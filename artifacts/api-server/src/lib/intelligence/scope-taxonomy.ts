/**
 * Canonical procurement scope taxonomy.
 *
 * `market_signals` rows are scoped by one of:
 *   - `scope_material_code` (e.g. raw inputs like steel, resin, lumber)
 *   - `scope_category_code` (e.g. service / logistics categories)
 *
 * Each tenant ingests their own `categories` rows (via CSV / ERP sync), but
 * the *codes* come from the same canonical taxonomy. A tenant whose category
 * `code = "FREIGHT_TRUCKING_TL"` is automatically matched to a FRED PPI
 * signal scoped to the same code, so analyzers can do a stable string-match
 * join without per-tenant configuration.
 *
 * This file is the single source of truth for:
 *
 *   1. The canonical scope codes used across collectors AND analyzers.
 *   2. The FRED series → canonical scope mapping (so the collector and the
 *      `spot_vs_contract` lever can never disagree about what "IRON_STEEL"
 *      means).
 *
 * Adding a new FRED series: add an entry to `FRED_SERIES_CATALOG` with the
 * canonical scope; the collector picks it up automatically.
 *
 * Adding a new collector that wants to emit canonical scope codes: import
 * `CANONICAL_MATERIAL_CODES` / `CANONICAL_CATEGORY_CODES` and use them
 * directly so signals from different feeds line up on the same codes.
 */

/** Canonical material codes used as `market_signals.scope_material_code`. */
export const CANONICAL_MATERIAL_CODES = [
  // Metals
  "IRON_STEEL",
  "STEEL_MILL_PRODUCTS",
  "NONFERROUS_METALS",
  // Chemicals & polymers
  "INDUSTRIAL_CHEMICALS",
  "PLASTIC_RESINS",
  // Wood & paper
  "LUMBER",
  "PULP_PAPER",
  // Energy
  "CRUDE_PETROLEUM",
  "NATURAL_GAS_INDUSTRIAL",
  "FUELS_AND_POWER",
] as const;
export type CanonicalMaterialCode = (typeof CANONICAL_MATERIAL_CODES)[number];

/** Canonical category codes used as `market_signals.scope_category_code`. */
export const CANONICAL_CATEGORY_CODES = [
  // Freight & logistics (services-side PCU codes — scoped as categories)
  "FREIGHT_TRUCKING_TL",
  "FREIGHT_TRUCKING_LTL",
  "RAIL_FREIGHT",
  "WAREHOUSING_STORAGE",
  "FREIGHT_BROKERAGE",

  // ─── Services-side codes (Task #214) ───────────────────────────────
  // Each tower below carries 3-7 sub-codes covering the bulk of F500
  // services spend. Band assignments live in `lib/db/seeds/taxonomy.sql`
  // (see Task #214 step 8). Once Task #3 collectors emit signals scoped
  // to these codes, routing fires automatically via `category_bands`.

  // Professional Services
  "PROF_CONSULTING_STRATEGY",
  "PROF_CONSULTING_OPS",
  "PROF_LEGAL",
  "PROF_AUDIT_TAX",
  "PROF_M_AND_A_ADVISORY",

  // IT / SaaS
  "IT_APP_DEV",
  "IT_INFRA",
  "IT_CYBER",
  "IT_SAAS",
  "IT_MANAGED_SERVICES",
  "IT_HELP_DESK",

  // HR / Contingent Labor
  "HR_CONTINGENT_LABOR",
  "HR_RECRUITING",
  "HR_TRAINING",
  "HR_PAYROLL_BENEFITS",

  // Marketing & Creative
  "MKT_AGENCY_CREATIVE",
  "MKT_MEDIA_BUYING",
  "MKT_PR",
  "MKT_EVENTS_TRADE_SHOWS",
  "MKT_RESEARCH",
  "MKT_MARTECH_SAAS",

  // Facilities
  "FAC_JANITORIAL",
  "FAC_SECURITY",
  "FAC_MAINTENANCE",
  "FAC_LANDSCAPING",
  "FAC_CATERING",
  "FAC_LEASES",
  "FAC_UTILITIES",

  // Logistics (extended — existing freight/warehousing codes above stay)
  "LOG_FREIGHT_OCEAN",
  "LOG_FREIGHT_AIR",
  "LOG_LAST_MILE",
  "LOG_3PL",
  "LOG_CUSTOMS_BROKERAGE",
  "LOG_PARCEL",

  // Telecom
  "TEL_NETWORK",
  "TEL_WIRELESS",
  "TEL_CONFERENCING",

  // Travel & Expense
  "TRV_TMC",
  "TRV_AIR",
  "TRV_HOTEL",
  "TRV_GROUND",

  // Financial Services
  "FIN_BANKING",
  "FIN_INSURANCE",
  "FIN_TREASURY",
  "FIN_AUDIT_EXTERNAL",

  // Engineering Services
  "ENG_RND",
  "ENG_DESIGN",
  "ENG_TESTING_CERT",
] as const;
export type CanonicalCategoryCode = (typeof CANONICAL_CATEGORY_CODES)[number];

/** The kind of scope this code populates on a market_signal row. */
export type CanonicalScope =
  | { kind: "material"; code: CanonicalMaterialCode }
  | { kind: "category"; code: CanonicalCategoryCode };

interface FredSeriesEntry {
  /** FRED series id (e.g. "WPU101"). */
  seriesId: string;
  /** Human-readable label (also used in collector audit + opportunity rationale). */
  label: string;
  /** Canonical procurement scope this series maps to. */
  scope: CanonicalScope;
  /** Unit reported in the market_signals row. FRED PPIs are index numbers. */
  unit: string;
}

/**
 * Curated FRED PPI series → canonical procurement scope mapping.
 *
 * Selection criteria: each series is a stable, widely-cited PPI sub-index
 * with a clear procurement mapping (raw material category or service /
 * logistics category). Material codes line up with raw inputs; PCU
 * (industry) codes line up with service categories.
 *
 * This list is the only place where FRED series ids live — the collector
 * iterates over it, and the `spot_vs_contract` analyzer derives its set of
 * "canonical FRED scope codes" from it.
 */
export const FRED_SERIES_CATALOG: readonly FredSeriesEntry[] = [
  // Metals
  {
    seriesId: "WPU101",
    label: "PPI: Iron and steel",
    scope: { kind: "material", code: "IRON_STEEL" },
    unit: "index",
  },
  {
    seriesId: "WPU1017",
    label: "PPI: Steel mill products",
    scope: { kind: "material", code: "STEEL_MILL_PRODUCTS" },
    unit: "index",
  },
  {
    seriesId: "WPU102",
    label: "PPI: Nonferrous metals",
    scope: { kind: "material", code: "NONFERROUS_METALS" },
    unit: "index",
  },
  // Chemicals & polymers
  {
    seriesId: "WPU0571",
    label: "PPI: Industrial chemicals",
    scope: { kind: "material", code: "INDUSTRIAL_CHEMICALS" },
    unit: "index",
  },
  {
    seriesId: "WPU072",
    label: "PPI: Plastic resins and materials",
    scope: { kind: "material", code: "PLASTIC_RESINS" },
    unit: "index",
  },
  // Wood & paper
  {
    seriesId: "WPU0911",
    label: "PPI: Lumber",
    scope: { kind: "material", code: "LUMBER" },
    unit: "index",
  },
  {
    seriesId: "WPU0913",
    label: "PPI: Pulp, paper, and allied products",
    scope: { kind: "material", code: "PULP_PAPER" },
    unit: "index",
  },
  // Energy
  {
    seriesId: "WPU0561",
    label: "PPI: Crude petroleum (domestic production)",
    scope: { kind: "material", code: "CRUDE_PETROLEUM" },
    unit: "index",
  },
  {
    seriesId: "WPU057303",
    label: "PPI: Natural gas to industrial users",
    scope: { kind: "material", code: "NATURAL_GAS_INDUSTRIAL" },
    unit: "index",
  },
  {
    seriesId: "WPU061",
    label: "PPI: Fuels and related products and power",
    scope: { kind: "material", code: "FUELS_AND_POWER" },
    unit: "index",
  },
  // Freight & logistics
  {
    seriesId: "PCU484121484121",
    label: "PPI: General freight trucking, long-distance, truckload",
    scope: { kind: "category", code: "FREIGHT_TRUCKING_TL" },
    unit: "index",
  },
  {
    seriesId: "PCU484122484122",
    label: "PPI: General freight trucking, long-distance, less than truckload",
    scope: { kind: "category", code: "FREIGHT_TRUCKING_LTL" },
    unit: "index",
  },
  {
    seriesId: "PCU482111482111",
    label: "PPI: Line-haul railroads",
    scope: { kind: "category", code: "RAIL_FREIGHT" },
    unit: "index",
  },
  {
    seriesId: "PCU493110493110",
    label: "PPI: Warehousing and storage",
    scope: { kind: "category", code: "WAREHOUSING_STORAGE" },
    unit: "index",
  },
  {
    seriesId: "PCU488510488510",
    label: "PPI: Freight transportation arrangement",
    scope: { kind: "category", code: "FREIGHT_BROKERAGE" },
    unit: "index",
  },
];

/**
 * Canonical category codes that a FRED PPI series currently scopes to.
 * Analyzers use this as the LHS of a category.code equality join.
 */
export const FRED_CATEGORY_SCOPE_CODES: readonly CanonicalCategoryCode[] =
  Array.from(
    new Set(
      FRED_SERIES_CATALOG.filter(
        (e): e is FredSeriesEntry & { scope: { kind: "category"; code: CanonicalCategoryCode } } =>
          e.scope.kind === "category",
      ).map((e) => e.scope.code),
    ),
  );

/**
 * Canonical material codes that a FRED PPI series currently scopes to.
 * Analyzers use this for material-level matches (e.g. items with a tag).
 */
export const FRED_MATERIAL_SCOPE_CODES: readonly CanonicalMaterialCode[] =
  Array.from(
    new Set(
      FRED_SERIES_CATALOG.filter(
        (e): e is FredSeriesEntry & { scope: { kind: "material"; code: CanonicalMaterialCode } } =>
          e.scope.kind === "material",
      ).map((e) => e.scope.code),
    ),
  );

/** Look up the canonical scope for a FRED series id. */
export function fredScopeForSeriesId(
  seriesId: string,
): CanonicalScope | undefined {
  return FRED_SERIES_CATALOG.find((e) => e.seriesId === seriesId)?.scope;
}

/**
 * Look up FRED series entries that map to a given canonical scope code.
 * Used by analyzers to surface the FRED label/series id alongside the
 * matched market_signal in opportunity rationale.
 */
export function fredSeriesForScopeCode(
  code: string,
): readonly FredSeriesEntry[] {
  return FRED_SERIES_CATALOG.filter((e) => e.scope.code === code);
}

/**
 * Material → tenant category-code aliases.
 *
 * The `spot_vs_contract` lever matches signals to tenant categories on
 * the **service-side** PCU codes (FREIGHT_TRUCKING_TL etc.) where the
 * FRED scope code is identical to a canonical tenant category code.
 *
 * The `material_index_arbitrage` lever (#62) instead matches tenant
 * categories that *consume a raw material* whose PPI we track. Tenant
 * categories don't reliably encode the raw input in their `code`, so we
 * keep a curated mapping here from each FRED material scope to the set
 * of tenant category-code aliases that procurement teams commonly use
 * for that input. Match is case-insensitive equality on `category.code`.
 *
 * Adding a new material → category alias
 * --------------------------------------
 *   1. Pick the canonical material whose FRED PPI most closely tracks
 *      the input cost the buyer actually pays. When in doubt, prefer
 *      the broader index over the narrower one (e.g. specialty resins
 *      → PLASTIC_RESINS rather than INDUSTRIAL_CHEMICALS) so the lever
 *      fires; a more specific series can be added to FRED_SERIES_CATALOG
 *      later and the alias migrates automatically.
 *   2. Add the upper-case category code under that material's alias
 *      list below. Aliases must be **unique across materials** — the
 *      reverse lookup returns the first match, so the same code under
 *      two materials would silently shadow one. The taxonomy test pins
 *      this invariant.
 *   3. Pin the new alias in `test/intelligence-scope-taxonomy.test.ts`
 *      so a typo or accidental removal fails CI.
 *   4. (Optional) extend `FRED_SERIES_CATALOG` if a more specific PPI
 *      series exists for the alias's input grade.
 *
 * Coverage notes
 * --------------
 *   - Copper and aluminum do not have dedicated FRED catalog entries
 *     (yet); their PPI rolls up into `NONFERROUS_METALS` (WPU102). We
 *     still surface tenant category aliases here so the lever fires on
 *     copper/aluminum spend; if a more specific series is added later
 *     the aliases automatically migrate.
 *   - "FUEL" and "DIESEL" intentionally map to FUELS_AND_POWER rather
 *     than CRUDE_PETROLEUM — the buyer is paying refined-fuel rack
 *     prices, not Brent. The same applies to bunker / marine fuel,
 *     LPG, propane, and heating oil — all refined products that track
 *     the FUELS_AND_POWER aggregate more closely than crude.
 *   - Resin grade abbreviations (PET, HDPE, LDPE, PP, PC, …) are
 *     deliberately listed alongside their long names because tenant
 *     ERP feeds use both forms interchangeably.
 *   - Stainless and carbon steels are folded into IRON_STEEL rather
 *     than NONFERROUS_METALS even though stainless contains chromium /
 *     nickel — the dominant input cost is still iron-ore + scrap.
 */
export const MATERIAL_TO_CATEGORY_CODES: Readonly<
  Record<CanonicalMaterialCode, readonly string[]>
> = {
  IRON_STEEL: [
    "IRON_STEEL",
    "STEEL",
    "STEEL_PLATE",
    "STEEL_COIL",
    "STEEL_SHEET",
    "HOT_ROLLED_STEEL",
    "COLD_ROLLED_STEEL",
    "GALVANIZED_STEEL",
    "STAINLESS_STEEL",
    "CARBON_STEEL",
    "ALLOY_STEEL",
    "TIN_PLATE",
    "REBAR",
    "STRUCTURAL_STEEL",
  ],
  STEEL_MILL_PRODUCTS: [
    "STEEL_MILL_PRODUCTS",
    "STEEL_TUBE",
    "STEEL_PIPE",
    "STEEL_BAR",
    "STEEL_WIRE",
  ],
  NONFERROUS_METALS: [
    "NONFERROUS_METALS",
    "COPPER",
    "COPPER_WIRE",
    "COPPER_TUBE",
    "ALUMINUM",
    "ALUMINUM_SHEET",
    "ALUMINUM_EXTRUSION",
    "BRASS",
    "BRONZE",
    "ZINC",
    "NICKEL",
    "TIN",
    "LEAD",
    "TITANIUM",
  ],
  INDUSTRIAL_CHEMICALS: [
    "INDUSTRIAL_CHEMICALS",
    "CHEMICALS",
    "ADHESIVES",
    "SOLVENTS",
    "COATINGS",
    "LUBRICANTS",
    "CAUSTIC_SODA",
    "AMMONIA",
  ],
  PLASTIC_RESINS: [
    "PLASTIC_RESINS",
    "RESIN",
    "PLASTIC_RESIN",
    "POLYETHYLENE",
    "POLYPROPYLENE",
    "PP",
    "HDPE",
    "LDPE",
    "LLDPE",
    "PVC",
    "ABS",
    "POLYSTYRENE",
    "PET",
    "PET_RESIN",
    "POLYCARBONATE",
    "PC_RESIN",
    "NYLON",
  ],
  LUMBER: [
    "LUMBER",
    "WOOD",
    "PLYWOOD",
    "OSB",
    "DIMENSIONAL_LUMBER",
    "HARDWOOD",
    "SOFTWOOD",
    "MDF",
    "PARTICLE_BOARD",
    "ENGINEERED_WOOD",
    "VENEER",
  ],
  PULP_PAPER: [
    "PULP_PAPER",
    "PAPER",
    "PULP",
    "CORRUGATED",
    "CARDBOARD",
    "PAPERBOARD",
    "BOXBOARD",
    "KRAFT_PAPER",
    "LINERBOARD",
    "NEWSPRINT",
    "PACKAGING_PAPER",
    "PRINTING_PAPER",
  ],
  CRUDE_PETROLEUM: ["CRUDE_PETROLEUM", "CRUDE_OIL"],
  NATURAL_GAS_INDUSTRIAL: [
    "NATURAL_GAS_INDUSTRIAL",
    "NATURAL_GAS",
    "INDUSTRIAL_GAS",
  ],
  FUELS_AND_POWER: [
    "FUELS_AND_POWER",
    "FUEL",
    "DIESEL",
    "GASOLINE",
    "JET_FUEL",
    "BUNKER_FUEL",
    "MARINE_FUEL",
    "HEATING_OIL",
    "PROPANE",
    "LPG",
    "ELECTRICITY",
    "POWER",
  ],
};

/**
 * Reverse lookup: given a tenant `category.code`, return the canonical
 * material code (if any) it maps to. Used by analyzers that scan a
 * tenant's category list and want to attach the right PPI series.
 *
 * Returns `null` when the code is not a known material alias. Match is
 * case-insensitive on `code`.
 */
export function materialCodeForCategoryCode(
  categoryCode: string | null | undefined,
): CanonicalMaterialCode | null {
  if (!categoryCode) return null;
  const upper = categoryCode.trim().toUpperCase();
  for (const [material, aliases] of Object.entries(
    MATERIAL_TO_CATEGORY_CODES,
  )) {
    if (aliases.includes(upper)) {
      return material as CanonicalMaterialCode;
    }
  }
  return null;
}
