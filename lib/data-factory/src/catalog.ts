/**
 * Layer A source catalog — public procurement / SC / logistics signals.
 *
 * Every entry cites a source URL. Paid / commercial-index licenses are
 * marked `paid_license_required` and must not be fetched until a human
 * approves the license. Free-registration APIs may need a key later;
 * Day 0 does not mint keys.
 *
 * `wired_existing_collector` points at collectors already registered
 * in `artifacts/api-server` — this spine does not re-implement them
 * and does not dump tenant-scoped `market_signals` rows.
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
  "blocked_pending_license",
] as const;
export type DataFactoryFetchStatus =
  (typeof dataFactoryFetchStatuses)[number];

export interface DataFactorySource {
  id: string;
  name: string;
  family: DataFactorySourceFamily;
  observeKind: DataFactoryObserveKind;
  /** Landing / documentation URL cited for operators and counsel. */
  sourceUrl: string;
  /** Machine-readable feed URL when it differs from the landing page. */
  feedUrl: string;
  licenseClass: DataFactoryLicenseClass;
  licenseNote: string;
  fetchStatus: DataFactoryFetchStatus;
  /** Existing `collectors.id` when this source is already wired. */
  existingCollectorId: string | null;
  signalTypes: readonly string[];
}

export const DATA_FACTORY_SOURCES: readonly DataFactorySource[] = [
  // --- Procurement (public bid / award) ---------------------------------
  {
    id: "src_sam_gov",
    name: "SAM.gov opportunities & exclusions",
    family: "procurement",
    observeKind: "disruption_policy",
    // GSA Open Data opportunities API
    sourceUrl: "https://open.gsa.gov/api/opportunities-api/",
    feedUrl: "https://api.sam.gov/opportunities/v2/search",
    licenseClass: "free_registration",
    licenseNote:
      "Public federal opportunities. Production fetch uses SAM_GOV_API_KEY (free registration). Day 0 does not mint keys.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "sam-gov",
    signalTypes: ["public_bid_award"],
  },
  {
    id: "src_usaspending",
    name: "USAspending.gov awards",
    family: "procurement",
    observeKind: "disruption_policy",
    sourceUrl: "https://api.usaspending.gov/",
    feedUrl: "https://api.usaspending.gov/api/v2/search/spending_by_award/",
    licenseClass: "public_api",
    licenseNote:
      "US Treasury public spending API. No key. Award-level public records, not tenant spend.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "usaspending",
    signalTypes: ["public_bid_award"],
  },
  {
    id: "src_eu_ted",
    name: "TED (Tenders Electronic Daily)",
    family: "procurement",
    observeKind: "disruption_policy",
    sourceUrl: "https://ted.europa.eu/en/simap",
    feedUrl: "https://ted.europa.eu/en/simap/search",
    licenseClass: "public_api",
    licenseNote:
      "EU public procurement notices. Day 0 stub only — bulk extract needs a documented TED/SIMAP access path and ToS review.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["public_bid_award"],
  },
  {
    id: "src_uk_contracts_finder",
    name: "UK Contracts Finder",
    family: "procurement",
    observeKind: "disruption_policy",
    sourceUrl: "https://www.contractsfinder.service.gov.uk/apidocumentation",
    feedUrl: "https://www.contractsfinder.service.gov.uk/Published/Notices",
    licenseClass: "public_api",
    licenseNote:
      "UK Cabinet Office published notices. Day 0 stub — confirm Crown copyright / API terms before live fetch.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["public_bid_award"],
  },

  // --- Indices (price / economic / FX) ----------------------------------
  {
    id: "src_fred",
    name: "FRED economic series",
    family: "index",
    observeKind: "price_index",
    sourceUrl: "https://fred.stlouisfed.org/docs/api/fred/",
    feedUrl: "https://api.stlouisfed.org/fred/series/observations",
    licenseClass: "free_registration",
    licenseNote:
      "St. Louis Fed public API. Free key required in production (FRED_API_KEY).",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "fred-economic-index",
    signalTypes: ["economic_index"],
  },
  {
    id: "src_bls",
    name: "BLS CPI / PPI",
    family: "index",
    observeKind: "price_index",
    sourceUrl: "https://www.bls.gov/developers/",
    feedUrl: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
    licenseClass: "public_api",
    licenseNote:
      "BLS public API. Optional free key raises quota (BLS_API_KEY).",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "bls-economic-index",
    signalTypes: ["economic_index"],
  },
  {
    id: "src_eia",
    name: "EIA energy prices",
    family: "index",
    observeKind: "price_index",
    sourceUrl: "https://www.eia.gov/opendata/",
    feedUrl: "https://api.eia.gov/v2/",
    licenseClass: "free_registration",
    licenseNote:
      "US EIA Open Data. Free registration key in production (EIA_API_KEY).",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "eia-energy",
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_world_bank_pink_sheet",
    name: "World Bank Pink Sheet",
    family: "index",
    observeKind: "price_index",
    sourceUrl: "https://www.worldbank.org/en/research/commodity-markets",
    feedUrl:
      "https://thedocs.worldbank.org/en/doc/5d903e848db1d1b83e0ec8f744e55570-0350012021/related/CMO-Historical-Data-Monthly.xlsx",
    licenseClass: "public_api",
    licenseNote:
      "World Bank commodity monthly series. Published spreadsheet; cite World Bank.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "world-bank-pink-sheet",
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_usgs_mineral",
    name: "USGS mineral commodity summaries",
    family: "index",
    observeKind: "price_index",
    sourceUrl:
      "https://www.usgs.gov/centers/national-minerals-information-center",
    feedUrl: "https://www.usgs.gov/centers/national-minerals-information-center",
    licenseClass: "public_api",
    licenseNote: "USGS public mineral unit-value series (US government work).",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "usgs-mineral",
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_ecb_fx",
    name: "ECB reference FX rates",
    family: "index",
    observeKind: "price_index",
    sourceUrl: "https://data.ecb.europa.eu/",
    feedUrl: "https://data-api.ecb.europa.eu/service/data/EXR",
    licenseClass: "public_api",
    licenseNote: "ECB SDMX public API. No key.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "ecb-fx-rates",
    signalTypes: ["fx_rate"],
  },
  {
    id: "src_eurostat",
    name: "Eurostat HICP / PPI",
    family: "index",
    observeKind: "price_index",
    sourceUrl: "https://ec.europa.eu/eurostat",
    feedUrl: "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data",
    licenseClass: "public_api",
    licenseNote: "Eurostat public dissemination API.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "eurostat-economic-index",
    signalTypes: ["economic_index"],
  },
  {
    id: "src_usda_nass",
    name: "USDA NASS Prices Received",
    family: "index",
    observeKind: "price_index",
    sourceUrl: "https://quickstats.nass.usda.gov/api",
    feedUrl: "https://quickstats.nass.usda.gov/api/api_GET",
    licenseClass: "free_registration",
    licenseNote:
      "USDA NASS Quick Stats. Free key in production (USDA_NASS_API_KEY).",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "usda-nass-economic-index",
    signalTypes: ["economic_index"],
  },

  // --- Freight / commodity public + paid-blocked ------------------------
  {
    id: "src_published_commodity_index",
    name: "Published commodity closes (Alpha Vantage)",
    family: "freight_commodity",
    observeKind: "price_index",
    sourceUrl: "https://www.alphavantage.co/documentation/",
    feedUrl: "https://www.alphavantage.co/query",
    licenseClass: "free_registration",
    licenseNote:
      "Alpha Vantage free tier (daily quota). Not a substitute for LME/CME licensed closes. ALPHA_VANTAGE_API_KEY required to fetch.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "published-commodity-index",
    signalTypes: ["commodity_index"],
  },
  {
    id: "src_bts_freight",
    name: "BTS freight transportation indicators",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    sourceUrl: "https://www.bts.gov/",
    feedUrl: "https://data.bts.gov/",
    licenseClass: "public_api",
    licenseNote:
      "US Bureau of Transportation Statistics public datasets. Day 0 stub — pick a specific series before live fetch.",
    fetchStatus: "stub",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_freightos_fbx",
    name: "Freightos Baltic Index (FBX)",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    sourceUrl: "https://fbx.freightos.com/",
    feedUrl: "https://fbx.freightos.com/",
    licenseClass: "paid_license_required",
    licenseNote:
      "Commercial ocean-container index. Do not scrape or redistribute until a human-approved license is on file.",
    fetchStatus: "blocked_pending_license",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_cass_freight_index",
    name: "Cass Freight Index",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    sourceUrl:
      "https://www.cassinfo.com/freight-audit-payment/cass-transportation-indexes",
    feedUrl:
      "https://www.cassinfo.com/freight-audit-payment/cass-transportation-indexes",
    licenseClass: "paid_license_required",
    licenseNote:
      "Cass commercial index. Catalogued only. Human license approval required before any fetch or resale.",
    fetchStatus: "blocked_pending_license",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },
  {
    id: "src_scfi",
    name: "Shanghai Containerized Freight Index (SCFI)",
    family: "freight_commodity",
    observeKind: "logistics_lane",
    sourceUrl: "https://en.sse.net.cn/",
    feedUrl: "https://en.sse.net.cn/",
    licenseClass: "paid_license_required",
    licenseNote:
      "Shanghai Shipping Exchange commercial index. Blocked pending license. Do not scrape.",
    fetchStatus: "blocked_pending_license",
    existingCollectorId: null,
    signalTypes: ["freight_rate"],
  },

  // --- Disruption -------------------------------------------------------
  {
    id: "src_gdelt",
    name: "GDELT 2.0 events",
    family: "disruption",
    observeKind: "disruption_policy",
    sourceUrl: "https://www.gdeltproject.org/",
    feedUrl: "https://data.gdeltproject.org/gdeltv2/lastupdate.txt",
    licenseClass: "public_api",
    licenseNote: "GDELT public event firehose. Cite GDELT Project.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "gdelt-events",
    signalTypes: ["event_geocoded"],
  },
  {
    id: "src_natural_hazards",
    name: "Natural hazards (USGS / NWS / EONET / GDACS)",
    family: "disruption",
    observeKind: "disruption_policy",
    sourceUrl: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php",
    feedUrl: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_hour.geojson",
    licenseClass: "public_api",
    licenseNote:
      "USGS GeoJSON + NOAA NWS (https://api.weather.gov/) + NASA EONET (https://eonet.gsfc.nasa.gov/docs/v3) + GDACS RSS. All public.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "natural-hazards",
    signalTypes: ["natural_hazard"],
  },
  {
    id: "src_government_sanctions",
    name: "OFAC / EU / UK / UN consolidated sanctions",
    family: "disruption",
    observeKind: "disruption_policy",
    sourceUrl: "https://ofac.treasury.gov/sanctions-list-service",
    feedUrl: "https://www.treasury.gov/ofac/downloads/sdn.xml",
    licenseClass: "public_api",
    licenseNote:
      "Official open lists: OFAC SDN, EU FSD, UK OFSI, UN consolidated. Not a screening product claim.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "government-sanctions",
    signalTypes: ["sanctions_match"],
  },

  // --- Filings ----------------------------------------------------------
  {
    id: "src_sec_edgar",
    name: "SEC EDGAR submissions",
    family: "filing",
    observeKind: "supplier_public",
    sourceUrl: "https://www.sec.gov/os/accessing-edgar-data",
    feedUrl: "https://data.sec.gov/submissions/",
    licenseClass: "public_api",
    licenseNote:
      "SEC fair-access policy requires a contact User-Agent (SEC_EDGAR_USER_AGENT).",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "sec-edgar",
    signalTypes: ["corporate_filing"],
  },
  {
    id: "src_companies_house",
    name: "UK Companies House filings",
    family: "filing",
    observeKind: "supplier_public",
    sourceUrl: "https://developer.company-information.service.gov.uk/",
    feedUrl: "https://api.company-information.service.gov.uk/",
    licenseClass: "free_registration",
    licenseNote:
      "Free API key (COMPANIES_HOUSE_API_KEY). Crown copyright — follow Companies House terms.",
    fetchStatus: "wired_existing_collector",
    existingCollectorId: "companies-house",
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
}): DataFactorySource[] {
  return DATA_FACTORY_SOURCES.filter((s) => {
    if (filter?.family && s.family !== filter.family) return false;
    if (filter?.fetchStatus && s.fetchStatus !== filter.fetchStatus) {
      return false;
    }
    if (filter?.licenseClass && s.licenseClass !== filter.licenseClass) {
      return false;
    }
    return true;
  });
}
