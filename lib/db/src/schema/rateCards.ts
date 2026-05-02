import {
  pgTable,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { suppliersTable } from "./suppliers";
import { contractsTable } from "./contracts";
import { statementsOfWorkTable } from "./statementsOfWork";

/**
 * Rate card — the canonical labor-rate matrix for a T&M services
 * agreement. A rate card belongs to either a contract (MSA-level) or a
 * SOW (engagement-level override). Added in Task #214 to replace the
 * pattern of stuffing labor rates into `contract_items`.
 */
export const rateCardsTable = pgTable(
  "rate_cards",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    /** Either contractId or sowId is populated; both may be set if the
     * rate card is scoped to a SOW under an MSA. */
    contractId: text("contract_id").references(() => contractsTable.id, {
      onDelete: "cascade",
    }),
    sowId: text("sow_id").references(() => statementsOfWorkTable.id, {
      onDelete: "cascade",
    }),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** ISO 4217 — defaults to USD when ingest payloads don't specify. */
    currency: text("currency").notNull().default("USD"),
    effectiveDate: timestamp("effective_date", { withTimezone: true }).notNull(),
    expiryDate: timestamp("expiry_date", { withTimezone: true }),
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
    index("rate_cards_org_idx").on(t.orgId),
    index("rate_cards_contract_idx").on(t.contractId),
    index("rate_cards_sow_idx").on(t.sowId),
    index("rate_cards_supplier_idx").on(t.orgId, t.supplierId),
    uniqueIndex("rate_cards_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type RateCardRow = typeof rateCardsTable.$inferSelect;
export type InsertRateCardRow = typeof rateCardsTable.$inferInsert;

/**
 * Individual rate-card lines (role × seniority → hourly/daily rate). The
 * T&M utilization analyzer joins time entries against this table to flag
 * rate-card vs. invoiced rate drift.
 */
export const rateCardLinesTable = pgTable(
  "rate_card_lines",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    rateCardId: text("rate_card_id")
      .notNull()
      .references(() => rateCardsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    /** Free-form seniority label ("junior", "senior", "principal"). */
    seniority: text("seniority"),
    /** Hourly rate in the rate card's currency. */
    hourlyRate: numeric("hourly_rate", { precision: 14, scale: 4 }),
    /** Daily rate in the rate card's currency. Optional — usually one or the other. */
    dailyRate: numeric("daily_rate", { precision: 14, scale: 4 }),
    /** Optional code (vendor's role code). */
    roleCode: text("role_code"),
    /** Optional geography / region tag (e.g. "US", "EMEA", "India"). */
    geography: text("geography"),
    /** Commercial structure for this line: t_and_m, fixed, milestone, retainer, outcome. */
    billingModel: text("billing_model"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("rate_card_lines_card_idx").on(t.rateCardId),
    index("rate_card_lines_role_idx").on(t.orgId, t.role),
    uniqueIndex("rate_card_lines_uq").on(t.rateCardId, t.role, t.seniority),
  ],
);

export type RateCardLineRow = typeof rateCardLinesTable.$inferSelect;
export type InsertRateCardLineRow = typeof rateCardLinesTable.$inferInsert;

/**
 * Time entries — actuals reported by the supplier (or pulled from the
 * staffing/PSA system). Drives T&M utilization & burn-rate analyzers.
 */
export const timeEntriesTable = pgTable(
  "time_entries",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "cascade" }),
    contractId: text("contract_id").references(() => contractsTable.id, {
      onDelete: "set null",
    }),
    sowId: text("sow_id").references(() => statementsOfWorkTable.id, {
      onDelete: "set null",
    }),
    rateCardId: text("rate_card_id").references(() => rateCardsTable.id, {
      onDelete: "set null",
    }),
    rateCardLineId: text("rate_card_line_id").references(
      () => rateCardLinesTable.id,
      { onDelete: "set null" },
    ),
    /** Free-form resource identifier (consultant name, vendor employee id). */
    resource: text("resource").notNull(),
    role: text("role"),
    seniority: text("seniority"),
    workDate: timestamp("work_date", { withTimezone: true }).notNull(),
    hours: numeric("hours", { precision: 10, scale: 2 }).notNull(),
    /** Effective rate billed for this entry (snapshot at entry time). */
    billRateUsd: numeric("bill_rate_usd", { precision: 14, scale: 4 }),
    amountUsd: numeric("amount_usd", { precision: 16, scale: 2 }),
    description: text("description"),
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
    index("time_entries_org_idx").on(t.orgId),
    index("time_entries_supplier_idx").on(t.orgId, t.supplierId),
    index("time_entries_contract_idx").on(t.contractId),
    index("time_entries_sow_idx").on(t.sowId),
    index("time_entries_rate_card_idx").on(t.rateCardId),
    index("time_entries_work_date_idx").on(t.orgId, t.workDate),
    uniqueIndex("time_entries_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type TimeEntryRow = typeof timeEntriesTable.$inferSelect;
export type InsertTimeEntryRow = typeof timeEntriesTable.$inferInsert;
