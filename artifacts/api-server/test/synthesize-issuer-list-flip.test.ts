/**
 * Integration test for Task #166: the operational-alert synthesizer
 * MUST translate `issuer_list_source_changed` audit-log rows into
 * `operational_collector_issuer_list_flip` alerts that get fanned out
 * to every opted-in tenant — same delivery path as
 * `operational_collector_stale` / `operational_collector_never_run`.
 *
 * Pinned invariants:
 *   1. A flip in the last 24h × an opted-in tenant produces exactly
 *      one alert with severity `medium`,
 *      source = `operational_collector_issuer_list_flip`, and a
 *      payload that captures `{ previousSource, listSource,
 *      issuerCount, callSite, collectorId }` — that's the contract
 *      the on-call channel adapter renders.
 *   2. The dedupe key embeds the transition direction so a
 *      `seed → tenant` followed by a `tenant → seed` re-fires (those
 *      are different runbook actions). A repeat of the SAME direction
 *      within the same day must NOT create a second row — it bumps
 *      occurrences instead.
 *   3. A tenant that hasn't opted into the collector receives no
 *      alert.
 *   4. The `tenant → seed` direction (operationally the dangerous one
 *      — every tenant row was deleted) ends up with a summary that
 *      tells on-call to PAGE rather than celebrate. We assert the
 *      key phrase so a future copy edit can't silently flip the
 *      runbook semantics.
 *
 * Prereqs: DATABASE_URL is set and the schema has been pushed.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const {
  db,
  pool,
  orgsTable,
  collectorsTable,
  collectorTenantOptInsTable,
  collectorAuditLogTable,
  alertsTable,
} = await import("@workspace/db");
const { and, eq, like } = await import("drizzle-orm");
const { newId } = await import("../src/lib/ids");
const { synthesizeOperationalAlerts } = await import(
  "../src/lib/alerts/synthesize"
);

const RUN = `t166-${Date.now()}-${process.pid}`;
const optedInOrgId = newId("org");
const otherOrgId = newId("org");
const collectorId = `coll_${RUN}`;
const otherCollectorId = `coll_${RUN}_other`;

before(async () => {
  await db.insert(orgsTable).values([
    {
      id: optedInOrgId,
      name: `${RUN} Opted-In Org`,
      slug: `${RUN}-opted-in`,
    },
    {
      id: otherOrgId,
      name: `${RUN} Not Opted-In Org`,
      slug: `${RUN}-not-opted-in`,
    },
  ]);
  // The "subject" collector — the flip happens here. Schema requires
  // status / posture / source_url / owner.
  await db.insert(collectorsTable).values({
    id: collectorId,
    name: `${RUN} EDGAR Test Collector`,
    description: "Issuer-list flip synthesizer test",
    posture: "public-api",
    status: "approved",
    owner: "test",
    sourceUrl: "https://example.test/edgar",
  });
  // A second collector whose flip events MUST be ignored — proves
  // the synthesizer scopes its fan-out by collector_id.
  await db.insert(collectorsTable).values({
    id: otherCollectorId,
    name: `${RUN} Other Collector`,
    description: "Should not be touched by this test",
    posture: "public-api",
    status: "approved",
    owner: "test",
    sourceUrl: "https://example.test/other",
  });
  // Only the first org opts into our subject collector. The second
  // org opts into the unrelated collector — so it would get alerts
  // for OTHER flips but must NOT see one for `collectorId`.
  await db.insert(collectorTenantOptInsTable).values([
    {
      id: newId("opt"),
      orgId: optedInOrgId,
      collectorId,
      optedIn: 1,
    },
    {
      id: newId("opt"),
      orgId: otherOrgId,
      collectorId: otherCollectorId,
      optedIn: 1,
    },
  ]);
});

after(async () => {
  // Cascade order matters even with FK ON DELETE CASCADE — alerts has
  // no FK to collectors, so clean it explicitly.
  await db
    .delete(alertsTable)
    .where(like(alertsTable.dedupeKey, `op:issuer_list_flip:%${RUN}%`));
  await db
    .delete(alertsTable)
    .where(eq(alertsTable.orgId, optedInOrgId));
  await db.delete(alertsTable).where(eq(alertsTable.orgId, otherOrgId));
  // Audit log + opt-ins cascade via collector_id FK; orgs cascade alerts.
  await db
    .delete(collectorAuditLogTable)
    .where(eq(collectorAuditLogTable.collectorId, collectorId));
  await db.delete(collectorsTable).where(eq(collectorsTable.id, collectorId));
  await db
    .delete(collectorsTable)
    .where(eq(collectorsTable.id, otherCollectorId));
  await db.delete(orgsTable).where(eq(orgsTable.id, optedInOrgId));
  await db.delete(orgsTable).where(eq(orgsTable.id, otherOrgId));
  await pool.end();
});

async function insertFlip(args: {
  previousSource: "seed" | "tenant" | "override";
  listSource: "seed" | "tenant" | "override";
  issuerCount: number;
  callSite?: "collect" | "backfill";
  createdAt?: Date;
}): Promise<void> {
  await db.insert(collectorAuditLogTable).values({
    id: newId("aud"),
    collectorId,
    event: "issuer_list_source_changed",
    metadata: {
      previousSource: args.previousSource,
      listSource: args.listSource,
      issuerCount: args.issuerCount,
      callSite: args.callSite ?? "collect",
    },
    ...(args.createdAt ? { createdAt: args.createdAt } : {}),
  });
}

test("seed → tenant flip raises one alert per opted-in tenant with the celebratory summary", async () => {
  await insertFlip({
    previousSource: "seed",
    listSource: "tenant",
    issuerCount: 12,
  });
  const before = await synthesizeOperationalAlerts({
    now: () => new Date(),
  });
  assert.ok(
    before.collectorIssuerListFlipAlerts >= 1,
    "synthesizer should report at least one issuer-list flip alert",
  );

  const rows = await db
    .select()
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.orgId, optedInOrgId),
        eq(alertsTable.source, "operational_collector_issuer_list_flip"),
      ),
    );
  assert.equal(
    rows.length,
    1,
    "exactly one flip alert for the opted-in tenant",
  );
  const alert = rows[0]!;
  assert.equal(alert.severity, "medium");
  assert.equal(alert.kind, `collector_issuer_list_flip:${collectorId}`);
  const payload = alert.payload as Record<string, unknown>;
  assert.equal(payload["collectorId"], collectorId);
  assert.equal(payload["previousSource"], "seed");
  assert.equal(payload["listSource"], "tenant");
  assert.equal(payload["issuerCount"], 12);
  assert.equal(payload["callSite"], "collect");
  // The summary is the *operational* signal to on-call. The
  // seed→tenant direction is "no page" so the copy MUST tell
  // them as much.
  assert.match(
    String(alert.summary),
    /onboarding|first watched issuer|no action/i,
    "seed→tenant summary should signal a healthy onboarding event",
  );
});

test("non-opted-in tenant sees no alert for someone else's collector flip", async () => {
  const rows = await db
    .select()
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.orgId, otherOrgId),
        eq(alertsTable.source, "operational_collector_issuer_list_flip"),
      ),
    );
  assert.equal(
    rows.length,
    0,
    "tenants that didn't opt into the collector must not be paged",
  );
});

test("re-running the synthesizer on the same flip bumps occurrences instead of inserting a second row", async () => {
  // No new audit row — same flip from the previous test should
  // collapse onto the already-created alert.
  await synthesizeOperationalAlerts({ now: () => new Date() });

  const rows = await db
    .select()
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.orgId, optedInOrgId),
        eq(alertsTable.source, "operational_collector_issuer_list_flip"),
      ),
    );
  assert.equal(rows.length, 1, "dedupe key must collapse repeats");
  assert.ok(
    rows[0]!.occurrences >= 2,
    `expected occurrences to bump, got ${rows[0]!.occurrences}`,
  );
});

test("tenant → seed flip (the dangerous direction) creates a SEPARATE alert with a page-now summary", async () => {
  await insertFlip({
    previousSource: "tenant",
    listSource: "seed",
    issuerCount: 8,
  });
  await synthesizeOperationalAlerts({ now: () => new Date() });

  const rows = await db
    .select()
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.orgId, optedInOrgId),
        eq(alertsTable.source, "operational_collector_issuer_list_flip"),
      ),
    );
  // The seed→tenant alert from before MUST still exist; the new
  // tenant→seed alert MUST be a distinct row because the dedupe key
  // includes direction.
  assert.equal(
    rows.length,
    2,
    "transition reversal must create a new alert row, not bump the old one",
  );
  const dangerous = rows.find((r) => {
    const p = r.payload as Record<string, unknown>;
    return p["previousSource"] === "tenant" && p["listSource"] === "seed";
  });
  assert.ok(dangerous, "tenant→seed alert must exist");
  // The summary MUST nudge on-call to escalate. We pin the key
  // operational phrase so a future copy edit can't silently
  // downgrade the runbook semantics.
  assert.match(
    String(dangerous!.summary),
    /seed list|deleted|silently mask/i,
    "tenant→seed summary should warn that the seed list will mask an outage",
  );
});
