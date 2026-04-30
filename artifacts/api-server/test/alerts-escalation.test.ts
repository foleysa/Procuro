/**
 * Integration test for `escalateAlertsTick` with an injectable clock.
 *
 * The escalation worker is what catches "ack-rot": an alert that comes
 * in, sits in the inbox, and never gets acknowledged before some
 * tenant-defined deadline. Without this, a critical sanctions hit could
 * languish for days. The contract pinned here:
 *
 *   - An open alert that has been sitting >= `policy.unackedHours` past
 *     its `first_seen_at` MUST be escalated: `escalated_at` is set, an
 *     `escalated` event is appended, and the configured channel
 *     adapter's `send` is invoked. The function reports the escalated
 *     count back to the caller (used by the periodic job's progress).
 *
 *   - Alerts younger than the threshold MUST NOT be escalated, even if
 *     all other conditions match. This is the whole point of the timer.
 *
 *   - Alerts whose severity is below `policy.severityAtLeast` MUST be
 *     skipped — the policy is a per-severity SLA.
 *
 *   - Once an alert has been escalated (`escalated_at` not null), a
 *     subsequent tick MUST NOT escalate it again. Re-escalation would
 *     cause every cron tick to re-page the on-call.
 *
 * The test passes its own clock via `escalateAlertsTick({ now })` so the
 * escalation threshold can be satisfied deterministically without
 * sleeping or backdating columns. The escalation channel is an `email`
 * channel with no SENDGRID_API_KEY, so the adapter records a simulated
 * delivery and returns `status: "simulated"` — that's fine for the
 * test, which is about the *escalation* control flow, not the delivery
 * provider.
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
  alertChannelsTable,
  escalationPoliciesTable,
  orgsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { newId } from "../src/lib/ids";
import { createAlert } from "@workspace/intelligence";
import { escalateAlertsTick } from "../src/lib/alerts/delivery";

const RUN = `alerts-escalate-${Date.now()}-${process.pid}`;
const orgId = newId("org");
const userId = newId("usr");
const channelId = newId("ch");
const policyId = newId("ep");

// We anchor every "now" we hand to the worker against this fixed
// reference so the threshold math is obvious in the assertions below.
const T0 = new Date("2025-06-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

test.before(async () => {
  // Force the email adapter into its simulated branch — the test is
  // about escalation timing, not provider integration.
  delete process.env["SENDGRID_API_KEY"];

  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} Test Org`,
    slug: `${RUN}-org`,
  });
  await db.insert(usersTable).values({
    id: userId,
    orgId,
    email: `oncall-${RUN}@example.test`,
    name: "On Call",
    role: "admin",
  });
  await db.insert(alertChannelsTable).values({
    id: channelId,
    orgId,
    kind: "email",
    name: "Test escalation channel",
    config: {
      to: [`oncall-${RUN}@example.test`],
      from: "alerts@example.test",
    },
    enabled: true,
  });
  await db.insert(escalationPoliciesTable).values({
    id: policyId,
    orgId,
    name: "Test policy",
    enabled: true,
    severityAtLeast: "high",
    unackedHours: 4,
    escalateToUserId: userId,
    channelId,
  });
});

test.after(async () => {
  // Cascade deletes alerts, events, channels, policies, users, etc.
  await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  await pool.end();
});

async function backdateFirstSeen(alertId: string, hoursAgo: number): Promise<void> {
  // The escalation worker reads `first_seen_at` to compare against the
  // injected `now - unackedHours`. Test fixtures need an explicit
  // backdate because `createAlert` always stamps `firstSeenAt = now()`.
  const stamp = new Date(T0.getTime() - hoursAgo * HOUR);
  await db
    .update(alertsTable)
    .set({ firstSeenAt: stamp, lastSeenAt: stamp })
    .where(eq(alertsTable.id, alertId));
}

test("escalateAlertsTick escalates an open, high-sev alert that's older than the unackedHours window", async () => {
  // Seed an alert that has been sitting open for 5 hours, against a
  // policy with a 4 hour SLA. With `now = T0`, this alert's age is
  // 5h ≥ 4h, so it must escalate on this tick.
  const created = await createAlert({
    orgId,
    severity: "high",
    source: "sanctions",
    kind: "test_escalate_old",
    title: `${RUN} should escalate`,
  });
  await backdateFirstSeen(created.alert.id, 5);

  const result = await escalateAlertsTick({ now: () => T0 });

  // The function may evaluate other policies seeded by adjacent tests
  // or seed data, so we assert on the *minimum* escalation count and
  // verify our specific row by id below.
  assert.ok(
    result.alertsEscalated >= 1,
    `expected at least one escalation, got ${result.alertsEscalated}`,
  );

  const [post] = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.id, created.alert.id));
  assert.ok(post, "escalated alert must still exist after the tick");
  assert.ok(
    post.escalatedAt instanceof Date,
    "escalated_at must be set on the row that breached the SLA",
  );

  const events = await db
    .select()
    .from(alertEventsTable)
    .where(eq(alertEventsTable.alertId, created.alert.id));
  const types = events.map((e) => e.eventType).sort();
  assert.ok(
    types.includes("escalated"),
    `events must include 'escalated', got ${types.join(", ")}`,
  );
});

test("escalateAlertsTick leaves a fresh alert alone, even if severity matches", async () => {
  // 1 hour old vs a 4 hour SLA. Below the threshold → must NOT escalate.
  const created = await createAlert({
    orgId,
    severity: "critical",
    source: "sanctions",
    kind: "test_escalate_fresh",
    title: `${RUN} too fresh`,
  });
  await backdateFirstSeen(created.alert.id, 1);

  await escalateAlertsTick({ now: () => T0 });

  const [post] = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.id, created.alert.id));
  assert.equal(
    post?.escalatedAt,
    null,
    "alert younger than unackedHours must NOT be escalated",
  );
});

test("escalateAlertsTick skips alerts below the policy's severity floor", async () => {
  // Old enough (10h) but only 'low' severity, vs a policy that requires
  // 'high'. Must NOT escalate.
  const created = await createAlert({
    orgId,
    severity: "low",
    source: "sanctions",
    kind: "test_escalate_low_sev",
    title: `${RUN} too low sev`,
  });
  await backdateFirstSeen(created.alert.id, 10);

  await escalateAlertsTick({ now: () => T0 });

  const [post] = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.id, created.alert.id));
  assert.equal(
    post?.escalatedAt,
    null,
    "alert below severityAtLeast must NOT be escalated",
  );
});

test("escalateAlertsTick does not re-escalate an already-escalated alert", async () => {
  // Seed an old, high-sev alert and run the worker twice. The second
  // run must NOT re-set escalated_at (we'd otherwise re-page on every
  // tick) and must NOT append a second 'escalated' event.
  const created = await createAlert({
    orgId,
    severity: "high",
    source: "sanctions",
    kind: "test_escalate_once",
    title: `${RUN} escalate once`,
  });
  await backdateFirstSeen(created.alert.id, 6);

  await escalateAlertsTick({ now: () => T0 });
  const [afterFirst] = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.id, created.alert.id));
  const firstEscalatedAt = afterFirst?.escalatedAt ?? null;
  assert.ok(
    firstEscalatedAt instanceof Date,
    "first tick must escalate the breached alert",
  );

  // Second tick at a later "now" — the alert is still open, still old,
  // still high-sev, but already escalated. Worker MUST not re-escalate.
  const T1 = new Date(T0.getTime() + 1 * HOUR);
  await escalateAlertsTick({ now: () => T1 });

  const [afterSecond] = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.id, created.alert.id));
  assert.equal(
    afterSecond?.escalatedAt?.getTime(),
    firstEscalatedAt.getTime(),
    "escalated_at must not move on a second tick (no re-escalation)",
  );

  const escalatedEvents = await db
    .select()
    .from(alertEventsTable)
    .where(eq(alertEventsTable.alertId, created.alert.id));
  const escalateCount = escalatedEvents.filter(
    (e) => e.eventType === "escalated",
  ).length;
  assert.equal(
    escalateCount,
    1,
    `exactly one 'escalated' event must be appended; got ${escalateCount}`,
  );
});
