import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnalyzeResult, LeverAnalyzer, OpportunityDraft } from "./types";
import {
  FRED_MATERIAL_SCOPE_CODES,
  MATERIAL_TO_CATEGORY_CODES,
  fredSeriesForScopeCode,
  type CanonicalMaterialCode,
} from "../intelligence/scope-taxonomy";
import { getCollector } from "../intelligence/runtime";
import { collectorContract } from "../intelligence/collector";
import { buildInsightSource, type InsightSource } from "../insight-sources";

/**
 * Lever — Material PPI arbitrage (Tier 4, lever #62).
 *
 * Surfaces opportunities where the FRED PPI for a raw material has moved
 * materially over a recent window and the tenant has spend on contracts
 * in categories that consume that material. The intent is *price-update
 * arbitrage*: contract prices are sticky, but spot PPI moves — if the
 * PPI dropped 8% over 6 months, the buyer should be repricing the
 * passthrough portion of the cost (typically half) to capture savings,
 * or — when PPI rose — pulling forward orders / locking-in pre-rise
 * pricing.
 *
 * Distinction from neighbouring levers
 * ------------------------------------
 *   - `spot_vs_contract` (Tier 2) matches signals to **service** PCU
 *     codes (freight, warehousing). Each tenant category code is
 *     identical to a FRED PCU scope code, so the join is direct.
 *   - `material_index_arbitrage` (this file) matches signals to raw
 *     **material** codes. Tenant categories don't follow the FRED
 *     material naming, so we use the curated alias map in
 *     `MATERIAL_TO_CATEGORY_CODES` to bridge them.
 *   - `raw_material_hedging` (placeholder) is intended to surface
 *     forward-buy / hedge recommendations on volatile materials. This
 *     lever is the spot-vs-contract analog for materials and does not
 *     touch hedging.
 *
 * Tenant isolation
 * ----------------
 * `market_signals` rows are either platform-wide (`org_id IS NULL`) or
 * tenant-scoped. The signal query restricts to `(org_id IS NULL OR
 * org_id = ${orgId})`.
 *
 * Configurability
 * ---------------
 * Threshold and lookback are read from `org.settings`:
 *   - `materialIndexLookbackDays`     (default 180)
 *   - `materialIndexMovePctThreshold` (default 4)
 *   - `materialIndexPassthroughFactor` (default 0.5)
 *
 * The passthrough factor models the share of contract price that's a
 * direct material passthrough (the rest is conversion / labor / SG&A).
 */

const DEFAULT_LOOKBACK_DAYS = 180;
const DEFAULT_MOVE_PCT_THRESHOLD = 4;
const DEFAULT_PASSTHROUGH_FACTOR = 0.5;
const MIN_SAVINGS_USD = 1000;

const dollars = (n: number) => Math.round(n * 100) / 100;

/** Read a positive numeric setting, falling back to a default. */
function readNumericSetting(
  settings: Record<string, unknown> | null | undefined,
  key: string,
  fallback: number,
): number {
  const raw = settings?.[key];
  if (typeof raw === "number" && isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (isFinite(n) && n > 0) return n;
  }
  return fallback;
}

interface MaterialEndpointRow {
  scope_material_code: string;
  earliest_value: string;
  latest_value: string;
  earliest_at: string;
  latest_at: string;
  observation_count: string;
  /** Most-recent collector for citation attribution. */
  latest_collector_id: string;
  latest_source_url: string | null;
  /** Comma-joined `market_signals.id`s consulted for this material in window. */
  signal_ids: string;
}

interface MatchedContractRow {
  contract_id: string;
  contract_number: string;
  title: string;
  supplier_id: string;
  supplier_name: string;
  category_id: string;
  category_code: string;
  category_name: string;
  actual_12mo_spend: string;
}

export const materialIndexArbitrageLever: LeverAnalyzer = {
  leverId: "material_index_arbitrage",
  tier: 4,
  label: "Material PPI Arbitrage",
  description:
    "FRED material PPI has moved materially over the lookback window — surface tenant contracts in categories consuming that material as repricing (PPI down) or pull-forward / lock-in (PPI up) candidates. Projection multiplies contract spend by the move and a passthrough factor (default 0.5).",
  async analyze({ orgId }) {
    const materialCodes = FRED_MATERIAL_SCOPE_CODES;
    if (materialCodes.length === 0) return [];

    // 1. Org settings.
    const [orgRow] = (await db.execute(sql`
      SELECT settings FROM orgs WHERE id = ${orgId}
    `)).rows as unknown as Array<{
      settings: Record<string, unknown> | null;
    }>;
    const settings = orgRow?.settings ?? null;
    const lookbackDays = Math.round(
      readNumericSetting(settings, "materialIndexLookbackDays", DEFAULT_LOOKBACK_DAYS),
    );
    const thresholdPct = readNumericSetting(
      settings,
      "materialIndexMovePctThreshold",
      DEFAULT_MOVE_PCT_THRESHOLD,
    );
    const passthroughFactor = Math.min(
      1,
      readNumericSetting(
        settings,
        "materialIndexPassthroughFactor",
        DEFAULT_PASSTHROUGH_FACTOR,
      ),
    );

    // 2. Endpoint values per material scope (earliest + latest in window),
    //    restricted to platform-wide or this tenant's signals only.
    const endpointRows = (await db.execute(sql`
      WITH window_signals AS (
        SELECT ms.id AS signal_id,
               ms.scope_material_code,
               ms.value::numeric AS value,
               ms.observed_at,
               ms.collector_id,
               ms.source_url
        FROM market_signals ms
        WHERE ms.signal_type IN ('economic_index', 'commodity_index')
          AND ms.scope_material_code = ANY(${sql.raw(
            `ARRAY[${materialCodes.map((c) => `'${c}'`).join(",")}]::text[]`,
          )})
          AND ms.observed_at >= NOW() - make_interval(days => ${lookbackDays})
          AND (ms.org_id IS NULL OR ms.org_id = ${orgId})
      )
      SELECT scope_material_code,
             (array_agg(value ORDER BY observed_at ASC ))[1]::text AS earliest_value,
             (array_agg(value ORDER BY observed_at DESC))[1]::text AS latest_value,
             MIN(observed_at)::text AS earliest_at,
             MAX(observed_at)::text AS latest_at,
             COUNT(*)::text         AS observation_count,
             (array_agg(collector_id ORDER BY observed_at DESC))[1] AS latest_collector_id,
             (array_agg(source_url ORDER BY observed_at DESC))[1] AS latest_source_url,
             string_agg(signal_id, ',')                            AS signal_ids
      FROM window_signals
      GROUP BY scope_material_code
      HAVING COUNT(*) >= 2
    `)).rows as unknown as MaterialEndpointRow[];

    const consultedSignalIds = new Set<string>();
    for (const ep of endpointRows) {
      if (ep.signal_ids) {
        for (const id of ep.signal_ids.split(",")) {
          if (id) consultedSignalIds.add(id);
        }
      }
    }

    if (endpointRows.length === 0) {
      const empty: AnalyzeResult = {
        drafts: [],
        consultedSignalIds: [],
        candidatesEvaluated: 0,
      };
      return empty;
    }

    const drafts: OpportunityDraft[] = [];
    for (const ep of endpointRows) {
      const earliest = Number(ep.earliest_value);
      const latest = Number(ep.latest_value);
      if (!isFinite(earliest) || !isFinite(latest) || earliest === 0) continue;
      const movePct = ((latest - earliest) / earliest) * 100;
      const absMovePct = Math.abs(movePct);
      if (absMovePct < thresholdPct) continue;

      const materialCode = ep.scope_material_code as CanonicalMaterialCode;
      const aliases = MATERIAL_TO_CATEGORY_CODES[materialCode];
      if (!aliases || aliases.length === 0) continue;

      // 3. Find tenant contracts in matching categories with material spend.
      const matched = (await db.execute(sql`
        WITH cat_match AS (
          SELECT id AS category_id, code AS category_code, name AS category_name
          FROM categories
          WHERE org_id = ${orgId}
            AND UPPER(code) = ANY(${sql.raw(
              `ARRAY[${aliases.map((a) => `'${a.toUpperCase()}'`).join(",")}]::text[]`,
            )})
        ),
        actuals AS (
          SELECT po.contract_id,
                 SUM(pol.extended_usd::numeric) AS spend
          FROM po_lines pol
          JOIN purchase_orders po ON po.id = pol.po_id
          JOIN cat_match cm ON cm.category_id = pol.category_id
          WHERE pol.org_id = ${orgId}
            AND pol.order_date >= NOW() - INTERVAL '365 days'
            AND po.contract_id IS NOT NULL
          GROUP BY po.contract_id
        )
        SELECT c.id AS contract_id,
               c.contract_number,
               c.title,
               c.supplier_id,
               c.category_id,
               cm.category_code,
               cm.category_name,
               s.name AS supplier_name,
               COALESCE(a.spend, 0)::text AS actual_12mo_spend
        FROM contracts c
        JOIN suppliers s ON s.id = c.supplier_id
        JOIN cat_match cm ON cm.category_id = c.category_id
        LEFT JOIN actuals a ON a.contract_id = c.id
        WHERE c.org_id = ${orgId}
          AND c.status = 'active'
          AND COALESCE(a.spend, 0) > 25000
        ORDER BY COALESCE(a.spend, 0) DESC
        LIMIT 10
      `)).rows as unknown as MatchedContractRow[];

      if (matched.length === 0) continue;

      // 4. Build the disclosure-tier source descriptor for the FRED PPI
      //    observation that drove the opportunity. Same pattern as
      //    `spot_vs_contract` and `supplier_fx_exposure`.
      const sources: InsightSource[] = [];
      const collector = getCollector(ep.latest_collector_id);
      if (collector) {
        sources.push(
          buildInsightSource({
            collectorId: collector.id,
            collectorName: collector.name,
            sourceUrl: ep.latest_source_url || collector.sourceUrl,
            observedAt: new Date(ep.latest_at),
            contract: collectorContract(collector),
          }),
        );
      }

      const fredSeries = fredSeriesForScopeCode(materialCode);
      const fredLabels = fredSeries.map((f) => `${f.label} (${f.seriesId})`);
      const direction = movePct < 0 ? "down" : "up";
      const observedDate = new Date(ep.latest_at).toISOString().slice(0, 10);
      const earliestDate = new Date(ep.earliest_at).toISOString().slice(0, 10);

      for (const r of matched) {
        const actual = Number(r.actual_12mo_spend);
        // Project savings on the PASSTHROUGH portion only. When PPI is
        // down, that's pure savings on next reset; when PPI is up, it's
        // the value of locking in pre-rise pricing on planned spend.
        const savings = actual * (absMovePct / 100) * passthroughFactor;
        if (savings < MIN_SAVINGS_USD) continue;

        const action =
          movePct < 0
            ? `Open a fact-based renegotiation citing the ${absMovePct.toFixed(1)}% drop in the FRED ${fredLabels.join(", ") || materialCode} PPI; target the passthrough portion (${(passthroughFactor * 100).toFixed(0)}%) of contract pricing for a reset.`
            : `Open a pull-forward / lock-in conversation: the FRED ${fredLabels.join(", ") || materialCode} PPI rose ${absMovePct.toFixed(1)}% — accelerate planned POs against the current contract or convert to a fixed-price for the next ${lookbackDays} days to avoid the next reset.`;

        drafts.push({
          leverId: "material_index_arbitrage",
          title:
            movePct < 0
              ? `Reprice ${r.contract_number} (${r.category_name}) — ${materialCode} PPI down ${absMovePct.toFixed(1)}%`
              : `Lock-in pricing on ${r.contract_number} (${r.category_name}) — ${materialCode} PPI up ${absMovePct.toFixed(1)}%`,
          rationale: `Active contract ${r.contract_number} (${r.title}) with ${r.supplier_name} in ${r.category_name} (code ${r.category_code}) ran $${actual.toFixed(0)} of spend in the last 12 months. The ${fredLabels.join("; ") || materialCode} PPI moved ${direction} ${absMovePct.toFixed(2)}% over the last ${lookbackDays} days (${earliest.toFixed(2)} on ${earliestDate} → ${latest.toFixed(2)} on ${observedDate}). Assuming a ${(passthroughFactor * 100).toFixed(0)}% passthrough share of contract price, the addressable swing is ~$${savings.toFixed(0)}.`,
          recommendedAction: action,
          supplierId: r.supplier_id,
          categoryId: r.category_id,
          rawProjectedSavingsUsd: dollars(savings),
          inputs: {
            contractId: r.contract_id,
            categoryId: r.category_id,
            supplierId: r.supplier_id,
            actual12moUsd: actual,
            materialScopeCode: materialCode,
            categoryCode: r.category_code,
            movePct,
            absMovePct,
            lookbackDays,
            thresholdPct,
            passthroughFactor,
            earliestValue: earliest,
            latestValue: latest,
            earliestObservedAt: ep.earliest_at,
            latestObservedAt: ep.latest_at,
            observationCount: Number(ep.observation_count),
            fredSeries: fredSeries.map((f) => ({
              seriesId: f.seriesId,
              label: f.label,
            })),
            // Persisted on the opportunity's `inputs` JSON so the
            // detail route can lift them back out without re-querying
            // market_signals — same shape as the FX-exposure and
            // spot-vs-contract levers.
            sources,
          },
        });
      }
    }
    const result: AnalyzeResult = {
      drafts,
      consultedSignalIds: Array.from(consultedSignalIds),
      candidatesEvaluated: endpointRows.length,
    };
    return result;
  },
  cohortKey(draft: OpportunityDraft): string {
    // Material PPI cohorts are identified by the canonical material
    // scope code (the FRED PPI series the lever consulted).
    const inputs = draft.inputs as Record<string, unknown>;
    return String(inputs["materialScopeCode"] ?? "");
  },
};
