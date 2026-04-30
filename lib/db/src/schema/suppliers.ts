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
    uniqueIndex("suppliers_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type SupplierRow = typeof suppliersTable.$inferSelect;
export type InsertSupplierRow = typeof suppliersTable.$inferInsert;
