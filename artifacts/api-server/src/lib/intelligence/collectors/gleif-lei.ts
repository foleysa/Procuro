/**
 * GLEIF LEI collector — global legal-entity registry.
 *
 * Pulls Level-1 records from the GLEIF public REST API
 *   https://api.gleif.org/api/v1/lei-records
 * which returns JSON:API formatted entity records (LEI, legal name,
 * jurisdiction, registration status, and parent relationships).
 *
 * Each draft is one `entity_registry` MarketSignal scoped by supplier
 * name with the LEI in scope_sku, jurisdiction in scope_lane_key, and
 * registration status code as draft.value:
 *   1 = ISSUED, 2 = LAPSED, 3 = MERGED, 4 = RETIRED, 5 = DUPLICATE,
 *   6 = ANNULLED, 7 = TRANSFERRED, 8 = PENDING_TRANSFER,
 *   9 = PENDING_ARCHIVAL, 0 = OTHER
 *
 * Posture: `public_api`, tier `T1`. GLEIF data is fully open and
 * citable (CC0).
 *
 * Default scheduled tick pulls the most-recently-updated 200 records
 * (page[size]=200, sort=-attributes.entity.lastUpdateDate). The
 * backfill helper paginates through the full registry on demand.
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
import { resolveDraftEntities } from "./_entity-resolver";

export const GLEIF_LEI_COLLECTOR_ID = "gleif-lei";

const GLEIF_BASE_URL = "https://api.gleif.org/api/v1/lei-records";
export const GLEIF_DEFAULT_PAGE_SIZE = 200;

export const GLEIF_REGISTRATION_STATUS_CODES: Record<string, number> = {
  ISSUED: 1,
  LAPSED: 2,
  MERGED: 3,
  RETIRED: 4,
  DUPLICATE: 5,
  ANNULLED: 6,
  TRANSFERRED: 7,
  PENDING_TRANSFER: 8,
  PENDING_ARCHIVAL: 9,
};

export interface GleifRecord {
  id: string;
  type?: string;
  attributes?: {
    lei?: string;
    entity?: {
      legalName?: { name?: string };
      jurisdiction?: string;
      legalAddress?: { country?: string };
      headquartersAddress?: { country?: string };
      status?: string;
    };
    registration?: {
      status?: string;
      lastUpdateDate?: string;
      initialRegistrationDate?: string;
    };
  };
  relationships?: Record<string, unknown>;
}

export interface GleifResponse {
  data?: GleifRecord[];
  meta?: { pagination?: { currentPage?: number; lastPage?: number; total?: number } };
}

/** Convert one GLEIF record into a MarketSignalDraft. */
export function recordToDraft(record: GleifRecord): MarketSignalDraft | null {
  const lei = record.attributes?.lei ?? record.id;
  const name = record.attributes?.entity?.legalName?.name;
  if (!lei || !name) return null;
  const status = record.attributes?.registration?.status ?? "OTHER";
  const value = GLEIF_REGISTRATION_STATUS_CODES[status] ?? 0;
  const jurisdiction = record.attributes?.entity?.jurisdiction ?? null;
  const country =
    record.attributes?.entity?.legalAddress?.country ??
    record.attributes?.entity?.headquartersAddress?.country ??
    null;
  const lastUpdate = record.attributes?.registration?.lastUpdateDate;
  const observedAt = lastUpdate ? new Date(lastUpdate) : new Date();
  if (Number.isNaN(observedAt.getTime())) return null;
  return {
    signalType: "entity_registry",
    scopeSupplierName: name,
    scopeSku: lei,
    scopeLaneKey: jurisdiction ?? country ?? undefined,
    value,
    unit: "registration_status",
    currency: "USD",
    observedAt,
    sourceUrl: `https://search.gleif.org/#/record/${lei}`,
    confidence: 0.99,
    // entityUid is populated by the collector's resolver pass.
    metadata: {
      lei,
      legalName: name,
      jurisdiction,
      legalAddressCountry: record.attributes?.entity?.legalAddress?.country ?? null,
      headquartersCountry:
        record.attributes?.entity?.headquartersAddress?.country ?? null,
      registrationStatus: status,
      entityStatus: record.attributes?.entity?.status ?? null,
      lastUpdateDate: lastUpdate ?? null,
      initialRegistrationDate:
        record.attributes?.registration?.initialRegistrationDate ?? null,
    },
  };
}

export function parseGleifResponse(payload: GleifResponse): MarketSignalDraft[] {
  const drafts: MarketSignalDraft[] = [];
  for (const r of payload.data ?? []) {
    const d = recordToDraft(r);
    if (d) drafts.push(d);
  }
  return drafts;
}

const gleifMetadataSchema = z
  .object({
    lei: z.string().min(1),
    legalName: z.string().min(1),
    jurisdiction: z.string().nullable(),
    legalAddressCountry: z.string().nullable(),
    headquartersCountry: z.string().nullable(),
    registrationStatus: z.string().min(1),
    entityStatus: z.string().nullable(),
    lastUpdateDate: z.string().nullable(),
    initialRegistrationDate: z.string().nullable(),
  })
  .passthrough();

const gleifSignalSchema = buildSignalDraftSchema(gleifMetadataSchema);

async function fetchGleifPage(
  page: number,
  pageSize: number,
): Promise<{ url: string; body: string; parsed: GleifResponse }> {
  const url = `${GLEIF_BASE_URL}?page[number]=${page}&page[size]=${pageSize}&sort=-attributes.registration.lastUpdateDate`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.api+json" } });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`GLEIF HTTP ${res.status} (page ${page})`);
  }
  return { url, body, parsed: JSON.parse(body) as GleifResponse };
}

async function attachGleifEntityUids(
  drafts: MarketSignalDraft[],
): Promise<MarketSignalDraft[]> {
  const inputs = drafts.map((d) => {
    const md = (d.metadata ?? {}) as { lei?: string; jurisdiction?: string | null };
    return {
      collectorId: GLEIF_LEI_COLLECTOR_ID,
      name: d.scopeSupplierName ?? "",
      ...(md.jurisdiction ? { country: md.jurisdiction } : {}),
      ...(md.lei ? { identifiers: { lei: md.lei } } : {}),
    };
  });
  const uids = await resolveDraftEntities(inputs);
  return drafts.map((d, i) => (uids[i] ? { ...d, entityUid: uids[i]! } : d));
}

export const gleifLeiCollector: IntelligenceCollector<typeof gleifSignalSchema> = {
  id: GLEIF_LEI_COLLECTOR_ID,
  name: "GLEIF Legal Entity Identifier Registry",
  description:
    "Pulls the most recently updated GLEIF Level-1 records via the public LEI API and emits entity_registry MarketSignals (LEI in scope_sku, registration-status code in value). One draft per record.",
  posture: "public-api",
  sourceUrl: "https://www.gleif.org/",
  defaultRateLimitRpm: 60,
  defaultScheduleCron: "0 5 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "GLOBAL",
  retentionDays: 1095,
  tenantOptInDefault: true,
  signalSchema: gleifSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(GLEIF_LEI_COLLECTOR_ID, draft);
  },
  async collect(): Promise<MarketSignalDraft[]> {
    return (await this.collectWithRaw!({ since: null })).drafts;
  },
  async collectWithRaw(): Promise<CollectWithRawResult> {
    const r = await fetchGleifPage(1, GLEIF_DEFAULT_PAGE_SIZE);
    const drafts = parseGleifResponse(r.parsed);
    const enriched = await attachGleifEntityUids(drafts);
    const rawPayloads: RawPayload[] = [
      {
        name: "gleif-lei-page-1",
        contentType: "application/vnd.api+json",
        body: r.body,
        sourceUrl: r.url,
        metadata: { page: 1, pageSize: GLEIF_DEFAULT_PAGE_SIZE },
      },
    ];
    return { drafts: enriched, rawPayloads };
  },
};

/**
 * Backfill helper — paginates up to `maxPages` and accumulates drafts.
 * Default ceiling keeps even an admin-triggered backfill at < 5k rows.
 */
export async function fetchGleifBackfillDrafts(opts?: {
  maxPages?: number;
  pageSize?: number;
}): Promise<{
  drafts: MarketSignalDraft[];
  pagesFetched: number;
}> {
  const pageSize = opts?.pageSize ?? GLEIF_DEFAULT_PAGE_SIZE;
  const maxPages = opts?.maxPages ?? 25;
  const drafts: MarketSignalDraft[] = [];
  let page = 1;
  while (page <= maxPages) {
    const response = await fetchGleifPage(page, pageSize);
    const pageDrafts = parseGleifResponse(response.parsed);
    if (pageDrafts.length === 0) break;
    for (const d of pageDrafts) drafts.push(d);
    const lastPage = response.parsed.meta?.pagination?.lastPage ?? page;
    if (page >= lastPage) break;
    page++;
  }
  const enriched = await attachGleifEntityUids(drafts);
  return { drafts: enriched, pagesFetched: page };
}
