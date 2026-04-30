import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnalyzeResult, LeverAnalyzer, OpportunityDraft } from "./types";
import { getCollector } from "../intelligence/runtime";
import { collectorContract } from "../intelligence/collector";
import { buildInsightSource, type InsightSource } from "../insight-sources";

/**
 * Lever — Supplier FX exposure.
 *
 * Reads recent `fx_rate` market signals (ECB-emitted EUR-base pairs and
 * derived USD-base cross rates) and flags supplier × billing-currency
 * combinations whose effective FX rate against the org's reporting currency
 * has moved more than the configured threshold over the lookback window.
 *
 * Exposure set
 * ------------
 * The exposure set is the UNION of:
 *   1. suppliers where `supplier.billing_currency != org.base_currency`
 *   2. contracts where `contract.billing_currency != org.base_currency`
 *      (a contract's billing currency overrides the supplier's for that
 *      contract's spend; this lets a USD-default supplier still surface FX
 *      risk on a single foreign-currency contract)
 *
 * Result rows are grouped by `(supplier_id, billing_currency)` so that one
 * supplier with two currencies (rare but possible) produces two distinct
 * opportunities. Only the contracts whose effective currency matches the
 * grouped currency are listed in the rationale — contracts denominated in
 * the org base currency are never "affected" and are excluded.
 *
 * Tenant isolation
 * ----------------
 * `market_signals` rows are either platform-wide (`org_id IS NULL`) or
 * tenant-scoped. The signal query restricts to the union of those two so
 * one tenant's analysis can never be driven by another tenant's private
 * FX series.
 *
 * Direction normalization
 * -----------------------
 * The ECB feed emits "EUR/X" (X-per-EUR) and the derived feed emits
 * "USD/X" (X-per-USD). For a buyer reporting in `base` and paying a
 * supplier in `billing`, what we care about is the change in the USD cost
 * of one unit of billing currency:
 *
 *   - If the matching pair is `base/billing` (value = billing per base),
 *     then base-per-billing = 1 / value, and the buyer's cost moves
 *     INVERSELY to the pair value.
 *   - If the matching pair is `billing/base` (value = base per billing),
 *     then the buyer's cost moves WITH the pair value.
 *
 * `costChangePct > 0` ⇒ each billing-currency unit now costs more in base ⇒
 *   **adverse** move for the buyer ⇒ recommend hedge / lock in pricing.
 * `costChangePct < 0` ⇒ favorable move ⇒ recommend pull-forward / renegotiate.
 *
 * Configurability
 * ---------------
 * Threshold and lookback are read from `org.settings` JSON, with defensible
 * defaults if absent:
 *
 *   - `settings.fxExposureThresholdPct`  (default 3)
 *   - `settings.fxExposureLookbackDays`  (default 30)
 */

const DEFAULT_FX_MOVE_THRESHOLD_PCT = 3;
const DEFAULT_FX_LOOKBACK_DAYS = 30;
const MIN_SPEND_FOR_OPP_USD = 1000;

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

interface ExposureRow {
  supplier_id: string;
  supplier_name: string;
  billing_currency: string;
  base_currency: string;
  spend_12mo_usd: string;
  contract_numbers: string[] | null;
}

interface FxEndpointRow {
  pair: string;
  base: string;
  quote: string;
  earliest_value: string;
  latest_value: string;
  earliest_at: string;
  latest_at: string;
  observation_count: string;
  /**
   * Collector that produced the most recent observation in the window.
   * Used to attribute the FX signal back to a registered intelligence
   * collector (`@workspace/intelligence/contracts`) so the disclosure
   * renderer can decide whether to surface it as a citation.
   */
  latest_collector_id: string;
  /**
   * Comma-joined `market_signals.id`s that contributed to this endpoint
   * pair within the lookback window. Surfaced through `AnalyzeResult.
   * consultedSignalIds` so the funnel substrate can attribute the
   * Signals-Analyzed stage to specific signal rows (task #185).
   */
  signal_ids: string;
}

export const supplierFxExposureLever: LeverAnalyzer = {
  leverId: "supplier_fx_exposure",
  tier: 4,
  label: "Supplier FX Exposure",
  description:
    "Suppliers (or specific contracts) billing in a non-base currency where the FX pair has moved materially over the lookback window. Surfaces directional currency risk against the org's reporting currency, normalized so adverse vs favorable moves are recommended differently.",
  async analyze({ orgId }) {
    // 1. Pull the org's base currency + configurable analyzer settings.
    const [orgRow] = (await db.execute(sql`
      SELECT base_currency, settings
      FROM orgs
      WHERE id = ${orgId}
    `)).rows as unknown as Array<{
      base_currency: string;
      settings: Record<string, unknown> | null;
    }>;
    if (!orgRow) return [];
    const baseCurrency = orgRow.base_currency;
    const thresholdPct = readNumericSetting(
      orgRow.settings,
      "fxExposureThresholdPct",
      DEFAULT_FX_MOVE_THRESHOLD_PCT,
    );
    const lookbackDays = Math.round(
      readNumericSetting(
        orgRow.settings,
        "fxExposureLookbackDays",
        DEFAULT_FX_LOOKBACK_DAYS,
      ),
    );

    // 2. Build the exposure set: one row per (supplier, billing_currency).
    //
    //    Sources of exposure:
    //      a. supplier.billing_currency  (covers all of that supplier's spend)
    //      b. contract.billing_currency  (overrides on a per-contract basis)
    //
    //    `contract_numbers` lists only the contracts whose effective currency
    //    matches the row's `billing_currency` — base-currency contracts are
    //    correctly excluded.
    const exposureRows = (await db.execute(sql`
      WITH org AS (
        SELECT id, base_currency FROM orgs WHERE id = ${orgId}
      ),
      contract_currencies AS (
        SELECT c.supplier_id,
               c.contract_number,
               COALESCE(c.billing_currency, s.billing_currency) AS effective_currency
        FROM contracts c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.org_id = ${orgId}
          AND c.status = 'active'
      ),
      exposure_keys AS (
        -- supplier-level: fires for any supplier with a non-base billing currency
        SELECT s.id              AS supplier_id,
               s.name            AS supplier_name,
               s.billing_currency AS billing_currency
        FROM suppliers s
        CROSS JOIN org o
        WHERE s.org_id = ${orgId}
          AND s.billing_currency IS NOT NULL
          AND s.billing_currency <> o.base_currency

        UNION

        -- contract-level: fires for any active contract with a non-base
        -- effective billing currency, even if the supplier itself defaults
        -- to base currency.
        SELECT cc.supplier_id,
               s.name AS supplier_name,
               cc.effective_currency AS billing_currency
        FROM contract_currencies cc
        JOIN suppliers s ON s.id = cc.supplier_id
        CROSS JOIN org o
        WHERE cc.effective_currency IS NOT NULL
          AND cc.effective_currency <> o.base_currency
      ),
      supplier_spend AS (
        SELECT inv.supplier_id,
               COALESCE(SUM(inv.amount_usd::numeric), 0) AS spend_12mo_usd
        FROM invoices inv
        WHERE inv.org_id = ${orgId}
          AND inv.invoice_date >= NOW() - INTERVAL '365 days'
        GROUP BY inv.supplier_id
      ),
      contract_lists AS (
        SELECT cc.supplier_id,
               cc.effective_currency AS billing_currency,
               array_agg(cc.contract_number ORDER BY cc.contract_number) AS contract_numbers
        FROM contract_currencies cc
        WHERE cc.effective_currency IS NOT NULL
        GROUP BY cc.supplier_id, cc.effective_currency
      )
      SELECT ek.supplier_id,
             ek.supplier_name,
             ek.billing_currency,
             o.base_currency,
             COALESCE(ss.spend_12mo_usd, 0)::text AS spend_12mo_usd,
             cl.contract_numbers
      FROM exposure_keys ek
      CROSS JOIN org o
      LEFT JOIN supplier_spend ss
        ON ss.supplier_id = ek.supplier_id
      LEFT JOIN contract_lists cl
        ON cl.supplier_id = ek.supplier_id
       AND cl.billing_currency = ek.billing_currency
      GROUP BY ek.supplier_id, ek.supplier_name, ek.billing_currency,
               o.base_currency, ss.spend_12mo_usd, cl.contract_numbers
    `)).rows as unknown as ExposureRow[];

    if (exposureRows.length === 0) return [];

    // 3. Pull all in-window fx_rate endpoints, restricted to platform-wide
    //    or this tenant's signals only — never another tenant's series.
    const fxRows = (await db.execute(sql`
      WITH window_signals AS (
        SELECT ms.id                  AS signal_id,
               ms.scope_material_code AS pair,
               (ms.metadata->>'base') AS base,
               ms.currency            AS quote,
               ms.value::numeric      AS value,
               ms.observed_at,
               ms.collector_id        AS collector_id
        FROM market_signals ms
        WHERE ms.signal_type = 'fx_rate'
          AND ms.scope_material_code IS NOT NULL
          AND ms.metadata ? 'base'
          AND ms.observed_at >= NOW() - make_interval(days => ${lookbackDays})
          AND (ms.org_id IS NULL OR ms.org_id = ${orgId})
      )
      SELECT pair,
             base,
             quote,
             (array_agg(value ORDER BY observed_at ASC ))[1]::text AS earliest_value,
             (array_agg(value ORDER BY observed_at DESC))[1]::text AS latest_value,
             MIN(observed_at)::text AS earliest_at,
             MAX(observed_at)::text AS latest_at,
             COUNT(*)::text         AS observation_count,
             (array_agg(collector_id ORDER BY observed_at DESC))[1] AS latest_collector_id,
             string_agg(signal_id, ',')                            AS signal_ids
      FROM window_signals
      GROUP BY pair, base, quote
      HAVING COUNT(*) >= 2
    `)).rows as unknown as FxEndpointRow[];

    // Index FX endpoints by (base, quote) for fast lookup in both
    // orientations.
    const fxByOrientation = new Map<string, FxEndpointRow>();
    for (const r of fxRows) {
      fxByOrientation.set(`${r.base}/${r.quote}`, r);
    }

    const consultedSignalIds = new Set<string>();
    for (const r of fxRows) {
      if (r.signal_ids) {
        for (const id of r.signal_ids.split(",")) {
          if (id) consultedSignalIds.add(id);
        }
      }
    }

    const drafts: OpportunityDraft[] = [];
    for (const row of exposureRows) {
      // Prefer the direct base→billing orientation (e.g. USD/EUR for a
      // USD-base org with an EUR supplier); fall back to billing→base.
      const direct = fxByOrientation.get(
        `${row.base_currency}/${row.billing_currency}`,
      );
      const inverse = fxByOrientation.get(
        `${row.billing_currency}/${row.base_currency}`,
      );
      const fx = direct ?? inverse;
      if (!fx) continue;

      const earliest = Number(fx.earliest_value);
      const latest = Number(fx.latest_value);
      if (!isFinite(earliest) || !isFinite(latest) || earliest === 0) continue;

      // Pair-value % move (raw observation move, just for context).
      const movePct = ((latest - earliest) / earliest) * 100;

      // Normalized cost-change %: how much more (or less) one unit of the
      // billing currency now costs, expressed in the buyer's base currency.
      // - direct orientation (base/billing): cost = 1/value, so a rising
      //   pair value REDUCES the buyer's cost. costChange = (1/latest)/(1/earliest) - 1.
      // - inverse orientation (billing/base): cost = value, so cost moves
      //   with the pair.
      const costChangePct =
        fx === direct
          ? (earliest / latest - 1) * 100
          : (latest / earliest - 1) * 100;
      const absCostChangePct = Math.abs(costChangePct);
      if (absCostChangePct < thresholdPct) continue;

      const spend12mo = Number(row.spend_12mo_usd);
      const exposureUsd = spend12mo * (absCostChangePct / 100);
      if (exposureUsd < MIN_SPEND_FOR_OPP_USD) continue;

      const adverse = costChangePct > 0;
      const direction = adverse
        ? `cost more in ${row.base_currency}`
        : `cost less in ${row.base_currency}`;
      const contracts = (row.contract_numbers ?? []).filter(Boolean);
      const contractText =
        contracts.length === 0
          ? "no active foreign-currency contracts on file"
          : contracts.length <= 3
            ? `affected contracts: ${contracts.join(", ")}`
            : `${contracts.length} affected contracts (${contracts.slice(0, 3).join(", ")}, …)`;

      // Build the disclosure-tier source descriptor for the FX
      // observation that drove this opportunity. The collector lookup
      // is in-memory (`getCollector`) and only succeeds for collectors
      // registered at boot — if the registry doesn't recognise the id
      // (e.g. a legacy row from a removed source) we omit the source
      // rather than emit a partial citation.
      const sources: InsightSource[] = [];
      const collector = getCollector(fx.latest_collector_id);
      if (collector) {
        sources.push(
          buildInsightSource({
            collectorId: collector.id,
            collectorName: collector.name,
            sourceUrl: collector.sourceUrl,
            observedAt: new Date(fx.latest_at),
            contract: collectorContract(collector),
          }),
        );
      }

      drafts.push({
        leverId: "supplier_fx_exposure",
        title: `FX exposure: ${row.supplier_name} (${row.billing_currency}) — ${costChangePct >= 0 ? "+" : ""}${costChangePct.toFixed(2)}% in ${row.base_currency} cost vs ${fx.pair}`,
        rationale: `${row.supplier_name} bills in ${row.billing_currency}; the ${fx.pair} reference rate moved ${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}% over the last ${lookbackDays} days (${earliest.toFixed(4)} → ${latest.toFixed(4)}). Normalized to the buyer's ${row.base_currency} cost, each ${row.billing_currency} unit now ${direction} by ${absCostChangePct.toFixed(2)}%. Last-12-months invoiced spend with this supplier is $${spend12mo.toFixed(0)} (${contractText}). Directional FX exposure on that spend at the current move is ~$${exposureUsd.toFixed(0)} ${adverse ? "of incremental cost" : "of potential savings"} vs ${row.base_currency}.`,
        recommendedAction: adverse
          ? `Adverse FX move — open a hedging conversation: forward-buy ${row.billing_currency} or renegotiate to a ${row.base_currency}-denominated price now to lock in pre-move pricing on upcoming POs with ${row.supplier_name}.`
          : `Favorable FX move — capture the gain: pull-forward planned spend with ${row.supplier_name} or renegotiate unit pricing in ${row.base_currency} while the cross rate is in your favor.`,
        supplierId: row.supplier_id,
        rawProjectedSavingsUsd: dollars(exposureUsd),
        inputs: {
          supplierId: row.supplier_id,
          supplierName: row.supplier_name,
          baseCurrency: row.base_currency,
          billingCurrency: row.billing_currency,
          fxPair: fx.pair,
          fxOrientation: fx === direct ? "base/billing" : "billing/base",
          earliestValue: earliest,
          latestValue: latest,
          earliestObservedAt: fx.earliest_at,
          latestObservedAt: fx.latest_at,
          observationCount: Number(fx.observation_count),
          movePct,
          costChangePct,
          absCostChangePct,
          adverse,
          lookbackDays,
          thresholdPct,
          spend12moUsd: spend12mo,
          contractNumbers: contracts,
          // Persisted on the opportunity's `inputs` JSON so the API
          // server can lift them back out at read time without
          // re-querying the underlying market_signals.
          sources,
        },
      });
    }
    const result: AnalyzeResult = {
      drafts,
      consultedSignalIds: Array.from(consultedSignalIds),
      candidatesEvaluated: exposureRows.length,
    };
    return result;
  },
  cohortKey(draft: OpportunityDraft): string {
    // FX cohorts are identified by the (base, billing) currency pair —
    // a supplier with two billing currencies should appear in two
    // distinct cohorts even though the supplier id is the same.
    const inputs = draft.inputs as Record<string, unknown>;
    const base = String(inputs["baseCurrency"] ?? "");
    const billing = String(inputs["billingCurrency"] ?? "");
    return base && billing ? `${base}/${billing}` : "";
  },
};

export const TIER_4_LEVERS: LeverAnalyzer[] = [supplierFxExposureLever];
