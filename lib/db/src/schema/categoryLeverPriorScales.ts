import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Per-(org, category_code, lever_id) prior-strength override learned
 * from the snapshot calibration tier matrix (task #229).
 *
 * Background: `learnedPriors` are per-(org, lever) only. The
 * `suggestTierForCategoryLever` helper (task #218) classifies each
 * (category, lever) bucket of the latest snapshot's calibration block
 * as tier_a / tier_b / tier_c_or_d / insufficient_data. This table
 * persists the *currently-applied* tier per (category, lever) along
 * with the multipliers it expands into, plus a small hysteresis state
 * machine so a single bad cycle can't flip a previously-stable tier.
 *
 * Hysteresis model
 * ----------------
 * The cycle reads the latest snapshot's tier suggestion for each
 * (category, lever) it touches and compares to `appliedTier`:
 *   - same tier            → reset pending state, no change
 *   - new tier first time  → record `pendingTier` + `pendingObservations=1`
 *   - new tier seen again  → if matches `pendingTier`, increment
 *                            observations; once it crosses
 *                            `STABILITY_OBS_REQUIRED` (=2 by default)
 *                            the change is *applied* — `appliedTier`
 *                            updates, `appliedAtCycle` records the
 *                            cycle generation, pending state resets,
 *                            and a `calibration_change` annotation is
 *                            emitted against the snapshot.
 *
 * `appliedScaleProjection` and `appliedScaleConfidence` are the
 * multipliers Decide layers on top of the per-lever `learnedPriors`
 * row when scoring a draft whose (category, lever) matches this
 * override. Tier C/D suppresses both; tier A leaves them at 1.0;
 * tier B and `insufficient_data` are also 1.0 (no-op). The mapping
 * lives in `lib/ooda/tier-auto-apply.ts` so it can evolve without a
 * schema migration.
 *
 * Insufficient-data rows are *not* persisted — there is nothing to
 * apply, and storing them would just inflate the table. Once a
 * bucket crosses `n >= 10`, the next cycle will consider the tier
 * suggestion and (with hysteresis) start applying.
 *
 * Cross-tenant: scoped to `org_id`. No FK to `categories` because
 * the dimension is the *canonical code* (string), not the per-tenant
 * category row id — same convention used by the snapshot calibration
 * keys (`<lever>:<categoryCode>:<window>`).
 */
export const categoryLeverPriorScalesTable = pgTable(
  "category_lever_prior_scales",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    categoryCode: text("category_code").notNull(),
    leverId: text("lever_id").notNull(),
    /**
     * The tier currently *applied* to the prior. One of `tier_a`,
     * `tier_b`, `tier_c_or_d`. `insufficient_data` is never stored;
     * a (category, lever) without a row defaults to `tier_b` semantics
     * (1.0 multipliers).
     */
    appliedTier: text("applied_tier").notNull(),
    appliedScaleProjection: numeric("applied_scale_projection", {
      precision: 6,
      scale: 4,
    })
      .notNull()
      .default("1.0000"),
    appliedScaleConfidence: numeric("applied_scale_confidence", {
      precision: 6,
      scale: 4,
    })
      .notNull()
      .default("1.0000"),
    /** Cycle generation at which `appliedTier` last changed. */
    appliedAtCycle: integer("applied_at_cycle").notNull(),
    /**
     * Hysteresis state: the candidate tier the latest snapshot is
     * suggesting that differs from `appliedTier`. Null when no
     * candidate is currently being staged. Reset to null whenever
     * the snapshot suggestion matches `appliedTier`.
     */
    pendingTier: text("pending_tier"),
    /**
     * How many consecutive cycles `pendingTier` has been the latest
     * snapshot's suggestion. The change is applied when this reaches
     * `STABILITY_OBS_REQUIRED` (see `lib/ooda/tier-auto-apply.ts`).
     */
    pendingObservations: integer("pending_observations").notNull().default(0),
    /** Cycle generation at which the current pending streak started. */
    pendingSinceCycle: integer("pending_since_cycle"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("category_lever_prior_scales_uq").on(
      t.orgId,
      t.categoryCode,
      t.leverId,
    ),
    index("category_lever_prior_scales_org_idx").on(t.orgId),
  ],
);

export type CategoryLeverPriorScaleRow =
  typeof categoryLeverPriorScalesTable.$inferSelect;
export type InsertCategoryLeverPriorScaleRow =
  typeof categoryLeverPriorScalesTable.$inferInsert;
