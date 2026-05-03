/**
 * Starter seed of well-known US public companies used to bootstrap a
 * fresh tenant's watched US-supplier list.
 *
 * Why: the EPA ECHO and OSHA Inspections collectors only poll suppliers
 * whose `countryCode` is `US`/`USA`. A brand-new tenant that has not yet
 * uploaded its supplier master would otherwise see an empty risk
 * timeline forever, because the collectors run with nothing to query.
 *
 * The seed is inserted via `ensureUsSuppliersSeeded()` (see
 * `_us-suppliers.ts`) — only when the tenant has zero US suppliers. As
 * soon as the operator adds (or imports) any US supplier of their own
 * the seed is left alone, and individual seeded rows can be removed
 * via the `DELETE /us-suppliers/:id` admin endpoint.
 *
 * Each entry's `externalId` is stable so the upsert is idempotent
 * across restarts (the unique index on
 * `(org_id, source_system, source_external_id)` enforces this).
 */

export interface UsSupplierSeedEntry {
  /** Stable id suffix — combined with `us_seed_` to form `source_external_id`. */
  externalId: string;
  /** Display name used by the EPA / OSHA collectors as the upstream query string. */
  name: string;
}

/**
 * 20 well-known US public companies spanning sectors that historically
 * generate enough EPA enforcement / OSHA inspection traffic that the
 * supplier-risk timeline starts populating on day one.
 */
export const US_SUPPLIER_SEEDS: readonly UsSupplierSeedEntry[] = [
  { externalId: "apple", name: "Apple Inc." },
  { externalId: "microsoft", name: "Microsoft Corporation" },
  { externalId: "amazon", name: "Amazon.com, Inc." },
  { externalId: "alphabet", name: "Alphabet Inc." },
  { externalId: "meta", name: "Meta Platforms, Inc." },
  { externalId: "walmart", name: "Walmart Inc." },
  { externalId: "exxonmobil", name: "Exxon Mobil Corporation" },
  { externalId: "chevron", name: "Chevron Corporation" },
  { externalId: "jpmorgan", name: "JPMorgan Chase & Co." },
  { externalId: "berkshire", name: "Berkshire Hathaway Inc." },
  { externalId: "johnson-and-johnson", name: "Johnson & Johnson" },
  { externalId: "tesla", name: "Tesla, Inc." },
  { externalId: "procter-and-gamble", name: "Procter & Gamble Company" },
  { externalId: "boeing", name: "Boeing Company" },
  { externalId: "general-electric", name: "General Electric Company" },
  { externalId: "ford", name: "Ford Motor Company" },
  { externalId: "general-motors", name: "General Motors Company" },
  { externalId: "pfizer", name: "Pfizer Inc." },
  { externalId: "coca-cola", name: "Coca-Cola Company" },
  { externalId: "pepsico", name: "PepsiCo, Inc." },
] as const;

/** Source-system tag stamped on every seeded `suppliers` row. */
export const US_SUPPLIER_SEED_SOURCE = "us_supplier_seed";

/** Normalise a supplier name the same way the ingest writer does. */
export function normalizeUsSupplierName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
