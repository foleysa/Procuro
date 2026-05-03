/**
 * Eurostat economic index collector.
 *
 * Source: Eurostat dissemination REST API
 *   https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset}
 *
 * Why this collector exists
 * -------------------------
 * The FRED + BLS collectors give US-side PPI/CPI coverage but procurement
 * teams buying in Europe need EU-area PPI (industrial + services) and
 * HICP sub-indices (overall, energy, food, services) so spot/contract,
 * supplier price-increase, and inflation-pass-through analyzers have a
 * comparable reference for euro-denominated spend.
 *
 * Posture: `public-api` — Eurostat publishes a documented REST API that
 * requires no API key (free re-use with attribution per the Eurostat
 * copyright policy). We default to a conservative 30 rpm.
 *
 * Auth: NONE. Unlike FRED/BLS/USDA-NASS, Eurostat is open data with no
 * key — there is intentionally no env-var guard in `collect()` /
 * `fetchEurostatBackfillDrafts`.
 *
 * Idempotency
 * -----------
 * The runtime's natural-key dedupe (collectorId, signalType, scope_*,
 * observed_at) makes re-runs safe. Both the live `collect()` (latest
 * observation per series) and the one-shot historical backfill
 * (default: 5 years) call the same `buildEurostatDraftForObservation`
 * so a backfilled row is indistinguishable from a row the daily
 * collector would have produced for the same `(seriesCode, observed_at)`.
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

/** Public id for the Eurostat economic index collector. */
export const EUROSTAT_ECONOMIC_INDEX_COLLECTOR_ID = "eurostat-economic-index";

const EUROSTAT_API_BASE =
  "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
const EUROSTAT_LANDING_URL = "https://ec.europa.eu/eurostat";

/** Default historical window for the on-demand backfill (matches FRED/NASS). */
const EUROSTAT_BACKFILL_DEFAULT_YEARS = 5;

/**
 * One curated Eurostat series.
 *
 * `dataset` is the Eurostat dataset code (e.g. `prc_hicp_midx`,
 * `sts_inppd_m`). `filters` pin every non-time dimension to a single
 * value so the response is one observation per time period — anything
 * left unfiltered would fan out into a multi-dimensional cube the
 * parser would have to disambiguate.
 *
 * `scopeCategoryCode` is the canonical procurement scope code surfaced
 * on the MarketSignal so downstream lever logic can correlate across
 * collectors. Per task #243 scope, mapping Eurostat series to specific
 * procurement categories beyond the obvious overall/energy/food/services
 * buckets is intentionally out of scope.
 */
export interface EurostatSeriesRef {
  /** Stable code used for metadata, dedupe, and the curated guardrail. */
  code: string;
  label: string;
  dataset: string;
  /** All non-`time` dimension selectors. */
  filters: Readonly<Record<string, string>>;
  frequency: "monthly" | "quarterly";
  scopeCategoryCode: string;
  /** Eurostat reference period label ("2015=100", "2021=100"); kept in metadata. */
  baseLabel: string;
}

/**
 * Curated Eurostat series tracked by this collector.
 *
 * Per task #243 scope: HICP overall + energy/food/services sub-indices
 * (monthly, prc_hicp_midx) and industrial + services PPI (sts_inppd_m
 * monthly, sts_sepp_q quarterly). All series are euro-area aggregates
 * (geo=EA20) so a single time series per scope code lands on the
 * MarketSignal, and the curated-list guardrail test pins each entry
 * against silent removal.
 */
export const EUROSTAT_SERIES: readonly EurostatSeriesRef[] = [
  // --- HICP (Harmonised Index of Consumer Prices), monthly, base 2015=100 ---
  {
    code: "HICP_EA_OVERALL",
    label: "HICP — Euro area, all-items (2015=100)",
    dataset: "prc_hicp_midx",
    filters: { geo: "EA20", coicop: "CP00", unit: "I15" },
    frequency: "monthly",
    scopeCategoryCode: "EU_HICP_OVERALL",
    baseLabel: "2015=100",
  },
  {
    code: "HICP_EA_ENERGY",
    label: "HICP — Euro area, energy (2015=100)",
    dataset: "prc_hicp_midx",
    filters: { geo: "EA20", coicop: "NRG", unit: "I15" },
    frequency: "monthly",
    scopeCategoryCode: "EU_HICP_ENERGY",
    baseLabel: "2015=100",
  },
  {
    code: "HICP_EA_FOOD",
    label: "HICP — Euro area, food including alcohol & tobacco (2015=100)",
    dataset: "prc_hicp_midx",
    filters: { geo: "EA20", coicop: "FOOD", unit: "I15" },
    frequency: "monthly",
    scopeCategoryCode: "EU_HICP_FOOD",
    baseLabel: "2015=100",
  },
  {
    code: "HICP_EA_SERVICES",
    label: "HICP — Euro area, services (2015=100)",
    dataset: "prc_hicp_midx",
    filters: { geo: "EA20", coicop: "SERV", unit: "I15" },
    frequency: "monthly",
    scopeCategoryCode: "EU_HICP_SERVICES",
    baseLabel: "2015=100",
  },

  // --- Industrial PPI, domestic market, monthly, base 2021=100 ---
  // nace_r2 B-D = Mining + Manufacturing + Electricity (industry total
  // excluding construction). indic_bt=PRC_PRR_DOM = "Domestic producer
  // prices" — the headline domestic-market PPI series Eurostat
  // currently publishes for `sts_inppd_m` (verified live 2026-05).
  // NSA = not seasonally adjusted (Eurostat's headline release).
  {
    code: "PPI_EA_INDUSTRY",
    label: "Industrial PPI — Euro area, domestic market (2021=100)",
    dataset: "sts_inppd_m",
    filters: {
      geo: "EA20",
      nace_r2: "B-D",
      indic_bt: "PRC_PRR_DOM",
      unit: "I21",
      s_adj: "NSA",
    },
    frequency: "monthly",
    scopeCategoryCode: "EU_PPI_INDUSTRY",
    baseLabel: "2021=100",
  },

  // --- Services PPI, quarterly, base 2021=100 ---
  // nace_r2 H-N_X_K = "Services of the business economy (except trade
  // and financial and insurance activities)" — the broadest aggregate
  // for which Eurostat actually publishes a value-bearing services PPI
  // index (the older `H-N_STS` aggregate currently returns an empty
  // cube for I21; verified live 2026-05).
  {
    code: "PPI_EA_SERVICES",
    label: "Services PPI — Euro area (2021=100, quarterly)",
    dataset: "sts_sepp_q",
    filters: {
      geo: "EA20",
      nace_r2: "H-N_X_K",
      indic_bt: "PRC_PRR",
      unit: "I21",
      s_adj: "NSA",
    },
    frequency: "quarterly",
    scopeCategoryCode: "EU_PPI_SERVICES",
    baseLabel: "2021=100",
  },
];

/**
 * Minimal subset of the JSON-stat 2.0 response shape we read. The full
 * spec carries label tables, status flags, source attribution, etc.
 * that we don't need for parsing observations.
 */
export interface JsonStatCategory {
  index?: Record<string, number> | string[];
  label?: Record<string, string>;
}
export interface JsonStatDimension {
  category?: JsonStatCategory;
}
export interface JsonStatResponse {
  /** "JSON-stat 2.0" or "JSON-stat" */
  class?: string;
  /** Dimension axis order, e.g. ["geo","coicop","unit","time"]. */
  id?: string[];
  /** Per-axis size, parallel to `id`. */
  size?: number[];
  /** Sparse value map — keys are flat indices into the cube. */
  value?: Record<string, number | null>;
  /** Per-dimension category metadata, keyed by dimension id. */
  dimension?: Record<string, JsonStatDimension>;
}

/**
 * One parsed observation extracted from a JSON-stat response.
 * `period` is the raw Eurostat time string ("2024-03" / "2024-Q1");
 * `observedAt` is the canonical end-of-period UTC date used as the
 * dedupe key.
 */
export interface EurostatObservation {
  period: string;
  observedAt: Date;
  value: number;
}

/**
 * Parse a Eurostat time-period string into the last instant of that
 * period, UTC. Supports monthly ("YYYY-MM") and quarterly
 * ("YYYY-QN") periods only — annual / semester / weekly tokens map to
 * `null` so callers can drop them rather than emit a misleading date.
 */
export function parseEurostatPeriodEnd(period: string): Date | null {
  const monthly = /^(\d{4})-(\d{2})$/.exec(period);
  if (monthly) {
    const y = Number(monthly[1]);
    const m = Number(monthly[2]);
    if (!Number.isInteger(y) || y < 1900 || y > 2200) return null;
    if (!Number.isInteger(m) || m < 1 || m > 12) return null;
    // Date.UTC(year, monthIndex, 0) rolls back to the last day of the
    // previous monthIndex — passing m (1-12) gives the last day of
    // month m.
    return new Date(Date.UTC(y, m, 0, 23, 59, 59));
  }
  const quarterly = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarterly) {
    const y = Number(quarterly[1]);
    const q = Number(quarterly[2]);
    if (!Number.isInteger(y) || y < 1900 || y > 2200) return null;
    // Quarter end month (1-indexed): Q1→3, Q2→6, Q3→9, Q4→12.
    const m = q * 3;
    return new Date(Date.UTC(y, m, 0, 23, 59, 59));
  }
  return null;
}

/**
 * Resolve the integer index a dimension category sits at on its axis.
 * JSON-stat allows two forms:
 *   - object form `{ "EA20": 0, "EU27_2020": 1 }`
 *   - array form `["EA20", "EU27_2020"]`
 * Returns `null` when the value is not present on the axis.
 */
export function categoryIndex(
  cat: JsonStatCategory | undefined,
  value: string,
): number | null {
  if (!cat || !cat.index) return null;
  if (Array.isArray(cat.index)) {
    const i = cat.index.indexOf(value);
    return i === -1 ? null : i;
  }
  const i = cat.index[value];
  return typeof i === "number" ? i : null;
}

/**
 * Enumerate `(period, periodIndex)` pairs from the response's `time`
 * dimension. Eurostat sorts time ascending so callers iterating in the
 * returned order see the oldest observation first.
 */
export function listTimePoints(
  response: JsonStatResponse,
): Array<{ period: string; index: number }> {
  const cat = response.dimension?.["time"]?.category;
  if (!cat || !cat.index) return [];
  if (Array.isArray(cat.index)) {
    return cat.index.map((period, index) => ({ period, index }));
  }
  const out: Array<{ period: string; index: number }> = [];
  for (const [period, index] of Object.entries(cat.index)) {
    out.push({ period, index });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * Compute the flat index into `response.value` for a given coordinate.
 * JSON-stat row-major formula: idx = sum(coord[i] * product(size[i+1..])).
 * Returns `null` when `size` / `id` are missing or any coord is OOB.
 */
function flatIndex(
  size: number[],
  coords: number[],
): number | null {
  if (size.length !== coords.length) return null;
  let stride = 1;
  let idx = 0;
  for (let i = size.length - 1; i >= 0; i--) {
    const dim = size[i];
    const c = coords[i];
    if (dim === undefined || c === undefined) return null;
    if (c < 0 || c >= dim) return null;
    idx += c * stride;
    stride *= dim;
  }
  return idx;
}

/**
 * Extract every `(period, value)` pair for `series` from a JSON-stat
 * response. Drops periods we can't parse as a calendar month/quarter
 * end, and drops null/non-finite values rather than emitting NaN.
 */
export function parseEurostatObservations(
  series: EurostatSeriesRef,
  response: JsonStatResponse,
): EurostatObservation[] {
  const id = response.id;
  const size = response.size;
  if (!id || !size || id.length !== size.length) return [];
  const timeAxis = id.indexOf("time");
  if (timeAxis === -1) return [];

  // Resolve every non-time dimension to its singleton coordinate. We
  // expect each curated query to pin every other axis to one category;
  // if a dim has multiple values on it we fall back to category 0 only
  // when the response says size===1 there (i.e. Eurostat collapsed it
  // server-side), and otherwise refuse the series to avoid mis-routing
  // a multi-dim cube into a single time series.
  const baseCoords: number[] = new Array(id.length).fill(0);
  for (let i = 0; i < id.length; i++) {
    const dim = id[i];
    if (dim === "time" || dim === undefined) continue;
    const wantedValue = series.filters[dim];
    const dimSize = size[i] ?? 0;
    if (wantedValue === undefined) {
      if (dimSize !== 1) return [];
      baseCoords[i] = 0;
      continue;
    }
    const cat = response.dimension?.[dim]?.category;
    const ci = categoryIndex(cat, wantedValue);
    if (ci === null) return [];
    baseCoords[i] = ci;
  }

  const out: EurostatObservation[] = [];
  for (const tp of listTimePoints(response)) {
    const observedAt = parseEurostatPeriodEnd(tp.period);
    if (!observedAt) continue;
    const coords = baseCoords.slice();
    coords[timeAxis] = tp.index;
    const flat = flatIndex(size, coords);
    if (flat === null) continue;
    const raw = response.value?.[String(flat)];
    if (raw === null || raw === undefined) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    out.push({ period: tp.period, observedAt, value: v });
  }
  return out;
}

/**
 * Build a `MarketSignalDraft` for a single Eurostat observation. Shared
 * between the live collector (`basis: "eurostat_latest_observation"`)
 * and the historical backfill (`basis: "eurostat_historical_backfill"`)
 * so backfilled rows dedupe cleanly against same-day live rows.
 */
export function buildEurostatDraftForObservation(
  series: EurostatSeriesRef,
  obs: EurostatObservation,
  basis: "eurostat_latest_observation" | "eurostat_historical_backfill",
): MarketSignalDraft | null {
  if (!Number.isFinite(obs.value)) return null;
  return {
    signalType: "economic_index",
    scopeCategoryCode: series.scopeCategoryCode,
    value: +obs.value.toFixed(6),
    unit: "index",
    currency: "EUR",
    observedAt: obs.observedAt,
    sourceUrl: `${EUROSTAT_LANDING_URL}/web/products-datasets/-/${series.dataset}`,
    confidence: 0.95,
    metadata: {
      seriesCode: series.code,
      label: series.label,
      dataset: series.dataset,
      period: obs.period,
      frequency: series.frequency,
      baseLabel: series.baseLabel,
      basis,
    },
  };
}

/**
 * Build the Eurostat REST URL for one curated series. `extra` lets the
 * caller append `lastTimePeriod=1` (live) or `sinceTimePeriod=YYYY-MM`
 * (backfill) without forking the URL builder.
 */
export function buildEurostatUrl(
  series: EurostatSeriesRef,
  extra: Readonly<Record<string, string>> = {},
): string {
  const url = new URL(`${EUROSTAT_API_BASE}/${series.dataset}`);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("lang", "EN");
  for (const [k, v] of Object.entries(series.filters)) {
    url.searchParams.append(k, v);
  }
  for (const [k, v] of Object.entries(extra)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Fetch one Eurostat series and return its parsed observations.
 * Throws on non-2xx so the caller's per-series try/catch can record
 * the failure without poisoning the rest of the run.
 */
export async function fetchEurostatSeries(
  series: EurostatSeriesRef,
  extra: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<EurostatObservation[]> {
  const url = buildEurostatUrl(series, extra);
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Eurostat ${series.code} HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as JsonStatResponse;
  return parseEurostatObservations(series, json);
}

/** Compute the default `sinceTimePeriod` for the backfill (5y back). */
function defaultSinceTimePeriod(
  frequency: "monthly" | "quarterly",
  now: Date = new Date(),
): string {
  const y = now.getUTCFullYear() - EUROSTAT_BACKFILL_DEFAULT_YEARS;
  if (frequency === "monthly") {
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

/**
 * One-shot historical backfill for the Eurostat collector. Walks every
 * series in `EUROSTAT_SERIES`, fetches its history from the per-frequency
 * default window (5 years back), and returns one `MarketSignalDraft`
 * per (series × period). The runtime owns the idempotent insert.
 *
 * A single bad series doesn't abort the whole run — failures are
 * collected and surfaced to the caller, which decides whether to throw.
 */
export async function fetchEurostatBackfillDrafts(opts?: {
  /** Override the per-frequency `sinceTimePeriod`. */
  sinceMonthly?: string;
  sinceQuarterly?: string;
}): Promise<{
  drafts: MarketSignalDraft[];
  failedSeries: Array<{ code: string; error: string }>;
}> {
  const sinceMonthly = opts?.sinceMonthly ?? defaultSinceTimePeriod("monthly");
  const sinceQuarterly =
    opts?.sinceQuarterly ?? defaultSinceTimePeriod("quarterly");

  const drafts: MarketSignalDraft[] = [];
  const failedSeries: Array<{ code: string; error: string }> = [];
  for (const series of EUROSTAT_SERIES) {
    const since =
      series.frequency === "monthly" ? sinceMonthly : sinceQuarterly;
    let observations: EurostatObservation[];
    try {
      observations = await fetchEurostatSeries(series, {
        sinceTimePeriod: since,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedSeries.push({ code: series.code, error: message });
      logger.warn(
        {
          collectorId: EUROSTAT_ECONOMIC_INDEX_COLLECTOR_ID,
          seriesCode: series.code,
          err,
        },
        "Eurostat historical fetch failed",
      );
      continue;
    }
    if (observations.length === 0) {
      // Eurostat returned 200 with an empty value cube — the dataset
      // is reachable but the curated filter combination doesn't pin
      // any published cell. Treat as a failed series (not a silent
      // zero-row success) so the runtime audit log reflects reality.
      failedSeries.push({
        code: series.code,
        error: `Eurostat ${series.code}: 200 OK but 0 observations for filters ${JSON.stringify(series.filters)}`,
      });
      logger.warn(
        {
          collectorId: EUROSTAT_ECONOMIC_INDEX_COLLECTOR_ID,
          seriesCode: series.code,
          filters: series.filters,
        },
        "Eurostat historical fetch returned no observations",
      );
      continue;
    }
    for (const obs of observations) {
      const draft = buildEurostatDraftForObservation(
        series,
        obs,
        "eurostat_historical_backfill",
      );
      if (draft) drafts.push(draft);
    }
  }
  return { drafts, failedSeries };
}

/**
 * Per-collector metadata schema. Eurostat drafts always carry the
 * upstream series code, dataset, raw period string, and frequency so
 * re-parsers and downstream analyzers can audit which dataset slice a
 * given signal came from.
 */
const eurostatMetadataSchema = z
  .object({
    seriesCode: z.string().min(1),
    label: z.string().optional(),
    dataset: z.string().min(1),
    period: z.string().optional(),
    frequency: z.enum(["monthly", "quarterly"]).optional(),
    baseLabel: z.string().optional(),
    basis: z.string().optional(),
  })
  .passthrough();

const eurostatSignalSchema = buildSignalDraftSchema(eurostatMetadataSchema);

export const eurostatEconomicIndexCollector: IntelligenceCollector<
  typeof eurostatSignalSchema
> = {
  id: EUROSTAT_ECONOMIC_INDEX_COLLECTOR_ID,
  name: "Eurostat Economic Index (HICP + PPI)",
  description:
    "Pulls Euro-area HICP sub-indices (overall, energy, food, services) and Industrial / Services PPI from the Eurostat dissemination REST API and emits them as economic_index market signals scoped to EU procurement category buckets.",
  posture: "public-api",
  sourceUrl: EUROSTAT_LANDING_URL,
  defaultRateLimitRpm: 30,
  // Eurostat releases monthly indices in the second half of the
  // following month; a daily 7am-UTC poll picks new releases up within
  // a day at trivial cost, and the natural-key dedupe makes redundant
  // polls free.
  defaultScheduleCron: "0 7 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "EU",
  retentionDays: 365,
  // Free public data with attribution; safe to enable for every tenant.
  tenantOptInDefault: true,
  signalSchema: eurostatSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(
      EUROSTAT_ECONOMIC_INDEX_COLLECTOR_ID,
      draft,
    );
  },
  async collect({ since: _since, signal }): Promise<MarketSignalDraft[]> {
    // Eurostat is keyless — no env-var guard.
    const drafts: MarketSignalDraft[] = [];
    const failedSeries: Array<{ code: string; error: string }> = [];

    for (const series of EUROSTAT_SERIES) {
      let observations: EurostatObservation[];
      try {
        observations = await fetchEurostatSeries(
          series,
          { lastTimePeriod: "1" },
          signal,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failedSeries.push({ code: series.code, error: message });
        logger.warn(
          {
            collectorId: EUROSTAT_ECONOMIC_INDEX_COLLECTOR_ID,
            seriesCode: series.code,
            err,
          },
          "Eurostat series fetch failed",
        );
        continue;
      }
      // `lastTimePeriod=1` collapses each series to its newest period;
      // we still defensively pick the maximum observedAt so a future
      // Eurostat behaviour change (returning two periods) doesn't pick
      // the older one.
      let latest: EurostatObservation | null = null;
      for (const obs of observations) {
        if (!latest || obs.observedAt > latest.observedAt) latest = obs;
      }
      if (!latest) {
        // 200 with no parseable observation means the curated filter
        // combination matched no published cell — record as a failed
        // series so an upstream filter regression is visible instead
        // of silently shrinking the curated set.
        failedSeries.push({
          code: series.code,
          error: `Eurostat ${series.code}: 200 OK but 0 observations for filters ${JSON.stringify(series.filters)}`,
        });
        logger.warn(
          {
            collectorId: EUROSTAT_ECONOMIC_INDEX_COLLECTOR_ID,
            seriesCode: series.code,
            filters: series.filters,
          },
          "Eurostat live fetch returned no observations",
        );
        continue;
      }
      const draft = buildEurostatDraftForObservation(
        series,
        latest,
        "eurostat_latest_observation",
      );
      if (draft) drafts.push(draft);
    }

    // If every series failed, the run is genuinely broken (Eurostat
    // outage, network, schema rev) — surface it to the runtime so the
    // audit log records `fetch_failed` instead of `fetch_succeeded` with 0.
    if (
      drafts.length === 0 &&
      failedSeries.length === EUROSTAT_SERIES.length
    ) {
      const sample = failedSeries
        .slice(0, 3)
        .map((f) => f.error)
        .join("; ");
      throw new Error(
        `Eurostat collector: all ${EUROSTAT_SERIES.length} series failed. Sample errors: ${sample}`,
      );
    }

    return drafts;
  },
};
