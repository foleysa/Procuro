import {
  pgTable,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { suppliersTable } from "./suppliers";
import { categoriesTable } from "./categories";
import { itemsTable } from "./items";

export const contractStatusValues = [
  "active",
  "pending",
  "expired",
  "cancelled",
] as const;
export type ContractStatus = (typeof contractStatusValues)[number];

export const contractsTable = pgTable(
  "contracts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => categoriesTable.id, {
      onDelete: "set null",
    }),
    contractNumber: text("contract_number").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<ContractStatus>().notNull().default("active"),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    paymentTermsDays: integer("payment_terms_days"),
    referenceIndex: text("reference_index"),
    /**
     * ISO 4217 currency this contract is denominated in. Null means "inherits
     * supplier or org base currency". Used by the FX-exposure analyzer to
     * scope alerts to the specific contracts a currency move impacts.
     */
    billingCurrency: text("billing_currency"),
    annualBaselineUsd: numeric("annual_baseline_usd", {
      precision: 16,
      scale: 2,
    }).default("0"),
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
    index("contracts_org_idx").on(t.orgId),
    index("contracts_supplier_idx").on(t.orgId, t.supplierId),
    index("contracts_category_idx").on(t.orgId, t.categoryId),
    index("contracts_end_date_idx").on(t.orgId, t.endDate),
    uniqueIndex("contracts_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type ContractRow = typeof contractsTable.$inferSelect;
export type InsertContractRow = typeof contractsTable.$inferInsert;

export const contractItemsTable = pgTable(
  "contract_items",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    contractId: text("contract_id")
      .notNull()
      .references(() => contractsTable.id, { onDelete: "cascade" }),
    itemId: text("item_id").references(() => itemsTable.id, {
      onDelete: "set null",
    }),
    sku: text("sku").notNull(),
    contractedUnitPriceUsd: numeric("contracted_unit_price_usd", {
      precision: 14,
      scale: 4,
    }).notNull(),
    /**
     * tiers: ordered breakpoints
     * [{ minQty: number, unitPriceUsd: number }, ...]
     */
    tiers: jsonb("tiers")
      .$type<{ minQty: number; unitPriceUsd: number }[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("contract_items_contract_idx").on(t.contractId),
    index("contract_items_org_sku_idx").on(t.orgId, t.sku),
  ],
);

export type ContractItemRow = typeof contractItemsTable.$inferSelect;
export type InsertContractItemRow = typeof contractItemsTable.$inferInsert;
