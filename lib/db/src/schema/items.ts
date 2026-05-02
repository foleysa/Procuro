import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
    /**
     * Canonical raw-material code from `scope-taxonomy.ts`
     * (`CANONICAL_MATERIAL_CODES`: `IRON_STEEL`, `PLASTIC_RESINS`,
     * `LUMBER`, `CRUDE_PETROLEUM`, etc.). Tagged on an item to mark
     * it as a buy of that raw input. Mirrors the same column on
     * `categories` so tenants can tag at either grain — the
     * `material_index_arbitrage` Tier-4 lever (#62) consults both
     * (item-level tag wins when both are set on a PO line).
     *
     * Nullable; the lever falls back to the category-level tag and
     * then the alias-name match in `MATERIAL_TO_CATEGORY_CODES`.
     * Stored as text (no FK) — the canonical list is a TS literal
     * type, not a DB-backed enum.
     */
    materialCode: text("material_code"),
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
    // Drives the `material_index_arbitrage` lever's per-material join
    // when tenants tag at the item grain. Partial so the index stays
    // small for tenants that only tag at the category level (or not
    // at all).
    index("items_material_code_idx")
      .on(t.orgId, t.materialCode)
      .where(sql`material_code IS NOT NULL`),
    uniqueIndex("items_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type ItemRow = typeof itemsTable.$inferSelect;
export type InsertItemRow = typeof itemsTable.$inferInsert;
