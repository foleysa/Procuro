import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { suppliersTable } from "./suppliers";
import { contractsTable } from "./contracts";

/**
 * Statement of Work — a child agreement underneath an MSA contract that
 * carries the actual scope, deliverables, and commercial structure for a
 * services engagement. Added in Task #214 alongside `rate_cards` so
 * services-side intelligence (milestone burn-down, T&M utilization,
 * acceptance gates) has a place to live.
 *
 * SOWs are idempotent on `(orgId, sourceSystem, sourceExternalId)` to
 * match the rest of the ingest pipeline.
 */
export const sowStatusValues = [
  "draft",
  "active",
  "completed",
  "cancelled",
] as const;
export type SowStatus = (typeof sowStatusValues)[number];

export const statementsOfWorkTable = pgTable(
  "statements_of_work",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    /** Parent MSA contract. Required — a SOW with no parent is meaningless. */
    contractId: text("contract_id")
      .notNull()
      .references(() => contractsTable.id, { onDelete: "cascade" }),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "cascade" }),
    sowNumber: text("sow_number").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<SowStatus>().notNull().default("active"),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    /** Total committed value in USD (lump-sum for fixed-price SOWs). */
    totalValueUsd: numeric("total_value_usd", {
      precision: 16,
      scale: 2,
    }),
    /** ISO 4217. Null inherits parent contract's currency. */
    billingCurrency: text("billing_currency"),
    /** Optional structured scope statement / deliverables list. */
    scope: jsonb("scope").$type<unknown>(),
    /** Plain-text acceptance criteria for the SOW. */
    acceptanceCriteria: text("acceptance_criteria"),
    sourceSystem: text("source_system").notNull().default("seed"),
    sourceExternalId: text("source_external_id"),
    sourceSyncedAt: timestamp("source_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sow_org_idx").on(t.orgId),
    index("sow_contract_idx").on(t.orgId, t.contractId),
    index("sow_contract_fk_idx").on(t.contractId),
    index("sow_supplier_idx").on(t.orgId, t.supplierId),
    index("sow_status_idx").on(t.orgId, t.status),
    index("sow_end_date_idx").on(t.orgId, t.endDate),
    uniqueIndex("sow_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type StatementOfWorkRow = typeof statementsOfWorkTable.$inferSelect;
export type InsertStatementOfWorkRow =
  typeof statementsOfWorkTable.$inferInsert;

/**
 * Discrete deliverables / payment milestones on a SOW. The
 * milestone-burn-down analyzer reads this table to compute how much of
 * the committed value has been earned vs. invoiced.
 */
export const sowMilestoneStatusValues = [
  "pending",
  "in_progress",
  "delivered",
  "accepted",
  "invoiced",
  "paid",
  "cancelled",
] as const;
export type SowMilestoneStatus = (typeof sowMilestoneStatusValues)[number];

export const sowMilestonesTable = pgTable(
  "sow_milestones",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    sowId: text("sow_id")
      .notNull()
      .references(() => statementsOfWorkTable.id, { onDelete: "cascade" }),
    milestoneNumber: integer("milestone_number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    valueUsd: numeric("value_usd", { precision: 16, scale: 2 }),
    status: text("status")
      .$type<SowMilestoneStatus>()
      .notNull()
      .default("pending"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sow_milestones_sow_idx").on(t.sowId),
    index("sow_milestones_status_idx").on(t.orgId, t.status),
    index("sow_milestones_due_idx").on(t.orgId, t.dueDate),
    uniqueIndex("sow_milestones_uq").on(t.sowId, t.milestoneNumber),
  ],
);

export type SowMilestoneRow = typeof sowMilestonesTable.$inferSelect;
export type InsertSowMilestoneRow = typeof sowMilestonesTable.$inferInsert;

/**
 * Change orders against a SOW. Captures scope/value/date deltas so the
 * burn-down analyzer can show "original vs. current commitment" deltas
 * and surface scope-creep alerts in Task #4.
 */
export const sowChangeOrderStatusValues = [
  "proposed",
  "approved",
  "rejected",
  "executed",
] as const;
export type SowChangeOrderStatus = (typeof sowChangeOrderStatusValues)[number];

export const sowChangeOrdersTable = pgTable(
  "sow_change_orders",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    sowId: text("sow_id")
      .notNull()
      .references(() => statementsOfWorkTable.id, { onDelete: "cascade" }),
    changeOrderNumber: text("change_order_number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status")
      .$type<SowChangeOrderStatus>()
      .notNull()
      .default("proposed"),
    /** Signed delta to total SOW value (can be negative). */
    valueDeltaUsd: numeric("value_delta_usd", {
      precision: 16,
      scale: 2,
    }),
    /** Signed delta to SOW end date in days (can be negative). */
    dateDeltaDays: integer("date_delta_days"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    /**
     * Free-text identity (name / email / role) of the approver who
     * signed off on this change order. Surfaces in the audit trail
     * alongside delta-value and approval-date so an operator can
     * answer "who approved this scope creep?" without leaving the
     * SOW detail page. Nullable: not every source system carries an
     * approver identity, and rows in `proposed`/`rejected` states
     * may not have one yet.
     */
    approver: text("approver"),
    sourceSystem: text("source_system").notNull().default("seed"),
    sourceExternalId: text("source_external_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sow_change_orders_sow_idx").on(t.sowId),
    index("sow_change_orders_status_idx").on(t.orgId, t.status),
    uniqueIndex("sow_change_orders_uq").on(t.sowId, t.changeOrderNumber),
    uniqueIndex("sow_change_orders_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type SowChangeOrderRow = typeof sowChangeOrdersTable.$inferSelect;
export type InsertSowChangeOrderRow = typeof sowChangeOrdersTable.$inferInsert;
