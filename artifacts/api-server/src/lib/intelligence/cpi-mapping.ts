/**
 * Tenant category → CPI sub-series mapping (#68 CPI pushback).
 *
 * The BLS economic-index collector emits monthly CPI sub-series (CUUR
 * prefix — CPI-U, NSA, U.S. city average, base 1982-84=100) under
 * canonical `scope_category_code` values. See
 * `artifacts/api-server/src/lib/intelligence/collectors/bls-economic-index.ts`
 * for the live catalog.
 *
 * Supplier price-increase / renegotiation flows want to compare a
 * supplier-implied price ask against the relevant CPI sub-index move
 * over the same window. The lever does *not* try to translate every
 * tenant category into the right CPI series — instead it asks this
 * mapping. The mapping covers:
 *
 *   - the canonical BLS CPI scope codes themselves (so a tenant whose
 *     `category.code` is already canonical lights up with no work)
 *   - common tenant aliases for each (e.g. `FOOD` → `FOOD_AT_HOME`,
 *     `UTILITIES` → `ENERGY`)
 *
 * Adding a new tenant alias
 * -------------------------
 *   1. Add the alias under the matching CPI scope code below.
 *   2. Pin it in `test/cpi-mapping.test.ts` so a typo fails CI.
 *   3. Confirm the alias is *not* a better fit for a more specific
 *      sub-series (e.g. `RETAIL_ELECTRICITY` → `ELECTRICITY_RETAIL`,
 *      not generic `ENERGY`).
 *
 * Conservative coverage
 * ---------------------
 * Direct-materials categories (steel, resin, lumber, freight, …) are
 * intentionally *not* mapped to a CPI series — those should flow
 * through `material_index_arbitrage` (PPI) or `spot_vs_contract`
 * (PCU). CPI is the right benchmark only for end-consumer-priced
 * categories (food, energy, transportation services, medical, etc.).
 */

/** Canonical BLS CPI scope codes the collector emits today. */
export const CPI_SCOPE_CODES = [
  "FOOD_AT_HOME",
  "FOOD_AWAY_FROM_HOME",
  "ENERGY",
  "ELECTRICITY_RETAIL",
  "APPAREL",
  "HOUSEHOLD_FURNISHINGS",
  "TRANSPORTATION_SERVICES",
  "MEDICAL_SERVICES",
] as const;
export type CpiScopeCode = (typeof CPI_SCOPE_CODES)[number];

/** Tenant category-code aliases per CPI scope code. */
export const CATEGORY_TO_CPI_SCOPE: Readonly<
  Record<CpiScopeCode, readonly string[]>
> = {
  FOOD_AT_HOME: [
    "FOOD_AT_HOME",
    "FOOD",
    "GROCERY",
    "GROCERIES",
    "CAFETERIA_FOOD",
  ],
  FOOD_AWAY_FROM_HOME: [
    "FOOD_AWAY_FROM_HOME",
    "RESTAURANT",
    "RESTAURANT_CATERING",
    "CATERING",
    "FOODSERVICE",
  ],
  ENERGY: ["ENERGY", "UTILITIES", "FUEL_RETAIL", "GASOLINE_RETAIL"],
  ELECTRICITY_RETAIL: [
    "ELECTRICITY_RETAIL",
    "ELECTRICITY",
    "RETAIL_ELECTRICITY",
  ],
  APPAREL: ["APPAREL", "UNIFORMS", "WORKWEAR", "PPE_APPAREL"],
  HOUSEHOLD_FURNISHINGS: [
    "HOUSEHOLD_FURNISHINGS",
    "FURNITURE",
    "OFFICE_FURNITURE",
    "FACILITIES_FURNITURE",
  ],
  TRANSPORTATION_SERVICES: [
    "TRANSPORTATION_SERVICES",
    "TRAVEL",
    "BUSINESS_TRAVEL",
    "GROUND_TRANSPORT",
  ],
  MEDICAL_SERVICES: [
    "MEDICAL_SERVICES",
    "MEDICAL",
    "HEALTHCARE_SERVICES",
    "OCCUPATIONAL_HEALTH",
  ],
};

/**
 * Lookup the CPI scope code (if any) for a tenant `category.code`.
 *
 * Match is case-insensitive on the trimmed input. Returns `null` for
 * unknown / unmapped codes — the caller MUST treat that as "no CPI
 * context, render the lever's existing rationale unchanged" rather than
 * fabricate a series.
 */
export function cpiScopeForCategoryCode(
  categoryCode: string | null | undefined,
): CpiScopeCode | null {
  if (!categoryCode) return null;
  const upper = categoryCode.trim().toUpperCase();
  for (const [scope, aliases] of Object.entries(CATEGORY_TO_CPI_SCOPE)) {
    if (aliases.includes(upper)) return scope as CpiScopeCode;
  }
  return null;
}
