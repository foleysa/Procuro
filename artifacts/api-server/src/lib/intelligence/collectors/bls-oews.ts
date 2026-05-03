/**
 * BLS OEWS collector. Emits `wage_benchmark` signals: annual,
 * region-aware (national/state/MSA) mean & percentile wages by SOC
 * code, complementing the PPI/CPI/ECI signals from `bls-economic-index`
 * with absolute rate-card anchors for services-band negotiations.
 *
 * Series ID format (25 chars):
 *   OE + U + areatype(1) + area(7) + industry(6) + occupation(6) + datatype(2)
 * Built from the (region × occupation × datatype) registry via
 * {@link buildOewsSeriesId} — registry is declarative, no hand-typed IDs.
 */

import { db, collectorAuditLogTable } from "@workspace/db";
import { z } from "zod";
import { newId } from "../../ids";
import { logger } from "../../logger";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../collector";
import {
  BLS_API_URL,
  BLS_API_SERIES_PER_REQUEST_AUTHENTICATED,
  BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED,
  periodEndUtc,
  type BlsObservation,
  type BlsResponse,
  type BlsSeriesResult,
} from "./bls-economic-index";

const OEWS_SERIES_PAGE_BASE = "https://data.bls.gov/oes/";

/** Cross-industry rollup — the only industry slice we use today. */
const OEWS_INDUSTRY_CROSS_INDUSTRY = "000000";

/** BLS OEWS area type: N = national, S = state, M = MSA. */
export type OewsAreaType = "N" | "S" | "M";

/** BLS OEWS datatype codes we emit. */
export type OewsDatatype = "03" | "04" | "07" | "08" | "09" | "10" | "13";

export interface OewsRegion {
  regionCode: string;
  areaType: OewsAreaType;
  /** 7-digit BLS OEWS area code (zero-padded). */
  areaCode: string;
  label: string;
}

export interface OewsOccupation {
  /** SOC code with hyphen (e.g. "23-1011"). */
  socCode: string;
  /** SOC code with hyphen stripped (6 digits) for the series ID. */
  occCode: string;
  /** Canonical Task #214 services-band category. */
  scopeCategoryCode: string;
  label: string;
}

export interface OewsDatatypeSpec {
  code: OewsDatatype;
  label: string;
  /** "USD/hour" or "USD/year". */
  unit: string;
  aggregate: "mean" | "median" | "p10" | "p25" | "p75" | "p90";
  horizon: "hourly" | "annual";
}

/**
 * One curated OEWS series. The (region × SOC × datatype) tuple is
 * unique. `regionCode` lands on `scope_region_code`, `scopeCategoryCode`
 * on `scope_category_code` for analyzer routing.
 */
export interface OewsSeriesRef {
  /** 25-char OE-prefixed series ID. */
  seriesId: string;
  label: string;
  socCode: string;
  regionCode: string;
  scopeCategoryCode: string;
  unit: string;
  datatype: OewsDatatype;
  aggregate: OewsDatatypeSpec["aggregate"];
  horizon: OewsDatatypeSpec["horizon"];
}

/** Compose the 25-char OEWS series ID from its parts. */
export function buildOewsSeriesId(opts: {
  areaType: OewsAreaType;
  areaCode: string;
  industryCode: string;
  occupationCode: string;
  datatype: OewsDatatype;
}): string {
  if (opts.areaCode.length !== 7) {
    throw new Error(`OEWS areaCode must be 7 digits: ${opts.areaCode}`);
  }
  if (opts.industryCode.length !== 6) {
    throw new Error(`OEWS industryCode must be 6 digits: ${opts.industryCode}`);
  }
  if (opts.occupationCode.length !== 6) {
    throw new Error(
      `OEWS occupationCode must be 6 digits: ${opts.occupationCode}`,
    );
  }
  return `OEU${opts.areaType}${opts.areaCode}${opts.industryCode}${opts.occupationCode}${opts.datatype}`;
}

/** Curated OEWS regions: US national + CA state + NYC MSA. */
export const OEWS_REGIONS: readonly OewsRegion[] = [
  {
    regionCode: "US-NATIONAL",
    areaType: "N",
    areaCode: "0000000",
    label: "United States (national)",
  },
  {
    regionCode: "US-CA",
    areaType: "S",
    areaCode: "0600000",
    label: "California (state)",
  },
  {
    regionCode: "US-MSA-35620",
    areaType: "M",
    areaCode: "0035620",
    label: "New York-Newark-Jersey City MSA",
  },
];

/**
 * Curated OEWS occupations covering the services towers from the task:
 * legal, audit/tax, consulting, IT, marketing, HR, facilities,
 * engineering. Each pins one canonical scope; guardrail test asserts
 * `occCode === socCode.replace("-","")` so a typo can't silently route
 * the wrong occupation to a category.
 */
export const OEWS_OCCUPATIONS: readonly OewsOccupation[] = [
  {
    socCode: "23-1011",
    occCode: "231011",
    scopeCategoryCode: "PROF_LEGAL",
    label: "Lawyers",
  },
  {
    socCode: "13-2011",
    occCode: "132011",
    scopeCategoryCode: "PROF_AUDIT_TAX",
    label: "Accountants and Auditors",
  },
  {
    socCode: "13-1111",
    occCode: "131111",
    scopeCategoryCode: "PROF_CONSULTING_OPS",
    label: "Management Analysts (consulting)",
  },
  {
    socCode: "15-1252",
    occCode: "151252",
    scopeCategoryCode: "IT_APP_DEV",
    label: "Software Developers",
  },
  {
    socCode: "15-1244",
    occCode: "151244",
    scopeCategoryCode: "IT_INFRA",
    label: "Network and Computer Systems Administrators",
  },
  {
    // SOC 15-1299 = Computer Occupations, All Other (IT PMs, etc.).
    socCode: "15-1299",
    occCode: "151299",
    scopeCategoryCode: "IT_MANAGED_SERVICES",
    label: "Computer Occupations, All Other",
  },
  {
    socCode: "27-1024",
    occCode: "271024",
    scopeCategoryCode: "MKT_AGENCY_CREATIVE",
    label: "Graphic Designers",
  },
  {
    // 13-1071 = Human Resources Specialists. SOC code and occupation
    // code in the series ID must agree — the guardrail test pins this.
    socCode: "13-1071",
    occCode: "131071",
    scopeCategoryCode: "HR_RECRUITING",
    label: "Human Resources Specialists",
  },
  {
    socCode: "33-9032",
    occCode: "339032",
    scopeCategoryCode: "FAC_SECURITY",
    label: "Security Guards",
  },
  {
    socCode: "37-2011",
    occCode: "372011",
    scopeCategoryCode: "FAC_JANITORIAL",
    label: "Janitors and Cleaners",
  },
  {
    socCode: "17-2199",
    occCode: "172199",
    scopeCategoryCode: "ENG_RND",
    label: "Engineers, All Other",
  },
];

/**
 * OEWS datatypes the collector emits. The hourly suite (mean + 25th /
 * median / 75th / 90th percentile) is what negotiation playbooks use;
 * annual mean is the headline number procurement reporting cites.
 */
export const OEWS_DATATYPES: readonly OewsDatatypeSpec[] = [
  {
    code: "03",
    label: "Hourly mean wage",
    unit: "USD/hour",
    aggregate: "mean",
    horizon: "hourly",
  },
  {
    code: "07",
    label: "Hourly 25th percentile wage",
    unit: "USD/hour",
    aggregate: "p25",
    horizon: "hourly",
  },
  {
    code: "08",
    label: "Hourly median wage",
    unit: "USD/hour",
    aggregate: "median",
    horizon: "hourly",
  },
  {
    code: "09",
    label: "Hourly 75th percentile wage",
    unit: "USD/hour",
    aggregate: "p75",
    horizon: "hourly",
  },
  {
    code: "10",
    label: "Hourly 90th percentile wage",
    unit: "USD/hour",
    aggregate: "p90",
    horizon: "hourly",
  },
  {
    code: "04",
    label: "Annual mean wage",
    unit: "USD/year",
    aggregate: "mean",
    horizon: "annual",
  },
  {
    code: "13",
    label: "Annual median wage",
    unit: "USD/year",
    aggregate: "median",
    horizon: "annual",
  },
];

/**
 * Build the curated OEWS registry as the Cartesian product of regions ×
 * occupations × datatypes. Every region (national, state, MSA) emits
 * the full datatype suite — hourly mean, p25, median, p75, p90 plus
 * annual mean and median — so downstream rate-card analyzers have the
 * same percentile breadth at every geographic resolution. Adding a
 * region or an occupation is a single-line change in the upstream
 * tables; no series IDs are hand-typed.
 */
function expandOewsRegistry(): readonly OewsSeriesRef[] {
  const refs: OewsSeriesRef[] = [];
  for (const region of OEWS_REGIONS) {
    for (const occ of OEWS_OCCUPATIONS) {
      for (const dt of OEWS_DATATYPES) {
        const seriesId = buildOewsSeriesId({
          areaType: region.areaType,
          areaCode: region.areaCode,
          industryCode: OEWS_INDUSTRY_CROSS_INDUSTRY,
          occupationCode: occ.occCode,
          datatype: dt.code,
        });
        refs.push({
          seriesId,
          label: `OEWS: ${occ.label} — ${dt.label} (${region.label})`,
          socCode: occ.socCode,
          regionCode: region.regionCode,
          scopeCategoryCode: occ.scopeCategoryCode,
          unit: dt.unit,
          datatype: dt.code,
          aggregate: dt.aggregate,
          horizon: dt.horizon,
        });
      }
    }
  }
  return refs;
}

/** Curated OEWS series, expanded from REGIONS × OCCUPATIONS × DATATYPES. */
export const OEWS_SERIES: readonly OewsSeriesRef[] = expandOewsRegistry();

/**
 * `scope_sku` for OEWS drafts. Encodes horizon + aggregate + SOC so
 * distinct datatypes for the same (region × category × observed_at)
 * tuple dedupe independently, and so two SOCs mapping to the same
 * category never collide on the natural key.
 */
export function oewsScopeSku(ref: OewsSeriesRef): string {
  return `wage:${ref.horizon}:${ref.aggregate}:${ref.socCode}`;
}

/**
 * Build one `wage_benchmark` draft from a single OEWS observation.
 * OEWS is annual, so period is always "A01" and `periodEndUtc` lands
 * on Dec 31. Returns null for unparseable periods or non-numeric values.
 */
export function buildOewsDraftForObservation(
  ref: OewsSeriesRef,
  obs: BlsObservation,
  opts: { tier: "authenticated" | "unauthenticated" },
): MarketSignalDraft | null {
  const observedAt = periodEndUtc(obs.year, obs.period);
  if (!observedAt) return null;
  const value = Number(obs.value);
  if (!Number.isFinite(value)) return null;

  return {
    signalType: "wage_benchmark",
    value: +value.toFixed(2),
    unit: ref.unit,
    currency: "USD",
    observedAt,
    sourceUrl: `${OEWS_SERIES_PAGE_BASE}${ref.seriesId}`,
    confidence: 0.9,
    scopeCategoryCode: ref.scopeCategoryCode,
    scopeRegionCode: ref.regionCode,
    scopeSku: oewsScopeSku(ref),
    metadata: {
      seriesId: ref.seriesId,
      label: ref.label,
      socCode: ref.socCode,
      regionCode: ref.regionCode,
      datatype: ref.datatype,
      aggregate: ref.aggregate,
      horizon: ref.horizon,
      period: obs.period,
      periodName: obs.periodName,
      year: obs.year,
      tier: opts.tier,
      source: "bls.gov/oes",
    },
  };
}

/**
 * Fan an OEWS API response into one `wage_benchmark` draft per
 * (series × observation). `onMissing` records an audit warning for
 * each curated series the upstream omitted.
 */
export async function buildOewsDraftsFromResponse(
  response: BlsResponse,
  series: readonly OewsSeriesRef[],
  opts: {
    tier: "authenticated" | "unauthenticated";
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
          `OEWS returned no data for series ${ref.seriesId}`,
        );
      }
      continue;
    }
    let parsedAny = false;
    for (const obs of result.data) {
      const draft = buildOewsDraftForObservation(ref, obs, { tier: opts.tier });
      if (draft) {
        drafts.push(draft);
        parsedAny = true;
      }
    }
    if (!parsedAny && opts.onMissing) {
      await opts.onMissing(
        ref.seriesId,
        `OEWS series ${ref.seriesId} returned data but no rows were parseable`,
      );
    }
  }
  return drafts;
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
      "Failed to record OEWS collector audit warning",
    );
  }
}

const oewsMetadataSchema = z
  .object({
    seriesId: z.string().min(1),
    label: z.string().optional(),
    socCode: z.string().optional(),
    regionCode: z.string().optional(),
    datatype: z.string().optional(),
    aggregate: z.string().optional(),
    horizon: z.string().optional(),
    period: z.string().optional(),
    periodName: z.string().optional(),
    year: z.union([z.string(), z.number()]).optional(),
    tier: z.enum(["authenticated", "unauthenticated"]).optional(),
    source: z.string().optional(),
  })
  .passthrough();

const oewsSignalSchema = buildSignalDraftSchema(oewsMetadataSchema);

export const BLS_OEWS_COLLECTOR_ID = "bls-oews";

export const blsOewsCollector: IntelligenceCollector<typeof oewsSignalSchema> =
  {
    id: BLS_OEWS_COLLECTOR_ID,
    name: "BLS OEWS Wage Benchmarks",
    description:
      "BLS OEWS annual, region-aware wage benchmarks (mean & percentile, hourly + annual) by SOC occupation for services-band negotiations.",
    posture: "public-api",
    sourceUrl: "https://www.bls.gov/oes/",
    defaultRateLimitRpm: 10,
    // OEWS publishes once per year for the prior May reference period
    // (initial release in late March/early April, with revisions through
    // the spring). We tick at 13:30 UTC on the 1st of April, May, June,
    // and July so the annual refresh is captured no matter when BLS
    // publishes within that window, while leaving the rest of the year
    // idle to preserve the BLS API daily quota.
    defaultScheduleCron: "30 13 1 4-7 *",
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "US",
    retentionDays: 365 * 3,
    tenantOptInDefault: true,
    signalSchema: oewsSignalSchema,
    stableSignalKey(draft) {
      return defaultStableSignalKey(BLS_OEWS_COLLECTOR_ID, draft);
    },

    async collect({ since: _since, signal }): Promise<MarketSignalDraft[]> {
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
      // OEWS has a ~6 month lag; 3-year window covers the latest
      // release plus history for trend continuity if BLS slips one.
      const startYear = endYear - 3;

      const uniqueSeriesIds = Array.from(
        new Set(OEWS_SERIES.map((s) => s.seriesId)),
      );
      const tier = apiKey ? "authenticated" : "unauthenticated";
      const chunkSize = apiKey
        ? BLS_API_SERIES_PER_REQUEST_AUTHENTICATED
        : BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED;

      const stitched: BlsResponse = {
        status: "REQUEST_SUCCEEDED",
        Results: { series: [] },
      };
      for (let i = 0; i < uniqueSeriesIds.length; i += chunkSize) {
        const chunk = uniqueSeriesIds.slice(i, i + chunkSize);
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          throw new Error(
            `BLS OEWS API HTTP ${res.status} on chunk ${i / chunkSize + 1}: ${await res.text().catch(() => "<no body>")}`,
          );
        }
        const json = (await res.json()) as BlsResponse;
        if (json.status && json.status !== "REQUEST_SUCCEEDED") {
          const msg =
            (json.message && json.message.join("; ")) ||
            "unknown BLS OEWS error";
          throw new Error(
            `BLS OEWS API status=${json.status} on chunk ${i / chunkSize + 1}: ${msg}`,
          );
        }
        for (const s of json.Results?.series ?? []) {
          stitched.Results!.series!.push(s);
        }
      }

      return buildOewsDraftsFromResponse(stitched, OEWS_SERIES, {
        tier,
        onMissing: async (seriesId, reason) => {
          await recordWarning(this.id, reason, { seriesId });
        },
      });
    },
  };
