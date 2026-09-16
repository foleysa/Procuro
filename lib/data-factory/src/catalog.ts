/**
 * Layer A source catalog — live Day 0 product map.
 *
 * Wire-first (public/open): FRED, EIA v2, openFDA food enforcement,
 * OFAC SDN, api.weather.gov, BTS TEU, POLA/POLB (careful public-page
 * scrape), Cass (cite-only until license).
 *
 * Paid commercial feeds are `license_required` placeholders only.
 * No live fetch. No invented values. No tenant/FSA data.
 */

import type { DataFactoryObserveKind } from "./layer-c";

export const dataFactorySourceFamilies = [
  "procurement",
  "index",
  "freight_commodity",
  "disruption",
  "filing",
] as const;
export type DataFactorySourceFamily =
  (typeof dataFactorySourceFamilies)[number];

export const dataFactoryLicenseClasses = [
  "public_api",
  "free_registration",
  "paid_license_required",
] as const;
export type DataFactoryLicenseClass =
  (typeof dataFactoryLicenseClasses)[number];

export const dataFactoryFetchStatuses = [
  "wired_existing_collector",
  "stub",
  "license_required",
] as const;
export type DataFactoryFetchStatus =
  (typeof dataFactoryFetchStatuses)[number];

export const dataFactoryDay0Tiers = [
  "wire_first",
  "existing_collector",
  "license_required",
] as const;
export type DataFactoryDay0Tier = (typeof dataFactoryDay0Tiers)[number];

/** Pulse brief vs API product vs both. */
export const dataFactoryChannelUses = ["pulse", "api", "both"] as const;
export type DataFactoryChannelUse = (typeof dataFactoryChannelUses)[number];

export interface DataFactorySource {
  id: string;
  name: string;
  family: DataFactorySourceFamily;
  observeKind: DataFactoryObserveKind;
  channelUse: DataFactoryChannelUse;
  day0Tier: DataFactoryDay0Tier;
  /** 1–8 for wire-first; null otherwise. */
  wireFirstRank: number | null;
  sourceUrl: string;
  feedUrl: string;
  licenseClass: DataFactoryLicenseClass;
  licenseNote: string;
  fetchStatus: DataFactoryFetchStatus;
  existingCollectorId: string | null;
  signalTypes: readonly string[];
  /**
   * POLA/POLB only: public HTML pages, robots-respecting scrape later.
   * Never treat as a licensed commercial index.
   */
  scrapePosture?: "careful_public_page";
}

export const DAY0_WIRE_FIRST_IDS = [
  "src_fred",
  "src_eia",
  "src_openfda_food_enforcement",
  "src_ofac_sdn",
  "src_weather_gov",
  "src_bts_teu",
  "src_pola",
  "src_polb",
  "src_cass_freight_index",
] as const;

export const LICENSE_REQUIRED_PLACEHOLDER_IDS = [
  "src_dat",
  "src_freightos_fbx",
  "src_xeneta",
  "src_drewry",
  "src_sonar",
  "src_lme",
  "src_cme",
  "src_ism_rob",
  "src_sp_commodity_index",
  "src_fastmarkets",
  "src_joc",
  "src_cass_freight_index",
] as const;

export const DATA_FACTORY_SOURCES: readonly DataFactorySource[] = [
  // ------------------------------------------------------------------
  // Day 0 WIRE FIRST — schema + fetch stubs first
  // ------------------------------------------------------------------
  {
    id: "src_fred",
    name: "FRED API",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "wire_first",
    wireFirstRank: 1,
    // https://fred.stlouisfed.org/docs/api/fred/
    sourceUrl: "https://fred.stlouisfed.org/docs/api/fred/",
    feedUrl: "https://api.stlouisfed.org/fred/series/observations",
    licenseClass: "free_registration",
    licenseNote:
      "St. Louis Fed public API. Production live fetch uses FRED_API_KEY. Day 0 stub does not call FRED.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "fred-economic-index",
    signalTypes: ["economic_index"],
  },
  {
    id: "src_eia",
    name: "EIA API v2",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "wire_first",
    wireFirstRank: 2,
    // https://www.eia.gov/opendata/documentation.php
    sourceUrl: "https://www.eia.gov/opendata/documentation.php",
    feedUrl: "https://api.eia.gov/v2/",
    licenseClass: "free_registration",
    licenseNote:
      "US EIA Open Data v2. Production live fetch uses EIA_API_KEY. Day 0 stub does not call EIA.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "eia-energy",
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_openfda_food_enforcement",
    name: "openFDA food enforcement",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "pulse",
    day0Tier: "wire_first",
    wireFirstRank: 3,
    // https://open.fda.gov/apis/food/enforcement/
    sourceUrl: "https://open.fda.gov/apis/food/enforcement/",
    feedUrl: "https://api.fda.gov/food/enforcement.json",
    licenseClass: "public_api",
    licenseNote:
      "FDA openFDA public API. No key for modest volume. Food-edition Pulse disruption, not a tenant recall list.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["supplier_risk_news"],
  },
  {
    id: "src_ofac_sdn",
    name: "OFAC SDN",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "both",
    day0Tier: "wire_first",
    wireFirstRank: 4,
    // https://ofac.treasury.gov/sanctions-list-service
    sourceUrl: "https://ofac.treasury.gov/sanctions-list-service",
    feedUrl: "https://www.treasury.gov/ofac/downloads/sdn.xml",
    licenseClass: "public_api",
    licenseNote:
      "US Treasury SDN XML (public). Not a screening-product claim. Existing collector `government-sanctions` already pulls this file.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "government-sanctions",
    signalTypes: ["sanctions_match"],
  },
  {
    id: "src_weather_gov",
    name: "api.weather.gov (NWS alerts)",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "pulse",
    day0Tier: "wire_first",
    wireFirstRank: 5,
    // https://www.weather.gov/documentation/services-web-api
    sourceUrl: "https://www.weather.gov/documentation/services-web-api",
    feedUrl: "https://api.weather.gov/alerts/active",
    licenseClass: "public_api",
    licenseNote:
      "NOAA NWS public API. Requires a contact User-Agent. Also one of four feeds in `natural-hazards`. Day 0 first-class stub does not live-fetch.",
    fetchStatus: "stub",
    existingCollectorId: "natural-hazards",
    signalTypes: ["natural_hazard"],
  },
  {
    id: "src_bts_teu",
    name: "BTS TEU / containerized trade",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "wire_first",
    wireFirstRank: 6,
    // https://www.bts.gov/browse-statistical-products-and-data/freight-facts-and-figures
    sourceUrl:
      "https://www.bts.gov/browse-statistical-products-and-data/freight-facts-and-figures",
    feedUrl: "https://data.bts.gov/",
    licenseClass: "public_api",
    licenseNote:
      "US BTS public freight statistics (TEU / containerized merchandise). Day 0 stub — pin the exact Socrata dataset before live fetch.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_pola",
    name: "Port of Los Angeles statistics",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "pulse",
    day0Tier: "wire_first",
    wireFirstRank: 7,
    // https://www.portoflosangeles.org/business/statistics
    sourceUrl: "https://www.portoflosangeles.org/business/statistics",
    feedUrl:
      "https://www.portoflosangeles.org/business/statistics/container-statistics",
    licenseClass: "public_api",
    licenseNote:
      "Public HTML stats pages. Careful scrape only (respect robots, low rate, cite POLA). No invented TEU counts on Day 0.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
    scrapePosture: "careful_public_page",
  },
  {
    id: "src_polb",
    name: "Port of Long Beach statistics",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "pulse",
    day0Tier: "wire_first",
    wireFirstRank: 7,
    // https://polb.com/business/port-statistics/
    sourceUrl: "https://polb.com/business/port-statistics/",
    feedUrl: "https://polb.com/business/port-statistics/",
    licenseClass: "public_api",
    licenseNote:
      "Public HTML stats pages. Careful scrape only (respect robots, low rate, cite POLB). No invented TEU counts on Day 0.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
    scrapePosture: "careful_public_page",
  },
  {
    id: "src_cass_freight_index",
    name: "Cass Freight Index",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "wire_first",
    wireFirstRank: 8,
    sourceUrl:
      "https://www.cassinfo.com/freight-audit-payment/cass-transportation-indexes",
    feedUrl:
      "https://www.cassinfo.com/freight-audit-payment/cass-transportation-indexes",
    licenseClass: "paid_license_required",
    licenseNote:
      "Cite-only until a human-approved license is on file. Do not scrape or redistribute Cass values.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },

  // ------------------------------------------------------------------
  // Paid commercial — license_required placeholders ONLY
  // ------------------------------------------------------------------
  {
    id: "src_dat",
    name: "DAT freight rates",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl: "https://www.dat.com/",
    feedUrl: "https://www.dat.com/",
    licenseClass: "paid_license_required",
    licenseNote: "Commercial truckload rate data. Placeholder only.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_freightos_fbx",
    name: "Freightos Baltic Index (FBX)",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl: "https://fbx.freightos.com/",
    feedUrl: "https://fbx.freightos.com/",
    licenseClass: "paid_license_required",
    licenseNote: "Commercial ocean-container index. Placeholder only.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_xeneta",
    name: "Xeneta ocean/air benchmarks",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl: "https://www.xeneta.com/",
    feedUrl: "https://www.xeneta.com/",
    licenseClass: "paid_license_required",
    licenseNote: "Commercial rate benchmark. Placeholder only.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_drewry",
    name: "Drewry container / World Container Index",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl: "https://www.drewry.co.uk/",
    feedUrl: "https://www.drewry.co.uk/",
    licenseClass: "paid_license_required",
    licenseNote: "Commercial container index. Placeholder only.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_sonar",
    name: "FreightWaves SONAR",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl: "https://sonar.freightwaves.com/",
    feedUrl: "https://sonar.freightwaves.com/",
    licenseClass: "paid_license_required",
    licenseNote: "Commercial freight analytics. Placeholder only.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_lme",
    name: "London Metal Exchange",
    family: "freight_commodity",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl: "https://www.lme.com/",
    feedUrl: "https://www.lme.com/",
    licenseClass: "paid_license_required",
    licenseNote:
      "Licensed metal prices. Alpha Vantage copper is not an LME substitute.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_cme",
    name: "CME Group",
    family: "freight_commodity",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl: "https://www.cmegroup.com/",
    feedUrl: "https://www.cmegroup.com/",
    licenseClass: "paid_license_required",
    licenseNote: "Licensed futures/settlements. Placeholder only.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_ism_rob",
    name: "ISM Report On Business",
    family: "index",
    observeKind: "price_index",
    channelUse: "pulse",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl:
      "https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/",
    feedUrl:
      "https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/",
    licenseClass: "paid_license_required",
    licenseNote: "ISM PMI / ROB is licensed. Cite-only placeholder.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["economic_index"],
  },
  {
    id: "src_sp_commodity_index",
    name: "S&P Commodity Insights",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl: "https://www.spglobal.com/commodityinsights/",
    feedUrl: "https://www.spglobal.com/commodityinsights/",
    licenseClass: "paid_license_required",
    licenseNote: "S&P CI commercial prices. Placeholder only.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_fastmarkets",
    name: "Fastmarkets",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl: "https://www.fastmarkets.com/",
    feedUrl: "https://www.fastmarkets.com/",
    licenseClass: "paid_license_required",
    licenseNote: "Commercial price assessments. Placeholder only.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_joc",
    name: "Journal of Commerce",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "pulse",
    day0Tier: "license_required",
    wireFirstRank: null,
    sourceUrl: "https://www.joc.com/",
    feedUrl: "https://www.joc.com/",
    licenseClass: "paid_license_required",
    licenseNote: "JOC commercial news/data. Placeholder only.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },

  // ------------------------------------------------------------------
  // Other public collectors already on disk (not Day 0 wire-first)
  // ------------------------------------------------------------------
  {
    id: "src_sam_gov",
    name: "SAM.gov opportunities & exclusions",
    family: "procurement",
    observeKind: "disruption_policy",
    channelUse: "api",
    day0Tier: "existing_collector",
    wireFirstRank: null,
    sourceUrl: "https://open.gsa.gov/api/opportunities-api/",
    feedUrl: "https://api.sam.gov/opportunities/v2/search",
    licenseClass: "free_registration",
    licenseNote:
      "Public federal opportunities. Production uses SAM_GOV_API_KEY.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "sam-gov",
    signalTypes: ["public_bid_award"],
  },
  {
    id: "src_usaspending",
    name: "USAspending.gov awards",
    family: "procurement",
    observeKind: "disruption_policy",
    channelUse: "api",
    day0Tier: "existing_collector",
    wireFirstRank: null,
    sourceUrl: "https://api.usaspending.gov/",
    feedUrl: "https://api.usaspending.gov/api/v2/search/spending_by_award/",
    licenseClass: "public_api",
    licenseNote: "Award-level public records, not tenant spend.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "usaspending",
    signalTypes: ["public_bid_award"],
  },
  {
    id: "src_bls",
    name: "BLS CPI / PPI",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "existing_collector",
    wireFirstRank: null,
    sourceUrl: "https://www.bls.gov/developers/",
    feedUrl: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
    licenseClass: "public_api",
    licenseNote: "Optional free key raises quota (BLS_API_KEY).",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "bls-economic-index",
    signalTypes: ["economic_index"],
  },
  {
    id: "src_world_bank_pink_sheet",
    name: "World Bank Pink Sheet",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "existing_collector",
    wireFirstRank: null,
    sourceUrl: "https://www.worldbank.org/en/research/commodity-markets",
    feedUrl:
      "https://thedocs.worldbank.org/en/doc/5d903e848db1d1b83e0ec8f744e55570-0350012021/related/CMO-Historical-Data-Monthly.xlsx",
    licenseClass: "public_api",
    licenseNote: "World Bank commodity monthly series.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "world-bank-pink-sheet",
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_sec_edgar",
    name: "SEC EDGAR submissions",
    family: "filing",
    observeKind: "supplier_public",
    channelUse: "api",
    day0Tier: "existing_collector",
    wireFirstRank: null,
    sourceUrl: "https://www.sec.gov/os/accessing-edgar-data",
    feedUrl: "https://data.sec.gov/submissions/",
    licenseClass: "public_api",
    licenseNote: "Requires contact User-Agent (SEC_EDGAR_USER_AGENT).",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "sec-edgar",
    signalTypes: ["corporate_filing"],
  },
] as const;

const SOURCE_BY_ID = new Map(DATA_FACTORY_SOURCES.map((s) => [s.id, s]));

export function getDataFactorySource(
  id: string,
): DataFactorySource | undefined {
  return SOURCE_BY_ID.get(id);
}

export function listDataFactorySources(filter?: {
  family?: DataFactorySourceFamily;
  fetchStatus?: DataFactoryFetchStatus;
  licenseClass?: DataFactoryLicenseClass;
  day0Tier?: DataFactoryDay0Tier;
  channelUse?: DataFactoryChannelUse;
}): DataFactorySource[] {
  return DATA_FACTORY_SOURCES.filter((s) => {
    if (filter?.family && s.family !== filter.family) return false;
    if (filter?.fetchStatus && s.fetchStatus !== filter.fetchStatus) {
      return false;
    }
    if (filter?.licenseClass && s.licenseClass !== filter.licenseClass) {
      return false;
    }
    if (filter?.day0Tier && s.day0Tier !== filter.day0Tier) return false;
    if (filter?.channelUse) {
      if (filter.channelUse === "both") {
        if (s.channelUse !== "both") return false;
      } else if (
        s.channelUse !== filter.channelUse &&
        s.channelUse !== "both"
      ) {
        return false;
      }
    }
    return true;
  });
}

export function listWireFirstSources(): DataFactorySource[] {
  return listDataFactorySources({ day0Tier: "wire_first" }).sort(
    (a, b) => (a.wireFirstRank ?? 99) - (b.wireFirstRank ?? 99),
  );
}
