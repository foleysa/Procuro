/**
 * Layer A fetch stubs.
 *
 * Wire-first sources return a request plan + observation schema and
 * empty observations. Paid `license_required` sources refuse to fetch.
 * No live HTTP. No invented values.
 */

import {
  DATA_FACTORY_SOURCES,
  getDataFactorySource,
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
  scrapePosture?: "careful_public_page";
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
    case "src_openfda_food_enforcement":
      query.limit = "10";
      query.sort = "report_date:desc";
      break;
    case "src_ofac_sdn":
      headers.Accept = "application/xml";
      break;
    case "src_weather_gov":
      headers["User-Agent"] = "Procuro Data Factory (compliance@procuro.ai)";
      query.status = "actual";
      break;
    case "src_pola":
    case "src_polb":
      headers.Accept = "text/html";
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
    note: source.scrapePosture
      ? `Careful public-page stub — no scrape on Day 0. Cite ${source.sourceUrl}.`
      : `Day 0 stub — no live HTTP. Cite ${source.sourceUrl}.`,
  };
}

export function fetchAllLayerASources(): LayerAFetchResult[] {
  return DATA_FACTORY_SOURCES.map((s) => fetchKnownSource(s));
}

export function fetchWireFirstSources(): LayerAFetchResult[] {
  return DATA_FACTORY_SOURCES.filter((s) => s.day0Tier === "wire_first")
    .sort((a, b) => (a.wireFirstRank ?? 99) - (b.wireFirstRank ?? 99))
    .map((s) => fetchKnownSource(s));
}
