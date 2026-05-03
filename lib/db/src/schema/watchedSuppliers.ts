import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { suppliersTable } from "./suppliers";

/**
 * Tenant-scoped registry of suppliers each tenant wants polled by the
 * federal-procurement collectors (USAspending.gov, SAM.gov). Mirrors
 * `watched_issuers` for corporate-filing sources.
 *
 * Why this exists:
 *   The previous derivation in `loadWatchedSupplierNames` did a
 *   `SELECT DISTINCT name FROM suppliers` across every tenant capped at
 *   50/run (250 in backfill). Most tenants have hundreds of suppliers
 *   but only a handful are strategic, so we wasted the upstream rate
 *   budget on long-tail names that will never produce a hit. With
 *   `watched_suppliers`, only suppliers a tenant has explicitly opted
 *   into (or that are flagged `is_strategic` / `is_preferred` in the
 *   default seed) are polled.
 *
 * Linking back to `suppliers.id` (`supplierUid`) is required: the whole
 * point is to drive enrichment for known tenant suppliers, and the
 * downstream lever code attributes the resulting signal to that
 * supplier card.
 *
 * Uniqueness:
 *   `(orgId, supplierUid)` — a tenant cannot watch the same supplier
 *   twice. Two tenants can independently watch the same underlying
 *   supplier (different `orgId`).
 */
export const watchedSuppliersTable = pgTable(
  "watched_suppliers",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    /**
     * Foreign key into the tenant's supplier master. Cascade-deleted
     * with the supplier — a watch entry without a backing supplier
     * row is meaningless.
     */
    supplierUid: text("supplier_uid")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "cascade" }),
    /**
     * Denormalised supplier display name at the time the watch was
     * created. Used as the upstream query string for USAspending /
     * SAM.gov so renames on the supplier row don't silently change
     * what we poll. Refresh by re-inserting if needed.
     */
    name: text("name").notNull(),
    /**
     * Optional ISO 3166-1 alpha-2 country hint, used by the SAM.gov
     * collector to disambiguate common names. Snapshotted from
     * `suppliers.country_code` at watch time.
     */
    countryCode: text("country_code"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("watched_suppliers_uq").on(t.orgId, t.supplierUid),
    index("watched_suppliers_org_idx").on(t.orgId),
    index("watched_suppliers_name_idx").on(t.name),
  ],
);

export type WatchedSupplierRow = typeof watchedSuppliersTable.$inferSelect;
export type InsertWatchedSupplierRow =
  typeof watchedSuppliersTable.$inferInsert;
