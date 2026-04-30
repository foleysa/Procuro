/**
 * Pin the tenant category → CPI sub-series mapping (#68 CPI pushback).
 *
 * The mapping is the only join between a tenant's free-form category
 * codes and the BLS CPI sub-series the renegotiation lever cites for
 * pushback context. A typo here mis-cites a real opportunity, so we
 * pin both the canonical scope codes and a few human-known aliases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORY_TO_CPI_SCOPE,
  CPI_SCOPE_CODES,
  cpiScopeForCategoryCode,
} from "../src/lib/intelligence/cpi-mapping";

describe("CATEGORY_TO_CPI_SCOPE", () => {
  it("covers every canonical CPI scope code", () => {
    for (const scope of CPI_SCOPE_CODES) {
      const aliases = CATEGORY_TO_CPI_SCOPE[scope];
      assert.ok(aliases, `${scope} missing from CATEGORY_TO_CPI_SCOPE`);
      assert.ok(
        aliases.includes(scope),
        `${scope} aliases must include the canonical scope code itself`,
      );
    }
  });

  it("pins the requested CPI aliases (#68 spec)", () => {
    const pins: Record<string, string[]> = {
      ENERGY: ["UTILITIES", "FUEL_RETAIL"],
      FOOD_AT_HOME: ["FOOD", "GROCERY"],
      TRANSPORTATION_SERVICES: ["TRAVEL", "BUSINESS_TRAVEL"],
      MEDICAL_SERVICES: ["MEDICAL", "HEALTHCARE_SERVICES"],
      APPAREL: ["UNIFORMS", "WORKWEAR"],
    };
    for (const [scope, expected] of Object.entries(pins)) {
      const aliases =
        CATEGORY_TO_CPI_SCOPE[scope as keyof typeof CATEGORY_TO_CPI_SCOPE];
      for (const a of expected) {
        assert.ok(
          aliases.includes(a),
          `${scope} aliases should include ${a} (#68 spec)`,
        );
      }
    }
  });

  it("cpiScopeForCategoryCode is case-insensitive and rejects unknown", () => {
    assert.equal(cpiScopeForCategoryCode("food"), "FOOD_AT_HOME");
    assert.equal(cpiScopeForCategoryCode("  uniforms  "), "APPAREL");
    assert.equal(cpiScopeForCategoryCode("UTILITIES"), "ENERGY");
    assert.equal(cpiScopeForCategoryCode("travel"), "TRANSPORTATION_SERVICES");
    assert.equal(cpiScopeForCategoryCode("STEEL_PLATE"), null);
    assert.equal(cpiScopeForCategoryCode(null), null);
    assert.equal(cpiScopeForCategoryCode(undefined), null);
    assert.equal(cpiScopeForCategoryCode(""), null);
  });
});
