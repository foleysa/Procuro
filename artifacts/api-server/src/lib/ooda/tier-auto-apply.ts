/**
 * Auto-update of per-(category, lever) prior strengths from the
 * snapshot tier matrix (task #229).
 *
 * Wires `suggestTierForCategoryLever` into the OODA cycle:
 *
 *   - Decide-time: load the persisted scale overrides for the org and
 *     layer them on top of the per-lever `learnedPriors` when scoring
 *     drafts. A draft whose (categoryCode, leverId) matches a Tier C/D
 *     override gets its projected savings *and* confidence weight
 *     suppressed; Tier A/B leave the prior at face value.
 *
 *   - Post-snapshot: for every distinct (categoryCode, leverId) the
 *     cycle just touched, fetch the tier suggestion from the latest
 *     snapshot's calibration block and feed it into a small hysteresis
 *     state machine in `category_lever_prior_scales`. A change in
 *     applied tier requires `STABILITY_OBS_REQUIRED` consecutive
 *     cycles of agreement, so a single anomalous cycle cannot flip a
 *     previously-stable tier. When a change *does* take effect we
 *     write a `calibration_change` annotation on the snapshot so the
 *     funnel UI can badge the promotion/demotion alongside the
 *     existing stage-drop / stage-spike feed.
 *
 * Mode toggle: a single `app_settings` row (`tier_auto_apply`)
 * controls whether the post-snapshot processing is allowed to mutate
 * the override table. In `advisory` mode (default) the helper still
 * reads the suggestions but does not change anything; only the read
 * surfaces (admin tier matrix UI) reflect them. In `auto` mode the
 * hysteresis machine runs and annotations are written.
 */
import {
  db,
  appSettingsTable,
  APP_SETTING_KEY_TIER_AUTO_APPLY,
  categoryLeverPriorScalesTable,
  funnelAnnotationsTable,
  type CategoryLeverPriorScaleRow,
  type LeverId,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";
import {
  suggestTierForCategoryLever,
  type TierSuggestion,
} from "../intelligence/routing";

export type TierAutoApplyMode = "advisory" | "auto";

/** Default mode when no operator override exists in `app_settings`. */
export const DEFAULT_TIER_AUTO_APPLY_MODE: TierAutoApplyMode = "advisory";

/**
 * How many consecutive cycles a new tier suggestion must persist
 * before the override table flips `appliedTier`. Two is the smallest
 * value that still rejects single-cycle anomalies — exactly the
 * "no flip-flopping on a single bad cycle" requirement.
 */
export const STABILITY_OBS_REQUIRED = 2;

/**
 * Per-tier projection / confidence multipliers layered onto the
 * per-lever `learnedPriors` row. Tier C/D suppresses both metrics
 * (low projection × low confidence makes Tier C/D drafts uncompetitive
 * against Tier A/B siblings in the rank); Tier A is left at parity
 * with the existing per-lever prior so the new behaviour is *strictly*
 * a downside guard rather than a hidden boost. Tier B and
 * insufficient_data are no-ops.
 */
const TIER_SCALE: Record<
  Exclude<TierSuggestion, "insufficient_data"> | "tier_b",
  { projection: number; confidence: number }
> = {
  tier_a: { projection: 1.0, confidence: 1.0 },
  tier_b: { projection: 1.0, confidence: 1.0 },
  tier_c_or_d: { projection: 0.5, confidence: 0.6 },
};

export function tierToScale(tier: TierSuggestion): {
  projection: number;
  confidence: number;
} {
  if (tier === "insufficient_data") return { projection: 1.0, confidence: 1.0 };
  return TIER_SCALE[tier];
}

// ────────────────────────────────────────────────────────────────────
// Mode toggle (app_settings)
// ────────────────────────────────────────────────────────────────────

export interface TierAutoApplySettings {
  mode: TierAutoApplyMode;
  isOverride: boolean;
  lastChangedAt: Date | null;
  lastChangedBy: string | null;
}

function isMode(v: unknown): v is TierAutoApplyMode {
  return v === "advisory" || v === "auto";
}

export async function getTierAutoApplySettings(): Promise<TierAutoApplySettings> {
  const [row] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, APP_SETTING_KEY_TIER_AUTO_APPLY));
  const stored = (row?.value as { mode?: unknown } | undefined)?.mode;
  if (!row || !isMode(stored)) {
    if (row) {
      logger.warn(
        { stored: row.value },
        "Stored tier_auto_apply is invalid; falling back to advisory",
      );
    }
    return {
      mode: DEFAULT_TIER_AUTO_APPLY_MODE,
      isOverride: false,
      lastChangedAt: null,
      lastChangedBy: null,
    };
  }
  return {
    mode: stored,
    isOverride: true,
    lastChangedAt: row.lastChangedAt ?? row.updatedAt ?? null,
    lastChangedBy: row.lastChangedBy ?? null,
  };
}

export async function setTierAutoApplyMode(args: {
  mode: TierAutoApplyMode;
  actorEmail: string | null;
}): Promise<TierAutoApplySettings> {
  if (!isMode(args.mode)) {
    throw new Error(`mode must be one of "advisory" | "auto"`);
  }
  const now = new Date();
  await db
    .insert(appSettingsTable)
    .values({
      key: APP_SETTING_KEY_TIER_AUTO_APPLY,
      value: { mode: args.mode },
      lastChangedAt: now,
      lastChangedBy: args.actorEmail,
    })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: {
        value: { mode: args.mode },
        lastChangedAt: now,
        lastChangedBy: args.actorEmail,
      },
    });
  logger.info(
    { mode: args.mode, actor: args.actorEmail },
    "Updated tier_auto_apply",
  );
  return getTierAutoApplySettings();
}

// ────────────────────────────────────────────────────────────────────
// Decide-time scale lookup
// ────────────────────────────────────────────────────────────────────

export type CategoryLeverScaleMap = Map<
  string,
  { projection: number; confidence: number; tier: string }
>;

function key(categoryCode: string, leverId: string): string {
  return `${categoryCode}\u0000${leverId}`;
}

export function makeScaleMapKey(
  categoryCode: string,
  leverId: string,
): string {
  return key(categoryCode, leverId);
}

/**
 * Load every applied scale override for an org. Returned as a Map
 * keyed by `${categoryCode}\u0000${leverId}` — callers use
 * `makeScaleMapKey` to avoid hand-rolling the separator.
 *
 * The scale stored in the row IS the value to multiply by; we read
 * it as-is rather than re-deriving from `appliedTier` so a future
 * tweak to `TIER_SCALE` only takes effect after the hysteresis
 * machine sees a fresh cycle (no silent retroactive rescale).
 */
export async function loadCategoryLeverScales(
  orgId: string,
): Promise<CategoryLeverScaleMap> {
  const rows = await db
    .select({
      categoryCode: categoryLeverPriorScalesTable.categoryCode,
      leverId: categoryLeverPriorScalesTable.leverId,
      appliedTier: categoryLeverPriorScalesTable.appliedTier,
      appliedScaleProjection:
        categoryLeverPriorScalesTable.appliedScaleProjection,
      appliedScaleConfidence:
        categoryLeverPriorScalesTable.appliedScaleConfidence,
    })
    .from(categoryLeverPriorScalesTable)
    .where(eq(categoryLeverPriorScalesTable.orgId, orgId));
  const out: CategoryLeverScaleMap = new Map();
  for (const r of rows) {
    out.set(key(r.categoryCode, r.leverId), {
      projection: Number(r.appliedScaleProjection),
      confidence: Number(r.appliedScaleConfidence),
      tier: r.appliedTier,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Post-snapshot processing — hysteresis + annotations
// ────────────────────────────────────────────────────────────────────

export interface ProcessTierUpdatesResult {
  /** (cat, lever) pairs whose `appliedTier` flipped this cycle. */
  changes: Array<{
    categoryCode: string;
    leverId: string;
    fromTier: string;
    toTier: TierSuggestion;
    annotationId: string | null;
  }>;
  /** Pairs whose pending counter advanced but did not yet flip. */
  pendingAdvances: number;
  /** Pairs that matched their applied tier and reset pending state. */
  reaffirmations: number;
  /** Pairs skipped because the suggestion was insufficient_data. */
  skippedInsufficient: number;
  /** Total (cat, lever) pairs processed. */
  processed: number;
}

/**
 * For each distinct (categoryCode, leverId) the cycle touched, fetch
 * the latest snapshot's tier suggestion and advance the hysteresis
 * state machine. When `appliedTier` flips, write a
 * `calibration_change` funnel annotation against `snapshotId` so the
 * admin UI can badge promotions/demotions in the existing feed.
 *
 * No-op when:
 *   - mode is `advisory` (handled by the caller — this function does
 *     not re-read the toggle so the caller can short-circuit early)
 *   - `snapshotId` is null (the cycle's snapshot capture failed)
 *   - the (cat, lever) suggestion comes back `insufficient_data`
 *     AND no override row exists yet (nothing to track)
 *
 * Returns a structured summary so the cycle runner can log it.
 */
export async function processTierUpdates(args: {
  orgId: string;
  cycleGeneration: number;
  snapshotId: string;
  pairs: Array<{ categoryCode: string; leverId: LeverId }>;
}): Promise<ProcessTierUpdatesResult> {
  const result: ProcessTierUpdatesResult = {
    changes: [],
    pendingAdvances: 0,
    reaffirmations: 0,
    skippedInsufficient: 0,
    processed: 0,
  };
  if (args.pairs.length === 0) return result;

  // Dedupe pairs (cycles often emit many drafts for the same
  // (cat, lever)).
  const dedup = new Map<string, { categoryCode: string; leverId: LeverId }>();
  for (const p of args.pairs) {
    dedup.set(key(p.categoryCode, p.leverId), p);
  }
  const pairs = Array.from(dedup.values());
  result.processed = pairs.length;

  // Bulk-load existing rows for these pairs so we don't issue one
  // SELECT per pair.
  const codes = Array.from(new Set(pairs.map((p) => p.categoryCode)));
  const levers = Array.from(new Set(pairs.map((p) => p.leverId as string)));
  const existingRows: CategoryLeverPriorScaleRow[] =
    codes.length > 0 && levers.length > 0
      ? await db
          .select()
          .from(categoryLeverPriorScalesTable)
          .where(
            and(
              eq(categoryLeverPriorScalesTable.orgId, args.orgId),
              inArray(categoryLeverPriorScalesTable.categoryCode, codes),
              inArray(categoryLeverPriorScalesTable.leverId, levers),
            ),
          )
      : [];
  const existing = new Map<string, CategoryLeverPriorScaleRow>();
  for (const r of existingRows) {
    existing.set(key(r.categoryCode, r.leverId), r);
  }

  for (const p of pairs) {
    const sugg = await suggestTierForCategoryLever({
      orgId: args.orgId,
      categoryCode: p.categoryCode,
      leverId: p.leverId,
    });
    const row = existing.get(key(p.categoryCode, p.leverId));

    // Insufficient data: don't materialize a new row, but if an
    // existing row is mid-pending we leave its pending state alone
    // (treat as no signal — neither confirmation nor contradiction)
    // so a transient gap in n doesn't reset learning.
    if (sugg.tier === "insufficient_data") {
      result.skippedInsufficient += 1;
      continue;
    }

    // Bootstrap path — first time we see a usable signal for this
    // (cat, lever). Persist immediately at the suggested tier so
    // tier_b stays a no-op and tier_a/c_d take effect on the next
    // cycle. No annotation: there's no prior tier to compare
    // against, so nothing meaningful changed.
    if (!row) {
      const scale = tierToScale(sugg.tier);
      await db.insert(categoryLeverPriorScalesTable).values({
        id: newId("clps"),
        orgId: args.orgId,
        categoryCode: p.categoryCode,
        leverId: p.leverId,
        appliedTier: sugg.tier,
        appliedScaleProjection: scale.projection.toFixed(4),
        appliedScaleConfidence: scale.confidence.toFixed(4),
        appliedAtCycle: args.cycleGeneration,
        pendingTier: null,
        pendingObservations: 0,
        pendingSinceCycle: null,
      });
      // Bootstrap is reported as a "change from none" so observers
      // can still see *something* happened. We tag fromTier as the
      // sentinel `none` to distinguish from a tier→tier flip.
      const annId = newId("fnlann");
      await db.insert(funnelAnnotationsTable).values({
        id: annId,
        orgId: args.orgId,
        snapshotId: args.snapshotId,
        source: "auto",
        kind: "calibration_change",
        targetLeverId: p.leverId,
        summary: `Tier auto-apply bootstrapped ${p.categoryCode} × ${p.leverId} at ${sugg.tier}`,
        detail: {
          categoryCode: p.categoryCode,
          leverId: p.leverId,
          fromTier: "none",
          toTier: sugg.tier,
          improvementUsd: sugg.improvementUsd,
          n: sugg.n,
          window: sugg.window,
          fellBackToLeverRollup: sugg.fellBackToLeverRollup,
          stabilityObsRequired: STABILITY_OBS_REQUIRED,
          bootstrap: true,
        },
      });
      result.changes.push({
        categoryCode: p.categoryCode,
        leverId: p.leverId,
        fromTier: "none",
        toTier: sugg.tier,
        annotationId: annId,
      });
      continue;
    }

    // Existing row — three branches:
    //   (a) suggestion matches appliedTier → reaffirm, clear pending
    //   (b) suggestion matches pendingTier → bump observations,
    //       maybe flip
    //   (c) suggestion is a *new* candidate → reset pending to it
    if (sugg.tier === row.appliedTier) {
      if (row.pendingTier !== null || row.pendingObservations !== 0) {
        await db
          .update(categoryLeverPriorScalesTable)
          .set({
            pendingTier: null,
            pendingObservations: 0,
            pendingSinceCycle: null,
          })
          .where(eq(categoryLeverPriorScalesTable.id, row.id));
      }
      result.reaffirmations += 1;
      continue;
    }

    if (sugg.tier === row.pendingTier) {
      const nextObs = row.pendingObservations + 1;
      if (nextObs >= STABILITY_OBS_REQUIRED) {
        // Flip — apply the change and emit annotation.
        const scale = tierToScale(sugg.tier);
        await db
          .update(categoryLeverPriorScalesTable)
          .set({
            appliedTier: sugg.tier,
            appliedScaleProjection: scale.projection.toFixed(4),
            appliedScaleConfidence: scale.confidence.toFixed(4),
            appliedAtCycle: args.cycleGeneration,
            pendingTier: null,
            pendingObservations: 0,
            pendingSinceCycle: null,
          })
          .where(eq(categoryLeverPriorScalesTable.id, row.id));
        const annId = newId("fnlann");
        const verb = tierRank(sugg.tier) > tierRank(row.appliedTier)
          ? "promoted"
          : "demoted";
        await db.insert(funnelAnnotationsTable).values({
          id: annId,
          orgId: args.orgId,
          snapshotId: args.snapshotId,
          source: "auto",
          kind: "calibration_change",
          targetLeverId: p.leverId,
          summary: `Tier auto-apply ${verb} ${p.categoryCode} × ${p.leverId}: ${row.appliedTier} → ${sugg.tier} (stable for ${nextObs} cycles)`,
          detail: {
            categoryCode: p.categoryCode,
            leverId: p.leverId,
            fromTier: row.appliedTier,
            toTier: sugg.tier,
            improvementUsd: sugg.improvementUsd,
            n: sugg.n,
            window: sugg.window,
            fellBackToLeverRollup: sugg.fellBackToLeverRollup,
            stabilityObsRequired: STABILITY_OBS_REQUIRED,
            stableCycles: nextObs,
            scale,
          },
        });
        result.changes.push({
          categoryCode: p.categoryCode,
          leverId: p.leverId,
          fromTier: row.appliedTier,
          toTier: sugg.tier,
          annotationId: annId,
        });
      } else {
        // Still building stability — bump observations only. No
        // annotation; the funnel feed shouldn't get spammed by
        // every "pending advanced" tick.
        await db
          .update(categoryLeverPriorScalesTable)
          .set({ pendingObservations: nextObs })
          .where(eq(categoryLeverPriorScalesTable.id, row.id));
        result.pendingAdvances += 1;
      }
      continue;
    }

    // New candidate (different from both applied and any prior
    // pending). Reset the pending counter to 1 so the change still
    // requires `STABILITY_OBS_REQUIRED` consecutive cycles.
    await db
      .update(categoryLeverPriorScalesTable)
      .set({
        pendingTier: sugg.tier,
        pendingObservations: 1,
        pendingSinceCycle: args.cycleGeneration,
      })
      .where(eq(categoryLeverPriorScalesTable.id, row.id));
    result.pendingAdvances += 1;
  }

  return result;
}

/**
 * Ordering used to label flips as promote vs demote in annotation
 * summaries. Higher = "stronger / more trusted" prior.
 */
function tierRank(tier: string): number {
  if (tier === "tier_a") return 3;
  if (tier === "tier_b") return 2;
  if (tier === "tier_c_or_d") return 1;
  return 0;
}
