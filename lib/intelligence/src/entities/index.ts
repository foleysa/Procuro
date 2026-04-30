/**
 * Entity-resolution v0.
 *
 * Public surface:
 *   `resolveEntity({ name, country?, identifiers? }) → ResolvedEntity`
 *
 * Resolution order:
 *   1. **Identifier match.** A non-empty LEI / CIK / EIN / Companies House
 *      number / UEI / ticker is treated as authoritative — exact match
 *      against the BQ `entities` table returns confidence 0.99.
 *   2. **Deterministic name + country.** Both fields are normalised
 *      (lowercase, strip legal suffixes, collapse whitespace) and looked
 *      up. Confidence 0.85.
 *   3. **Fuzzy fallback.** When neither of the above matches, we compose
 *      a Gemini-2.5-Flash prompt against the candidate pool and accept
 *      the model's best match if its confidence exceeds the threshold.
 *      Confidence is whatever the model returned (capped at 0.75 to
 *      prevent fuzzy matches from outranking deterministic ones).
 *
 * Resolutions are cached in the Postgres `entity_resolution_cache` table
 * keyed on a canonicalised query. The cache is the hot read path —
 * lever analyzers calling resolveEntity repeatedly during a cycle hit
 * Postgres, not BQ or Gemini. The cache row stores the canonical
 * `entity_uid`, the matching strategy used, and the time of resolution
 * for audit.
 *
 * Without GCP creds (BQ unavailable) the resolver still returns a
 * deterministic identifier-keyed `entity_uid` so unit tests can exercise
 * the contract without standing up BQ. Name-only and fuzzy paths return
 * `{ entity_uid: null, match_type: "unresolved" }`.
 */

import { db, entityResolutionCacheTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getBigQueryClient } from "../bq/index.js";
import { resolveIntelligenceConfig } from "../config.js";

export type IdentifierKind =
  | "lei"
  | "ein"
  | "cik"
  | "companies_house"
  | "uei"
  | "ticker";

export type Identifiers = Partial<Record<IdentifierKind, string>>;

export interface ResolveEntityArgs {
  name: string;
  country?: string;
  identifiers?: Identifiers;
}

export type MatchType =
  | "identifier"
  | "deterministic_name"
  | "fuzzy_gemini"
  | "unresolved";

export interface ResolvedEntity {
  entity_uid: string | null;
  confidence: number;
  match_type: MatchType;
  cached: boolean;
}

/**
 * Strip common legal-form suffixes, punctuation, and collapse whitespace
 * for a deterministic name+country lookup. Pure function so it can be
 * unit-tested without a database.
 */
export function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(
      /\b(inc|incorporated|corp|corporation|llc|ltd|limited|plc|sa|ag|gmbh|nv|bv|sarl|kk|kabushiki kaisha|holdings?|company|co)\b\.?/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normaliseIdentifier(kind: IdentifierKind, raw: string): string {
  const v = raw.trim().toUpperCase();
  if (kind === "lei") return v.replace(/[^A-Z0-9]/g, "").slice(0, 20);
  if (kind === "cik") return v.replace(/[^0-9]/g, "");
  return v.replace(/\s+/g, "");
}

/**
 * Build the canonical cache key. Identifier matches are unambiguous so
 * the key is just the kind + value; name+country queries fall through
 * to the normalised composite.
 */
export function buildCacheKey(args: ResolveEntityArgs): string {
  if (args.identifiers) {
    const order: IdentifierKind[] = [
      "lei",
      "cik",
      "companies_house",
      "ein",
      "uei",
      "ticker",
    ];
    for (const k of order) {
      const v = args.identifiers[k];
      if (v && v.trim() !== "") {
        return `id:${k}:${normaliseIdentifier(k, v)}`;
      }
    }
  }
  const name = normaliseName(args.name);
  const country = (args.country ?? "").trim().toUpperCase();
  return `name:${country}:${name}`;
}

/** Stable, deterministic UID for an identifier-only resolution. */
export function deterministicUidFromIdentifier(
  kind: IdentifierKind,
  value: string,
): string {
  return `ent_${kind}_${normaliseIdentifier(kind, value).toLowerCase()}`;
}

interface CacheRowShape {
  entityUid: string;
  confidence: string;
  matchType: string;
}

async function readCache(key: string): Promise<CacheRowShape | null> {
  try {
    const [row] = await db
      .select()
      .from(entityResolutionCacheTable)
      .where(eq(entityResolutionCacheTable.queryKey, key))
      .limit(1);
    return row
      ? {
          entityUid: row.entityUid,
          confidence: row.confidence,
          matchType: row.matchType,
        }
      : null;
  } catch {
    // The cache is best-effort. A missing table during early bootstrap
    // shouldn't break the resolver — just skip caching.
    return null;
  }
}

async function writeCache(args: {
  key: string;
  entity_uid: string;
  confidence: number;
  match_type: MatchType;
}): Promise<void> {
  try {
    await db
      .insert(entityResolutionCacheTable)
      .values({
        id: `erc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
        queryKey: args.key,
        entityUid: args.entity_uid,
        confidence: args.confidence.toFixed(4),
        matchType: args.match_type,
      })
      .onConflictDoUpdate({
        target: entityResolutionCacheTable.queryKey,
        set: {
          entityUid: args.entity_uid,
          confidence: args.confidence.toFixed(4),
          matchType: args.match_type,
          resolvedAt: new Date(),
        },
      });
  } catch {
    // Best effort.
  }
}

/**
 * Look up a single entity by an identifier in the BQ `entities` table.
 * Returns `null` when BQ isn't configured or no row matched.
 */
async function lookupByIdentifier(
  kind: IdentifierKind,
  value: string,
): Promise<{ entity_uid: string } | null> {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  const bq = await getBigQueryClient();
  if (!bq) return null;
  const fq = `\`${cfg.projectId}.${cfg.bqDataset}.entities\``;
  // BQ struct dotted access — `identifiers.lei`, etc.
  const [rows] = (await bq.query({
    query: `SELECT entity_uid FROM ${fq} WHERE identifiers.${kind} = @v LIMIT 1`,
    params: { v: normaliseIdentifier(kind, value) },
    maximumBytesBilled: String(cfg.maxBytesBilled),
    location: cfg.bqLocation,
  })) as [Array<{ entity_uid: string }>];
  return rows[0] ?? null;
}

async function lookupByDeterministicName(
  name: string,
  country: string,
): Promise<{ entity_uid: string } | null> {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  const bq = await getBigQueryClient();
  if (!bq) return null;
  const fq = `\`${cfg.projectId}.${cfg.bqDataset}.entities\``;
  const [rows] = (await bq.query({
    query: `
      SELECT entity_uid FROM ${fq}
      WHERE LOWER(REGEXP_REPLACE(primary_name, '[^a-zA-Z0-9]+', ' ')) = @n
        AND COALESCE(country, '') = @c
      LIMIT 1
    `,
    params: { n: name, c: country },
    maximumBytesBilled: String(cfg.maxBytesBilled),
    location: cfg.bqLocation,
  })) as [Array<{ entity_uid: string }>];
  return rows[0] ?? null;
}

/**
 * Resolve an entity. Identifier-keyed lookups are deterministic and
 * always returnable even without BQ; the name + fuzzy paths require BQ
 * (and Gemini for fuzzy) to be configured.
 *
 * The fuzzy path is intentionally a stub here: it logs the gap and
 * returns `unresolved` rather than calling Gemini, since:
 *   (a) Gemini access is task-Φ + integration-bound,
 *   (b) every downstream caller already handles `unresolved` cleanly.
 *
 * A follow-up task wires the actual Gemini call.
 */
export async function resolveEntity(
  args: ResolveEntityArgs,
): Promise<ResolvedEntity> {
  const cacheKey = buildCacheKey(args);
  const cached = await readCache(cacheKey);
  if (cached) {
    return {
      entity_uid: cached.entityUid,
      confidence: Number(cached.confidence),
      match_type: cached.matchType as MatchType,
      cached: true,
    };
  }

  // Identifier-priority order
  if (args.identifiers) {
    const order: IdentifierKind[] = [
      "lei",
      "cik",
      "companies_house",
      "ein",
      "uei",
      "ticker",
    ];
    for (const kind of order) {
      const v = args.identifiers[kind];
      if (!v || v.trim() === "") continue;
      const bqHit = await lookupByIdentifier(kind, v);
      const entity_uid = bqHit?.entity_uid ?? deterministicUidFromIdentifier(kind, v);
      const result: ResolvedEntity = {
        entity_uid,
        confidence: 0.99,
        match_type: "identifier",
        cached: false,
      };
      await writeCache({
        key: cacheKey,
        entity_uid,
        confidence: result.confidence,
        match_type: result.match_type,
      });
      return result;
    }
  }

  // Deterministic name + country
  const country = (args.country ?? "").trim().toUpperCase();
  const name = normaliseName(args.name);
  if (name.length > 0 && country.length > 0) {
    const hit = await lookupByDeterministicName(name, country);
    if (hit) {
      const result: ResolvedEntity = {
        entity_uid: hit.entity_uid,
        confidence: 0.85,
        match_type: "deterministic_name",
        cached: false,
      };
      await writeCache({
        key: cacheKey,
        entity_uid: hit.entity_uid,
        confidence: result.confidence,
        match_type: result.match_type,
      });
      return result;
    }
  }

  // Fuzzy fallback. Requires both BQ (for the candidate pool) and Gemini
  // (for the match call). When either is missing we cleanly return
  // `unresolved` so the caller stays on the deterministic / cached path.
  const fuzzy = await fuzzyResolveWithGemini(args);
  if (fuzzy) {
    await writeCache({
      key: cacheKey,
      entity_uid: fuzzy.entity_uid!,
      confidence: fuzzy.confidence,
      match_type: fuzzy.match_type,
    });
    return fuzzy;
  }

  return {
    entity_uid: null,
    confidence: 0,
    match_type: "unresolved",
    cached: false,
  };
}

/** Minimum confidence we'll accept from the model. Tuned conservatively
 *  so fuzzy matches never outrank deterministic name (0.85) or
 *  identifier (0.99) confidences in downstream lever rollups. */
const FUZZY_GEMINI_MIN_CONFIDENCE = 0.6;
/** Hard cap on the fuzzy confidence regardless of what the model claims.
 *  Keeps the partial-order property: identifier > deterministic > fuzzy. */
const FUZZY_GEMINI_MAX_CONFIDENCE = 0.75;
/** How many candidate entities we ask BQ to score before composing the
 *  prompt. Capped so prompt size + BQ scan stay bounded. */
const FUZZY_CANDIDATE_LIMIT = 25;

interface FuzzyCandidate {
  entity_uid: string;
  primary_name: string;
  country: string | null;
}

/**
 * Pull a small candidate pool from the BQ `entities` table using a
 * cheap token-overlap heuristic on the normalised name. Returns at most
 * `FUZZY_CANDIDATE_LIMIT` rows; an empty result means the resolver
 * should give up and emit `unresolved`.
 *
 * Token-overlap (rather than `LIKE %x%`) keeps the BQ scan amenable to
 * the search-index optimisation in BigQuery and avoids missing matches
 * where suffix words differ ("Renault SA" vs "Renault Group").
 */
async function fetchFuzzyCandidates(
  args: ResolveEntityArgs,
): Promise<FuzzyCandidate[]> {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return [];
  const bq = await getBigQueryClient();
  if (!bq) return [];
  const fq = `\`${cfg.projectId}.${cfg.bqDataset}.entities\``;
  const tokens = normaliseName(args.name).split(" ").filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  const country = (args.country ?? "").trim().toUpperCase();
  const [rows] = (await bq.query({
    query: `
      WITH norm AS (
        SELECT entity_uid,
               primary_name,
               country,
               LOWER(REGEXP_REPLACE(primary_name, '[^a-zA-Z0-9]+', ' ')) AS n
        FROM ${fq}
        ${country ? "WHERE COALESCE(country, '') IN ('', @country)" : ""}
      )
      SELECT entity_uid, primary_name, country
      FROM norm
      WHERE EXISTS (
        SELECT 1 FROM UNNEST(@tokens) t WHERE STRPOS(n, t) > 0
      )
      LIMIT @lim
    `,
    params: country
      ? { country, tokens, lim: FUZZY_CANDIDATE_LIMIT }
      : { tokens, lim: FUZZY_CANDIDATE_LIMIT },
    types: country
      ? { country: "STRING", tokens: ["STRING"], lim: "INT64" }
      : { tokens: ["STRING"], lim: "INT64" },
    maximumBytesBilled: String(cfg.maxBytesBilled),
    location: cfg.bqLocation,
  })) as [FuzzyCandidate[]];
  return rows;
}

/**
 * Call Gemini-2.5-flash via the Replit AI Integrations proxy to pick
 * the best candidate. Uses a JSON-mode response so we never have to
 * parse free-form text. Returns `null` when:
 *   - GCP / BQ creds are missing (no candidate pool to score),
 *   - Gemini env vars are missing (proxy not provisioned),
 *   - the model returns no parseable JSON,
 *   - the model's confidence falls below FUZZY_GEMINI_MIN_CONFIDENCE.
 *
 * In every "null" case the caller falls back to `unresolved` rather
 * than failing the resolution — fuzzy matching is best-effort.
 */
async function fuzzyResolveWithGemini(
  args: ResolveEntityArgs,
): Promise<ResolvedEntity | null> {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const candidates = await fetchFuzzyCandidates(args);
  if (candidates.length === 0) return null;

  const prompt = [
    "You match a company name to one of the listed candidates.",
    "Respond ONLY with strict JSON of the form:",
    '{"entity_uid": "<uid from list, or null>", "confidence": <0..1 number>}',
    "Use confidence > 0.7 only when the match is unambiguous (same legal entity).",
    "Use confidence 0 and entity_uid null when none of the candidates match.",
    "",
    `Query name: ${args.name}`,
    args.country ? `Query country: ${args.country}` : "",
    "",
    "Candidates:",
    ...candidates.map(
      (c, i) =>
        `${i + 1}. uid=${c.entity_uid} name=${JSON.stringify(c.primary_name)} country=${JSON.stringify(c.country ?? "")}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");

  const url = `${baseUrl.replace(/\/$/, "")}/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  let parsed: { entity_uid: string | null; confidence: number } | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 256,
          responseMimeType: "application/json",
        },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    parsed = JSON.parse(text) as {
      entity_uid: string | null;
      confidence: number;
    };
  } catch {
    return null;
  }

  if (!parsed) return null;
  if (!parsed.entity_uid) return null;
  // Reject UIDs the model invented — must come from the candidate pool.
  if (!candidates.some((c) => c.entity_uid === parsed!.entity_uid)) return null;
  if (typeof parsed.confidence !== "number") return null;
  if (parsed.confidence < FUZZY_GEMINI_MIN_CONFIDENCE) return null;
  const confidence = Math.min(parsed.confidence, FUZZY_GEMINI_MAX_CONFIDENCE);

  return {
    entity_uid: parsed.entity_uid,
    confidence,
    match_type: "fuzzy_gemini",
    cached: false,
  };
}
