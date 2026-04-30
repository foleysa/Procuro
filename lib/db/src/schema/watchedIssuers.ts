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
 * Source feeds whose per-issuer poll list is tenant-scoped.
 *
 * - `sec_edgar`        — `identifier` = SEC CIK, zero-padded to 10 chars
 *                        (matches what the collector sends to EDGAR).
 * - `companies_house`  — `identifier` = UK Companies House number,
 *                        zero-padded to 8 chars.
 *
 * Adding a new corporate-filing source means: add the slug here, add a
 * loader in the collector, and surface it on the admin endpoint's
 * source enum.
 */
export const watchedIssuerSourceValues = [
  "sec_edgar",
  "companies_house",
] as const;
export type WatchedIssuerSource = (typeof watchedIssuerSourceValues)[number];

/**
 * Tenant-scoped registry of corporate-filing issuers each tenant wants
 * polled. Replaces the previously hard-coded `SEC_EDGAR_DEFAULT_ISSUERS`
 * and `COMPANIES_HOUSE_DEFAULT_NUMBERS` arrays — the collectors now read
 * the union of every tenant's watch list (deduped on identifier) so
 * we only spend the upstream rate budget on issuers some tenant
 * actually procures from.
 *
 * Linking back to `suppliers.id` (`supplierUid`) is optional but
 * encouraged: it lets downstream lever code attribute a filing-driven
 * signal directly to the supplier card, instead of relying on a
 * fuzzy name match.
 *
 * Uniqueness:
 *   `(orgId, source, identifier)` — a tenant cannot watch the same
 *   issuer twice on the same source. They CAN watch the same issuer
 *   on both SEC and Companies House (different `source` values), and
 *   two tenants can independently watch the same issuer (different
 *   `orgId`).
 */
export const watchedIssuersTable = pgTable(
  "watched_issuers",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    source: text("source").$type<WatchedIssuerSource>().notNull(),
    /**
     * Source-native identifier:
     *   - SEC EDGAR:       10-digit zero-padded CIK
     *   - Companies House: 8-char zero-padded company number
     */
    identifier: text("identifier").notNull(),
    /** Issuer / company display name. Used as `scope_supplier_name`. */
    name: text("name").notNull(),
    /** Optional LEI (lets the entity resolver short-circuit). */
    lei: text("lei"),
    /** Optional ticker (SEC-side, human cross-reference). */
    ticker: text("ticker"),
    /**
     * Optional foreign key into the tenant's supplier master. When set,
     * downstream cards can render the filing on the supplier page
     * without fuzzy-matching by name.
     */
    supplierUid: text("supplier_uid").references(() => suppliersTable.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("watched_issuers_uq").on(t.orgId, t.source, t.identifier),
    index("watched_issuers_source_idx").on(t.source),
    index("watched_issuers_supplier_idx").on(t.supplierUid),
  ],
);

export type WatchedIssuerRow = typeof watchedIssuersTable.$inferSelect;
export type InsertWatchedIssuerRow = typeof watchedIssuersTable.$inferInsert;
