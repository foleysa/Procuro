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

  it("materialCodeForCategoryCode is case-insensitive and tolerant of whitespace", () => {
    assert.equal(materialCodeForCategoryCode("steel"), "IRON_STEEL");
    assert.equal(materialCodeForCategoryCode("  copper  "), "NONFERROUS_METALS");
    assert.equal(materialCodeForCategoryCode("PVC"), "PLASTIC_RESINS");
    assert.equal(materialCodeForCategoryCode("DIESEL"), "FUELS_AND_POWER");
    assert.equal(materialCodeForCategoryCode("UNKNOWN_CODE"), null);
    assert.equal(materialCodeForCategoryCode(""), null);
    assert.equal(materialCodeForCategoryCode(null), null);
  });
});
