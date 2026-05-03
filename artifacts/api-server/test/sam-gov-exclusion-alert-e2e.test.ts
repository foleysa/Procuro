/**
 * End-to-end runtime test: a SAM.gov exclusion fires a critical
 * `sanctions_match` alert for a watched supplier.
 *
 * Task #247 wired SAM.gov exclusions into the existing sanctions
 * fan-out path (reserved list code 5) so that an exclusion hit on a
 * watched supplier behaves identically to OFAC / EU / UK / UN sanctions
 * matches: a critical-severity tenant alert lands in the inbox per
 * matching supplier. Per-collector parser unit tests
 * (`sam-gov-parser.test.ts`) and the static fan-out spec test
 * (`sam-gov-fanout.test.ts`) already pin the deterministic pieces. This
 * test stitches the entire chain — HTTP fetch → parser → runtime
 * persist → `fanOutCollectorAlerts` → `createAlert` — so a future
 * regression that breaks any link (e.g. dropping the `sanctions_match`
 * mapping, renaming list code 5, skipping fan-out for SAM, or breaking
 * supplier matching) fails loudly here.
 *
 * Strategy:
 *   1. Seed a fresh org + supplier whose normalized name matches the
 *      stubbed SAM exclusion record (so the supplier-name fan-out path
 *      resolves to exactly that org/supplier).
 *   2. Stub `globalThis.fetch` to return a fixed SAM exclusions JSON
 *      payload for the exclusions endpoint, and an empty entities
 *      payload for the registrations endpoint. Set `SAM_GOV_API_KEY`
 *      so the collector doesn't degrade to zero drafts.
 *   3. Register, upsert, and approve `samGovCollector` and call
 *      `runCollector` on it.
 *   4. Assert (a) a `market_signals` row was inserted with
 *      `signal_type = 'sanctions_match'` for our supplier, and
 *      (b) an `alerts` row was created for the seeded org/supplier
 *      with `source='sanctions'`, `severity='critical'`,
 *      `kind='sanctions_match'`.
 *
 * Hermetic: no real SAM.gov calls. Postgres is real (matches the rest
 * of the api-server integration tests).
 *
 * Prereqs: `DATABASE_URL` set and the schema pushed
 * (`pnpm --filter @workspace/db run push`).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  alertsTable,
  marketSignalsTable,
  collectorAuditLogTable,
  orgsTable,
  suppliersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  approveCollector,
  disableCollector,
  registerCollector,
  runCollector,
  upsertCollectorRegistration,
} from "../src/lib/intelligence/runtime";
import {
  SAM_GOV_COLLECTOR_ID,
  samGovCollector,
} from "../src/lib/intelligence/collectors/sam-gov";
import { newId } from "../src/lib/ids";

const RUN = `sam-e2e-${Date.now()}-${process.pid}`;
const SUPPLIER_NAME = `${RUN}-Bad-Actor-Inc`;
const NORMALIZED = SUPPLIER_NAME.trim().toLowerCase().replace(/\s+/g, " ");
const ACTIVATION_DATE = "2025-11-04";

const orgId = newId("org");
const supplierId = newId("sup");

test("SAM.gov exclusion E2E: stubbed HTTP → critical sanctions_match alert in inbox", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // ---------------------------------------------------------------
  // Stub upstream SAM.gov HTTP. Exclusions return one record whose
  // `exclusionName` matches our seeded supplier; entity registrations
  // return zero records (we only care about the exclusions → alert
  // path). Anything else falls through to real fetch.
  // ---------------------------------------------------------------
  const realFetch = globalThis.fetch;
  const prevApiKey = process.env["SAM_GOV_API_KEY"];
  process.env["SAM_GOV_API_KEY"] = prevApiKey ?? "test-key";

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.includes("api.sam.gov/exclusions/")) {
      const body = JSON.stringify({
        excludedEntity: [
          {
            exclusionName: SUPPLIER_NAME,
            classificationType: "Firm",
            recordId: `${RUN}-rec-1`,
            activationDate: ACTIVATION_DATE,
            terminationDate: null,
            countryCode: "USA",
            ueiSAM: "PPPP9999QQQQ",
            exclusionDetails: {
              exclusionType: "Reciprocal",
              excludingAgencyCode: "DOD",
              exclusionProgram: "Procurement",
            },
          },
        ],
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("api.sam.gov/entity-information/")) {
      return new Response(JSON.stringify({ entityData: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  // ---------------------------------------------------------------
  // Seed a fresh tenant + matching supplier. The fan-out resolves
  // tenants by `suppliers.normalized_name` (lowercase, collapsed
  // whitespace) — we set both `name` and `normalizedName` to match
  // what the collector emits as `scopeSupplierName`.
  // ---------------------------------------------------------------
  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} Test Org`,
    slug: `${RUN}-org`,
  });
  await db.insert(suppliersTable).values({
    id: supplierId,
    orgId,
    name: SUPPLIER_NAME,
    normalizedName: NORMALIZED,
    countryCode: "US",
    sourceSystem: "test",
    sourceExternalId: `${RUN}-ext`,
  });

  registerCollector(samGovCollector);
  await upsertCollectorRegistration({
    id: SAM_GOV_COLLECTOR_ID,
    name: samGovCollector.name,
    description: samGovCollector.description,
    posture: samGovCollector.posture,
    owner: "tests",
    sourceUrl: samGovCollector.sourceUrl,
    rateLimitRpm: samGovCollector.defaultRateLimitRpm ?? null,
    scheduleCron: samGovCollector.defaultScheduleCron,
    notes: null,
    actor: "tests",
  });
  await approveCollector(SAM_GOV_COLLECTOR_ID, "tests");

  t.after(async () => {
    globalThis.fetch = realFetch;
    if (prevApiKey === undefined) delete process.env["SAM_GOV_API_KEY"];
    else process.env["SAM_GOV_API_KEY"] = prevApiKey;
    try {
      // Clean up market signals + audit rows produced by this run, plus
      // the fresh org (which cascades alerts + suppliers + watched-list
      // children). Belt-and-braces: mark the collector rejected so a
      // stray DB row doesn't pollute the operator UI.
      await db
        .delete(marketSignalsTable)
        .where(eq(marketSignalsTable.collectorId, SAM_GOV_COLLECTOR_ID));
      await db
        .delete(collectorAuditLogTable)
        .where(eq(collectorAuditLogTable.collectorId, SAM_GOV_COLLECTOR_ID));
      await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
      await disableCollector(SAM_GOV_COLLECTOR_ID, "tests", "rejected");
    } catch (err) {
      console.error("[cleanup] sam-gov e2e cleanup failed:", err);
    }
    await pool.end().catch(() => {});
  });

  // ---------------------------------------------------------------
  // Run the collector through the runtime — same code path the
  // scheduler uses in production.
  // ---------------------------------------------------------------
  await runCollector(SAM_GOV_COLLECTOR_ID);

  // ---------------------------------------------------------------
  // Assert: a `sanctions_match` market_signals row landed for our
  // supplier with the SAM list code (5).
  // ---------------------------------------------------------------
  const signals = await db
    .select()
    .from(marketSignalsTable)
    .where(
      and(
        eq(marketSignalsTable.collectorId, SAM_GOV_COLLECTOR_ID),
        eq(marketSignalsTable.signalType, "sanctions_match"),
        eq(marketSignalsTable.scopeSupplierName, SUPPLIER_NAME),
      ),
    );
  assert.equal(
    signals.length,
    1,
    "exactly one sanctions_match signal should be persisted for the watched supplier",
  );
  assert.equal(
    Number(signals[0]!.value),
    5,
    "SAM exclusion list code (5) must be persisted on `value`",
  );

  // ---------------------------------------------------------------
  // Assert: a critical sanctions alert landed in the inbox for the
  // seeded org, scoped to the seeded supplier. This is the contract
  // we are pinning end-to-end.
  // ---------------------------------------------------------------
  const alerts = await db
    .select()
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.orgId, orgId),
        eq(alertsTable.kind, "sanctions_match"),
      ),
    );
  assert.equal(
    alerts.length,
    1,
    "exactly one sanctions_match alert should be created for the watched supplier",
  );
  const alert = alerts[0]!;
  assert.equal(
    alert.source,
    "sanctions",
    "SAM exclusion alerts must use the sanctions alert source",
  );
  assert.equal(
    alert.severity,
    "critical",
    "SAM exclusion alerts must fire at critical severity (same as OFAC/EU/UK/UN)",
  );
  assert.equal(
    alert.supplierId,
    supplierId,
    "alert must be scoped to the matched watched supplier",
  );
  assert.match(
    alert.title,
    new RegExp(SUPPLIER_NAME),
    "alert title must reference the matched supplier",
  );
});
