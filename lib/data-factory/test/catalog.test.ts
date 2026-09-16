import { describe, expect, it } from "vitest";
import {
  DATA_FACTORY_SOURCES,
  getDataFactorySource,
  listDataFactorySources,
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
      expect(source.fetchStatus).toBe("blocked_pending_license");
      expect(source.existingCollectorId).toBeNull();
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

  it("points wired sources at known collector ids", () => {
    const wired = listDataFactorySources({
      fetchStatus: "wired_existing_collector",
    });
    expect(wired.length).toBeGreaterThan(5);
    for (const source of wired) {
      expect(source.existingCollectorId).toBeTruthy();
    }
    expect(getDataFactorySource("src_sam_gov")?.existingCollectorId).toBe(
      "sam-gov",
    );
  });

  it("returns undefined for unknown ids", () => {
    expect(getDataFactorySource("src_tenant_spend")).toBeUndefined();
    expect(getDataFactorySource("src_fsa_client")).toBeUndefined();
  });
});
