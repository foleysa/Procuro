/**
 * BLS PPI + CPI + ECI economic-index collector.
 *
 * Pulls a curated set of Producer Price Index (PPI) sub-series for commonly
 * procured material categories, a curated set of Consumer Price Index (CPI)
 * sub-series for consumer-facing supplier categories (food at home, energy,
 * apparel, household furnishings, transportation services, medical care
 * services, etc.), plus the four headline Employment Cost Index (ECI) series,
 * from the BLS Public Data API v2. Each series produces one `economic_index`
 * `MarketSignalDraft` carrying the latest observation.
 *
 * CPI is intentionally limited to a handful of sub-indexes (NOT headline
 * CPI-U): suppliers in retail / hospitality / consumer-goods regularly cite
 * CPI when asking for price increases, and we want the appropriate sub-index
 * on hand to push back ("you're invoking CPI but the food-at-home sub-index
 * actually fell last quarter") rather than the headline number, which is too
 * coarse to be useful in category-level negotiations.
 *
 * BLS series naturally publish monthly (PPI, CPI) or quarterly (ECI); the
 * runtime polls daily so we land each release within ~24h of publication.
 *
 * `BLS_API_KEY` is optional. With a key, the v2 endpoint allows up to 50
 * series per request and 20 years per request. Without one, the same endpoint
 * remains usable but with smaller per-day quotas — we fall back to that tier
 * and emit an audit-log warning so operators know to add a key when usage
 * grows. We deliberately do NOT throw on missing key so the collector still
 * runs out-of-the-box on a fresh install.
 *
 * Overlap with `fred-economic-index` is intentional. Different `collectorId`s
 * let downstream consumers compare publication latency / revisions per source.
 */

import {
  db,
  collectorAuditLogTable,
} from "@workspace/db";
import { newId } from "../../ids";
import { logger } from "../../logger";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../collector";

const BLS_API_URL =
  "https://api.bls.gov/publicAPI/v2/timeseries/data/";

const SERIES_PAGE_BASE = "https://data.bls.gov/timeseries/";

interface SeriesRef {
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
 * Curated BLS series. PPI commodity series (WPU prefix) cover materials
 * commonly procured at scale; CPI sub-series (CUUR prefix, NSA, US city
 * average, base 1982-84=100) cover consumer-facing categories suppliers
 * cite when pushing for price increases; ECI series (CIU prefix) anchor
 * services rate-card negotiations. Overlap with FRED PPI is intentional.
 *
 * Note: this list is sized to stay within the BLS unauthenticated tier's
 * 25-series-per-request cap (authenticated tier allows 50). Adding more
 * series past 25 will require splitting into multiple POSTs or requiring
 * an API key.
 */
const SERIES: SeriesRef[] = [
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

  // --- ECI headline series (quarterly index, base Dec 2005 = 100) ---
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
];

interface BlsObservation {
  year: string;
  period: string;
  periodName: string;
  value: string;
  footnotes?: Array<{ code?: string; text?: string }>;
}

interface BlsSeriesResult {
  seriesID: string;
  data?: BlsObservation[];
}

interface BlsResponse {
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
function periodEndUtc(year: string, period: string): Date | null {
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

/** Pick the most recent observation by (year, period). */
function pickLatest(
  data: BlsObservation[],
): { obs: BlsObservation; observedAt: Date } | null {
  let best: { obs: BlsObservation; observedAt: Date } | null = null;
  for (const obs of data) {
    const observedAt = periodEndUtc(obs.year, obs.period);
    if (!observedAt) continue;
    if (!best || observedAt.getTime() > best.observedAt.getTime()) {
      best = { obs, observedAt };
    }
  }
  return best;
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

export const blsEconomicIndexCollector: IntelligenceCollector = {
  id: "bls-economic-index",
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

  async collect({ since: _since }): Promise<MarketSignalDraft[]> {
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
    // 2 calendar years of history is enough to find the latest observation
    // for both monthly PPI and quarterly ECI releases (which can lag by months).
    const startYear = endYear - 2;

    const seriesIds = SERIES.map((s) => s.seriesId);

    const body: Record<string, unknown> = {
      seriesid: seriesIds,
      startyear: String(startYear),
      endyear: String(endYear),
      catalog: false,
      calculations: false,
      annualaverage: false,
    };
    if (apiKey) body["registrationkey"] = apiKey;

    const res = await fetch(BLS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `BLS API HTTP ${res.status}: ${await res.text().catch(() => "<no body>")}`,
      );
    }

    const json = (await res.json()) as BlsResponse;
    if (json.status && json.status !== "REQUEST_SUCCEEDED") {
      const msg =
        (json.message && json.message.join("; ")) || "unknown BLS error";
      throw new Error(`BLS API status=${json.status}: ${msg}`);
    }

    const seriesById = new Map<string, BlsSeriesResult>();
    for (const s of json.Results?.series ?? []) {
      seriesById.set(s.seriesID, s);
    }

    const drafts: MarketSignalDraft[] = [];
    for (const ref of SERIES) {
      const result = seriesById.get(ref.seriesId);
      if (!result || !result.data || result.data.length === 0) {
        await recordWarning(
          this.id,
          `BLS returned no data for series ${ref.seriesId}`,
          { seriesId: ref.seriesId },
        );
        continue;
      }
      const latest = pickLatest(result.data);
      if (!latest) {
        await recordWarning(
          this.id,
          `BLS series ${ref.seriesId} returned data but no parseable period`,
          { seriesId: ref.seriesId },
        );
        continue;
      }
      const value = Number(latest.obs.value);
      if (!Number.isFinite(value)) {
        await recordWarning(
          this.id,
          `BLS series ${ref.seriesId} returned non-numeric value '${latest.obs.value}'`,
          { seriesId: ref.seriesId, raw: latest.obs.value },
        );
        continue;
      }

      const draft: MarketSignalDraft = {
        signalType: "economic_index",
        value: +value.toFixed(4),
        unit: ref.unit,
        currency: "USD",
        observedAt: latest.observedAt,
        sourceUrl: `${SERIES_PAGE_BASE}${ref.seriesId}`,
        confidence: 0.9,
        metadata: {
          seriesId: ref.seriesId,
          label: ref.label,
          baseYear: ref.baseYear,
          periodicity: ref.periodicity,
          period: latest.obs.period,
          periodName: latest.obs.periodName,
          year: latest.obs.year,
          tier: apiKey ? "authenticated" : "unauthenticated",
          source: "bls.gov",
        },
      };
      if (ref.scopeCategoryCode) draft.scopeCategoryCode = ref.scopeCategoryCode;
      if (ref.scopeMaterialCode) draft.scopeMaterialCode = ref.scopeMaterialCode;
      drafts.push(draft);
    }

    return drafts;
  },
};
