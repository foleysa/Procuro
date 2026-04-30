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
import { purchaseOrdersTable } from "./purchaseOrders";

export const invoiceStatusValues = [
  "received",
  "approved",
  "paid",
  "disputed",
  "void",
] as const;
export type InvoiceStatus = (typeof invoiceStatusValues)[number];

export const invoicesTable = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    invoiceNumber: text("invoice_number").notNull(),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    poId: text("po_id").references(() => purchaseOrdersTable.id, {
      onDelete: "set null",
    }),
    invoiceDate: timestamp("invoice_date", { withTimezone: true }).notNull(),
    amountUsd: numeric("amount_usd", { precision: 16, scale: 2 }).notNull(),
    status: text("status").$type<InvoiceStatus>().notNull().default("received"),
    /** Hash used for duplicate-payment detection */
    dedupKey: text("dedup_key").notNull(),
    sourceSystem: text("source_system").notNull().default("seed"),
    sourceExternalId: text("source_external_id"),
    sourceSyncedAt: timestamp("source_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("invoices_org_idx").on(t.orgId),
    index("invoices_supplier_idx").on(t.orgId, t.supplierId),
    index("invoices_po_idx").on(t.orgId, t.poId),
    index("invoices_dedup_idx").on(t.orgId, t.dedupKey),
    uniqueIndex("invoices_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type InvoiceRow = typeof invoicesTable.$inferSelect;
export type InsertInvoiceRow = typeof invoicesTable.$inferInsert;

export const paymentsTable = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "cascade" }),
    paidDate: timestamp("paid_date", { withTimezone: true }).notNull(),
    amountUsd: numeric("amount_usd", { precision: 16, scale: 2 }).notNull(),
    paymentTermsDays: integer("payment_terms_days"),
    sourceSystem: text("source_system").notNull().default("seed"),
    sourceExternalId: text("source_external_id"),
    sourceSyncedAt: timestamp("source_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("payments_org_idx").on(t.orgId),
    index("payments_invoice_idx").on(t.invoiceId),
    uniqueIndex("payments_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type PaymentRow = typeof paymentsTable.$inferSelect;
export type InsertPaymentRow = typeof paymentsTable.$inferInsert;
