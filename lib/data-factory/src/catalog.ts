/**
 * Layer A source catalog — strengthened Day 0 map (John: old 8 was weak).
 *
 * Tier 1: implement fetch stubs + schemas for ALL 15 public APIs.
 * Tier 2: file/CSV / careful-page stubs (Cass + SCFI cite-only).
 * Paid commercial feeds: license_required placeholders only.
 *
 * No live invented values. No tenant/FSA data. Layer B deferred.
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
  "tier_1",
  "tier_2",
  "license_required",
] as const;
export type DataFactoryDay0Tier = (typeof dataFactoryDay0Tiers)[number];

export const dataFactoryChannelUses = ["pulse", "api", "both"] as const;
export type DataFactoryChannelUse = (typeof dataFactoryChannelUses)[number];

export type DataFactoryScrapePosture =
  | "careful_public_page"
  | "file_csv"
  | "socrata";

export interface DataFactorySource {
  id: string;
  name: string;
  family: DataFactorySourceFamily;
  observeKind: DataFactoryObserveKind;
  channelUse: DataFactoryChannelUse;
  day0Tier: DataFactoryDay0Tier;
  /** Tier 1 rank 1–15; null otherwise. */
  tierRank: number | null;
  sourceUrl: string;
  feedUrl: string;
  altFeedUrls?: readonly string[];
  licenseClass: DataFactoryLicenseClass;
  licenseNote: string;
  fetchStatus: DataFactoryFetchStatus;
  existingCollectorId: string | null;
  signalTypes: readonly string[];
  scrapePosture?: DataFactoryScrapePosture;
}

/** Strengthened Tier 1 — stubs required for every id. */
export const TIER1_SOURCE_IDS = [
  "src_bls",
  "src_fred",
  "src_eia",
  "src_usda_mymarketnews",
  "src_openfda_food_enforcement",
  "src_openfda_recalls",
  "src_ofac_sdn",
  "src_federal_register",
  "src_sec_edgar",
  "src_bts_teu",
  "src_weather_gov",
  "src_usaspending",
  "src_census_ft900",
  "src_census_m3",
  "src_world_bank_pink_sheet",
  "src_un_comtrade",
] as const;

export const TIER2_SOURCE_IDS = [
  "src_pola",
  "src_polb",
  "src_usgs_mcs",
  "src_usda_ers",
  "src_cpsc",
  "src_beige_book",
  "src_naics",
  "src_unspsc",
  "src_cass_freight_index",
  "src_nhc",
  "src_fda_dashboard",
  "src_sam_gov",
  "src_scfi",
  "src_imf_primary_commodity",
  "src_usace",
  "src_epa_tri",
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
] as const;

/** @deprecated use TIER1_SOURCE_IDS — old weak 8-source list */
export const DAY0_WIRE_FIRST_IDS = TIER1_SOURCE_IDS;

export const DATA_FACTORY_SOURCES: readonly DataFactorySource[] = [
  // ---- Tier 1 (strengthened) -------------------------------------------
  {
    id: "src_bls",
    name: "BLS Public Data API v2 (PPI)",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "tier_1",
    tierRank: 1,
    sourceUrl: "https://www.bls.gov/developers/api_signature_v2.htm",
    feedUrl: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
    licenseClass: "public_api",
    licenseNote:
      "BLS v2 public API. Optional BLS_API_KEY raises quota. PPI series (WPU*), not tenant prices.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "bls-economic-index",
    signalTypes: ["economic_index"],
  },
  {
    id: "src_fred",
    name: "FRED API",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "tier_1",
    tierRank: 2,
    sourceUrl: "https://fred.stlouisfed.org/docs/api/fred/",
    feedUrl: "https://api.stlouisfed.org/fred/series/observations",
    licenseClass: "free_registration",
    licenseNote: "St. Louis Fed. Production uses FRED_API_KEY. Stub does not call FRED.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "fred-economic-index",
    signalTypes: ["economic_index"],
  },
  {
    id: "src_eia",
    name: "EIA Open Data API v2",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "tier_1",
    tierRank: 3,
    sourceUrl: "https://www.eia.gov/opendata/documentation.php",
    feedUrl: "https://api.eia.gov/v2/",
    licenseClass: "free_registration",
    licenseNote: "EIA v2. Production uses EIA_API_KEY.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "eia-energy",
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_usda_mymarketnews",
    name: "USDA MyMarketNews API",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "tier_1",
    tierRank: 4,
    // https://mymarketnews.ams.usda.gov/public_data_api
    sourceUrl: "https://mymarketnews.ams.usda.gov/public_data_api",
    feedUrl: "https://marsapi.ams.usda.gov/services/v1.1/reports",
    licenseClass: "free_registration",
    licenseNote:
      "AMS MyMarketNews / MARS API. Free key from USDA AMS. Not USDA NASS QuickStats (separate collector).",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_openfda_food_enforcement",
    name: "openFDA food enforcement",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "pulse",
    day0Tier: "tier_1",
    tierRank: 5,
    sourceUrl: "https://open.fda.gov/apis/food/enforcement/",
    feedUrl: "https://api.fda.gov/food/enforcement.json",
    licenseClass: "public_api",
    licenseNote: "FDA openFDA food recall/enforcement. Public events, not a tenant recall list.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["supplier_risk_news"],
  },
  {
    id: "src_openfda_recalls",
    name: "openFDA enforcement recalls (drug/device)",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "pulse",
    day0Tier: "tier_1",
    tierRank: 5,
    sourceUrl: "https://open.fda.gov/apis/",
    feedUrl: "https://api.fda.gov/drug/enforcement.json",
    altFeedUrls: ["https://api.fda.gov/device/enforcement.json"],
    licenseClass: "public_api",
    licenseNote: "openFDA enforcement JSON for drug and device recalls.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["supplier_risk_news"],
  },
  {
    id: "src_ofac_sdn",
    name: "OFAC SDN CSV/XML downloads",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "both",
    day0Tier: "tier_1",
    tierRank: 6,
    sourceUrl: "https://ofac.treasury.gov/sanctions-list-service",
    feedUrl: "https://www.treasury.gov/ofac/downloads/sdn.xml",
    altFeedUrls: [
      "https://www.treasury.gov/ofac/downloads/sdn.csv",
      "https://www.treasury.gov/ofac/downloads/sdn_advanced.xml",
    ],
    licenseClass: "public_api",
    licenseNote:
      "Treasury SDN XML + CSV. Not a screening-product claim. Existing `government-sanctions` already pulls XML.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "government-sanctions",
    signalTypes: ["sanctions_match"],
  },
  {
    id: "src_federal_register",
    name: "Federal Register API",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "pulse",
    day0Tier: "tier_1",
    tierRank: 7,
    sourceUrl: "https://www.federalregister.gov/developers/documentation/api/v1",
    feedUrl: "https://www.federalregister.gov/api/v1/documents.json",
    licenseClass: "public_api",
    licenseNote: "NARA Federal Register v1. Public rules/notices — policy disruption, not tenant dockets.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["event_geocoded"],
  },
  {
    id: "src_sec_edgar",
    name: "SEC EDGAR APIs",
    family: "filing",
    observeKind: "supplier_public",
    channelUse: "api",
    day0Tier: "tier_1",
    tierRank: 8,
    sourceUrl: "https://www.sec.gov/os/accessing-edgar-data",
    feedUrl: "https://data.sec.gov/submissions/",
    altFeedUrls: [
      "https://efts.sec.gov/LATEST/search-index",
      "https://data.sec.gov/api/xbrl/companyfacts/",
    ],
    licenseClass: "public_api",
    licenseNote: "SEC fair-access User-Agent required (SEC_EDGAR_USER_AGENT).",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "sec-edgar",
    signalTypes: ["corporate_filing"],
  },
  {
    id: "src_bts_teu",
    name: "BTS data.bts.gov Monthly TEU (Socrata)",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "tier_1",
    tierRank: 9,
    sourceUrl: "https://www.bts.gov/PPFS",
    feedUrl: "https://data.bts.gov/",
    altFeedUrls: ["https://data.bts.gov/browse?q=TEU"],
    licenseClass: "public_api",
    licenseNote:
      "Socrata `https://data.bts.gov/resource/{id}.json`. Pin the monthly TEU 4×4 dataset id before live fetch — do not invent an id.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
    scrapePosture: "socrata",
  },
  {
    id: "src_weather_gov",
    name: "api.weather.gov alerts",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "pulse",
    day0Tier: "tier_1",
    tierRank: 10,
    sourceUrl: "https://www.weather.gov/documentation/services-web-api",
    feedUrl: "https://api.weather.gov/alerts/active",
    licenseClass: "public_api",
    licenseNote: "NWS public API. Contact User-Agent required.",
    fetchStatus: "stub",
    existingCollectorId: "natural-hazards",
    signalTypes: ["natural_hazard"],
  },
  {
    id: "src_usaspending",
    name: "USAspending.gov API",
    family: "procurement",
    observeKind: "disruption_policy",
    channelUse: "api",
    day0Tier: "tier_1",
    tierRank: 11,
    sourceUrl: "https://api.usaspending.gov/",
    feedUrl: "https://api.usaspending.gov/api/v2/search/spending_by_award/",
    licenseClass: "public_api",
    licenseNote: "Award-level public records. Not tenant spend.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "usaspending",
    signalTypes: ["public_bid_award"],
  },
  {
    id: "src_census_ft900",
    name: "Census Foreign Trade / FT-900 downloads",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "tier_1",
    tierRank: 12,
    sourceUrl:
      "https://www.census.gov/foreign-trade/Press-Release/current_press_release/index.html",
    feedUrl:
      "https://www.census.gov/foreign-trade/Press-Release/current_press_release/index.html",
    licenseClass: "public_api",
    licenseNote:
      "Monthly FT-900 exhibits (XLS/CSV). US government work. Stub does not invent trade balances.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["customs_trade"],
    scrapePosture: "file_csv",
  },
  {
    id: "src_census_m3",
    name: "Census M3 (Manufacturers' Shipments)",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "tier_1",
    tierRank: 13,
    sourceUrl: "https://www.census.gov/manufacturing/m3/index.html",
    feedUrl: "https://api.census.gov/data/timeseries/eits/m3",
    altFeedUrls: [
      "https://www.census.gov/manufacturing/m3/historical_data/index.html",
    ],
    licenseClass: "public_api",
    licenseNote: "Census EITS M3 timeseries. Optional CENSUS_API_KEY.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["economic_index"],
  },
  {
    id: "src_world_bank_pink_sheet",
    name: "World Bank Pink Sheet commodity monthly",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "tier_1",
    tierRank: 14,
    sourceUrl: "https://www.worldbank.org/en/research/commodity-markets",
    feedUrl:
      "https://thedocs.worldbank.org/en/doc/5d903e848db1d1b83e0ec8f744e55570-0350012021/related/CMO-Historical-Data-Monthly.xlsx",
    licenseClass: "public_api",
    licenseNote: "World Bank CMO monthly XLSX. Cite World Bank.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "world-bank-pink-sheet",
    signalTypes: ["commodity_index"],
    scrapePosture: "file_csv",
  },
  {
    id: "src_un_comtrade",
    name: "UN Comtrade free tier / bulk",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "tier_1",
    tierRank: 15,
    sourceUrl: "https://comtradedeveloper.un.org/",
    feedUrl: "https://comtradeapi.un.org/public/v1",
    altFeedUrls: [
      "https://comtrade.un.org/data/dev/portal",
      "https://comtradeplus.un.org/",
    ],
    licenseClass: "free_registration",
    licenseNote:
      "Comtrade Plus free tier needs a subscription key. Use public/bulk only where the terms allow. No paid extract.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["customs_trade"],
  },

  // ---- Tier 2 file / CSV / careful pages --------------------------------
  {
    id: "src_pola",
    name: "Port of Los Angeles statistics",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "pulse",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://www.portoflosangeles.org/business/statistics",
    feedUrl:
      "https://www.portoflosangeles.org/business/statistics/container-statistics",
    licenseClass: "public_api",
    licenseNote: "Public HTML/CSV. Careful scrape later. No invented TEU.",
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
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://polb.com/business/port-statistics/",
    feedUrl: "https://polb.com/business/port-statistics/",
    licenseClass: "public_api",
    licenseNote: "Public HTML/CSV. Careful scrape later.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
    scrapePosture: "careful_public_page",
  },
  {
    id: "src_usgs_mcs",
    name: "USGS Mineral Commodity Summaries",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl:
      "https://www.usgs.gov/centers/national-minerals-information-center/commodity-statistics-and-information",
    feedUrl:
      "https://www.usgs.gov/centers/national-minerals-information-center",
    licenseClass: "public_api",
    licenseNote: "USGS MCS annual files. Existing collector `usgs-mineral`.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "usgs-mineral",
    signalTypes: ["commodity_index"],
    scrapePosture: "file_csv",
  },
  {
    id: "src_usda_ers",
    name: "USDA ERS data products",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://www.ers.usda.gov/data-products",
    feedUrl: "https://www.ers.usda.gov/data-products",
    licenseClass: "public_api",
    licenseNote: "ERS public data products (XLS/CSV). Pin a product before live fetch.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["economic_index"],
    scrapePosture: "file_csv",
  },
  {
    id: "src_cpsc",
    name: "CPSC / SaferProducts recalls",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "pulse",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://www.cpsc.gov/Recalls",
    feedUrl: "https://www.saferproducts.gov/RestWebServices/Recall",
    licenseClass: "public_api",
    licenseNote: "CPSC public recall web service.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["supplier_risk_news"],
  },
  {
    id: "src_beige_book",
    name: "Fed Beige Book",
    family: "index",
    observeKind: "price_index",
    channelUse: "pulse",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl:
      "https://www.federalreserve.gov/monetarypolicy/beige-book-default.htm",
    feedUrl:
      "https://www.federalreserve.gov/monetarypolicy/beige-book-default.htm",
    licenseClass: "public_api",
    licenseNote: "HTML/PDF qualitative report. No invented PMI numbers.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["economic_index"],
    scrapePosture: "careful_public_page",
  },
  {
    id: "src_naics",
    name: "NAICS codes",
    family: "procurement",
    observeKind: "supplier_public",
    channelUse: "api",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://www.census.gov/naics/",
    feedUrl: "https://www.census.gov/naics/",
    licenseClass: "public_api",
    licenseNote: "Census NAICS concordance downloads. Taxonomy, not a price feed.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["entity_registry"],
    scrapePosture: "file_csv",
  },
  {
    id: "src_unspsc",
    name: "UNSPSC codes",
    family: "procurement",
    observeKind: "supplier_public",
    channelUse: "api",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://www.unspsc.org/",
    feedUrl: "https://www.unspsc.org/download-unspsc",
    licenseClass: "free_registration",
    licenseNote:
      "UNSPSC download often requires registration. Confirm terms before redistributing codes.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["entity_registry"],
    scrapePosture: "file_csv",
  },
  {
    id: "src_cass_freight_index",
    name: "Cass Freight Index",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl:
      "https://www.cassinfo.com/freight-audit-payment/cass-transportation-indexes",
    feedUrl:
      "https://www.cassinfo.com/freight-audit-payment/cass-transportation-indexes",
    licenseClass: "paid_license_required",
    licenseNote: "Cite-only until a human-approved license is on file.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_nhc",
    name: "NHC tropical cyclone GIS",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "pulse",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://www.nhc.noaa.gov/",
    feedUrl: "https://www.nhc.noaa.gov/gis/",
    licenseClass: "public_api",
    licenseNote: "NOAA NHC public GIS / advisories.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["natural_hazard"],
    scrapePosture: "file_csv",
  },
  {
    id: "src_fda_dashboard",
    name: "FDA recalls dashboard",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "pulse",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://datadashboard.fda.gov/ora/cd/recalls.htm",
    feedUrl: "https://datadashboard.fda.gov/ora/cd/recalls.htm",
    altFeedUrls: [
      "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts",
    ],
    licenseClass: "public_api",
    licenseNote: "Public dashboard / HTML. Prefer openFDA APIs (Tier 1) for machine reads.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["supplier_risk_news"],
    scrapePosture: "careful_public_page",
  },
  {
    id: "src_sam_gov",
    name: "SAM.gov opportunities (careful)",
    family: "procurement",
    observeKind: "disruption_policy",
    channelUse: "api",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://open.gsa.gov/api/opportunities-api/",
    feedUrl: "https://api.sam.gov/opportunities/v2/search",
    licenseClass: "free_registration",
    licenseNote:
      "Public opportunities. Rate-limit + SAM_GOV_API_KEY. Careful — ToS and quota. Existing `sam-gov` collector.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "sam-gov",
    signalTypes: ["public_bid_award"],
  },
  {
    id: "src_scfi",
    name: "Shanghai Containerized Freight Index (SCFI)",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://en.sse.net.cn/",
    feedUrl: "https://en.sse.net.cn/",
    licenseClass: "paid_license_required",
    licenseNote: "Cite-only. Do not scrape SSE/SCFI.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_imf_primary_commodity",
    name: "IMF primary commodity prices",
    family: "index",
    observeKind: "price_index",
    channelUse: "both",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://www.imf.org/en/Research/commodity-prices",
    feedUrl: "https://www.imf.org/en/Research/commodity-prices",
    licenseClass: "public_api",
    licenseNote: "IMF monthly commodity XLS. Cite IMF. No invented indexes.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["commodity_index"],
    scrapePosture: "file_csv",
  },
  {
    id: "src_usace",
    name: "USACE waterborne commerce (if open)",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl:
      "https://www.iwr.usace.army.mil/About/Technical-Centers/WCSC-Waterborne-Commerce-Statistics-Center/",
    feedUrl:
      "https://www.iwr.usace.army.mil/About/Technical-Centers/WCSC-Waterborne-Commerce-Statistics-Center/",
    licenseClass: "public_api",
    licenseNote:
      "WCSC reports are often public PDFs/tables. Confirm the specific open file before fetch. Skip if not open.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
    scrapePosture: "file_csv",
  },
  {
    id: "src_epa_tri",
    name: "EPA Toxics Release Inventory",
    family: "disruption",
    observeKind: "disruption_policy",
    channelUse: "both",
    day0Tier: "tier_2",
    tierRank: null,
    sourceUrl: "https://www.epa.gov/toxics-release-inventory-tri-program",
    feedUrl: "https://www.epa.gov/toxics-release-inventory-tri-program/tri-basic-data-files-calendar-years-1987-present",
    altFeedUrls: ["https://data.epa.gov/efservice/"],
    licenseClass: "public_api",
    licenseNote: "TRI basic data files / Envirofacts. Facility releases, not tenant EHS data.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["environmental_violation"],
    scrapePosture: "file_csv",
  },

  // ---- Paid commercial — placeholders only ------------------------------
  {
    id: "src_dat",
    name: "DAT freight rates",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    channelUse: "both",
    day0Tier: "license_required",
    tierRank: null,
    sourceUrl: "https://www.dat.com/",
    feedUrl: "https://www.dat.com/",
    licenseClass: "paid_license_required",
    licenseNote: "Commercial truckload rates. Placeholder only.",
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
    tierRank: null,
    sourceUrl: "https://fbx.freightos.com/",
    feedUrl: "https://fbx.freightos.com/",
    licenseClass: "paid_license_required",
    licenseNote: "Commercial ocean index. Placeholder only.",
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
    tierRank: null,
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
    tierRank: null,
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
    tierRank: null,
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
    tierRank: null,
    sourceUrl: "https://www.lme.com/",
    feedUrl: "https://www.lme.com/",
    licenseClass: "paid_license_required",
    licenseNote: "Licensed metal prices. Placeholder only.",
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
    tierRank: null,
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
    tierRank: null,
    sourceUrl:
      "https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/",
    feedUrl:
      "https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/",
    licenseClass: "paid_license_required",
    licenseNote: "ISM PMI / ROB is licensed. Placeholder only.",
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
    tierRank: null,
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
    tierRank: null,
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
    tierRank: null,
    sourceUrl: "https://www.joc.com/",
    feedUrl: "https://www.joc.com/",
    licenseClass: "paid_license_required",
    licenseNote: "JOC commercial news/data. Placeholder only.",
    fetchStatus: "license_required",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
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

export function listTier1Sources(): DataFactorySource[] {
  return listDataFactorySources({ day0Tier: "tier_1" }).sort(
    (a, b) => (a.tierRank ?? 99) - (b.tierRank ?? 99),
  );
}

export function listTier2Sources(): DataFactorySource[] {
  return listDataFactorySources({ day0Tier: "tier_2" });
}

/** @deprecated use listTier1Sources */
export function listWireFirstSources(): DataFactorySource[] {
  return listTier1Sources();
}
