/**
 * ClimateTRACE collector — facility-level emissions for ESG /
 * scope-3 supplier intelligence.
 *
 * Pulls the ClimateTRACE asset emissions search API
 *   https://api.climatetrace.org/v6/assets
 * which returns paginated facility-level emissions records. We
 * normalise each into a `facility_emissions` MarketSignal scoped by
 * supplier name (the asset owner) with the asset id in scope_sku, the
 * country in scope_lane_key, and `value` set to the most recent annual
 * CO2e tonnage.
 *
 * Posture: `public_api`, tier `T2`. ClimateTRACE data is CC-BY 4.0,
 * fully attributable to climatetrace.org.
 *
 * Default scheduled tick pulls one page (limit=200) of the most
 * recently updated assets across the platform; the backfill helper
 * paginates further or filters by sector / country.
 */

import { z } from "zod";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";
import type {
  CollectWithRawResult,
  IntelligenceCollector,
  MarketSignalDraft,
  RawPayload,
} from "../collector";

export const CLIMATE_TRACE_COLLECTOR_ID = "climate-trace";

const CLIMATE_TRACE_BASE_URL = "https://api.climatetrace.org/v6/assets";
export const CLIMATE_TRACE_DEFAULT_LIMIT = 200;

export interface ClimateTraceAsset {
  AssetId?: number | string;
  Id?: number | string;
  Name?: string;
  Country?: string;
  Iso3Country?: string;
  Sector?: string;
  Subsector?: string;
  AssetType?: string;
  Owner?: string | { Name?: string }[] | { Name?: string };
  Co2?: number;
  Co2e_100yr?: number;
  Co2e_20yr?: number;
  Confidence?: number;
  EmissionsQuantityUnits?: string;
  StartTime?: string;
  EndTime?: string;
  Centroid?: { Geometry?: number[] } | null;
  Capacity?: number | null;
  CapacityUnits?: string | null;
}

export interface ClimateTraceResponse {
  assets?: ClimateTraceAsset[];
  Assets?: ClimateTraceAsset[];
  data?: ClimateTraceAsset[];
  total?: number;
  Total?: number;
}

function ownerName(owner: ClimateTraceAsset["Owner"]): string | null {
  if (!owner) return null;
  if (typeof owner === "string") return owner;
  if (Array.isArray(owner)) {
    for (const o of owner) {
      if (o && typeof o.Name === "string" && o.Name.trim()) return o.Name.trim();
    }
    return null;
  }
  if (typeof owner === "object" && owner.Name) return owner.Name;
  return null;
}

/** Convert a ClimateTRACE asset record into a MarketSignalDraft. */
export function assetToDraft(asset: ClimateTraceAsset): MarketSignalDraft | null {
  const id = asset.AssetId ?? asset.Id;
  if (id === undefined || id === null) return null;
  const name = asset.Name ?? null;
  // Prefer the 100-year CO2e (industry standard) but fall back to raw
  // CO2 / 20-year CO2e to keep more rows.
  const value =
    typeof asset.Co2e_100yr === "number"
      ? asset.Co2e_100yr
      : typeof asset.Co2 === "number"
        ? asset.Co2
        : typeof asset.Co2e_20yr === "number"
          ? asset.Co2e_20yr
          : null;
  if (value === null || !Number.isFinite(value)) return null;
  const observedAt = asset.EndTime
    ? new Date(asset.EndTime)
    : asset.StartTime
      ? new Date(asset.StartTime)
      : new Date();
  if (Number.isNaN(observedAt.getTime())) return null;
  const owner = ownerName(asset.Owner);
  return {
    signalType: "facility_emissions",
    scopeSupplierName: owner ?? name ?? `ClimateTRACE asset ${id}`,
    scopeSku: String(id),
    scopeLaneKey: asset.Iso3Country ?? asset.Country ?? undefined,
    scopeCategoryCode: asset.Sector ?? undefined,
    value,
    unit: asset.EmissionsQuantityUnits ?? "tonnes_co2e",
    currency: "USD",
    observedAt,
    sourceUrl: `https://climatetrace.org/explore?assetId=${id}`,
    confidence:
      typeof asset.Confidence === "number" && asset.Confidence >= 0 && asset.Confidence <= 1
        ? asset.Confidence
        : 0.7,
    entityUid: owner ? `ent_climatetrace_owner_${owner.replace(/\s+/g, "_").toLowerCase()}` : null,
    metadata: {
      assetId: String(id),
      assetName: name,
      country: asset.Country ?? null,
      iso3Country: asset.Iso3Country ?? null,
      sector: asset.Sector ?? null,
      subsector: asset.Subsector ?? null,
      assetType: asset.AssetType ?? null,
      ownerName: owner,
      co2: asset.Co2 ?? null,
      co2e100yr: asset.Co2e_100yr ?? null,
      co2e20yr: asset.Co2e_20yr ?? null,
      capacity: asset.Capacity ?? null,
      capacityUnits: asset.CapacityUnits ?? null,
      startTime: asset.StartTime ?? null,
      endTime: asset.EndTime ?? null,
    },
  };
}

export function parseClimateTraceResponse(
  payload: ClimateTraceResponse,
): MarketSignalDraft[] {
  const list = payload.assets ?? payload.Assets ?? payload.data ?? [];
  const drafts: MarketSignalDraft[] = [];
  for (const asset of list) {
    const draft = assetToDraft(asset);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

const climateTraceMetadataSchema = z
  .object({
    assetId: z.string().min(1),
    assetName: z.string().nullable(),
    country: z.string().nullable(),
    iso3Country: z.string().nullable(),
    sector: z.string().nullable(),
    subsector: z.string().nullable(),
    assetType: z.string().nullable(),
    ownerName: z.string().nullable(),
    co2: z.number().nullable(),
    co2e100yr: z.number().nullable(),
    co2e20yr: z.number().nullable(),
    capacity: z.number().nullable(),
    capacityUnits: z.string().nullable(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
  })
  .passthrough();

const climateTraceSignalSchema = buildSignalDraftSchema(climateTraceMetadataSchema);

async function fetchClimateTracePage(
  offset: number,
  limit: number,
  sector?: string,
  country?: string,
  signal?: AbortSignal,
): Promise<{ payload: ClimateTraceResponse; body: string; url: string }> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (sector) params.set("sectors", sector);
  if (country) params.set("countries", country);
  const url = `${CLIMATE_TRACE_BASE_URL}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`ClimateTRACE HTTP ${res.status} (${url})`);
  const body = await res.text();
  const payload = JSON.parse(body) as ClimateTraceResponse;
  return { payload, body, url };
}

export const climateTraceCollector: IntelligenceCollector<typeof climateTraceSignalSchema> = {
  id: CLIMATE_TRACE_COLLECTOR_ID,
  name: "ClimateTRACE Facility Emissions",
  description:
    "Pulls the ClimateTRACE asset-emissions API and emits one facility_emissions MarketSignal per facility (owner in scope_supplier_name, asset id in scope_sku, sector in scope_category_code, latest annual CO2e in value).",
  posture: "public-api",
  sourceUrl: "https://climatetrace.org/",
  defaultRateLimitRpm: 30,
  // ClimateTRACE refreshes its asset-emissions snapshot on a roughly
  // monthly cadence; weekly polls produce no new data and just spend
  // the rate budget. Run on the 1st of every month at 06:00 UTC.
  defaultScheduleCron: "0 6 1 * *",
  postureClass: "public_api",
  disclosureTier: "T2",
  jurisdiction: "GLOBAL",
  retentionDays: 1095,
  tenantOptInDefault: false,
  signalSchema: climateTraceSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(CLIMATE_TRACE_COLLECTOR_ID, draft);
  },
  async collect({ signal } = { since: null }): Promise<MarketSignalDraft[]> {
    return (await this.collectWithRaw!({ since: null, signal })).drafts;
  },
  async collectWithRaw({ signal } = { since: null }): Promise<CollectWithRawResult> {
    const { payload, body, url } = await fetchClimateTracePage(
      0,
      CLIMATE_TRACE_DEFAULT_LIMIT,
      undefined,
      undefined,
      signal,
    );
    const drafts = parseClimateTraceResponse(payload);
    const rawPayloads: RawPayload[] = [
      {
        name: "climate-trace-assets-page-0",
        contentType: "application/json",
        body,
        sourceUrl: url,
        metadata: { offset: 0, limit: CLIMATE_TRACE_DEFAULT_LIMIT },
      },
    ];
    return { drafts, rawPayloads };
  },
};

export async function fetchClimateTraceBackfillDrafts(opts?: {
  maxPages?: number;
  pageSize?: number;
  sector?: string;
  country?: string;
}): Promise<{ drafts: MarketSignalDraft[]; pagesFetched: number }> {
  const pageSize = opts?.pageSize ?? CLIMATE_TRACE_DEFAULT_LIMIT;
  const maxPages = opts?.maxPages ?? 10;
  const drafts: MarketSignalDraft[] = [];
  let page = 0;
  while (page < maxPages) {
    const { payload } = await fetchClimateTracePage(
      page * pageSize,
      pageSize,
      opts?.sector,
      opts?.country,
    );
    const pageDrafts = parseClimateTraceResponse(payload);
    if (pageDrafts.length === 0) break;
    for (const d of pageDrafts) drafts.push(d);
    page++;
  }
  return { drafts, pagesFetched: page };
}
