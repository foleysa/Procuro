import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { categoriesTable } from "./categories";

export const itemsTable = pgTable(
  "items",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    mfgPartNumber: text("mfg_part_number"),
    description: text("description").notNull(),
    normalizedKey: text("normalized_key").notNull(),
    categoryId: text("category_id").references(() => categoriesTable.id, {
      onDelete: "set null",
    }),
    uom: text("uom"),
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
    index("items_org_idx").on(t.orgId),
    uniqueIndex("items_org_sku_uq").on(t.orgId, t.sku),
    index("items_normalized_idx").on(t.orgId, t.normalizedKey),
    index("items_category_idx").on(t.orgId, t.categoryId),
    index("items_category_fk_idx").on(t.categoryId),
    uniqueIndex("items_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type ItemRow = typeof itemsTable.$inferSelect;
export type InsertItemRow = typeof itemsTable.$inferInsert;
