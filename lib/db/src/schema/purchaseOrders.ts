import {
  pgTable,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
  integer,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { suppliersTable } from "./suppliers";
import { contractsTable } from "./contracts";
import { categoriesTable } from "./categories";
import { itemsTable } from "./items";
import { type CategoryClass } from "./categories";

export const poStatusValues = [
  "draft",
  "open",
  "received",
  "closed",
  "cancelled",
] as const;
export type PoStatus = (typeof poStatusValues)[number];

export const purchaseOrdersTable = pgTable(
  "purchase_orders",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    poNumber: text("po_number").notNull(),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    contractId: text("contract_id").references(() => contractsTable.id, {
      onDelete: "set null",
    }),
    businessUnit: text("business_unit"),
    site: text("site"),
    status: text("status").$type<PoStatus>().notNull().default("open"),
    orderDate: timestamp("order_date", { withTimezone: true }).notNull(),
    totalUsd: numeric("total_usd", { precision: 16, scale: 2 })
      .notNull()
      .default("0"),
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
    index("po_org_idx").on(t.orgId),
    index("po_supplier_idx").on(t.orgId, t.supplierId),
    // Single-column FK indexes so onDelete enforcement on the referenced
    // parent row uses an index lookup instead of a sequential scan.
    index("po_supplier_fk_idx").on(t.supplierId),
    index("po_contract_fk_idx").on(t.contractId),
    index("po_order_date_idx").on(t.orgId, t.orderDate),
    index("po_business_unit_idx").on(t.orgId, t.businessUnit),
    uniqueIndex("po_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type PurchaseOrderRow = typeof purchaseOrdersTable.$inferSelect;
export type InsertPurchaseOrderRow = typeof purchaseOrdersTable.$inferInsert;

export const poLinesTable = pgTable(
  "po_lines",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    poId: text("po_id")
      .notNull()
      .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: text("item_id").references(() => itemsTable.id, {
      onDelete: "set null",
    }),
    sku: text("sku").notNull(),
    description: text("description").notNull(),
    categoryId: text("category_id").references(() => categoriesTable.id, {
      onDelete: "set null",
    }),
    spendClass: text("spend_class").$type<CategoryClass>().notNull(),
    qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
    uom: text("uom"),
    unitPriceUsd: numeric("unit_price_usd", { precision: 14, scale: 4 }).notNull(),
    extendedUsd: numeric("extended_usd", { precision: 16, scale: 2 }).notNull(),
    orderDate: timestamp("order_date", { withTimezone: true }).notNull(),
    sourceSystem: text("source_system").notNull().default("seed"),
    sourceExternalId: text("source_external_id"),
    sourceSyncedAt: timestamp("source_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("po_lines_org_idx").on(t.orgId),
    index("po_lines_po_idx").on(t.poId),
    index("po_lines_item_idx").on(t.orgId, t.itemId),
    index("po_lines_item_fk_idx").on(t.itemId),
    index("po_lines_sku_idx").on(t.orgId, t.sku),
    index("po_lines_category_idx").on(t.orgId, t.categoryId),
    index("po_lines_category_fk_idx").on(t.categoryId),
    index("po_lines_spend_class_idx").on(t.orgId, t.spendClass),
    index("po_lines_order_date_idx").on(t.orgId, t.orderDate),
    uniqueIndex("po_lines_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type PoLineRow = typeof poLinesTable.$inferSelect;
export type InsertPoLineRow = typeof poLinesTable.$inferInsert;
