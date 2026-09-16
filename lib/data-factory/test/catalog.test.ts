import { describe, expect, it } from "vitest";
import {
  DATA_FACTORY_SOURCES,
  TIER1_SOURCE_IDS,
  TIER2_SOURCE_IDS,
  NEWS_OSINT_SOURCE_IDS,
  LICENSE_REQUIRED_PLACEHOLDER_IDS,
  getDataFactorySource,
  listDataFactorySources,
  listNewsOsintSources,
  listTier1Sources,
  listTier2Sources,
} from "../src/catalog";

const NUMBERED_TIER1_NAMES = [
  "BLS Public Data API v2 (PPI)",
  "FRED API",
  "EIA Open Data API v2",
  "USDA MyMarketNews API",
  "openFDA food enforcement",
  "OFAC SDN CSV/XML downloads",
  "Federal Register API",
  "SEC EDGAR APIs",
  "BTS data.bts.gov Monthly TEU (Socrata)",
  "api.weather.gov alerts",
  "USAspending.gov API",
  "Census Foreign Trade / FT-900 downloads",
  "Census M3 (Manufacturers' Shipments)",
  "World Bank Pink Sheet commodity monthly",
  "UN Comtrade free tier / bulk",
] as const;

describe("Layer A catalog", () => {
  it("cites an http(s) source URL on every feed", () => {
    for (const source of DATA_FACTORY_SOURCES) {
      expect(source.sourceUrl.startsWith("https://"), source.id).toBe(true);
      expect(source.feedUrl.startsWith("https://"), source.id).toBe(true);
    }
  });

  it("does not mark paid-license commercial feeds as fetchable", () => {
    const paid = listDataFactorySources({
      licenseClass: "paid_license_required",
    });
    expect(paid.length).toBeGreaterThan(0);
    for (const source of paid) {
      expect(source.fetchStatus).toBe("license_required");
      expect(source.existingCollectorId).toBeNull();
    }
  });

  it("lists the strengthened Tier 1 map in rank order (all 15 numbered sources)", () => {
    const tier1 = listTier1Sources();
    expect(tier1.map((s) => s.id)).toEqual([...TIER1_SOURCE_IDS]);
    expect(TIER1_SOURCE_IDS).toHaveLength(16);
    expect(tier1[0]?.name).toBe("BLS Public Data API v2 (PPI)");
    expect(tier1[1]?.name).toBe("FRED API");
    expect(tier1[2]?.name).toBe("EIA Open Data API v2");
    const names = new Set(tier1.map((s) => s.name));
    for (const name of NUMBERED_TIER1_NAMES) {
      expect(names.has(name), name).toBe(true);
    }
    expect(names.has("openFDA enforcement recalls (drug/device)")).toBe(true);
  });

  it("lists Tier 2 file/CSV / cite-only sources", () => {
    const tier2 = listTier2Sources();
    expect(tier2.map((s) => s.id)).toEqual([...TIER2_SOURCE_IDS]);
    expect(TIER2_SOURCE_IDS).toHaveLength(16);
    expect(getDataFactorySource("src_cass_freight_index")?.day0Tier).toBe(
      "tier_2",
    );
    expect(getDataFactorySource("src_scfi")?.day0Tier).toBe("tier_2");
    expect(getDataFactorySource("src_cass_freight_index")?.fetchStatus).toBe(
      "license_required",
    );
    expect(getDataFactorySource("src_scfi")?.fetchStatus).toBe(
      "license_required",
    );
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

  it("keeps paid commercial feeds as license_required placeholders (not Cass/SCFI)", () => {
    expect([...LICENSE_REQUIRED_PLACEHOLDER_IDS]).not.toContain(
      "src_cass_freight_index",
    );
    expect([...LICENSE_REQUIRED_PLACEHOLDER_IDS]).not.toContain("src_scfi");
    for (const id of LICENSE_REQUIRED_PLACEHOLDER_IDS) {
      const source = getDataFactorySource(id);
      expect(source?.fetchStatus, id).toBe("license_required");
      expect(source?.day0Tier, id).toBe("license_required");
    }
  });

  it("covers procurement, index, freight, disruption, filings, and news/OSINT", () => {
    const families = new Set(DATA_FACTORY_SOURCES.map((s) => s.family));
    expect([...families].sort()).toEqual([
      "disruption",
      "filing",
      "freight_commodity",
      "index",
      "news_osint",
      "procurement",
    ]);
  });

  it("lists the parallel news/OSINT track (FR reused from Tier 1)", () => {
    const news = listNewsOsintSources();
    expect(news.map((s) => s.id)).toEqual([...NEWS_OSINT_SOURCE_IDS]);
    expect(getDataFactorySource("src_federal_register")?.day0Tier).toBe(
      "tier_1",
    );
    expect(getDataFactorySource("src_google_news_rss")?.fragile).toBe(true);
    expect(getDataFactorySource("src_usgs_quakes")?.day0Tier).toBe(
      "news_osint",
    );
  });

  it("returns undefined for tenant/FSA ids", () => {
    expect(getDataFactorySource("src_tenant_spend")).toBeUndefined();
    expect(getDataFactorySource("src_fsa_client")).toBeUndefined();
  });
});
