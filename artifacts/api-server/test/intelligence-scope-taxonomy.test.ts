/**
 * Pins the FRED → canonical procurement scope mapping.
 *
 * The collector and the `spot_vs_contract` Tier-2 lever both read from the
 * same `FRED_SERIES_CATALOG`, so the two are guaranteed to agree on what
 * each scope code means. These assertions catch:
 *
 *   - any FRED entry forgetting a canonical scope code
 *   - any divergence between the catalog and the derived "FRED scope codes"
 *     used by the analyzer's `WHERE scope_category_code = ANY(...)` filter
 *   - any new canonical code being added without being added to the FRED
 *     mapping (in which case the derived FRED scope-code lists must
 *     remain a strict subset of the canonical lists)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_CATEGORY_CODES,
  CANONICAL_MATERIAL_CODES,
  FRED_CATEGORY_SCOPE_CODES,
  FRED_MATERIAL_SCOPE_CODES,
  FRED_SERIES_CATALOG,
  MATERIAL_TO_CATEGORY_CODES,
  fredScopeForSeriesId,
  fredSeriesForScopeCode,
  materialCodeForCategoryCode,
} from "../src/lib/intelligence/scope-taxonomy";
import { NASS_SERIES } from "../src/lib/intelligence/collectors/usda-nass-economic-index";

describe("FRED_SERIES_CATALOG", () => {
  it("every series has a canonical material or category scope code", () => {
    for (const entry of FRED_SERIES_CATALOG) {
      assert.ok(
        entry.scope.kind === "material" || entry.scope.kind === "category",
        `${entry.seriesId} has invalid scope kind`,
      );
      const allowed: readonly string[] =
        entry.scope.kind === "material"
          ? CANONICAL_MATERIAL_CODES
          : CANONICAL_CATEGORY_CODES;
      assert.ok(
        allowed.includes(entry.scope.code),
        `${entry.seriesId} → ${entry.scope.code} is not a canonical ${entry.scope.kind} code`,
      );
    }
  });

  it("series ids are unique", () => {
    const ids = FRED_SERIES_CATALOG.map((e) => e.seriesId);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("derived FRED scope-code lists are a subset of the canonical lists", () => {
    for (const c of FRED_CATEGORY_SCOPE_CODES) {
      assert.ok(
        (CANONICAL_CATEGORY_CODES as readonly string[]).includes(c),
        `${c} not in CANONICAL_CATEGORY_CODES`,
      );
    }
    for (const c of FRED_MATERIAL_SCOPE_CODES) {
      assert.ok(
        (CANONICAL_MATERIAL_CODES as readonly string[]).includes(c),
        `${c} not in CANONICAL_MATERIAL_CODES`,
      );
    }
  });

  it("freight categories map to FRED PCU series", () => {
    // The lever's spot-check relies on these specific category codes — pin
    // them so a rename or removal fails this test instead of silently
    // breaking the analyzer.
    for (const code of [
      "FREIGHT_TRUCKING_TL",
      "FREIGHT_TRUCKING_LTL",
      "RAIL_FREIGHT",
      "WAREHOUSING_STORAGE",
      "FREIGHT_BROKERAGE",
    ] as const) {
      const series = fredSeriesForScopeCode(code);
      assert.ok(
        series.length > 0,
        `expected a FRED series mapped to ${code}`,
      );
      assert.ok(
        series.every((s) => /^PCU\d/.test(s.seriesId)),
        `expected FRED ${code} to map to PCU series, got ${series.map((s) => s.seriesId).join(",")}`,
      );
    }
  });

  it("metals/chemicals/energy materials map to FRED WPU series", () => {
    for (const code of [
      "IRON_STEEL",
      "PLASTIC_RESINS",
      "CRUDE_PETROLEUM",
    ] as const) {
      const series = fredSeriesForScopeCode(code);
      assert.ok(series.length > 0, `expected a FRED series mapped to ${code}`);
      assert.ok(
        series.every((s) => /^WPU/.test(s.seriesId)),
        `expected FRED ${code} to map to WPU series, got ${series.map((s) => s.seriesId).join(",")}`,
      );
    }
  });

  it("fredScopeForSeriesId resolves known and rejects unknown ids", () => {
    const scope = fredScopeForSeriesId("WPU101");
    assert.ok(scope);
    assert.equal(scope?.kind, "material");
    assert.equal(scope?.code, "IRON_STEEL");
    assert.equal(fredScopeForSeriesId("DOES_NOT_EXIST"), undefined);
  });
});

describe("MATERIAL_TO_CATEGORY_CODES (#62 mapping)", () => {
  it("covers every canonical material code", () => {
    for (const code of CANONICAL_MATERIAL_CODES) {
      const aliases = MATERIAL_TO_CATEGORY_CODES[code];
      assert.ok(aliases, `${code} missing from MATERIAL_TO_CATEGORY_CODES`);
      assert.ok(aliases.length > 0, `${code} has no aliases`);
      // The canonical code itself must be a self-alias so a tenant
      // category whose code is already canonical lights up.
      assert.ok(
        aliases.includes(code),
        `${code} aliases must include the canonical code itself`,
      );
    }
  });

  it("pins the requested material aliases (#62 spec)", () => {
    const pins: Record<string, string[]> = {
      IRON_STEEL: ["STEEL", "REBAR"],
      PLASTIC_RESINS: ["RESIN", "POLYETHYLENE", "PVC"],
      LUMBER: ["LUMBER", "PLYWOOD"],
      FUELS_AND_POWER: ["FUEL", "DIESEL"],
      NONFERROUS_METALS: ["COPPER", "ALUMINUM"],
    };
    for (const [material, expectedAliases] of Object.entries(pins)) {
      const aliases = MATERIAL_TO_CATEGORY_CODES[
        material as keyof typeof MATERIAL_TO_CATEGORY_CODES
      ];
      for (const a of expectedAliases) {
        assert.ok(
          aliases.includes(a),
          `${material} aliases should include ${a} (#62 spec)`,
        );
      }
    }
  });

  it("pins the extended material alias coverage (Task #141)", () => {
    // Additional clusters of common tenant aliases that the lever
    // should fire on without per-tenant configuration. Each alias
    // below was added in Task #141 — every newly introduced code is
    // pinned so a typo, removal, or rename fails CI before the lever
    // silently stops matching tenant contracts.
    const pins: Record<string, string[]> = {
      // Specific resin grades — extremely common in packaging /
      // injection-molding tenants. Long names + abbreviations both
      // appear in real ERP feeds, so pin both forms.
      PLASTIC_RESINS: [
        "PET",
        "HDPE",
        "LDPE",
        "LLDPE",
        "PP",
        "POLYCARBONATE",
        "PC_RESIN",
      ],
      // Paperboard / pulp grades the original mapping missed.
      PULP_PAPER: [
        "PULP",
        "PAPERBOARD",
        "BOXBOARD",
        "KRAFT_PAPER",
        "LINERBOARD",
        "NEWSPRINT",
      ],
      // Freight-material crossovers — refined fuels that bunker / fleet
      // contracts commonly track and that move with FUELS_AND_POWER.
      FUELS_AND_POWER: [
        "BUNKER_FUEL",
        "MARINE_FUEL",
        "HEATING_OIL",
        "PROPANE",
        "LPG",
      ],
      // Common steel grade aliases — folded into IRON_STEEL because the
      // dominant input cost is still iron-ore + scrap.
      IRON_STEEL: [
        "STEEL_SHEET",
        "STAINLESS_STEEL",
        "CARBON_STEEL",
        "ALLOY_STEEL",
        "TIN_PLATE",
      ],
      // Engineered-wood aliases that consume the same softwood /
      // hardwood inputs the LUMBER PPI tracks.
      LUMBER: ["MDF", "PARTICLE_BOARD", "ENGINEERED_WOOD", "VENEER"],
      // Specialty nonferrous metals that roll up to WPU102.
      NONFERROUS_METALS: ["BRONZE", "LEAD", "TITANIUM"],
      // Industrial chemicals — heavy-tonnage commodity inputs.
      INDUSTRIAL_CHEMICALS: ["LUBRICANTS", "CAUSTIC_SODA", "AMMONIA"],
    };
    for (const [material, expectedAliases] of Object.entries(pins)) {
      const aliases = MATERIAL_TO_CATEGORY_CODES[
        material as keyof typeof MATERIAL_TO_CATEGORY_CODES
      ];
      for (const a of expectedAliases) {
        assert.ok(
          aliases.includes(a),
          `${material} aliases should include ${a} (#141 spec)`,
        );
      }
    }
  });

  it("aliases are unique across canonical materials", () => {
    // The reverse lookup `materialCodeForCategoryCode` returns the first
    // material whose alias list contains the code. If the same alias
    // appeared under two materials, one would silently shadow the other
    // depending on object iteration order. The docblock pins this
    // invariant — guard it here so accidental duplicates fail CI.
    const seen = new Map<string, string>();
    for (const [material, aliases] of Object.entries(MATERIAL_TO_CATEGORY_CODES)) {
      for (const alias of aliases) {
        const key = alias.toUpperCase();
        const prior = seen.get(key);
        assert.ok(
          prior === undefined,
          `alias ${alias} appears under both ${prior} and ${material}`,
        );
        seen.set(key, material);
      }
    }
  });

  it("aliases within a single material are unique (no accidental dupes)", () => {
    for (const [material, aliases] of Object.entries(MATERIAL_TO_CATEGORY_CODES)) {
      const upper = aliases.map((a) => a.toUpperCase());
      assert.equal(
        new Set(upper).size,
        upper.length,
        `${material} contains duplicate aliases: ${upper.join(", ")}`,
      );
    }
  });

  it("materialCodeForCategoryCode is case-insensitive and tolerant of whitespace", () => {
    assert.equal(materialCodeForCategoryCode("steel"), "IRON_STEEL");
    assert.equal(materialCodeForCategoryCode("  copper  "), "NONFERROUS_METALS");
    assert.equal(materialCodeForCategoryCode("PVC"), "PLASTIC_RESINS");
    assert.equal(materialCodeForCategoryCode("DIESEL"), "FUELS_AND_POWER");
    assert.equal(materialCodeForCategoryCode("UNKNOWN_CODE"), null);
    assert.equal(materialCodeForCategoryCode(""), null);
    assert.equal(materialCodeForCategoryCode(null), null);
  });

  it("pins the USDA NASS agricultural material aliases (Task #253)", () => {
    // Each NASS series materialCode (CORN, WHEAT, SOYBEANS, MILK,
    // CHEESE, BUTTER, BEEF_CATTLE, HOGS, BROILERS, COTTON) must be
    // wired into MATERIAL_TO_CATEGORY_CODES so food/dairy/meat/cotton
    // category pages surface NASS observations alongside (or instead
    // of) the World Bank Pink Sheet equivalents. A future refactor
    // that drops one of these will fail this test before tenants
    // silently lose the lever.
    const pins: Record<string, string[]> = {
      CORN: ["CORN", "MAIZE", "FEED_CORN"],
      WHEAT: ["WHEAT", "WHEAT_FLOUR", "FLOUR"],
      SOYBEANS: ["SOYBEANS", "SOY", "SOY_OIL", "SOYMEAL"],
      MILK: ["MILK", "FLUID_MILK", "RAW_MILK"],
      CHEESE: ["CHEESE", "CHEESE_BLOCK"],
      BUTTER: ["BUTTER"],
      BEEF_CATTLE: ["BEEF_CATTLE", "BEEF", "CATTLE"],
      HOGS: ["HOGS", "PORK", "PIGS"],
      BROILERS: ["BROILERS", "CHICKEN", "POULTRY"],
      COTTON: ["COTTON", "RAW_COTTON", "UPLAND_COTTON"],
    };
    for (const [material, expectedAliases] of Object.entries(pins)) {
      const aliases = MATERIAL_TO_CATEGORY_CODES[
        material as keyof typeof MATERIAL_TO_CATEGORY_CODES
      ];
      assert.ok(
        aliases,
        `${material} missing from MATERIAL_TO_CATEGORY_CODES (Task #253)`,
      );
      for (const a of expectedAliases) {
        assert.ok(
          aliases.includes(a),
          `${material} aliases should include ${a} (Task #253 spec)`,
        );
      }
    }
  });

  it("USDA NASS material codes round-trip via materialCodeForCategoryCode", () => {
    // Sanity-check the reverse lookup for every NASS series + a few
    // common tenant aliases. If a future edit shadows one of these
    // under a different canonical material the lever will silently
    // stop matching the right tenant categories.
    assert.equal(materialCodeForCategoryCode("CORN"), "CORN");
    assert.equal(materialCodeForCategoryCode("maize"), "CORN");
    assert.equal(materialCodeForCategoryCode("WHEAT"), "WHEAT");
    assert.equal(materialCodeForCategoryCode("flour"), "WHEAT");
    assert.equal(materialCodeForCategoryCode("SOYBEANS"), "SOYBEANS");
    assert.equal(materialCodeForCategoryCode("soy_oil"), "SOYBEANS");
    assert.equal(materialCodeForCategoryCode("MILK"), "MILK");
    assert.equal(materialCodeForCategoryCode("fluid_milk"), "MILK");
    assert.equal(materialCodeForCategoryCode("CHEESE"), "CHEESE");
    assert.equal(materialCodeForCategoryCode("BUTTER"), "BUTTER");
    assert.equal(materialCodeForCategoryCode("BEEF"), "BEEF_CATTLE");
    assert.equal(materialCodeForCategoryCode("cattle"), "BEEF_CATTLE");
    assert.equal(materialCodeForCategoryCode("PORK"), "HOGS");
    assert.equal(materialCodeForCategoryCode("hogs"), "HOGS");
    assert.equal(materialCodeForCategoryCode("CHICKEN"), "BROILERS");
    assert.equal(materialCodeForCategoryCode("poultry"), "BROILERS");
    assert.equal(materialCodeForCategoryCode("COTTON"), "COTTON");
    assert.equal(materialCodeForCategoryCode("upland_cotton"), "COTTON");
  });

  it("NASS_SERIES material codes are all present in the alias map", () => {
    // Pin the contract between the USDA NASS collector's curated
    // series list and the canonical alias map. We import NASS_SERIES
    // directly so adding a new series without a matching
    // MATERIAL_TO_CATEGORY_CODES entry fails CI here — the omission
    // would silently drop the new series off category pages otherwise.
    for (const series of NASS_SERIES) {
      const code = series.materialCode;
      const aliases =
        MATERIAL_TO_CATEGORY_CODES[
          code as keyof typeof MATERIAL_TO_CATEGORY_CODES
        ];
      assert.ok(aliases, `NASS material ${code} missing from alias map`);
      assert.ok(
        aliases.includes(code),
        `NASS material ${code} must include itself as an alias`,
      );
    }
  });

  it("materialCodeForCategoryCode resolves the new Task #141 aliases", () => {
    // Sanity-check the round-trip for the most-cited new aliases — if
    // someone removes one of these from the map, this test fails before
    // a tenant's contracts silently stop matching the lever.
    assert.equal(materialCodeForCategoryCode("HDPE"), "PLASTIC_RESINS");
    assert.equal(materialCodeForCategoryCode("pet"), "PLASTIC_RESINS");
    assert.equal(materialCodeForCategoryCode("PAPERBOARD"), "PULP_PAPER");
    assert.equal(materialCodeForCategoryCode("kraft_paper"), "PULP_PAPER");
    assert.equal(materialCodeForCategoryCode("BUNKER_FUEL"), "FUELS_AND_POWER");
    assert.equal(materialCodeForCategoryCode("LPG"), "FUELS_AND_POWER");
    assert.equal(materialCodeForCategoryCode("STAINLESS_STEEL"), "IRON_STEEL");
    assert.equal(materialCodeForCategoryCode("MDF"), "LUMBER");
    assert.equal(materialCodeForCategoryCode("titanium"), "NONFERROUS_METALS");
  });
});
