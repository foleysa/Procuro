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

import { z } from "zod";
import { logger } from "../../logger";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../collector";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";
import { FRED_SERIES_CATALOG } from "../scope-taxonomy";
import {
  buildConditionalHeaders,
  extractCacheHeaders,
  readCacheWatermarks,
  setPendingCacheCommit,
  takePendingCacheCommit,
  writeCacheWatermarks,
  type CacheHeaders,
} from "./cache-watermarks";

/**
 * FRED series shape exposed to the runtime + tests. Derived from the
 * canonical catalog so the two cannot drift.
 */
export type FredSeriesRef = (typeof FRED_SERIES_CATALOG)[number];

/**
 * The curated FRED series → canonical procurement scope mapping lives in
 * `../scope-taxonomy` so the collector and the lever analyzers that consume
 * these signals are guaranteed to agree on what each scope code means.
 *
 * To add or change a series, edit `FRED_SERIES_CATALOG` in scope-taxonomy.ts.
 */
export const FRED_SERIES: readonly FredSeriesRef[] = FRED_SERIES_CATALOG;

const FRED_API_BASE = "https://api.stlouisfed.org/fred";

/** Public id for the FRED economic index collector. */
export const FRED_ECONOMIC_INDEX_COLLECTOR_ID = "fred-economic-index";

/**
 * Default historical window for the on-demand backfill. Five years gives
 * downstream analyzers enough history to compute YoY comparisons, multi-cycle
 * trends, and momentum/inflection signals without pulling the entire archive
 * (some PPI series go back to the 1940s).
 */
const FRED_BACKFILL_DEFAULT_YEARS = 5;

export interface FredObservation {
  date: string;
  value: string;
}

interface FredObservationsResponse {
  observations?: FredObservation[];
}

function seriesPageUrl(seriesId: string): string {
  return `https://fred.stlouisfed.org/series/${seriesId}`;
}

/**
 * Build a `MarketSignalDraft` for a single FRED observation. Shared between
 * the live collector (`basis: "fred_latest_observation"`) and the historical
 * backfill (`basis: "fred_historical_backfill"`) so backfilled rows are
 * indistinguishable from rows the daily collector would have produced for
 * the same `(seriesId, observed_at)` — which is what lets the deduper
 * recognize them as the same signal.
 *
 * Returns `null` when the observation is FRED's "." missing-value marker or
 * an unparseable date.
 */
export function buildFredDraftForObservation(
  series: FredSeriesRef,
  obs: FredObservation,
  basis: "fred_latest_observation" | "fred_historical_backfill",
): MarketSignalDraft | null {
  if (obs.value === "." || obs.value === "") return null;
  const value = Number(obs.value);
  if (!Number.isFinite(value)) return null;
  const observedAt = new Date(`${obs.date}T00:00:00Z`);
  if (Number.isNaN(observedAt.getTime())) return null;

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
      basis,
    },
  };
  if (series.scope.kind === "material") {
    draft.scopeMaterialCode = series.scope.code;
  } else {
    draft.scopeCategoryCode = series.scope.code;
  }
  return draft;
}

/**
 * Result shape of a single per-series fetch. Distinguishes the three
 * outcomes the caller has to handle differently:
 *   - `unchanged`  → upstream returned 304; preserve watermark, no draft.
 *   - `fresh`      → upstream returned 200; capture cache headers and
 *                    parse the (possibly empty / missing-value) row.
 */
export type FetchLatestResult =
  | { kind: "unchanged" }
  | {
      kind: "fresh";
      observation: FredObservation | null;
      cacheHeaders: CacheHeaders;
    };

async function fetchLatestObservation(
  seriesId: string,
  apiKey: string,
  watermark: CacheHeaders | undefined,
  signal?: AbortSignal,
): Promise<FetchLatestResult> {
  const url = new URL(`${FRED_API_BASE}/series/observations`);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "1");

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...buildConditionalHeaders(watermark),
    },
    signal,
  });
  // 304 Not Modified: the cached observation set is byte-identical to
  // the prior poll. Skip the parse, preserve the watermark.
  if (res.status === 304) return { kind: "unchanged" };
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `FRED ${seriesId} HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  const cacheHeaders = extractCacheHeaders(res);
  const json = (await res.json()) as FredObservationsResponse;
  const obs = json.observations?.[0];
  if (!obs) return { kind: "fresh", observation: null, cacheHeaders };
  // FRED uses "." for missing values.
  if (obs.value === "." || obs.value === "") {
    return { kind: "fresh", observation: null, cacheHeaders };
  }
  return { kind: "fresh", observation: obs, cacheHeaders };
}

/**
 * Fetch the historical observation series for one FRED id starting at
 * `observationStart` (inclusive, `YYYY-MM-DD`). Sorted ascending so callers
 * see the oldest point first. Missing-value rows (FRED ".") are filtered
 * out here so caller code can stay simple.
 */
export async function fetchHistoricalObservations(
  seriesId: string,
  apiKey: string,
  observationStart: string,
): Promise<FredObservation[]> {
  const url = new URL(`${FRED_API_BASE}/series/observations`);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "asc");
  url.searchParams.set("observation_start", observationStart);

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
  const out: FredObservation[] = [];
  for (const o of json.observations ?? []) {
    if (o.value === "." || o.value === "") continue;
    out.push(o);
  }
  return out;
}

/**
 * Compute the default `observation_start` for the backfill: today minus
 * `FRED_BACKFILL_DEFAULT_YEARS` years, formatted `YYYY-MM-DD` (UTC).
 */
function defaultObservationStart(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear() - FRED_BACKFILL_DEFAULT_YEARS,
      now.getUTCMonth(),
      now.getUTCDate(),
    ),
  );
  return d.toISOString().slice(0, 10);
}

/**
 * One-shot historical backfill for the FRED economic index collector.
 *
 * Walks every series in `FRED_SERIES`, fetches its observation history from
 * `observationStart` (default: 5 years back), and returns one
 * `MarketSignalDraft` per (series × observation). The caller (runtime) is
 * responsible for the idempotent insert against `market_signals` so re-runs
 * are safe no-ops.
 *
 * A single bad series id (e.g. FRED removes a sub-series) does not abort
 * the whole run — failures are collected and surfaced to the caller, which
 * decides whether to throw (e.g. zero successes = genuine breakage).
 */
export async function fetchFredBackfillDrafts(opts?: {
  apiKey?: string;
  observationStart?: string;
}): Promise<{
  drafts: MarketSignalDraft[];
  failedSeries: Array<{ seriesId: string; error: string }>;
}> {
  const apiKey = opts?.apiKey ?? process.env["FRED_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "FRED_API_KEY env var is not set. Set it to your St. Louis Fed FRED API key (https://fred.stlouisfed.org/docs/api/api_key.html) before running the FRED backfill.",
    );
  }
  const observationStart = opts?.observationStart ?? defaultObservationStart();

  const drafts: MarketSignalDraft[] = [];
  const failedSeries: Array<{ seriesId: string; error: string }> = [];
  for (const series of FRED_SERIES) {
    let observations: FredObservation[];
    try {
      observations = await fetchHistoricalObservations(
        series.seriesId,
        apiKey,
        observationStart,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedSeries.push({ seriesId: series.seriesId, error: message });
      logger.warn(
        {
          collectorId: FRED_ECONOMIC_INDEX_COLLECTOR_ID,
          seriesId: series.seriesId,
          err,
        },
        "FRED historical fetch failed",
      );
      continue;
    }
    for (const obs of observations) {
      const draft = buildFredDraftForObservation(
        series,
        obs,
        "fred_historical_backfill",
      );
      if (draft) drafts.push(draft);
    }
  }
  return { drafts, failedSeries };
}

/**
 * Per-collector metadata schema. FRED drafts always carry the upstream
 * series id and observation date so re-parsers and downstream analyzers
 * can audit which sub-index a given signal came from.
 */
const fredMetadataSchema = z
  .object({
    seriesId: z.string().min(1),
    label: z.string().optional(),
    basis: z.string().optional(),
  })
  .passthrough();

const fredSignalSchema = buildSignalDraftSchema(fredMetadataSchema);

export const fredEconomicIndexCollector: IntelligenceCollector<
  typeof fredSignalSchema
> = {
  id: FRED_ECONOMIC_INDEX_COLLECTOR_ID,
  name: "FRED Economic Index (PPI)",
  description:
    "Pulls Producer Price Index sub-series (metals, chemicals, plastics, lumber, energy, freight, warehousing) from the St. Louis Fed FRED API and emits them as economic_index market signals scoped to procurement materials/categories.",
  posture: "public-api",
  sourceUrl: "https://fred.stlouisfed.org/",
  defaultRateLimitRpm: 30,
  defaultScheduleCron: "0 6 * * *",
  postureClass: "public_api",
  // FRED is a US Federal Reserve published API; full attribution is
  // permitted and analytically useful (lever explanations cite the
  // exact series id).
  disclosureTier: "T1",
  jurisdiction: "US",
  // Public-API default — keep the year of history GCS already has.
  retentionDays: 365,
  // Free public data; safe to enable for every tenant by default.
  tenantOptInDefault: true,
  signalSchema: fredSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(FRED_ECONOMIC_INDEX_COLLECTOR_ID, draft);
  },
  async collect({ since: _since, signal }): Promise<MarketSignalDraft[]> {
    const apiKey = process.env["FRED_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "FRED_API_KEY env var is not set. Set it to your St. Louis Fed FRED API key (https://fred.stlouisfed.org/docs/api/api_key.html) before running the fred-economic-index collector.",
      );
    }

    // Per-series watermark map. Empty on first run / DB read failure;
    // each series falls through to a full fetch in that case.
    const watermarks = await readCacheWatermarks(
      FRED_ECONOMIC_INDEX_COLLECTOR_ID,
    );
    const newWatermarks = new Map<string, CacheHeaders>(watermarks);

    const drafts: MarketSignalDraft[] = [];
    const failedSeries: Array<{ seriesId: string; error: string }> = [];
    let unchangedSeries = 0;

    for (const series of FRED_SERIES) {
      let result: FetchLatestResult;
      try {
        result = await fetchLatestObservation(
          series.seriesId,
          apiKey,
          watermarks.get(series.seriesId),
          signal,
        );
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
      // 304: preserve the existing watermark, skip draft emission.
      if (result.kind === "unchanged") {
        unchangedSeries += 1;
        continue;
      }
      // 200: capture fresh headers (or drop the entry if upstream
      // stopped sending cache headers, so we don't keep replaying a
      // stale watermark the server is no longer honouring).
      if (
        result.cacheHeaders.etag !== null ||
        result.cacheHeaders.lastModified !== null
      ) {
        newWatermarks.set(series.seriesId, result.cacheHeaders);
      } else {
        newWatermarks.delete(series.seriesId);
      }
      if (!result.observation) continue;
      const draft = buildFredDraftForObservation(
        series,
        result.observation,
        "fred_latest_observation",
      );
      if (draft) drafts.push(draft);
    }

    // If every series failed, the run is genuinely broken (bad key,
    // FRED outage, network) — surface it to the runtime so the audit
    // log records `fetch_failed` instead of `fetch_succeeded` with 0.
    // An unchanged 304 is NOT a failure, so the all-failed condition
    // remains `failedSeries.length === FRED_SERIES.length`.
    //
    // We throw BEFORE queuing the watermark so a fully-failed run
    // never advances state — the next run must re-fetch from scratch.
    if (drafts.length === 0 && failedSeries.length === FRED_SERIES.length) {
      const sample = failedSeries.slice(0, 3).map((f) => f.error).join("; ");
      throw new Error(
        `FRED collector: all ${FRED_SERIES.length} series failed. Sample errors: ${sample}`,
      );
    }

    // Queue the watermark write to fire AFTER the runtime's
    // insertSignalsWithDedupe succeeds. Writing it here directly would
    // open a window where collect() returns OK but the downstream
    // insert fails — leaving the next run with an advanced per-series
    // watermark and a 304 short-circuit on observations we never
    // committed. See `cache-watermarks.ts` for the full rationale.
    setPendingCacheCommit(FRED_ECONOMIC_INDEX_COLLECTOR_ID, () =>
      writeCacheWatermarks(
        FRED_ECONOMIC_INDEX_COLLECTOR_ID,
        newWatermarks,
        { unchangedSeries, totalSeries: FRED_SERIES.length },
      ),
    );

    return drafts;
  },

  /**
   * Hand the runtime the pending watermark write so it fires only after
   * `insertSignalsWithDedupe` commits the run's drafts. Mirrors the BLS
   * collector and the ECB historical-archive pattern from Task #127.
   */
  takePendingPostInsertCommit(): (() => Promise<void>) | null {
    return takePendingCacheCommit(FRED_ECONOMIC_INDEX_COLLECTOR_ID);
  },
};
