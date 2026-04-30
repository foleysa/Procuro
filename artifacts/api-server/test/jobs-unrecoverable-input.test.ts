/**
 * Integration tests for the production job handlers' "fail fast on
 * known-permanent input" contract.
 *
 * The queue's auto-retry loop wraps every handler exception in
 * exponential backoff (5s, 10s, 20s, ...) before declaring a job
 * permanently failed. That's the right behaviour for transient errors
 * (upstream 5xx, DB connection blips), but it's pure waste for
 * deterministic input failures: a missing orgId, an unknown collector
 * ID, or a payload of the wrong shape will fail identically on every
 * retry. Wrapping those errors in `UnrecoverableJobError` short-circuits
 * the retry budget so the job lands in `failed` on attempt #1 and the
 * operator sees the breakage immediately.
 *
 * What we lock in:
 *   - `ingest_csv` with a missing orgId fails immediately (attempts=1)
 *   - `ingest_csv` with a malformed payload (`payload.csv` is not an
 *     object) fails immediately (attempts=1)
 *   - `ingest_mock_erp` with `payload.erp.feed` not an array fails
 *     immediately (attempts=1)
 *   - `run_analysis_cycle` with no orgId fails immediately (attempts=1)
 *   - `run_collector` with an empty collectorId fails immediately
 *     (attempts=1)
 *
 * In every case the recorded attempts must be exactly 1 and
 * `scheduledFor` must be cleared (no retry queued).
 *
 * Prereq: `DATABASE_URL` is set and the schema has been pushed
 * (`pnpm --filter @workspace/db run push`).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  orgsTable,
  pool,
  jobsTable,
  type JobKind,
  type JobRow,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

import {
  enqueueJob,
  processOnce,
  registerJobHandler,
} from "../src/lib/jobs/queue";
import {
  ingestCsvHandler,
  ingestMockErpHandler,
  runAnalysisCycleHandler,
  runCollectorHandler,
} from "../src/lib/jobs/handlers";

/**
 * Register the production handlers under the same JobKinds the live
 * server uses. The queue module is a singleton inside this process, so
 * these registrations swap in for whatever the live server would have
 * registered (which `node --test` doesn't trigger anyway because it
 * never imports `src/index.ts`). Tagging payloads via `unrecoverableTest`
 * lets the cleanup teardown find only this file's rows.
 */
const handlersInstalled = { current: false };
function installProductionHandlers(): void {
  if (handlersInstalled.current) return;
  handlersInstalled.current = true;
  registerJobHandler("ingest_csv", ingestCsvHandler);
  registerJobHandler("ingest_mock_erp", ingestMockErpHandler);
  registerJobHandler("run_analysis_cycle", runAnalysisCycleHandler);
  registerJobHandler("run_collector", runCollectorHandler);
}

async function getRow(jobId: string): Promise<JobRow | null> {
  const [row] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  return row ?? null;
}

/**
 * Drive `processOnce` until `jobId` reaches a terminal state, or the
 * deadline elapses. Race-tolerant against a live API server worker
 * polling concurrently in another process during dev — both processes
 * have the same handler wiring so the outcome is identical regardless
 * of who claims the row first.
 */
async function waitForTerminal(
  jobId: string,
  timeoutMs: number,
): Promise<NonNullable<Awaited<ReturnType<typeof getRow>>>> {
  const deadline = Date.now() + timeoutMs;
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
        `job ${jobId} did not reach a terminal state within ${timeoutMs}ms ` +
          `(last status=${row?.status ?? "missing"}, attempts=${row?.attempts ?? "?"})`,
      );
    }
    await processOnce().catch(() => {});
    await new Promise((r) => setTimeout(r, 75));
  }
}

async function deleteTestJobs(): Promise<void> {
  await db.execute(sql`
    DELETE FROM jobs
    WHERE payload ? 'unrecoverableTest'
  `);
}

/**
 * Pick any seeded org. Required because the `jobs.org_id` column has a
 * FK to `orgs(id)`, so the malformed-payload tests that enqueue with a
 * non-null orgId need a real id — even though their handlers will fail
 * before touching any org-scoped data.
 */
async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) {
    throw new Error(
      "No org seeded; cannot run jobs-unrecoverable-input integration test",
    );
  }
  return row.id;
}

/**
 * Enqueue a job whose payload is tagged with the given test id, then
 * wait for it to reach a terminal state and return the final row.
 * `maxAttempts: 4` ensures any retry attempt would obviously bump the
 * counter past 1 — making attempts=1 a strong signal that the
 * unrecoverable short-circuit fired.
 */
async function runJobAndWait(args: {
  kind: JobKind;
  orgId: string | null;
  payload: Record<string, unknown>;
  tag: string;
}): Promise<JobRow> {
  const job = await enqueueJob({
    kind: args.kind,
    orgId: args.orgId,
    payload: { ...args.payload, unrecoverableTest: args.tag },
    maxAttempts: 4,
  });
  return await waitForTerminal(job.id, 5_000);
}

function assertImmediatePermanentFailure(
  row: JobRow,
  errorPattern: RegExp,
): void {
  assert.equal(row.status, "failed", "must end in failed status");
  assert.equal(
    row.attempts,
    1,
    `must consume exactly one attempt (was ${row.attempts}); ` +
      `more attempts means the retry budget was burned on a permanent error`,
  );
  assert.equal(
    row.scheduledFor,
    null,
    "scheduled_for must be cleared (no retry queued)",
  );
  assert.match(
    row.error ?? "",
    errorPattern,
    "error message preserved through UnrecoverableJobError",
  );
}

test("known-permanent job inputs fail immediately without burning retry budget", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  installProductionHandlers();
  const orgId = await pickOrgId();

  t.after(async () => {
    try {
      await deleteTestJobs();
    } catch (err) {
      console.error("[cleanup] jobs-unrecoverable-input cleanup failed:", err);
    }
    await pool.end().catch(() => {});
  });

  await deleteTestJobs();

  await t.test("ingest_csv with no orgId fails on attempt #1", async () => {
    const row = await runJobAndWait({
      kind: "ingest_csv",
      orgId: null,
      payload: { csv: { suppliers: [] } },
      tag: `csv-no-org-${Date.now()}-${process.pid}`,
    });
    assertImmediatePermanentFailure(row, /orgId/i);
  });

  await t.test(
    "ingest_csv with payload.csv that is not an object fails on attempt #1",
    async () => {
      // We need an orgId for the malformed-payload check to be the
      // failure that surfaces (otherwise the orgId guard fires first
      // and we'd be testing the same thing as the previous case).
      // Using a real seeded org keeps the FK constraint happy; the
      // handler trips on the payload shape long before any DB write.
      const row = await runJobAndWait({
        kind: "ingest_csv",
        orgId,
        payload: { csv: "not-an-object" },
        tag: `csv-bad-shape-${Date.now()}-${process.pid}`,
      });
      assertImmediatePermanentFailure(row, /payload\.csv must be an object/i);
    },
  );

  await t.test(
    "ingest_mock_erp with non-array payload.erp.feed fails on attempt #1",
    async () => {
      const row = await runJobAndWait({
        kind: "ingest_mock_erp",
        orgId,
        payload: { erp: { feed: "not-an-array" } },
        tag: `erp-bad-feed-${Date.now()}-${process.pid}`,
      });
      assertImmediatePermanentFailure(row, /feed must be an array/i);
    },
  );

  await t.test(
    "run_analysis_cycle with no orgId fails on attempt #1",
    async () => {
      const row = await runJobAndWait({
        kind: "run_analysis_cycle",
        orgId: null,
        payload: {},
        tag: `cycle-no-org-${Date.now()}-${process.pid}`,
      });
      assertImmediatePermanentFailure(row, /orgId/i);
    },
  );

  await t.test(
    "run_collector with an empty collectorId fails on attempt #1",
    async () => {
      const row = await runJobAndWait({
        kind: "run_collector",
        orgId: null,
        payload: { collectorId: "" },
        tag: `collector-empty-${Date.now()}-${process.pid}`,
      });
      assertImmediatePermanentFailure(row, /collectorId/i);
    },
  );
});
