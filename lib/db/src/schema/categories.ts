import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgsTable } from "./orgs";

export const categoryClassValues = ["direct", "indirect", "service"] as const;
export type CategoryClass = (typeof categoryClassValues)[number];

export const categoriesTable = pgTable(
  "categories",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    class: text("class").$type<CategoryClass>().notNull(),
    parentId: text("parent_id"),
    /**
     * UNSPSC code (e.g. "81111500") for cross-walks into external taxonomy
     * data sets. Nullable; populated by ingest mappers (e.g. Coupa) or
     * manual classification. See Task #214.
     */
    unspscCode: text("unspsc_code"),
    /**
     * UNSPSC family — first 2 segments of the code (e.g. "8111"). Stored
     * separately so the analyzer can group by family without parsing the
     * full code on every query.
     */
    unspscFamily: text("unspsc_family"),
    /**
     * NAICS code (e.g. "541611" — Administrative Management Consulting).
     * Nullable; complements UNSPSC for North American industry mapping.
     */
    naicsCode: text("naics_code"),
    /**
     * Canonical raw-material code from `scope-taxonomy.ts`
     * (`CANONICAL_MATERIAL_CODES`: `IRON_STEEL`, `PLASTIC_RESINS`,
     * `LUMBER`, `CRUDE_PETROLEUM`, etc.). Tagged on a tenant category
     * to declare "this category consumes this raw input", which lets
     * the `material_index_arbitrage` Tier-4 lever (#62) join FRED
     * material PPI signals to the category's contracts even when the
     * tenant's `code` doesn't follow the canonical naming convention.
     *
     * Nullable; the lever falls back to the alias-name match in
     * `MATERIAL_TO_CATEGORY_CODES` when the column is unset, so this
     * is a precision tag, not a hard requirement. Stored as text
     * (no FK) because the canonical list is a TS literal type, not a
     * DB-backed enum.
     */
    materialCode: text("material_code"),
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
    index("categories_org_idx").on(t.orgId),
    uniqueIndex("categories_org_code_uq").on(t.orgId, t.code),
    index("categories_class_idx").on(t.orgId, t.class),
    index("categories_unspsc_family_idx").on(t.orgId, t.unspscFamily),
    index("categories_naics_idx").on(t.orgId, t.naicsCode),
    // Drives the `material_index_arbitrage` lever's per-material join:
    // for each FRED material PPI signal in window, the lever filters
    // categories on (orgId, materialCode) — a partial index keeps the
    // index small (most categories never carry a material tag).
    index("categories_material_code_idx")
      .on(t.orgId, t.materialCode)
      .where(sql`material_code IS NOT NULL`),
    uniqueIndex("categories_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type CategoryRow = typeof categoriesTable.$inferSelect;
export type InsertCategoryRow = typeof categoriesTable.$inferInsert;
