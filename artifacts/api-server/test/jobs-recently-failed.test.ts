/**
 * Integration test for `GET /api/jobs/recently-failed` and the
 * `payload` field on `GET /api/jobs/{id}` (#94).
 *
 * Pins the contract that the failed-jobs notification surface depends
 * on:
 *
 *   - The lookback endpoint returns failed jobs whose `completed_at`
 *     falls inside the requested window, in newest-first order.
 *   - Failures older than the window are excluded — operators should
 *     not be re-notified about ancient failures every time they load
 *     a page.
 *   - Non-`failed` rows (succeeded, pending, running, cancelled) are
 *     excluded even when fresh, so the banner is exclusively about
 *     the "needs your attention" set.
 *   - Tenant isolation: a row tagged with a different `org_id` MUST
 *     NOT appear in another tenant's response.
 *   - System-scoped rows (`org_id IS NULL`) are visible to every
 *     tenant — these are the cleanup / pruner kinds that any admin
 *     might be the one to notice has died.
 *   - The lookback endpoint omits the `payload` field; the detail
 *     endpoint includes a redacted copy. Credential-shaped keys must
 *     never appear verbatim in the detail response.
 *
 * Approach mirrors `jobs-cancel.test.ts`: spin up an ephemeral HTTP
 * server bound to the imported `app`, seed jobs directly via SQL with
 * deterministic ids, and tear down at the end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { db, orgsTable, jobsTable, pool, type JobKind } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import app from "../src/app";

const RUN_TAG = `recfail-${Date.now()}-${process.pid}`;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TEST_KIND = "ingest_csv" satisfies JobKind;

interface SeededJob {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  /** Hours-ago for `completed_at`. Undefined means leave NULL. */
  completedHoursAgo?: number;
  orgId?: string | null;
  payload?: Record<string, unknown>;
  error?: string;
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
    throw new Error("No orgs seeded; cannot run recently-failed test");
  }
  if (rows.length === 1) {
    // We only have one tenant — synthesize a second uuid that is
    // intentionally NOT present in `orgs` so isolation tests still
    // exercise the `org_id` filter.
    return { a: rows[0]!.id, b: "00000000-0000-0000-0000-000000000fff" };
  }
  return { a: rows[0]!.id, b: rows[1]!.id };
}

async function seed(jobs: SeededJob[]): Promise<void> {
  for (const j of jobs) {
    const completedAt =
      j.completedHoursAgo === undefined
        ? null
        : new Date(Date.now() - j.completedHoursAgo * HOUR_MS);
    const payload = j.payload ?? {};
    const error = j.error ?? null;
    const orgId = j.orgId === undefined ? null : j.orgId;
    await db.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status, completed_at, error)
      VALUES (
        ${j.id},
        ${TEST_KIND},
        ${orgId},
        ${JSON.stringify(payload)}::jsonb,
        ${j.status},
        ${completedAt},
        ${error}
      )
    `);
  }
}

async function cleanup(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(jobsTable).where(inArray(jobsTable.id, ids));
}

async function getJson(
  port: number,
  path: string,
  orgId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "x-org-id": orgId },
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

test("listRecentlyFailedJobs returns recent failures, newest first", async () => {
  const { a: orgA } = await pickTwoOrgIds();
  const ids = [
    `${RUN_TAG}-fresh-fail-1h`,
    `${RUN_TAG}-fresh-fail-3h`,
    `${RUN_TAG}-stale-fail-30h`,
  ];
  await seed([
    {
      id: ids[0]!,
      status: "failed",
      completedHoursAgo: 1,
      orgId: orgA,
      error: "transient outage hit retry budget",
      payload: { fileName: "fresh.csv" },
    },
    {
      id: ids[1]!,
      status: "failed",
      completedHoursAgo: 3,
      orgId: orgA,
      error: "row 42: invalid currency code",
      payload: { fileName: "older.csv" },
    },
    // Outside the default 24h window — must not appear.
    {
      id: ids[2]!,
      status: "failed",
      completedHoursAgo: 30,
      orgId: orgA,
      error: "ancient failure",
    },
  ]);

  try {
    await withServer(async (port) => {
      const { status, body } = await getJson(
        port,
        "/api/jobs/recently-failed",
        orgA,
      );
      assert.equal(status, 200);
      assert.equal(body["withinHours"], 24);
      const jobs = body["jobs"] as Array<Record<string, unknown>>;
      const seenIds = jobs.map((j) => j["id"] as string);
      assert.ok(seenIds.includes(ids[0]!), "fresh 1h failure should appear");
      assert.ok(seenIds.includes(ids[1]!), "fresh 3h failure should appear");
      assert.ok(
        !seenIds.includes(ids[2]!),
        "30h failure should be outside the 24h window",
      );
      // Newest-first ordering.
      const idx0 = seenIds.indexOf(ids[0]!);
      const idx1 = seenIds.indexOf(ids[1]!);
      assert.ok(idx0 < idx1, "1h failure must precede 3h failure");
      // List endpoint must NOT carry the payload field — it is reserved
      // for the detail view.
      const fresh = jobs[idx0]!;
      assert.equal(fresh["payload"], undefined);
    });
  } finally {
    await cleanup(ids);
  }
});

test("listRecentlyFailedJobs excludes non-failed statuses", async () => {
  const { a: orgA } = await pickTwoOrgIds();
  const ids = [
    `${RUN_TAG}-succeeded`,
    `${RUN_TAG}-cancelled`,
    `${RUN_TAG}-pending`,
    `${RUN_TAG}-failed-baseline`,
  ];
  await seed([
    { id: ids[0]!, status: "succeeded", completedHoursAgo: 1, orgId: orgA },
    { id: ids[1]!, status: "cancelled", completedHoursAgo: 1, orgId: orgA },
    { id: ids[2]!, status: "pending", orgId: orgA },
    { id: ids[3]!, status: "failed", completedHoursAgo: 1, orgId: orgA },
  ]);

  try {
    await withServer(async (port) => {
      const { body } = await getJson(
        port,
        "/api/jobs/recently-failed",
        orgA,
      );
      const seenIds = (body["jobs"] as Array<Record<string, unknown>>).map(
        (j) => j["id"] as string,
      );
      assert.ok(!seenIds.includes(ids[0]!), "succeeded must be excluded");
      assert.ok(!seenIds.includes(ids[1]!), "cancelled must be excluded");
      assert.ok(!seenIds.includes(ids[2]!), "pending must be excluded");
      assert.ok(seenIds.includes(ids[3]!), "failed must be included");
    });
  } finally {
    await cleanup(ids);
  }
});

test("listRecentlyFailedJobs enforces tenant isolation, surfaces system-scoped", async () => {
  const { a: orgA, b: orgB } = await pickTwoOrgIds();
  const ids = [
    `${RUN_TAG}-orgA-only`,
    `${RUN_TAG}-orgB-only`,
    `${RUN_TAG}-system`,
  ];
  await seed([
    { id: ids[0]!, status: "failed", completedHoursAgo: 1, orgId: orgA },
    { id: ids[1]!, status: "failed", completedHoursAgo: 1, orgId: orgB },
    { id: ids[2]!, status: "failed", completedHoursAgo: 1, orgId: null },
  ]);

  try {
    await withServer(async (port) => {
      const { body } = await getJson(
        port,
        "/api/jobs/recently-failed",
        orgA,
      );
      const seenIds = (body["jobs"] as Array<Record<string, unknown>>).map(
        (j) => j["id"] as string,
      );
      assert.ok(seenIds.includes(ids[0]!), "own-tenant failure visible");
      assert.ok(
        !seenIds.includes(ids[1]!),
        "other-tenant failure must not leak",
      );
      assert.ok(
        seenIds.includes(ids[2]!),
        "system-scoped failure visible to every tenant",
      );
    });
  } finally {
    await cleanup(ids);
  }
});

test("getJob returns a redacted payload on the detail endpoint", async () => {
  const { a: orgA } = await pickTwoOrgIds();
  const id = `${RUN_TAG}-detail-redact`;
  await seed([
    {
      id,
      status: "failed",
      completedHoursAgo: 1,
      orgId: orgA,
      error: "could not authenticate",
      payload: {
        fileName: "supplier-creds.csv",
        apiKey: "sk_live_should_be_hidden",
        nested: { token: "tok_should_be_hidden", endpoint: "https://x" },
      },
    },
  ]);

  try {
    await withServer(async (port) => {
      const { status, body } = await getJson(
        port,
        `/api/jobs/${id}`,
        orgA,
      );
      assert.equal(status, 200);
      const payload = body["payload"] as Record<string, unknown>;
      assert.ok(payload, "detail endpoint must include payload");
      assert.equal(payload["fileName"], "supplier-creds.csv");
      assert.equal(payload["apiKey"], "[REDACTED]");
      const nested = payload["nested"] as Record<string, unknown>;
      assert.equal(nested["token"], "[REDACTED]");
      assert.equal(nested["endpoint"], "https://x");
    });
  } finally {
    await cleanup([id]);
  }
});

test.after(async () => {
  await pool.end();
});
