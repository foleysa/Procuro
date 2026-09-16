import { describe, expect, it } from "vitest";
import {
  DATA_FACTORY_SOURCES,
  DAY0_WIRE_FIRST_IDS,
  LICENSE_REQUIRED_PLACEHOLDER_IDS,
  getDataFactorySource,
  listDataFactorySources,
  listWireFirstSources,
} from "../src/catalog";

describe("Layer A catalog", () => {
  it("cites an http(s) source URL on every feed", () => {
    for (const source of DATA_FACTORY_SOURCES) {
      expect(source.sourceUrl.startsWith("https://"), source.id).toBe(true);
      expect(source.feedUrl.startsWith("https://"), source.id).toBe(true);
    }
  });

  it("does not mark paid-license feeds as fetchable", () => {
    const paid = listDataFactorySources({
      licenseClass: "paid_license_required",
    });
    expect(paid.length).toBeGreaterThan(0);
    for (const source of paid) {
      expect(source.fetchStatus).toBe("license_required");
      expect(source.existingCollectorId).toBeNull();
    }
  });

  it("lists the live Day 0 wire-first map in rank order", () => {
    const wired = listWireFirstSources();
    expect(wired.map((s) => s.id)).toEqual([...DAY0_WIRE_FIRST_IDS]);
    expect(wired[0]?.name).toBe("FRED API");
    expect(wired[1]?.name).toBe("EIA API v2");
  });

  it("tags every source Pulse / API / both", () => {
    for (const source of DATA_FACTORY_SOURCES) {
      expect(["pulse", "api", "both"]).toContain(source.channelUse);
    }
    expect(getDataFactorySource("src_openfda_food_enforcement")?.channelUse).toBe(
      "pulse",
    );
    expect(getDataFactorySource("src_fred")?.channelUse).toBe("both");
    expect(getDataFactorySource("src_sam_gov")?.channelUse).toBe("api");
  });

  it("keeps paid commercial feeds as license_required placeholders", () => {
    for (const id of LICENSE_REQUIRED_PLACEHOLDER_IDS) {
      const source = getDataFactorySource(id);
      expect(source?.fetchStatus, id).toBe("license_required");
    }
  });

  it("covers procurement, index, freight, disruption, and filings", () => {
    const families = new Set(DATA_FACTORY_SOURCES.map((s) => s.family));
    expect([...families].sort()).toEqual([
      "disruption",
      "filing",
      "freight_commodity",
      "index",
      "procurement",
    ]);
  });

  it("returns undefined for tenant/FSA ids", () => {
    expect(getDataFactorySource("src_tenant_spend")).toBeUndefined();
    expect(getDataFactorySource("src_fsa_client")).toBeUndefined();
  });
});
