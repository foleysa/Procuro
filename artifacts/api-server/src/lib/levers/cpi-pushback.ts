/**
 * CPI pushback helper (#68).
 *
 * Given a tenant category and a supplier-implied price-ask %, returns a
 * structured CPI-context payload that can be appended to a contract
 * renegotiation lever's rationale, recommended action, and inputs.
 *
 * The supplier-implied ask is computed by the calling lever (e.g. the
 * "actual / baseline − 1" overrun rate on `contract_renegotiation_trigger`).
 * This helper is purely deterministic: it reads the most-recent and the
 * earliest in-window CPI signal for the matched scope code and returns a
 * directional comparison. **No LLM, no external lookup.**
 *
 * Returns `null` when:
 *   - the tenant category has no CPI mapping
 *   - there are fewer than 2 in-window observations for that scope
 *   - both endpoints are zero (avoids a divide-by-zero)
 *
 * Callers must treat `null` as "no pushback context, render the existing
 * rationale unchanged."
 *
 * Wire shape
 * ----------
 * The returned object is JSON-safe and intended to be persisted under
 * `inputs.cpiPushback` on the opportunity row, so the disclosure-tier
 * citation block can render it alongside other source descriptors.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  cpiScopeForCategoryCode,
  type CpiScopeCode,
} from "../intelligence/cpi-mapping";
import { getCollector } from "../intelligence/runtime";
import { collectorContract } from "../intelligence/collector";
import { buildInsightSource, type InsightSource } from "../insight-sources";

export interface CpiPushbackContext {
  /** Canonical CPI scope code matched off the tenant category. */
  cpiScopeCode: CpiScopeCode;
  /** % move in the CPI sub-index over the lookback window. */
  cpiMovePct: number;
  /** Supplier-implied ask % the caller fed in. */
  supplierAskPct: number;
  /**
   * Spread = supplierAskPct - cpiMovePct. Positive means the supplier
   * is asking for more than CPI — the buyer can defensibly push back.
   */
  spreadPct: number;
  /**
   * `support` — CPI moved at least as much as the ask (no pushback).
   * `pushback` — CPI moved less than the ask (push back recommended).
   * `cpi_decline` — CPI fell while the supplier is asking for an
   * increase (strongest pushback case).
   */
  verdict: "support" | "pushback" | "cpi_decline";
  /** Summary string ready to splice into the lever's rationale. */
  summary: string;
  /** Earliest in-window CPI value used. */
  earliestValue: number;
  /** Latest in-window CPI value used. */
  latestValue: number;
  earliestObservedAt: string;
  latestObservedAt: string;
  /** Lookback window the helper actually used. */
  lookbackDays: number;
  /** Disclosure-tier source descriptor for the latest CPI observation. */
  source: InsightSource | null;
}

interface CpiEndpointRow {
  earliest_value: string;
  latest_value: string;
  earliest_at: string;
  latest_at: string;
  observation_count: string;
  latest_collector_id: string;
  latest_source_url: string | null;
}

/**
 * Compute a CPI pushback context for the given tenant category and
 * supplier-implied price ask. Returns `null` if there is no CPI signal
 * to compare against (the lever should then leave its rationale alone).
 */
export async function computeCpiPushback(args: {
  orgId: string;
  /** The tenant `category.code` (case-insensitive) — see `cpi-mapping.ts`. */
  categoryCode: string | null | undefined;
  /** Supplier-implied % price ask. e.g. 8 means "asking for 8% more". */
  supplierAskPct: number;
  /** Defaults to 365 days — covers the standard YoY CPI compare. */
  lookbackDays?: number;
}): Promise<CpiPushbackContext | null> {
  const lookbackDays = Math.max(30, Math.round(args.lookbackDays ?? 365));
  const cpiScope = cpiScopeForCategoryCode(args.categoryCode);
  if (!cpiScope) return null;

  const rows = (await db.execute(sql`
    WITH window_signals AS (
      SELECT ms.value::numeric AS value,
             ms.observed_at,
             ms.collector_id,
             ms.source_url
      FROM market_signals ms
      WHERE ms.signal_type = 'economic_index'
        AND ms.scope_category_code = ${cpiScope}
        AND ms.observed_at >= NOW() - make_interval(days => ${lookbackDays})
        AND (ms.org_id IS NULL OR ms.org_id = ${args.orgId})
    )
    SELECT (array_agg(value ORDER BY observed_at ASC))[1]::text AS earliest_value,
           (array_agg(value ORDER BY observed_at DESC))[1]::text AS latest_value,
           MIN(observed_at)::text AS earliest_at,
           MAX(observed_at)::text AS latest_at,
           COUNT(*)::text         AS observation_count,
           (array_agg(collector_id ORDER BY observed_at DESC))[1] AS latest_collector_id,
           (array_agg(source_url ORDER BY observed_at DESC))[1] AS latest_source_url
    FROM window_signals
    HAVING COUNT(*) >= 2
  `)).rows as unknown as CpiEndpointRow[];

  const ep = rows[0];
  if (!ep) return null;
  const earliest = Number(ep.earliest_value);
  const latest = Number(ep.latest_value);
  if (!isFinite(earliest) || !isFinite(latest) || earliest === 0) return null;

  const cpiMovePct = ((latest - earliest) / earliest) * 100;
  const spreadPct = args.supplierAskPct - cpiMovePct;
  const verdict: CpiPushbackContext["verdict"] =
    cpiMovePct < 0 && args.supplierAskPct > 0
      ? "cpi_decline"
      : spreadPct > 0
        ? "pushback"
        : "support";

  // Disclosure-tier source descriptor (matches FX-exposure / spot-vs-contract).
  let source: InsightSource | null = null;
  const collector = getCollector(ep.latest_collector_id);
  if (collector) {
    source = buildInsightSource({
      collectorId: collector.id,
      collectorName: collector.name,
      sourceUrl: ep.latest_source_url || collector.sourceUrl,
      observedAt: new Date(ep.latest_at),
      contract: collectorContract(collector),
    });
  }

  const summary =
    verdict === "cpi_decline"
      ? `BLS ${cpiScope} CPI fell ${Math.abs(cpiMovePct).toFixed(1)}% over the last ${lookbackDays} days while the supplier is implying a +${args.supplierAskPct.toFixed(1)}% ask — strongest possible pushback case.`
      : verdict === "pushback"
        ? `BLS ${cpiScope} CPI moved +${cpiMovePct.toFixed(1)}% over the last ${lookbackDays} days vs the supplier's implied +${args.supplierAskPct.toFixed(1)}% ask — defensible pushback room of ${spreadPct.toFixed(1)} pts.`
        : `BLS ${cpiScope} CPI moved +${cpiMovePct.toFixed(1)}% over the last ${lookbackDays} days, in line with or above the supplier's implied +${args.supplierAskPct.toFixed(1)}% ask — pushback support is weak.`;

  return {
    cpiScopeCode: cpiScope,
    cpiMovePct,
    supplierAskPct: args.supplierAskPct,
    spreadPct,
    verdict,
    summary,
    earliestValue: earliest,
    latestValue: latest,
    earliestObservedAt: ep.earliest_at,
    latestObservedAt: ep.latest_at,
    lookbackDays,
    source,
  };
}
