import { describe, expect, it } from "vitest";
import {
  DATA_FACTORY_SOURCES,
  TIER1_SOURCE_IDS,
  TIER2_SOURCE_IDS,
  TIER15_SOURCE_IDS,
  TIER15B_SOURCE_IDS,
  NEWS_OSINT_SOURCE_IDS,
  LICENSE_REQUIRED_PLACEHOLDER_IDS,
  getDataFactorySource,
  listDataFactorySources,
  listNewsOsintSources,
  listTier1Sources,
  listTier15Sources,
  listTier15bSources,
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

  it("lists the Tier 1.5 free gap pack and reuses GDACS from news/OSINT", () => {
    const tier15 = listTier15Sources();
    expect(tier15.map((s) => s.id)).toEqual([...TIER15_SOURCE_IDS]);
    expect(TIER15_SOURCE_IDS).toHaveLength(13);
    expect([...TIER15_SOURCE_IDS]).toContain("src_wits");
    expect([...TIER15_SOURCE_IDS]).toContain("src_eurostat");
    expect([...TIER15_SOURCE_IDS]).toContain("src_eurostat_comext");
    expect([...TIER15_SOURCE_IDS]).toContain("src_ted_europa");
    expect([...TIER15_SOURCE_IDS]).toContain("src_opensanctions");
    expect([...TIER15_SOURCE_IDS]).toContain("src_gleif");
    expect([...TIER15_SOURCE_IDS]).toContain("src_faostat");
    expect([...TIER15_SOURCE_IDS]).toContain("src_oecd_sdmx");
    expect([...TIER15_SOURCE_IDS]).toContain("src_bea");
    expect([...TIER15_SOURCE_IDS]).toContain("src_reliefweb");
    expect([...TIER15_SOURCE_IDS]).toContain("src_gdacs");
    expect([...TIER15_SOURCE_IDS]).toContain("src_opensky");
    expect([...TIER15_SOURCE_IDS]).toContain("src_aishub");
    expect(getDataFactorySource("src_gdacs")?.day0Tier).toBe("news_osint");
    expect(getDataFactorySource("src_eurostat")?.existingCollectorId).toBe(
      "eurostat-economic-index",
    );
    expect(getDataFactorySource("src_opensanctions")?.existingCollectorId).toBe(
      "opensanctions",
    );
    expect(getDataFactorySource("src_gleif")?.existingCollectorId).toBe(
      "gleif-lei",
    );
    expect(getDataFactorySource("src_aishub")?.fetchStatus).toBe("stub");
    expect(getDataFactorySource("src_aishub")?.licenseClass).toBe(
      "free_registration",
    );
  });

  it("lists optional Tier 1.5b stubs", () => {
    const tier15b = listTier15bSources();
    expect(tier15b.map((s) => s.id)).toEqual([...TIER15B_SOURCE_IDS]);
    expect(TIER15B_SOURCE_IDS).toHaveLength(4);
    expect(getDataFactorySource("src_companies_house")?.existingCollectorId).toBe(
      "companies-house",
    );
    expect(getDataFactorySource("src_uflpa")?.scrapePosture).toBe(
      "careful_public_page",
    );
  });

  it("does not catalog paid MarineTraffic", () => {
    expect(getDataFactorySource("src_marinetraffic")).toBeUndefined();
    expect(DATA_FACTORY_SOURCES.some((s) => /marinetraffic/i.test(s.id))).toBe(
      false,
    );
    expect(DATA_FACTORY_SOURCES.some((s) => /marinetraffic/i.test(s.name))).toBe(
      false,
    );
    expect([...TIER15_SOURCE_IDS]).not.toContain("src_marinetraffic");
    expect([...LICENSE_REQUIRED_PLACEHOLDER_IDS]).not.toContain(
      "src_marinetraffic",
    );
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
