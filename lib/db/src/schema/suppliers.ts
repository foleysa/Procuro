import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

export const suppliersTable = pgTable(
  "suppliers",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    countryCode: text("country_code"),
    paymentTermsDays: text("payment_terms_days"),
    isStrategic: boolean("is_strategic").notNull().default(false),
    isPreferred: boolean("is_preferred").notNull().default(false),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
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
    index("suppliers_org_idx").on(t.orgId),
    index("suppliers_name_idx").on(t.orgId, t.normalizedName),
    uniqueIndex("suppliers_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type SupplierRow = typeof suppliersTable.$inferSelect;
export type InsertSupplierRow = typeof suppliersTable.$inferInsert;
