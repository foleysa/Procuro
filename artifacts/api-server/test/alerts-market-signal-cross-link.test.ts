/**
 * Cross-link contract for Task #161: alerts ↔ Fusion war-room events.
 *
 * Two distinct surfaces collaborate to deep-link an operator from the
 * alerts inbox into the originating war-room event and back:
 *
 *   1. Collector fan-out (`fanOutCollectorAlerts`) MUST stamp the
 *      persisted `market_signals.id` of the row that produced the
 *      alert into the alert's `payload.marketSignalId` AND the array
 *      form `payload.marketSignalIds`. The single-id field is what
 *      the alert detail dialog reads for its "Open in War Room" CTA;
 *      the array form is forward-compatible with a future composer
 *      that fans multiple signals into one alert.
 *
 *   2. `GET /alerts?marketSignalId=<id>` MUST return only alerts whose
 *      payload references that id (single OR array form). This is the
 *      reverse direction — the war-room row uses it to render the
 *      "N alerts triggered" badge that links to a pre-filtered inbox.
 *
 * Both halves of the contract are exercised here against real
 * Postgres so the JSONB query stays honest (`->>`, `->`, and the `?`
 * key-existence operator are not the kind of thing you want to mock).
 *
 * Prereqs:
 *   - `DATABASE_URL` is set and the schema has been pushed
 *     (`pnpm --filter @workspace/db run push`).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import http from "node:http";

// Tenant middleware reads NODE_ENV at module load — set the dev
// header opt-in BEFORE we import the route module.
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

const {
  db,
  pool,
  orgsTable,
  suppliersTable,
  collectorsTable,
  alertsTable,
  marketSignalsTable,
} = await import("@workspace/db");
const { eq, sql } = await import("drizzle-orm");
const { newId } = await import("../src/lib/ids");
const { fanOutCollectorAlerts } = await import(
  "../src/lib/alerts/collector-fanout"
);
const { insertSignalsWithDedupe } = await import(
  "../src/lib/intelligence/runtime"
);
const alertsRouter = (await import("../src/routes/alerts")).default;

const RUN = `t161-${Date.now()}-${process.pid}`;
const orgId = newId("org");
const supplierId = newId("sup");
const collectorId = `coll_${RUN}`;
// Stable signal ids — must match the route's `^sig_…$` prefix guard.
const sigA = `sig_${RUN}_a`;
const sigB = `sig_${RUN}_b`;

let server: http.Server;
let baseUrl: string;

before(async () => {
  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} Cross-link Test Org`,
    slug: `${RUN}-org`,
  });
  // Supplier name + normalized form must match the draft's
  // `scopeSupplierName` for fan-out's tenant resolver to bind the
  // alert to this org. The resolver lowercases + collapses
  // whitespace, so we mirror that here.
  await db.insert(suppliersTable).values({
    id: supplierId,
    orgId,
    name: "Acme Corp",
    normalizedName: "acme corp",
  });
  await db.insert(collectorsTable).values({
    id: collectorId,
    name: "Test collector",
    description: "Test collector for #161 cross-link",
    posture: "public-api",
    status: "approved",
    owner: "test",
    sourceUrl: "https://example.test/collector",
  });

  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: (...a: unknown[]) => void } }).log = {
      error: () => undefined,
    };
    next();
  });
  app.use("/api", alertsRouter);

  server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await db.delete(alertsTable).where(eq(alertsTable.orgId, orgId));
  await db
    .delete(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, collectorId));
  await db.delete(collectorsTable).where(eq(collectorsTable.id, collectorId));
  await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  await pool.end();
});

test("fan-out stamps marketSignalId + marketSignalIds in alert payload", async () => {
  const [collector] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, collectorId));
  assert.ok(collector, "collector seed missing");

  const counts = await fanOutCollectorAlerts({
    collector,
    drafts: [
      {
        signalType: "sanctions_match",
        scopeSupplierName: "Acme Corp",
        observedAt: new Date("2026-04-01T00:00:00Z"),
        sourceUrl: "https://example.test/sanctions/a",
        value: 1,
        unit: "match",
        marketSignalId: sigA,
      },
      {
        signalType: "corporate_filing",
        scopeSupplierName: "Acme Corp",
        observedAt: new Date("2026-04-02T00:00:00Z"),
        sourceUrl: "https://example.test/filings/b",
        value: 1,
        unit: "filing",
        marketSignalId: sigB,
      },
      // Fan-out without a marketSignalId — must NOT crash and must
      // NOT add either key. This pins the optional-payload branch.
      {
        signalType: "natural_hazard",
        scopeSupplierName: "Acme Corp",
        observedAt: new Date("2026-04-03T00:00:00Z"),
        sourceUrl: "https://example.test/hazards/c",
        value: 5,
        unit: "magnitude",
      },
    ],
  });
  assert.equal(counts.alertsCreated, 3, "expected 3 alerts created");

  const rows = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.orgId, orgId));
  assert.equal(rows.length, 3);

  const bySig = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const p = r.payload as Record<string, unknown>;
    const sid = p["marketSignalId"];
    if (typeof sid === "string") bySig.set(sid, r);
  }
  assert.ok(bySig.has(sigA), "sigA alert must exist");
  assert.ok(bySig.has(sigB), "sigB alert must exist");

  const a = bySig.get(sigA)!;
  const aPayload = a.payload as Record<string, unknown>;
  assert.equal(aPayload["marketSignalId"], sigA);
  assert.deepEqual(aPayload["marketSignalIds"], [sigA]);

  const hazard = rows.find(
    (r) =>
      (r.payload as Record<string, unknown>)["signalType"] ===
      "natural_hazard",
  );
  assert.ok(hazard, "natural_hazard alert missing");
  const hPayload = hazard.payload as Record<string, unknown>;
  assert.equal(
    hPayload["marketSignalId"],
    undefined,
    "no marketSignalId stamped when draft omits it",
  );
  assert.equal(
    hPayload["marketSignalIds"],
    undefined,
    "no marketSignalIds stamped when draft omits it",
  );
});

test("GET /alerts?marketSignalId filters by payload (single + array form)", async () => {
  const r = await fetch(
    `${baseUrl}/api/alerts?marketSignalId=${encodeURIComponent(sigA)}`,
    { headers: { "x-org-id": orgId } },
  );
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    items: Array<{ id: string; payload: Record<string, unknown> }>;
  };
  assert.equal(body.items.length, 1, "exactly one alert references sigA");
  assert.equal(body.items[0]!.payload["marketSignalId"], sigA);

  // Now flip one of the rows to use ONLY the array form (drop the
  // singular field). This proves the JSONB `?` operator on
  // `marketSignalIds` is wired correctly and not just a coincidence
  // of the singular column matching.
  const arrayJson = JSON.stringify([sigB]);
  await db.execute(sql`
    UPDATE alerts
       SET payload = (payload - 'marketSignalId')
                   || jsonb_build_object('marketSignalIds', ${arrayJson}::jsonb)
     WHERE org_id = ${orgId}
       AND payload ->> 'signalType' = 'corporate_filing'
  `);
  const r2 = await fetch(
    `${baseUrl}/api/alerts?marketSignalId=${encodeURIComponent(sigB)}`,
    { headers: { "x-org-id": orgId } },
  );
  assert.equal(r2.status, 200);
  const body2 = (await r2.json()) as {
    items: Array<{ id: string; payload: Record<string, unknown> }>;
  };
  assert.equal(
    body2.items.length,
    1,
    "array-form-only payload still matches the filter",
  );

  // Unknown sig id → empty result, not 4xx.
  const r3 = await fetch(
    `${baseUrl}/api/alerts?marketSignalId=sig_does_not_exist`,
    { headers: { "x-org-id": orgId } },
  );
  assert.equal(r3.status, 200);
  const body3 = (await r3.json()) as { items: unknown[] };
  assert.equal(body3.items.length, 0);

  // Malformed id (no `sig_` prefix) → filter is silently ignored,
  // route returns the org's alerts. This is the prefix guard at
  // work; it must not 500 or leak a SQL error.
  const r4 = await fetch(
    `${baseUrl}/api/alerts?marketSignalId=not-a-sig-id`,
    { headers: { "x-org-id": orgId } },
  );
  assert.equal(r4.status, 200);
  const body4 = (await r4.json()) as { items: unknown[] };
  assert.equal(
    body4.items.length,
    3,
    "malformed marketSignalId is ignored and all alerts are returned",
  );
});

test("insertSignalsWithDedupe persistedIds resolves to existing row on conflict (regression for #161 ID drift)", async () => {
  // Pre-seed a market_signals row with a known id ("the existing
  // owner of this natural key"). A subsequent insert collision MUST
  // resolve to *this* id, not to the candidate id we generate
  // locally — that was the bug the code review caught: stamping the
  // candidate id into `payload.marketSignalId` creates a dangling
  // reference to a row that was never persisted, and the war-room
  // deep-link from the alert silently breaks.
  const existingId = `sig_${RUN}_existing`;
  const candidateId = `sig_${RUN}_candidate`;
  const observedAt = new Date("2026-04-10T00:00:00Z");

  await db.insert(marketSignalsTable).values({
    id: existingId,
    orgId: null,
    collectorId,
    signalType: "sanctions_match",
    scopeSupplierName: "Acme Corp",
    value: "1",
    unit: "probe",
    currency: "USD",
    observedAt,
    sourceUrl: "https://example.test/regression",
    posture: "public-api",
    confidence: "0.9",
    metadata: {},
  });

  // Same natural key (collectorId + signalType + scope cols +
  // observedAt) → INSERT path will hit ON CONFLICT DO NOTHING and
  // skip our candidate id entirely.
  const result = await insertSignalsWithDedupe([
    {
      id: candidateId,
      orgId: null,
      collectorId,
      signalType: "sanctions_match",
      scopeSupplierName: "Acme Corp",
      value: "1",
      unit: "probe",
      currency: "USD",
      observedAt,
      sourceUrl: "https://example.test/regression-rerun",
      posture: "public-api",
      confidence: "0.9",
      metadata: {},
    },
  ]);

  assert.equal(result.inserted, 0, "no new row was inserted");
  assert.equal(result.duplicates, 1, "the row was a natural-key duplicate");
  assert.equal(
    result.persistedIds.get(candidateId),
    existingId,
    "persistedIds maps the candidate id to the EXISTING row's id, " +
      "not the never-persisted candidate id",
  );

  // And the lookup is bidirectional-safe: a fresh natural key in the
  // same batch resolves to its own candidate id, while the conflict
  // row resolves to the pre-existing one.
  const freshId = `sig_${RUN}_fresh`;
  const result2 = await insertSignalsWithDedupe([
    {
      id: freshId,
      orgId: null,
      collectorId,
      signalType: "sanctions_match",
      scopeSupplierName: "Acme Corp",
      value: "1",
      unit: "probe",
      currency: "USD",
      observedAt: new Date("2026-04-11T00:00:00Z"),
      sourceUrl: "https://example.test/regression-fresh",
      posture: "public-api",
      confidence: "0.9",
      metadata: {},
    },
    {
      id: `sig_${RUN}_dup_again`,
      orgId: null,
      collectorId,
      signalType: "sanctions_match",
      scopeSupplierName: "Acme Corp",
      value: "1",
      unit: "probe",
      currency: "USD",
      observedAt,
      sourceUrl: "https://example.test/regression-dup-again",
      posture: "public-api",
      confidence: "0.9",
      metadata: {},
    },
  ]);
  assert.equal(result2.inserted, 1);
  assert.equal(result2.duplicates, 1);
  assert.equal(result2.persistedIds.get(freshId), freshId);
  assert.equal(result2.persistedIds.get(`sig_${RUN}_dup_again`), existingId);
});

test("insertSignalsWithDedupe maps conflict rows when legacy stores '' and new row uses NULL (index COALESCE parity)", async () => {
  // Edge case the code review surfaced: the unique natural-key index
  // wraps each scope_* column in `COALESCE(col, '')`, which means a
  // legacy row that stores `''` for an absent scope and a new row
  // that stores SQL NULL for the same scope COLLIDE in the index
  // (both normalise to ''). The conflict-row lookup must mirror that
  // normalization, otherwise the second-run alert would lose its
  // `marketSignalId` link to the existing row.
  const existingId = `sig_${RUN}_legacy_empty`;
  const candidateId = `sig_${RUN}_modern_null`;
  const observedAt = new Date("2026-04-12T00:00:00Z");

  // Insert directly with raw SQL so we can force `''` into the scope
  // columns (Drizzle would otherwise coerce undefined → NULL).
  await db.execute(sql`
    INSERT INTO ${marketSignalsTable}
      (id, org_id, collector_id, signal_type,
       scope_category_code, scope_sku, scope_material_code,
       scope_supplier_name, scope_lane_key, scope_region_code,
       value, unit, currency, observed_at,
       source_url, posture, confidence, metadata)
    VALUES (
      ${existingId}, NULL, ${collectorId}, 'sanctions_match',
      '', '', '', '', '', '',
      1::numeric, 'probe', 'USD', ${observedAt},
      'https://example.test/legacy-empty', 'public-api',
      0.9::numeric, '{}'::jsonb
    )
  `);

  // Insert a row whose JS shape uses null/undefined for every scope
  // column. After COALESCE both rows have the same natural key and
  // the INSERT hits ON CONFLICT DO NOTHING — the candidate id is
  // never persisted.
  const result = await insertSignalsWithDedupe([
    {
      id: candidateId,
      orgId: null,
      collectorId,
      signalType: "sanctions_match",
      // All scope_* columns omitted → null in the INSERT VALUES
      value: "1",
      unit: "probe",
      currency: "USD",
      observedAt,
      sourceUrl: "https://example.test/modern-null",
      posture: "public-api",
      confidence: "0.9",
      metadata: {},
    },
  ]);

  assert.equal(result.inserted, 0, "no new row was inserted");
  assert.equal(result.duplicates, 1, "natural-key collision was detected");
  assert.equal(
    result.persistedIds.get(candidateId),
    existingId,
    "lookup must mirror the index's COALESCE(col, '') normalization " +
      "and resolve NULL↔'' as equivalent — otherwise the alert " +
      "fan-out would lose its marketSignalId link to the legacy row",
  );
});
