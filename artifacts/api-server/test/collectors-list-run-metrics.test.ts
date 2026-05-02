/**
 * Integration test for the new last-run metrics that the Registry tab
 * surfaces (task #52). The `/collectors` list endpoint now reads each
 * collector's most-recent successful runs out of `collector_audit_log`
 * and returns:
 *
 *   - `lastRunAt`             — `createdAt` of the latest `fetch_succeeded`
 *   - `lastInsertedCount`     — `metadata.inserted` of the latest success
 *   - `lastDuplicateCount`    — `metadata.duplicates` of the latest success
 *   - `staleEmptyRuns`        — true when the last 3 successes all
 *                               inserted zero rows (stalled feed)
 *
 * This test seeds three audit rows for a throw-away collector and
 * asserts that all four fields land on the response. It also exercises
 * the "1 success only" path (staleEmptyRuns must stay false until we
 * have a full window of data) and the "mixed window" path (any run
 * with inserted > 0 in the window clears the chip).
 *
 * Prereqs (same as the other api-server integration tests):
 *   - `DATABASE_URL` set and the schema pushed (`pnpm --filter
 *     @workspace/db run push`).
 *   - `ALLOW_DEV_TENANT_HEADER=true` so the test can assert tenancy
 *     via the `x-org-id` header.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Opt into the dev-only `x-org-id` header path BEFORE importing the
// app. The tenant middleware reads this env var at request time, but
// being explicit before app construction matches the convention in
// csv-stream-large.test.ts and keeps the order obvious.
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { db, pool, collectorAuditLogTable, orgsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import app from "../src/app";
import {
  registerCollector,
  upsertCollectorRegistration,
} from "../src/lib/intelligence/runtime";
import type { IntelligenceCollector } from "../src/lib/intelligence/collector";
import {
  defaultStableSignalKey,
  looseSignalDraftSchema,
} from "../src/lib/intelligence/contractHelpers";

const TEST_COLLECTOR_ID = `test-listmetrics-${Date.now()}-${process.pid}`;

function makeCollector(): IntelligenceCollector {
  return {
    id: TEST_COLLECTOR_ID,
    name: "Test List-Metrics Collector",
    description: "Throw-away collector for /collectors list-metrics test.",
    posture: "public-api",
    sourceUrl: "https://example.test/list-metrics",
    defaultRateLimitRpm: 60,
    defaultScheduleCron: null,
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "US",
    retentionDays: 365,
    tenantOptInDefault: true,
    signalSchema: looseSignalDraftSchema,
    stableSignalKey(d) {
      return defaultStableSignalKey(TEST_COLLECTOR_ID, d);
    },
    async collect() {
      return [];
    },
  };
}

async function startServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) {
    throw new Error(
      "No org rows found. Seed the database before running this test.",
    );
  }
  return row.id;
}

async function deleteTestData(): Promise<void> {
  await db
    .delete(collectorAuditLogTable)
    .where(eq(collectorAuditLogTable.collectorId, TEST_COLLECTOR_ID));
}

/** Insert one synthetic `fetch_succeeded` audit row, dated `secondsAgo`
 *  ago so we can build a deterministic ordered run history. */
async function insertSuccess(
  inserted: number,
  duplicates: number,
  secondsAgo: number,
): Promise<void> {
  const createdAt = new Date(Date.now() - secondsAgo * 1000);
  await db.insert(collectorAuditLogTable).values({
    id: `aud_test_${Math.random().toString(36).slice(2, 12)}`,
    collectorId: TEST_COLLECTOR_ID,
    event: "fetch_succeeded",
    metadata: { inserted, duplicates, drafts: inserted + duplicates },
    createdAt,
  });
}

async function fetchCollectors(
  baseUrl: string,
  orgId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${baseUrl}/api/collectors`, {
    headers: { "x-org-id": orgId },
  });
  assert.equal(res.status, 200, `unexpected status ${res.status}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}

test("/collectors surfaces last-run inserted/duplicate counts and a stale-feed flag", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  registerCollector(makeCollector());
  await upsertCollectorRegistration({
    id: TEST_COLLECTOR_ID,
    name: "Test List-Metrics Collector",
    description: "Throw-away collector for /collectors list-metrics test.",
    posture: "public-api",
    owner: "tests",
    sourceUrl: "https://example.test/list-metrics",
    rateLimitRpm: 60,
    scheduleCron: null,
    notes: null,
    actor: "tests",
  });

  const { baseUrl, close } = await startServer();
  const orgId = await pickOrgId();

  t.after(async () => {
    await deleteTestData();
    await close();
    // Do NOT end the pool here — sibling tests in this file share the
    // same connection pool and would fail with "Cannot use a pool after
    // calling end on the pool". The runner shuts down the pool on
    // process exit.
  });

  // --- Case 1: only one success, latest landed 7 new rows ---------------
  await deleteTestData();
  await insertSuccess(7, 3, 60);
  {
    const all = await fetchCollectors(baseUrl, orgId);
    const c = all.find((x) => x["id"] === TEST_COLLECTOR_ID);
    assert.ok(c, "test collector missing from /collectors response");
    assert.equal(c["lastInsertedCount"], 7);
    assert.equal(c["lastDuplicateCount"], 3);
    // Legacy alias must mirror the new field so older clients keep working.
    assert.equal(c["lastSignalCount"], 7);
    assert.ok(c["lastRunAt"], "lastRunAt should be populated");
    // Single success is NOT enough to fire the chip — the runtime needs
    // a full STALE_RUN_WINDOW (3) of zero-insert successes before the
    // upstream is truly stalled.
    assert.equal(c["staleEmptyRuns"], false);
  }

  // --- Case 2: three consecutive successes, all zero new ----------------
  await deleteTestData();
  // 30s ago → 60s ago → 120s ago. Latest (30s) is `inserted=0`.
  await insertSuccess(0, 12, 30);
  await insertSuccess(0, 11, 60);
  await insertSuccess(0, 10, 120);
  {
    const all = await fetchCollectors(baseUrl, orgId);
    const c = all.find((x) => x["id"] === TEST_COLLECTOR_ID);
    assert.ok(c);
    assert.equal(c["lastInsertedCount"], 0);
    assert.equal(c["lastDuplicateCount"], 12);
    // Three zero-insert successes in a row → the upstream is almost
    // certainly stalled, so the chip MUST fire.
    assert.equal(c["staleEmptyRuns"], true);
  }

  // --- Case 3: window of 3 with one non-empty run clears the chip -------
  await deleteTestData();
  // Latest is empty, but the run before it landed rows → the upstream
  // is healthy; we must NOT show "no new data" just because the most
  // recent run happened to be a duplicate.
  await insertSuccess(0, 5, 30);
  await insertSuccess(4, 1, 60);
  await insertSuccess(0, 5, 120);
  {
    const all = await fetchCollectors(baseUrl, orgId);
    const c = all.find((x) => x["id"] === TEST_COLLECTOR_ID);
    assert.ok(c);
    assert.equal(c["lastInsertedCount"], 0);
    assert.equal(c["lastDuplicateCount"], 5);
    assert.equal(c["staleEmptyRuns"], false);
  }

  // --- Case 4: only successes count — failed runs in between are
  //              ignored when computing the stale window. ---------------
  await deleteTestData();
  await insertSuccess(0, 3, 30);
  await insertSuccess(0, 3, 60);
  await insertSuccess(0, 3, 90);
  // A `fetch_failed` row lying around should not enter the window.
  await db.insert(collectorAuditLogTable).values({
    id: `aud_test_fail_${Math.random().toString(36).slice(2, 12)}`,
    collectorId: TEST_COLLECTOR_ID,
    event: "fetch_failed",
    metadata: {},
    error: "synthetic",
    createdAt: new Date(Date.now() - 45 * 1000),
  });
  {
    const all = await fetchCollectors(baseUrl, orgId);
    const c = all.find((x) => x["id"] === TEST_COLLECTOR_ID);
    assert.ok(c);
    // The three successes still form a stalled window.
    assert.equal(c["staleEmptyRuns"], true);
  }
});

test("/collectors leaves last-run fields null when a collector has never succeeded", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Register a fresh collector with no audit history.
  const id = `test-noaudit-${Date.now()}-${process.pid}`;
  registerCollector({
    ...makeCollector(),
    id,
    name: "Test No-Audit Collector",
    stableSignalKey(d) {
      return defaultStableSignalKey(id, d);
    },
  } as IntelligenceCollector);
  await upsertCollectorRegistration({
    id,
    name: "Test No-Audit Collector",
    description: "Collector with zero audit history for null-field check.",
    posture: "public-api",
    owner: "tests",
    sourceUrl: "https://example.test/no-audit",
    rateLimitRpm: 60,
    scheduleCron: null,
    notes: null,
    actor: "tests",
  });

  const { baseUrl, close } = await startServer();
  const orgId = await pickOrgId();

  t.after(async () => {
    await db
      .delete(collectorAuditLogTable)
      .where(eq(collectorAuditLogTable.collectorId, id));
    await close();
    // Last test in the file ends the pool so the process can exit.
    await pool.end();
  });

  const all = await fetchCollectors(baseUrl, orgId);
  const c = all.find((x) => x["id"] === id);
  assert.ok(c, "fresh collector missing from /collectors");
  // Null-on-no-history is the contract: the UI uses `lastRunAt` as the
  // anchor for showing the new/duplicate split, so leaving the counts
  // null lets the UI hide the line entirely instead of rendering a
  // misleading "0 new / 0 duplicates".
  assert.equal(c["lastRunAt"], null);
  assert.equal(c["lastInsertedCount"], null);
  assert.equal(c["lastDuplicateCount"], null);
  assert.equal(c["lastSignalCount"], null);
  assert.equal(c["staleEmptyRuns"], false);
  // Sanity-check unrelated fields we did NOT change.
  assert.equal(typeof c["postureClass"], "string");
});
