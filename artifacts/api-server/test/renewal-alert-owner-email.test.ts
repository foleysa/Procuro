/**
 * Integration test for the renewal-alert owner email side-channel
 * added to `runRenewalAlertScanHandler` (Task #155).
 *
 * Until Task #155, the daily renewal scan would insert an `alerts`
 * row but only `deliverAlertsTick` would actually notify anyone — and
 * only for tenants who had configured an org-wide email subscription
 * matching `source='rule_match'`. A buyer-tenant on day 1 with no
 * subscription configured would silently never get notified that a
 * contract they own is about to expire.
 *
 * The new path attached to the scan handler ensures the contract
 * `owner` (when it parses as a valid email) ALWAYS gets a renewal
 * notification, independent of subscription wiring. The tests below
 * pin the contract:
 *
 *   - A contract with a valid email owner generates one
 *     `alert_events` row of `eventType='delivered'` with
 *     `metadata.kind='owner_notification'` and the right ownerEmail
 *     on first scan, and the handler return surfaces it under the
 *     `ownerEmailsSimulated` counter (no SENDGRID_API_KEY set in
 *     the test process).
 *   - A contract with a free-form (non-email) owner is alerted
 *     normally but no owner-email event is recorded — operators
 *     shouldn't see "we tried to email Bob Smith" because Bob Smith
 *     isn't a deliverable address.
 *   - A contract with NULL owner is also alerted normally with no
 *     owner-email event.
 *   - A second scan over the same window does NOT generate a second
 *     owner-email event for the same alert, even though the alert
 *     row dedupes idempotently. This is the spam-protection contract
 *     that the daily scheduler depends on.
 *
 * Prereqs:
 *   - `DATABASE_URL` is set and the schema has been pushed
 *     (`pnpm --filter @workspace/db run push`).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  alertsTable,
  alertEventsTable,
  contractsTable,
  orgsTable,
  suppliersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { newId } from "../src/lib/ids";
import { runRenewalAlertScanHandler } from "../src/lib/jobs/handlers";
import type { JobRow } from "@workspace/db";

const RUN = `renewal-owner-email-${Date.now()}-${process.pid}`;
const orgId = newId("org");
const supplierId = newId("sup");
const contractEmailOwnerId = newId("ctr");
const contractNameOwnerId = newId("ctr");
const contractNoOwnerId = newId("ctr");
const ownerEmail = `alice-${RUN}@example.test`;

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// The scan handler signature is `(job: JobRow) => Promise<...>`. The
// handler does not actually read any job fields beyond the type bound,
// so a shaped placeholder object is sufficient.
const FAKE_JOB: JobRow = {
  id: newId("job"),
  orgId: null,
  kind: "renewal_alert_scan",
  status: "running",
  payload: {},
  result: null,
  error: null,
  attempts: 1,
  maxAttempts: 3,
  cancelRequested: false,
  cancelRequestedAt: null,
  cancelRequestedBy: null,
  parentJobId: null,
  childOrdinal: null,
  startedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as JobRow;

test.before(async () => {
  // Force the email adapter into its simulated branch — this test is
  // about the scan-handler control flow, not the SendGrid integration.
  delete process.env["SENDGRID_API_KEY"];

  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} Test Org`,
    slug: `${RUN}-org`,
    settings: { contractRenewalAlertDays: 90 },
  });
  await db.insert(suppliersTable).values({
    id: supplierId,
    orgId,
    name: `${RUN} Supplier`,
    normalizedName: `${RUN} supplier`.toLowerCase(),
  });

  // Three contracts in the alert window (60 days out, well within the
  // default 90-day threshold the org settings above pin to). One has
  // a valid email owner, one has a free-form name, one has no owner.
  const endDate = daysFromNow(60);
  await db.insert(contractsTable).values([
    {
      id: contractEmailOwnerId,
      orgId,
      supplierId,
      contractNumber: `${RUN}-CTR-EMAIL`,
      title: "Renewal email owner contract",
      status: "active",
      contractType: "goods",
      startDate: daysFromNow(-365),
      endDate,
      owner: ownerEmail,
      sourceSystem: "seed",
    },
    {
      id: contractNameOwnerId,
      orgId,
      supplierId,
      contractNumber: `${RUN}-CTR-NAME`,
      title: "Renewal name owner contract",
      status: "active",
      contractType: "goods",
      startDate: daysFromNow(-365),
      endDate,
      owner: "Bob Smith",
      sourceSystem: "seed",
    },
    {
      id: contractNoOwnerId,
      orgId,
      supplierId,
      contractNumber: `${RUN}-CTR-NULL`,
      title: "Renewal null owner contract",
      status: "active",
      contractType: "goods",
      startDate: daysFromNow(-365),
      endDate,
      owner: null,
      sourceSystem: "seed",
    },
  ]);
});

test.after(async () => {
  // Cascade deletes alerts, alert_events, contracts, suppliers via
  // the org_id FKs.
  await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  await pool.end();
});

test("first scan: only the email-owner contract generates an owner_notification event", async () => {
  const result = (await runRenewalAlertScanHandler(FAKE_JOB)) as {
    orgsScanned: number;
    alertsInserted: number;
    contractsUpdated: number;
    ownerEmailsSent: number;
    ownerEmailsSimulated: number;
    ownerEmailsFailed: number;
    ownerEmailsSkipped: number;
    orgErrors: Array<{ orgId: string; error: string }>;
  };

  // Sanity: the test org has 3 candidate contracts, all 60 days out,
  // so all three should produce a fresh alert. The handler scans every
  // tenant in the database, so we filter our assertions to this RUN
  // when looking at counts that could be polluted by seeded data — but
  // the per-RUN counters below are immune because the only contracts
  // owned by `orgId` are the ones we just inserted.
  assert.ok(result.orgsScanned >= 1, "should have scanned at least our org");
  assert.equal(result.orgErrors.length, 0, "no per-tenant errors expected");

  // Pull the alerts created for our test org. Three contracts with a
  // brand-new dedupe key each → three alerts.
  const alertsForOrg = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.orgId, orgId));
  assert.equal(alertsForOrg.length, 3, "expected one alert per contract");

  // Find each contract's alert by inspecting the dedupe key — it
  // encodes the contract id, so we can route deterministically without
  // depending on insertion order.
  const alertByContract = new Map<string, (typeof alertsForOrg)[number]>();
  for (const a of alertsForOrg) {
    const m = /^renewal:(.+):\d+$/.exec(a.dedupeKey ?? "");
    if (m && m[1]) alertByContract.set(m[1], a);
  }
  const emailOwnerAlert = alertByContract.get(contractEmailOwnerId);
  const nameOwnerAlert = alertByContract.get(contractNameOwnerId);
  const nullOwnerAlert = alertByContract.get(contractNoOwnerId);
  assert.ok(emailOwnerAlert, "missing alert for the email-owner contract");
  assert.ok(nameOwnerAlert, "missing alert for the name-owner contract");
  assert.ok(nullOwnerAlert, "missing alert for the null-owner contract");

  // The email-owner contract should have exactly one owner_notification
  // event recorded by the side-channel sender.
  const emailOwnerEvents = await db
    .select()
    .from(alertEventsTable)
    .where(eq(alertEventsTable.alertId, emailOwnerAlert!.id));
  const ownerNotifs = emailOwnerEvents.filter(
    (e) => (e.metadata as { kind?: string }).kind === "owner_notification",
  );
  assert.equal(
    ownerNotifs.length,
    1,
    "expected exactly one owner_notification event for the email owner",
  );
  const meta = ownerNotifs[0]!.metadata as Record<string, unknown>;
  assert.equal(ownerNotifs[0]!.eventType, "delivered");
  assert.equal(meta["kind"], "owner_notification");
  assert.equal(meta["channelKind"], "email");
  assert.equal(meta["ownerEmail"], ownerEmail);
  assert.equal(meta["status"], "simulated");
  assert.equal(meta["contractNumber"], `${RUN}-CTR-EMAIL`);
  assert.equal(meta["thresholdDays"], 90);
  assert.equal(meta["daysToExpiry"], 60);

  // The name-owner and null-owner contracts must NOT have an
  // owner_notification event — Bob Smith isn't a deliverable address.
  for (const alert of [nameOwnerAlert!, nullOwnerAlert!]) {
    const events = await db
      .select()
      .from(alertEventsTable)
      .where(eq(alertEventsTable.alertId, alert.id));
    const wrong = events.filter(
      (e) => (e.metadata as { kind?: string }).kind === "owner_notification",
    );
    assert.equal(
      wrong.length,
      0,
      `unexpected owner_notification on alert ${alert.id} (dedupe ${alert.dedupeKey})`,
    );
  }

  // The handler return should reflect: 1 simulated, 2 skipped for our
  // org. Other tenants in the test database may bump these counters,
  // so we assert on lower bounds rather than equality.
  assert.ok(
    result.ownerEmailsSimulated >= 1,
    `expected ownerEmailsSimulated >= 1, got ${result.ownerEmailsSimulated}`,
  );
  assert.ok(
    result.ownerEmailsSkipped >= 2,
    `expected ownerEmailsSkipped >= 2, got ${result.ownerEmailsSkipped}`,
  );
});

test("second scan: no duplicate owner-notification event for the same alert", async () => {
  // Snapshot the count of owner_notification events for the email
  // owner's alert BEFORE the second scan.
  const [emailOwnerAlert] = await db
    .select()
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.orgId, orgId),
        eq(alertsTable.dedupeKey, `renewal:${contractEmailOwnerId}:90`),
      ),
    );
  assert.ok(emailOwnerAlert, "missing alert from the first scan");

  const before = await db
    .select()
    .from(alertEventsTable)
    .where(eq(alertEventsTable.alertId, emailOwnerAlert!.id));
  const beforeOwnerNotifs = before.filter(
    (e) => (e.metadata as { kind?: string }).kind === "owner_notification",
  );

  // Run the scan a second time. The alert row dedupes via
  // `(orgId, dedupeKey)` so no INSERT happens; the side-channel
  // sender is gated on the `RETURNING id` rowcount, so it should also
  // not fire.
  const result = (await runRenewalAlertScanHandler(FAKE_JOB)) as {
    alertsInserted: number;
    ownerEmailsSimulated: number;
  };

  // Our own org contributes 0 freshly-inserted alerts and 0 owner
  // emails on this tick. Other test data in the database may bump
  // these counters, so assert that the counters did NOT grow because
  // of *our* org by inspecting the events table directly below.
  assert.ok(typeof result.alertsInserted === "number");

  const after = await db
    .select()
    .from(alertEventsTable)
    .where(eq(alertEventsTable.alertId, emailOwnerAlert!.id));
  const afterOwnerNotifs = after.filter(
    (e) => (e.metadata as { kind?: string }).kind === "owner_notification",
  );
  assert.equal(
    afterOwnerNotifs.length,
    beforeOwnerNotifs.length,
    "second scan must not add a duplicate owner-notification event",
  );
});
