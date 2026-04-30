/**
 * FRED Producer Price Index collector.
 *
 * Pulls the latest observation of a curated set of PPI sub-series from the
 * St. Louis Fed FRED API and emits them as `economic_index` market signals.
 *
 * FRED PPI sub-indices map directly onto procurement spend categories
 * (steel mill products, plastic resins, industrial chemicals, freight
 * trucking, etc.), making them the highest-leverage free data source for
 * material/category cost trends.
 *
 * Posture: `public-api` — FRED has a published REST API and a 120 rpm
 * published cap. We default to a conservative 30 rpm.
 *
 * Auth: requires a `FRED_API_KEY` env var. If unset, `collect()` throws a
 * clear, actionable error and the runtime records the failure in the audit
 * log via `fetch_failed`.
 */

import { logger } from "../../logger";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../collector";

interface FredSeriesRef {
  /** FRED series id, e.g. "WPU101". */
  seriesId: string;
  /** Human-readable label for ops/docs. */
  label: string;
  /**
   * Procurement scope key. Material codes for raw inputs (steel, resin,
   * lumber); category codes for service/transport categories.
   */
  scope:
    | { kind: "material"; code: string }
    | { kind: "category"; code: string };
  /**
   * FRED PPI series are index numbers (varying base years). We tag the
   * unit "index" and surface the FRED-reported series id in metadata so
   * downstream analyzers can resolve the base period from FRED if needed.
   */
  unit: string;
}

/**
 * Initial curated set of procurement-relevant FRED PPI sub-series.
 * Kept inline (matching the `published-commodity-index` pattern) so changes
 * are code-reviewed rather than hidden in admin UI state.
 *
 * Selection criteria: each series is a stable, widely-cited PPI sub-index
 * with a clear procurement mapping (raw material category or service /
 * logistics category). Material codes line up with raw inputs; PCU
 * (industry) codes line up with service categories.
 */
const FRED_SERIES: FredSeriesRef[] = [
  // Metals
  {
    seriesId: "WPU101",
    label: "PPI: Iron and steel",
    scope: { kind: "material", code: "IRON_STEEL" },
    unit: "index",
  },
  {
    seriesId: "WPU1017",
    label: "PPI: Steel mill products",
    scope: { kind: "material", code: "STEEL_MILL_PRODUCTS" },
    unit: "index",
  },
  {
    seriesId: "WPU102",
    label: "PPI: Nonferrous metals",
    scope: { kind: "material", code: "NONFERROUS_METALS" },
    unit: "index",
  },
  // Chemicals & polymers
  {
    seriesId: "WPU0571",
    label: "PPI: Industrial chemicals",
    scope: { kind: "material", code: "INDUSTRIAL_CHEMICALS" },
    unit: "index",
  },
  {
    seriesId: "WPU072",
    label: "PPI: Plastic resins and materials",
    scope: { kind: "material", code: "PLASTIC_RESINS" },
    unit: "index",
  },
  // Wood & paper
  {
    seriesId: "WPU0911",
    label: "PPI: Lumber",
    scope: { kind: "material", code: "LUMBER" },
    unit: "index",
  },
  {
    seriesId: "WPU0913",
    label: "PPI: Pulp, paper, and allied products",
    scope: { kind: "material", code: "PULP_PAPER" },
    unit: "index",
  },
  // Energy
  {
    seriesId: "WPU0561",
    label: "PPI: Crude petroleum (domestic production)",
    scope: { kind: "material", code: "CRUDE_PETROLEUM" },
    unit: "index",
  },
  {
    seriesId: "WPU057303",
    label: "PPI: Natural gas to industrial users",
    scope: { kind: "material", code: "NATURAL_GAS_INDUSTRIAL" },
    unit: "index",
  },
  {
    seriesId: "WPU061",
    label: "PPI: Fuels and related products and power",
    scope: { kind: "material", code: "FUELS_AND_POWER" },
    unit: "index",
  },
  // Freight & logistics (services-side PCU codes — scoped as categories)
  {
    seriesId: "PCU484121484121",
    label: "PPI: General freight trucking, long-distance, truckload",
    scope: { kind: "category", code: "FREIGHT_TRUCKING_TL" },
    unit: "index",
  },
  {
    seriesId: "PCU484122484122",
    label: "PPI: General freight trucking, long-distance, less than truckload",
    scope: { kind: "category", code: "FREIGHT_TRUCKING_LTL" },
    unit: "index",
  },
  {
    seriesId: "PCU482111482111",
    label: "PPI: Line-haul railroads",
    scope: { kind: "category", code: "RAIL_FREIGHT" },
    unit: "index",
  },
  {
    seriesId: "PCU493110493110",
    label: "PPI: Warehousing and storage",
    scope: { kind: "category", code: "WAREHOUSING_STORAGE" },
    unit: "index",
  },
  {
    seriesId: "PCU488510488510",
    label: "PPI: Freight transportation arrangement",
    scope: { kind: "category", code: "FREIGHT_BROKERAGE" },
    unit: "index",
  },
];

const FRED_API_BASE = "https://api.stlouisfed.org/fred";

interface FredObservation {
  date: string;
  value: string;
}

interface FredObservationsResponse {
  observations?: FredObservation[];
}

function seriesPageUrl(seriesId: string): string {
  return `https://fred.stlouisfed.org/series/${seriesId}`;
}

async function fetchLatestObservation(
  seriesId: string,
  apiKey: string,
): Promise<FredObservation | null> {
  const url = new URL(`${FRED_API_BASE}/series/observations`);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "1");

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `FRED ${seriesId} HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as FredObservationsResponse;
  const obs = json.observations?.[0];
  if (!obs) return null;
  // FRED uses "." for missing values.
  if (obs.value === "." || obs.value === "") return null;
  return obs;
}

export const fredEconomicIndexCollector: IntelligenceCollector = {
  id: "fred-economic-index",
  name: "FRED Economic Index (PPI)",
  description:
    "Pulls Producer Price Index sub-series (metals, chemicals, plastics, lumber, energy, freight, warehousing) from the St. Louis Fed FRED API and emits them as economic_index market signals scoped to procurement materials/categories.",
  posture: "public-api",
  sourceUrl: "https://fred.stlouisfed.org/",
  defaultRateLimitRpm: 30,
  defaultScheduleCron: "0 6 * * *",
  async collect({ since: _since }): Promise<MarketSignalDraft[]> {
    const apiKey = process.env["FRED_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "FRED_API_KEY env var is not set. Set it to your St. Louis Fed FRED API key (https://fred.stlouisfed.org/docs/api/api_key.html) before running the fred-economic-index collector.",
      );
    }

    const drafts: MarketSignalDraft[] = [];
    const failedSeries: Array<{ seriesId: string; error: string }> = [];

    for (const series of FRED_SERIES) {
      let obs: FredObservation | null;
      try {
        obs = await fetchLatestObservation(series.seriesId, apiKey);
      } catch (err) {
        // A single bad series id shouldn't kill the whole run, but we
        // track failures so we can surface them — and so we can throw
        // (rather than silently report success) if every series fails.
        const message = err instanceof Error ? err.message : String(err);
        failedSeries.push({ seriesId: series.seriesId, error: message });
        logger.warn(
          { collectorId: "fred-economic-index", seriesId: series.seriesId, err },
          "FRED series fetch failed",
        );
        continue;
      }
      if (!obs) continue;
      const value = Number(obs.value);
      if (!Number.isFinite(value)) continue;
      const observedAt = new Date(`${obs.date}T00:00:00Z`);
      if (Number.isNaN(observedAt.getTime())) continue;

      const draft: MarketSignalDraft = {
        signalType: "economic_index",
        value,
        unit: series.unit,
        currency: "USD",
        observedAt,
        sourceUrl: seriesPageUrl(series.seriesId),
        confidence: 0.95,
        metadata: {
          seriesId: series.seriesId,
          label: series.label,
          basis: "fred_latest_observation",
        },
      };
      if (series.scope.kind === "material") {
        draft.scopeMaterialCode = series.scope.code;
      } else {
        draft.scopeCategoryCode = series.scope.code;
      }
      drafts.push(draft);
    }

    // If every series failed, the run is genuinely broken (bad key,
    // FRED outage, network) — surface it to the runtime so the audit
    // log records `fetch_failed` instead of `fetch_succeeded` with 0.
    if (drafts.length === 0 && failedSeries.length === FRED_SERIES.length) {
      const sample = failedSeries.slice(0, 3).map((f) => f.error).join("; ");
      throw new Error(
        `FRED collector: all ${FRED_SERIES.length} series failed. Sample errors: ${sample}`,
      );
    }
    return drafts;
  },
};
