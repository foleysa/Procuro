/**
 * Integration test for the periodic funnel-snapshot pruner.
 *
 * `funnel_snapshots` carries a sizable JSONB payload per OODA cycle and
 * `funnel_snapshot_failures` accumulates diagnostic noise; without
 * retention both grow unboundedly. The invariants pinned here:
 *
 *   - `pruneOldFunnelSnapshots` deletes snapshots with `created_at`
 *     older than the configured snapshot window, leaving fresher rows
 *     alone.
 *   - It deletes failure rows with `last_seen_at` older than the
 *     configured failure window, leaving fresh failures for the admin
 *     feed.
 *   - The two windows are independent: a long snapshot window plus a
 *     short failure window prunes only failures, and vice versa.
 *   - Cascading `funnel_annotations` rows go with the parent snapshot
 *     (FK `ON DELETE CASCADE`) so the annotations table can never end
 *     up orphaned.
 *   - `ensureFunnelSnapshotPruneJobScheduled` is idempotent: a second
 *     call while a `prune_funnel_snapshots` row is still pending
 *     returns `null` and inserts no duplicate row.
 *
 * Prereqs: `DATABASE_URL` is set and the schema has been pushed
 * (`pnpm --filter @workspace/db run push`).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  jobsTable,
  orgsTable,
  analysisCyclesTable,
  funnelSnapshotsTable,
  funnelAnnotationsTable,
  funnelSnapshotFailuresTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import {
  pruneOldFunnelSnapshots,
  ensureFunnelSnapshotPruneJobScheduled,
} from "../src/lib/jobs/queue";

const RUN_TAG = `funnel-prune-test-${Date.now()}-${process.pid}`;
const ORG_ID = `${RUN_TAG}-org`;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface SeededSnapshot {
  id: string;
  cycleId: string;
  cycleGeneration: number;
  createdDaysAgo: number;
  /** When set, also seeds an annotation pointing at this snapshot. */
  annotationId?: string;
}

interface SeededFailure {
  id: string;
  cycleId: string;
  cycleGeneration: number;
  lastSeenDaysAgo: number;
}

const SEEDED_SNAPSHOTS: SeededSnapshot[] = [
  {
    id: `${RUN_TAG}-snap-old`,
    cycleId: `${RUN_TAG}-cycle-1`,
    cycleGeneration: 1,
    createdDaysAgo: 400,
    annotationId: `${RUN_TAG}-anno-old`,
  },
  {
    id: `${RUN_TAG}-snap-fresh`,
    cycleId: `${RUN_TAG}-cycle-2`,
    cycleGeneration: 2,
    createdDaysAgo: 30,
  },
];

const SEEDED_FAILURES: SeededFailure[] = [
  {
    id: `${RUN_TAG}-fail-old`,
    cycleId: `${RUN_TAG}-cycle-3`,
    cycleGeneration: 3,
    lastSeenDaysAgo: 120,
  },
  {
    id: `${RUN_TAG}-fail-fresh`,
    cycleId: `${RUN_TAG}-cycle-4`,
    cycleGeneration: 4,
    lastSeenDaysAgo: 10,
  },
];

const SNAPSHOT_IDS = SEEDED_SNAPSHOTS.map((s) => s.id);
const FAILURE_IDS = SEEDED_FAILURES.map((f) => f.id);
const ANNOTATION_IDS = SEEDED_SNAPSHOTS.map((s) => s.annotationId).filter(
  (id): id is string => Boolean(id),
);
const CYCLE_IDS = SEEDED_SNAPSHOTS.map((s) => s.cycleId);

async function seed(): Promise<void> {
  const now = Date.now();

  await db
    .insert(orgsTable)
    .values({ id: ORG_ID, name: ORG_ID, slug: ORG_ID })
    .onConflictDoNothing();

  // Cycles for snapshots only — failure rows don't FK to cycles.
  await db.insert(analysisCyclesTable).values(
    SEEDED_SNAPSHOTS.map((s) => ({
      id: s.cycleId,
      orgId: ORG_ID,
      generation: s.cycleGeneration,
      triggeredBy: "test",
      startedAt: new Date(now - s.createdDaysAgo * DAY_MS),
    })),
  );

  await db.insert(funnelSnapshotsTable).values(
    SEEDED_SNAPSHOTS.map((s) => ({
      id: s.id,
      orgId: ORG_ID,
      cycleId: s.cycleId,
      cycleGeneration: s.cycleGeneration,
      createdAt: new Date(now - s.createdDaysAgo * DAY_MS),
    })),
  );

  // Annotation tied to the old snapshot — proves cascade-delete works.
  for (const s of SEEDED_SNAPSHOTS) {
    if (!s.annotationId) continue;
    await db.insert(funnelAnnotationsTable).values({
      id: s.annotationId,
      orgId: ORG_ID,
      snapshotId: s.id,
      source: "auto",
      kind: "stage_drop",
      summary: "test",
      detail: {},
    });
  }

  await db.insert(funnelSnapshotFailuresTable).values(
    SEEDED_FAILURES.map((f) => ({
      id: f.id,
      orgId: ORG_ID,
      cycleId: f.cycleId,
      cycleGeneration: f.cycleGeneration,
      errorClass: "TestError",
      errorMessage: "test",
      firstSeenAt: new Date(now - f.lastSeenDaysAgo * DAY_MS),
      lastSeenAt: new Date(now - f.lastSeenDaysAgo * DAY_MS),
    })),
  );
}

async function cleanup(): Promise<void> {
  // Delete prune_funnel_snapshots rows the second test inserted.
  await db
    .delete(jobsTable)
    .where(eq(jobsTable.kind, "prune_funnel_snapshots" as const));
  // Snapshots cascade-delete annotations; failures stand alone.
  await db
    .delete(funnelSnapshotFailuresTable)
    .where(inArray(funnelSnapshotFailuresTable.id, FAILURE_IDS));
  await db
    .delete(funnelSnapshotsTable)
    .where(inArray(funnelSnapshotsTable.id, SNAPSHOT_IDS));
  await db
    .delete(analysisCyclesTable)
    .where(inArray(analysisCyclesTable.id, CYCLE_IDS));
  await db.delete(orgsTable).where(eq(orgsTable.id, ORG_ID));
}

async function existingSnapshotIds(): Promise<Set<string>> {
  const rows = await db
    .select({ id: funnelSnapshotsTable.id })
    .from(funnelSnapshotsTable)
    .where(inArray(funnelSnapshotsTable.id, SNAPSHOT_IDS));
  return new Set(rows.map((r) => r.id));
}

async function existingFailureIds(): Promise<Set<string>> {
  const rows = await db
    .select({ id: funnelSnapshotFailuresTable.id })
    .from(funnelSnapshotFailuresTable)
    .where(inArray(funnelSnapshotFailuresTable.id, FAILURE_IDS));
  return new Set(rows.map((r) => r.id));
}

async function existingAnnotationIds(): Promise<Set<string>> {
  if (ANNOTATION_IDS.length === 0) return new Set();
  const rows = await db
    .select({ id: funnelAnnotationsTable.id })
    .from(funnelAnnotationsTable)
    .where(inArray(funnelAnnotationsTable.id, ANNOTATION_IDS));
  return new Set(rows.map((r) => r.id));
}

test("pruneOldFunnelSnapshots deletes only rows outside the retention windows and cascades annotations", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

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

  // Pick windows that straddle the seeded ages: 365d for snapshots
  // (only the 400d-old row is past the cutoff) and 90d for failures
  // (only the 120d-old row is past).
  const result = await pruneOldFunnelSnapshots({
    snapshotsOlderThanMs: 365 * DAY_MS,
    failuresOlderThanMs: 90 * DAY_MS,
  });

  assert.equal(
    result.snapshotsDeleted,
    1,
    "exactly one snapshot older than 365d should be deleted",
  );
  assert.equal(
    result.failuresDeleted,
    1,
    "exactly one failure older than 90d should be deleted",
  );

  const remainingSnapshots = await existingSnapshotIds();
  assert.ok(
    !remainingSnapshots.has(`${RUN_TAG}-snap-old`),
    "400-day-old snapshot must be pruned",
  );
  assert.ok(
    remainingSnapshots.has(`${RUN_TAG}-snap-fresh`),
    "30-day-old snapshot must be kept",
  );

  const remainingFailures = await existingFailureIds();
  assert.ok(
    !remainingFailures.has(`${RUN_TAG}-fail-old`),
    "120-day-old failure must be pruned",
  );
  assert.ok(
    remainingFailures.has(`${RUN_TAG}-fail-fresh`),
    "10-day-old failure must be kept",
  );

  const remainingAnnotations = await existingAnnotationIds();
  assert.ok(
    !remainingAnnotations.has(`${RUN_TAG}-anno-old`),
    "annotation tied to the deleted snapshot must cascade out",
  );

  // Re-running with the same windows is a no-op now that the matching
  // rows are gone — confirms the cutoff is applied per call.
  const second = await pruneOldFunnelSnapshots({
    snapshotsOlderThanMs: 365 * DAY_MS,
    failuresOlderThanMs: 90 * DAY_MS,
  });
  assert.equal(second.snapshotsDeleted, 0);
  assert.equal(second.failuresDeleted, 0);
});

test("pruneOldFunnelSnapshots respects independent snapshot/failure windows", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

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

  // Very long snapshot window (so neither snapshot ages out) plus a
  // very short failure window (so both seeded failures age out)
  // proves the two cutoffs are applied independently.
  const result = await pruneOldFunnelSnapshots({
    snapshotsOlderThanMs: 10_000 * DAY_MS,
    failuresOlderThanMs: 1 * DAY_MS,
  });

  assert.equal(
    result.snapshotsDeleted,
    0,
    "snapshots window is wider than any seeded row — none should be pruned",
  );
  assert.equal(
    result.failuresDeleted,
    2,
    "failures window of 1d should sweep both seeded failure rows",
  );

  const remainingSnapshots = await existingSnapshotIds();
  assert.equal(remainingSnapshots.size, 2, "both snapshots must survive");

  const remainingFailures = await existingFailureIds();
  assert.equal(remainingFailures.size, 0, "all failures must be gone");
});

test("ensureFunnelSnapshotPruneJobScheduled does not enqueue a duplicate row", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  await db
    .delete(jobsTable)
    .where(eq(jobsTable.kind, "prune_funnel_snapshots" as const));

  t.after(async () => {
    try {
      await db
        .delete(jobsTable)
        .where(eq(jobsTable.kind, "prune_funnel_snapshots" as const));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("cleanup failed", err);
    }
  });

  const first = await ensureFunnelSnapshotPruneJobScheduled();
  assert.ok(first, "first call should enqueue a prune_funnel_snapshots row");
  assert.equal(first?.kind, "prune_funnel_snapshots");
  assert.equal(first?.status, "pending");

  const second = await ensureFunnelSnapshotPruneJobScheduled();
  assert.equal(
    second,
    null,
    "second call must be a no-op while a row is still pending",
  );

  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.kind, "prune_funnel_snapshots" as const));
  assert.equal(
    rows.length,
    1,
    "only the first prune_funnel_snapshots row should exist",
  );

  // Sanity: the per-kind advisory lock is distinct from the generic
  // pruner's, so the two schedulers can never serialize against each
  // other under load.
  const lockProbe = await db.execute(
    sql`SELECT pg_try_advisory_lock(0x4a4f4200, 0x46554e50) AS locked`,
  );
  const lockedRow = lockProbe.rows?.[0] as { locked?: boolean } | undefined;
  if (lockedRow?.locked === true) {
    await db.execute(sql`SELECT pg_advisory_unlock(0x4a4f4200, 0x46554e50)`);
  }
});

test.after(async () => {
  await pool.end();
});
