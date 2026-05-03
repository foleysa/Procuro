/**
 * OSHA Inspections collector — US workplace-safety enforcement feed.
 *
 * Pulls per-supplier inspection records from the DOL OSHA Establishment
 * Search JSON endpoint:
 *   https://www.osha.gov/pls/imis/establishment.json?establishment={NAME}
 *
 * For every watched US supplier (see `_us-suppliers`), one HTTP call is
 * issued and each returned inspection becomes one
 * `workplace_safety_incident` MarketSignal:
 *   - scope_supplier_name = supplier display name
 *   - scope_sku           = activity_nr (OSHA inspection id)
 *   - scope_lane_key      = site state (or "US")
 *   - value               = scope code (1=Comprehensive, 2=Partial,
 *                           3=Records, 4=Referral, 5=Complaint,
 *                           6=Accident, 7=Programmed, 0=other)
 *
 * Posture: `public_api`, tier `T1`. OSHA inspection data is open and
 * citable. No API key required.
 */

import { z } from "zod";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";
import type {
  CollectorRunMode,
  CollectWithRawResult,
  IntelligenceCollector,
  MarketSignalDraft,
  RawPayload,
} from "../collector";
import { logger } from "../../logger";
import { resolveDraftEntities } from "./_entity-resolver";
import {
  loadWatchedUsSuppliers,
  type WatchedUsSupplier,
} from "./_us-suppliers";

export const OSHA_COLLECTOR_ID = "osha-inspections";

const OSHA_BASE_URL = "https://www.osha.gov/pls/imis/establishment.json";

/** Per-tick supplier cap. */
export const OSHA_MAX_SUPPLIERS_PER_RUN = 50;

/** Inspection-scope label → numeric class for the `value` column. */
export const OSHA_INSPECTION_SCOPE_CODES: Record<string, number> = {
  Comprehensive: 1,
  Partial: 2,
  Records: 3,
  Referral: 4,
  Complaint: 5,
  Accident: 6,
  Programmed: 7,
};

/** Subset of an OSHA inspection record we read. */
export interface OshaViolation {
  citation_id?: string;
  standard?: string;
  gravity?: number | string;
  initial_penalty?: number | string;
  current_penalty?: number | string;
  citation_type?: string;
}

export interface OshaInspection {
  activity_nr?: string;
  estab_name?: string;
  site_address?: string;
  site_city?: string;
  site_state?: string;
  site_zip?: string;
  open_date?: string;
  close_case_date?: string;
  naics_code?: string;
  scope_label?: string;
  total_violations?: number | string;
  total_penalty?: number | string;
  violations?: OshaViolation[];
}

export interface OshaSearchResponse {
  inspections?: OshaInspection[];
  error?: string;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v.replace(/[, $]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function int(v: unknown): number | null {
  const n = num(v);
  if (n == null) return null;
  return Math.trunc(n);
}

/**
 * Convert one OSHA inspection + the supplier we queried for into a
 * MarketSignalDraft, or null if the row is unusable.
 */
export function inspectionToDraft(
  supplier: WatchedUsSupplier,
  i: OshaInspection,
): MarketSignalDraft | null {
  const activityNr = i.activity_nr?.trim();
  if (!activityNr) return null;
  // Prefer open_date (when the inspection started); fall back to
  // close_case_date.
  const dateStr = i.open_date ?? i.close_case_date ?? null;
  const observedAt = dateStr
    ? new Date(`${dateStr.slice(0, 10)}T00:00:00Z`)
    : null;
  if (!observedAt || Number.isNaN(observedAt.getTime())) return null;

  const scope = (i.scope_label ?? "").trim();
  const value = OSHA_INSPECTION_SCOPE_CODES[scope] ?? 0;
  const state = i.site_state?.trim() ?? null;
  const totalPenalty = num(i.total_penalty);
  const totalViolations = int(i.total_violations);
  const violations = (i.violations ?? []).map((v) => ({
    citationId: v.citation_id ?? null,
    standard: v.standard ?? null,
    gravity: int(v.gravity),
    initialPenaltyUsd: num(v.initial_penalty),
    currentPenaltyUsd: num(v.current_penalty),
    citationType: v.citation_type ?? null,
  }));
  const sourceUrl = `https://www.osha.gov/ords/imis/establishment.inspection_detail?id=${encodeURIComponent(
    activityNr,
  )}`;
  return {
    signalType: "workplace_safety_incident",
    scopeSupplierName: supplier.name,
    scopeSku: activityNr,
    scopeLaneKey: state ?? "US",
    value,
    unit: "osha_scope_code",
    currency: "USD",
    observedAt,
    sourceUrl,
    confidence: 0.95,
    metadata: {
      activityNr,
      establishmentName: i.estab_name ?? null,
      siteAddress: i.site_address ?? null,
      siteCity: i.site_city ?? null,
      siteState: state,
      siteZip: i.site_zip ?? null,
      naicsCode: i.naics_code ?? null,
      scopeLabel: scope || null,
      openDate: i.open_date ?? null,
      closeCaseDate: i.close_case_date ?? null,
      totalViolations,
      totalPenaltyUsd: totalPenalty,
      violations,
      supplierName: supplier.name,
      supplierNormalizedName: supplier.normalizedName,
    },
  };
}

/** Parse a full OSHA establishment-search response for one supplier. */
export function parseOshaResponse(
  supplier: WatchedUsSupplier,
  res: OshaSearchResponse,
): MarketSignalDraft[] {
  const insp = res.inspections ?? [];
  const out: MarketSignalDraft[] = [];
  for (const i of insp) {
    const d = inspectionToDraft(supplier, i);
    if (d) out.push(d);
  }
  return out;
}

const oshaViolationSchema = z.object({
  citationId: z.string().nullable(),
  standard: z.string().nullable(),
  gravity: z.number().nullable(),
  initialPenaltyUsd: z.number().nullable(),
  currentPenaltyUsd: z.number().nullable(),
  citationType: z.string().nullable(),
});

const oshaMetadataSchema = z
  .object({
    activityNr: z.string().min(1),
    establishmentName: z.string().nullable(),
    siteAddress: z.string().nullable(),
    siteCity: z.string().nullable(),
    siteState: z.string().nullable(),
    siteZip: z.string().nullable(),
    naicsCode: z.string().nullable(),
    scopeLabel: z.string().nullable(),
    openDate: z.string().nullable(),
    closeCaseDate: z.string().nullable(),
    totalViolations: z.number().nullable(),
    totalPenaltyUsd: z.number().nullable(),
    violations: z.array(oshaViolationSchema),
    supplierName: z.string().min(1),
    supplierNormalizedName: z.string().min(1),
  })
  .passthrough();

const oshaSignalSchema = buildSignalDraftSchema(oshaMetadataSchema);

async function fetchOshaForSupplier(
  supplier: WatchedUsSupplier,
  signal?: AbortSignal,
): Promise<{ url: string; body: string; parsed: OshaSearchResponse }> {
  const url = `${OSHA_BASE_URL}?establishment=${encodeURIComponent(
    supplier.name,
  )}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`OSHA HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return { url, body, parsed: JSON.parse(body) as OshaSearchResponse };
}

async function attachOshaEntityUids(
  drafts: MarketSignalDraft[],
): Promise<MarketSignalDraft[]> {
  const inputs = drafts.map((d) => ({
    collectorId: OSHA_COLLECTOR_ID,
    name: d.scopeSupplierName ?? "",
    country: "US",
  }));
  const uids = await resolveDraftEntities(inputs);
  return drafts.map((d, i) => (uids[i] ? { ...d, entityUid: uids[i]! } : d));
}

export const oshaInspectionsCollector: IntelligenceCollector<typeof oshaSignalSchema> = {
  id: OSHA_COLLECTOR_ID,
  name: "DOL OSHA Inspections",
  description:
    "Polls the DOL OSHA Establishment Search REST API for workplace inspections against watched US suppliers and emits one workplace_safety_incident MarketSignal per inspection (activity_nr in scope_sku, scope-label code in value, violation list in metadata).",
  posture: "public-api",
  sourceUrl: "https://www.osha.gov/data",
  defaultRateLimitRpm: 30,
  // Daily at 07:30 UTC — staggered after EPA ECHO so the two
  // supplier-risk collectors don't compete for the same upstream
  // window. OSHA publishes inspections daily after east-coast close.
  defaultScheduleCron: "30 7 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "US",
  retentionDays: 1825,
  tenantOptInDefault: true,
  signalSchema: oshaSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(OSHA_COLLECTOR_ID, draft);
  },
  async collect({ signal, mode } = { since: null }): Promise<MarketSignalDraft[]> {
    return (await this.collectWithRaw!({ since: null, signal, mode })).drafts;
  },
  async collectWithRaw({ signal, mode } = { since: null }): Promise<CollectWithRawResult> {
    // Backfill mode lifts the per-tick supplier cap so an admin-triggered
    // historical replay covers every watched US supplier; the live cron
    // tick stays bounded by OSHA_MAX_SUPPLIERS_PER_RUN.
    const cap =
      (mode as CollectorRunMode | undefined) === "backfill"
        ? Number.MAX_SAFE_INTEGER
        : OSHA_MAX_SUPPLIERS_PER_RUN;
    const suppliers = await loadWatchedUsSuppliers(cap);
    if (suppliers.length === 0) {
      logger.info(
        { collectorId: OSHA_COLLECTOR_ID },
        "OSHA: no US suppliers configured; nothing to poll",
      );
      return { drafts: [], rawPayloads: [] };
    }
    const drafts: MarketSignalDraft[] = [];
    const rawPayloads: RawPayload[] = [];
    const failures: string[] = [];
    for (const supplier of suppliers) {
      try {
        const r = await fetchOshaForSupplier(supplier, signal);
        for (const d of parseOshaResponse(supplier, r.parsed)) drafts.push(d);
        rawPayloads.push({
          name: `inspections-${supplier.normalizedName.replace(/\s+/g, "_")}`,
          contentType: "application/json",
          body: r.body,
          sourceUrl: r.url,
          metadata: { supplierName: supplier.name },
        });
      } catch (err) {
        failures.push(
          `${supplier.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        logger.warn(
          { collectorId: OSHA_COLLECTOR_ID, supplier: supplier.name, err },
          "OSHA pull failed",
        );
      }
    }
    if (drafts.length === 0 && failures.length === suppliers.length) {
      throw new Error(
        `osha-inspections: all ${suppliers.length} suppliers failed. Sample: ${failures.slice(0, 2).join("; ")}`,
      );
    }
    const enriched = await attachOshaEntityUids(drafts);
    return { drafts: enriched, rawPayloads };
  },
};

/** Backfill — caller can supply an explicit supplier list. */
export async function fetchOshaBackfillDrafts(opts?: {
  suppliers?: readonly WatchedUsSupplier[];
  cap?: number;
}): Promise<{
  drafts: MarketSignalDraft[];
  failed: Array<{ supplier: string; error: string }>;
}> {
  const suppliers = opts?.suppliers
    ? [...opts.suppliers]
    : await loadWatchedUsSuppliers(opts?.cap ?? Number.MAX_SAFE_INTEGER);
  const drafts: MarketSignalDraft[] = [];
  const failed: Array<{ supplier: string; error: string }> = [];
  for (const supplier of suppliers) {
    try {
      const r = await fetchOshaForSupplier(supplier);
      for (const d of parseOshaResponse(supplier, r.parsed)) drafts.push(d);
    } catch (err) {
      failed.push({
        supplier: supplier.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const enriched = await attachOshaEntityUids(drafts);
  return { drafts: enriched, failed };
}
