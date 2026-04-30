import {
  pgTable,
  text,
  timestamp,
  numeric,
  index,
  jsonb,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import type { LeverId } from "./opportunities";

export const cycleStatusValues = [
  "running",
  "completed",
  "failed",
] as const;
export type CycleStatus = (typeof cycleStatusValues)[number];

/**
 * One row per OODA cycle (Observe → Orient → Decide → Act → Learn).
 * `generation` is the per-tenant cycle counter.
 */
export const analysisCyclesTable = pgTable(
  "analysis_cycles",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    status: text("status").$type<CycleStatus>().notNull().default("running"),
    triggeredBy: text("triggered_by").notNull(),
    /** Snapshot of internal data state + outcome events since cycle N-1 */
    observePayload: jsonb("observe_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Prior values applied this cycle + diff vs previous cycle */
    orientPayload: jsonb("orient_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Ranked opportunity set with their decision-rationale inputs */
    decidePayload: jsonb("decide_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Pointers to approvals/rejections/execution/realized events on this cycle */
    actPayload: jsonb("act_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Explicit prior updates this cycle's outcomes will produce next cycle */
    learnPayload: jsonb("learn_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Aggregated counts for the cycle dashboard */
    opportunitiesCreated: integer("opportunities_created").notNull().default(0),
    opportunitiesApproved: integer("opportunities_approved")
      .notNull()
      .default(0),
    opportunitiesRejected: integer("opportunities_rejected")
      .notNull()
      .default(0),
    opportunitiesRealized: integer("opportunities_realized")
      .notNull()
      .default(0),
    totalProjectedUsd: numeric("total_projected_usd", {
      precision: 18,
      scale: 2,
    })
      .notNull()
      .default("0"),
    totalRealizedUsd: numeric("total_realized_usd", {
      precision: 18,
      scale: 2,
    })
      .notNull()
      .default("0"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("cycles_org_idx").on(t.orgId),
    uniqueIndex("cycles_org_gen_uq").on(t.orgId, t.generation),
    index("cycles_started_at_idx").on(t.orgId, t.startedAt),
  ],
);

export type AnalysisCycleRow = typeof analysisCyclesTable.$inferSelect;
export type InsertAnalysisCycleRow = typeof analysisCyclesTable.$inferInsert;

/**
 * Per-tenant per-lever learned priors. Updated each cycle from realized outcomes.
 *
 *   projectionMultiplier: Bayesian-updated calibration of projected vs realized $.
 *   confidenceWeight: scaled by historical approval rate × realization rate.
 *   evidenceCount: total realized outcomes informing the prior.
 *
 * orgId = NULL means a global cross-tenant prior used to bootstrap new tenants.
 */
export const learnedPriorsTable = pgTable(
  "learned_priors",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").references(() => orgsTable.id, {
      onDelete: "cascade",
    }),
    leverId: text("lever_id").$type<LeverId>().notNull(),
    projectionMultiplier: numeric("projection_multiplier", {
      precision: 6,
      scale: 4,
    })
      .notNull()
      .default("1.0000"),
    confidenceWeight: numeric("confidence_weight", {
      precision: 5,
      scale: 4,
    })
      .notNull()
      .default("0.5000"),
    evidenceCount: integer("evidence_count").notNull().default(0),
    approvalCount: integer("approval_count").notNull().default(0),
    rejectionCount: integer("rejection_count").notNull().default(0),
    realizationCount: integer("realization_count").notNull().default(0),
    updatedAtCycle: integer("updated_at_cycle").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("priors_org_lever_uq").on(t.orgId, t.leverId),
  ],
);

export type LearnedPriorRow = typeof learnedPriorsTable.$inferSelect;
export type InsertLearnedPriorRow = typeof learnedPriorsTable.$inferInsert;

/**
 * Exclusion rules emitted by the OODA Learn step from structured rejection reasons.
 * Each rule is human-readable, removable by the procurement lead, and consulted
 * by the Decide step to filter / down-rank candidate opportunities.
 */
export const exclusionRulesTable = pgTable(
  "exclusion_rules",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    leverId: text("lever_id").$type<LeverId>(),
    supplierId: text("supplier_id"),
    categoryId: text("category_id"),
    reasonCode: text("reason_code").notNull(),
    description: text("description").notNull(),
    /** Cycle that produced this rule */
    sourceCycleId: text("source_cycle_id"),
    active: integer("active").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("excl_rules_org_idx").on(t.orgId),
    index("excl_rules_lever_idx").on(t.orgId, t.leverId),
    index("excl_rules_supplier_idx").on(t.orgId, t.supplierId),
    index("excl_rules_category_idx").on(t.orgId, t.categoryId),
  ],
);

export type ExclusionRuleRow = typeof exclusionRulesTable.$inferSelect;
export type InsertExclusionRuleRow = typeof exclusionRulesTable.$inferInsert;
