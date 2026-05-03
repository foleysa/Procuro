/**
 * Backfill funnel snapshots for completed cycles that ran before the
 * funnel substrate (task #185) shipped — or any other gap in the
 * `funnel_snapshots` table.
 *
 * Why
 * ---
 * The funnel observability page (`/admin/funnel/snapshots`) only shows
 * snapshots from cycles that completed AFTER the snapshot writer was
 * deployed. Tenants with months of historical `analysis_cycles` rows
 * have nothing to show — and the warm-up gate that controls auto delta
 * detection (≥5 prior snapshots) never lifts. A one-shot backfill fills
 * the gap so established tenants see their lever-performance trends
 * immediately.
 *
 * What this writes
 * ----------------
 * For each completed cycle without a snapshot, in `(orgId, generation)`
 * order:
 *   - Stages 1–5 (signal/draft/exclusion counts) are zeroed. The raw
 *     analyzer outputs aren't replayable from persisted state, so the
 *     spec for backfill explicitly accepts zero/best-effort here.
 *   - Stage 6 (`opps_persisted`) is derived from the `opportunities`
 *     rows whose `cycleId` equals this cycle.
 *   - Stages 7–9 (`opps_approved/executed/realized_{7,30,90}d`) are
 *     derived from `decisions` joined to `opportunities`, exactly the
 *     same query shape the live snapshot writer uses. Cohort windows
 *     are anchored on "now" (the moment the backfill runs), matching
 *     the recompute endpoint's behaviour.
 *   - Stage 10 (`priors_updated`) is zeroed — the Learn step's prior
 *     deltas weren't persisted per cycle, so we cannot recover the
 *     count after the fact.
 *   - `calibration` is computed from realized decisions in the trailing
 *     30d/90d, again matching the live writer.
 *   - `cohorts` drilldown is left empty (`{}`) because reconstructing
 *     `composeCohortKey()` requires the lever registry, which lives in
 *     the api-server and isn't safely importable from a script.
 *
 * Idempotency
 * -----------
 * `funnel_snapshots` has a unique index on `cycle_id`. Inserts use
 * `ON CONFLICT (cycle_id) DO NOTHING`, so re-running this script is a
 * no-op for cycles that already have a snapshot — even if a real cycle
 * captured a richer snapshot since the last backfill ran.
 *
 * Usage
 * -----
 *   pnpm --filter @workspace/scripts run backfill-funnel-snapshots
 *   pnpm --filter @workspace/scripts run backfill-funnel-snapshots -- --orgId org_seed_default
 *   pnpm --filter @workspace/scripts run backfill-funnel-snapshots -- --dry-run
 *
 * Without `--orgId`, the script processes every tenant in `orgs` in
 * deterministic order (id ASC).
 *
 * The same code path is exposed via `POST /platform/funnel/backfill`
 * (gated by PLATFORM_ADMIN_TOKEN) so the System page can trigger the
 * backfill without shell access. The API route uses the live snapshot
 * writer (`captureFunnelSnapshot`) for full parity with the recompute
 * endpoint; this script writes a minimal snapshot directly so it can
 * run without the api-server's dependency graph.
 */
import { randomUUID } from "node:crypto";
import {
  db,
  pool,
  analysisCyclesTable,
  funnelSnapshotsTable,
  opportunitiesTable,
  decisionsTable,
  orgsTable,
  COHORT_WINDOWS,
  type LeverId,
} from "@workspace/db";
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";

interface CliArgs {
  orgId: string | null;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { orgId: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--orgId") out.orgId = argv[++i] ?? null;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: backfill-funnel-snapshots [--orgId <id>] [--dry-run]\n" +
          "  --orgId <id>   Backfill only this tenant. Default: all tenants.\n" +
          "  --dry-run      Print what would be inserted without writing.\n",
      );
      process.exit(0);
    }
  }
  return out;
}

interface BackfillCounts {
  cyclesScanned: number;
  snapshotsCreated: number;
  alreadyHadSnapshot: number;
  skippedNotCompleted: number;
  failed: number;
}

function emptyCounts(): BackfillCounts {
  return {
    cyclesScanned: 0,
    snapshotsCreated: 0,
    alreadyHadSnapshot: 0,
    skippedNotCompleted: 0,
    failed: 0,
  };
}

const CALIBRATION_MIN_N = 10;
const CALIBRATION_HELP_USD = 100;

function newSnapshotId(): string {
  return `fnl_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/**
 * Build the stages 6–10 payload for a cycle that has already
 * persisted opportunities. Stages 1–5 and stage 10 are zero-shaped so
 * the JSON keys stay stable — UIs that read these counts treat
 * "zero with capped:false" as "no activity recorded", which is the
 * truthful state for a backfilled snapshot.
 */
async function buildStagesForCycle(
  orgId: string,
  cycleId: string,
  now: Date,
): Promise<{
  stages: Record<string, unknown>;
  totalDraftsProduced: number;
  totalDraftsPostExclusion: number;
  totalOppsPersisted: number;
  totalProjectedUsd: number;
}> {
  const persistedOpps = await db
    .select({
      id: opportunitiesTable.id,
      leverId: opportunitiesTable.leverId,
      projectedSavingsUsd: opportunitiesTable.projectedSavingsUsd,
    })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.orgId, orgId),
        eq(opportunitiesTable.cycleId, cycleId),
      ),
    );

  const persistedByLever: Record<string, number> = {};
  let totalProjected = 0;
  for (const o of persistedOpps) {
    persistedByLever[o.leverId] = (persistedByLever[o.leverId] ?? 0) + 1;
    totalProjected += Number(o.projectedSavingsUsd);
  }

  const stages: Record<string, unknown> = {
    // Stages 1–5 are best-effort/zero per the backfill spec — analyzer
    // inputs aren't persisted per cycle so we can't reconstruct them.
    signals_collected: { count: 0, sample_ids: [] as string[] },
    signals_mapped_to_levers: {
      count: 0,
      by_lever: {} as Record<string, number>,
      sample_ids: [] as string[],
    },
    signals_analyzed: {
      count: 0,
      by_lever: {} as Record<string, number>,
      sample_ids: [] as string[],
    },
    drafts_produced: {
      count: 0,
      by_lever: {} as Record<string, number>,
      sample_drafts: [] as unknown[],
    },
    drafts_post_exclusion: {
      count: 0,
      by_lever: {} as Record<string, number>,
      sample_drafts: [] as unknown[],
      dropped_by_exclusion: 0,
    },
    // Stage 6 — persisted opportunities (recoverable from `opportunities`).
    opps_persisted: {
      count: persistedOpps.length,
      by_lever: persistedByLever,
      total_projected_usd: round2(totalProjected),
      sample_ids: persistedOpps.map((o) => o.id),
    },
    // Stage 10 — prior deltas are not retained per cycle.
    priors_updated: {
      count: 0,
      by_lever: {} as Record<string, number>,
      deltas: [] as unknown[],
    },
  };

  // Stages 7, 8, 9 — cohort outcomes for each window relative to `now`.
  // Mirrors `captureCohortStages` in the live writer.
  for (const window of COHORT_WINDOWS) {
    const days = parseInt(window, 10);
    const since = new Date(now.getTime() - days * 86400_000);
    const rows = await db
      .select({
        oppId: opportunitiesTable.id,
        leverId: opportunitiesTable.leverId,
        eventType: decisionsTable.eventType,
        realized: decisionsTable.realizedSavingsUsd,
      })
      .from(decisionsTable)
      .innerJoin(
        opportunitiesTable,
        eq(decisionsTable.opportunityId, opportunitiesTable.id),
      )
      .where(
        and(
          eq(opportunitiesTable.orgId, orgId),
          gte(decisionsTable.createdAt, since),
        ),
      );
    const buckets: Record<
      "approve" | "execute" | "realize",
      {
        count: number;
        byLever: Record<string, number>;
        ids: Set<string>;
        realized: number;
      }
    > = {
      approve: { count: 0, byLever: {}, ids: new Set(), realized: 0 },
      execute: { count: 0, byLever: {}, ids: new Set(), realized: 0 },
      realize: { count: 0, byLever: {}, ids: new Set(), realized: 0 },
    };
    for (const r of rows) {
      const b = buckets[r.eventType as keyof typeof buckets];
      if (!b) continue;
      b.count += 1;
      b.byLever[r.leverId] = (b.byLever[r.leverId] ?? 0) + 1;
      b.ids.add(r.oppId);
      if (r.eventType === "realize" && r.realized != null) {
        b.realized += Number(r.realized);
      }
    }
    stages[`opps_approved_${window}`] = {
      count: buckets.approve.count,
      by_lever: buckets.approve.byLever,
      sample_ids: Array.from(buckets.approve.ids),
    };
    stages[`opps_executed_${window}`] = {
      count: buckets.execute.count,
      by_lever: buckets.execute.byLever,
      sample_ids: Array.from(buckets.execute.ids),
    };
    stages[`opps_realized_${window}`] = {
      count: buckets.realize.count,
      by_lever: buckets.realize.byLever,
      sample_ids: Array.from(buckets.realize.ids),
      total_realized_usd: round2(buckets.realize.realized),
    };
  }

  return {
    stages,
    totalDraftsProduced: 0,
    totalDraftsPostExclusion: 0,
    totalOppsPersisted: persistedOpps.length,
    totalProjectedUsd: round2(totalProjected),
  };
}

/**
 * Per-lever calibration on the trailing 30d/90d realized cohort. This
 * is a port of `computeCalibration` in the live writer; the verdict
 * thresholds (`n >= 10`, `> $100` swing) are duplicated as constants
 * above so a future drift here vs the live writer is loud.
 */
async function buildCalibrationForOrg(
  orgId: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const window of ["30d", "90d"] as const) {
    const days = parseInt(window, 10);
    const since = new Date(now.getTime() - days * 86400_000);
    const rows = await db
      .select({
        leverId: opportunitiesTable.leverId,
        rawProjected: opportunitiesTable.rawProjectedSavingsUsd,
        projected: opportunitiesTable.projectedSavingsUsd,
        realized: decisionsTable.realizedSavingsUsd,
      })
      .from(decisionsTable)
      .innerJoin(
        opportunitiesTable,
        eq(decisionsTable.opportunityId, opportunitiesTable.id),
      )
      .where(
        and(
          eq(opportunitiesTable.orgId, orgId),
          eq(decisionsTable.eventType, "realize"),
          gte(decisionsTable.createdAt, since),
        ),
      );

    const byLever = new Map<
      LeverId,
      Array<{ raw: number; rescaled: number; realized: number }>
    >();
    for (const r of rows) {
      if (r.realized == null) continue;
      const realized = Number(r.realized);
      const raw = Number(r.rawProjected);
      const rescaled = Number(r.projected);
      if (!isFinite(realized) || !isFinite(raw) || !isFinite(rescaled)) {
        continue;
      }
      const arr = byLever.get(r.leverId) ?? [];
      arr.push({ raw, rescaled, realized });
      byLever.set(r.leverId, arr);
    }

    for (const [leverId, samples] of byLever) {
      const rawErrs = samples
        .map((s) => Math.abs(s.raw - s.realized))
        .sort((a, b) => a - b);
      const rescaledErrs = samples
        .map((s) => Math.abs(s.rescaled - s.realized))
        .sort((a, b) => a - b);
      const rawMedian = median(rawErrs);
      const rescaledMedian = median(rescaledErrs);
      const improvementUsd = rawMedian - rescaledMedian;
      let verdict:
        | "helping"
        | "hurting"
        | "neutral"
        | "insufficient_evidence" = "neutral";
      if (samples.length < CALIBRATION_MIN_N) {
        verdict = "insufficient_evidence";
      } else if (improvementUsd > CALIBRATION_HELP_USD) {
        verdict = "helping";
      } else if (improvementUsd < -CALIBRATION_HELP_USD) {
        verdict = "hurting";
      }
      out[`${leverId}:${window}`] = {
        leverId,
        window,
        n: samples.length,
        rawMedianAbsErrorUsd: round2(rawMedian),
        rescaledMedianAbsErrorUsd: round2(rescaledMedian),
        improvementUsd: round2(improvementUsd),
        verdict,
      };
    }
  }
  return out;
}

/**
 * Backfill snapshots for one tenant. Returns counts so the caller can
 * report a per-tenant summary.
 */
async function backfillOrg(
  orgId: string,
  args: CliArgs,
): Promise<BackfillCounts> {
  const counts = emptyCounts();
  const now = new Date();
  const calibration = await buildCalibrationForOrg(orgId, now);

  // Walk cycles ordered by (generation ASC) so the resulting
  // `cycle_generation` column on funnel_snapshots is monotonic — the
  // delta-detection logic on the live writer reads "the last 5
  // snapshots" by generation, so backfilled rows must respect the same
  // ordering even though they're inserted in a different real-time
  // order.
  const cycles = await db
    .select({
      id: analysisCyclesTable.id,
      generation: analysisCyclesTable.generation,
      status: analysisCyclesTable.status,
    })
    .from(analysisCyclesTable)
    .leftJoin(
      funnelSnapshotsTable,
      eq(funnelSnapshotsTable.cycleId, analysisCyclesTable.id),
    )
    .where(
      and(
        eq(analysisCyclesTable.orgId, orgId),
        // Anti-join: keep only cycles that don't already have a snapshot.
        isNull(funnelSnapshotsTable.id),
      ),
    )
    .orderBy(asc(analysisCyclesTable.generation));

  for (const cycle of cycles) {
    counts.cyclesScanned += 1;
    if (cycle.status !== "completed") {
      counts.skippedNotCompleted += 1;
      continue;
    }
    try {
      const built = await buildStagesForCycle(orgId, cycle.id, now);
      if (args.dryRun) {
        console.log(
          `[backfill-funnel] (dry-run) org=${orgId} cycle=${cycle.id} ` +
            `gen=${cycle.generation} opps=${built.totalOppsPersisted} ` +
            `projected=$${built.totalProjectedUsd}`,
        );
        counts.snapshotsCreated += 1;
        continue;
      }
      const inserted = await db
        .insert(funnelSnapshotsTable)
        .values({
          id: newSnapshotId(),
          orgId,
          cycleId: cycle.id,
          cycleGeneration: cycle.generation,
          stages: built.stages,
          cohorts: {},
          calibration,
          totalDraftsProduced: built.totalDraftsProduced,
          totalDraftsPostExclusion: built.totalDraftsPostExclusion,
          totalOppsPersisted: built.totalOppsPersisted,
          totalProjectedUsd: built.totalProjectedUsd.toFixed(2),
          captureDurationMs: 0,
          // Provenance: marks this row as a post-hoc reconstruction.
          // The admin UI badges these visibly and the trailing-baseline
          // delta detector excludes them so zeroed stages 1–5 don't
          // pollute the live cycle baseline.
          source: "backfill",
        })
        // The unique index on `cycle_id` makes this insert idempotent
        // even when two backfill runs race or when a real cycle wrote
        // a snapshot between our anti-join read and the insert.
        .onConflictDoNothing({ target: funnelSnapshotsTable.cycleId })
        .returning({ id: funnelSnapshotsTable.id });
      if (inserted.length > 0) {
        counts.snapshotsCreated += 1;
      } else {
        counts.alreadyHadSnapshot += 1;
      }
    } catch (err) {
      counts.failed += 1;
      console.error(
        `[backfill-funnel] org=${orgId} cycle=${cycle.id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return counts;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let orgIds: string[];
  if (args.orgId) {
    orgIds = [args.orgId];
  } else {
    const rows = await db
      .select({ id: orgsTable.id })
      .from(orgsTable)
      .orderBy(asc(orgsTable.id));
    orgIds = rows.map((r) => r.id);
  }

  if (orgIds.length === 0) {
    console.log("[backfill-funnel] no tenants to process.");
    return;
  }

  console.log(
    `[backfill-funnel] ${args.dryRun ? "(dry-run) " : ""}processing ` +
      `${orgIds.length} tenant(s)…`,
  );

  const totals = emptyCounts();
  for (const orgId of orgIds) {
    const c = await backfillOrg(orgId, args);
    totals.cyclesScanned += c.cyclesScanned;
    totals.snapshotsCreated += c.snapshotsCreated;
    totals.alreadyHadSnapshot += c.alreadyHadSnapshot;
    totals.skippedNotCompleted += c.skippedNotCompleted;
    totals.failed += c.failed;
    console.log(
      `[backfill-funnel] org=${orgId} ` +
        `scanned=${c.cyclesScanned} ` +
        `created=${c.snapshotsCreated} ` +
        `existed=${c.alreadyHadSnapshot} ` +
        `not_completed=${c.skippedNotCompleted} ` +
        `failed=${c.failed}`,
    );
  }

  console.log(
    `[backfill-funnel] DONE total ` +
      `scanned=${totals.cyclesScanned} ` +
      `created=${totals.snapshotsCreated} ` +
      `existed=${totals.alreadyHadSnapshot} ` +
      `not_completed=${totals.skippedNotCompleted} ` +
      `failed=${totals.failed}`,
  );

  // Suppress an "unused import" warning when this file is statically
  // analysed by tooling that doesn't follow conditional code paths.
  void sql;
}

main()
  .catch((err) => {
    console.error("[backfill-funnel] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
