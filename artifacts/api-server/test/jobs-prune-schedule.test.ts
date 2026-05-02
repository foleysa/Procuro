/**
 * Integration tests for the operator-tunable prune_jobs schedule
 * (task #158).
 *
 * The pruner used to fire on a fixed `setInterval` driven by
 * `JOB_PRUNE_INTERVAL_MS`. It now reads a persisted cron expression
 * from `app_settings` so a Platform Admin can change the cadence at
 * runtime. The invariants pinned here:
 *
 *   - `getJobPruneSchedule()` returns the in-code default
 *     (`DEFAULT_JOB_PRUNE_CRON`) when no `app_settings` row exists,
 *     and reports `isOverride=false`.
 *   - `setJobPruneSchedule()` validates the cron, persists it,
 *     stamps `lastChangedBy`/`lastChangedAt`, and the next read
 *     reports `isOverride=true`.
 *   - A second `setJobPruneSchedule()` call replaces the value
 *     in-place (UPSERT — no duplicate row), and the audit metadata
 *     reflects the latest writer.
 *   - Invalid cron expressions throw rather than silently writing
 *     garbage that would later wedge the scheduler.
 *   - `getNextJobPruneRunAt()` returns a future timestamp consistent
 *     with the persisted cron.
 *   - A malformed stored value falls back to the default rather than
 *     crashing — the route exposes a way to recover by writing a new
 *     valid cron.
 *
 * Prereqs:
 *   - `DATABASE_URL` is set and the schema has been pushed
 *     (`pnpm --filter @workspace/db run sync`).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  appSettingsTable,
  APP_SETTING_KEY_JOB_PRUNE_SCHEDULE,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  DEFAULT_JOB_PRUNE_CRON,
  getJobPruneSchedule,
  getNextJobPruneRunAt,
  parsePruneCron,
  setJobPruneSchedule,
} from "../src/lib/jobs/queue";

async function clearScheduleRow(): Promise<void> {
  await db
    .delete(appSettingsTable)
    .where(eq(appSettingsTable.key, APP_SETTING_KEY_JOB_PRUNE_SCHEDULE));
}

test("getJobPruneSchedule returns the in-code default when no override exists", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  await clearScheduleRow();
  t.after(clearScheduleRow);

  const sched = await getJobPruneSchedule();
  assert.equal(sched.cron, DEFAULT_JOB_PRUNE_CRON);
  assert.equal(sched.defaultCron, DEFAULT_JOB_PRUNE_CRON);
  assert.equal(sched.isOverride, false);
  assert.equal(sched.lastChangedAt, null);
  assert.equal(sched.lastChangedBy, null);
});

test("setJobPruneSchedule persists a valid cron and reports it as an override", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  await clearScheduleRow();
  t.after(clearScheduleRow);

  const beforeWrite = Date.now();
  const updated = await setJobPruneSchedule({
    cron: "0 3 * * *", // 03:00 daily
    actorEmail: "admin@example.com",
  });
  assert.equal(updated.cron, "0 3 * * *");
  assert.equal(updated.isOverride, true);
  assert.equal(updated.lastChangedBy, "admin@example.com");
  assert.ok(updated.lastChangedAt);
  assert.ok(updated.lastChangedAt.getTime() >= beforeWrite - 1000);

  const reread = await getJobPruneSchedule();
  assert.equal(reread.cron, "0 3 * * *");
  assert.equal(reread.isOverride, true);
  assert.equal(reread.lastChangedBy, "admin@example.com");
});

test("setJobPruneSchedule UPSERTs (no duplicate rows, audit reflects latest writer)", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  await clearScheduleRow();
  t.after(clearScheduleRow);

  await setJobPruneSchedule({
    cron: "0 1 * * *",
    actorEmail: "first@example.com",
  });
  await setJobPruneSchedule({
    cron: "30 4 * * *",
    actorEmail: "second@example.com",
  });

  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, APP_SETTING_KEY_JOB_PRUNE_SCHEDULE));
  assert.equal(rows.length, 1, "UPSERT must keep exactly one row per key");
  const sched = await getJobPruneSchedule();
  assert.equal(sched.cron, "30 4 * * *");
  assert.equal(sched.lastChangedBy, "second@example.com");
});

test("setJobPruneSchedule rejects malformed crons before writing to the DB", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  await clearScheduleRow();
  t.after(clearScheduleRow);

  await assert.rejects(
    () => setJobPruneSchedule({ cron: "", actorEmail: "x@y.z" }),
    /must not be empty/,
  );
  await assert.rejects(
    () => setJobPruneSchedule({ cron: "not a cron", actorEmail: "x@y.z" }),
    /5 fields|Invalid/,
  );
  await assert.rejects(
    () =>
      setJobPruneSchedule({ cron: "70 * * * *", actorEmail: "x@y.z" }),
    /Invalid/,
  );

  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, APP_SETTING_KEY_JOB_PRUNE_SCHEDULE));
  assert.equal(
    rows.length,
    0,
    "no row should be written when validation fails",
  );
});

test("parsePruneCron accepts 5-field expressions and rejects 6-field ones", () => {
  assert.doesNotThrow(() => parsePruneCron("0 */6 * * *"));
  assert.doesNotThrow(() => parsePruneCron("@daily"));
  assert.doesNotThrow(() => parsePruneCron("15 2 * * 1"));
  assert.throws(() => parsePruneCron("0 0 0 * * *"), /5 fields/);
  assert.throws(() => parsePruneCron("   "), /must not be empty/);
});

test("getNextJobPruneRunAt returns a future timestamp consistent with the persisted cron", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  await clearScheduleRow();
  t.after(clearScheduleRow);

  // Daily at 03:00 — easy to reason about: the next fire is always
  // either today's 03:00 (if we're before it) or tomorrow's 03:00.
  await setJobPruneSchedule({
    cron: "0 3 * * *",
    actorEmail: "admin@example.com",
  });
  const next = await getNextJobPruneRunAt();
  assert.ok(
    next.getTime() > Date.now(),
    "next run must be in the future",
  );
  assert.equal(next.getUTCMinutes(), 0);
  assert.equal(next.getUTCHours(), 3);
});

test("getJobPruneSchedule falls back to the default when the stored cron is malformed", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  await clearScheduleRow();
  t.after(clearScheduleRow);

  // Simulate a row written by an older process (or by a manual SQL
  // edit) that violates the current parser's rules. The pruner
  // should keep working on the default rather than crashing.
  await db.insert(appSettingsTable).values({
    key: APP_SETTING_KEY_JOB_PRUNE_SCHEDULE,
    value: { cron: "totally-not-a-cron" },
    lastChangedAt: new Date(),
    lastChangedBy: "legacy@example.com",
  });

  const sched = await getJobPruneSchedule();
  assert.equal(sched.cron, DEFAULT_JOB_PRUNE_CRON);
  assert.equal(sched.isOverride, false);
});

test.after(async () => {
  await pool.end();
});
