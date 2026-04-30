/**
 * Funnel substrate (task #185) — admin observability v1.
 *
 * One snapshot per (org, cycle). Captures the 10-stage OODA pipeline
 * with cohort identity tuples, prior calibration, and behavioural
 * delta-detection annotations. Snapshot capture is wrapped in a guard
 * that records failures into `funnel_snapshot_failures` instead of
 * letting them propagate — a snapshot bug must never fail a cycle.
 *
 *   Stages captured (`stages.<key>` on funnel_snapshots):
 *     1. signals_collected         (within-cycle pull from market_signals)
 *     2. signals_mapped_to_levers  (signals matched to ≥1 lever scope)
 *     3. signals_analyzed          (sum of consultedSignalIds across levers)
 *     4. drafts_produced           (sum of drafts before exclusions)
 *     5. drafts_post_exclusion     (drafts after Decide-step exclusion gate)
 *     6. opps_persisted            (rows actually written to opportunities)
 *     7. opps_approved_{7,30,90}d  (cohort: approved within window since persistence)
 *     8. opps_executed_{7,30,90}d  (cohort: executed within window since persistence)
 *     9. opps_realized_{7,30,90}d  (cohort: realized within window since persistence)
 *    10. priors_updated            (per-lever prior deltas this cycle)
 */
import {
  db,
  funnelSnapshotsTable,
  funnelSnapshotFailuresTable,
  funnelAnnotationsTable,
  opportunitiesTable,
  decisionsTable,
  marketSignalsTable,
  analysisCyclesTable,
  orgsTable,
  COHORT_WINDOWS,
  type CohortWindow,
  type LeverId,
  type OpportunityRow,
} from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, lt, sql, isNull, or } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";
import { ALL_LEVERS } from "../levers";
import {
  composeCohortKey,
  type AnalyzeResult,
  type LeverAnalyzer,
  type OpportunityDraft,
} from "../levers/types";
import type { PriorDelta } from "./priors";

// --- Drill-down caps (per task spec). Once exceeded, the stage records
//     `capped: true` and stores only the head sample so a hot tenant
//     can't blow up snapshot rows.
export const STAGE_SAMPLE_CAPS = {
  signals_collected: 5000,
  signals_mapped_to_levers: 5000,
  signals_analyzed: 2000,
  drafts_produced: 2000,
  drafts_post_exclusion: 2000,
  opps_persisted: 2000,
  opps_approved: 1000,
  opps_executed: 1000,
  opps_realized: 1000,
  priors_updated: 500,
} as const;

// --- Delta-detection thresholds (dual condition: both must be exceeded).
const DELTA_REL_PCT = 0.25; // ≥25% relative move vs trailing-5 mean
const DELTA_ABS_FLOORS: Record<string, number> = {
  signals_collected: 50,
  signals_mapped_to_levers: 50,
  signals_analyzed: 50,
  drafts_produced: 10,
  drafts_post_exclusion: 10,
  opps_persisted: 10,
  opps_approved: 5,
  opps_executed: 5,
  opps_realized: 5,
  priors_updated: 5,
};
const WARMUP_CYCLES = 5;

// --- Calibration thresholds.
const CALIBRATION_MIN_N = 10;
const CALIBRATION_HELP_USD = 100;

// --- Dedupe window for snapshot failures.
const FAILURE_RECURRENCE_WINDOW_HOURS = 24;

/**
 * Within-cycle inputs the snapshot writer needs from the cycle runner.
 * Keyed by cycle to keep the writer testable in isolation.
 */
export interface CycleSnapshotInputs {
  orgId: string;
  cycleId: string;
  cycleGeneration: number;
  /**
   * Per-lever analyze results, in the order the cycle ran them.
   * The writer derives stages 1–4 from these.
   */
  leverResults: Array<{ lever: LeverAnalyzer; result: AnalyzeResult }>;
  /** Drafts that survived the exclusion gate. */
  draftsPostExclusion: Array<{ lever: LeverAnalyzer; draft: OpportunityDraft }>;
  /** Persisted opportunities (after Act). */
  persistedOpps: OpportunityRow[];
  /** Prior deltas the Learn step applied this cycle. */
  priorDeltas: PriorDelta[];
}

interface StagePayload {
  count: number;
  capped?: boolean;
  by_lever?: Record<string, number>;
  sample_ids?: string[];
  sample_drafts?: Array<{
    leverId: LeverId;
    title: string;
    cohortKey: string;
    rawProjectedSavingsUsd: number;
  }>;
  total_projected_usd?: number;
  total_realized_usd?: number;
  dropped_by_exclusion?: number;
  deltas?: PriorDelta[];
}

/**
 * Public entry point. Always returns; failures are recorded.
 */
export async function captureFunnelSnapshot(
  inputs: CycleSnapshotInputs,
): Promise<{ snapshotId: string | null; failed: boolean }> {
  const t0 = Date.now();
  let stage = "init";
  try {
    stage = "signals";
    const signalsStages = await captureSignalsStages(inputs);
    stage = "drafts";
    const draftsStages = captureDraftsStages(inputs);
    stage = "persisted";
    const persistedStage = capturePersistedStage(inputs);
    stage = "cohorts";
    const cohortStages = await captureCohortStages(inputs);
    stage = "priors";
    const priorsStage = capturePriorsStage(inputs);
    stage = "calibration";
    const calibration = await computeCalibration(inputs.orgId);
    stage = "cohorts_drilldown";
    const cohortDrilldown = buildCohortDrilldown(inputs);

    const stages: Record<string, StagePayload> = {
      ...signalsStages,
      ...draftsStages,
      ...persistedStage,
      ...cohortStages,
      ...priorsStage,
    };

    const snapshotId = newId("fnl");
    const totalProjected = inputs.persistedOpps.reduce(
      (acc, o) => acc + Number(o.projectedSavingsUsd),
      0,
    );

    stage = "insert";
    await db.insert(funnelSnapshotsTable).values({
      id: snapshotId,
      orgId: inputs.orgId,
      cycleId: inputs.cycleId,
      cycleGeneration: inputs.cycleGeneration,
      stages: stages as unknown as Record<string, unknown>,
      cohorts: cohortDrilldown,
      calibration: calibration as unknown as Record<string, unknown>,
      totalDraftsProduced: stages["drafts_produced"]?.count ?? 0,
      totalDraftsPostExclusion: stages["drafts_post_exclusion"]?.count ?? 0,
      totalOppsPersisted: stages["opps_persisted"]?.count ?? 0,
      totalProjectedUsd: totalProjected.toFixed(2),
      captureDurationMs: Date.now() - t0,
    });

    // Delta detection runs AFTER the snapshot persists so the snapshot
    // row id is stable for annotation FK. Errors here are logged but
    // don't fail the snapshot — annotations are nice-to-have lineage.
    try {
      stage = "deltas";
      const fired = await detectAndAnnotateDeltas({
        orgId: inputs.orgId,
        snapshotId,
        currentStages: stages,
      });
      if (fired > 0) {
        await db
          .update(funnelSnapshotsTable)
          .set({ hasAutoAnnotation: 1 })
          .where(eq(funnelSnapshotsTable.id, snapshotId));
      }
    } catch (err) {
      logger.warn(
        { err, orgId: inputs.orgId, snapshotId },
        "Funnel delta-annotation failed (non-fatal)",
      );
    }

    return { snapshotId, failed: false };
  } catch (err) {
    await recordSnapshotFailure(inputs, err, stage);
    return { snapshotId: null, failed: true };
  }
}

/** Stages 1, 2, 3 — derived from analyze results. */
async function captureSignalsStages(
  inputs: CycleSnapshotInputs,
): Promise<Record<string, StagePayload>> {
  // Stage 1: how many market_signals exist for this tenant + global at
  // cycle time. Bounded by the snapshot caps.
  const collectedRows = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(
      or(
        isNull(marketSignalsTable.orgId),
        eq(marketSignalsTable.orgId, inputs.orgId),
      ),
    )
    .orderBy(desc(marketSignalsTable.observedAt))
    .limit(STAGE_SAMPLE_CAPS.signals_collected + 1);
  const collectedCapped =
    collectedRows.length > STAGE_SAMPLE_CAPS.signals_collected;
  const collectedSample = collectedRows
    .slice(0, STAGE_SAMPLE_CAPS.signals_collected)
    .map((r) => r.id);

  // Stage 2: signals mapped to ≥1 lever scope. We approximate this as
  // the union of consultedSignalIds across levers (a signal is "mapped"
  // if at least one lever could consult it). For tenants with no
  // signal-driven levers active this collapses to 0, which is correct.
  // Stage 3: signals analyzed = same as union — every consulted signal
  // was looked at by analyze(). Kept as separate stages for shape parity
  // with the spec; if a future lever introduces a "considered but not
  // analyzed" path, the two diverge naturally.
  const consultedAll = new Set<string>();
  const byLeverConsulted: Record<string, number> = {};
  for (const { lever, result } of inputs.leverResults) {
    const ids = result.consultedSignalIds;
    byLeverConsulted[lever.leverId] = ids.length;
    for (const id of ids) consultedAll.add(id);
  }
  const consultedArr = Array.from(consultedAll);
  const analyzedCapped = consultedArr.length > STAGE_SAMPLE_CAPS.signals_analyzed;
  const analyzedSample = consultedArr.slice(0, STAGE_SAMPLE_CAPS.signals_analyzed);

  return {
    signals_collected: {
      count: collectedCapped
        ? STAGE_SAMPLE_CAPS.signals_collected
        : collectedRows.length,
      capped: collectedCapped,
      sample_ids: collectedSample,
    },
    signals_mapped_to_levers: {
      count: consultedArr.length,
      capped: analyzedCapped,
      by_lever: byLeverConsulted,
      sample_ids: analyzedSample,
    },
    signals_analyzed: {
      count: consultedArr.length,
      capped: analyzedCapped,
      by_lever: byLeverConsulted,
      sample_ids: analyzedSample,
    },
  };
}

/** Stages 4, 5 — derived from analyze results + post-exclusion drafts. */
function captureDraftsStages(
  inputs: CycleSnapshotInputs,
): Record<string, StagePayload> {
  const allDrafts = inputs.leverResults.flatMap(({ lever, result }) =>
    result.drafts.map((d) => ({ lever, draft: d })),
  );
  const producedByLever: Record<string, number> = {};
  for (const { lever } of allDrafts) {
    producedByLever[lever.leverId] = (producedByLever[lever.leverId] ?? 0) + 1;
  }
  const producedCapped = allDrafts.length > STAGE_SAMPLE_CAPS.drafts_produced;
  const producedSample = allDrafts
    .slice(0, STAGE_SAMPLE_CAPS.drafts_produced)
    .map(({ lever, draft }) => ({
      leverId: draft.leverId,
      title: draft.title.slice(0, 200),
      cohortKey: composeCohortKey(lever, draft),
      rawProjectedSavingsUsd: draft.rawProjectedSavingsUsd,
    }));

  const postExByLever: Record<string, number> = {};
  for (const { lever } of inputs.draftsPostExclusion) {
    postExByLever[lever.leverId] = (postExByLever[lever.leverId] ?? 0) + 1;
  }
  const postExCapped =
    inputs.draftsPostExclusion.length > STAGE_SAMPLE_CAPS.drafts_post_exclusion;
  const postExSample = inputs.draftsPostExclusion
    .slice(0, STAGE_SAMPLE_CAPS.drafts_post_exclusion)
    .map(({ lever, draft }) => ({
      leverId: draft.leverId,
      title: draft.title.slice(0, 200),
      cohortKey: composeCohortKey(lever, draft),
      rawProjectedSavingsUsd: draft.rawProjectedSavingsUsd,
    }));

  return {
    drafts_produced: {
      count: allDrafts.length,
      capped: producedCapped,
      by_lever: producedByLever,
      sample_drafts: producedSample,
    },
    drafts_post_exclusion: {
      count: inputs.draftsPostExclusion.length,
      capped: postExCapped,
      by_lever: postExByLever,
      sample_drafts: postExSample,
      dropped_by_exclusion:
        allDrafts.length - inputs.draftsPostExclusion.length,
    },
  };
}

/** Stage 6 — opps actually written to the table. */
function capturePersistedStage(
  inputs: CycleSnapshotInputs,
): Record<string, StagePayload> {
  const byLever: Record<string, number> = {};
  let totalProjected = 0;
  for (const o of inputs.persistedOpps) {
    byLever[o.leverId] = (byLever[o.leverId] ?? 0) + 1;
    totalProjected += Number(o.projectedSavingsUsd);
  }
  const capped = inputs.persistedOpps.length > STAGE_SAMPLE_CAPS.opps_persisted;
  return {
    opps_persisted: {
      count: inputs.persistedOpps.length,
      capped,
      by_lever: byLever,
      total_projected_usd: Math.round(totalProjected * 100) / 100,
      sample_ids: inputs.persistedOpps
        .slice(0, STAGE_SAMPLE_CAPS.opps_persisted)
        .map((o) => o.id),
    },
  };
}

/**
 * Stages 7, 8, 9 — cohort outcomes. The cohort window is anchored on
 * `opportunities.created_at` (cycle persistence time). For the CURRENT
 * cycle the windows are necessarily 0, but we capture the trailing
 * 7d/30d/90d cohort outcomes for opportunities persisted IN THE PAST so
 * the admin sees the moving cohort each time we snapshot.
 */
async function captureCohortStages(
  inputs: CycleSnapshotInputs,
): Promise<Record<string, StagePayload>> {
  const out: Record<string, StagePayload> = {};
  const now = new Date();
  for (const window of COHORT_WINDOWS) {
    const days = parseInt(window, 10);
    const since = new Date(now.getTime() - days * 86400_000);
    // Pull all decisions that happened since `since` and join to opps so
    // we know which lever each cohort entry belongs to. The cohort is
    // "decisions in this window for opps persisted in this window".
    const rows = await db
      .select({
        oppId: opportunitiesTable.id,
        leverId: opportunitiesTable.leverId,
        createdAt: opportunitiesTable.createdAt,
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
          eq(opportunitiesTable.orgId, inputs.orgId),
          gte(decisionsTable.createdAt, since),
        ),
      );

    const byEvent: Record<
      string,
      { count: number; byLever: Record<string, number>; ids: Set<string>; realized: number }
    > = {
      approve: { count: 0, byLever: {}, ids: new Set(), realized: 0 },
      execute: { count: 0, byLever: {}, ids: new Set(), realized: 0 },
      realize: { count: 0, byLever: {}, ids: new Set(), realized: 0 },
    };
    for (const r of rows) {
      const bucket = byEvent[r.eventType as keyof typeof byEvent];
      if (!bucket) continue;
      bucket.count += 1;
      bucket.byLever[r.leverId] = (bucket.byLever[r.leverId] ?? 0) + 1;
      bucket.ids.add(r.oppId);
      if (r.eventType === "realize" && r.realized) {
        bucket.realized += Number(r.realized);
      }
    }

    out[`opps_approved_${window}`] = stageFromBucket(
      byEvent["approve"]!,
      STAGE_SAMPLE_CAPS.opps_approved,
    );
    out[`opps_executed_${window}`] = stageFromBucket(
      byEvent["execute"]!,
      STAGE_SAMPLE_CAPS.opps_executed,
    );
    const realized = stageFromBucket(
      byEvent["realize"]!,
      STAGE_SAMPLE_CAPS.opps_realized,
    );
    realized.total_realized_usd = Math.round(byEvent["realize"]!.realized * 100) / 100;
    out[`opps_realized_${window}`] = realized;
  }
  return out;
}

function stageFromBucket(
  b: { count: number; byLever: Record<string, number>; ids: Set<string> },
  cap: number,
): StagePayload {
  const ids = Array.from(b.ids);
  const capped = ids.length > cap;
  return {
    count: b.count,
    capped,
    by_lever: b.byLever,
    sample_ids: ids.slice(0, cap),
  };
}

/** Stage 10 — prior updates from the Learn step. */
function capturePriorsStage(
  inputs: CycleSnapshotInputs,
): Record<string, StagePayload> {
  const byLever: Record<string, number> = {};
  for (const d of inputs.priorDeltas) {
    byLever[d.leverId] = (byLever[d.leverId] ?? 0) + 1;
  }
  const capped = inputs.priorDeltas.length > STAGE_SAMPLE_CAPS.priors_updated;
  return {
    priors_updated: {
      count: inputs.priorDeltas.length,
      capped,
      by_lever: byLever,
      deltas: inputs.priorDeltas.slice(0, STAGE_SAMPLE_CAPS.priors_updated),
    },
  };
}

/**
 * Per-cohort drill-down keyed by window. Each entry records the
 * cohort identity tuple count so an admin can see WHO was in the
 * cohort, not just totals.
 */
function buildCohortDrilldown(
  inputs: CycleSnapshotInputs,
): Record<string, unknown> {
  const out: Record<string, Array<{ key: string; count: number }>> = {};
  // For the persistence cohort, record one row per identity tuple.
  // The lever lookup table lets us call cohortKey() on each draft.
  const leverById = new Map<string, LeverAnalyzer>();
  for (const l of ALL_LEVERS) leverById.set(l.leverId, l);

  const persistKeyCounts = new Map<string, number>();
  for (const opp of inputs.persistedOpps) {
    const lever = leverById.get(opp.leverId);
    if (!lever) continue;
    // Reconstruct a draft-shaped object so cohortKey() works the same.
    const draftLike: OpportunityDraft = {
      leverId: opp.leverId,
      title: opp.title,
      rationale: opp.rationale,
      recommendedAction: opp.recommendedAction,
      supplierId: opp.supplierId,
      categoryId: opp.categoryId,
      rawProjectedSavingsUsd: Number(opp.rawProjectedSavingsUsd),
      inputs: opp.inputs as Record<string, unknown>,
    };
    const key = composeCohortKey(lever, draftLike);
    persistKeyCounts.set(key, (persistKeyCounts.get(key) ?? 0) + 1);
  }
  out["persisted"] = Array.from(persistKeyCounts.entries())
    .map(([key, count]) => ({ key, count }))
    .slice(0, STAGE_SAMPLE_CAPS.opps_persisted);
  return out;
}

/**
 * Median absolute error of (projected - realized) USD per lever, both
 * raw (without prior) and with the current prior multiplier applied,
 * over the trailing 30d/90d realized cohort. The verdict gates on
 * n ≥ 10 and a $100 swing in the buyer's favor.
 */
async function computeCalibration(
  orgId: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const window of ["30d", "90d"] as const) {
    const days = parseInt(window, 10);
    const since = new Date(Date.now() - days * 86400_000);
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
      string,
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
      // Only the most recent window per lever wins. We process 30d
      // first then 90d; later writes overwrite earlier — so the final
      // payload is the longer window where present, falling back to
      // 30d. To keep both, we namespace by window.
      const key = `${leverId}:${window}`;
      out[key] = {
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

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Detect material changes vs the trailing 5 cycles and emit one
 * annotation per stage that exceeds BOTH the relative threshold and
 * the per-stage absolute floor. Returns the number of annotations
 * fired. Skipped entirely until we have ≥ WARMUP_CYCLES history.
 */
export async function detectAndAnnotateDeltas(args: {
  orgId: string;
  snapshotId: string;
  currentStages: Record<string, StagePayload>;
}): Promise<number> {
  const prior = await db
    .select({
      stages: funnelSnapshotsTable.stages,
      cycleGeneration: funnelSnapshotsTable.cycleGeneration,
    })
    .from(funnelSnapshotsTable)
    .where(eq(funnelSnapshotsTable.orgId, args.orgId))
    .orderBy(desc(funnelSnapshotsTable.cycleGeneration))
    .limit(WARMUP_CYCLES + 1);

  // The most recent row IS the current snapshot we just wrote, so the
  // historical baseline is rows 1..WARMUP_CYCLES (0-indexed).
  const baseline = prior.slice(1);
  if (baseline.length < WARMUP_CYCLES) {
    return 0;
  }

  let fired = 0;
  for (const [stageKey, current] of Object.entries(args.currentStages)) {
    const floorKey = stageKey.replace(/_(7d|30d|90d)$/, "");
    const floor =
      DELTA_ABS_FLOORS[floorKey] ?? DELTA_ABS_FLOORS[stageKey] ?? 0;
    if (floor === 0) continue;

    const prevCounts: number[] = [];
    for (const row of baseline) {
      const stages = row.stages as Record<string, StagePayload>;
      const v = stages?.[stageKey];
      if (v && typeof v.count === "number") prevCounts.push(v.count);
    }
    if (prevCounts.length < WARMUP_CYCLES) continue;
    const mean = prevCounts.reduce((a, b) => a + b, 0) / prevCounts.length;
    if (mean === 0) continue;
    const delta = current.count - mean;
    const absDelta = Math.abs(delta);
    const relDelta = absDelta / mean;
    if (relDelta < DELTA_REL_PCT) continue;
    if (absDelta < floor) continue;

    const isDrop = delta < 0;
    await db.insert(funnelAnnotationsTable).values({
      id: newId("fnlann"),
      orgId: args.orgId,
      snapshotId: args.snapshotId,
      source: "auto",
      kind: isDrop ? "stage_drop" : "stage_spike",
      targetStage: stageKey,
      summary: `${stageKey} ${isDrop ? "dropped" : "spiked"} ${(relDelta * 100).toFixed(0)}% (${current.count} vs trailing-${prevCounts.length} mean ${mean.toFixed(1)})`,
      detail: {
        stageKey,
        currentCount: current.count,
        baselineMean: mean,
        absDelta,
        relDelta,
        floor,
        baselineCounts: prevCounts,
      },
    });
    fired += 1;
  }
  return fired;
}

/**
 * Idempotent failure recorder. Increments `recurrence_count` if the
 * same (org, error_class) was already seen within FAILURE_RECURRENCE_
 * WINDOW_HOURS, otherwise inserts a fresh row.
 */
async function recordSnapshotFailure(
  inputs: CycleSnapshotInputs,
  err: unknown,
  stage: string,
): Promise<void> {
  const e = err as Error;
  const errorClass = (e?.name && e.name !== "Error" ? e.name : null)
    ?? classifyError(e?.message ?? "");
  const errorMessage = String(e?.message ?? err ?? "Unknown");
  logger.error(
    { err, orgId: inputs.orgId, cycleId: inputs.cycleId, stage },
    "Funnel snapshot capture failed (non-fatal)",
  );
  // Bump prometheus-style counter exposed on /system/metrics.
  funnelSnapshotFailuresCounter.inc(inputs.orgId, errorClass);
  try {
    const since = new Date(
      Date.now() - FAILURE_RECURRENCE_WINDOW_HOURS * 3600_000,
    );
    const [existing] = await db
      .select()
      .from(funnelSnapshotFailuresTable)
      .where(
        and(
          eq(funnelSnapshotFailuresTable.orgId, inputs.orgId),
          eq(funnelSnapshotFailuresTable.errorClass, errorClass),
          gte(funnelSnapshotFailuresTable.lastSeenAt, since),
        ),
      )
      .orderBy(desc(funnelSnapshotFailuresTable.lastSeenAt))
      .limit(1);
    if (existing) {
      await db
        .update(funnelSnapshotFailuresTable)
        .set({
          recurrenceCount: existing.recurrenceCount + 1,
          lastSeenAt: new Date(),
          errorMessage,
          context: { stage, cycleId: inputs.cycleId },
        })
        .where(eq(funnelSnapshotFailuresTable.id, existing.id));
    } else {
      await db.insert(funnelSnapshotFailuresTable).values({
        id: newId("fnlerr"),
        orgId: inputs.orgId,
        cycleId: inputs.cycleId,
        cycleGeneration: inputs.cycleGeneration,
        errorClass,
        errorMessage,
        stack: e?.stack ?? null,
        context: { stage },
      });
    }
  } catch (recordErr) {
    // If even the failure recorder fails, just log — never propagate.
    logger.error(
      { recordErr, orgId: inputs.orgId },
      "Failed to record funnel snapshot failure",
    );
  }
}

function classifyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("timeout")) return "Timeout";
  if (m.includes("oom") || m.includes("out of memory")) return "OOM";
  if (m.includes("does not exist") || m.includes("missing")) return "MissingTable";
  if (m.includes("permission") || m.includes("denied")) return "PermissionDenied";
  return "Unknown";
}

/**
 * Tiny in-memory counter exported for the system metrics route.
 * Implementations read `funnelSnapshotFailuresCounter.snapshot()`.
 */
class Counter {
  private map = new Map<string, number>();
  inc(orgId: string, errorClass: string): void {
    const key = `${orgId}::${errorClass}`;
    this.map.set(key, (this.map.get(key) ?? 0) + 1);
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.map.entries());
  }
}

export const funnelSnapshotFailuresCounter = new Counter();

// ────────────────────────────────────────────────────────────────────────
// Backfill (task #188)
// ────────────────────────────────────────────────────────────────────────

export interface BackfillReport {
  orgId: string;
  cyclesScanned: number;
  snapshotsCreated: number;
  alreadyHadSnapshot: number;
  skippedNotCompleted: number;
  failed: number;
}

function emptyBackfillReport(orgId: string): BackfillReport {
  return {
    orgId,
    cyclesScanned: 0,
    snapshotsCreated: 0,
    alreadyHadSnapshot: 0,
    skippedNotCompleted: 0,
    failed: 0,
  };
}

/**
 * Walk every completed cycle for `orgId` (in `(orgId, generation)`
 * order) and write a snapshot for each one that doesn't already have
 * one. Mirrors the recompute endpoint's path: empty pre-Act inputs
 * (signals/drafts stages 1–5 collapse to 0) but real persisted
 * opportunities and decisions for stages 6–10.
 *
 * Idempotent: cycles with an existing snapshot are skipped, so a
 * re-run after new cycles complete only fills the gap.
 *
 * The system page invokes this per-tenant or for all tenants via
 * `POST /platform/funnel/backfill`; the script
 * `scripts/src/backfill-funnel-snapshots.ts` is an offline equivalent
 * for ops use that writes a minimal snapshot directly without going
 * through the api-server (it can't import from this module).
 */
export async function backfillFunnelSnapshotsForOrg(
  orgId: string,
  opts: { ALL_LEVERS: LeverAnalyzer[] },
): Promise<BackfillReport> {
  const report = emptyBackfillReport(orgId);

  // Anti-join: fetch only cycles that don't already have a snapshot,
  // ordered by generation ASC so backfilled rows respect the same
  // monotonic ordering the live writer relies on for delta detection.
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
        isNull(funnelSnapshotsTable.id),
      ),
    )
    .orderBy(asc(analysisCyclesTable.generation));

  for (const cycle of cycles) {
    report.cyclesScanned += 1;
    if (cycle.status !== "completed") {
      report.skippedNotCompleted += 1;
      continue;
    }

    // Re-fetch persisted opportunities for this cycle. Same shape the
    // recompute endpoint uses; lever results are empty because the
    // analyzers aren't replayable post-hoc.
    const persistedOpps = await db
      .select()
      .from(opportunitiesTable)
      .where(
        and(
          eq(opportunitiesTable.orgId, orgId),
          eq(opportunitiesTable.cycleId, cycle.id),
        ),
      );

    const leverResults = opts.ALL_LEVERS.map((lever) => ({
      lever,
      result: { drafts: [], consultedSignalIds: [] } as AnalyzeResult,
    }));

    const result = await captureFunnelSnapshot({
      orgId,
      cycleId: cycle.id,
      cycleGeneration: cycle.generation,
      leverResults,
      draftsPostExclusion: [],
      persistedOpps,
      priorDeltas: [],
    });
    if (result.failed) {
      report.failed += 1;
    } else if (result.snapshotId) {
      report.snapshotsCreated += 1;
    } else {
      report.alreadyHadSnapshot += 1;
    }
  }

  return report;
}

/**
 * Backfill every tenant in deterministic id-ASC order. Used by the
 * cross-tenant POST `/platform/funnel/backfill` endpoint. Returns one
 * `BackfillReport` per tenant so the caller can render a per-tenant
 * summary table.
 */
export async function backfillFunnelSnapshotsForAllTenants(opts: {
  ALL_LEVERS: LeverAnalyzer[];
}): Promise<BackfillReport[]> {
  const orgs = await db
    .select({ id: orgsTable.id })
    .from(orgsTable)
    .orderBy(asc(orgsTable.id));
  const reports: BackfillReport[] = [];
  for (const org of orgs) {
    reports.push(await backfillFunnelSnapshotsForOrg(org.id, opts));
  }
  return reports;
}
