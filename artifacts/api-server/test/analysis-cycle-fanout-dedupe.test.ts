/**
 * Integration test for the per-tenant analysis-cycle dedupe primitive.
 *
 * `ensureOrgAnalysisCycleScheduled` is the helper the periodic
 * `analysis_cycle_fanout` handler uses to enqueue one
 * `run_analysis_cycle` per tenant per tick — and the same race-safe
 * primitive an operator's "Run now" button can reuse to avoid piling
 * up duplicate cycles when the scheduler is also firing.
 *
 * The invariants pinned here:
 *
 *   - A first call for a tenant with no in-flight cycle inserts a new
 *     `run_analysis_cycle` row (`enqueued: true`).
 *   - A second call while that row is still pending/running returns
 *     `{ enqueued: false, reason: "in_flight" }` and inserts no second
 *     row — the operator-facing "Run now" override and the periodic
 *     fan-out cannot stack duplicates.
 *   - Under N concurrent callers (simulating a fan-out tick that races
 *     with an operator click, or two fan-out attempts overlapping),
 *     exactly one caller wins and inserts; the rest each see
 *     `in_flight`. This is the property that the race-prone
 *     SELECT-then-enqueue pattern violated; folding the check into the
 *     same per-org advisory-lock'd transaction as the INSERT closes the
 *     window.
 *
 * Prereqs:
 *   - `DATABASE_URL` is set and the schema has been pushed
 *     (`pnpm --filter @workspace/db run push`).
 *   - At least one org row exists in the `orgs` table (the dev seed
 *     script populates this).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { db, jobsTable, orgsTable, pool } from "@workspace/db";
import { and, eq } from "drizzle-orm";

import { ensureOrgAnalysisCycleScheduled } from "../src/lib/jobs/queue";

async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) {
    throw new Error(
      "No org seeded; cannot run analysis-cycle fan-out dedupe test",
    );
  }
  return row.id;
}

async function clearTenantCycleJobs(orgId: string): Promise<void> {
  await db
    .delete(jobsTable)
    .where(
      and(
        eq(jobsTable.kind, "run_analysis_cycle" as const),
        eq(jobsTable.orgId, orgId),
      ),
    );
}

test("ensureOrgAnalysisCycleScheduled enqueues when no cycle is in flight", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const orgId = await pickOrgId();
  await clearTenantCycleJobs(orgId);
  t.after(async () => {
    await clearTenantCycleJobs(orgId);
  });

  const result = await ensureOrgAnalysisCycleScheduled(orgId);
  assert.equal(result.enqueued, true, "first call should enqueue");
  if (!result.enqueued) return; // narrow for TS
  assert.equal(result.job.kind, "run_analysis_cycle");
  assert.equal(result.job.orgId, orgId);
  assert.equal(result.job.status, "pending");

  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.kind, "run_analysis_cycle" as const),
        eq(jobsTable.orgId, orgId),
      ),
    );
  assert.equal(rows.length, 1, "exactly one cycle row should exist");
});

test("ensureOrgAnalysisCycleScheduled is a no-op while a cycle is pending", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const orgId = await pickOrgId();
  await clearTenantCycleJobs(orgId);
  t.after(async () => {
    await clearTenantCycleJobs(orgId);
  });

  const first = await ensureOrgAnalysisCycleScheduled(orgId);
  assert.equal(first.enqueued, true);

  const second = await ensureOrgAnalysisCycleScheduled(orgId);
  assert.equal(second.enqueued, false, "second call must be a no-op");
  if (second.enqueued) return; // narrow for TS
  assert.equal(second.reason, "in_flight");
  if (second.reason !== "in_flight") return; // narrow for TS
  assert.equal(
    second.existingJobId,
    first.enqueued ? first.job.id : "",
    "in_flight outcome should expose the existing job's id so the manual route can return it for polling",
  );

  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.kind, "run_analysis_cycle" as const),
        eq(jobsTable.orgId, orgId),
      ),
    );
  assert.equal(rows.length, 1, "no second cycle row should be inserted");
});

test("ensureOrgAnalysisCycleScheduled dedupes across mixed scheduler+manual payloads", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const orgId = await pickOrgId();
  await clearTenantCycleJobs(orgId);
  t.after(async () => {
    await clearTenantCycleJobs(orgId);
  });

  // Mix scheduler-shaped and manual-shaped payloads in the same race
  // (this is what happens when the periodic fan-out tick coincides
  // with an operator clicking "Run now" — the manual `/cycles/run?async=true`
  // route now also calls this helper, so the dedupe contract must hold
  // across heterogeneous payloads, not just identical ones).
  const N = 8;
  const calls = Array.from({ length: N }, (_, i) =>
    i % 2 === 0
      ? ensureOrgAnalysisCycleScheduled(orgId) // scheduler payload
      : ensureOrgAnalysisCycleScheduled(orgId, {
          payload: { triggeredBy: `op-${i}@example.com`, source: "manual" },
        }),
  );
  const results = await Promise.all(calls);

  const enqueued = results.filter((r) => r.enqueued).length;
  assert.equal(
    enqueued,
    1,
    "exactly one of the mixed scheduler+manual callers should win",
  );

  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.kind, "run_analysis_cycle" as const),
        eq(jobsTable.orgId, orgId),
      ),
    );
  assert.equal(
    rows.length,
    1,
    "manual + scheduler concurrent enqueue must not produce duplicates",
  );

  // Every losing caller must point at the same existing job id —
  // otherwise the manual route would return a stale job id to the UI.
  const winningId = rows[0]?.id;
  assert.ok(winningId, "winning row id should be defined");
  for (const r of results) {
    if (!r.enqueued && r.reason === "in_flight") {
      assert.equal(
        r.existingJobId,
        winningId,
        "every in_flight outcome should reference the one winning row",
      );
    }
  }
});

test("ensureOrgAnalysisCycleScheduled is race-free under concurrent callers", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const orgId = await pickOrgId();
  await clearTenantCycleJobs(orgId);
  t.after(async () => {
    await clearTenantCycleJobs(orgId);
  });

  // Fire many enqueue attempts in parallel. Without the shared
  // per-org advisory lock around the SELECT-and-INSERT, each caller
  // would observe "no active cycle", each pass the in-flight check,
  // and each INSERT — leaving multiple pending rows. With the lock,
  // exactly one call wins and the rest see `in_flight`.
  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, () => ensureOrgAnalysisCycleScheduled(orgId)),
  );

  const enqueued = results.filter((r) => r.enqueued).length;
  const inFlight = results.filter(
    (r) => !r.enqueued && r.reason === "in_flight",
  ).length;

  assert.equal(
    enqueued,
    1,
    "exactly one concurrent caller should win the race and enqueue",
  );
  assert.equal(
    inFlight,
    N - 1,
    "every losing caller should observe `in_flight`, never `quota_exceeded`",
  );

  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.kind, "run_analysis_cycle" as const),
        eq(jobsTable.orgId, orgId),
      ),
    );
  assert.equal(
    rows.length,
    1,
    "no duplicate run_analysis_cycle rows should be created under concurrency",
  );
});

test.after(async () => {
  await pool.end();
});
