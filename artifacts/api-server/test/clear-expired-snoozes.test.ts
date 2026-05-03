/**
 * Integration test for the auto-clear-expired-snoozes job (task #228).
 *
 * The default opportunities list / Today feed has always honoured
 * `snoozed_until <= now()` via SQL filter, so a row whose deadline has
 * passed is *displayed* as un-snoozed even before this job runs. But
 * the column itself is never NULLed, so audit / reporting queries
 * ("how many rows are currently snoozed?") would otherwise stay
 * permanently wrong as past timestamps pile up.
 *
 * Invariants pinned here:
 *
 *   - Rows whose `snoozed_until` is in the PAST get NULLed.
 *   - Rows whose `snoozed_until` is in the FUTURE are left alone.
 *   - Rows that were never snoozed (NULL) are left alone.
 *   - Each cleared row gets exactly one `unsnooze` decision row with
 *     `actor='system'` so the audit trail is complete.
 *   - A second invocation is a no-op (the WHERE clause stops matching).
 *   - `ensureClearExpiredSnoozesScheduled` is idempotent under
 *     contention.
 *
 * Prereqs: `DATABASE_URL` is set and the schema has been pushed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  jobsTable,
  orgsTable,
  opportunitiesTable,
  decisionsTable,
  analysisCyclesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

import {
  clearExpiredSnoozes,
  ensureClearExpiredSnoozesScheduled,
} from "../src/lib/jobs/queue";

const RUN_TAG = `clear-expired-snoozes-test-${Date.now()}-${process.pid}`;
const ORG_ID = `${RUN_TAG}-org`;
const CYCLE_ID = `${RUN_TAG}-cyc`;
const LEVER_ID = "supplier_consolidation" as const;

interface SeededRow {
  id: string;
  /** Hours ago for snoozed_until; positive = past, negative = future, null = never snoozed. */
  snoozedUntilHoursOffset: number | null;
}

const SEEDED_ROWS: SeededRow[] = [
  // Past deadline → must be cleared, decision written.
  { id: `${RUN_TAG}-row-past-1`, snoozedUntilHoursOffset: 1 },
  { id: `${RUN_TAG}-row-past-2`, snoozedUntilHoursOffset: 240 },
  // Future deadline → must be left alone.
  { id: `${RUN_TAG}-row-future`, snoozedUntilHoursOffset: -24 },
  // Never snoozed → must be left alone.
  { id: `${RUN_TAG}-row-null`, snoozedUntilHoursOffset: null },
];

const ROW_IDS = SEEDED_ROWS.map((r) => r.id);

async function cleanup(): Promise<void> {
  await db
    .delete(jobsTable)
    .where(eq(jobsTable.kind, "clear_expired_snoozes" as const));
  await db
    .delete(decisionsTable)
    .where(inArray(decisionsTable.opportunityId, ROW_IDS));
  await db
    .delete(opportunitiesTable)
    .where(inArray(opportunitiesTable.id, ROW_IDS));
  await db
    .delete(analysisCyclesTable)
    .where(eq(analysisCyclesTable.id, CYCLE_ID));
  await db.delete(orgsTable).where(eq(orgsTable.id, ORG_ID));
}

async function seed(): Promise<void> {
  const now = Date.now();

  await db
    .insert(orgsTable)
    .values({ id: ORG_ID, name: ORG_ID, slug: ORG_ID })
    .onConflictDoNothing();

  await db.insert(analysisCyclesTable).values({
    id: CYCLE_ID,
    orgId: ORG_ID,
    generation: 1,
    triggeredBy: "test",
    status: "completed" as const,
    startedAt: new Date(now - 60_000),
    completedAt: new Date(now - 30_000),
  });

  await db.insert(opportunitiesTable).values(
    SEEDED_ROWS.map((r) => ({
      id: r.id,
      orgId: ORG_ID,
      cycleId: CYCLE_ID,
      leverId: LEVER_ID,
      tier: 1,
      title: r.id,
      rationale: "test",
      recommendedAction: "test",
      rawProjectedSavingsUsd: "100.00",
      projectedSavingsUsd: "100.00",
      confidence: "0.5000",
      inputs: {},
      status: "proposed" as const,
      snoozedUntil:
        r.snoozedUntilHoursOffset === null
          ? null
          : new Date(now - r.snoozedUntilHoursOffset * 60 * 60 * 1000),
    })),
  );
}

async function snoozedById(): Promise<Map<string, Date | null>> {
  const rows = await db
    .select({
      id: opportunitiesTable.id,
      snoozedUntil: opportunitiesTable.snoozedUntil,
    })
    .from(opportunitiesTable)
    .where(inArray(opportunitiesTable.id, ROW_IDS));
  return new Map(rows.map((r) => [r.id, r.snoozedUntil]));
}

test("clearExpiredSnoozes NULLs past deadlines, leaves future/null rows alone, writes system unsnooze decisions", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  await cleanup();
  await seed();
  t.after(async () => {
    try {
      await cleanup();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("cleanup failed", err);
    }
  });

  const result = await clearExpiredSnoozes();
  assert.ok(
    result.cleared >= 2,
    `expected at least the 2 past-deadline rows to be cleared, got ${result.cleared}`,
  );
  assert.equal(
    result.decisionsWritten,
    result.cleared,
    "every cleared row must get a matching decision row",
  );

  const after = await snoozedById();
  assert.equal(
    after.get(`${RUN_TAG}-row-past-1`),
    null,
    "past-deadline row must be cleared",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-past-2`),
    null,
    "old past-deadline row must be cleared",
  );
  assert.ok(
    after.get(`${RUN_TAG}-row-future`) instanceof Date,
    "future-deadline row must NOT be cleared",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-null`),
    null,
    "never-snoozed row stays NULL (unchanged)",
  );

  // Verify each cleared row got exactly one system unsnooze decision.
  for (const id of [`${RUN_TAG}-row-past-1`, `${RUN_TAG}-row-past-2`]) {
    const decisions = await db
      .select({
        eventType: decisionsTable.eventType,
        actor: decisionsTable.actor,
      })
      .from(decisionsTable)
      .where(
        and(
          eq(decisionsTable.opportunityId, id),
          eq(decisionsTable.eventType, "unsnooze" as const),
        ),
      );
    assert.equal(
      decisions.length,
      1,
      `row ${id} must have exactly one unsnooze decision row`,
    );
    assert.equal(
      decisions[0]?.actor,
      "system",
      `row ${id}'s unsnooze decision must be attributed to actor='system'`,
    );
  }

  // Future and never-snoozed rows must NOT have a system unsnooze decision.
  for (const id of [`${RUN_TAG}-row-future`, `${RUN_TAG}-row-null`]) {
    const decisions = await db
      .select({ id: decisionsTable.id })
      .from(decisionsTable)
      .where(
        and(
          eq(decisionsTable.opportunityId, id),
          eq(decisionsTable.eventType, "unsnooze" as const),
        ),
      );
    assert.equal(
      decisions.length,
      0,
      `row ${id} must NOT have a system unsnooze decision row`,
    );
  }
});

test("clearExpiredSnoozes second run is a no-op once nothing is stale", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  await cleanup();
  await seed();
  t.after(async () => {
    try {
      await cleanup();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("cleanup failed", err);
    }
  });

  await clearExpiredSnoozes();
  const second = await clearExpiredSnoozes();
  assert.equal(
    second.cleared,
    0,
    "no rows remain stale after the first sweep, so the second is a no-op",
  );
  assert.equal(
    second.decisionsWritten,
    0,
    "no decision rows are written when nothing is cleared",
  );
});

test("ensureClearExpiredSnoozesScheduled is idempotent under contention", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  await db
    .delete(jobsTable)
    .where(eq(jobsTable.kind, "clear_expired_snoozes" as const));
  t.after(async () => {
    await db
      .delete(jobsTable)
      .where(eq(jobsTable.kind, "clear_expired_snoozes" as const));
  });

  const first = await ensureClearExpiredSnoozesScheduled();
  assert.ok(first, "first call inserts a pending job");
  assert.equal(first?.kind, "clear_expired_snoozes");
  assert.equal(first?.status, "pending");

  const second = await ensureClearExpiredSnoozesScheduled();
  assert.equal(
    second,
    null,
    "second call is a no-op while the prior row is still pending",
  );

  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.kind, "clear_expired_snoozes" as const));
  assert.equal(rows.length, 1, "only one pending job row exists");
});

test.after(async () => {
  await pool.end();
});
