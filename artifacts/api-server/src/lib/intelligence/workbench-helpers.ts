/**
 * Pure helpers shared by the Collector Workbench routes.
 *
 * Pulled out of `collectors.ts` so the route handler stays small and
 * the helpers can be smoke-tested in isolation against the in-memory
 * registry (no DB).
 */

import { LEGACY_POSTURE_TO_CLASS } from "@workspace/intelligence";

import type { IntelligenceCollector } from "./collector";
import { getCollector, listRegisteredCollectorIds } from "./runtime";
import {
  getWorkbenchMeta,
  type CollectorWorkbenchMeta,
} from "./workbench-meta";

/**
 * Map the in-memory collector registry to a uniform shape that picks
 * up both the contract metadata and the workbench-only supplements.
 * Returns one entry per registered collector — DB rows are layered on
 * top later by `collectors.ts`.
 */
export function listRegisteredWorkbenchEntries(): Array<{
  collector: IntelligenceCollector;
  meta: CollectorWorkbenchMeta;
}> {
  return listRegisteredCollectorIds()
    .map((id) => ({
      collector: getCollector(id)!,
      meta: getWorkbenchMeta(id),
    }))
    .filter((entry) => entry.collector !== undefined);
}

/**
 * Resolve the canonical posture class for a collector. Prefers the
 * contract field (added in the Foundation task) and falls back to the
 * legacy posture map for safety, in case a future collector skips
 * declaring `postureClass`.
 */
export function resolvePostureClass(
  collector: Pick<IntelligenceCollector, "postureClass" | "posture">,
): "public_api" | "tos_restricted" | "gray_hat" {
  if (collector.postureClass) return collector.postureClass;
  return LEGACY_POSTURE_TO_CLASS[collector.posture] ?? "tos_restricted";
}

/**
 * Compose the static lineage graph: collectors → BQ tables → marts →
 * lever / fusion-center consumer panes. Built from the in-memory
 * registry plus the workbench metadata file. Re-built on every call
 * (cheap — half a dozen collectors), so newly registered collectors
 * appear without a server restart.
 */
export function buildLineageGraph(): {
  collectors: Array<{
    id: string;
    name: string;
    postureClass: "public_api" | "tos_restricted" | "gray_hat";
    disclosureTier: "T1" | "T2" | "T3" | "T4";
  }>;
  bqTables: string[];
  marts: string[];
  consumers: string[];
  edges: Array<{
    from: string;
    to: string;
    kind: "collector_to_table" | "table_to_mart" | "mart_to_consumer";
  }>;
} {
  const collectors: Array<{
    id: string;
    name: string;
    postureClass: "public_api" | "tos_restricted" | "gray_hat";
    disclosureTier: "T1" | "T2" | "T3" | "T4";
  }> = [];
  const bqTables = new Set<string>();
  const marts = new Set<string>();
  const consumers = new Set<string>();
  const edges: Array<{
    from: string;
    to: string;
    kind: "collector_to_table" | "table_to_mart" | "mart_to_consumer";
  }> = [];

  for (const { collector, meta } of listRegisteredWorkbenchEntries()) {
    collectors.push({
      id: collector.id,
      name: collector.name,
      postureClass: resolvePostureClass(collector),
      disclosureTier: collector.disclosureTier ?? "T1",
    });
    for (const tbl of meta.downstreamBqTables) {
      bqTables.add(tbl);
      edges.push({
        from: collector.id,
        to: tbl,
        kind: "collector_to_table",
      });
    }
    for (const mart of meta.downstreamMarts) {
      marts.add(mart);
      // Marts read from `market_signals` by convention.
      edges.push({
        from: "market_signals",
        to: mart,
        kind: "table_to_mart",
      });
    }
    for (const consumer of meta.downstreamConsumers) {
      consumers.add(consumer);
      for (const mart of meta.downstreamMarts) {
        edges.push({
          from: mart,
          to: consumer,
          kind: "mart_to_consumer",
        });
      }
    }
  }

  // Edge dedupe — the bipartite collector→table fan-out can repeat
  // (every collector writes to `market_signals`); same for mart→consumer.
  const seen = new Set<string>();
  const dedupedEdges = edges.filter((e) => {
    const key = `${e.kind}::${e.from}->${e.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    collectors,
    bqTables: Array.from(bqTables).sort(),
    marts: Array.from(marts).sort(),
    consumers: Array.from(consumers).sort(),
    edges: dedupedEdges,
  };
}

/**
 * Compute a 0-100 health score for a collector's audit-log window.
 * Heuristic: 100 minus the fraction of failed/error events vs total.
 * Gives 100 when there is no traffic at all (treated as "no news =
 * no problem" rather than 0, which would be alarming for cold sources).
 */
export function computeHealthScore(args: {
  runs: number;
  failures: number;
  fetchErrors: number;
}): number {
  const denom = args.runs + args.fetchErrors;
  if (denom === 0) return 100;
  const bad = args.failures + args.fetchErrors;
  const score = 100 - Math.round((bad / denom) * 100);
  return Math.max(0, Math.min(100, score));
}

/**
 * Tier-disclosure policy for the client-facing `/data-sources` view.
 *
 *  * T1, T2 → fully named in the response
 *  * T3     → never named individually; collapsed into one summary entry
 *  * T4     → never disclosed at all
 *
 * Pulled into a pure helper so the policy can be unit-tested without
 * spinning up the database. The route handler still owns the projection
 * to the wire shape; this helper just answers "given a tier, what does
 * the tenant get to see?".
 */
export function classifyDataSourceVisibility(
  tier: "T1" | "T2" | "T3" | "T4",
): "named" | "summarised" | "hidden" {
  if (tier === "T1" || tier === "T2") return "named";
  if (tier === "T3") return "summarised";
  return "hidden";
}
