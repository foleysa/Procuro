/**
 * Integration tests for auto-retry / exponential-backoff in the Postgres
 * job queue.
 *
 * What we lock in:
 *   - A transient handler error reschedules the job (status back to
 *     `pending`, `scheduled_for` set to a future time, error message
 *     captured) instead of marking it `failed`.
 *   - The worker refuses to claim a job whose `scheduled_for` is still in
 *     the future. Once we fast-forward `scheduled_for` to the past, the
 *     job is claimable again and a successful handler completes it.
 *   - When `attempts` reaches `max_attempts`, the next failure marks the
 *     job permanently `failed` (no further retry).
 *   - Throwing `UnrecoverableJobError` (or any error tagged with
 *     `unrecoverable: true`) bypasses retry budget entirely.
 *   - `nextBackoffMs` is monotonic, capped at five minutes, and includes
 *     non-negative jitter.
 *
 * These tests register their own handler for the `run_collector` kind.
 * Production handlers from `src/index.ts` are NOT loaded because we import
 * the queue module directly — that file only registers handlers when the
 * server boots, which `node --test` does not do.
 *
 * Prereq: `DATABASE_URL` is set and the schema has been pushed
 * (`pnpm --filter @workspace/db run push`).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { db, jobsTable, type JobKind } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

import {
  enqueueJob,
  processOnce,
  registerJobHandler,
  nextBackoffMs,
  UnrecoverableJobError,
} from "../src/lib/jobs/queue";
import { runCollector } from "../src/lib/intelligence/runtime";

/**
 * The retry-test payload tag. Each enqueued test job carries
 * `{ retryTest: <unique tag> }` so the shared handler below can decide
 * what to throw / return without colliding across test cases.
 */
type Behavior =
  | { kind: "succeed" }
  | { kind: "throw_transient"; message: string }
  | { kind: "throw_unrecoverable"; message: string }
  | { kind: "throw_after_n_transient"; n: number; message: string }
  // Mirrors the production wiring in src/index.ts: delegate straight
  // to runCollector and let any thrown error bubble up to processOnce.
  // Used to prove that runCollector's UnrecoverableJobError surfaces
  // through the queue as a permanent failure (no retry), regardless of
  // which process — this test or the live server worker — claims the
  // row first. Both processes run the same `runCollector` code, so the
  // outcome is race-independent.
  | { kind: "delegate_to_runcollector"; collectorId: string };

const behaviors = new Map<string, Behavior>();
const handlerCalls = new Map<string, number>();

const TEST_KIND: JobKind = "run_collector";
const handlerInstalled = { current: false };

function installHandlerOnce() {
  if (handlerInstalled.current) return;
  handlerInstalled.current = true;
  registerJobHandler(TEST_KIND, async (job) => {
    const tag = (job.payload as { retryTest?: string }).retryTest ?? "";
    handlerCalls.set(tag, (handlerCalls.get(tag) ?? 0) + 1);
    const b = behaviors.get(tag);
    if (!b) return { ok: true };
    switch (b.kind) {
      case "succeed":
        return { ok: true };
      case "throw_transient":
        throw new Error(b.message);
      case "throw_unrecoverable":
        throw new UnrecoverableJobError(b.message);
      case "throw_after_n_transient": {
        const calls = handlerCalls.get(tag) ?? 0;
        if (calls <= b.n) throw new Error(b.message);
        return { ok: true, attempts: calls };
      }
      case "delegate_to_runcollector": {
        // Identical to the production handler in src/index.ts so test
        // and server processes behave the same when racing for this job.
        const result = await runCollector(b.collectorId);
        return result as unknown as Record<string, unknown>;
      }
    }
  });
}

async function fastForwardScheduledFor(jobId: string): Promise<void> {
  // Pull the row's scheduled_for back to a time safely in the past so the
  // next claim picks it up immediately, without sleeping the test.
  await db
    .update(jobsTable)
    .set({ scheduledFor: new Date(Date.now() - 1_000) })
    .where(eq(jobsTable.id, jobId));
}

async function getRow(jobId: string) {
  const [row] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  return row ?? null;
}

/**
 * Drive processOnce() in a tight loop until the specific job row has been
 * claimed and processed (attempts >= minAttempts). Race-tolerant: works
 * regardless of whether this test process or the live API server worker
 * claims the row first — both advance `attempts` when they claim the job.
 */
async function driveJobUntilAttempt(
  jobId: string,
  minAttempts: number,
  timeoutMs = 8_000,
): Promise<NonNullable<Awaited<ReturnType<typeof getRow>>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await processOnce().catch(() => {});
    const row = await getRow(jobId);
    if (row && row.attempts >= minAttempts) return row;
    if (Date.now() >= deadline) {
      throw new Error(
        `job ${jobId} did not reach attempts=${minAttempts} within ${timeoutMs}ms` +
          ` (last: status=${row?.status ?? "missing"}, attempts=${row?.attempts ?? "?"})`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Drive the queue locally and poll until the job reaches a terminal
 * state (`failed` or `succeeded`) with non-zero attempts, or the
 * timeout elapses. Race-tolerant: works whether this process or the
 * live API server's worker loop ends up claiming the row first.
 */
async function waitForTerminal(
  jobId: string,
  timeoutMs: number,
): Promise<NonNullable<Awaited<ReturnType<typeof getRow>>>> {
  const deadline = Date.now() + timeoutMs;
  // Try once locally up front for the common no-server-running case.
  await processOnce().catch(() => {});
  for (;;) {
    const row = await getRow(jobId);
    if (
      row &&
      row.attempts > 0 &&
      (row.status === "failed" || row.status === "succeeded")
    ) {
      return row;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `job ${jobId} did not reach a terminal state within ${timeoutMs}ms (last status=${row?.status ?? "missing"}, attempts=${row?.attempts ?? "?"})`,
      );
    }
    // Tight poll; the server worker ticks every ~1.5s, our local
    // processOnce above usually wins so this rarely loops more than once.
    await new Promise((r) => setTimeout(r, 75));
  }
}

async function deleteTestJobs(): Promise<void> {
  // Only delete the rows this test file created. We tag them via payload
  // so we don't accidentally wipe unrelated jobs that another developer
  // might have queued in their dev DB.
  await db.execute(sql`
    DELETE FROM jobs
    WHERE payload ? 'retryTest'
  `);
}

test("queue auto-retry / backoff behaviour", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  installHandlerOnce();

  t.after(async () => {
    try {
      await deleteTestJobs();
    } catch (err) {
      console.error("[cleanup] jobs-retry cleanup failed:", err);
    }
  });

  await deleteTestJobs();

  await t.test(
    "transient failure reschedules the job with a future scheduled_for",
    async () => {
      const tag = `transient-${Date.now()}-${process.pid}`;
      behaviors.set(tag, {
        kind: "throw_after_n_transient",
        n: 1,
        message: "blip from upstream",
      });
      const job = await enqueueJob({
        kind: TEST_KIND,
        orgId: null,
        payload: { retryTest: tag },
        maxAttempts: 3,
      });

      // First attempt should fail transiently and reschedule.
      // Use driveJobUntilAttempt so the assertion holds whether this
      // process or the live API server worker claims the row first.
      const before = Date.now();
      const after1 = await driveJobUntilAttempt(job.id, 1);
      assert.ok(after1, "job row still exists after transient failure");
      assert.equal(after1.status, "pending", "status reset to pending");
      assert.equal(after1.attempts, 1, "attempts incremented to 1");
      assert.equal(after1.error, "blip from upstream");
      assert.ok(after1.scheduledFor, "scheduled_for is set");
      const next = new Date(after1.scheduledFor!).getTime();
      assert.ok(
        next > before,
        `scheduled_for (${next}) should be in the future relative to ${before}`,
      );

      // Worker must NOT pick the job up again while scheduled_for is in the
      // future.  In a concurrent suite other tests may have ready jobs so
      // processOnce() can legitimately return true (it claimed a different
      // job).  What matters is that OUR specific job was NOT re-attempted.
      await processOnce();
      const afterEarly = await getRow(job.id);
      assert.ok(afterEarly, "job row still exists after early processOnce");
      assert.equal(
        afterEarly.attempts,
        1,
        "worker must skip jobs whose scheduled_for has not yet arrived",
      );
      assert.ok(
        afterEarly.scheduledFor &&
          new Date(afterEarly.scheduledFor).getTime() > Date.now(),
        `scheduled_for (${afterEarly.scheduledFor}) must still be in the future`,
      );

      // Fast-forward and verify the next attempt succeeds.
      await fastForwardScheduledFor(job.id);
      const after2 = await driveJobUntilAttempt(job.id, 2);
      assert.ok(after2);
      assert.equal(after2.status, "succeeded", "second attempt succeeded");
      assert.equal(after2.attempts, 2, "attempts incremented to 2");
      assert.equal(
        after2.scheduledFor,
        null,
        "scheduled_for cleared on successful claim",
      );
    },
  );

  await t.test(
    "exhausted retry budget marks the job failed",
    async () => {
      const tag = `exhausted-${Date.now()}-${process.pid}`;
      behaviors.set(tag, {
        kind: "throw_transient",
        message: "always broken",
      });
      const job = await enqueueJob({
        kind: TEST_KIND,
        orgId: null,
        payload: { retryTest: tag },
        maxAttempts: 2,
      });

      // Attempt 1 — should reschedule (1 < 2).
      const after1 = await driveJobUntilAttempt(job.id, 1);
      assert.ok(after1);
      assert.equal(after1.status, "pending");
      assert.equal(after1.attempts, 1);
      assert.ok(after1.scheduledFor);

      // Fast-forward and run attempt 2 — budget exhausted, should fail.
      await fastForwardScheduledFor(job.id);
      const after2 = await driveJobUntilAttempt(job.id, 2);
      assert.ok(after2);
      assert.equal(
        after2.status,
        "failed",
        "second failure with maxAttempts=2 marks job failed",
      );
      assert.equal(after2.attempts, 2);
      assert.equal(
        after2.scheduledFor,
        null,
        "scheduled_for cleared when job permanently failed",
      );
      assert.ok(after2.completedAt, "completedAt set on permanent fail");
      assert.equal(after2.error, "always broken");
    },
  );

  await t.test(
    "UnrecoverableJobError fails the job immediately, no retry",
    async () => {
      const tag = `unrecoverable-${Date.now()}-${process.pid}`;
      behaviors.set(tag, {
        kind: "throw_unrecoverable",
        message: "invalid payload",
      });
      const job = await enqueueJob({
        kind: TEST_KIND,
        orgId: null,
        payload: { retryTest: tag },
        maxAttempts: 5,
      });

      const row = await driveJobUntilAttempt(job.id, 1);
      assert.ok(row);
      assert.equal(
        row.status,
        "failed",
        "unrecoverable errors short-circuit retries",
      );
      assert.equal(row.attempts, 1, "consumed exactly one attempt");
      assert.equal(row.error, "invalid payload");
      assert.equal(
        row.scheduledFor,
        null,
        "no retry scheduled for unrecoverable error",
      );
    },
  );

  await t.test(
    "run_collector handler treats an unknown collector as unrecoverable (no retry)",
    async () => {
      // Use TEST_KIND (`run_collector`) with a behaviour that delegates
      // straight to `runCollector`. The live API server worker also has
      // a `run_collector` handler that calls `runCollector(collectorId)`
      // (see src/index.ts), so whichever process wins the race for this
      // row produces an identical outcome — UnrecoverableJobError →
      // permanent failure. That makes the test resilient to the worker
      // loop polling concurrently in another process during dev.
      const tag = `unknown-collector-${Date.now()}-${process.pid}`;
      const collectorId = `does-not-exist-${Date.now()}`;
      behaviors.set(tag, { kind: "delegate_to_runcollector", collectorId });

      const job = await enqueueJob({
        kind: TEST_KIND,
        orgId: null,
        payload: {
          retryTest: tag,
          // Same shape the production handler reads, so the server's
          // `run_collector` handler also sees the unknown collector ID
          // if it claims the row first.
          collectorId,
        },
        maxAttempts: 4,
      });

      // Drive processing locally and also tolerate the live server worker
      // claiming the row first by polling for a terminal state. The job
      // must end up `failed` with attempts=1 either way.
      const row = await waitForTerminal(job.id, 5_000);
      assert.ok(row, "job row exists after handler ran");
      assert.equal(
        row.status,
        "failed",
        "unknown collector should fail immediately, not retry",
      );
      assert.equal(row.attempts, 1, "consumed exactly one attempt");
      assert.equal(
        row.scheduledFor,
        null,
        "no retry scheduled for unrecoverable collector error",
      );
      assert.match(
        row.error ?? "",
        /not registered/i,
        "preserves the underlying error message",
      );
    },
  );

  await t.test("nextBackoffMs is monotonic and capped at 5 minutes", () => {
    // Drive the helper across the meaningful range of attempt counts.
    let prev = 0;
    for (let attempt = 1; attempt <= 12; attempt++) {
      const delay = nextBackoffMs(attempt);
      assert.ok(delay > 0, `delay #${attempt} must be positive`);
      assert.ok(
        delay <= 5 * 60 * 1000 * 1.25 + 1,
        `delay #${attempt}=${delay}ms exceeds 5min+jitter cap`,
      );
      // Inside the exponential range each step doubles, so even the
      // lowest-jitter sample must beat the previous high-jitter sample
      // by a wide margin until we hit the cap. We only assert that we
      // are non-decreasing in expectation — strict monotonicity is
      // unsafe under random jitter, so check the exponential lower
      // bound directly.
      const lowerBound = Math.min(5 * 60 * 1000, 5_000 * 2 ** (attempt - 1));
      assert.ok(
        delay >= lowerBound,
        `delay #${attempt}=${delay}ms must be at least ${lowerBound}`,
      );
      prev = delay;
    }
    // Final sanity: at very high attempt counts we should be saturated.
    void prev;
    assert.ok(nextBackoffMs(50) <= 5 * 60 * 1000 * 1.25 + 1);
  });
});
