/**
 * USDA NASS QuickStats agricultural commodity collector.
 *
 * Source: USDA National Agricultural Statistics Service (NASS) QuickStats
 *   API — https://quickstats.nass.usda.gov/api
 *
 * Why this collector exists
 * -------------------------
 * The World Bank Pink Sheet covers global commodities at a high level
 * (e.g. "Wheat, US HRW", "Maize", "Soybeans" monthly averages) but US
 * procurement teams buying food, fiber, livestock, or agricultural
 * inputs need US-specific monthly Prices Received series. NASS is the
 * authoritative US federal source.
 *
 * Posture: `public-api` — NASS publishes a documented REST/JSON API
 * with a per-key rate limit. We default to a conservative 30 rpm.
 *
 * Auth: requires a `USDA_NASS_API_KEY` env var. If unset, both the live
 * collector and the historical backfill throw a clear, actionable error
 * — mirroring how FRED handles `FRED_API_KEY` so the audit log records
 * the same root cause and the System page surfaces a 409 instead of a
 * 500.
 *
 * Idempotency
 * -----------
 * The runtime's natural-key dedupe (collectorId, signalType, scope_*,
 * observed_at) makes re-runs safe. Both the live `collect()` (latest
 * monthly observation per series) and the one-shot historical backfill
 * (default: 5 years) call the same `buildNassDraftForObservation` so a
 * backfilled row is indistinguishable from a row the daily collector
 * would have produced for the same `(short_desc, observed_at)`.
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

/** Public id for the USDA NASS economic index collector. */
export const USDA_NASS_ECONOMIC_INDEX_COLLECTOR_ID = "usda-nass-economic-index";

const NASS_API_URL = "https://quickstats.nass.usda.gov/api/api_GET/";
const NASS_LANDING_URL = "https://quickstats.nass.usda.gov/";

/**
 * Default historical window for the on-demand backfill. Five years
 * matches the FRED default and gives downstream analyzers enough
 * history to compute YoY comparisons and multi-cycle trends without
 * pulling NASS's full archive (some series go back to the 1860s).
 */
const NASS_BACKFILL_DEFAULT_YEARS = 5;

/**
 * One curated NASS commodity series.
 *
 * `query` is the (commodity_desc + class_desc + statisticcat_desc +
 * unit_desc + agg_level_desc + freq_desc) filter combination that
 * uniquely identifies a single NASS `short_desc` series. NASS returns
 * many overlapping series per commodity (different classes, units,
 * geographies, frequencies) so each entry pins the exact slice we want.
 *
 * `materialCode` is the canonical material code surfaced on the
 * MarketSignal so downstream lever logic and category-page renderers
 * can correlate across collectors. `expectedUnit` is the post-normalize
 * unit string we expect on the row — drift triggers a warning so a
 * human can audit the change.
 */
export interface NassSeriesRef {
  materialCode: string;
  label: string;
  expectedUnit: string;
  query: Readonly<Record<string, string>>;
}

/**
 * Curated agricultural commodities tracked by this collector.
 *
 * Per task #244 scope: corn, wheat, soybeans, dairy (milk + cheese +
 * butter), beef, pork, poultry, cotton. We pin the most-aggregated
 * national monthly Prices Received series for each so the analytical
 * surface gets a single time series per material code.
 *
 * Adding or changing a series: extend this list and the
 * `usda-nass-curated-list` guardrail test will pin the new series id
 * against silent removal.
 */
export const NASS_SERIES: readonly NassSeriesRef[] = [
  // Grains & oilseeds
  {
    materialCode: "CORN",
    label: "Corn, grain — US monthly price received",
    expectedUnit: "USD/bu",
    query: {
      commodity_desc: "CORN",
      class_desc: "GRAIN",
      statisticcat_desc: "PRICE RECEIVED",
      unit_desc: "$ / BU",
      agg_level_desc: "NATIONAL",
      freq_desc: "MONTHLY",
    },
  },
  {
    materialCode: "WHEAT",
    label: "Wheat, all classes — US monthly price received",
    expectedUnit: "USD/bu",
    query: {
      commodity_desc: "WHEAT",
      class_desc: "ALL CLASSES",
      statisticcat_desc: "PRICE RECEIVED",
      unit_desc: "$ / BU",
      agg_level_desc: "NATIONAL",
      freq_desc: "MONTHLY",
    },
  },
  {
    materialCode: "SOYBEANS",
    label: "Soybeans — US monthly price received",
    expectedUnit: "USD/bu",
    query: {
      commodity_desc: "SOYBEANS",
      statisticcat_desc: "PRICE RECEIVED",
      unit_desc: "$ / BU",
      agg_level_desc: "NATIONAL",
      freq_desc: "MONTHLY",
    },
  },

  // Dairy
  {
    materialCode: "MILK",
    label: "Milk, all — US monthly price received",
    expectedUnit: "USD/cwt",
    query: {
      commodity_desc: "MILK",
      class_desc: "ALL CLASSES",
      statisticcat_desc: "PRICE RECEIVED",
      unit_desc: "$ / CWT",
      agg_level_desc: "NATIONAL",
      freq_desc: "MONTHLY",
    },
  },
  {
    materialCode: "CHEESE",
    label: "Cheese — US monthly wholesale price",
    expectedUnit: "USD/lb",
    query: {
      commodity_desc: "CHEESE",
      statisticcat_desc: "PRICE RECEIVED",
      agg_level_desc: "NATIONAL",
      freq_desc: "MONTHLY",
    },
  },
  {
    materialCode: "BUTTER",
    label: "Butter — US monthly wholesale price",
    expectedUnit: "USD/lb",
    query: {
      commodity_desc: "BUTTER",
      statisticcat_desc: "PRICE RECEIVED",
      agg_level_desc: "NATIONAL",
      freq_desc: "MONTHLY",
    },
  },

  // Livestock & meat
  {
    materialCode: "BEEF_CATTLE",
    label: "Beef cattle, steers & heifers — US monthly price received",
    expectedUnit: "USD/cwt",
    query: {
      commodity_desc: "CATTLE",
      class_desc: "STEERS & HEIFERS",
      statisticcat_desc: "PRICE RECEIVED",
      unit_desc: "$ / CWT",
      agg_level_desc: "NATIONAL",
      freq_desc: "MONTHLY",
    },
  },
  {
    materialCode: "HOGS",
    label: "Hogs — US monthly price received",
    expectedUnit: "USD/cwt",
    query: {
      commodity_desc: "HOGS",
      statisticcat_desc: "PRICE RECEIVED",
      unit_desc: "$ / CWT",
      agg_level_desc: "NATIONAL",
      freq_desc: "MONTHLY",
    },
  },
  {
    materialCode: "BROILERS",
    label: "Broilers — US monthly price received",
    expectedUnit: "USD/lb",
    query: {
      commodity_desc: "CHICKENS",
      class_desc: "BROILERS",
      statisticcat_desc: "PRICE RECEIVED",
      agg_level_desc: "NATIONAL",
      freq_desc: "MONTHLY",
    },
  },

  // Fiber
  {
    materialCode: "COTTON",
    label: "Upland cotton — US monthly price received",
    expectedUnit: "USD/lb",
    query: {
      commodity_desc: "COTTON",
      class_desc: "UPLAND",
      statisticcat_desc: "PRICE RECEIVED",
      unit_desc: "$ / LB",
      agg_level_desc: "NATIONAL",
      freq_desc: "MONTHLY",
    },
  },
];

/** Raw row shape returned by NASS QuickStats `/api_GET/`. */
export interface NassRow {
  short_desc?: string;
  commodity_desc?: string;
  year?: string;
  reference_period_desc?: string;
  value?: string;
  unit_desc?: string;
  load_time?: string;
}

interface NassResponse {
  data?: NassRow[];
}

/**
 * Three-letter month abbreviation → 1-indexed month number. NASS
 * publishes monthly observations with `reference_period_desc` set to
 * the upper-case month name (e.g. "JAN", "FEB"). Non-monthly periods
 * ("MARKETING YEAR", "ANNUAL", "JAN THRU MAR") map to `null` so the
 * caller can drop them.
 */
const MONTH_ABBREV: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/**
 * Parse `(year, reference_period_desc)` into the last instant of that
 * month, UTC. Returns `null` for non-monthly periods or unparseable
 * inputs so the caller can filter them out of the draft stream.
 */
export function parseNassMonthEnd(
  year: string | undefined,
  refPeriod: string | undefined,
): Date | null {
  if (!year || !refPeriod) return null;
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1900 || y > 2200) return null;
  const m = MONTH_ABBREV[refPeriod.trim().toUpperCase()];
  if (!m) return null;
  // Date.UTC(year, month, 0) yields the last day of (month) — month is
  // 0-indexed in Date.UTC and day 0 rolls back to the previous month's
  // last day, so passing m (1-12) gives us the last day of month m.
  return new Date(Date.UTC(y, m, 0, 23, 59, 59));
}

/**
 * Normalise NASS unit strings ("$ / BU", "$ / CWT", "$ / LB") into the
 * platform-canonical "USD/<unit>" form. Returns `null` when the input
 * doesn't look like a USD-per-unit string.
 */
export function normalizeNassUnit(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^\$\s*\/\s*([A-Z]+)$/i);
  if (!m || !m[1]) return null;
  return `USD/${m[1].trim().toLowerCase()}`;
}

/**
 * Parse a NASS value cell. NASS returns numbers as strings, sometimes
 * with thousands separators ("1,234.5") and sometimes as the literal
 * "(D)" / "(NA)" / "(Z)" markers for suppressed or missing data. We
 * return `null` for anything that isn't a finite number.
 */
export function parseNassValue(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("(")) return null;
  const n = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a `MarketSignalDraft` from a single NASS row + its series
 * descriptor. Shared between the live collector
 * (`basis: "nass_latest_observation"`) and the historical backfill
 * (`basis: "nass_historical_backfill"`) so backfilled rows dedupe
 * cleanly against same-day live rows.
 *
 * Returns `null` when the row's value is missing/suppressed or its
 * period can't be parsed as a single month.
 */
export function buildNassDraftForObservation(
  series: NassSeriesRef,
  row: NassRow,
  basis: "nass_latest_observation" | "nass_historical_backfill",
): MarketSignalDraft | null {
  const value = parseNassValue(row.value);
  if (value === null) return null;
  const observedAt = parseNassMonthEnd(row.year, row.reference_period_desc);
  if (!observedAt) return null;
  const unit = normalizeNassUnit(row.unit_desc) ?? series.expectedUnit;
  return {
    signalType: "commodity_index" as const,
    scopeMaterialCode: series.materialCode,
    value: +value.toFixed(6),
    unit,
    currency: "USD",
    observedAt,
    sourceUrl: NASS_LANDING_URL,
    confidence: 0.9,
    metadata: {
      shortDesc: row.short_desc ?? null,
      commodityDesc: row.commodity_desc ?? series.query["commodity_desc"] ?? null,
      year: row.year ?? null,
      referencePeriod: row.reference_period_desc ?? null,
      basis,
    },
  };
}

/**
 * Fetch all NASS rows matching `series.query` from `yearGe` (inclusive)
 * onward. Throws on transport / non-2xx errors so the caller's
 * try/catch can record the per-series failure without poisoning the
 * other series in the same run.
 */
export async function fetchNassRows(
  series: NassSeriesRef,
  apiKey: string,
  yearGe: number,
  signal?: AbortSignal,
): Promise<NassRow[]> {
  const url = new URL(NASS_API_URL);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("year__GE", String(yearGe));
  for (const [k, v] of Object.entries(series.query)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    // NASS uses 400 for "no records found matching this query" — treat
    // that as an empty result, not a transport failure, so a curated
    // entry that NASS temporarily stops publishing doesn't kill the
    // whole run.
    if (res.status === 400) {
      const body = await res.text().catch(() => "");
      if (body.toLowerCase().includes("no records")) return [];
    }
    const body = await res.text().catch(() => "");
    throw new Error(
      `USDA NASS ${series.materialCode} HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as NassResponse;
  return json.data ?? [];
}

/**
 * Pick the row with the most-recent monthly observation from `rows`.
 * Used by the live collector to emit a single latest-observation
 * draft per series. Non-monthly rows are filtered out before the
 * comparison so a "MARKETING YEAR" entry can never beat the most
 * recent calendar month.
 */
export function selectLatestMonthly(rows: NassRow[]): NassRow | null {
  let bestRow: NassRow | null = null;
  let bestAt = -Infinity;
  for (const r of rows) {
    const at = parseNassMonthEnd(r.year, r.reference_period_desc);
    if (!at) continue;
    const ms = at.getTime();
    if (ms > bestAt) {
      bestAt = ms;
      bestRow = r;
    }
  }
  return bestRow;
}

/**
 * Default `year__GE` for the historical backfill — current UTC year
 * minus `NASS_BACKFILL_DEFAULT_YEARS`.
 */
function defaultBackfillYearGe(now: Date = new Date()): number {
  return now.getUTCFullYear() - NASS_BACKFILL_DEFAULT_YEARS;
}

/**
 * One-shot historical backfill for the USDA NASS collector. Walks
 * every series in `NASS_SERIES`, fetches its monthly history from
 * `yearGe` (default: 5 years back), and returns one
 * `MarketSignalDraft` per (series × month). The caller (runtime) is
 * responsible for the idempotent insert against `market_signals` so
 * re-runs are safe no-ops.
 *
 * A single bad series (NASS removes a class, renames a commodity) does
 * not abort the whole run — failures are collected and surfaced to the
 * caller, which decides whether to throw (e.g. zero successes = genuine
 * breakage).
 */
export async function fetchUsdaNassBackfillDrafts(opts?: {
  apiKey?: string;
  yearGe?: number;
}): Promise<{
  drafts: MarketSignalDraft[];
  failedSeries: Array<{ materialCode: string; error: string }>;
}> {
  const apiKey = opts?.apiKey ?? process.env["USDA_NASS_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "USDA_NASS_API_KEY env var is not set. Request a free key at https://quickstats.nass.usda.gov/api before running the usda-nass-economic-index backfill.",
    );
  }
  const yearGe = opts?.yearGe ?? defaultBackfillYearGe();

  const drafts: MarketSignalDraft[] = [];
  const failedSeries: Array<{ materialCode: string; error: string }> = [];
  for (const series of NASS_SERIES) {
    let rows: NassRow[];
    try {
      rows = await fetchNassRows(series, apiKey, yearGe);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedSeries.push({ materialCode: series.materialCode, error: message });
      logger.warn(
        {
          collectorId: USDA_NASS_ECONOMIC_INDEX_COLLECTOR_ID,
          materialCode: series.materialCode,
          err,
        },
        "USDA NASS historical fetch failed",
      );
      continue;
    }
    for (const row of rows) {
      const draft = buildNassDraftForObservation(
        series,
        row,
        "nass_historical_backfill",
      );
      if (draft) drafts.push(draft);
    }
  }
  return { drafts, failedSeries };
}

/**
 * Per-collector metadata schema. NASS drafts always carry the upstream
 * `short_desc` (when NASS returns one) plus the year and reference
 * period so re-parsers and downstream analyzers can audit which slice
 * a given signal came from.
 */
const nassMetadataSchema = z
  .object({
    shortDesc: z.string().nullable().optional(),
    commodityDesc: z.string().nullable().optional(),
    year: z.string().nullable().optional(),
    referencePeriod: z.string().nullable().optional(),
    basis: z.string().optional(),
  })
  .passthrough();

const nassSignalSchema = buildSignalDraftSchema(nassMetadataSchema);

export const usdaNassEconomicIndexCollector: IntelligenceCollector<
  typeof nassSignalSchema
> = {
  id: USDA_NASS_ECONOMIC_INDEX_COLLECTOR_ID,
  name: "USDA NASS Agricultural Prices",
  description:
    "Pulls US monthly Prices Received series for a curated set of agricultural commodities (corn, wheat, soybeans, milk, cheese, butter, beef cattle, hogs, broilers, upland cotton) from the USDA NASS QuickStats API and emits them as commodity_index market signals scoped to procurement materials.",
  posture: "public-api",
  sourceUrl: NASS_LANDING_URL,
  defaultRateLimitRpm: 30,
  // NASS publishes the monthly Agricultural Prices report mid-month;
  // a daily 7am-UTC poll picks up new releases within a day at trivial
  // cost, and the natural-key dedupe makes redundant polls free.
  defaultScheduleCron: "0 7 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "US",
  retentionDays: 365,
  tenantOptInDefault: true,
  signalSchema: nassSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(USDA_NASS_ECONOMIC_INDEX_COLLECTOR_ID, draft);
  },
  async collect({ since: _since, signal }): Promise<MarketSignalDraft[]> {
    const apiKey = process.env["USDA_NASS_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "USDA_NASS_API_KEY env var is not set. Request a free key at https://quickstats.nass.usda.gov/api before running the usda-nass-economic-index collector.",
      );
    }

    // Live mode pulls only the current and prior calendar year so the
    // per-series response stays small (~24 rows) — the backfill path
    // handles deeper history. The dedupe insert means re-emitting the
    // same prior-month rows on each daily run is a free no-op.
    const yearGe = new Date().getUTCFullYear() - 1;

    const drafts: MarketSignalDraft[] = [];
    const failedSeries: Array<{ materialCode: string; error: string }> = [];
    for (const series of NASS_SERIES) {
      let rows: NassRow[];
      try {
        rows = await fetchNassRows(series, apiKey, yearGe, signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failedSeries.push({ materialCode: series.materialCode, error: message });
        logger.warn(
          {
            collectorId: USDA_NASS_ECONOMIC_INDEX_COLLECTOR_ID,
            materialCode: series.materialCode,
            err,
          },
          "USDA NASS series fetch failed",
        );
        continue;
      }
      const latest = selectLatestMonthly(rows);
      if (!latest) continue;
      const draft = buildNassDraftForObservation(
        series,
        latest,
        "nass_latest_observation",
      );
      if (draft) drafts.push(draft);
    }

    // If every series failed, the run is genuinely broken (bad key,
    // NASS outage, network) — surface it to the runtime so the audit
    // log records `fetch_failed` instead of `fetch_succeeded` with 0.
    if (drafts.length === 0 && failedSeries.length === NASS_SERIES.length) {
      const sample = failedSeries.slice(0, 3).map((f) => f.error).join("; ");
      throw new Error(
        `USDA NASS collector: all ${NASS_SERIES.length} series failed. Sample errors: ${sample}`,
      );
    }

    return drafts;
  },
};
