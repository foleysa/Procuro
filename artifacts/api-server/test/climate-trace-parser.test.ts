/**
 * ClimateTRACE asset parser tests.
 *
 * Pins the contract that:
 *   - Co2e_100yr is preferred over Co2 / Co2e_20yr for `value`
 *   - assets without an emissions number or asset id are dropped
 *   - owner name resolves from string / object / array shapes
 *   - schema validates and stable keys are unique per asset id
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseClimateTraceResponse,
  assetToDraft,
  climateTraceCollector,
  type ClimateTraceResponse,
} from "../src/lib/intelligence/collectors/climate-trace";

const PAYLOAD: ClimateTraceResponse = {
  assets: [
    {
      AssetId: 12345,
      Name: "Acme Steel Mill #1",
      Country: "China",
      Iso3Country: "CHN",
      Sector: "steel",
      Subsector: "blast-furnace",
      AssetType: "steel_facility",
      Owner: "Acme Heavy Industries",
      Co2: 1_000_000,
      Co2e_100yr: 1_050_000,
      Co2e_20yr: 1_100_000,
      Confidence: 0.85,
      EmissionsQuantityUnits: "tonnes",
      StartTime: "2025-01-01T00:00:00Z",
      EndTime: "2025-12-31T23:59:59Z",
    },
    {
      AssetId: "67890",
      Name: "Beta Cement Plant",
      Country: "Germany",
      Iso3Country: "DEU",
      Sector: "cement",
      Owner: [{ Name: "Beta Cement AG" }],
      Co2: 500_000, // Only Co2 — fallback path
      Confidence: 0.7,
      EndTime: "2025-12-31T00:00:00Z",
    },
    {
      // No id → dropped
      Name: "Skipme",
      Co2: 1,
    },
    {
      AssetId: 999,
      Name: "NoNumbers",
      // No Co2 fields → dropped
    },
  ],
  total: 4,
};

describe("assetToDraft", () => {
  it("prefers Co2e_100yr for the draft value", () => {
    const drafts = parseClimateTraceResponse(PAYLOAD);
    assert.equal(drafts[0]!.value, 1_050_000);
  });

  it("falls back to Co2 when Co2e_100yr is absent", () => {
    const drafts = parseClimateTraceResponse(PAYLOAD);
    assert.equal(drafts[1]!.value, 500_000);
  });

  it("resolves owner name from string and array forms", () => {
    const drafts = parseClimateTraceResponse(PAYLOAD);
    assert.equal(drafts[0]!.scopeSupplierName, "Acme Heavy Industries");
    assert.equal(drafts[1]!.scopeSupplierName, "Beta Cement AG");
  });

  it("emits ent_climatetrace_owner_<slug> when owner is present", () => {
    const drafts = parseClimateTraceResponse(PAYLOAD);
    assert.equal(drafts[0]!.entityUid, "ent_climatetrace_owner_acme_heavy_industries");
    assert.equal(drafts[1]!.entityUid, "ent_climatetrace_owner_beta_cement_ag");
  });

  it("drops rows missing id or emissions", () => {
    const drafts = parseClimateTraceResponse(PAYLOAD);
    assert.equal(drafts.length, 2);
  });

  it("returns null for malformed assets", () => {
    assert.equal(assetToDraft({}), null);
    assert.equal(assetToDraft({ AssetId: 1, Co2: NaN }), null);
  });
});

describe("parseClimateTraceResponse", () => {
  it("schema validates every produced draft", () => {
    const drafts = parseClimateTraceResponse(PAYLOAD);
    for (const d of drafts) {
      const r = climateTraceCollector.signalSchema.safeParse(d);
      assert.ok(r.success, JSON.stringify(r));
    }
  });

  it("stable signal keys are unique per asset id", () => {
    const drafts = parseClimateTraceResponse(PAYLOAD);
    const keys = drafts.map(climateTraceCollector.stableSignalKey);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("accepts uppercase Assets / data response shapes", () => {
    const alt: ClimateTraceResponse = {
      Assets: [
        { AssetId: 1, Name: "x", Owner: "y", Co2: 100, EndTime: "2025-01-01" },
      ],
    };
    assert.equal(parseClimateTraceResponse(alt).length, 1);
    const alt2: ClimateTraceResponse = {
      data: [
        { AssetId: 2, Name: "x", Owner: "y", Co2: 100, EndTime: "2025-01-01" },
      ],
    };
    assert.equal(parseClimateTraceResponse(alt2).length, 1);
  });
});
