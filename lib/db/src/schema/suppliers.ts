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
    /**
     * ISO 4217 currency code in which this supplier bills the tenant. Null
     * means "unknown / inherits the org base currency". When set and different
     * from the org base currency, the supplier is exposed to FX risk on the
     * USD/<billingCurrency> (or base/<billingCurrency>) pair.
     */
    billingCurrency: text("billing_currency"),
    /**
     * How `billingCurrency` was determined — one of:
     *   `provided`           — operator supplied the value on the supplier CSV
     *   `country`            — auto-detected from `countryCode`
     *   `invoice_iso`        — auto-detected from a 3-letter ISO token in an invoice sample
     *   `invoice_symbol`     — auto-detected from a currency symbol in an invoice sample
     *   `backfill_invoice`   — auto-detected later from PO line descriptions (backfill)
     *   `manual_override`    — set via the Supplier 360 override endpoint
     * Null when `billingCurrency` is null. See
     * `artifacts/api-server/src/lib/suppliers/billing-currency-resolver.ts`.
     */
    billingCurrencySource: text("billing_currency_source"),
    /**
     * Confidence rating for the auto-detected `billingCurrency`: `high`,
     * `medium`, or `low`. `provided` and `manual_override` sources are
     * treated as `high`. Null when `billingCurrency` is null.
     */
    billingCurrencyConfidence: text("billing_currency_confidence"),
    paymentTermsDays: text("payment_terms_days"),
    /**
     * Canonical entity identifier produced by the foundation entity
     * resolver (`@workspace/intelligence/resolveEntity`). Persisting the
     * resolution per supplier lets the supplier-intelligence join key on
     * `metadata.entityUid` and stop relying on `scope_supplier_name`
     * ilike fallback — which silently misses sanctions / corporate
     * filings whenever a supplier is recorded under a name variant.
     *
     * Populated by:
     *   - `pnpm --filter @workspace/scripts run backfill-supplier-entity-uid`
     *     (one-time / periodic batch — calls `resolveDraftEntity` per
     *     supplier with the stored identifiers below).
     *   - The CSV ingest path could be wired to do this inline in a
     *     follow-up; for now the backfill is the single writer.
     *
     * Null when the resolver returned `unresolved` (no identifier and
     * no BQ-name match). Coverage is exposed on the System page so
     * operators can see how many suppliers have a resolved entity.
     */
    entityUid: text("entity_uid"),
    /** Match strategy that produced `entityUid` — see `MatchType` in `@workspace/intelligence`. */
    entityMatchType: text("entity_match_type"),
    /** When `entityUid` was last (re)written. Null when never resolved. */
    entityResolvedAt: timestamp("entity_resolved_at", { withTimezone: true }),
    /**
     * Optional canonical identifiers operators can supply on the
     * supplier CSV / detail page so the resolver can short-circuit to
     * an authoritative match. Storing them per supplier means a re-run
     * of the backfill produces the same `entityUid` deterministically
     * even when BQ is offline.
     */
    lei: text("lei"),
    cik: text("cik"),
    companiesHouseNumber: text("companies_house_number"),
    isStrategic: boolean("is_strategic").notNull().default(false),
    isPreferred: boolean("is_preferred").notNull().default(false),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /**
     * Operator-authored notes on the relationship — surfaced in the
     * Supplier 360 Activity tab. Free-form text, capped at 5000 chars
     * by the PATCH body schema. Mirrors `contracts.internal_notes`.
     */
    internalNotes: text("internal_notes"),
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
    // Lookup by canonical entity uid for the supplier-intelligence join
    // and for the System-page coverage metric. Partial-equivalent: an
    // ordinary btree is fine because most rows will have a non-null
    // value once the backfill has run.
    index("suppliers_entity_uid_idx").on(t.entityUid),
    uniqueIndex("suppliers_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type SupplierRow = typeof suppliersTable.$inferSelect;
export type InsertSupplierRow = typeof suppliersTable.$inferInsert;
