/**
 * OpenSanctions collector — broader risk corpus (PEPs, debarments,
 * sanctions, watchlists, criminal-enforcement records).
 *
 * Pulls the OpenSanctions "default" dataset bulk export — newline-
 * delimited JSON of FollowTheMoney entities — from
 *   https://data.opensanctions.org/datasets/latest/default/entities.ftm.json
 *
 * Each line is one entity (Person / Organization / Company / Vessel)
 * with topics (e.g. `sanction`, `role.pep`, `crime.fraud`,
 * `debarment`). We emit one `risk_screening_match` MarketSignal per
 * entity, with the topic list captured in metadata.
 *
 * Posture: `public_api`, tier `T2`. OpenSanctions is CC-BY licensed,
 * fully attributable; we cite the dataset URL.
 *
 * Cap: hard ceiling at `OPENSANCTIONS_MAX_ENTITIES_PER_RUN` rows per
 * run to keep the round trip cheap. The full default dataset is
 * ~1.2M entities — way too many to ingest per scheduled tick. The
 * backfill route lifts the cap.
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

export const OPENSANCTIONS_COLLECTOR_ID = "opensanctions";

const OPENSANCTIONS_DEFAULT_URL =
  "https://data.opensanctions.org/datasets/latest/default/entities.ftm.json";

export const OPENSANCTIONS_MAX_ENTITIES_PER_RUN = 1000;

/**
 * Subset of FollowTheMoney entity shape we read. OpenSanctions emits
 * arrays for every property; we take the first non-empty value.
 */
export interface FtmEntity {
  id: string;
  schema?: string;
  caption?: string;
  properties?: {
    name?: string[];
    country?: string[];
    topics?: string[];
    leiCode?: string[];
    classification?: string[];
    program?: string[];
    modifiedAt?: string[];
    sourceUrl?: string[];
    weakAlias?: string[];
    notes?: string[];
  };
  referents?: string[];
  datasets?: string[];
  first_seen?: string;
  last_seen?: string;
}

function firstString(arr?: string[]): string | null {
  if (!Array.isArray(arr)) return null;
  for (const v of arr) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Map FollowTheMoney schema names to a coarse numeric class so the
 * `value` column can be used directly for analyzer pivots.
 */
export const FTM_SCHEMA_CLASS: Record<string, number> = {
  Person: 1,
  Organization: 2,
  Company: 3,
  PublicBody: 4,
  Vessel: 5,
  Airplane: 6,
  Position: 7,
  CryptoWallet: 8,
};

/** Parse one JSONL line into a draft, or null for unusable rows. */
export function parseOpenSanctionsLine(line: string): MarketSignalDraft | null {
  if (!line.trim()) return null;
  let entity: FtmEntity;
  try {
    entity = JSON.parse(line) as FtmEntity;
  } catch {
    return null;
  }
  if (!entity.id) return null;
  const name =
    firstString(entity.properties?.name) ?? entity.caption ?? null;
  if (!name) return null;
  const topics = entity.properties?.topics ?? [];
  const country = firstString(entity.properties?.country);
  const lei = firstString(entity.properties?.leiCode);
  const program = firstString(entity.properties?.program);
  const lastSeen =
    firstString(entity.properties?.modifiedAt) ??
    entity.last_seen ??
    entity.first_seen ??
    null;
  const observedAt = lastSeen ? new Date(lastSeen) : new Date();
  if (Number.isNaN(observedAt.getTime())) return null;
  const value = FTM_SCHEMA_CLASS[entity.schema ?? "Organization"] ?? 0;
  return {
    signalType: "risk_screening_match",
    scopeSupplierName: name,
    scopeSku: entity.id,
    scopeLaneKey: country ?? undefined,
    value,
    unit: "ftm_class",
    currency: "USD",
    observedAt,
    sourceUrl:
      firstString(entity.properties?.sourceUrl) ??
      `https://www.opensanctions.org/entities/${entity.id}/`,
    confidence: 0.92,
    // entityUid is populated by the collector's resolver pass when an
    // LEI is present; when no LEI is present we fall back to a stable
    // dataset-scoped synthetic uid so cross-source joins still group
    // multiple appearances of the same OpenSanctions entity.
    entityUid: lei ? null : `ent_opensanctions_${entity.id}`,
    metadata: {
      openSanctionsId: entity.id,
      schema: entity.schema ?? null,
      topics,
      country,
      lei,
      program,
      datasets: entity.datasets ?? [],
      referents: entity.referents ?? [],
    },
  };
}

/**
 * Parse a whole JSONL body. Stops after `cap` valid drafts. The runtime
 * collector uses `OPENSANCTIONS_MAX_ENTITIES_PER_RUN`; tests pass small
 * caps to keep them fast.
 */
export function parseOpenSanctionsJsonl(
  body: string,
  cap: number = OPENSANCTIONS_MAX_ENTITIES_PER_RUN,
): MarketSignalDraft[] {
  const drafts: MarketSignalDraft[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (drafts.length >= cap) break;
    const d = parseOpenSanctionsLine(line);
    if (d) drafts.push(d);
  }
  return drafts;
}

const opensanctionsMetadataSchema = z
  .object({
    openSanctionsId: z.string().min(1),
    schema: z.string().nullable(),
    topics: z.array(z.string()),
    country: z.string().nullable(),
    lei: z.string().nullable(),
    program: z.string().nullable(),
    datasets: z.array(z.string()),
    referents: z.array(z.string()),
  })
  .passthrough();

const opensanctionsSignalSchema = buildSignalDraftSchema(
  opensanctionsMetadataSchema,
);

export const opensanctionsCollector: IntelligenceCollector<typeof opensanctionsSignalSchema> = {
  id: OPENSANCTIONS_COLLECTOR_ID,
  name: "OpenSanctions Default Dataset",
  description:
    "Streams the OpenSanctions default JSONL bulk export and emits one risk_screening_match MarketSignal per entity (sanctioned parties, PEPs, debarments, criminal-enforcement records). Capped at OPENSANCTIONS_MAX_ENTITIES_PER_RUN rows per scheduled tick; backfill route lifts the cap.",
  posture: "public-api",
  sourceUrl: "https://www.opensanctions.org/",
  defaultRateLimitRpm: 2,
  // Daily refresh — OpenSanctions rebuilds the default dataset every
  // ~24h.
  defaultScheduleCron: "15 4 * * *",
  postureClass: "public_api",
  disclosureTier: "T2",
  jurisdiction: "GLOBAL",
  retentionDays: 730,
  tenantOptInDefault: false,
  signalSchema: opensanctionsSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(OPENSANCTIONS_COLLECTOR_ID, draft);
  },
  async collect({ signal } = { since: null }): Promise<MarketSignalDraft[]> {
    return (await this.collectWithRaw!({ since: null, signal })).drafts;
  },
  async collectWithRaw({ signal } = { since: null }): Promise<CollectWithRawResult> {
    const res = await fetch(OPENSANCTIONS_DEFAULT_URL, { signal });
    if (!res.ok) {
      throw new Error(`OpenSanctions HTTP ${res.status}`);
    }
    const body = await res.text();
    const drafts = parseOpenSanctionsJsonl(
      body,
      OPENSANCTIONS_MAX_ENTITIES_PER_RUN,
    );
    const enriched = await attachOpenSanctionsEntityUids(drafts);
    const rawPayloads: RawPayload[] = [
      {
        // Cap landed bytes at the parsed window — the full JSONL is
        // ~1.2M lines and we never reparse beyond cap, so the rest is
        // not replay-relevant.
        name: "opensanctions-default-window",
        contentType: "application/x-ndjson",
        body: trimToEntityWindow(body, OPENSANCTIONS_MAX_ENTITIES_PER_RUN),
        sourceUrl: OPENSANCTIONS_DEFAULT_URL,
        metadata: {
          cap: OPENSANCTIONS_MAX_ENTITIES_PER_RUN,
          totalBytesUpstream: body.length,
        },
      },
    ];
    return { drafts: enriched, rawPayloads };
  },
};

/** Trim the JSONL body to roughly the first `cap` non-empty lines so
 *  the GCS landed copy only contains the rows the parser kept. */
function trimToEntityWindow(body: string, cap: number): string {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    out.push(line);
    if (out.length >= cap) break;
  }
  return out.join("\n");
}

async function attachOpenSanctionsEntityUids(
  drafts: MarketSignalDraft[],
): Promise<MarketSignalDraft[]> {
  // Only resolve drafts whose parser left entityUid null — those are
  // the ones with an LEI we can hand to Foundation. Drafts that
  // already have a synthetic ent_opensanctions_* uid are passed
  // through (no LEI, no resolver-known identifier).
  const idxToResolve: number[] = [];
  const inputs: Array<{
    collectorId: string;
    name: string;
    country?: string;
    identifiers?: Record<string, string>;
  }> = [];
  drafts.forEach((d, i) => {
    if (d.entityUid != null) return;
    const md = (d.metadata ?? {}) as { lei?: string | null; country?: string | null };
    if (!md.lei) return;
    idxToResolve.push(i);
    inputs.push({
      collectorId: OPENSANCTIONS_COLLECTOR_ID,
      name: d.scopeSupplierName ?? "",
      ...(md.country ? { country: md.country } : {}),
      identifiers: { lei: md.lei },
    });
  });
  if (inputs.length === 0) return drafts;
  const uids = await resolveDraftEntities(inputs);
  const out = drafts.slice();
  idxToResolve.forEach((origIdx, k) => {
    const uid = uids[k];
    if (uid) out[origIdx] = { ...out[origIdx]!, entityUid: uid };
  });
  return out;
}

/** Backfill — lifts the per-run cap (caller controls it). */
export async function fetchOpenSanctionsBackfillDrafts(opts?: {
  cap?: number;
}): Promise<{ drafts: MarketSignalDraft[]; sourceUrl: string }> {
  const res = await fetch(OPENSANCTIONS_DEFAULT_URL);
  if (!res.ok) throw new Error(`OpenSanctions HTTP ${res.status}`);
  const body = await res.text();
  return {
    drafts: parseOpenSanctionsJsonl(body, opts?.cap ?? Number.MAX_SAFE_INTEGER),
    sourceUrl: OPENSANCTIONS_DEFAULT_URL,
  };
}
