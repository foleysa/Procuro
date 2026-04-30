/**
 * Regression tests for cooperative cancellation inside the four
 * long-running job handlers. The HTTP / queue plumbing is covered by
 * `jobs-cancel.test.ts`; this file pins the *handler-side* contract:
 *
 *   1. `csvSourceAdapter.fullSync` honours `isCancelled` between entity
 *      sections — a multi-section payload that flips the cancel flag
 *      after the first section bails out with `Cancelled by operator`
 *      and never reaches the second section.
 *   2. `mockErpSourceAdapter.fullSync` honours `isCancelled` between
 *      pages — a multi-page feed that flips after the first page bails
 *      out before processing page two.
 *   3. `runAnalysisCycle` honours `isCancelled` between OODA phases —
 *      flipping the flag immediately surfaces the cancel error and
 *      transitions the cycle row to `failed`.
 *   4. `runCollector` honours `isCancelled` before the HTTP fetch — a
 *      flag set before invocation prevents the collector from running
 *      and throws `Cancelled by operator`.
 *
 * Together these four cases prove that an operator pressing Cancel on
 * the System / Jobs page short-circuits *every* long-running handler
 * within seconds, not just CSV-via-stream.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";

import {
  db,
  orgsTable,
  collectorsTable,
  analysisCyclesTable,
  pool,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { csvSourceAdapter } from "../src/lib/adapters/csv-adapter";
import { mockErpSourceAdapter } from "../src/lib/adapters/mock-erp-adapter";
import { runAnalysisCycle } from "../src/lib/ooda/cycle";
import {
  registerCollector,
  runCollector,
  upsertCollectorRegistration,
  approveCollector,
} from "../src/lib/intelligence/runtime";
import {
  CANCELLED_ERROR_MESSAGE,
} from "../src/lib/jobs/queue";
import type { IntelligenceCollector } from "../src/lib/intelligence/collector";
import { newId } from "../src/lib/ids";

async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) throw new Error("No org seeded; cannot run cancel-checkpoint test");
  return row.id;
}

/**
 * Cancel callback that returns false the first N times then true forever.
 * Lets us assert "the worker bailed out *after* the first batch, not
 * *before* the first batch", which proves we placed the checkpoint at a
 * batch boundary rather than at the very top.
 */
function flipAfter(n: number): () => Promise<boolean> {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls > n;
  };
}

test("csvSourceAdapter.fullSync stops at the next section boundary", async () => {
  const orgId = await pickOrgId();
  // Two-section payload: a category section followed by a supplier
  // section. Cancel after the first checkpoint so the supplier section
  // is skipped entirely.
  const supplierExternalId = `cancel-test-${newId("sup")}`;
  const isCancelled = flipAfter(1);
  await assert.rejects(
    csvSourceAdapter.fullSync({
      orgId,
      isCancelled,
      config: {
        categories: [
          {
            externalId: `cat-${newId("cat")}`,
            code: `CC-${Math.random().toString(36).slice(2, 8)}`,
            name: "Cancel Test Category",
            class: "indirect",
          },
        ],
        suppliers: [
          {
            externalId: supplierExternalId,
            name: "Should Not Be Inserted Inc",
          },
        ],
      },
    }),
    (err: Error) => err.message === CANCELLED_ERROR_MESSAGE,
  );
  // Verify the second section never ran by checking the supplier row
  // wasn't created.
  const [hit] = await db.execute<{ count: string }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await import("drizzle-orm")).sql`
      SELECT COUNT(*)::text AS count FROM suppliers
      WHERE org_id = ${orgId} AND source_external_id = ${supplierExternalId}
    `,
  ).then((r) => r.rows as Array<{ count: string }>);
  assert.equal(hit?.count, "0", "supplier from cancelled section should not exist");
});

test("mockErpSourceAdapter.fullSync stops at the next page boundary", async () => {
  const orgId = await pickOrgId();
  // Two pages of one record each. Cancel after the first page so the
  // second page's record is never applied.
  const supplierExternalId = `mock-cancel-${newId("sup")}`;
  const isCancelled = flipAfter(1);
  await assert.rejects(
    mockErpSourceAdapter.fullSync({
      orgId,
      isCancelled,
      config: {
        pageSize: 1,
        feed: [
          {
            type: "supplier",
            externalId: `mock-cancel-first-${newId("sup")}`,
            updatedAt: new Date().toISOString(),
            payload: { name: "First Page Supplier" },
          },
          {
            type: "supplier",
            externalId: supplierExternalId,
            updatedAt: new Date().toISOString(),
            payload: { name: "Second Page Supplier" },
          },
        ],
      },
    }),
    (err: Error) => err.message === CANCELLED_ERROR_MESSAGE,
  );
  const [hit] = await db.execute<{ count: string }>(
    (await import("drizzle-orm")).sql`
      SELECT COUNT(*)::text AS count FROM suppliers
      WHERE org_id = ${orgId} AND source_external_id = ${supplierExternalId}
    `,
  ).then((r) => r.rows as Array<{ count: string }>);
  assert.equal(hit?.count, "0", "second-page supplier should not exist");
});

test("runAnalysisCycle stops at the next OODA phase boundary", async () => {
  const orgId = await pickOrgId();
  // Cancel on the very first checkpoint — the cycle should bail before
  // running Observe and the cycle row should be marked failed.
  const isCancelled = async (): Promise<boolean> => true;
  await assert.rejects(
    runAnalysisCycle({
      orgId,
      triggeredBy: "test:cancel-checkpoint",
      isCancelled,
    }),
    (err: Error) => err.message === CANCELLED_ERROR_MESSAGE,
  );
  // Find the cycle row we just created (most recent for this org) and
  // verify it transitioned to failed with the cancel error in
  // learnPayload.
  const { desc } = await import("drizzle-orm");
  const [row] = await db
    .select()
    .from(analysisCyclesTable)
    .where(eq(analysisCyclesTable.orgId, orgId))
    .orderBy(desc(analysisCyclesTable.startedAt))
    .limit(1);
  assert.ok(row, "expected a cycle row to be created before the cancel");
  assert.equal(row!.status, "failed");
  assert.equal(
    (row!.learnPayload as { error?: string } | null)?.error,
    CANCELLED_ERROR_MESSAGE,
  );
});

test("runCollector stops before invoking the collector when cancelled", async () => {
  // Register a fake collector that fails the test if its `collect()` is
  // ever called. Cancel must trip *before* that point.
  const collectorId = "test_cancel_collector";
  let collectInvoked = false;
  const fake: IntelligenceCollector = {
    id: collectorId,
    name: "Cancel-test fake collector",
    description: "Should never run; cancel-trip happens first.",
    posture: "public-api",
    sourceUrl: "https://example.invalid/cancel-test",
    defaultRateLimitRpm: 60,
    defaultScheduleCron: null,
    async collect() {
      collectInvoked = true;
      return [];
    },
  };
  registerCollector(fake);
  await upsertCollectorRegistration({
    id: collectorId,
    name: fake.name,
    description: fake.description,
    posture: fake.posture,
    owner: "test@procuro.ai",
    sourceUrl: fake.sourceUrl,
    actor: "test@procuro.ai",
  });
  await approveCollector(collectorId, "test@procuro.ai");

  try {
    await assert.rejects(
      runCollector(collectorId, { isCancelled: async () => true }),
      (err: Error) => err.message === CANCELLED_ERROR_MESSAGE,
    );
    assert.equal(
      collectInvoked,
      false,
      "collector.collect() must not be called once cancel is observed",
    );
  } finally {
    await db.delete(collectorsTable).where(eq(collectorsTable.id, collectorId));
  }
});

test.after(async () => {
  await pool.end();
});
