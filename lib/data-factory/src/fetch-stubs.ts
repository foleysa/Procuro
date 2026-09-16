/**
 * Layer A fetch stubs.
 *
 * Tier 1 / Tier 2 public sources return a request plan + observation
 * schema and empty observations. Paid `license_required` sources refuse
 * to fetch. No live HTTP. No invented values. No invented Socrata ids.
 */

import {
  listTier1Sources,
  listTier2Sources,
  listNewsOsintSources,
  DATA_FACTORY_SOURCES,
  getDataFactorySource,
  type DataFactoryScrapePosture,
  type DataFactorySource,
} from "./catalog";
import {
  getLayerAObservationSchema,
  type LayerAObservationSchema,
} from "./schemas";

export interface LayerAFetchPlan {
  method: "GET";
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  authEnvVar: string | null;
  liveFetch: false;
  scrapePosture?: DataFactoryScrapePosture;
}

export type LayerAFetchResult = {
  sourceId: string;
  sourceUrl: string;
  feedUrl: string;
  observations: [];
  schema: LayerAObservationSchema | null;
  plan: LayerAFetchPlan | null;
  note: string;
} & (
  | { status: "wired_existing_collector"; collectorId: string }
  | { status: "stub" }
  | { status: "license_required" }
  | { status: "unknown_source" }
);

function planFor(source: DataFactorySource): LayerAFetchPlan {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const query: Record<string, string> = {};
  let authEnvVar: string | null = null;

  switch (source.id) {
    case "src_bls":
      authEnvVar = "BLS_API_KEY";
      break;
    case "src_fred":
      query.series_id = "WPU101";
      query.file_type = "json";
      query.sort_order = "desc";
      query.limit = "1";
      authEnvVar = "FRED_API_KEY";
      break;
    case "src_eia":
      query.length = "1";
      authEnvVar = "EIA_API_KEY";
      break;
    case "src_usda_mymarketnews":
      authEnvVar = "USDA_MMN_API_KEY";
      break;
    case "src_openfda_food_enforcement":
    case "src_openfda_recalls":
      query.limit = "10";
      query.sort = "report_date:desc";
      break;
    case "src_ofac_sdn":
      headers.Accept = "application/xml";
      break;
    case "src_federal_register":
      query.per_page = "20";
      query.order = "newest";
      break;
    case "src_cbp_csms":
    case "src_freightwaves_rss":
    case "src_supply_chain_dive":
    case "src_gcaptain":
    case "src_maritime_executive":
    case "src_splash247":
    case "src_loadstar":
    case "src_container_news":
    case "src_bbc_business":
    case "src_gdacs":
    case "src_usgs_quakes":
    case "src_nhc_products":
      headers.Accept = "application/rss+xml, application/atom+xml, application/xml";
      break;
    case "src_gdelt":
      query.format = "json";
      query.maxrecords = "10";
      query.query = "supply chain";
      break;
    case "src_google_news_rss":
      headers.Accept = "application/rss+xml, application/xml";
      query.q = "supply chain";
      query.hl = "en-US";
      query.gl = "US";
      query.ceid = "US:en";
      break;
    case "src_sec_edgar":
      headers["User-Agent"] = "Procuro Data Factory compliance@procuro.ai";
      authEnvVar = "SEC_EDGAR_USER_AGENT";
      break;
    case "src_bts_teu":
      // Do not invent a Socrata 4×4. Pin before live fetch.
      break;
    case "src_weather_gov":
      headers["User-Agent"] = "Procuro Data Factory (compliance@procuro.ai)";
      query.status = "actual";
      break;
    case "src_usaspending":
      // Award search is a POST in production; stub records the public URL only.
      break;
    case "src_census_ft900":
      headers.Accept = "text/html,text/csv,application/vnd.ms-excel";
      break;
    case "src_census_m3":
      query.get = "cell_value,time_slot_id,category_code";
      authEnvVar = "CENSUS_API_KEY";
      break;
    case "src_world_bank_pink_sheet":
      headers.Accept =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      break;
    case "src_un_comtrade":
      authEnvVar = "COMTRADE_SUBSCRIPTION_KEY";
      break;
    case "src_sam_gov":
      authEnvVar = "SAM_GOV_API_KEY";
      query.limit = "10";
      break;
    case "src_cpsc":
      headers.Accept = "application/json";
      break;
    case "src_pola":
    case "src_polb":
    case "src_beige_book":
    case "src_fda_dashboard":
      headers.Accept = "text/html";
      break;
    case "src_usgs_mcs":
    case "src_usda_ers":
    case "src_naics":
    case "src_unspsc":
    case "src_nhc":
    case "src_imf_primary_commodity":
    case "src_usace":
    case "src_epa_tri":
      headers.Accept = "text/csv,application/vnd.ms-excel,text/html";
      break;
    default:
      break;
  }

  return {
    method: "GET",
    url: source.feedUrl,
    headers,
    query,
    authEnvVar,
    liveFetch: false,
    scrapePosture: source.scrapePosture,
  };
}

function stubNote(source: DataFactorySource): string {
  if (source.scrapePosture === "careful_public_page") {
    return `Careful public-page stub — no scrape on Day 0. Cite ${source.sourceUrl}.`;
  }
  if (source.scrapePosture === "file_csv") {
    return `File/CSV stub — no download on Day 0. Cite ${source.sourceUrl}.`;
  }
  if (source.scrapePosture === "socrata") {
    return `Socrata stub — do not invent a 4×4 dataset id. Cite ${source.sourceUrl}.`;
  }
  if (source.scrapePosture === "fragile_rss") {
    return `Fragile RSS sensor — optional, not a GA dependency. Headlines + link only. Cite ${source.sourceUrl}.`;
  }
  if (source.scrapePosture === "rss") {
    return `RSS metadata stub — headlines + link only; no article HTML. Cite ${source.sourceUrl}.`;
  }
  if (source.scrapePosture === "event_api") {
    return `Event-graph stub — metadata + source URLs only; no article HTML. Cite ${source.sourceUrl}.`;
  }
  return `Day 0 stub — no live HTTP. Cite ${source.sourceUrl}.`;
}

export function fetchLayerASource(sourceId: string): LayerAFetchResult {
  const source = getDataFactorySource(sourceId);
  if (!source) {
    return {
      status: "unknown_source",
      sourceId,
      sourceUrl: "",
      feedUrl: "",
      observations: [],
      schema: null,
      plan: null,
      note: "Not in the Day 0 Layer A catalog.",
    };
  }
  return fetchKnownSource(source);
}

function fetchKnownSource(source: DataFactorySource): LayerAFetchResult {
  const schema = getLayerAObservationSchema(source.id) ?? null;
  const plan =
    source.fetchStatus === "license_required" ? null : planFor(source);
  const base = {
    sourceId: source.id,
    sourceUrl: source.sourceUrl,
    feedUrl: source.feedUrl,
    observations: [] as [],
    schema,
    plan,
  };

  if (source.fetchStatus === "license_required") {
    return {
      ...base,
      status: "license_required",
      note: `license_required placeholder. Do not fetch. ${source.licenseNote}`,
    };
  }
  if (source.fetchStatus === "wired_existing_collector") {
    return {
      ...base,
      status: "wired_existing_collector",
      collectorId: source.existingCollectorId ?? "unknown",
      note:
        "Fetch stub + schema only. Existing IntelligenceCollector may live-fetch later; this spine does not dump market_signals.",
    };
  }
  return {
    ...base,
    status: "stub",
    note: stubNote(source),
  };
}

export function fetchAllLayerASources(): LayerAFetchResult[] {
  return DATA_FACTORY_SOURCES.map((s) => fetchKnownSource(s));
}

export function fetchTier1Sources(): LayerAFetchResult[] {
  return listTier1Sources().map((s) => fetchKnownSource(s));
}

export function fetchTier2Sources(): LayerAFetchResult[] {
  return listTier2Sources().map((s) => fetchKnownSource(s));
}

export function fetchNewsOsintSources(): LayerAFetchResult[] {
  return listNewsOsintSources().map((s) => fetchKnownSource(s));
}

/** @deprecated use fetchTier1Sources */
export function fetchWireFirstSources(): LayerAFetchResult[] {
  return fetchTier1Sources();
}
