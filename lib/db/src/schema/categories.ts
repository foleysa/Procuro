import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
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
    uniqueIndex("categories_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type CategoryRow = typeof categoriesTable.$inferSelect;
export type InsertCategoryRow = typeof categoriesTable.$inferInsert;
