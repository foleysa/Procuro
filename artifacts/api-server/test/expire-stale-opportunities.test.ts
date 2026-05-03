/**
 * Integration test for the auto-expire job that flips stale
 * `proposed` opportunities to `expired` (task #219).
 *
 * Two cutoffs apply, independently:
 *
 *   - TTL: rows with `created_at` older than `OPPORTUNITY_TTL_DAYS`
 *     (default 30d) are expired regardless of cycle activity.
 *   - Quiet cycles: rows whose `last_seen_at` is older than the
 *     `OPPORTUNITY_QUIET_CYCLES`-th-most-recent completed cycle's
 *     `completed_at` are expired even if newer than the TTL.
 *
 * The invariants pinned here:
 *
 *   - TTL sweep flips only `proposed` rows past the cutoff.
 *   - Quiet-cycles sweep uses the per-org cycle history; rows whose
 *     signal has been seen recently are kept.
 *   - Rows with NULL `last_seen_at` (legacy) are NOT touched by the
 *     quiet-cycles sweep — only the TTL sweep can age them out.
 *   - Rows in non-`proposed` status (`approved`, `executing`,
 *     `realized`, `rejected`, `expired`) are NEVER touched.
 *   - The result row reports TTL vs quiet-cycles counts independently
 *     so operators can see which cause is dominant.
 *   - `ensureExpireStaleOpportunitiesScheduled` is idempotent.
 *
 * Prereqs: `DATABASE_URL` is set and the schema has been pushed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  jobsTable,
  orgsTable,
  opportunitiesTable,
  analysisCyclesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import {
  expireStaleOpportunities,
  ensureExpireStaleOpportunitiesScheduled,
} from "../src/lib/jobs/queue";

const RUN_TAG = `expire-stale-opps-test-${Date.now()}-${process.pid}`;
const ORG_ID = `${RUN_TAG}-org`;
const LEVER_ID = "supplier_consolidation" as const;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SeededRow {
  id: string;
  status: "proposed" | "approved" | "executing" | "realized" | "expired";
  createdDaysAgo: number;
  /** Days ago for last_seen_at; null = legacy NULL value. */
  lastSeenDaysAgo: number | null;
  signalKey: string | null;
}

interface SeededCycle {
  id: string;
  generation: number;
  /** When `completed_at` was set; null = still running. */
  completedDaysAgo: number | null;
}

const SEEDED_ROWS: SeededRow[] = [
  // (1) Old `proposed` row, signal still seen recently → TTL expires it
  // anyway because TTL > quiet-cycles freshness.
  {
    id: `${RUN_TAG}-row-ttl-old`,
    status: "proposed",
    createdDaysAgo: 60,
    lastSeenDaysAgo: 0,
    signalKey: `${RUN_TAG}-sig-1`,
  },
  // (2) Fresh `proposed` row whose signal hasn't been seen since cycle
  // gen 1 (oldest) → quiet-cycles sweep with quietCycles=2 should flip it.
  {
    id: `${RUN_TAG}-row-quiet-stale`,
    status: "proposed",
    createdDaysAgo: 5,
    lastSeenDaysAgo: 12,
    signalKey: `${RUN_TAG}-sig-2`,
  },
  // (3) Fresh `proposed` row, signal seen as recently as the most
  // recent cycle → kept by both sweeps.
  {
    id: `${RUN_TAG}-row-fresh-kept`,
    status: "proposed",
    createdDaysAgo: 2,
    lastSeenDaysAgo: 0,
    signalKey: `${RUN_TAG}-sig-3`,
  },
  // (4) Legacy `proposed` row with NULL last_seen_at AND fresh
  // created_at → quiet-cycles cannot touch it (NULL); TTL doesn't
  // either (fresh). Stays.
  {
    id: `${RUN_TAG}-row-legacy-fresh`,
    status: "proposed",
    createdDaysAgo: 5,
    lastSeenDaysAgo: null,
    signalKey: null,
  },
  // (5) Legacy `proposed` row with NULL last_seen_at AND OLD
  // created_at → only TTL can touch it. Should be flipped.
  {
    id: `${RUN_TAG}-row-legacy-ttl`,
    status: "proposed",
    createdDaysAgo: 90,
    lastSeenDaysAgo: null,
    signalKey: null,
  },
  // (6) Old `approved` row → never touched by either sweep.
  {
    id: `${RUN_TAG}-row-approved`,
    status: "approved",
    createdDaysAgo: 90,
    lastSeenDaysAgo: 30,
    signalKey: `${RUN_TAG}-sig-4`,
  },
  // (7) Old `expired` row → already expired, must not be re-counted.
  {
    id: `${RUN_TAG}-row-already-expired`,
    status: "expired",
    createdDaysAgo: 90,
    lastSeenDaysAgo: 30,
    signalKey: `${RUN_TAG}-sig-5`,
  },
];

const SEEDED_CYCLES: SeededCycle[] = [
  // Most recent (offset 0)
  { id: `${RUN_TAG}-cyc-3`, generation: 3, completedDaysAgo: 0 },
  // Offset 1 (this is the cutoff for quietCycles=2 — last_seen_at
  // strictly older than this is stale).
  { id: `${RUN_TAG}-cyc-2`, generation: 2, completedDaysAgo: 7 },
  // Offset 2
  { id: `${RUN_TAG}-cyc-1`, generation: 1, completedDaysAgo: 14 },
];

const ROW_IDS = SEEDED_ROWS.map((r) => r.id);
const CYCLE_IDS = SEEDED_CYCLES.map((c) => c.id);

async function cleanup(): Promise<void> {
  await db
    .delete(jobsTable)
    .where(eq(jobsTable.kind, "expire_stale_opportunities" as const));
  await db
    .delete(opportunitiesTable)
    .where(inArray(opportunitiesTable.id, ROW_IDS));
  await db
    .delete(analysisCyclesTable)
    .where(inArray(analysisCyclesTable.id, CYCLE_IDS));
  await db.delete(orgsTable).where(eq(orgsTable.id, ORG_ID));
}

async function seed(): Promise<void> {
  const now = Date.now();

  await db
    .insert(orgsTable)
    .values({ id: ORG_ID, name: ORG_ID, slug: ORG_ID })
    .onConflictDoNothing();

  await db.insert(analysisCyclesTable).values(
    SEEDED_CYCLES.map((c) => ({
      id: c.id,
      orgId: ORG_ID,
      generation: c.generation,
      triggeredBy: "test",
      status: "completed" as const,
      startedAt: new Date(
        now - (c.completedDaysAgo ?? 0) * DAY_MS - 1000,
      ),
      completedAt:
        c.completedDaysAgo === null
          ? null
          : new Date(now - c.completedDaysAgo * DAY_MS),
    })),
  );

  await db.insert(opportunitiesTable).values(
    SEEDED_ROWS.map((r) => ({
      id: r.id,
      orgId: ORG_ID,
      cycleId: SEEDED_CYCLES[0]!.id,
      leverId: LEVER_ID,
      tier: 1,
      title: r.id,
      rationale: "test",
      recommendedAction: "test",
      rawProjectedSavingsUsd: "100.00",
      projectedSavingsUsd: "100.00",
      confidence: "0.5000",
      inputs: {},
      status: r.status,
      signalKey: r.signalKey,
      lastSeenAt:
        r.lastSeenDaysAgo === null
          ? null
          : new Date(now - r.lastSeenDaysAgo * DAY_MS),
      createdAt: new Date(now - r.createdDaysAgo * DAY_MS),
    })),
  );
}

interface RowSnapshot {
  status: string;
  expiryReason: "ttl" | "quiet_cycles" | null;
}

async function rowsById(): Promise<Map<string, RowSnapshot>> {
  const rows = await db
    .select({
      id: opportunitiesTable.id,
      status: opportunitiesTable.status,
      expiryReason: opportunitiesTable.expiryReason,
    })
    .from(opportunitiesTable)
    .where(inArray(opportunitiesTable.id, ROW_IDS));
  return new Map(
    rows.map((r) => [
      r.id,
      { status: r.status, expiryReason: r.expiryReason },
    ]),
  );
}

test("expireStaleOpportunities flips TTL-stale and quiet-cycle-stale rows; leaves the rest", async (t) => {
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

  // Pick cutoffs that straddle the seeded ages: TTL=30d catches
  // rows 60d/90d old; quietCycles=2 catches rows whose last_seen_at
  // < cycle gen-2's completed_at (7d ago) — i.e. row (2) at 12d.
  const result = await expireStaleOpportunities({
    ttlDays: 30,
    quietCycles: 2,
  });

  assert.equal(result.ttlDays, 30);
  assert.equal(result.quietCycles, 2);
  assert.ok(
    result.ttlExpired >= 2,
    `TTL sweep should expire at least the 60d and 90d proposed rows, got ${result.ttlExpired}`,
  );
  assert.ok(
    result.quietCyclesExpired >= 1,
    `quiet-cycles sweep should expire at least the 12d-stale row, got ${result.quietCyclesExpired}`,
  );
  assert.equal(
    result.totalExpired,
    result.ttlExpired + result.quietCyclesExpired,
  );
  assert.ok(result.orgsScanned >= 1);

  const after = await rowsById();
  assert.equal(
    after.get(`${RUN_TAG}-row-ttl-old`)?.status,
    "expired",
    "60d-old proposed row must be TTL-expired",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-ttl-old`)?.expiryReason,
    "ttl",
    "TTL-expired row must carry expiryReason='ttl' for the Approvals view",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-legacy-ttl`)?.status,
    "expired",
    "90d-old legacy proposed row must be TTL-expired",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-legacy-ttl`)?.expiryReason,
    "ttl",
    "Legacy TTL-expired row must also carry expiryReason='ttl'",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-quiet-stale`)?.status,
    "expired",
    "12d-stale proposed row must be quiet-cycles-expired",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-quiet-stale`)?.expiryReason,
    "quiet_cycles",
    "Quiet-cycles-expired row must carry expiryReason='quiet_cycles'",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-fresh-kept`)?.status,
    "proposed",
    "fresh, recently-seen row must NOT be expired",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-fresh-kept`)?.expiryReason,
    null,
    "non-expired row must NOT carry an expiryReason",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-legacy-fresh`)?.status,
    "proposed",
    "legacy NULL-last_seen_at fresh row must NOT be expired (only TTL can touch legacy)",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-approved`)?.status,
    "approved",
    "approved row must NEVER be touched by the expiry job",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-already-expired`)?.status,
    "expired",
    "already-expired row must remain expired (and not be re-counted)",
  );
  assert.equal(
    after.get(`${RUN_TAG}-row-already-expired`)?.expiryReason,
    null,
    "pre-existing expired row must NOT be back-filled with an expiryReason — the column is populated by the sweep itself, not retroactively",
  );
});

test("expireStaleOpportunities second run is a no-op once nothing is stale", async (t) => {
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

  await expireStaleOpportunities({ ttlDays: 30, quietCycles: 2 });
  const second = await expireStaleOpportunities({
    ttlDays: 30,
    quietCycles: 2,
  });
  assert.equal(
    second.totalExpired,
    0,
    "no rows remain stale after the first sweep, so the second is a no-op",
  );
});

test("ensureExpireStaleOpportunitiesScheduled is idempotent under contention", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Independent of the seeded opportunity rows — only manages the
  // jobs-queue side of things. Cleanup wipes its own jobs.
  await db
    .delete(jobsTable)
    .where(eq(jobsTable.kind, "expire_stale_opportunities" as const));
  t.after(async () => {
    await db
      .delete(jobsTable)
      .where(eq(jobsTable.kind, "expire_stale_opportunities" as const));
  });

  const first = await ensureExpireStaleOpportunitiesScheduled();
  assert.ok(first, "first call inserts a pending job");
  assert.equal(first?.kind, "expire_stale_opportunities");
  assert.equal(first?.status, "pending");

  const second = await ensureExpireStaleOpportunitiesScheduled();
  assert.equal(
    second,
    null,
    "second call is a no-op while the prior row is still pending",
  );

  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.kind, "expire_stale_opportunities" as const));
  assert.equal(rows.length, 1, "only one pending job row exists");
});

test.after(async () => {
  await pool.end();
});
