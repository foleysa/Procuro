/**
 * Integration test for `createAlert`'s de-duplication contract.
 *
 * The single write-path for new alerts is `intelligence.createAlert`. It
 * upserts on `(orgId, dedupeKey)` so producers (collector fanout, the
 * synthesize_operational_alerts job, manual REST creates) can call it
 * idempotently without flooding the inbox. The invariants pinned here
 * — any future change to the dedupe semantics needs to update this test
 * and read its rationale comments first:
 *
 *   - First call with a `dedupeKey` inserts a row and returns
 *     `outcome === "created"`.
 *   - Re-calling with the same `(orgId, dedupeKey)` MUST NOT insert a
 *     second row; it bumps `occurrences` + `lastSeenAt`, returns
 *     `outcome === "bumped"`, and appends an `occurrence` audit event.
 *   - Severity is monotone: a re-occurrence at a *higher* severity
 *     raises the stored severity, but a re-occurrence at a *lower*
 *     severity must NOT downgrade the alert (otherwise a noisy low-sev
 *     producer could mask a real critical).
 *   - Calls without a `dedupeKey` always insert (one alert per call) —
 *     this is the explicit opt-out for producers that have no stable
 *     identity.
 *   - Re-occurrence of a previously-resolved alert reopens it, because
 *     a re-occurrence after resolution is itself news.
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
  orgsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createAlert, transitionAlert } from "@workspace/intelligence";
import { newId } from "../src/lib/ids";

const RUN = `alerts-dedupe-${Date.now()}-${process.pid}`;
const orgId = newId("org");

test.before(async () => {
  // A fresh org so we can scope dedupe-key collisions cleanly without
  // colliding with seeded tenant data.
  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} Test Org`,
    slug: `${RUN}-org`,
  });
});

test.after(async () => {
  // Cascade deletes alerts + alert_events via the org_id FK.
  await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  await pool.end();
});

test("createAlert inserts a brand-new row with outcome=created and a 'created' event", async () => {
  const dedupeKey = `${RUN}/sanctions/SUP-A`;
  const r = await createAlert({
    orgId,
    severity: "high",
    source: "sanctions",
    kind: "ofac_sdn_match",
    title: "Acme Trading Co matched OFAC SDN",
    summary: "Initial match.",
    dedupeKey,
    payload: { sources: [], matchScore: 0.91 },
  });

  assert.equal(r.outcome, "created");
  assert.equal(r.alert.orgId, orgId);
  assert.equal(r.alert.severity, "high");
  assert.equal(r.alert.dedupeKey, dedupeKey);
  assert.equal(r.alert.occurrences, 1);

  const events = await db
    .select()
    .from(alertEventsTable)
    .where(eq(alertEventsTable.alertId, r.alert.id));
  assert.equal(events.length, 1, "one created-event must be appended");
  assert.equal(events[0]?.eventType, "created");
});

test("re-calling with the same (orgId, dedupeKey) bumps occurrences instead of inserting a new row", async () => {
  const dedupeKey = `${RUN}/sanctions/SUP-B`;

  const first = await createAlert({
    orgId,
    severity: "medium",
    source: "sanctions",
    kind: "ofac_sdn_match",
    title: "Test dedupe bump",
    dedupeKey,
  });
  assert.equal(first.outcome, "created");
  assert.equal(first.alert.occurrences, 1);

  const second = await createAlert({
    orgId,
    severity: "medium",
    source: "sanctions",
    kind: "ofac_sdn_match",
    title: "Test dedupe bump",
    dedupeKey,
  });
  assert.equal(
    second.outcome,
    "bumped",
    "second call with the same dedupeKey must bump, not create",
  );
  assert.equal(
    second.alert.id,
    first.alert.id,
    "the bumped row must be the same row id",
  );
  assert.equal(second.alert.occurrences, 2);
  assert.ok(
    second.alert.lastSeenAt.getTime() >= first.alert.lastSeenAt.getTime(),
    "lastSeenAt must move forward (not backward) on a bump",
  );

  // Exactly one row must exist for this dedupeKey.
  const rows = await db
    .select()
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.orgId, orgId),
        eq(alertsTable.dedupeKey, dedupeKey),
      ),
    );
  assert.equal(
    rows.length,
    1,
    "the dedupe upsert must NOT create a second row",
  );

  // We expect a created event + an occurrence event on the bump.
  const events = await db
    .select()
    .from(alertEventsTable)
    .where(eq(alertEventsTable.alertId, first.alert.id));
  const types = events.map((e) => e.eventType).sort();
  assert.deepEqual(
    types,
    ["created", "occurrence"],
    `events must record both create and occurrence, got ${types.join(", ")}`,
  );
});

test("severity is monotone: a bump can raise but never lower the stored severity", async () => {
  const dedupeKey = `${RUN}/severity/SUP-C`;

  // Open at medium.
  const first = await createAlert({
    orgId,
    severity: "medium",
    source: "sanctions",
    kind: "test_kind",
    title: "Severity monotonicity",
    dedupeKey,
  });
  assert.equal(first.alert.severity, "medium");

  // Bump at critical → stored severity must be raised to critical.
  const raised = await createAlert({
    orgId,
    severity: "critical",
    source: "sanctions",
    kind: "test_kind",
    title: "Severity monotonicity",
    dedupeKey,
  });
  assert.equal(raised.outcome, "bumped");
  assert.equal(
    raised.alert.severity,
    "critical",
    "a higher-sev re-occurrence must raise severity",
  );

  // Bump again at low → stored severity must REMAIN critical.
  const lowered = await createAlert({
    orgId,
    severity: "low",
    source: "sanctions",
    kind: "test_kind",
    title: "Severity monotonicity",
    dedupeKey,
  });
  assert.equal(lowered.outcome, "bumped");
  assert.equal(
    lowered.alert.severity,
    "critical",
    "a lower-sev re-occurrence must NOT downgrade severity (would mask real criticals)",
  );
});

test("createAlert without a dedupeKey always inserts a new row", async () => {
  // Two calls with identical fields but no dedupeKey → two distinct
  // rows. This is the explicit opt-out for producers without a stable
  // identity.
  const a = await createAlert({
    orgId,
    severity: "info",
    source: "manual",
    kind: "ad_hoc",
    title: `${RUN} no-dedupe note`,
  });
  const b = await createAlert({
    orgId,
    severity: "info",
    source: "manual",
    kind: "ad_hoc",
    title: `${RUN} no-dedupe note`,
  });

  assert.equal(a.outcome, "created");
  assert.equal(b.outcome, "created");
  assert.notEqual(
    a.alert.id,
    b.alert.id,
    "without a dedupeKey, every call must insert a fresh alert id",
  );
});

test("re-occurrence after resolve reopens the alert", async () => {
  const dedupeKey = `${RUN}/reopen/SUP-D`;

  // Create + resolve.
  const first = await createAlert({
    orgId,
    severity: "high",
    source: "sanctions",
    kind: "test_reopen",
    title: "Reopen test",
    dedupeKey,
  });
  await transitionAlert({
    alertId: first.alert.id,
    action: "resolve",
    actor: "test@procuro.local",
  });

  const [resolvedRow] = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.id, first.alert.id));
  assert.equal(resolvedRow?.state, "resolved", "fixture must be resolved");

  // Re-occurrence should reopen because the underlying issue resurfaced.
  const reopened = await createAlert({
    orgId,
    severity: "high",
    source: "sanctions",
    kind: "test_reopen",
    title: "Reopen test",
    dedupeKey,
  });
  assert.equal(reopened.outcome, "bumped");
  assert.equal(
    reopened.alert.state,
    "open",
    "a re-occurrence after resolve must reopen the alert",
  );
});
