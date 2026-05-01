/**
 * Routing module — public API.
 *
 * THIS FILE IS THE ONLY EXPORT SURFACE. Modules outside
 * `artifacts/api-server/src/lib/intelligence/routing/` must import from
 * `./routing` (or `../routing`, `../../routing`, etc.) — never directly
 * from `./routing/synonym`, `./routing/queue`, etc.
 *
 * The `routing-boundary.test.ts` guardrail enforces this so the
 * routing layer can evolve without callers reaching past the surface.
 *
 * What lives behind this surface
 * ------------------------------
 *   - 4-layer category resolution (synonym → fragmented fallback →
 *     queue → learning) for tenant-supplied category strings
 *   - The `category × band × lever` truth tables and the
 *     `v_category_lever_mappings` materialized view
 *   - Operational health checks for routing drift
 *
 * What does NOT live here
 * -----------------------
 *   - Calibration / confidence weight learning lives in
 *     `lib/ooda/funnel.ts`
 *   - Canonical material/category code constants live in
 *     `lib/intelligence/scope-taxonomy.ts`
 */

// Layer A — synonym registry resolver
export { resolveSynonym } from "./synonym";

// Layer B/C — unmapped queue + operator resolution
export {
  enqueueUnmapped,
  listOpenQueue,
  summarizeQueue,
  resolveQueueEntry,
  countOpportunitiesByMappedVia,
  type QueueSummary,
  type ResolveResult,
  type ResolveSuccess,
  type ResolveCollision,
} from "./queue";

// Read-side queries against the materialized view
export {
  leversForCategory,
  categoriesForLever,
  isCanonicalCodeRouted,
  bandForCategory,
  leversInFragmentedFallback,
  suggestTierForCategoryLever,
  type LeversForCategoryRow,
  type CategoriesForLeverRow,
  type TierSuggestion,
  type SuggestTierResult,
} from "./queries";

// Materialized view bootstrap + refresh
export {
  bootstrapCategoryLeverMappings,
  refreshCategoryLeverMappings,
} from "./materialized-view";

// Bands constants
export { ALL_BANDS, FALLBACK_BAND, isBand } from "./bands";

// Health check
export {
  checkRoutingHealth,
  getRoutingHealthMetadata,
  type RoutingHealthReport,
  type DriftSample,
} from "./health";

// ── High-level resolver used by ingest paths ────────────────────────────────

import {
  resolveSynonym as _resolveSynonym,
} from "./synonym";
import { enqueueUnmapped as _enqueueUnmapped } from "./queue";
import {
  isCanonicalCodeRouted as _isCanonicalCodeRouted,
  bandForCategory as _bandForCategory,
} from "./queries";
import { FALLBACK_BAND as _FALLBACK_BAND } from "./bands";
import type { MappedVia, SynonymScope } from "@workspace/db";

export interface RouteCategoryResult {
  /**
   * The canonical procurement code the tenant string resolved to.
   * `null` when no synonym matched AND the string isn't already a
   * recognized canonical code — in that case the caller falls back to
   * the Fragmented band and tags the resulting opportunity
   * `mapped_via = 'unmapped_default'`.
   */
  canonicalCode: string | null;
  /**
   * Routing band the caller should treat the result as. On a hit this
   * is the canonical code's primary band assignment; on a miss this is
   * always `FALLBACK_BAND` ('fragmented') so callers get a deterministic
   * Layer-B answer without having to import band constants themselves.
   */
  band: string;
  /** Provenance to stamp on `opportunities.mapped_via`. */
  mappedVia: MappedVia;
  /** Scope of the synonym hit, when one occurred. */
  scope: SynonymScope | null;
  /** True if Layer A produced the answer. */
  matched: boolean;
}

/**
 * One-call routing for ingest paths: looks up the synonym registry
 * (Layer A) and, on miss, enqueues the string for operator review
 * (Layer B) returning the `unmapped_default` provenance so the caller
 * can still create an opportunity tagged accordingly.
 *
 * The caller is responsible for translating `canonicalCode` into a
 * `categories.id` (the materialized view + analyzers operate on
 * canonical codes; the ORM still wants a category row id).
 */
export async function routeTenantCategory(args: {
  orgId: string;
  tenantString: string;
  spendUsd?: number;
}): Promise<RouteCategoryResult> {
  const hit = await _resolveSynonym(args.orgId, args.tenantString);
  if (hit) {
    // Hit: report the canonical code's primary band so callers can
    // pre-filter levers without a follow-up query. Defensive: if the
    // canonical code somehow has no `category_bands` row (e.g. a
    // synonym was seeded for a code we haven't categorized yet), we
    // still fall back to FALLBACK_BAND rather than silently exposing
    // `null` and breaking the API contract.
    const band = (await _bandForCategory(hit.canonicalCode)) ?? _FALLBACK_BAND;
    return {
      canonicalCode: hit.canonicalCode,
      band,
      mappedVia: hit.mappedVia,
      scope: hit.scope,
      matched: true,
    };
  }
  // Layer B: enqueue + signal Fragmented fallback. The band is part of
  // the public API contract so analyzers can deterministically branch
  // on Layer-B fallthrough without re-deriving the fallback themselves.
  await _enqueueUnmapped({
    orgId: args.orgId,
    tenantString: args.tenantString,
    spendUsd: args.spendUsd,
  });
  return {
    canonicalCode: null,
    band: _FALLBACK_BAND,
    mappedVia: "unmapped_default",
    scope: null,
    matched: false,
  };
}

/**
 * Determine the `mapped_via` provenance value to stamp on a new
 * opportunity, given the canonical category code its draft refers to.
 *
 * Used by `lib/ooda/cycle.ts` at insert time so calibration can
 * exclude `unmapped_default` opportunities downstream.
 *
 *   - canonicalCode missing OR not in `category_bands`  → `unmapped_default`
 *   - canonical code present                            → `synonym_global`
 *
 * Tenant-scoped routing for cycle-time opportunities is not exposed
 * here in v1 because the cycle layer doesn't see the original tenant
 * string — only the resolved category row. Tenant-scoped provenance
 * still flows through ingest paths via `routeTenantCategory`.
 */
export async function determineOpportunityMappedVia(
  canonicalCode: string | null | undefined,
): Promise<MappedVia> {
  if (!canonicalCode) return "unmapped_default";
  const routed = await _isCanonicalCodeRouted(canonicalCode);
  return routed ? "synonym_global" : "unmapped_default";
}
