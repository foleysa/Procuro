/**
 * USAspending.gov federal-procurement collector.
 *
 * The Treasury USAspending API publishes every federal award (contracts,
 * grants, loans, ...) under an open, key-less HTTP API. We poll it per
 * watched supplier name and emit one `public_bid_award` MarketSignal per
 * matching award so the Supplier 360 page can surface "this vendor sells
 * $N to the federal government per year" alongside sanctions and
 * filings.
 *
 * Why per-supplier polling:
 *   The full firehose is enormous. Tenants only care about awards for
 *   suppliers they actually buy from, so we pull the distinct supplier
 *   names across every tenant (capped) and POST one search per name.
 *   Idempotency comes from the natural-key dedupe on
 *   (collectorId, signalType, scope_supplier_name, observedAt).
 *
 * Endpoint:
 *   POST https://api.usaspending.gov/api/v2/search/spending_by_award/
 *   No API key required. Documented at
 *   https://api.usaspending.gov/docs/endpoints
 *
 * Each emitted draft uses:
 *   - `signalType`        = `public_bid_award`
 *   - `value`             = obligation amount in USD
 *   - `unit`              = `usd_award`
 *   - `currency`          = `USD`
 *   - `scopeSupplierName` = the recipient name as USAspending returns it
 *   - `scopeSku`          = USAspending generated_internal_id (stable per award)
 *   - `scopeRegionCode`   = recipient state code, when present
 *   - `metadata`          = { piid, awardingAgency, awardType, period, recipientUei }
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
import { logger } from "../../logger";
import { loadWatchedSupplierNames } from "./_watched-suppliers";
import { resolveDraftEntities } from "./_entity-resolver";

export const USASPENDING_COLLECTOR_ID = "usaspending";

const USASPENDING_SEARCH_URL =
  "https://api.usaspending.gov/api/v2/search/spending_by_award/";

/** Cap awards-per-supplier so a single very active vendor doesn't drown the run. */
const USASPENDING_AWARDS_PER_SUPPLIER = 25;

/** Cap watched-supplier names per scheduled tick. Backfill mode lifts it. */
const USASPENDING_MAX_SUPPLIERS_PER_RUN = 50;
const USASPENDING_MAX_SUPPLIERS_PER_BACKFILL = 250;

interface UsaspendingAward {
  recipientName: string;
  recipientUei: string | null;
  recipientStateCode: string | null;
  generatedInternalId: string;
  piid: string | null;
  awardingAgency: string | null;
  awardType: string | null;
  obligationAmountUsd: number;
  actionDate: Date;
}

/**
 * Parse a raw `spending_by_award` response into our normalised shape.
 * Tolerates missing optional fields — the API returns a `null` for a
 * column that isn't present rather than omitting the key.
 */
export function parseUsaspendingResponse(json: unknown): UsaspendingAward[] {
  if (!json || typeof json !== "object") return [];
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const awards: UsaspendingAward[] = [];
  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const recipientName =
      typeof r["Recipient Name"] === "string" ? (r["Recipient Name"] as string) : null;
    const generatedInternalId =
      typeof r["generated_internal_id"] === "string"
        ? (r["generated_internal_id"] as string)
        : null;
    if (!recipientName || !generatedInternalId) continue;
    const obligationRaw = r["Award Amount"];
    const obligationAmountUsd =
      typeof obligationRaw === "number"
        ? obligationRaw
        : typeof obligationRaw === "string"
          ? Number(obligationRaw)
          : NaN;
    if (!Number.isFinite(obligationAmountUsd)) continue;
    const actionDateRaw = r["Action Date"] ?? r["Last Modified Date"];
    const actionDate =
      typeof actionDateRaw === "string" ? new Date(actionDateRaw) : null;
    if (!actionDate || Number.isNaN(actionDate.getTime())) continue;
    awards.push({
      recipientName,
      recipientUei:
        typeof r["recipient_id"] === "string" ? (r["recipient_id"] as string) : null,
      recipientStateCode:
        typeof r["Recipient Location State Code"] === "string"
          ? (r["Recipient Location State Code"] as string)
          : null,
      generatedInternalId,
      piid: typeof r["Award ID"] === "string" ? (r["Award ID"] as string) : null,
      awardingAgency:
        typeof r["Awarding Agency"] === "string"
          ? (r["Awarding Agency"] as string)
          : null,
      awardType:
        typeof r["Award Type"] === "string" ? (r["Award Type"] as string) : null,
      obligationAmountUsd,
      actionDate,
    });
  }
  return awards;
}

/** Build the POST body our search uses. */
function buildSearchBody(
  recipientName: string,
  windowStart: Date,
  windowEnd: Date,
): Record<string, unknown> {
  const fmt = (d: Date): string => d.toISOString().slice(0, 10);
  return {
    filters: {
      // Contract + IDV award types only — these are the procurement
      // awards a supplier-360 page cares about. Grants and loans are
      // out of scope for federal-procurement intelligence.
      award_type_codes: ["A", "B", "C", "D", "IDV_A", "IDV_B", "IDV_C", "IDV_D", "IDV_E"],
      time_period: [{ start_date: fmt(windowStart), end_date: fmt(windowEnd) }],
      recipient_search_text: [recipientName],
    },
    fields: [
      "Award ID",
      "Recipient Name",
      "Award Amount",
      "Awarding Agency",
      "Award Type",
      "Action Date",
      "Last Modified Date",
      "Recipient Location State Code",
      "recipient_id",
      "generated_internal_id",
    ],
    page: 1,
    limit: USASPENDING_AWARDS_PER_SUPPLIER,
    sort: "Award Amount",
    order: "desc",
  };
}

const usaspendingMetadataSchema = z
  .object({
    piid: z.string().nullable(),
    awardingAgency: z.string().nullable(),
    awardType: z.string().nullable(),
    actionDate: z.string(),
    recipientUei: z.string().nullable(),
  })
  .passthrough();

const usaspendingSignalSchema = buildSignalDraftSchema(usaspendingMetadataSchema);

async function fetchSpendingByAward(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ json: unknown; raw: string }> {
  const res = await fetch(USASPENDING_SEARCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "User-Agent": "Procuro Compliance Platform",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} for USAspending spending_by_award`,
    );
  }
  const raw = await res.text();
  return { json: JSON.parse(raw), raw };
}

export const usaspendingCollector: IntelligenceCollector<typeof usaspendingSignalSchema> = {
  id: USASPENDING_COLLECTOR_ID,
  name: "USAspending.gov federal awards",
  description:
    "Polls the open Treasury USAspending.gov spending_by_award endpoint per watched supplier name and emits one public_bid_award MarketSignal per federal contract / IDV award. No API key required. Capped at USASPENDING_MAX_SUPPLIERS_PER_RUN watched suppliers per scheduled tick (lifted in backfill mode).",
  posture: "public-api",
  sourceUrl: "https://api.usaspending.gov/",
  // Treasury rate-limits are generous; one tick polls dozens of supplier
  // names so we keep the per-minute cap conservative.
  defaultRateLimitRpm: 30,
  // Federal awards are reported daily; refresh once per day.
  defaultScheduleCron: "20 5 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "US",
  retentionDays: 730,
  tenantOptInDefault: true,
  signalSchema: usaspendingSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(USASPENDING_COLLECTOR_ID, draft);
  },
  async collect({ signal, mode } = { since: null }): Promise<MarketSignalDraft[]> {
    return (
      await this.collectWithRaw!({ since: null, signal, mode: mode ?? "latest" })
    ).drafts;
  },
  async collectWithRaw({ signal, mode } = { since: null }): Promise<CollectWithRawResult> {
    const isBackfill = mode === "backfill";
    const supplierCap = isBackfill
      ? USASPENDING_MAX_SUPPLIERS_PER_BACKFILL
      : USASPENDING_MAX_SUPPLIERS_PER_RUN;
    // Backfill widens the time window from 18 months to 5 years.
    const now = new Date();
    const windowStart = new Date(now);
    windowStart.setMonth(windowStart.getMonth() - (isBackfill ? 60 : 18));

    const watched = await loadWatchedSupplierNames({ limit: supplierCap });
    if (watched.length === 0) {
      return { drafts: [], rawPayloads: [] };
    }

    const drafts: MarketSignalDraft[] = [];
    const rawPayloads: RawPayload[] = [];
    let failures = 0;
    const allAwards: UsaspendingAward[] = [];

    for (const w of watched) {
      try {
        const body = buildSearchBody(w.name, windowStart, now);
        const { json, raw } = await fetchSpendingByAward(body, signal);
        const awards = parseUsaspendingResponse(json);
        rawPayloads.push({
          name: `usaspending-${w.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`,
          contentType: "application/json",
          body: raw,
          sourceUrl: USASPENDING_SEARCH_URL,
          metadata: { recipientName: w.name, awards: awards.length },
        });
        for (const a of awards) {
          allAwards.push(a);
        }
      } catch (err) {
        failures++;
        logger.warn(
          {
            collectorId: USASPENDING_COLLECTOR_ID,
            supplier: w.name,
            err: (err as Error).message,
          },
          "USAspending search failed for supplier; continuing",
        );
      }
    }

    // Resolve canonical entity_uid in parallel so the supplier-detail
    // join works the same way it does for SEC EDGAR / GLEIF.
    const uids = await resolveDraftEntities(
      allAwards.map((a) => ({
        collectorId: USASPENDING_COLLECTOR_ID,
        name: a.recipientName,
        country: "US",
        ...(a.recipientUei ? { identifiers: { uei: a.recipientUei } } : {}),
      })),
    );

    for (let i = 0; i < allAwards.length; i++) {
      const a = allAwards[i]!;
      drafts.push({
        signalType: "public_bid_award",
        scopeSupplierName: a.recipientName,
        scopeSku: a.generatedInternalId,
        ...(a.recipientStateCode ? { scopeRegionCode: a.recipientStateCode } : {}),
        value: a.obligationAmountUsd,
        unit: "usd_award",
        currency: "USD",
        observedAt: a.actionDate,
        sourceUrl: USASPENDING_SEARCH_URL,
        confidence: 0.95,
        ...(uids[i] ? { entityUid: uids[i]! } : {}),
        metadata: {
          piid: a.piid,
          awardingAgency: a.awardingAgency,
          awardType: a.awardType,
          actionDate: a.actionDate.toISOString(),
          recipientUei: a.recipientUei,
        },
      });
    }

    if (drafts.length === 0 && failures === watched.length && watched.length > 0) {
      throw new Error(
        `usaspending: every supplier search failed (${failures}/${watched.length})`,
      );
    }
    return { drafts, rawPayloads };
  },
};
