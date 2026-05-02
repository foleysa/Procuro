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
 * `owner` (when it parses as a valid email) gets a renewal
 * notification, independent of subscription wiring — but ONLY when
 * the tenant has explicitly opted in via the
 * `contractRenewalEmailEnabled` setting. The default is `false` so
 * existing tenants don't get a surprise blast of emails when the
 * code first ships. The tests below pin both contracts:
 *
 *   Opt-in tenant (settings.contractRenewalEmailEnabled = true):
 *     - A contract with a valid email owner generates one
 *       `alert_events` row of `eventType='delivered'` with
 *       `metadata.kind='owner_notification'` and the right ownerEmail
 *       on first scan. The metadata also includes a `deepLink` back
 *       into `/contracts/:id` and the handler return surfaces it
 *       under the `ownerEmailsSimulated` counter (no SENDGRID_API_KEY
 *       set in the test process).
 *     - A contract with a free-form (non-email) owner is alerted
 *       normally but no owner-email event is recorded — operators
 *       shouldn't see "we tried to email Bob Smith" because Bob
 *       Smith isn't a deliverable address.
 *     - A contract with NULL owner is also alerted normally with no
 *       owner-email event.
 *     - A second scan over the same window does NOT generate a second
 *       owner-email event for the same alert, even though the alert
 *       row dedupes idempotently. This is the spam-protection
 *       contract that the daily scheduler depends on.
 *
 *   Default-off tenant (no `contractRenewalEmailEnabled` set):
 *     - The renewal alert is still inserted, but NO owner_notification
 *       event is recorded — even when the owner is a perfectly valid
 *       email. The handler bumps the `ownerEmailsDisabled` counter so
 *       the System / Jobs page can surface "you have unsent renewal
 *       notifications waiting for you to opt in".
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
import {
  buildAppDeepLink,
  runRenewalAlertScanHandler,
} from "../src/lib/jobs/handlers";
import { readRenewalEmailEnabled } from "../src/lib/contract-settings";
import type { JobRow } from "@workspace/db";

const RUN = `renewal-owner-email-${Date.now()}-${process.pid}`;
const orgId = newId("org");
const orgDefaultId = newId("org");
const supplierId = newId("sup");
const supplierDefaultId = newId("sup");
const contractEmailOwnerId = newId("ctr");
const contractNameOwnerId = newId("ctr");
const contractNoOwnerId = newId("ctr");
const contractDefaultOrgId = newId("ctr");
const ownerEmail = `alice-${RUN}@example.test`;
const defaultOrgOwnerEmail = `dora-${RUN}@example.test`;

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

  // Two orgs: one explicitly opted in via
  // `contractRenewalEmailEnabled: true`, one with the default
  // (unset → false) so we can exercise both branches in the same run.
  await db.insert(orgsTable).values([
    {
      id: orgId,
      name: `${RUN} Test Org (opted-in)`,
      slug: `${RUN}-org`,
      settings: {
        contractRenewalAlertDays: 90,
        contractRenewalEmailEnabled: true,
      },
    },
    {
      id: orgDefaultId,
      name: `${RUN} Test Org (default off)`,
      slug: `${RUN}-org-default`,
      // No `contractRenewalEmailEnabled` set — should fall back to
      // the safe default of `false`.
      settings: { contractRenewalAlertDays: 90 },
    },
  ]);
  await db.insert(suppliersTable).values([
    {
      id: supplierId,
      orgId,
      name: `${RUN} Supplier`,
      normalizedName: `${RUN} supplier`.toLowerCase(),
    },
    {
      id: supplierDefaultId,
      orgId: orgDefaultId,
      name: `${RUN} Default Supplier`,
      normalizedName: `${RUN} default supplier`.toLowerCase(),
    },
  ]);

  // Four contracts in the alert window (60 days out, well within the
  // 90-day threshold both orgs use). Three in the opted-in org cover
  // valid-email / free-form-name / null owner; one in the default-off
  // org has a perfectly valid email owner so we can prove the gate
  // really does suppress the email.
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
    {
      id: contractDefaultOrgId,
      orgId: orgDefaultId,
      supplierId: supplierDefaultId,
      contractNumber: `${RUN}-CTR-DEFAULT`,
      title: "Default-off org contract",
      status: "active",
      contractType: "goods",
      startDate: daysFromNow(-365),
      endDate,
      owner: defaultOrgOwnerEmail,
      sourceSystem: "seed",
    },
  ]);
});

test.after(async () => {
  // Cascade deletes alerts, alert_events, contracts, suppliers via
  // the org_id FKs.
  await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  await db.delete(orgsTable).where(eq(orgsTable.id, orgDefaultId));
  await pool.end();
});

test("first scan: opted-in org emails the email-owner; default-off org records no owner_notification event", async () => {
  const result = (await runRenewalAlertScanHandler(FAKE_JOB)) as {
    orgsScanned: number;
    alertsInserted: number;
    contractsUpdated: number;
    ownerEmailsSent: number;
    ownerEmailsSimulated: number;
    ownerEmailsFailed: number;
    ownerEmailsSkipped: number;
    ownerEmailsDisabled: number;
    orgErrors: Array<{ orgId: string; error: string }>;
  };

  // Sanity: the opted-in test org has 3 candidate contracts and the
  // default-off org has 1, all 60 days out, so all four should produce
  // a fresh alert. The handler scans every tenant in the database, so
  // we filter our assertions to this RUN when looking at counts that
  // could be polluted by seeded data.
  assert.ok(result.orgsScanned >= 2, "should have scanned at least both test orgs");
  assert.equal(result.orgErrors.length, 0, "no per-tenant errors expected");

  // --- Opted-in org assertions ---
  const alertsForOrg = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.orgId, orgId));
  assert.equal(alertsForOrg.length, 3, "expected one alert per contract in opted-in org");

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

  // The persisted alerts.summary must remain the terse original
  // (just title/supplier/end-date) — the deep-link enrichment lives
  // in the in-memory adapter copy ONLY, so the in-app alert detail
  // drawer doesn't show "Open contract: https://..." prose. This
  // pins the non-mutation guarantee called out in the handler
  // comment.
  const persistedSummary = emailOwnerAlert!.summary ?? "";
  assert.ok(
    !persistedSummary.includes("Open contract:"),
    `persisted summary must not contain the email deep-link block, got: ${persistedSummary}`,
  );
  assert.ok(
    !persistedSummary.includes(`/contracts/${contractEmailOwnerId}`),
    "persisted summary must not contain a deep link",
  );
  assert.ok(
    persistedSummary.includes(`${RUN} Supplier`),
    "persisted summary should still contain the original terse blurb",
  );

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
  assert.equal(meta["contractId"], contractEmailOwnerId);
  assert.equal(meta["contractNumber"], `${RUN}-CTR-EMAIL`);
  assert.equal(meta["thresholdDays"], 90);
  assert.equal(meta["daysToExpiry"], 60);
  // Deep link points at the contract detail page so the owner can
  // click through. We don't pin the host (depends on env), but the
  // path suffix must match exactly so the link routes correctly when
  // resolved against any base URL.
  const deepLink = meta["deepLink"];
  assert.ok(typeof deepLink === "string", "deepLink should be a string");
  assert.ok(
    (deepLink as string).endsWith(`/contracts/${contractEmailOwnerId}`),
    `deepLink should end with /contracts/${contractEmailOwnerId}, got ${String(deepLink)}`,
  );

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

  // --- Default-off org assertions ---
  // The default-off org's contract should still have an alert row
  // (the in-app inbox always works) but NO owner_notification event,
  // because the tenant hasn't opted in.
  const defaultAlerts = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.orgId, orgDefaultId));
  assert.equal(
    defaultAlerts.length,
    1,
    "default-off org should still get an alert row",
  );
  const defaultAlert = defaultAlerts[0]!;
  const defaultEvents = await db
    .select()
    .from(alertEventsTable)
    .where(eq(alertEventsTable.alertId, defaultAlert.id));
  const defaultOwnerNotifs = defaultEvents.filter(
    (e) => (e.metadata as { kind?: string }).kind === "owner_notification",
  );
  assert.equal(
    defaultOwnerNotifs.length,
    0,
    "default-off org must NOT generate owner_notification events",
  );

  // The handler return should reflect: at least 1 simulated (the
  // opted-in email owner), 2 skipped (Bob Smith + null owner from the
  // opted-in org), and 1 disabled (the default-off org's contract).
  // Other tenants in the test database may bump these counters, so
  // we assert lower bounds.
  assert.ok(
    result.ownerEmailsSimulated >= 1,
    `expected ownerEmailsSimulated >= 1, got ${result.ownerEmailsSimulated}`,
  );
  assert.ok(
    result.ownerEmailsSkipped >= 2,
    `expected ownerEmailsSkipped >= 2, got ${result.ownerEmailsSkipped}`,
  );
  assert.ok(
    result.ownerEmailsDisabled >= 1,
    `expected ownerEmailsDisabled >= 1, got ${result.ownerEmailsDisabled}`,
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

test("buildAppDeepLink: env-var resolution order", () => {
  // Snapshot env so we can restore it after each branch without
  // leaking state into other tests in the same process.
  const origAppBaseUrl = process.env["APP_BASE_URL"];
  const origReplitDomains = process.env["REPLIT_DOMAINS"];

  try {
    // Branch 1: APP_BASE_URL wins outright, even when REPLIT_DOMAINS
    // is also set. Trailing slash on the base must be normalised.
    process.env["APP_BASE_URL"] = "https://procuro.example/";
    process.env["REPLIT_DOMAINS"] = "should-not-be-used.replit.dev";
    assert.equal(
      buildAppDeepLink("/contracts/abc"),
      "https://procuro.example/contracts/abc",
    );

    // Branch 2: APP_BASE_URL unset, REPLIT_DOMAINS used (first entry,
    // trimmed, prefixed with https://).
    delete process.env["APP_BASE_URL"];
    process.env["REPLIT_DOMAINS"] = " a.replit.dev , b.replit.dev ";
    assert.equal(
      buildAppDeepLink("/contracts/xyz"),
      "https://a.replit.dev/contracts/xyz",
    );

    // Branch 3: neither env set → relative fallback. Path passed in
    // without a leading slash must still produce a leading-slash
    // path so callers don't generate "contracts/x" by accident.
    delete process.env["APP_BASE_URL"];
    delete process.env["REPLIT_DOMAINS"];
    assert.equal(buildAppDeepLink("/contracts/zzz"), "/contracts/zzz");
    assert.equal(buildAppDeepLink("contracts/no-slash"), "/contracts/no-slash");

    // Empty-string envs must be treated as unset, not as a valid
    // base URL — otherwise we'd ship "/contracts/x" with no host
    // through the explicit branch and look like we configured it.
    process.env["APP_BASE_URL"] = "";
    process.env["REPLIT_DOMAINS"] = "";
    assert.equal(buildAppDeepLink("/contracts/empty"), "/contracts/empty");
  } finally {
    if (typeof origAppBaseUrl === "string") {
      process.env["APP_BASE_URL"] = origAppBaseUrl;
    } else {
      delete process.env["APP_BASE_URL"];
    }
    if (typeof origReplitDomains === "string") {
      process.env["REPLIT_DOMAINS"] = origReplitDomains;
    } else {
      delete process.env["REPLIT_DOMAINS"];
    }
  }
});

test("readRenewalEmailEnabled: strict-true semantics", () => {
  // Truthy paths — only literal `true` and the string "true"
  // (case-insensitive) opt the tenant in.
  assert.equal(readRenewalEmailEnabled({ contractRenewalEmailEnabled: true }), true);
  assert.equal(readRenewalEmailEnabled({ contractRenewalEmailEnabled: "true" }), true);
  assert.equal(readRenewalEmailEnabled({ contractRenewalEmailEnabled: "TRUE" }), true);

  // Everything else falls back to the safe default of `false`. This
  // is the spam-prevention contract — a typo in the settings JSON
  // must NEVER accidentally enable the side-channel.
  assert.equal(readRenewalEmailEnabled(null), false);
  assert.equal(readRenewalEmailEnabled(undefined), false);
  assert.equal(readRenewalEmailEnabled({}), false);
  assert.equal(readRenewalEmailEnabled({ contractRenewalEmailEnabled: false }), false);
  assert.equal(readRenewalEmailEnabled({ contractRenewalEmailEnabled: "false" }), false);
  assert.equal(readRenewalEmailEnabled({ contractRenewalEmailEnabled: 1 }), false);
  assert.equal(readRenewalEmailEnabled({ contractRenewalEmailEnabled: "1" }), false);
  assert.equal(readRenewalEmailEnabled({ contractRenewalEmailEnabled: "yes" }), false);
  assert.equal(readRenewalEmailEnabled({ contractRenewalEmailEnabled: "on" }), false);
  assert.equal(readRenewalEmailEnabled({ contractRenewalEmailEnabled: null }), false);
});
