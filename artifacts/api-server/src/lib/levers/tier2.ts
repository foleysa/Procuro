import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { LeverAnalyzer, OpportunityDraft } from "./types";
import {
  FRED_CATEGORY_SCOPE_CODES,
  fredSeriesForScopeCode,
} from "../intelligence/scope-taxonomy";
import { getCollector } from "../intelligence/runtime";
import { collectorContract } from "../intelligence/collector";
import { buildInsightSource, type InsightSource } from "../insight-sources";

const dollars = (n: number) => Math.round(n * 100) / 100;

/**
 * Lever 8 — Supplier consolidation in indirect categories.
 * Multiple active suppliers in the same indirect category — consolidate.
 */
export const supplierConsolidationLever: LeverAnalyzer = {
  leverId: "supplier_consolidation",
  tier: 2,
  label: "Supplier Consolidation (Indirect)",
  description:
    "Multiple active suppliers in the same indirect category. Consolidate to the top 1–2 for volume leverage.",
  async analyze({ orgId }) {
    const rows = await db.execute(sql`
      WITH cat_suppliers AS (
        SELECT pol.category_id,
               cat.name AS category_name,
               cat.class AS category_class,
               po.supplier_id,
               s.name AS supplier_name,
               SUM(pol.extended_usd::numeric) AS supplier_spend
        FROM po_lines pol
        JOIN purchase_orders po ON po.id = pol.po_id
        JOIN suppliers s ON s.id = po.supplier_id
        JOIN categories cat ON cat.id = pol.category_id
        WHERE pol.org_id = ${orgId}
          AND cat.class = 'indirect'
          AND pol.order_date >= NOW() - INTERVAL '365 days'
        GROUP BY pol.category_id, cat.name, cat.class, po.supplier_id, s.name
      ),
      cat_summary AS (
        SELECT category_id,
               category_name,
               COUNT(DISTINCT supplier_id) AS supplier_count,
               SUM(supplier_spend) AS total_cat_spend
        FROM cat_suppliers
        GROUP BY category_id, category_name
        HAVING COUNT(DISTINCT supplier_id) >= 4
           AND SUM(supplier_spend) > 25000
      )
      SELECT * FROM cat_summary
      ORDER BY total_cat_spend DESC
      LIMIT 15
    `);
    const drafts: OpportunityDraft[] = [];
    for (const r of rows.rows as Array<{
      category_id: string;
      category_name: string;
      supplier_count: string;
      total_cat_spend: string;
    }>) {
      const totalSpend = Number(r.total_cat_spend);
      const supplierCount = Number(r.supplier_count);
      const savings = totalSpend * 0.06;
      drafts.push({
        leverId: "supplier_consolidation",
        title: `Consolidate ${supplierCount} ${r.category_name} suppliers`,
        rationale: `${r.category_name} indirect spend of $${totalSpend.toFixed(0)} is fragmented across ${supplierCount} active suppliers. Consolidating to the top 2 typically captures 5–8% via volume leverage.`,
        recommendedAction: `Run a sourcing event on ${r.category_name}; award to the top 2 suppliers with a primary/secondary split.`,
        categoryId: r.category_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          categoryId: r.category_id,
          supplierCount,
          totalCategorySpendUsd: totalSpend,
          assumedSavingsPct: 6,
        },
      });
    }
    return drafts;
  },
};

/**
 * Lever 9 — Contract renegotiation triggers.
 * Contracts expiring soon, or where actual volume has materially grown.
 */
export const contractRenegotiationTriggerLever: LeverAnalyzer = {
  leverId: "contract_renegotiation_trigger",
  tier: 2,
  label: "Contract Renegotiation Triggers",
  description:
    "Contracts expiring in <90 days or where actual volume has grown materially vs baseline. Renegotiate now while leverage is fresh.",
  async analyze({ orgId }) {
    const rows = await db.execute(sql`
      WITH actuals AS (
        SELECT pol.po_id, po.supplier_id, po.contract_id,
               SUM(pol.extended_usd::numeric) AS spend
        FROM po_lines pol
        JOIN purchase_orders po ON po.id = pol.po_id
        WHERE pol.org_id = ${orgId}
          AND pol.order_date >= NOW() - INTERVAL '365 days'
        GROUP BY pol.po_id, po.supplier_id, po.contract_id
      ),
      contract_actuals AS (
        SELECT contract_id, SUM(spend) AS actual_12mo_spend
        FROM actuals
        WHERE contract_id IS NOT NULL
        GROUP BY contract_id
      )
      SELECT c.id AS contract_id,
             c.contract_number,
             c.title,
             c.supplier_id,
             s.name AS supplier_name,
             c.end_date,
             c.annual_baseline_usd::numeric AS baseline,
             COALESCE(ca.actual_12mo_spend, 0) AS actual_12mo
      FROM contracts c
      JOIN suppliers s ON s.id = c.supplier_id
      LEFT JOIN contract_actuals ca ON ca.contract_id = c.id
      WHERE c.org_id = ${orgId}
        AND c.status = 'active'
        AND (
          c.end_date <= NOW() + INTERVAL '90 days'
          OR (c.annual_baseline_usd::numeric > 0 AND COALESCE(ca.actual_12mo_spend, 0) > c.annual_baseline_usd::numeric * 1.20)
        )
      ORDER BY c.end_date ASC
      LIMIT 15
    `);
    const drafts: OpportunityDraft[] = [];
    const now = Date.now();
    for (const r of rows.rows as Array<{
      contract_id: string;
      contract_number: string;
      title: string;
      supplier_id: string;
      supplier_name: string;
      end_date: string;
      baseline: string;
      actual_12mo: string;
    }>) {
      const actual = Number(r.actual_12mo);
      const baseline = Number(r.baseline);
      const expiringSoon =
        new Date(r.end_date).getTime() - now < 90 * 24 * 60 * 60 * 1000;
      const overran = baseline > 0 && actual > baseline * 1.2;
      const triggers: string[] = [];
      if (expiringSoon) triggers.push("expiring <90d");
      if (overran)
        triggers.push(
          `volume +${(((actual - baseline) / baseline) * 100).toFixed(0)}% vs baseline`,
        );
      // Conservative: 5% on actual.
      const savings = actual * 0.05;
      if (savings < 1000) continue;
      drafts.push({
        leverId: "contract_renegotiation_trigger",
        title: `Renegotiate ${r.contract_number} with ${r.supplier_name} (${triggers.join("; ")})`,
        rationale: `Contract ${r.contract_number} (${r.title}) — baseline $${baseline.toFixed(0)}, actual 12-mo $${actual.toFixed(0)}, end date ${new Date(r.end_date).toISOString().slice(0, 10)}. Triggers: ${triggers.join(", ")}.`,
        recommendedAction: `Open renewal negotiation now with volume leverage; secure tier breakpoint that captures next-12mo trajectory.`,
        supplierId: r.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          contractId: r.contract_id,
          supplierId: r.supplier_id,
          baselineUsd: baseline,
          actual12moUsd: actual,
          endDate: r.end_date,
          triggers,
          assumedSavingsPct: 5,
        },
      });
    }
    return drafts;
  },
};

/**
 * Lever 10 — Spot vs contract benchmark (FRED PPI).
 *
 * Pulls recently observed FRED economic-index signals scoped to canonical
 * procurement categories (`FREIGHT_TRUCKING_TL`, `RAIL_FREIGHT`, etc.) and,
 * for each tenant category whose `code` matches the canonical scope, surfaces
 * any active contract with material 12-month spend as a renegotiation
 * candidate that can be defended with the public PPI as the spot benchmark.
 *
 * This is the join point that turns `IntelligenceCollector` output into real
 * Tier-2 opportunity scoring: the canonical scope code in `market_signals`
 * matches `categories.code` exactly (the taxonomy lives in
 * `lib/intelligence/scope-taxonomy.ts`).
 */
export const spotVsContractLever: LeverAnalyzer = {
  leverId: "spot_vs_contract",
  tier: 2,
  label: "Spot vs Contract Benchmark (PPI)",
  description:
    "Active contracts in categories where the public PPI (FRED) gives an independent spot benchmark. Surface as renegotiation candidates with the PPI series cited in the rationale.",
  async analyze({ orgId }) {
    const scopeCodes = FRED_CATEGORY_SCOPE_CODES;
    if (scopeCodes.length === 0) return [];

    // Most-recent economic_index / commodity_index signal per category scope
    // (org-specific overrides global; window keeps stale signals out).
    const signalRows = await db.execute(sql`
      WITH ranked AS (
        SELECT ms.id,
               ms.scope_category_code,
               ms.value::numeric AS value,
               ms.unit,
               ms.observed_at,
               ms.source_url,
               ms.collector_id,
               ms.metadata,
               ROW_NUMBER() OVER (
                 PARTITION BY ms.scope_category_code
                 ORDER BY (ms.org_id IS NOT NULL) DESC, ms.observed_at DESC
               ) AS rn
        FROM market_signals ms
        WHERE ms.signal_type IN ('economic_index', 'commodity_index')
          AND ms.scope_category_code = ANY(${sql.raw(
            `ARRAY[${scopeCodes.map((c) => `'${c}'`).join(",")}]::text[]`,
          )})
          AND (ms.org_id IS NULL OR ms.org_id = ${orgId})
          AND ms.observed_at >= NOW() - INTERVAL '180 days'
      )
      SELECT id, scope_category_code, value, unit, observed_at,
             source_url, collector_id, metadata
      FROM ranked
      WHERE rn = 1
    `);

    const signals = signalRows.rows as Array<{
      id: string;
      scope_category_code: string;
      value: string;
      unit: string;
      observed_at: string;
      source_url: string;
      collector_id: string;
      metadata: Record<string, unknown> | null;
    }>;
    if (signals.length === 0) return [];

    const drafts: OpportunityDraft[] = [];
    for (const sig of signals) {
      // Match tenant categories on canonical code (case-insensitive — tenant
      // ingestion may casefold differently, but the taxonomy uses ALL_CAPS).
      const contractRows = await db.execute(sql`
        WITH cat_match AS (
          SELECT id AS category_id, name AS category_name
          FROM categories
          WHERE org_id = ${orgId}
            AND UPPER(code) = ${sig.scope_category_code}
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
               cm.category_name,
               s.name AS supplier_name,
               COALESCE(a.spend, 0) AS actual_12mo_spend
        FROM contracts c
        JOIN suppliers s ON s.id = c.supplier_id
        JOIN cat_match cm ON cm.category_id = c.category_id
        LEFT JOIN actuals a ON a.contract_id = c.id
        WHERE c.org_id = ${orgId}
          AND c.status = 'active'
          AND COALESCE(a.spend, 0) > 25000
        ORDER BY COALESCE(a.spend, 0) DESC
        LIMIT 10
      `);

      const fredSeries = fredSeriesForScopeCode(sig.scope_category_code);
      const fredLabels = fredSeries.map((f) => `${f.label} (${f.seriesId})`);
      const observedDate = new Date(sig.observed_at).toISOString().slice(0, 10);
      const indexValue = Number(sig.value);

      // Build the disclosure-tier source descriptor for the FRED PPI
      // observation that drove this opportunity. Same pattern as
      // `supplier-fx-exposure`: look the collector up in the in-memory
      // registry by `market_signals.collector_id` and emit one entry
      // via `buildInsightSource()`. If the registry doesn't recognise
      // the id (legacy row from a removed collector) we omit the
      // source rather than emit a partial citation.
      const sources: InsightSource[] = [];
      const collector = getCollector(sig.collector_id);
      if (collector) {
        sources.push(
          buildInsightSource({
            collectorId: collector.id,
            collectorName: collector.name,
            // Prefer the per-signal source URL (e.g. the exact FRED
            // series page) over the collector's catalog URL — it's a
            // more useful citation target for the buyer.
            sourceUrl: sig.source_url || collector.sourceUrl,
            observedAt: new Date(sig.observed_at),
            contract: collectorContract(collector),
          }),
        );
      }

      for (const r of contractRows.rows as Array<{
        contract_id: string;
        contract_number: string;
        title: string;
        supplier_id: string;
        category_id: string;
        category_name: string;
        supplier_name: string;
        actual_12mo_spend: string;
      }>) {
        const actual = Number(r.actual_12mo_spend);
        // Conservative: 3% on the contract's actual 12-month spend. Widely
        // used "PPI defended" renegotiation savings range is 3–6%; the OODA
        // priors learner will calibrate from realized outcomes.
        const savings = actual * 0.03;
        if (savings < 750) continue;
        drafts.push({
          leverId: "spot_vs_contract",
          title: `Renegotiate ${r.contract_number} (${r.category_name}) using public PPI as spot benchmark`,
          rationale: `Active contract ${r.contract_number} (${r.title}) with ${r.supplier_name} in ${r.category_name} ran $${actual.toFixed(0)} of spend in the last 12 months. The public producer-price benchmark (${fredLabels.join("; ") || sig.scope_category_code}) was ${indexValue.toFixed(2)} as of ${observedDate} and gives an independent reference for the next negotiation.`,
          recommendedAction: `Open a fact-based renegotiation citing the FRED PPI for ${r.category_name} as the spot benchmark; target a 3% reduction off current contracted rates.`,
          supplierId: r.supplier_id,
          categoryId: r.category_id,
          rawProjectedSavingsUsd: dollars(savings),
          inputs: {
            contractId: r.contract_id,
            categoryId: r.category_id,
            supplierId: r.supplier_id,
            actual12moUsd: actual,
            assumedSavingsPct: 3,
            marketSignal: {
              id: sig.id,
              collectorId: sig.collector_id,
              scopeCategoryCode: sig.scope_category_code,
              value: indexValue,
              unit: sig.unit,
              observedAt: sig.observed_at,
              sourceUrl: sig.source_url,
              fredSeries: fredSeries.map((f) => ({
                seriesId: f.seriesId,
                label: f.label,
              })),
            },
            // Persisted on the opportunity's `inputs` JSON so the API
            // server can lift them back out at read time without
            // re-querying the underlying market_signals — same shape
            // as the FX-exposure lever uses.
            sources,
          },
        });
      }
    }
    return drafts;
  },
};

export const TIER_2_LEVERS: LeverAnalyzer[] = [
  supplierConsolidationLever,
  contractRenegotiationTriggerLever,
  spotVsContractLever,
];
