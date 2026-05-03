import { pool } from "@workspace/db";

/**
 * Layer D — at-request suggestions for the admin routing queue.
 *
 * For every open queue entry, propose the top-N most likely canonical
 * codes the operator might want to map the tenant string to. Suggestions
 * come from three signals, all computed in a single Postgres query:
 *
 *   1. Trigram similarity of the queued `normalized` string against
 *      every active `synonym_registry.normalized`. The matched row's
 *      `canonical_code` is the candidate.
 *   2. Trigram similarity against the canonical procurement code itself
 *      (lower(replace(category_code,'_',' '))). This catches strings
 *      where no synonym exists yet but the tenant string is close to
 *      the code spelling (e.g. "iron and steel" → IRON_STEEL).
 *   3. Cross-tenant tenant_scoped synonyms (rows from OTHER orgs at
 *      `scope='tenant_scoped'`) get a small confidence boost — another
 *      operator already vouched for that mapping in their own tenant,
 *      so it's a strong signal.
 *
 * Suggestions are computed at request time. There is no precomputed
 * table or background job in v1 — admin queue reads are infrequent
 * enough and the trigram GIN index keeps the per-row cost bounded.
 *
 * `auto`-source synonym rows are deliberately excluded from the
 * candidate set, mirroring the Layer A resolver (`synonym.ts`) — those
 * rows are reserved for v2 self-learning and must not propagate
 * through the operator UI as if they were already approved mappings.
 */

export type SuggestionReason =
  | "tenant_synonym"
  | "global_synonym"
  | "cross_tenant_synonym"
  | "canonical_code_match";

export interface RoutingSuggestion {
  canonicalCode: string;
  /** 0..1 trigram similarity with optional small cross-tenant boost. */
  confidence: number;
  reason: SuggestionReason;
}

export interface SuggestCategoryMappingsArgs {
  orgId: string;
  queueIds: string[];
  /** How many suggestions to return per queue entry. Defaults to 3. */
  topN?: number;
  /**
   * Minimum trigram similarity for a candidate to be considered.
   * Defaults to 0.25 — below that, results are noise. Operators see
   * "no suggestions" rather than misleading low-confidence picks.
   */
  minSimilarity?: number;
}

/**
 * Compute top-N suggestions for a batch of queue entries. Returns a
 * map keyed by queue entry id; entries with no qualifying candidates
 * are omitted (callers should treat absence as "no suggestion").
 */
export async function suggestCategoryMappings(
  args: SuggestCategoryMappingsArgs,
): Promise<Map<string, RoutingSuggestion[]>> {
  const out = new Map<string, RoutingSuggestion[]>();
  if (args.queueIds.length === 0) return out;
  const topN = args.topN ?? 3;
  const minSim = args.minSimilarity ?? 0.25;

  // The cross-tenant boost is folded into `sim` BEFORE the per-queue
  // ROW_NUMBER() ranking so a marginally-better global match cannot
  // displace a strong cross-tenant operator-vouched match. Capped at 1
  // so the public confidence stays in [0, 1].
  const sql = `
    WITH q AS (
      SELECT id, normalized
        FROM unmapped_category_queue
       WHERE id = ANY($1::text[])
    ),
    syn_cand AS (
      SELECT q.id AS queue_id,
             s.canonical_code,
             LEAST(
               1.0,
               similarity(q.normalized, s.normalized) *
               CASE
                 WHEN s.scope = 'tenant_scoped'
                  AND s.org_id IS DISTINCT FROM $2 THEN 1.05
                 ELSE 1.0
               END
             ) AS sim,
             CASE
               WHEN s.scope = 'tenant_scoped' AND s.org_id = $2
                 THEN 'tenant_synonym'
               WHEN s.scope = 'tenant_scoped'
                 THEN 'cross_tenant_synonym'
               ELSE 'global_synonym'
             END AS reason
        FROM q
        JOIN synonym_registry s
          ON s.superseded_at IS NULL
         AND s.source IN ('seed', 'operator')
         AND similarity(q.normalized, s.normalized) >= $3
    ),
    code_cand AS (
      SELECT q.id AS queue_id,
             cb.category_code AS canonical_code,
             similarity(
               q.normalized,
               lower(replace(cb.category_code, '_', ' '))
             ) AS sim,
             'canonical_code_match' AS reason
        FROM q
        CROSS JOIN (
          SELECT DISTINCT category_code FROM category_bands
        ) cb
       WHERE similarity(
               q.normalized,
               lower(replace(cb.category_code, '_', ' '))
             ) >= $3
    ),
    all_cand AS (
      SELECT * FROM syn_cand
      UNION ALL
      SELECT * FROM code_cand
    ),
    -- Collapse duplicate (queue, canonical) candidates that came from
    -- multiple sources, keeping the highest-scoring one and the reason
    -- attached to it. Without DISTINCT ON, "iron & steel" routed via
    -- both a global synonym and a code-spelling match would consume two
    -- of the three suggestion slots.
    best AS (
      SELECT DISTINCT ON (queue_id, canonical_code)
             queue_id, canonical_code, sim, reason
        FROM all_cand
       ORDER BY queue_id, canonical_code, sim DESC
    ),
    ranked AS (
      SELECT queue_id, canonical_code, sim, reason,
             row_number() OVER (
               PARTITION BY queue_id
               ORDER BY sim DESC, canonical_code ASC
             ) AS rn
        FROM best
    )
    SELECT queue_id, canonical_code, sim, reason
      FROM ranked
     WHERE rn <= $4
     ORDER BY queue_id, sim DESC, canonical_code ASC
  `;

  const { rows } = await pool.query<{
    queue_id: string;
    canonical_code: string;
    sim: string | number;
    reason: SuggestionReason;
  }>(sql, [args.queueIds, args.orgId, minSim, topN]);

  for (const r of rows) {
    const list = out.get(r.queue_id) ?? [];
    list.push({
      canonicalCode: r.canonical_code,
      confidence: Number(r.sim),
      reason: r.reason,
    });
    out.set(r.queue_id, list);
  }
  return out;
}

/**
 * One-time bootstrap of the pg_trgm extension + the GIN trigram index
 * on `synonym_registry.normalized`. Idempotent — safe to call on every
 * server boot. Co-located with the routing layer because the
 * suggestions query is the only consumer.
 */
const TRGM_DDL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS synonym_registry_normalized_trgm_idx
  ON synonym_registry USING gin (normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS unmapped_queue_normalized_trgm_idx
  ON unmapped_category_queue USING gin (normalized gin_trgm_ops);
`;

let trgmBootstrapped = false;

export async function bootstrapTrigramSuggestions(): Promise<void> {
  if (trgmBootstrapped) return;
  await pool.query(TRGM_DDL);
  trgmBootstrapped = true;
}

/** Test-only: force re-bootstrap on next call. */
export function __resetTrigramBootstrap(): void {
  trgmBootstrapped = false;
}
