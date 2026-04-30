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
    uniqueIndex("categories_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type CategoryRow = typeof categoriesTable.$inferSelect;
export type InsertCategoryRow = typeof categoriesTable.$inferInsert;
