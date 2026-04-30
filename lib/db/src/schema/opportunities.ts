import {
  pgTable,
  text,
  timestamp,
  numeric,
  index,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
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
  "dual_sourcing",
  // Tier 5
  "services_rate_card_benchmark",
  "sow_to_msa_conversion",
  "outcome_based_contract",
  "unbundling_rebundling",
  "multi_year_tco",
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
  dual_sourcing: 4,
  services_rate_card_benchmark: 5,
  sow_to_msa_conversion: 5,
  outcome_based_contract: 5,
  unbundling_rebundling: 5,
  multi_year_tco: 5,
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("opps_org_idx").on(t.orgId),
    index("opps_cycle_idx").on(t.cycleId),
    index("opps_lever_idx").on(t.orgId, t.leverId),
    index("opps_status_idx").on(t.orgId, t.status),
    index("opps_supplier_idx").on(t.orgId, t.supplierId),
    index("opps_category_idx").on(t.orgId, t.categoryId),
  ],
);

export type OpportunityRow = typeof opportunitiesTable.$inferSelect;
export type InsertOpportunityRow = typeof opportunitiesTable.$inferInsert;

export const decisionEventTypes = [
  "approve",
  "reject",
  "execute",
  "realize",
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
