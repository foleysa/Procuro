/**
 * Integration test for the periodic job-pruner.
 *
 * The `jobs` table grows unbounded as analysis cycles, ingests, and
 * collectors enqueue jobs. The pruner is responsible for trimming
 * `succeeded` jobs after a short retention window and `failed` jobs
 * after a longer one (so operators can still inspect them). The
 * invariants pinned here:
 *
 *   - `pruneOldJobs` deletes succeeded jobs with `completed_at` older
 *     than the configured succeeded window.
 *   - It deletes failed jobs older than the configured failed window,
 *     while keeping fresher failed jobs around for inspection.
 *   - It NEVER deletes `pending` or `running` jobs, regardless of how
 *     old their `enqueued_at` is — a long-running job must not be
 *     pruned out from under the worker.
 *   - Recently-completed jobs (inside both windows) are left alone.
 *   - The returned counts match the number of rows actually deleted.
 *   - `ensurePruneJobScheduled` is idempotent: calling it while a
 *     `prune_jobs` row is already pending returns `null` and inserts
 *     no second row, so a server restart loop or a fast scheduler
 *     tick can't pile up duplicate prune jobs.
 *
 * Prereqs:
 *   - `DATABASE_URL` is set and the schema has been pushed
 *     (`pnpm --filter @workspace/db run push`).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { db, pool, jobsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  pruneOldJobs,
  ensurePruneJobScheduled,
} from "../src/lib/jobs/queue";

const RUN_TAG = `prune-test-${Date.now()}-${process.pid}`;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface SeededJob {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  // Wall-clock age. Undefined for pending/running rows whose completed_at
  // is null.
  completedDaysAgo?: number;
}

const SEEDED: SeededJob[] = [
  { id: `${RUN_TAG}-old-success`, status: "succeeded", completedDaysAgo: 30 },
  { id: `${RUN_TAG}-fresh-success`, status: "succeeded", completedDaysAgo: 1 },
  { id: `${RUN_TAG}-old-failure`, status: "failed", completedDaysAgo: 90 },
  { id: `${RUN_TAG}-fresh-failure`, status: "failed", completedDaysAgo: 10 },
  { id: `${RUN_TAG}-pending`, status: "pending" },
  { id: `${RUN_TAG}-running`, status: "running" },
];

const SEEDED_IDS = SEEDED.map((s) => s.id);

async function seed(): Promise<void> {
  const now = Date.now();
  await db.insert(jobsTable).values(
    SEEDED.map((s) => ({
      id: s.id,
      orgId: null,
      kind: "run_analysis_cycle" as const,
      status: s.status,
      payload: { tag: RUN_TAG },
      result: {},
      progress: 0,
      attempts: 0,
      enqueuedAt: new Date(now - 60 * DAY_MS),
      startedAt:
        s.status === "running" || s.completedDaysAgo !== undefined
          ? new Date(now - 59 * DAY_MS)
          : null,
      completedAt:
        s.completedDaysAgo !== undefined
          ? new Date(now - s.completedDaysAgo * DAY_MS)
          : null,
    })),
  );
}

async function cleanup(): Promise<void> {
  await db.delete(jobsTable).where(inArray(jobsTable.id, SEEDED_IDS));
  // Also clean up any prune_jobs rows the second test inserted.
  await db
    .delete(jobsTable)
    .where(eq(jobsTable.kind, "prune_jobs" as const));
}

async function existingIds(): Promise<Set<string>> {
  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(inArray(jobsTable.id, SEEDED_IDS));
  return new Set(rows.map((r) => r.id));
}

test("pruneOldJobs deletes only completed jobs outside the retention windows", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Make sure no leftover prune_jobs rows from a previous failed run
  // confuse the second test in this file.
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

  // Use 7d / 30d so the seeded ages straddle both cutoffs.
  const result = await pruneOldJobs({
    succeededOlderThanMs: 7 * DAY_MS,
    failedOlderThanMs: 30 * DAY_MS,
  });

  assert.equal(
    result.succeededDeleted,
    1,
    "exactly one old succeeded job should be deleted",
  );
  assert.equal(
    result.failedDeleted,
    1,
    "exactly one old failed job should be deleted",
  );

  const remaining = await existingIds();
  assert.ok(
    !remaining.has(`${RUN_TAG}-old-success`),
    "30-day-old succeeded job must be pruned",
  );
  assert.ok(
    !remaining.has(`${RUN_TAG}-old-failure`),
    "90-day-old failed job must be pruned",
  );
  assert.ok(
    remaining.has(`${RUN_TAG}-fresh-success`),
    "1-day-old succeeded job must be kept",
  );
  assert.ok(
    remaining.has(`${RUN_TAG}-fresh-failure`),
    "10-day-old failed job must be kept (within 30d window)",
  );
  assert.ok(
    remaining.has(`${RUN_TAG}-pending`),
    "pending jobs must never be pruned regardless of age",
  );
  assert.ok(
    remaining.has(`${RUN_TAG}-running`),
    "running jobs must never be pruned regardless of age",
  );

  // Re-running with the same windows is a no-op now that the matching
  // rows are gone — confirms the cutoff is applied per call, not
  // cumulatively.
  const second = await pruneOldJobs({
    succeededOlderThanMs: 7 * DAY_MS,
    failedOlderThanMs: 30 * DAY_MS,
  });
  assert.equal(second.succeededDeleted, 0);
  assert.equal(second.failedDeleted, 0);
});

test("ensurePruneJobScheduled does not enqueue a duplicate prune_jobs row", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Start from a clean slate so we count only what this test enqueues.
  await db
    .delete(jobsTable)
    .where(eq(jobsTable.kind, "prune_jobs" as const));

  t.after(async () => {
    try {
      await db
        .delete(jobsTable)
        .where(eq(jobsTable.kind, "prune_jobs" as const));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("cleanup failed", err);
    }
  });

  const first = await ensurePruneJobScheduled();
  assert.ok(first, "first call should enqueue a prune_jobs row");
  assert.equal(first?.kind, "prune_jobs");
  assert.equal(first?.status, "pending");

  const second = await ensurePruneJobScheduled();
  assert.equal(
    second,
    null,
    "second call must be a no-op while a prune_jobs row is still pending",
  );

  const pendingPruneRows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.kind, "prune_jobs" as const));
  assert.equal(
    pendingPruneRows.length,
    1,
    "only the first prune_jobs row should exist in the table",
  );
});

test("ensurePruneJobScheduled is race-free under concurrent callers", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Start from a clean slate so the only prune_jobs rows in the table
  // are the ones this test enqueues.
  await db
    .delete(jobsTable)
    .where(eq(jobsTable.kind, "prune_jobs" as const));

  t.after(async () => {
    try {
      await db
        .delete(jobsTable)
        .where(eq(jobsTable.kind, "prune_jobs" as const));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("cleanup failed", err);
    }
  });

  // Fire many schedule attempts in parallel. Without the
  // advisory-lock-protected check-then-insert in
  // `ensurePruneJobScheduled`, several of these would each observe
  // "no active prune", each pass the SELECT, and each INSERT — leaving
  // multiple pending `prune_jobs` rows. With the lock, exactly one
  // call wins.
  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, () => ensurePruneJobScheduled()),
  );

  const insertedCount = results.filter((r) => r !== null).length;
  assert.equal(
    insertedCount,
    1,
    "exactly one concurrent caller should win the race and enqueue",
  );

  const pendingPruneRows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.kind, "prune_jobs" as const));
  assert.equal(
    pendingPruneRows.length,
    1,
    "no duplicate prune_jobs rows should be created under concurrency",
  );
});

test.after(async () => {
  await pool.end();
});
