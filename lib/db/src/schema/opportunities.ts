import {
  pgTable,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
  jsonb,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgsTable } from "./orgs";
import { suppliersTable } from "./suppliers";
import { categoriesTable } from "./categories";

export const leverIds = [
  // Tier 1
  "sku_price_benchmark",
  "maverick_spend",
  "contract_leakage",
  "duplicate_payment",
  "missed_volume_threshold",
  "payment_term_extension",
  "tail_spend_rationalization",
  // Tier 2 (Phase 5a)
  "supplier_consolidation",
  "contract_renegotiation_trigger",
  "spot_vs_contract",
  "catalog_standardization",
  "indirect_category_strategy",
  // Tier 3
  "freight_mode_optimization",
  "lane_consolidation",
  "incoterms_optimization",
  // Tier 4
  "should_cost_modeling",
  "index_based_pricing",
  "demand_aggregation",
  "raw_material_hedging",
  "supplier_fx_exposure",
  "dual_sourcing",
  "material_index_arbitrage",
  // Tier 5
  "services_rate_card_benchmark",
  "sow_to_msa_conversion",
  "outcome_based_contract",
  "unbundling_rebundling",
  "multi_year_tco",
  "scope_management",
  "hours_audit",
] as const;
export type LeverId = (typeof leverIds)[number];

export const tierLabels: Record<LeverId, 1 | 2 | 3 | 4 | 5> = {
  sku_price_benchmark: 1,
  maverick_spend: 1,
  contract_leakage: 1,
  duplicate_payment: 1,
  missed_volume_threshold: 1,
  payment_term_extension: 1,
  tail_spend_rationalization: 1,
  supplier_consolidation: 2,
  contract_renegotiation_trigger: 2,
  spot_vs_contract: 2,
  catalog_standardization: 2,
  indirect_category_strategy: 2,
  freight_mode_optimization: 3,
  lane_consolidation: 3,
  incoterms_optimization: 3,
  should_cost_modeling: 4,
  index_based_pricing: 4,
  demand_aggregation: 4,
  raw_material_hedging: 4,
  supplier_fx_exposure: 4,
  dual_sourcing: 4,
  material_index_arbitrage: 4,
  services_rate_card_benchmark: 5,
  sow_to_msa_conversion: 5,
  outcome_based_contract: 5,
  unbundling_rebundling: 5,
  multi_year_tco: 5,
  scope_management: 5,
  hours_audit: 5,
};

export const opportunityStatusValues = [
  "proposed",
  "approved",
  "rejected",
  "executing",
  "realized",
  "expired",
] as const;
export type OpportunityStatus = (typeof opportunityStatusValues)[number];

// ---------------------------------------------------------------------------
// S2P canonical vocabulary (Task #284)
// ---------------------------------------------------------------------------

/**
 * Savings type tracks the maturity of a savings claim through the S2P lifecycle.
 *   Identified      — potential savings flagged by the engine, not yet committed
 *   Negotiated      — savings agreed in principle (award issued)
 *   Implemented     — contract signed / purchase order cut; savings flow starting
 *   Realized        — savings confirmed against actuals in the accounting system
 */
export const savingsTypeValues = [
  "Identified",
  "Negotiated",
  "Implemented",
  "Realized",
] as const;
export type SavingsType = (typeof savingsTypeValues)[number];

/**
 * Savings classification controls how savings are reported in finance.
 *   Hard            — cash savings verified in the P&L / GL
 *   Cost Avoidance  — price increase avoided, rebate captured, or TTM spend prevented
 *   Soft            — productivity/time savings not directly in P&L
 */
export const savingsClassificationValues = [
  "Hard",
  "Cost Avoidance",
  "Soft",
] as const;
export type SavingsClassification = (typeof savingsClassificationValues)[number];

/**
 * Canonical stage aligns the opportunity lifecycle with the S2P process gate model.
 * Maps loosely to the existing `status` enum but uses procurement-standard terminology.
 *
 *   Identified         ← status: proposed
 *   Awarded            ← status: approved
 *   In Contracting     ← (future gate between approved and executing)
 *   In Implementation  ← status: executing
 *   Realized           ← status: realized
 *   Closed-No Action   ← status: rejected / expired
 *   Under Re-evaluation← special bucket: rejected-but-under-review records
 *                        (sourced from the ~8 records tagged as such in the
 *                         platform at migration time; backfilled from a
 *                         `rejected_under_review` platform_status if present,
 *                         otherwise operator-set post-migration)
 */
export const canonicalStageValues = [
  "Identified",
  "Awarded",
  "In Contracting",
  "In Implementation",
  "Realized",
  "Closed-No Action",
  "Under Re-evaluation",
] as const;
export type CanonicalStage = (typeof canonicalStageValues)[number];

/**
 * Sourcing strategy taxonomy for categorising how the saving was (or will be) captured.
 *   Unclassified is the default for all backfilled and new rows until explicitly set.
 */
export const sourcingStrategyValues = [
  "Competitive RFP",
  "Single-to-Dual Source",
  "Should-Cost Challenge",
  "Tiered Pricing Audit / Rebate Claim",
  "Invoice-to-Contract Reconciliation",
  "Catalog Enforcement",
  "Negotiated Renewal",
  "Unclassified",
] as const;
export type SourcingStrategy = (typeof sourcingStrategyValues)[number];

/** Structured rejection-reason taxonomy. Drives exclusion rules in OODA Learn. */
export const rejectionReasonCodes = [
  "supplier_strategic_do_not_consolidate",
  "supplier_dei_or_diverse_program",
  "data_quality_issue",
  "already_negotiated",
  "compliance_or_legal_block",
  "specification_required",
  "lead_time_critical",
  "cash_flow_constraint",
  "category_owner_disagrees",
  "other",
] as const;
export type RejectionReasonCode = (typeof rejectionReasonCodes)[number];

export const opportunitiesTable = pgTable(
  "opportunities",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    /** OODA cycle (generation) that produced this opportunity */
    cycleId: text("cycle_id").notNull(),
    leverId: text("lever_id").$type<LeverId>().notNull(),
    tier: integer("tier").notNull(),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    recommendedAction: text("recommended_action").notNull(),
    supplierId: text("supplier_id").references(() => suppliersTable.id, {
      onDelete: "set null",
    }),
    categoryId: text("category_id").references(() => categoriesTable.id, {
      onDelete: "set null",
    }),
    /** Raw model output before priors are applied */
    rawProjectedSavingsUsd: numeric("raw_projected_savings_usd", {
      precision: 16,
      scale: 2,
    }).notNull(),
    /** Calibrated against per-lever projection-multiplier prior */
    projectedSavingsUsd: numeric("projected_savings_usd", {
      precision: 16,
      scale: 2,
    }).notNull(),
    /** [0..1] from confidence-weight prior */
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    /** Inputs that drove the decision: signals, refs, market signal ids, etc. */
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status")
      .$type<OpportunityStatus>()
      .notNull()
      .default("proposed"),
    realizedSavingsUsd: numeric("realized_savings_usd", {
      precision: 16,
      scale: 2,
    }).notNull().default("0"),
    realizedAt: timestamp("realized_at", { withTimezone: true }),
    rejectedReasonCode: text("rejected_reason_code").$type<RejectionReasonCode>(),
    rejectedReasonNote: text("rejected_reason_note"),
    /**
     * Stable cohort identity key for the underlying signal a row was
     * raised from (task #219). Computed by `composeSignalKey(lever,
     * draft)` at Act time from STABLE identity fields ONLY
     * (leverId, supplierId, categoryId, lever-declared `cohortKey()`)
     * and used as the dedupe key so re-runs of the same OODA cycle
     * don't grow a forever-growing pile of duplicate `proposed`
     * opportunities for the same supplier/category/lever. Narrative
     * fields (title, rationale) and volatile metrics (projected
     * savings, aggregates) are intentionally excluded so that
     * regenerated drafts refresh the existing row in place rather
     * than producing a fresh INSERT each cycle.
     *
     * Nullable so historical rows (pre-#219) can co-exist; the partial
     * unique index below is `WHERE signal_key IS NOT NULL` so legacy
     * rows never conflict on insert.
     */
    signalKey: text("signal_key"),
    /**
     * Last cycle timestamp at which the underlying signal was still
     * present (i.e. the lever produced a draft with the same
     * `signalKey`). Refreshed on every cycle that touches the row;
     * used by the `expire_stale_opportunities` job to flip rows to
     * `expired` after `OPPORTUNITY_QUIET_CYCLES` quiet cycles have
     * elapsed without the signal re-firing. Nullable for the same
     * legacy-row reason as `signalKey`.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /**
     * Provenance for category routing (task #213).
     *
     * `null` for legacy rows persisted before bands routing landed.
     * Newly-routed rows are tagged via the routing helpers:
     *   - `synonym_global`        — Layer A hit on the global registry
     *   - `synonym_tenant_scoped` — Layer A hit on a tenant-scoped row
     *   - `unmapped_default`      — Layer B fallback (Fragmented band)
     *
     * The calibration job (lib/ooda/funnel.ts) excludes
     * `unmapped_default` opportunities from per-lever scoring so the
     * fallback routing never contaminates the prior.
     */
    mappedVia: text("mapped_via").$type<
      "synonym_global" | "synonym_tenant_scoped" | "unmapped_default"
    >(),
    /**
     * Originating tenant-supplied category string for opportunities
     * that came in through the unmapped path (Layer B fallback). This
     * is the raw string the tenant uploaded BEFORE normalization, kept
     * verbatim so we can audit-flag the right rows when an admin later
     * resolves the matching queue entry. Null for rows that didn't
     * originate from a tenant category string (analyzer-derived,
     * synonym-routed, or pre-#213 legacy rows).
     */
    sourceTenantCategoryString: text("source_tenant_category_string"),
    /**
     * Audit-only flag set by the admin queue resolver when an
     * operator maps a tenant string AFTER opportunities tagged with
     * the unresolved category have already been persisted. Going-forward
     * routing changes immediately; this flag exists purely so admins
     * can trace which historical opportunities were derived from a
     * since-resolved category — `category_code`, `mappedVia`, and
     * cohort assignment are NEVER rewritten. Matched via
     * `source_tenant_category_string` provenance — NOT category code,
     * which would mismatch since unmapped opps point to placeholder
     * categories, not the eventually-resolved canonical code.
     */
    reCategorizedAfterPersistence: integer("re_categorized_after_persistence")
      .notNull()
      .default(0),
    /**
     * Snooze deadline (task #220). When set and `> now()`, the row is
     * "snoozed" — it stays in `proposed` status (so the audit trail
     * keeps the same lifecycle), but is excluded from the Today
     * page's pending-approvals card and from the default opportunities
     * list view until the deadline passes. Snoozed rows reappear
     * automatically once `snoozedUntil <= now()`. The bulk snooze /
     * unsnooze endpoints flip this column and write a `snooze` /
     * `unsnooze` event into `decisions` per affected row so the audit
     * trail is preserved.
     */
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    /**
     * Reason an opportunity was auto-expired by the
     * `expire_stale_opportunities` job (task #222). Populated when the
     * job flips a `proposed` row to `expired`:
     *   - `ttl`           — the absolute `OPPORTUNITY_TTL_DAYS` cap fired
     *   - `quiet_cycles`  — the underlying signal went quiet for
     *                       `OPPORTUNITY_QUIET_CYCLES` cycles
     *
     * NULL for rows that reached `expired` by some other means (legacy
     * pre-#222 expirations, or any future manual/import path) and for
     * every non-`expired` row. The job's per-cause counts on the System
     * / Jobs page are still derived from the per-statement RETURNING
     * counts, so this column is purely the per-row complement that
     * lets the Approvals "Expired" view tell operators WHY a single
     * row aged out.
     */
    expiryReason: text("expiry_reason").$type<"ttl" | "quiet_cycles">(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // -----------------------------------------------------------------------
    // S2P canonical vocabulary columns (Task #284)
    //
    // MIGRATION PLAN (additive only — no destructive changes):
    //   1. Ten new nullable columns added to `opportunities` via drizzle-kit push.
    //   2. New table `opportunity_stage_history` created via drizzle-kit push.
    //   3. A backfill script (lib/db/scripts/backfill-s2p-fields.mjs) applies
    //      the following mapping for all rows with canonical_stage IS NULL:
    //
    //      status      → canonical_stage         savings_type
    //      ─────────────────────────────────────────────────────────────
    //      proposed    → Identified              Identified
    //      approved    → Awarded                 Negotiated
    //      executing   → In Implementation       Implemented
    //      realized    → Realized                Realized
    //      rejected    → Closed-No Action        Identified  (*)
    //      expired     → Closed-No Action        Identified  (*)
    //
    //      (*) savings_type='Identified' because the prior stage cannot be
    //          reconstructed without stage history that didn't yet exist.
    //          Going forward, opportunity_stage_history records the actual
    //          prior stage on every transition.
    //
    //   4. All backfilled rows also receive:
    //        savings_classification      = 'Hard'              (conservative default)
    //        classification_needs_review = true                (flagged for review)
    //        baseline_method             = 'Internal Estimate' (conservative default)
    //        baseline_value              = NULL
    //        baseline_source             = 'BACKFILL — needs review'
    //        sourcing_strategy           = 'Unclassified'
    //        doa_tier derived from projected_savings_usd:
    //          >= 5,000,000 → 1 | >= 1,000,000 → 2 | >= 250,000 → 3 | < 250,000 → 4
    //        stage_entered_at = COALESCE(updated_at, created_at)
    //   5. A seed row is written to opportunity_stage_history per opportunity:
    //        from_stage = NULL, to_stage = <backfilled canonical_stage>,
    //        transitioned_at = stage_entered_at, transition_reason = 'BACKFILL'
    //   6. `time_in_current_stage_hours` and `breaching_sla` are NOT stored;
    //      they are computed at query time via gateSlaBreach() in doa-config.ts.
    //   7. Going-forward: canonical_stage, stage_entered_at, and savings_type
    //      are updated on every status transition in the opportunities route,
    //      and a history row is written per transition.
    // -----------------------------------------------------------------------

    /**
     * S2P savings-type tag — tracks maturity of the savings claim.
     * Backfilled from `status` on first deploy; operator-editable thereafter.
     */
    savingsType: text("savings_type").$type<SavingsType>(),

    /**
     * Finance classification for reporting purposes.
     * All backfilled rows default to `Hard` with `classificationNeedsReview = true`.
     */
    savingsClassification: text("savings_classification").$type<SavingsClassification>(),

    /**
     * Flag set to true for every row backfilled at migration time,
     * prompting operators to confirm or adjust the auto-assigned
     * savings_classification. Cleared when an operator explicitly sets
     * a classification via the admin UI (future task).
     *
     * GATING CONDITION: No aggregate labeled "Hard Savings" may include records
     * where this flag is true until Category Manager review is complete.
     */
    classificationNeedsReview: boolean("classification_needs_review").default(false),

    /**
     * Procurement-standard stage gate label. Kept in sync with `status`
     * transitions; operators may also advance it manually within the
     * constraints of the gate model.
     */
    canonicalStage: text("canonical_stage").$type<CanonicalStage>(),

    /**
     * Timestamp when `canonical_stage` last changed. Used to compute
     * `time_in_current_stage_hours` at query time and to evaluate gate SLA
     * breaches. Set to COALESCE(updated_at, created_at) for backfilled rows.
     */
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }),

    /**
     * DOA tier (1–4) derived from `projected_savings_usd` using the
     * DOA_TIERS ladder in `lib/db/src/doa-config.ts`. Denormalised here
     * so the DOA queue can filter/sort without a join to the config.
     * Must be kept in sync whenever `projected_savings_usd` changes.
     */
    doaTier: integer("doa_tier"),

    /**
     * Sourcing strategy taxonomy — how the saving is (or will be) captured.
     * Defaults to `Unclassified` for all rows; operator-settable via
     * admin UI (future task).
     */
    sourcingStrategy: text("sourcing_strategy")
      .$type<SourcingStrategy>()
      .default("Unclassified"),

    /**
     * Baseline calculation method — how the benchmark price/cost was
     * established. Required for Finance to validate "Hard" savings.
     *   Prior Unit Price      — historical unit price from PO/invoice data
     *   Market Index          — external commodity/market reference
     *   Should-Cost Model     — bottom-up TCO engineering estimate
     *   Supplier Proposed Increase — avoided increase; baseline = current price
     *   Internal Estimate     — procurement team judgment; lowest rigor
     *   N/A — Soft            — no financial baseline (Soft classification only)
     *
     * All backfilled rows default to 'Internal Estimate' with
     * classificationNeedsReview = true.
     */
    baselineMethod: text("baseline_method").$type<
      | "Prior Unit Price"
      | "Market Index"
      | "Should-Cost Model"
      | "Supplier Proposed Increase"
      | "Internal Estimate"
      | "N/A — Soft"
    >(),

    /**
     * The numeric baseline value (e.g. prior unit price, index price) used
     * in the savings calculation. Units match the opportunity's price metric.
     * Nullable — may not be known at identification time.
     */
    baselineValue: numeric("baseline_value", { precision: 16, scale: 4 }),

    /**
     * Free-text provenance of the baseline_value (e.g. PO reference number,
     * index name, model run ID). Set to 'BACKFILL — needs review' for all
     * backfilled rows.
     */
    baselineSource: text("baseline_source"),
  },
  (t) => [
    index("opps_org_idx").on(t.orgId),
    index("opps_cycle_idx").on(t.cycleId),
    index("opps_lever_idx").on(t.orgId, t.leverId),
    index("opps_status_idx").on(t.orgId, t.status),
    index("opps_supplier_idx").on(t.orgId, t.supplierId),
    index("opps_supplier_fk_idx").on(t.supplierId),
    index("opps_category_idx").on(t.orgId, t.categoryId),
    index("opps_category_fk_idx").on(t.categoryId),
    // Partial unique index — only the live (non-terminal) lifecycle
    // states participate in dedupe so the same signal can produce a
    // new `proposed` row after the previous one was rejected/expired
    // /realized. NULL signal_key rows (legacy) are excluded so the
    // backfill never violates the constraint.
    uniqueIndex("opps_signal_key_uq")
      .on(t.orgId, t.leverId, t.signalKey)
      .where(
        sql`status IN ('proposed', 'approved', 'executing') AND signal_key IS NOT NULL`,
      ),
    // Drives the auto-expire scan: per-org filter + status filter +
    // last_seen_at range scan against the quiet-cycle cutoff.
    index("opps_status_last_seen_idx").on(t.orgId, t.status, t.lastSeenAt),
    index("opps_mapped_via_idx").on(t.orgId, t.mappedVia),
    // Lookup index for queue-resolution audit-flag matching
    // (resolveQueueEntry filters by org_id + source_tenant_category_string).
    index("opps_source_tenant_string_idx").on(
      t.orgId,
      t.sourceTenantCategoryString,
    ),
    // Drives the "currently snoozed" filter on the Today aggregator
    // and the default opportunities list query: per-org + status +
    // snoozed_until range scan against `now()`. Partial so the index
    // only carries the rows that can be currently snoozed (others are
    // excluded by `status` upstream anyway).
    index("opps_snoozed_until_idx")
      .on(t.orgId, t.status, t.snoozedUntil)
      .where(sql`snoozed_until IS NOT NULL`),
  ],
);

export type OpportunityRow = typeof opportunitiesTable.$inferSelect;
export type InsertOpportunityRow = typeof opportunitiesTable.$inferInsert;

// ---------------------------------------------------------------------------
// Opportunity Stage History (Task #284)
// ---------------------------------------------------------------------------

/**
 * One row per canonical_stage transition.
 *
 * Written by application code (opportunities route) on every
 * `canonical_stage` change. Backfill seeds one row per opportunity with
 * from_stage = NULL and transition_reason = 'BACKFILL'.
 *
 * This table is the source of truth for "how long did this opportunity
 * spend in each gate?" and for reconstructing savings_type history on
 * terminal-state rows (Closed-No Action / Under Re-evaluation) where the
 * prior stage is now recoverable from this log.
 */
export const opportunityStageHistoryTable = pgTable(
  "opportunity_stage_history",
  {
    id: text("id").primaryKey(),
    opportunityId: text("opportunity_id")
      .notNull()
      .references(() => opportunitiesTable.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    /** Stage the opportunity transitioned FROM. NULL for the initial backfill seed row. */
    fromStage: text("from_stage").$type<CanonicalStage>(),
    /** Stage the opportunity transitioned TO. */
    toStage: text("to_stage").$type<CanonicalStage>().notNull(),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Email/ID of the actor who triggered the transition.
     * NULL for system-initiated transitions (auto-expire, backfill).
     */
    transitionedByUserId: text("transitioned_by_user_id"),
    /**
     * Machine-readable reason code:
     *   BACKFILL      — seed row written by the backfill migration
     *   STATUS_CHANGE — driven by an opportunity status transition event
     *   MANUAL        — operator manually advanced the canonical stage
     */
    transitionReason: text("transition_reason"),
    /** Optional free-text notes from the actor. */
    notes: text("notes"),
  },
  (t) => [
    index("opp_stage_hist_opp_idx").on(t.opportunityId),
    index("opp_stage_hist_org_idx").on(t.orgId),
    index("opp_stage_hist_at_idx").on(t.opportunityId, t.transitionedAt),
  ],
);

export type OpportunityStageHistoryRow =
  typeof opportunityStageHistoryTable.$inferSelect;
export type InsertOpportunityStageHistoryRow =
  typeof opportunityStageHistoryTable.$inferInsert;

export const decisionEventTypes = [
  "approve",
  "reject",
  "execute",
  "realize",
  // Snooze / unsnooze (task #220) — write a decision row for every
  // affected opportunity so the audit trail records who deferred what
  // and until when, and who unsnoozed it.
  "snooze",
  "unsnooze",
] as const;
export type DecisionEventType = (typeof decisionEventTypes)[number];

export const decisionsTable = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    opportunityId: text("opportunity_id")
      .notNull()
      .references(() => opportunitiesTable.id, { onDelete: "cascade" }),
    cycleId: text("cycle_id").notNull(),
    eventType: text("event_type").$type<DecisionEventType>().notNull(),
    actor: text("actor").notNull(),
    rejectedReasonCode: text("rejected_reason_code").$type<RejectionReasonCode>(),
    rejectedReasonNote: text("rejected_reason_note"),
    realizedSavingsUsd: numeric("realized_savings_usd", {
      precision: 16,
      scale: 2,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("decisions_org_idx").on(t.orgId),
    index("decisions_opp_idx").on(t.opportunityId),
    index("decisions_cycle_idx").on(t.cycleId),
    index("decisions_created_at_idx").on(t.createdAt),
  ],
);

export type DecisionRow = typeof decisionsTable.$inferSelect;
export type InsertDecisionRow = typeof decisionsTable.$inferInsert;
