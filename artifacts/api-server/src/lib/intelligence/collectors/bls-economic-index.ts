/**
 * BLS PPI + CPI + ECI economic-index collector. Emits one
 * `economic_index` draft per (curated series × latest observation)
 * from the BLS Public Data API v2. `BLS_API_KEY` is optional —
 * unauthenticated tier is used with a smaller per-day quota and an
 * audit-log warning when no key is set.
 */

import {
  db,
  collectorAuditLogTable,
} from "@workspace/db";
import { z } from "zod";
import { newId } from "../../ids";
import { logger } from "../../logger";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";
import type {
  CollectorRunMode,
  IntelligenceCollector,
  MarketSignalDraft,
} from "../collector";
import {
  buildConditionalHeaders,
  extractCacheHeaders,
  readCacheWatermarks,
  setPendingCacheCommit,
  takePendingCacheCommit,
  writeCacheWatermarks,
  type CacheHeaders,
} from "./cache-watermarks";

export const BLS_API_URL =
  "https://api.bls.gov/publicAPI/v2/timeseries/data/";

const SERIES_PAGE_BASE = "https://data.bls.gov/timeseries/";

/**
 * BLS Public Data API v2 per-request series caps. Posts that exceed
 * these are rejected upstream, so the collector chunks its registry
 * before issuing requests. Numbers are pinned by BLS docs:
 * https://www.bls.gov/developers/api_signature_v2.htm
 */
export const BLS_API_SERIES_PER_REQUEST_AUTHENTICATED = 50;
export const BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED = 25;

/**
 * Per-mode lookback windows (calendar years) requested from the BLS
 * Public Data API.
 *
 * - `latest` (default for the daily cron): a 1-year window is enough to
 *   capture the most recent observation for both monthly PPI/CPI and
 *   quarterly ECI series, which can lag the publication date by a few
 *   months. The collector then trims to *one* observation per series so
 *   recurring runs don't re-write the entire window every day.
 * - `backfill` (one-off, manual): a 3-year window so the trend-chart UI
 *   has up to ~36 monthly observations of PPI/CPI history and up to
 *   ~12 quarterly observations of ECI history per series — the range
 *   the dashboards need to plot a meaningful trend rather than a single
 *   point. The 3-year value is intentionally an upper bound; the per-
 *   periodicity caps below trim each series to the requested range
 *   regardless of how many extra observations BLS includes for partial
 *   calendar years at the window edges.
 */
export const BLS_LATEST_LOOKBACK_YEARS = 1;
export const BLS_BACKFILL_LOOKBACK_YEARS = 3;
/** Backfill cap: ~36 months of monthly PPI/CPI observations per series. */
export const BLS_BACKFILL_MAX_MONTHLY_OBS = 36;
/** Backfill cap: ~12 quarters of quarterly ECI observations per series. */
export const BLS_BACKFILL_MAX_QUARTERLY_OBS = 12;

export interface BlsSeriesRef {
  seriesId: string;
  label: string;
  /** Set exactly one of scopeCategoryCode / scopeMaterialCode where it maps cleanly. */
  scopeCategoryCode?: string;
  scopeMaterialCode?: string;
  /** Index unit label (BLS PPI/ECI are dimensionless indexes vs a base year). */
  unit: string;
  baseYear: string;
  /** Native publication cadence — informational only. */
  periodicity: "monthly" | "quarterly";
}

/**
 * Curated BLS series:
 * - WPU* = PPI commodity (materials).
 * - PCU* = PPI service-industry (services towers).
 * - CUUR* = CPI sub-series (NSA, US city average, base 1982-84=100).
 * - CIU* = ECI total compensation; some entries fan a single upstream
 *   `seriesId` out across multiple canonical services scopes via
 *   distinct registry entries (request body dedupes by id, draft
 *   builder walks every entry, natural-key dedupe keeps the
 *   multi-emit drafts from colliding).
 *
 * BLS Public Data API v2 caps each request at 25 series unauth /
 * 50 series auth; `collect` chunks POSTs accordingly.
 */
export const BLS_SERIES: readonly BlsSeriesRef[] = [
  // --- PPI commodity sub-series (monthly, WPU = PPI commodity not seasonally adjusted) ---
  {
    seriesId: "WPU101",
    label: "PPI: Iron and steel",
    scopeMaterialCode: "STEEL",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU102",
    label: "PPI: Nonferrous metals",
    scopeMaterialCode: "NONFERROUS_METALS",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU0561",
    label: "PPI: Crude petroleum (domestic production)",
    scopeMaterialCode: "CRUDE_OIL",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU0571",
    label: "PPI: Gasoline",
    scopeMaterialCode: "GASOLINE",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU057303",
    label: "PPI: No. 2 diesel fuel",
    scopeMaterialCode: "DIESEL",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU0531",
    label: "PPI: Natural gas to industrial users",
    scopeMaterialCode: "NATURAL_GAS",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU0811",
    label: "PPI: Softwood lumber",
    scopeMaterialCode: "LUMBER",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU0911",
    label: "PPI: Pulp, paper, and allied products",
    scopeMaterialCode: "PAPER",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU0721",
    label: "PPI: Plastic resins and materials",
    scopeMaterialCode: "PLASTIC_RESIN",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU061",
    label: "PPI: Industrial chemicals",
    scopeCategoryCode: "CHEMICALS",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU085",
    label: "PPI: Paper and paperboard containers",
    scopeCategoryCode: "PACKAGING",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU114",
    label: "PPI: Plastic products",
    scopeCategoryCode: "PLASTICS",
    unit: "index_1982=100",
    baseYear: "1982",
    periodicity: "monthly",
  },
  {
    seriesId: "WPU3022",
    label: "PPI: Truck transportation of freight",
    scopeCategoryCode: "FREIGHT",
    unit: "index_2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },

  // --- CPI consumer sub-series (monthly, CUUR = CPI-U, NSA, U.S. city avg, base 1982-84=100) ---
  // These exist to defend against supplier "we need to raise prices, look at CPI"
  // asks on consumer-facing categories. We deliberately exclude headline CPI-U
  // (SA0) — too coarse to negotiate on — and stick to sub-indexes that map to
  // procurement categories where suppliers actually cite CPI.
  {
    seriesId: "CUUR0000SAF11",
    label: "CPI: Food at home",
    scopeCategoryCode: "FOOD_AT_HOME",
    unit: "index_1982-84=100",
    baseYear: "1982-1984",
    periodicity: "monthly",
  },
  {
    seriesId: "CUUR0000SEFV",
    label: "CPI: Food away from home",
    scopeCategoryCode: "FOOD_AWAY_FROM_HOME",
    unit: "index_1982-84=100",
    baseYear: "1982-1984",
    periodicity: "monthly",
  },
  {
    seriesId: "CUUR0000SA0E",
    label: "CPI: Energy (all types)",
    scopeCategoryCode: "ENERGY",
    unit: "index_1982-84=100",
    baseYear: "1982-1984",
    periodicity: "monthly",
  },
  {
    seriesId: "CUUR0000SEHF01",
    label: "CPI: Electricity",
    scopeCategoryCode: "ELECTRICITY_RETAIL",
    unit: "index_1982-84=100",
    baseYear: "1982-1984",
    periodicity: "monthly",
  },
  {
    seriesId: "CUUR0000SAA",
    label: "CPI: Apparel",
    scopeCategoryCode: "APPAREL",
    unit: "index_1982-84=100",
    baseYear: "1982-1984",
    periodicity: "monthly",
  },
  {
    seriesId: "CUUR0000SAH3",
    label: "CPI: Household furnishings and operations",
    scopeCategoryCode: "HOUSEHOLD_FURNISHINGS",
    unit: "index_1982-84=100",
    baseYear: "1982-1984",
    periodicity: "monthly",
  },
  {
    seriesId: "CUUR0000SAS4",
    label: "CPI: Transportation services",
    scopeCategoryCode: "TRANSPORTATION_SERVICES",
    unit: "index_1982-84=100",
    baseYear: "1982-1984",
    periodicity: "monthly",
  },
  {
    seriesId: "CUUR0000SAM2",
    label: "CPI: Medical care services",
    scopeCategoryCode: "MEDICAL_SERVICES",
    unit: "index_1982-84=100",
    baseYear: "1982-1984",
    periodicity: "monthly",
  },

  // --- PPI service-industry sub-series (monthly, PCU = PPI industry NSA) ---
  // Series ID format: "PCU" + NAICS6 + NAICS6 (industry × primary product).
  // Some PCU codes fan out to multiple canonical scopes (e.g. PCU541330
  // → ENG_DESIGN + ENG_RND); same upstream series, distinct natural-key
  // rows.
  {
    seriesId: "PCU541110541110",
    label: "PPI: Offices of lawyers — legal services",
    scopeCategoryCode: "PROF_LEGAL",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU541211541211",
    label: "PPI: Offices of certified public accountants — audit & tax",
    scopeCategoryCode: "PROF_AUDIT_TAX",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  // NOTE: Task #215 specified `PCU541611541611` (NAICS 541611, the
  // narrower "administrative management consulting" sub-line). BLS
  // publishes that detail line only intermittently with frequent gaps,
  // so we use the parent industry index `PCU541610541610` (NAICS
  // 541610, "Management consulting services") which has continuous
  // monthly history and is the standard PPI series cited in
  // procurement benchmarks. Same scope coverage, more reliable data.
  {
    seriesId: "PCU541610541610",
    label: "PPI: Management consulting services → Strategy",
    scopeCategoryCode: "PROF_CONSULTING_STRATEGY",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU541610541610",
    label: "PPI: Management consulting services → Operations",
    scopeCategoryCode: "PROF_CONSULTING_OPS",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  // NOTE: Task #215 referenced the broad NAICS 5415-- (computer
  // systems design AND related services) industry group. The BLS PPI
  // group-level series (`PCU5415----`) is publication-suppressed in
  // many recent months. We pin to `PCU541512541512` (NAICS 541512,
  // "Computer systems design services" — the largest sub-line by
  // revenue) which carries continuous monthly observations and is
  // the canonical reference for IT services rate-card negotiations.
  {
    seriesId: "PCU541512541512",
    label: "PPI: Computer systems design services → Application development",
    scopeCategoryCode: "IT_APP_DEV",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU541512541512",
    label: "PPI: Computer systems design services → Infrastructure",
    scopeCategoryCode: "IT_INFRA",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU541512541512",
    label: "PPI: Computer systems design services → Managed services",
    scopeCategoryCode: "IT_MANAGED_SERVICES",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU518210518210",
    label: "PPI: Data processing & hosting services → IT SaaS",
    scopeCategoryCode: "IT_SAAS",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU518210518210",
    label: "PPI: Data processing & hosting services → IT Infrastructure",
    scopeCategoryCode: "IT_INFRA",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU541810541810",
    label: "PPI: Advertising agencies",
    scopeCategoryCode: "MKT_AGENCY_CREATIVE",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU541613541613",
    label: "PPI: Marketing consulting services",
    scopeCategoryCode: "MKT_RESEARCH",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU561311561311",
    label: "PPI: Employment placement agencies — recruiting",
    scopeCategoryCode: "HR_RECRUITING",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU561320561320",
    label: "PPI: Temporary help services — contingent labor",
    scopeCategoryCode: "HR_CONTINGENT_LABOR",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU561110561110",
    label: "PPI: Office administrative services — payroll & benefits ops",
    scopeCategoryCode: "HR_PAYROLL_BENEFITS",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU561720561720",
    label: "PPI: Janitorial services",
    scopeCategoryCode: "FAC_JANITORIAL",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU561612561612",
    label: "PPI: Security guards & patrol services",
    scopeCategoryCode: "FAC_SECURITY",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU541330541330",
    label: "PPI: Engineering services → Design",
    scopeCategoryCode: "ENG_DESIGN",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },
  {
    seriesId: "PCU541330541330",
    label: "PPI: Engineering services → R&D engineering",
    scopeCategoryCode: "ENG_RND",
    unit: "index_dec2009=100",
    baseYear: "2009",
    periodicity: "monthly",
  },

  // --- ECI headline series (quarterly index, base Dec 2005 = 100) ---
  // Civilian-workers comp/wages/benefits land on LABOR_* aggregates;
  // service-providing-industries series additionally fans out across
  // canonical PROF_*/IT_*/HR_*/MKT_*/FAC_*/ENG_* scopes (see below).
  {
    seriesId: "CIU1010000000000I",
    label: "ECI: Total compensation, civilian workers (NSA index)",
    scopeCategoryCode: "LABOR_TOTAL_COMP",
    unit: "index_dec2005=100",
    baseYear: "2005",
    periodicity: "quarterly",
  },
  {
    seriesId: "CIU2010000000000I",
    label: "ECI: Wages and salaries, civilian workers (NSA index)",
    scopeCategoryCode: "LABOR_WAGES",
    unit: "index_dec2005=100",
    baseYear: "2005",
    periodicity: "quarterly",
  },
  {
    seriesId: "CIU2030000000000I",
    label: "ECI: Benefits, civilian workers (NSA index)",
    scopeCategoryCode: "LABOR_BENEFITS",
    unit: "index_dec2005=100",
    baseYear: "2005",
    periodicity: "quarterly",
  },
  {
    seriesId: "CIU2020000000000I",
    label: "ECI: Total compensation, service-providing industries (NSA index)",
    scopeCategoryCode: "LABOR_SERVICES_COMP",
    unit: "index_dec2005=100",
    baseYear: "2005",
    periodicity: "quarterly",
  },
  // ECI service-providing fan-out: same upstream series (CIU2020000000000I
  // = total compensation, service-providing industries), distinct scope
  // per entry. Request body is deduped by seriesId → one HTTP call.
  ...(
    [
      "PROF_LEGAL",
      "PROF_AUDIT_TAX",
      "PROF_CONSULTING_STRATEGY",
      "PROF_CONSULTING_OPS",
      "IT_APP_DEV",
      "IT_INFRA",
      "IT_CYBER",
      "IT_SAAS",
      "IT_MANAGED_SERVICES",
      "IT_HELP_DESK",
      "HR_CONTINGENT_LABOR",
      "HR_RECRUITING",
      "HR_TRAINING",
      "HR_PAYROLL_BENEFITS",
      "MKT_AGENCY_CREATIVE",
      "MKT_MEDIA_BUYING",
      "MKT_PR",
      "MKT_RESEARCH",
      "FAC_JANITORIAL",
      "FAC_SECURITY",
      "FAC_MAINTENANCE",
      "FAC_LANDSCAPING",
      "FAC_CATERING",
      "ENG_RND",
      "ENG_DESIGN",
      "ENG_TESTING_CERT",
    ] as const
  ).map((scope) => ({
    seriesId: "CIU2020000000000I",
    label: `ECI: Service-providing industries → ${scope}`,
    scopeCategoryCode: scope,
    unit: "index_dec2005=100",
    baseYear: "2005",
    periodicity: "quarterly" as const,
  })),
];

export interface BlsObservation {
  year: string;
  period: string;
  periodName: string;
  value: string;
  footnotes?: Array<{ code?: string; text?: string }>;
}

export interface BlsSeriesResult {
  seriesID: string;
  data?: BlsObservation[];
}

export interface BlsResponse {
  status?: string;
  message?: string[];
  Results?: { series?: BlsSeriesResult[] };
}

/**
 * Convert a BLS (year, period) into the period-end Date in UTC.
 *  - "M01".."M12" → last day of that month
 *  - "Q01".."Q04" → Mar 31, Jun 30, Sep 30, Dec 31
 *  - "A01" / "M13" → Dec 31 of that year (annual average)
 *  - "S01" / "S02" → Jun 30 / Dec 31
 * Returns null if the period code is unrecognized.
 */
export function periodEndUtc(year: string, period: string): Date | null {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1900 || y > 2100) return null;

  if (period === "A01" || period === "M13") {
    return new Date(Date.UTC(y, 11, 31));
  }
  if (period === "S01") return new Date(Date.UTC(y, 5, 30));
  if (period === "S02") return new Date(Date.UTC(y, 11, 31));

  if (period.startsWith("M")) {
    const m = Number(period.slice(1));
    if (!Number.isInteger(m) || m < 1 || m > 12) return null;
    // Day 0 of next month = last day of month m.
    return new Date(Date.UTC(y, m, 0));
  }
  if (period.startsWith("Q")) {
    const q = Number(period.slice(1));
    if (!Number.isInteger(q) || q < 1 || q > 4) return null;
    const lastMonth = q * 3; // Q1→3, Q2→6, Q3→9, Q4→12
    return new Date(Date.UTC(y, lastMonth, 0));
  }
  return null;
}

/**
 * Build one `economic_index` MarketSignalDraft for a single BLS observation.
 *
 * Shared between the live collector (which emits every observation in the
 * 2-year window so the trend-chart UI has history to plot) and the test
 * fixtures so re-runs of the collector against the same upstream snapshot
 * are idempotent on `(collector_id, signalType, scope_*, observed_at)`.
 *
 * Returns `null` for observations with an unrecognized period code or a
 * non-numeric value rather than emitting NaN signals.
 */
export function buildBlsDraftForObservation(
  ref: BlsSeriesRef,
  obs: BlsObservation,
  opts: { tier: "authenticated" | "unauthenticated" },
): MarketSignalDraft | null {
  const observedAt = periodEndUtc(obs.year, obs.period);
  if (!observedAt) return null;
  const value = Number(obs.value);
  if (!Number.isFinite(value)) return null;

  const draft: MarketSignalDraft = {
    signalType: "economic_index",
    value: +value.toFixed(4),
    unit: ref.unit,
    currency: "USD",
    observedAt,
    sourceUrl: `${SERIES_PAGE_BASE}${ref.seriesId}`,
    confidence: 0.9,
    // Anchor the natural-key dedupe to the upstream BLS series so two
    // different series that resolve to the same scope+date (e.g.
    // PPI monthly M03 + ECI quarterly Q01 both ending 2025-03-31, or
    // two PCU series mapping to IT_INFRA) coexist as distinct rows
    // instead of silently colliding on insert.
    scopeSku: blsScopeSku(ref),
    metadata: {
      seriesId: ref.seriesId,
      label: ref.label,
      baseYear: ref.baseYear,
      periodicity: ref.periodicity,
      period: obs.period,
      periodName: obs.periodName,
      year: obs.year,
      tier: opts.tier,
      source: "bls.gov",
    },
  };
  if (ref.scopeCategoryCode) draft.scopeCategoryCode = ref.scopeCategoryCode;
  if (ref.scopeMaterialCode) draft.scopeMaterialCode = ref.scopeMaterialCode;
  return draft;
}

/**
 * `scope_sku` for `bls-economic-index` drafts. Encoding the upstream
 * BLS series ID keeps the natural-key dedupe distinct per series even
 * when multiple series share `scope_category_code` + `observed_at`.
 */
export function blsScopeSku(ref: BlsSeriesRef): string {
  return `bls_series:${ref.seriesId}`;
}

/**
 * Cache-watermark key for one BLS POST chunk.
 *
 * The BLS POST body varies by chunk membership AND by the lookback
 * window (which advances every January). All three components are
 * folded into the key so a year-boundary roll-over (or a registry
 * change that re-shuffles which series land in which chunk) invalidates
 * the watermark automatically and the next run does a clean fetch
 * instead of short-circuiting on a stale 304 against a brand-new
 * request body.
 *
 * Sorted seriesIds keep the key stable when the registry rearranges
 * within a chunk without changing membership.
 */
export function blsChunkCacheKey(
  chunkSeriesIds: readonly string[],
  startYear: number,
  endYear: number,
  tier: "authenticated" | "unauthenticated",
): string {
  const sorted = [...chunkSeriesIds].sort().join(",");
  return `bls:${tier}:${startYear}-${endYear}:${sorted}`;
}

async function recordWarning(
  collectorId: string,
  message: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.insert(collectorAuditLogTable).values({
      id: newId("aud"),
      collectorId,
      event: "warning",
      metadata: { message, ...metadata },
    });
  } catch (err) {
    logger.warn(
      { err, collectorId, message },
      "Failed to record collector audit warning",
    );
  }
}

const blsMetadataSchema = z
  .object({
    seriesId: z.string().min(1),
    label: z.string().optional(),
    baseYear: z.union([z.string(), z.number()]).optional(),
    periodicity: z.string().optional(),
    period: z.string().optional(),
    periodName: z.string().optional(),
    year: z.union([z.string(), z.number()]).optional(),
    tier: z.enum(["authenticated", "unauthenticated"]).optional(),
    source: z.string().optional(),
  })
  .passthrough();

const blsSignalSchema = buildSignalDraftSchema(blsMetadataSchema);

export const BLS_ECONOMIC_INDEX_COLLECTOR_ID = "bls-economic-index";

export const blsEconomicIndexCollector: IntelligenceCollector<
  typeof blsSignalSchema
> = {
  id: BLS_ECONOMIC_INDEX_COLLECTOR_ID,
  name: "BLS PPI, CPI & ECI Index",
  description:
    "Bureau of Labor Statistics PPI commodity sub-series, CPI consumer sub-series, and ECI headline series. PPI gives material-category cost trends; CPI sub-indexes (food at home, energy, apparel, household furnishings, transportation services, medical care services, etc.) defend against supplier price-increase asks on consumer-facing categories; ECI is the standard reference for services rate-card negotiations.",
  posture: "public-api",
  sourceUrl: "https://www.bls.gov/developers/",
  // BLS quotas are per-day, not per-minute; cap RPM modestly so a stuck loop
  // can't burn through the daily budget (500/day with key, 25/day without).
  defaultRateLimitRpm: 10,
  // Daily polling lands monthly PPI / quarterly ECI releases within ~24h.
  defaultScheduleCron: "0 13 * * *",
  postureClass: "public_api",
  // BLS publishes the series openly and explicitly cites them; full
  // attribution is appropriate.
  disclosureTier: "T1",
  jurisdiction: "US",
  retentionDays: 365,
  tenantOptInDefault: true,
  signalSchema: blsSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(BLS_ECONOMIC_INDEX_COLLECTOR_ID, draft);
  },

  async collect({ since: _since, signal, mode }): Promise<MarketSignalDraft[]> {
    const effectiveMode: CollectorRunMode = mode ?? "latest";
    const apiKey = process.env["BLS_API_KEY"];
    if (!apiKey) {
      await recordWarning(
        this.id,
        "BLS_API_KEY is not set; using unauthenticated tier with a smaller daily quota. Add a free key from https://data.bls.gov/registrationEngine/ to raise the quota.",
        { tier: "unauthenticated" },
      );
    }

    const now = new Date();
    const endYear = now.getUTCFullYear();
    // Latest mode: 1-year window is enough to capture the most recent
    // observation for monthly PPI/CPI and quarterly ECI series even when
    // BLS releases lag by a few months. Backfill mode: 3-year window so
    // the trend-chart UI has 24-36 monthly / 8-12 quarterly observations
    // of history per series, trimmed to the per-periodicity caps below.
    const lookbackYears =
      effectiveMode === "backfill"
        ? BLS_BACKFILL_LOOKBACK_YEARS
        : BLS_LATEST_LOOKBACK_YEARS;
    const startYear = endYear - lookbackYears;

    // De-duplicate seriesIds before request building. The registry can
    // legitimately contain multiple entries that share an upstream
    // seriesId (ECI fan-out → multiple canonical service categories);
    // we still only want to fetch each series once.
    const uniqueSeriesIds = Array.from(
      new Set(BLS_SERIES.map((s) => s.seriesId)),
    );
    const tier = apiKey ? "authenticated" : "unauthenticated";
    const chunkSize = apiKey
      ? BLS_API_SERIES_PER_REQUEST_AUTHENTICATED
      : BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED;

    // Read the prior-run watermark map up-front. The map keys each chunk
    // request to the `{ etag, lastModified }` BLS returned the last
    // time we POSTed that exact body. Empty map = first-run / DB read
    // failure → falls through to a full fetch for every chunk.
    const watermarks = await readCacheWatermarks(this.id);
    const newWatermarks = new Map<string, CacheHeaders>(watermarks);
    // Series IDs whose chunk short-circuited on a 304. We exclude those
    // from the draft fan-out so `onMissing` doesn't fire spuriously for
    // series whose data is unchanged (and already in the DB).
    const unchangedSeriesIds = new Set<string>();
    let unchangedChunks = 0;

    // Chunk + stitch so we stay within the per-request series cap.
    // Each chunk's `Results.series` array is concatenated into a single
    // synthetic response that `buildBlsDraftsFromResponse` walks once,
    // preserving its existing fan-out + onMissing semantics.
    const stitched: BlsResponse = {
      status: "REQUEST_SUCCEEDED",
      Results: { series: [] },
    };
    for (let i = 0; i < uniqueSeriesIds.length; i += chunkSize) {
      const chunk = uniqueSeriesIds.slice(i, i + chunkSize);
      const cacheKey = blsChunkCacheKey(chunk, startYear, endYear, tier);
      const watermark = watermarks.get(cacheKey);
      const conditionalHeaders = buildConditionalHeaders(watermark);

      const body: Record<string, unknown> = {
        seriesid: chunk,
        startyear: String(startYear),
        endyear: String(endYear),
        catalog: false,
        calculations: false,
        annualaverage: false,
      };
      if (apiKey) body["registrationkey"] = apiKey;

      const res = await fetch(BLS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...conditionalHeaders },
        body: JSON.stringify(body),
        signal,
      });

      // 304 Not Modified: BLS confirmed the chunk's response is byte-
      // identical to what we already parsed last time. Skip the parse,
      // skip the draft fan-out for these series, and preserve the
      // existing watermark so the next run still short-circuits.
      if (res.status === 304) {
        unchangedChunks += 1;
        for (const id of chunk) unchangedSeriesIds.add(id);
        continue;
      }

      if (!res.ok) {
        throw new Error(
          `BLS API HTTP ${res.status} on chunk ${i / chunkSize + 1}: ${await res.text().catch(() => "<no body>")}`,
        );
      }

      // Capture fresh cache headers (when present) for the next run.
      // If upstream stopped sending them, drop any stale entry so we
      // don't accidentally keep replaying a value the server is no
      // longer honouring.
      const fresh = extractCacheHeaders(res);
      if (fresh.etag !== null || fresh.lastModified !== null) {
        newWatermarks.set(cacheKey, fresh);
      } else {
        newWatermarks.delete(cacheKey);
      }

      const json = (await res.json()) as BlsResponse;
      if (json.status && json.status !== "REQUEST_SUCCEEDED") {
        const msg =
          (json.message && json.message.join("; ")) || "unknown BLS error";
        throw new Error(
          `BLS API status=${json.status} on chunk ${i / chunkSize + 1}: ${msg}`,
        );
      }
      for (const s of json.Results?.series ?? []) {
        stitched.Results!.series!.push(s);
      }
    }

    // Drop short-circuited series from the fan-out so `onMissing`
    // doesn't write a misleading "no data for series X" warning for
    // series whose data is unchanged-and-cached, not actually missing.
    const seriesForFanOut =
      unchangedSeriesIds.size === 0
        ? BLS_SERIES
        : BLS_SERIES.filter((s) => !unchangedSeriesIds.has(s.seriesId));

    // Build drafts FIRST, then queue the watermark write. If draft
    // building throws (e.g. a malformed observation in the canned
    // response), we must NOT queue the watermark — otherwise a future
    // run would 304-skip the chunk we never managed to ingest.
    const drafts = await buildBlsDraftsFromResponse(stitched, seriesForFanOut, {
      tier,
      observationCapForRef: (ref) => observationCapForMode(effectiveMode, ref),
      onMissing: async (seriesId, reason) => {
        await recordWarning(this.id, reason, { seriesId });
      },
    });

    // Queue the watermark write to fire AFTER the runtime's
    // insertSignalsWithDedupe succeeds. Writing it here directly would
    // open a window where collect() returns OK but the downstream
    // insert fails — leaving the next run with an advanced watermark
    // and a 304 short-circuit on data we never committed.
    // The runtime invokes the queued commit via
    // `takePendingPostInsertCommit()` (see below) only on the success
    // path; a failed run discards it.
    setPendingCacheCommit(this.id, () =>
      writeCacheWatermarks(this.id, newWatermarks, {
        unchangedChunks,
        unchangedSeriesCount: unchangedSeriesIds.size,
        totalChunks: Math.ceil(uniqueSeriesIds.length / chunkSize),
        tier,
      }),
    );

    return drafts;
  },

  /**
   * Hand the runtime the pending watermark write so it fires only after
   * `insertSignalsWithDedupe` commits the run's drafts. See
   * `cache-watermarks.ts` for the rationale (mirrors the ECB historical
   * archive pattern from Task #127). Returns `null` when collect() did
   * not queue one — e.g. a run that errored out before the queue point.
   */
  takePendingPostInsertCommit(): (() => Promise<void>) | null {
    return takePendingCacheCommit(this.id);
  },
};

/**
 * Per-(mode × series) observation cap.
 *
 * - `latest` mode collapses every series down to its single most recent
 *   observation, so the daily cron stops re-writing months of identical
 *   history on every poll.
 * - `backfill` mode trims monthly series to the last
 *   `BLS_BACKFILL_MAX_MONTHLY_OBS` observations and quarterly series to
 *   the last `BLS_BACKFILL_MAX_QUARTERLY_OBS` observations. The 3-year
 *   API window may include extra observations at the tails (partial
 *   calendar years) — the caps keep the per-series row counts inside
 *   the range the trend-chart UI documents.
 */
export function observationCapForMode(
  mode: CollectorRunMode,
  ref: BlsSeriesRef,
): number {
  if (mode === "latest") return 1;
  return ref.periodicity === "monthly"
    ? BLS_BACKFILL_MAX_MONTHLY_OBS
    : BLS_BACKFILL_MAX_QUARTERLY_OBS;
}

/**
 * Fan a BLS API response out into MarketSignalDrafts per series in the
 * curated `series` registry.
 *
 * `observationCapForRef` controls how many observations per series the
 * fan-out emits. The BLS API returns each series' `data` newest-first,
 * so the cap takes the most recent N observations:
 *   - omit (or return undefined) → emit every parseable observation
 *     (preserves the legacy "full window" behaviour the guardrail test
 *     relies on)
 *   - return 1 → latest-only emission (the daily cron's default)
 *   - return >1 → backfill emission, trimmed per-periodicity by the
 *     caller (see `observationCapForMode`)
 *
 * Re-runs are safe regardless of the cap because the runtime dedupe
 * collides on `(collectorId, signalType, scope_*, observedAt)`.
 *
 * `onMissing` lets the caller record an audit warning per series that the
 * upstream payload didn't include — used by the live collector to flag
 * silent BLS removals, and pinned by the series-list guardrail test to
 * fail loudly if any curated id stops resolving.
 */
export async function buildBlsDraftsFromResponse(
  response: BlsResponse,
  series: readonly BlsSeriesRef[],
  opts: {
    tier: "authenticated" | "unauthenticated";
    observationCapForRef?: (ref: BlsSeriesRef) => number | undefined;
    onMissing?: (seriesId: string, reason: string) => Promise<void> | void;
  },
): Promise<MarketSignalDraft[]> {
  const seriesById = new Map<string, BlsSeriesResult>();
  for (const s of response.Results?.series ?? []) {
    seriesById.set(s.seriesID, s);
  }

  const drafts: MarketSignalDraft[] = [];
  for (const ref of series) {
    const result = seriesById.get(ref.seriesId);
    if (!result || !result.data || result.data.length === 0) {
      if (opts.onMissing) {
        await opts.onMissing(
          ref.seriesId,
          `BLS returned no data for series ${ref.seriesId}`,
        );
      }
      continue;
    }
    const cap = opts.observationCapForRef
      ? opts.observationCapForRef(ref)
      : undefined;
    let parsedAny = false;
    let emittedForRef = 0;
    for (const obs of result.data) {
      if (cap !== undefined && emittedForRef >= cap) break;
      const draft = buildBlsDraftForObservation(ref, obs, { tier: opts.tier });
      if (draft) {
        drafts.push(draft);
        parsedAny = true;
        emittedForRef += 1;
      }
    }
    if (!parsedAny && opts.onMissing) {
      await opts.onMissing(
        ref.seriesId,
        `BLS series ${ref.seriesId} returned data but no rows were parseable`,
      );
    }
  }
  return drafts;
}
