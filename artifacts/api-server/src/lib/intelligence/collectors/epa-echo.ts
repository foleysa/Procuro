/**
 * EPA ECHO collector — US environmental enforcement / violation feed.
 *
 * Pulls per-supplier enforcement cases from the EPA ECHO Case Search
 * REST endpoint:
 *   https://echodata.epa.gov/echo/case_rest_services.get_cases?output=JSON&p_co={NAME}
 *
 * For every watched US supplier (see `_us-suppliers`), one HTTP call is
 * issued and each returned case becomes one `environmental_violation`
 * MarketSignal:
 *   - scope_supplier_name = supplier display name
 *   - scope_sku           = case_number (per-case identifier)
 *   - scope_lane_key      = facility state (or "US")
 *   - value               = statute code (1=CWA, 2=CAA, 3=RCRA, 4=TSCA,
 *                           5=EPCRA, 6=SDWA, 7=FIFRA, 0=other)
 *
 * Posture: `public_api`, tier `T1`. EPA ECHO data is open and
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

export const EPA_ECHO_COLLECTOR_ID = "epa-echo";

const EPA_ECHO_BASE_URL =
  "https://echodata.epa.gov/echo/case_rest_services.get_cases";

/** Per-tick supplier cap — keeps the scheduled run bounded. */
export const EPA_ECHO_MAX_SUPPLIERS_PER_RUN = 50;

/**
 * Statute / law-section → numeric class so the `value` column can be
 * pivoted directly. 0 = other / unknown.
 */
export const EPA_ECHO_STATUTE_CODES: Record<string, number> = {
  CWA: 1, // Clean Water Act
  CAA: 2, // Clean Air Act
  RCRA: 3, // Resource Conservation & Recovery Act
  TSCA: 4, // Toxic Substances Control Act
  EPCRA: 5, // Emergency Planning & Community Right-to-Know
  SDWA: 6, // Safe Drinking Water Act
  FIFRA: 7, // Federal Insecticide, Fungicide, Rodenticide Act
};

/** Subset of an EPA ECHO Case row we read. */
export interface EchoCase {
  case_number?: string;
  case_name?: string;
  case_law_section_code?: string;
  case_status?: string;
  settlement_date?: string;
  settlement_entry_date?: string;
  facility_name?: string;
  facility_city?: string;
  facility_state?: string;
  facility_zip?: string;
  federal_penalty_assessed_amt?: number | string;
  complying_actions?: string;
  case_url?: string;
}

/** Top-level shape returned by the ECHO Case Search endpoint. */
export interface EchoCaseSearchResponse {
  Results?: {
    QueryRows?: string | number;
    Cases?: EchoCase[];
  };
  Error?: string;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v.replace(/[, $]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Convert one ECHO case + the supplier we queried for into a
 * MarketSignalDraft, or null if the row is unusable.
 */
export function caseToDraft(
  supplier: WatchedUsSupplier,
  c: EchoCase,
): MarketSignalDraft | null {
  const caseNumber = c.case_number?.trim();
  if (!caseNumber) return null;
  // Prefer settlement / entry date; fall back to today so the row still
  // lands but with a deterministic stable observed_at the dedupe index
  // can use.
  const dateStr =
    c.settlement_entry_date ?? c.settlement_date ?? null;
  const observedAt = dateStr
    ? new Date(`${dateStr.slice(0, 10)}T00:00:00Z`)
    : null;
  if (!observedAt || Number.isNaN(observedAt.getTime())) return null;

  const statute = (c.case_law_section_code ?? "").toUpperCase();
  const value = EPA_ECHO_STATUTE_CODES[statute] ?? 0;
  const state = c.facility_state?.trim() ?? null;
  const penalty = num(c.federal_penalty_assessed_amt);
  const sourceUrl =
    c.case_url ??
    `https://echo.epa.gov/enforcement-case-report?id=${encodeURIComponent(
      caseNumber,
    )}`;
  return {
    signalType: "environmental_violation",
    scopeSupplierName: supplier.name,
    scopeSku: caseNumber,
    scopeLaneKey: state ?? "US",
    value,
    unit: "epa_statute_code",
    currency: "USD",
    observedAt,
    sourceUrl,
    confidence: 0.95,
    metadata: {
      caseNumber,
      caseName: c.case_name ?? null,
      caseStatus: c.case_status ?? null,
      statute: statute || null,
      facilityName: c.facility_name ?? null,
      facilityCity: c.facility_city ?? null,
      facilityState: state,
      facilityZip: c.facility_zip ?? null,
      federalPenaltyUsd: penalty,
      complyingActions: c.complying_actions ?? null,
      supplierName: supplier.name,
      supplierNormalizedName: supplier.normalizedName,
    },
  };
}

/** Parse a full ECHO Case Search response for a single supplier. */
export function parseEchoCaseResponse(
  supplier: WatchedUsSupplier,
  res: EchoCaseSearchResponse,
): MarketSignalDraft[] {
  const cases = res.Results?.Cases ?? [];
  const out: MarketSignalDraft[] = [];
  for (const c of cases) {
    const d = caseToDraft(supplier, c);
    if (d) out.push(d);
  }
  return out;
}

const epaEchoMetadataSchema = z
  .object({
    caseNumber: z.string().min(1),
    caseName: z.string().nullable(),
    caseStatus: z.string().nullable(),
    statute: z.string().nullable(),
    facilityName: z.string().nullable(),
    facilityCity: z.string().nullable(),
    facilityState: z.string().nullable(),
    facilityZip: z.string().nullable(),
    federalPenaltyUsd: z.number().nullable(),
    complyingActions: z.string().nullable(),
    supplierName: z.string().min(1),
    supplierNormalizedName: z.string().min(1),
  })
  .passthrough();

const epaEchoSignalSchema = buildSignalDraftSchema(epaEchoMetadataSchema);

async function fetchEchoForSupplier(
  supplier: WatchedUsSupplier,
  signal?: AbortSignal,
): Promise<{ url: string; body: string; parsed: EchoCaseSearchResponse }> {
  const url = `${EPA_ECHO_BASE_URL}?output=JSON&p_co=${encodeURIComponent(
    supplier.name,
  )}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`EPA ECHO HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return { url, body, parsed: JSON.parse(body) as EchoCaseSearchResponse };
}

async function attachEpaEntityUids(
  drafts: MarketSignalDraft[],
): Promise<MarketSignalDraft[]> {
  const inputs = drafts.map((d) => ({
    collectorId: EPA_ECHO_COLLECTOR_ID,
    name: d.scopeSupplierName ?? "",
    country: "US",
  }));
  const uids = await resolveDraftEntities(inputs);
  return drafts.map((d, i) => (uids[i] ? { ...d, entityUid: uids[i]! } : d));
}

export const epaEchoCollector: IntelligenceCollector<typeof epaEchoSignalSchema> = {
  id: EPA_ECHO_COLLECTOR_ID,
  name: "EPA ECHO Enforcement Cases",
  description:
    "Polls the EPA ECHO Case Search REST API for environmental enforcement cases against watched US suppliers and emits one environmental_violation MarketSignal per case (case_number in scope_sku, statute code in value).",
  posture: "public-api",
  sourceUrl: "https://echo.epa.gov/tools/web-services",
  defaultRateLimitRpm: 30,
  // Daily at 07:00 UTC catches overnight settlement / entry-date
  // updates without thrashing the rate budget.
  defaultScheduleCron: "0 7 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "US",
  retentionDays: 1825,
  tenantOptInDefault: true,
  signalSchema: epaEchoSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(EPA_ECHO_COLLECTOR_ID, draft);
  },
  async collect({ signal, mode } = { since: null }): Promise<MarketSignalDraft[]> {
    return (await this.collectWithRaw!({ since: null, signal, mode })).drafts;
  },
  async collectWithRaw({ signal, mode } = { since: null }): Promise<CollectWithRawResult> {
    // Backfill mode lifts the per-tick supplier cap so an admin-triggered
    // historical replay covers every watched US supplier; the live cron
    // tick stays bounded by EPA_ECHO_MAX_SUPPLIERS_PER_RUN.
    const cap =
      (mode as CollectorRunMode | undefined) === "backfill"
        ? Number.MAX_SAFE_INTEGER
        : EPA_ECHO_MAX_SUPPLIERS_PER_RUN;
    const suppliers = await loadWatchedUsSuppliers(cap);
    if (suppliers.length === 0) {
      logger.info(
        { collectorId: EPA_ECHO_COLLECTOR_ID },
        "EPA ECHO: no US suppliers configured; nothing to poll",
      );
      return { drafts: [], rawPayloads: [] };
    }
    const drafts: MarketSignalDraft[] = [];
    const rawPayloads: RawPayload[] = [];
    const failures: string[] = [];
    for (const supplier of suppliers) {
      try {
        const r = await fetchEchoForSupplier(supplier, signal);
        for (const d of parseEchoCaseResponse(supplier, r.parsed)) {
          drafts.push(d);
        }
        rawPayloads.push({
          name: `cases-${supplier.normalizedName.replace(/\s+/g, "_")}`,
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
          { collectorId: EPA_ECHO_COLLECTOR_ID, supplier: supplier.name, err },
          "EPA ECHO pull failed",
        );
      }
    }
    if (drafts.length === 0 && failures.length === suppliers.length) {
      throw new Error(
        `epa-echo: all ${suppliers.length} suppliers failed. Sample: ${failures.slice(0, 2).join("; ")}`,
      );
    }
    const enriched = await attachEpaEntityUids(drafts);
    return { drafts: enriched, rawPayloads };
  },
};

/** Backfill — caller can supply an explicit supplier list. */
export async function fetchEpaEchoBackfillDrafts(opts?: {
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
      const r = await fetchEchoForSupplier(supplier);
      for (const d of parseEchoCaseResponse(supplier, r.parsed)) drafts.push(d);
    } catch (err) {
      failed.push({
        supplier: supplier.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const enriched = await attachEpaEntityUids(drafts);
  return { drafts: enriched, failed };
}
