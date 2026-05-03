/**
 * Integration tests for the dead-letter dashboard surface (#183):
 *
 *   - `GET /api/jobs/dead-letter` — paginated list of every
 *     permanently-failed job for the active tenant.
 *   - `POST /api/jobs/:id/retry` — already wired for failed jobs;
 *     re-asserted here from the dashboard's perspective so changes to
 *     the contract (status code, response shape) break the test.
 *   - `POST /api/jobs/:id/discard` — operator escape hatch that
 *     deletes a dead-letter row so it stops surfacing.
 *
 * Pinned behaviour:
 *   - Dead-letter list returns failed jobs newest-first (by
 *     completed_at).
 *   - Pagination via `limit` / `offset` returns the requested slice
 *     and a stable `total` count.
 *   - Tenant isolation: another tenant's failed rows must NOT appear.
 *   - Non-failed statuses (succeeded / pending / cancelled) are
 *     excluded.
 *   - Retry on a failed row enqueues a fresh `pending` job (HTTP 202)
 *     while leaving the original in `failed` for audit.
 *   - Retry on a non-failed row returns 409.
 *   - Discard removes the row entirely; a follow-up GET returns 404
 *     and the dead-letter list no longer shows it.
 *   - Discard on a non-failed row returns 409.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { db, orgsTable, jobsTable, pool, type JobKind } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../src/app";

const RUN_TAG = `dl-${Date.now()}-${process.pid}`;
const HOUR_MS = 60 * 60 * 1000;
const SEC_MS = 1000;
const TEST_KIND = "ingest_csv" satisfies JobKind;

// Pin seeded rows into the very-recent future-past so they always sit
// at the top of the newest-first dead-letter listing regardless of how
// much pre-existing dev seed data is in the jobs table.
function recentDate(secondsAgo: number): Date {
  return new Date(Date.now() - secondsAgo * SEC_MS);
}

interface SeededJob {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  completedHoursAgo?: number;
  completedAt?: Date;
  orgId?: string | null;
  payload?: Record<string, unknown>;
  error?: string;
  attempts?: number;
  maxAttempts?: number;
}

async function withServer<T>(
  handler: (port: number) => Promise<T>,
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to start ephemeral test server");
  }
  try {
    return await handler(addr.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function pickTwoOrgIds(): Promise<{ a: string; b: string }> {
  const rows = await db.select({ id: orgsTable.id }).from(orgsTable).limit(2);
  if (rows.length < 1) {
    throw new Error("No orgs seeded; cannot run dead-letter test");
  }
  if (rows.length === 1) {
    return { a: rows[0]!.id, b: "00000000-0000-0000-0000-000000000fff" };
  }
  return { a: rows[0]!.id, b: rows[1]!.id };
}

async function seed(jobs: SeededJob[]): Promise<void> {
  for (const j of jobs) {
    const completedAt =
      j.completedAt ??
      (j.completedHoursAgo === undefined
        ? null
        : new Date(Date.now() - j.completedHoursAgo * HOUR_MS));
    await db.execute(sql`
      INSERT INTO jobs (
        id, kind, org_id, payload, status, completed_at, error,
        attempts, max_attempts
      )
      VALUES (
        ${j.id},
        ${TEST_KIND},
        ${j.orgId === undefined ? null : j.orgId},
        ${JSON.stringify(j.payload ?? {})}::jsonb,
        ${j.status},
        ${completedAt},
        ${j.error ?? null},
        ${j.attempts ?? 0},
        ${j.maxAttempts ?? 3}
      )
    `);
  }
}

async function cleanup(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(jobsTable).where(inArray(jobsTable.id, ids));
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function callJson(
  port: number,
  method: string,
  path: string,
  orgId: string,
): Promise<JsonResponse> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "x-org-id": orgId },
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

test("listDeadLetterJobs returns failed jobs newest-first with pagination", async () => {
  const { a: orgA } = await pickTwoOrgIds();
  const ids = [
    `${RUN_TAG}-fresh`,
    `${RUN_TAG}-mid`,
    `${RUN_TAG}-old`,
  ];
  // Use sub-second offsets so all three rows land at the top of the
  // newest-first list regardless of how many dev-seed failures already
  // exist in the table. The relative ordering (0 < 1 < 2) is what we
  // assert on.
  await seed([
    {
      id: ids[0]!,
      status: "failed",
      completedAt: recentDate(0.001),
      orgId: orgA,
      error: "fresh failure",
      attempts: 3,
      maxAttempts: 3,
    },
    {
      id: ids[1]!,
      status: "failed",
      completedAt: recentDate(0.5),
      orgId: orgA,
      error: "mid failure",
      attempts: 1,
      maxAttempts: 1,
    },
    {
      id: ids[2]!,
      status: "failed",
      completedAt: recentDate(1),
      orgId: orgA,
      error: "older but still on top by virtue of recent seed",
      attempts: 3,
      maxAttempts: 3,
    },
  ]);

  try {
    await withServer(async (port) => {
      // Pull a large window so any other failed rows in the dev DB
      // don't perturb the offset arithmetic — we only assert
      // ordering and pagination metadata, never absolute positions.
      const { status, body } = await callJson(
        port,
        "GET",
        "/api/jobs/dead-letter?limit=100&offset=0",
        orgA,
      );
      assert.equal(status, 200);
      assert.equal(body["limit"], 100);
      assert.equal(body["offset"], 0);
      assert.ok(
        (body["total"] as number) >= 3,
        "total should include all seeded failures",
      );
      const all = (body["jobs"] as Array<{ id: string }>).map((j) => j.id);
      const seenIdx = ids.map((id) => all.indexOf(id));
      for (const [i, idx] of seenIdx.entries()) {
        assert.notEqual(idx, -1, `seeded id #${i} (${ids[i]}) must be listed`);
      }
      // Newest-first: ids[0] (1h) → ids[1] (5h) → ids[2] (240h).
      assert.ok(
        seenIdx[0]! < seenIdx[1]! && seenIdx[1]! < seenIdx[2]!,
        `newest-first ordering broken: ${seenIdx.join(",")}`,
      );

      // Pagination metadata: a small page reflects the requested
      // limit/offset and never returns more than `limit` items.
      const { body: page1 } = await callJson(
        port,
        "GET",
        "/api/jobs/dead-letter?limit=2&offset=0",
        orgA,
      );
      assert.equal(page1["limit"], 2);
      assert.equal(page1["offset"], 0);
      assert.ok(
        (page1["jobs"] as unknown[]).length <= 2,
        "page must respect limit",
      );
      assert.equal(
        page1["total"],
        body["total"],
        "total stable across pages",
      );
    });
  } finally {
    await cleanup(ids);
  }
});

test("listDeadLetterJobs excludes non-failed statuses and other tenants", async () => {
  const { a: orgA, b: orgB } = await pickTwoOrgIds();
  const ids = [
    `${RUN_TAG}-failed-own`,
    `${RUN_TAG}-failed-other-tenant`,
    `${RUN_TAG}-succeeded-own`,
    `${RUN_TAG}-pending-own`,
    `${RUN_TAG}-cancelled-own`,
  ];
  await seed([
    {
      id: ids[0]!,
      status: "failed",
      completedHoursAgo: 1,
      orgId: orgA,
      error: "own-tenant failure",
    },
    {
      id: ids[1]!,
      status: "failed",
      completedHoursAgo: 1,
      orgId: orgB,
      error: "other-tenant failure must not leak",
    },
    { id: ids[2]!, status: "succeeded", completedHoursAgo: 1, orgId: orgA },
    { id: ids[3]!, status: "pending", orgId: orgA },
    { id: ids[4]!, status: "cancelled", completedHoursAgo: 1, orgId: orgA },
  ]);

  try {
    await withServer(async (port) => {
      const { body } = await callJson(
        port,
        "GET",
        "/api/jobs/dead-letter?limit=100&offset=0",
        orgA,
      );
      const seen = (body["jobs"] as Array<{ id: string }>).map((j) => j.id);
      assert.ok(seen.includes(ids[0]!), "own failure must appear");
      assert.ok(!seen.includes(ids[1]!), "other-tenant failure must not leak");
      assert.ok(!seen.includes(ids[2]!), "succeeded excluded");
      assert.ok(!seen.includes(ids[3]!), "pending excluded");
      assert.ok(!seen.includes(ids[4]!), "cancelled excluded");
    });
  } finally {
    await cleanup(ids);
  }
});

test("retryJob enqueues a fresh pending job; original stays failed", async () => {
  const { a: orgA } = await pickTwoOrgIds();
  const id = `${RUN_TAG}-retry-target`;
  await seed([
    {
      id,
      status: "failed",
      completedHoursAgo: 1,
      orgId: orgA,
      error: "broken",
      attempts: 3,
      maxAttempts: 3,
      payload: { csv: { source: "memory" } },
    },
  ]);
  let retryJobId: string | null = null;
  try {
    await withServer(async (port) => {
      const { status, body } = await callJson(
        port,
        "POST",
        `/api/jobs/${id}/retry`,
        orgA,
      );
      assert.equal(status, 202, "retry returns 202 Accepted");
      retryJobId = body["jobId"] as string;
      assert.ok(retryJobId, "response includes new jobId");
      assert.equal(body["status"], "pending");

      // Original row remains in failed for audit; the retry job is a
      // brand-new row with attempts=0 (a fresh enqueue counts as
      // attempt #1 once a worker claims it).
      const [orig] = await db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, id));
      assert.ok(orig);
      assert.equal(orig.status, "failed", "original stays failed");

      const [retried] = await db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, retryJobId!));
      assert.ok(retried);
      assert.equal(retried.attempts, 0, "fresh job has attempts reset");
    });
  } finally {
    await cleanup(retryJobId ? [id, retryJobId] : [id]);
  }
});

test("retryJob refuses non-failed rows with 409", async () => {
  const { a: orgA } = await pickTwoOrgIds();
  const id = `${RUN_TAG}-retry-nonfailed`;
  await seed([{ id, status: "succeeded", completedHoursAgo: 1, orgId: orgA }]);
  try {
    await withServer(async (port) => {
      const { status, body } = await callJson(
        port,
        "POST",
        `/api/jobs/${id}/retry`,
        orgA,
      );
      assert.equal(status, 409);
      assert.match(String(body["error"] ?? ""), /failed/i);
    });
  } finally {
    await cleanup([id]);
  }
});

test("discardJob deletes a failed row and removes it from dead-letter", async () => {
  const { a: orgA } = await pickTwoOrgIds();
  const id = `${RUN_TAG}-discard-target`;
  await seed([
    {
      id,
      status: "failed",
      completedHoursAgo: 1,
      orgId: orgA,
      error: "to be discarded",
    },
  ]);

  try {
    await withServer(async (port) => {
      // Pre-condition: row appears in dead-letter list.
      const { body: before } = await callJson(
        port,
        "GET",
        "/api/jobs/dead-letter?limit=100",
        orgA,
      );
      const ids0 = (before["jobs"] as Array<{ id: string }>).map((j) => j.id);
      assert.ok(ids0.includes(id), "row visible before discard");

      const { status, body } = await callJson(
        port,
        "POST",
        `/api/jobs/${id}/discard`,
        orgA,
      );
      assert.equal(status, 200);
      assert.equal(body["jobId"], id);
      assert.equal(body["discarded"], true);

      // Row is gone from the DB.
      const rows = await db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, id));
      assert.equal(rows.length, 0, "discard removes the job row");

      // Dead-letter list no longer surfaces it.
      const { body: after } = await callJson(
        port,
        "GET",
        "/api/jobs/dead-letter?limit=100",
        orgA,
      );
      const ids1 = (after["jobs"] as Array<{ id: string }>).map((j) => j.id);
      assert.ok(!ids1.includes(id), "row excluded after discard");
    });
  } finally {
    await cleanup([id]);
  }
});

test("discardJob refuses non-failed rows with 409", async () => {
  const { a: orgA } = await pickTwoOrgIds();
  const id = `${RUN_TAG}-discard-nonfailed`;
  await seed([{ id, status: "pending", orgId: orgA }]);
  try {
    await withServer(async (port) => {
      const { status, body } = await callJson(
        port,
        "POST",
        `/api/jobs/${id}/discard`,
        orgA,
      );
      assert.equal(status, 409);
      assert.match(String(body["error"] ?? ""), /failed/i);
      // Confirm the row was NOT deleted.
      const rows = await db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, id));
      assert.equal(rows.length, 1, "non-failed row preserved");
    });
  } finally {
    await cleanup([id]);
  }
});

test("discardJob returns 404 for unknown id", async () => {
  const { a: orgA } = await pickTwoOrgIds();
  await withServer(async (port) => {
    const { status } = await callJson(
      port,
      "POST",
      `/api/jobs/${RUN_TAG}-does-not-exist/discard`,
      orgA,
    );
    assert.equal(status, 404);
  });
});

test.after(async () => {
  await pool.end();
});
