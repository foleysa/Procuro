/**
 * Unit test for the per-connection recurring ERP-sync scheduler
 * (`enqueueDueErpSyncs` in `lib/jobs/queue.ts`, wired into the boot
 * path via `startErpSyncScheduler`).
 *
 * Verifies the four behaviours the route, schema, and UI all rely on:
 *
 *   1. A connection whose `next_scheduled_sync_at` is in the past gets
 *      a single `sync_erp_connection` job enqueued, and its watermark
 *      is bumped to roughly `now() + sync_interval_minutes`.
 *   2. Paused connections are never auto-enqueued, regardless of how
 *      far overdue their watermark is.
 *   3. Connections whose watermark is in the future are skipped.
 *   4. Rerunning the scheduler immediately after a successful enqueue
 *      is a no-op — the in-flight pending job dedupes the next pass.
 *
 * This test owns its own org row + connection rows so it can run
 * alongside the existing integration tests without crosstalk; cleanup
 * runs in `after()` and never touches any other tenant's data.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ERP_CREDENTIAL_ENCRYPTION_KEY"] =
  process.env["ERP_CREDENTIAL_ENCRYPTION_KEY"] ?? "test-key-do-not-use-in-prod";

import { db, erpConnectionsTable, jobsTable, orgsTable } from "@workspace/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { newId } from "../src/lib/ids";
import { encryptCredentials } from "../src/lib/erp/crypto";
import { enqueueDueErpSyncs } from "../src/lib/jobs/queue";

const LABEL_PREFIX = `erp-sched-${process.pid}-${Date.now()}`;

let orgId = "";
const createdConnectionIds: string[] = [];

async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) throw new Error("Seed an org before running this test");
  return row.id;
}

async function makeConnection(args: {
  label: string;
  status: "active" | "paused" | "error";
  syncIntervalMinutes: number;
  nextScheduledSyncAt: Date | null;
}): Promise<string> {
  const id = newId("erpc");
  await db.insert(erpConnectionsTable).values({
    id,
    orgId,
    label: args.label,
    adapterKey: "coupa",
    status: args.status,
    credentialsCipher: encryptCredentials({ clientId: "x", clientSecret: "y" }),
    settings: { instanceUrl: "https://example.coupahost.com" },
    watermarks: {},
    syncIntervalMinutes: args.syncIntervalMinutes,
    nextScheduledSyncAt: args.nextScheduledSyncAt,
  });
  createdConnectionIds.push(id);
  return id;
}

before(async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  orgId = await pickOrgId();
});

after(async () => {
  if (createdConnectionIds.length > 0) {
    await db
      .delete(jobsTable)
      .where(
        and(
          eq(jobsTable.kind, "sync_erp_connection"),
          eq(jobsTable.orgId, orgId),
          sql`payload->>'connectionId' IN (${sql.join(
            createdConnectionIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      );
    await db
      .delete(erpConnectionsTable)
      .where(inArray(erpConnectionsTable.id, createdConnectionIds));
  }
  await db
    .delete(erpConnectionsTable)
    .where(like(erpConnectionsTable.label, `${LABEL_PREFIX}%`));
});

async function pendingSyncJobsForConnection(
  connectionId: string,
): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM jobs
    WHERE kind = 'sync_erp_connection'
      AND status IN ('pending', 'running')
      AND payload->>'connectionId' = ${connectionId}
  `);
  return (res.rows?.[0] as { n?: number } | undefined)?.n ?? 0;
}

describe("ERP sync scheduler — enqueueDueErpSyncs", () => {
  it("enqueues exactly one job per due active connection and bumps the watermark", async () => {
    const minutes = 60;
    const dueId = await makeConnection({
      label: `${LABEL_PREFIX}-due`,
      status: "active",
      syncIntervalMinutes: minutes,
      // 1 minute ago — past due, should fire on this tick.
      nextScheduledSyncAt: new Date(Date.now() - 60_000),
    });

    const before = await pendingSyncJobsForConnection(dueId);
    const result = await enqueueDueErpSyncs();
    const after = await pendingSyncJobsForConnection(dueId);

    assert.ok(
      result.scanned >= 1,
      `expected scheduler to scan at least our due row, got scanned=${result.scanned}`,
    );
    assert.equal(
      after - before,
      1,
      "exactly one new sync_erp_connection job should be enqueued for the due connection",
    );

    const [bumped] = await db
      .select({
        nextScheduledSyncAt: erpConnectionsTable.nextScheduledSyncAt,
      })
      .from(erpConnectionsTable)
      .where(eq(erpConnectionsTable.id, dueId));
    assert.ok(bumped?.nextScheduledSyncAt, "watermark should be bumped");
    const ms = bumped!.nextScheduledSyncAt!.getTime();
    const expectedLow = Date.now() + (minutes - 1) * 60_000;
    const expectedHigh = Date.now() + (minutes + 1) * 60_000;
    assert.ok(
      ms >= expectedLow && ms <= expectedHigh,
      `next_scheduled_sync_at should land roughly ${minutes} min ahead, got ${bumped!.nextScheduledSyncAt!.toISOString()}`,
    );
  });

  it("re-running the scheduler does not double-enqueue a connection that already has a pending sync", async () => {
    // The previous test left a pending sync_erp_connection for the
    // first connection. Re-tick and assert nothing else was added for
    // it. Note: a concurrent worker might pick the row up between
    // ticks — that's fine, dedupe is "pending OR running".
    const target = createdConnectionIds[0]!;

    const before = await pendingSyncJobsForConnection(target);
    // Force the watermark back into the past so the scheduler considers
    // this connection "due" again — without this the dedupe would never
    // be exercised, the row would just be skipped at the SELECT stage.
    await db
      .update(erpConnectionsTable)
      .set({ nextScheduledSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(erpConnectionsTable.id, target));

    await enqueueDueErpSyncs();
    const after = await pendingSyncJobsForConnection(target);

    assert.equal(
      after,
      before,
      "scheduler must not enqueue a second sync while one is already pending/running",
    );
  });

  it("skips paused connections regardless of an overdue watermark", async () => {
    const pausedId = await makeConnection({
      label: `${LABEL_PREFIX}-paused`,
      status: "paused",
      syncIntervalMinutes: 30,
      // Far in the past — would absolutely fire if status weren't paused.
      nextScheduledSyncAt: new Date(Date.now() - 24 * 60 * 60_000),
    });

    await enqueueDueErpSyncs();

    const count = await pendingSyncJobsForConnection(pausedId);
    assert.equal(count, 0, "paused connections must never be auto-enqueued");
  });

  it("skips connections whose next_scheduled_sync_at is in the future", async () => {
    const futureId = await makeConnection({
      label: `${LABEL_PREFIX}-future`,
      status: "active",
      syncIntervalMinutes: 60,
      // 1 hour ahead.
      nextScheduledSyncAt: new Date(Date.now() + 60 * 60_000),
    });

    await enqueueDueErpSyncs();

    const count = await pendingSyncJobsForConnection(futureId);
    assert.equal(
      count,
      0,
      "connections not yet due should not be enqueued by the scheduler",
    );
  });
});
