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
  categoriesTable,
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
  /**
   * Newly-inserted opportunities (Act step). Excludes rows whose
   * signal was matched against the partial unique index and refreshed
   * in place — those go in `refreshedOpps` so the funnel stage
   * `opps_persisted` doesn't double-count an unchanged signal as
   * "fresh persistence" each cycle (task #219 dedupe).
   */
  persistedOpps: OpportunityRow[];
  /**
   * Existing opportunity rows the Act step refreshed this cycle (same
   * `(orgId, leverId, signalKey)` as a still-live row). Captured
   * separately from `persistedOpps` so the funnel snapshot can report
   * `opps_persisted.refreshed_count` for delta-detection without
   * inflating the underlying "newly persisted" count.
   */
  refreshedOpps?: OpportunityRow[];
  /** Prior deltas the Learn step applied this cycle. */
  priorDeltas: PriorDelta[];
  /**
   * Provenance discriminator. Defaults to `live` for normal cycle
   * runner captures. Set to `backfill` by the historical reconstruction
   * paths so the row is badged in the admin UI and excluded from
   * trailing-baseline delta detection (its zeroed stages 1–5 would
   * otherwise drag the baseline down).
   */
  source?: "live" | "backfill";
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
  /**
   * Number of existing opportunity rows the Act step refreshed in
   * place this cycle (task #219 dedupe). Surfaced on `opps_persisted`
   * so a hot tenant where the same signals re-fire each cycle no
   * longer looks like a brand-new burst of work in the funnel
   * timeline. Does NOT contribute to `count`.
   */
  refreshed_count?: number;
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
    // Independent DB-bound stages run concurrently — none of them
    // depend on each other's results, so issuing them serially just
    // burns wall-clock on round-trips. Each promise tags the failing
    // stage on its error so recordSnapshotFailure still sees which
    // query blew up.
    stage = "parallel_db_queries";
    const [signalsStages, cohortStages, calibration] = await Promise.all([
      captureSignalsStages(inputs).catch((err: unknown) => {
        tagStage(err, "signals");
        throw err;
      }),
      captureCohortStages(inputs).catch((err: unknown) => {
        tagStage(err, "cohorts");
        throw err;
      }),
      computeCalibration(inputs.orgId).catch((err: unknown) => {
        tagStage(err, "calibration");
        throw err;
      }),
    ]);
    stage = "drafts";
    const draftsStages = captureDraftsStages(inputs);
    stage = "persisted";
    const persistedStage = capturePersistedStage(inputs);
    stage = "priors";
    const priorsStage = capturePriorsStage(inputs);
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
      source: inputs.source ?? "live",
    });

    // Delta detection runs AFTER the snapshot persists so the snapshot
    // row id is stable for annotation FK. Errors here are logged but
    // don't fail the snapshot — annotations are nice-to-have lineage.
    // Backfilled snapshots are skipped entirely: their stages 1–5 are
    // zeroed by construction, so any "delta" against the live baseline
    // is an artifact of reconstruction, not a real behavioural change.
    try {
      stage = "deltas";
      const fired =
        (inputs.source ?? "live") === "backfill"
          ? 0
          : await detectAndAnnotateDeltas({
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
    const taggedStage = readStageTag(err) ?? stage;
    await recordSnapshotFailure(inputs, err, taggedStage);
    return { snapshotId: null, failed: true };
  }
}

/** Stage-tag plumbing for the parallel-query block above. */
const STAGE_TAG = Symbol.for("funnel.snapshot.stage");
function tagStage(err: unknown, stage: string): void {
  if (err && typeof err === "object") {
    (err as Record<symbol, string>)[STAGE_TAG] = stage;
  }
}
function readStageTag(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    return (err as Record<symbol, string>)[STAGE_TAG];
  }
  return undefined;
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
  const refreshedCount = inputs.refreshedOpps?.length ?? 0;
  return {
    opps_persisted: {
      count: inputs.persistedOpps.length,
      capped,
      by_lever: byLever,
      total_projected_usd: Math.round(totalProjected * 100) / 100,
      sample_ids: inputs.persistedOpps
        .slice(0, STAGE_SAMPLE_CAPS.opps_persisted)
        .map((o) => o.id),
      ...(refreshedCount > 0 ? { refreshed_count: refreshedCount } : {}),
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
  const now = new Date();
  // Each cohort window is an independent join — fan them out concurrently
  // so the snapshot's cohort cost is bound by the slowest window, not the
  // sum of all three.
  const perWindow = await Promise.all(
    COHORT_WINDOWS.map(async (window) => {
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
      return { window, byEvent };
    }),
  );

  // Re-assemble in the original COHORT_WINDOWS order so the resulting
  // map's key order matches the pre-parallel implementation.
  const out: Record<string, StagePayload> = {};
  for (const { window, byEvent } of perWindow) {
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
 * Sentinel categoryCode used for the per-lever rollup that aggregates
 * realized opportunities across all categories (and includes legacy /
 * supplier-scoped opportunities without a `categoryId`). Picking a
 * leading underscore keeps it lex-sorted ahead of any canonical code
 * and is unambiguously not a real procurement code.
 */
export const CALIBRATION_ROLLUP_CATEGORY = "_all" as const;

/**
 * Calibration entry surfaced on `funnel_snapshots.calibration`.
 *
 * Keys take the form `<leverId>:<categoryCode>:<window>` where
 * `categoryCode` is either a canonical procurement code or
 * `CALIBRATION_ROLLUP_CATEGORY` ('_all') for the per-lever rollup that
 * preserves the legacy per-lever surface (task #218).
 */
export interface CalibrationEntry {
  leverId: string;
  /** Canonical category code OR `_all` for the per-lever rollup. */
  categoryCode: string;
  window: "30d" | "90d";
  n: number;
  rawMedianAbsErrorUsd: number;
  rescaledMedianAbsErrorUsd: number;
  improvementUsd: number;
  verdict: "helping" | "hurting" | "neutral" | "insufficient_evidence";
}

/**
 * Median absolute error of (projected - realized) USD per (lever,
 * category) bucket, both raw (without prior) and with the current
 * prior multiplier applied, over the trailing 30d/90d realized cohort.
 * Verdict gates on n ≥ 10 and a $100 swing in the buyer's favor — same
 * thresholds as the original per-lever calibration.
 *
 * Per task #218, results are bucketed by both `leverId` and the
 * canonical `categoryCode` resolved via `opportunities.categoryId →
 * categories.code`. Opportunities without a category (legacy or
 * supplier-scoped) contribute only to the `<leverId>:_all` rollup,
 * which is also emitted unconditionally so existing per-lever displays
 * stay backward-compatible. Output keys take the form
 * `<leverId>:<categoryCode>:<window>` with `_all` as the rollup
 * sentinel.
 */
async function computeCalibration(
  orgId: string,
): Promise<Record<string, unknown>> {
  const windows = ["30d", "90d"] as const;
  // The two calibration windows are independent joins — fan them out in
  // parallel so the slower one bounds the cost rather than their sum.
  const perWindow = await Promise.all(
    windows.map(async (window) => {
      const days = parseInt(window, 10);
      const since = new Date(Date.now() - days * 86400_000);
      const rows = await db
        .select({
          leverId: opportunitiesTable.leverId,
          rawProjected: opportunitiesTable.rawProjectedSavingsUsd,
          projected: opportunitiesTable.projectedSavingsUsd,
          realized: decisionsTable.realizedSavingsUsd,
          // LEFT JOIN so opportunities without a categoryId still
          // contribute to the per-lever `_all` rollup. categoryCode is
          // null in that case and we route the sample to `_all` only.
          categoryCode: categoriesTable.code,
        })
        .from(decisionsTable)
        .innerJoin(
          opportunitiesTable,
          eq(decisionsTable.opportunityId, opportunitiesTable.id),
        )
        .leftJoin(
          categoriesTable,
          eq(opportunitiesTable.categoryId, categoriesTable.id),
        )
        .where(
          and(
            eq(opportunitiesTable.orgId, orgId),
            eq(decisionsTable.eventType, "realize"),
            gte(decisionsTable.createdAt, since),
            // Calibration integrity (task #213/218): exclude
            // opportunities routed via the Layer-B fallback.
            // `unmapped_default` rows are scope-mismatched by
            // construction (Fragmented band catch-all), so including
            // them in either the per-lever rollup or the per-(lever,
            // category) bucket would contaminate the priors.
            // `IS DISTINCT FROM` also keeps legacy NULL-mapped_via
            // rows in the calibration sample so the historical
            // baseline is preserved.
            sql`${opportunitiesTable.mappedVia} IS DISTINCT FROM 'unmapped_default'`,
          ),
        );

      type Sample = { raw: number; rescaled: number; realized: number };
      const allByLever = new Map<string, Sample[]>();
      // Keyed by `<leverId>\u0000<categoryCode>` so we don't have to
      // worry about colons in canonical codes.
      const byLeverCat = new Map<string, Sample[]>();
      for (const r of rows) {
        if (r.realized == null) continue;
        const realized = Number(r.realized);
        const raw = Number(r.rawProjected);
        const rescaled = Number(r.projected);
        if (!isFinite(realized) || !isFinite(raw) || !isFinite(rescaled)) {
          continue;
        }
        const sample: Sample = { raw, rescaled, realized };
        // Always feed the per-lever rollup — that's the backward-compat
        // surface previous per-lever-only consumers depend on.
        const allArr = allByLever.get(r.leverId) ?? [];
        allArr.push(sample);
        allByLever.set(r.leverId, allArr);
        // Per-(lever, category) bucket only when the opportunity has a
        // category. Supplier-scoped / legacy rows roll up under `_all`.
        if (r.categoryCode) {
          const k = `${r.leverId}\u0000${r.categoryCode}`;
          const arr = byLeverCat.get(k) ?? [];
          arr.push(sample);
          byLeverCat.set(k, arr);
        }
      }
      return { window, allByLever, byLeverCat };
    }),
  );

  function classify(samples: Array<{ raw: number; rescaled: number; realized: number }>): {
    n: number;
    rawMedian: number;
    rescaledMedian: number;
    improvementUsd: number;
    verdict: CalibrationEntry["verdict"];
  } {
    const rawErrs = samples
      .map((s) => Math.abs(s.raw - s.realized))
      .sort((a, b) => a - b);
    const rescaledErrs = samples
      .map((s) => Math.abs(s.rescaled - s.realized))
      .sort((a, b) => a - b);
    const rawMedian = median(rawErrs);
    const rescaledMedian = median(rescaledErrs);
    const improvementUsd = rawMedian - rescaledMedian;
    let verdict: CalibrationEntry["verdict"] = "neutral";
    if (samples.length < CALIBRATION_MIN_N) {
      verdict = "insufficient_evidence";
    } else if (improvementUsd > CALIBRATION_HELP_USD) {
      verdict = "helping";
    } else if (improvementUsd < -CALIBRATION_HELP_USD) {
      verdict = "hurting";
    }
    return {
      n: samples.length,
      rawMedian,
      rescaledMedian,
      improvementUsd,
      verdict,
    };
  }

  // Re-assemble in the original window order so 30d entries appear
  // before 90d when iterating `Object.entries`. Within a window we
  // emit the per-lever rollup first (lever ASC) followed by the
  // per-(lever, category) buckets (lever ASC, category ASC) so the
  // payload is deterministic and easy to diff between snapshots.
  const out: Record<string, unknown> = {};
  for (const { window, allByLever, byLeverCat } of perWindow) {
    const sortedLevers = Array.from(allByLever.keys()).sort();
    for (const leverId of sortedLevers) {
      const samples = allByLever.get(leverId)!;
      const c = classify(samples);
      const key = `${leverId}:${CALIBRATION_ROLLUP_CATEGORY}:${window}`;
      out[key] = {
        leverId,
        categoryCode: CALIBRATION_ROLLUP_CATEGORY,
        window,
        n: c.n,
        rawMedianAbsErrorUsd: round2(c.rawMedian),
        rescaledMedianAbsErrorUsd: round2(c.rescaledMedian),
        improvementUsd: round2(c.improvementUsd),
        verdict: c.verdict,
      } satisfies CalibrationEntry;
    }
    const sortedCatKeys = Array.from(byLeverCat.keys()).sort();
    for (const k of sortedCatKeys) {
      const idx = k.indexOf("\u0000");
      const leverId = k.slice(0, idx);
      const categoryCode = k.slice(idx + 1);
      const samples = byLeverCat.get(k)!;
      const c = classify(samples);
      const key = `${leverId}:${categoryCode}:${window}`;
      out[key] = {
        leverId,
        categoryCode,
        window,
        n: c.n,
        rawMedianAbsErrorUsd: round2(c.rawMedian),
        rescaledMedianAbsErrorUsd: round2(c.rescaledMedian),
        improvementUsd: round2(c.improvementUsd),
        verdict: c.verdict,
      } satisfies CalibrationEntry;
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
  // Backfilled snapshots zero stages 1–5 because the analyzer outputs
  // aren't reconstructible from persisted state. Including them in the
  // trailing baseline would drag the mean toward zero and either fire
  // spurious "stage spiked" annotations on the next live cycle or mask
  // a real drop. Skip them at the SQL layer so the baseline is built
  // exclusively from live snapshots.
  const prior = await db
    .select({
      stages: funnelSnapshotsTable.stages,
      cycleGeneration: funnelSnapshotsTable.cycleGeneration,
      source: funnelSnapshotsTable.source,
    })
    .from(funnelSnapshotsTable)
    .where(
      and(
        eq(funnelSnapshotsTable.orgId, args.orgId),
        eq(funnelSnapshotsTable.source, "live"),
      ),
    )
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
      source: "backfill",
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

// ────────────────────────────────────────────────────────────────────────
// Today-feed readers (task #204)
//
// Thin per-tenant queries that surface substrate state on the operator's
// landing page. Both readers are read-only, return plain JSON-friendly
// shapes, and never throw on "no data" — the Today aggregator wraps each
// in its `safe()` helper so a reader-level exception still degrades the
// feed to `partial=true` rather than failing the response.
// ────────────────────────────────────────────────────────────────────────

export interface RecentAutoAnnotation {
  id: string;
  snapshotId: string;
  cycleGeneration: number;
  kind: string;
  targetStage: string | null;
  targetLeverId: string | null;
  summary: string;
  createdAt: string;
  ackedAt: string | null;
}

/**
 * Most-recent auto annotations for a tenant, ordered newest first.
 * Joined to `funnel_snapshots` so the Today card can show "what cycle
 * fired this" alongside the human summary. Capped at `limit` (default
 * 10) so a noisy detector can't blow up the feed payload.
 *
 * Operator annotations are excluded — the daily flow card is for
 * substrate-emitted "what changed since yesterday" deltas, not free-form
 * notes (which live on the engine page where the operator wrote them).
 */
export async function getRecentAutoAnnotations(
  orgId: string,
  opts: { limit?: number; includeAcked?: boolean } = {},
): Promise<RecentAutoAnnotation[]> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  // Default behaviour (#210): hide acked annotations from the Today
  // card so the noise level stays manageable as cycles accumulate. The
  // `includeAcked` escape hatch is preserved for admin views that
  // still want the full history.
  const includeAcked = opts.includeAcked ?? false;
  const filters = [
    eq(funnelAnnotationsTable.orgId, orgId),
    eq(funnelAnnotationsTable.source, "auto"),
  ];
  if (!includeAcked) {
    filters.push(isNull(funnelAnnotationsTable.ackedAt));
  }
  const rows = await db
    .select({
      id: funnelAnnotationsTable.id,
      snapshotId: funnelAnnotationsTable.snapshotId,
      kind: funnelAnnotationsTable.kind,
      targetStage: funnelAnnotationsTable.targetStage,
      targetLeverId: funnelAnnotationsTable.targetLeverId,
      summary: funnelAnnotationsTable.summary,
      createdAt: funnelAnnotationsTable.createdAt,
      ackedAt: funnelAnnotationsTable.ackedAt,
      cycleGeneration: funnelSnapshotsTable.cycleGeneration,
    })
    .from(funnelAnnotationsTable)
    .innerJoin(
      funnelSnapshotsTable,
      and(
        eq(funnelAnnotationsTable.snapshotId, funnelSnapshotsTable.id),
        // Defense-in-depth: require the joined snapshot to belong to the
        // same org. Annotations already carry org_id, but this prevents
        // any cross-tenant leak if a row's org_id were ever wrong.
        eq(funnelSnapshotsTable.orgId, orgId),
      ),
    )
    .where(and(...filters))
    .orderBy(desc(funnelAnnotationsTable.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    snapshotId: r.snapshotId,
    cycleGeneration: r.cycleGeneration,
    kind: r.kind,
    targetStage: r.targetStage,
    targetLeverId: r.targetLeverId,
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
    ackedAt: r.ackedAt ? r.ackedAt.toISOString() : null,
  }));
}

/** Conversion-rate transitions we surface on the Today delta card. */
const CONVERSION_TRANSITIONS: Array<[string, string, string]> = [
  ["drafts→post_exclusion", "drafts_produced", "drafts_post_exclusion"],
  ["post_exclusion→persisted", "drafts_post_exclusion", "opps_persisted"],
  ["persisted→approved_30d", "opps_persisted", "opps_approved_30d"],
  ["approved_30d→realized_30d", "opps_approved_30d", "opps_realized_30d"],
];

/**
 * Minimum denominator (in either cycle) required to call a
 * conversion-rate delta "meaningful". Below this we treat the
 * transition as noisy: a single +/- pp swing on a tiny sample is
 * within normal cycle-to-cycle variance and shouldn't compete with
 * real shifts for the operator's attention.
 *
 * 30 matches the rule-of-thumb sample size where binomial proportion
 * variance starts looking roughly normal — small enough to not gate
 * out healthy mid-volume tenants, large enough that a ±X pp move
 * isn't dominated by a single decision flipping the count.
 */
export const MIN_SIGNIFICANT_DENOMINATOR = 30;

export interface ConversionRateDelta {
  transition: string;
  numeratorStage: string;
  denominatorStage: string;
  /** Rate as a 0..1 fraction. `null` when the denominator was 0. */
  prevRate: number | null;
  currentRate: number | null;
  /**
   * `currentRate - prevRate`. `null` when either side is `null`. Negative
   * means the funnel got worse this cycle, positive means it improved.
   */
  delta: number | null;
  /** Denominator-stage `count` from the current cycle's snapshot. */
  currentDenominator: number;
  /** Denominator-stage `count` from the previous cycle's snapshot. */
  prevDenominator: number;
  /**
   * Whether this rate change is large enough vs sample size to be
   * actionable (#211).
   *
   *   - `insufficient` — at least one cycle's denominator was 0 (no
   *     rate to compare against; the UI surfaces this as "no signal"
   *     rather than as a real change). Also used when the comparison
   *     baseline is missing entirely (only one snapshot exists).
   *   - `noisy` — both rates are computable but the smaller of the
   *     two denominators is below `MIN_SIGNIFICANT_DENOMINATOR`, so
   *     a single +/- pp swing is within normal variance.
   *   - `meaningful` — both denominators meet the floor, so the
   *     delta reflects a real cohort-level shift the operator can
   *     act on.
   */
  significance: "meaningful" | "noisy" | "insufficient";
}

export interface ConversionRateDeltasResult {
  /** ISO timestamp of the most recent snapshot's cycle (or null if none). */
  currentCycleAt: string | null;
  currentCycleGeneration: number | null;
  prevCycleAt: string | null;
  prevCycleGeneration: number | null;
  /** Sorted by absolute delta descending; transitions with no delta come last. */
  transitions: ConversionRateDelta[];
}

/**
 * Per-cycle conversion-rate deltas between the two most recent funnel
 * snapshots for a tenant. Powers the Today "what changed since last
 * cycle" card.
 *
 * Returns an empty `transitions` array when the tenant has fewer than
 * two snapshots — the UI renders an "insufficient history" hint rather
 * than treating the empty case as a hard error. Transitions where the
 * denominator was 0 in either cycle surface as `null` rates so the UI
 * can distinguish "no change" from "no signal."
 */
export async function getCycleConversionRateDeltas(
  orgId: string,
): Promise<ConversionRateDeltasResult> {
  const rows = await db
    .select({
      stages: funnelSnapshotsTable.stages,
      cycleGeneration: funnelSnapshotsTable.cycleGeneration,
      createdAt: funnelSnapshotsTable.createdAt,
    })
    .from(funnelSnapshotsTable)
    .where(eq(funnelSnapshotsTable.orgId, orgId))
    .orderBy(desc(funnelSnapshotsTable.cycleGeneration))
    .limit(2);

  const empty: ConversionRateDeltasResult = {
    currentCycleAt: null,
    currentCycleGeneration: null,
    prevCycleAt: null,
    prevCycleGeneration: null,
    transitions: [],
  };
  if (rows.length === 0) return empty;
  const current = rows[0]!;
  const prev = rows[1] ?? null;

  if (!prev) {
    return {
      currentCycleAt: current.createdAt.toISOString(),
      currentCycleGeneration: current.cycleGeneration,
      prevCycleAt: null,
      prevCycleGeneration: null,
      transitions: [],
    };
  }

  const countOf = (
    stages: Record<string, unknown>,
    key: string,
  ): number => {
    const v = Number(
      (stages?.[key] as { count?: number } | undefined)?.count ?? 0,
    );
    return isFinite(v) ? v : 0;
  };
  const rateOf = (num: number, den: number): number | null => {
    if (den === 0) return null;
    return num / den;
  };

  const transitions: ConversionRateDelta[] = CONVERSION_TRANSITIONS.map(
    ([name, denStage, numStage]) => {
      const currStages = current.stages as Record<string, unknown>;
      const prevStages = prev.stages as Record<string, unknown>;
      const currDen = countOf(currStages, denStage);
      const prevDen = countOf(prevStages, denStage);
      const currRate = rateOf(countOf(currStages, numStage), currDen);
      const prevRate = rateOf(countOf(prevStages, numStage), prevDen);
      const delta =
        currRate === null || prevRate === null ? null : currRate - prevRate;
      let significance: ConversionRateDelta["significance"];
      if (delta === null) {
        // Either cycle had a 0 denominator → no rate to compare. The UI
        // shows this as "no signal" rather than as a real change.
        significance = "insufficient";
      } else if (Math.min(currDen, prevDen) < MIN_SIGNIFICANT_DENOMINATOR) {
        // Both rates exist but the smaller sample is too small to trust
        // — a +/- pp swing here is within normal cycle variance.
        significance = "noisy";
      } else {
        significance = "meaningful";
      }
      return {
        transition: name,
        numeratorStage: numStage,
        denominatorStage: denStage,
        prevRate: prevRate === null ? null : round4(prevRate),
        currentRate: currRate === null ? null : round4(currRate),
        delta: delta === null ? null : round4(delta),
        currentDenominator: currDen,
        prevDenominator: prevDen,
        significance,
      };
    },
  );

  // Largest absolute movement first; null deltas sink to the bottom so
  // the operator sees real changes before "no signal" rows.
  transitions.sort((a, b) => {
    const aHas = a.delta !== null;
    const bHas = b.delta !== null;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    if (!aHas && !bHas) return 0;
    return Math.abs(b.delta!) - Math.abs(a.delta!);
  });

  return {
    currentCycleAt: current.createdAt.toISOString(),
    currentCycleGeneration: current.cycleGeneration,
    prevCycleAt: prev.createdAt.toISOString(),
    prevCycleGeneration: prev.cycleGeneration,
    transitions,
  };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
