import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnalyzeResult, LeverAnalyzer, OpportunityDraft } from "../types";
import { getCollector } from "../../intelligence/runtime";
import { collectorContract } from "../../intelligence/collector";
import { buildInsightSource, type InsightSource } from "../../insight-sources";
import {
  mapRoleToScopeCategory,
  ROLE_SCOPE_CATEGORY_CODES,
} from "./role-soc-mapping";

/**
 * Lever — Services rate-card benchmark (Tier 5).
 *
 * Two complementary detections fold into a single lever:
 *
 *   1. **Above-market rate-card lines.** Each `rate_card_lines.role`
 *      is mapped to a BLS OEWS SOC occupation via `mapRoleToScopeCategory`.
 *      The card's `hourlyRate` is then percentile-ranked against the
 *      latest hourly OEWS percentiles (`p25`/`median`/`p75`/`p90`)
 *      from `wage_benchmark` market signals scoped to the matched
 *      category. Lines at or above the 90th percentile generate an
 *      opportunity sized at `(rate - p75) * estimatedAnnualHours`,
 *      where the hours estimate prefers `time_entries` for the
 *      supplier+role over the trailing 12 months and falls back to
 *      `(invoice_spend / hourlyRate)` when no time entries exist.
 *
 *   2. **Off-card billing.** For each supplier with a rate card, any
 *      `time_entries` row whose `billRateUsd` lands outside ±5% of
 *      every card line for the same role+seniority is flagged as
 *      off-card. Savings = `(billed - card_rate) * hours`.
 *
 * Tenant isolation: every query is scoped by `org_id`. OEWS signals
 * have `org_id = NULL` (platform-wide); we restrict to that explicitly
 * to avoid cross-tenant private signals.
 *
 * Cohort identity: `(supplierId, rateCardLineId)`. Off-card drafts
 * carry the matched card line whose role+seniority the time-entry
 * tried (and failed) to match — see `cohortKey` below.
 */

const OFF_CARD_TOLERANCE = 0.05; // ±5% per task spec
const MIN_SAVINGS_USD = 250;
const FALLBACK_HOURS_LOOKBACK_DAYS = 365;

/**
 * Percentile threshold above which a rate-card line is flagged as
 * above-market. Defaults to p90 per task spec; overridable per
 * environment via `RATE_CARD_BENCHMARK_PERCENTILE` (`p75`/`p90`/`p95`).
 *
 * `p95` is not in OEWS by default, so it's mapped to p90 with a
 * stricter sizing anchor.
 */
const PERCENTILE_BANDS = ["p75", "p90", "p95"] as const;
type PercentileBand = (typeof PERCENTILE_BANDS)[number];

function resolveThresholdBand(): PercentileBand {
  const raw = (process.env.RATE_CARD_BENCHMARK_PERCENTILE ?? "p90")
    .trim()
    .toLowerCase();
  return (PERCENTILE_BANDS as readonly string[]).includes(raw)
    ? (raw as PercentileBand)
    : "p90";
}

const dollars = (n: number) => Math.round(n * 100) / 100;

interface RateCardLineRow {
  id: string;
  org_id: string;
  rate_card_id: string;
  supplier_id: string;
  supplier_name: string;
  role: string;
  seniority: string | null;
  hourly_rate: string | null;
  /** Free-form geography label on the rate-card line ("US", "EMEA", "India"). */
  geography: string | null;
}

/**
 * Map a rate-card `geography` tag to an OEWS `scope_region_code`
 * preference. OEWS publishes US-only series, so non-US geographies
 * still match the national series but the analyzer records that
 * the regional anchor was unavailable.
 *
 * Returns the preferred region code (or null = "any").
 */
function preferredOewsRegion(geography: string | null): string | null {
  if (!geography) return "US-NATIONAL";
  const g = geography.trim().toUpperCase();
  if (g === "US" || g === "USA" || g === "UNITED STATES") return "US-NATIONAL";
  // Future: map state/MSA tags here. For non-US tags we still anchor
  // to US-NATIONAL but expose the mismatch via `oewsRegionMatch`
  // on the draft inputs.
  return "US-NATIONAL";
}

interface WageSignalRow {
  id: string;
  scope_category_code: string;
  scope_region_code: string | null;
  value: string;
  observed_at: string;
  collector_id: string;
  source_url: string;
  aggregate: string | null;
  horizon: string | null;
}

interface TimeEntryAggRow {
  supplier_id: string;
  role: string | null;
  seniority: string | null;
  total_hours: string;
  total_amount: string | null;
}

interface OffCardRow {
  supplier_id: string;
  role: string | null;
  seniority: string | null;
  bill_rate_usd: string | null;
  total_hours: string;
  total_amount: string;
  entry_count: string;
}

interface SignalCorner {
  p25?: number;
  median?: number;
  p75?: number;
  p90?: number;
  /** Most-recent observation per aggregate; the analyzer cites the latest. */
  latestObservedAt?: string;
  latestSourceUrl?: string;
  latestCollectorId?: string;
  /** All observed signal IDs for this category that fed the rank. */
  signalIds: Set<string>;
  scopeRegionCode: string | null;
}

/**
 * Returns the OEWS percentile value used as the fire threshold for
 * the configured band. `p95` falls back to `p90` since OEWS does not
 * publish p95; the sizing anchor stays at p75 in either case.
 */
function thresholdValue(c: SignalCorner, band: PercentileBand): number | undefined {
  if (band === "p75") return c.p75;
  return c.p90; // covers p90 and p95 (no OEWS p95 series)
}

function rateAboveThreshold(
  rate: number,
  c: SignalCorner,
  band: PercentileBand,
): boolean {
  const t = thresholdValue(c, band);
  return t !== undefined && rate >= t;
}

export const servicesRateCardBenchmarkLever: LeverAnalyzer = {
  leverId: "services_rate_card_benchmark",
  tier: 5,
  label: "Services Rate-Card Benchmark",
  description:
    "Rate-card lines that price at or above the BLS OEWS 90th-percentile wage for the matched occupation, plus off-card billing where time entries clear at rates inconsistent with the card. Sizes savings against the OEWS p75 anchor and the trailing-12 hours.",
  cohortKey(draft: OpportunityDraft): string {
    // Cohort identity is `(supplierId, rateCardLineId)` per task #216;
    // supplierId is already on draft.supplierId so the lever-key
    // contribution is just the rate-card line. Both above-market and
    // off-card flavours that pin to the same line collapse to a
    // single cohort and remain idempotent across re-runs.
    const inputs = (draft.inputs as Record<string, unknown>) ?? {};
    const id = inputs["rateCardLineId"];
    return typeof id === "string" ? id : "";
  },
  async analyze({ orgId }) {
    const thresholdBand = resolveThresholdBand();
    // 1. Rate-card lines for the org with hourly rates set.
    const lines = (await db.execute(sql`
      SELECT rcl.id,
             rcl.org_id,
             rcl.rate_card_id,
             rc.supplier_id,
             s.name AS supplier_name,
             rcl.role,
             rcl.seniority,
             rcl.hourly_rate,
             rcl.geography
      FROM rate_card_lines rcl
      JOIN rate_cards rc ON rc.id = rcl.rate_card_id
      JOIN suppliers s ON s.id = rc.supplier_id
      WHERE rcl.org_id = ${orgId}
        AND rcl.hourly_rate IS NOT NULL
    `)).rows as unknown as RateCardLineRow[];

    // Track how many card lines each supplier has so the supplier-
    // level spend fallback can be apportioned across lines instead
    // of charged to every line in full (which would over-count).
    const linesPerSupplier = new Map<string, number>();
    for (const l of lines) {
      linesPerSupplier.set(
        l.supplier_id,
        (linesPerSupplier.get(l.supplier_id) ?? 0) + 1,
      );
    }

    if (lines.length === 0) {
      const empty: AnalyzeResult = {
        drafts: [],
        consultedSignalIds: [],
        candidatesEvaluated: 0,
      };
      return empty;
    }

    // 2. Compute the distinct set of scope-category codes the card
    //    lines map to, so the OEWS signal pull is bounded.
    const lineMatches = lines.map((l) => ({
      line: l,
      match: mapRoleToScopeCategory(l.role),
    }));
    const wantedCodes = new Set<string>();
    for (const { match } of lineMatches) {
      if (match) wantedCodes.add(match.scopeCategoryCode);
    }

    const consultedSignalIds = new Set<string>();
    // Corners are kept per (scope_category_code, region) so that
    // each rate-card line can pick the corner that matches its own
    // geography. The resolver below picks the line's preferred
    // region first, then falls back to US-NATIONAL, then to any
    // other region we have data for.
    const cornersByCodeRegion = new Map<string, Map<string, SignalCorner>>();

    if (wantedCodes.size > 0) {
      // Restrict to codes we know we'll consult — keeps the IN list short.
      const inList = Array.from(wantedCodes).filter((c) =>
        ROLE_SCOPE_CATEGORY_CODES.includes(c),
      );
      const codesArr = `ARRAY[${inList.map((c) => `'${c}'`).join(",")}]::text[]`;

      const wageRows = (await db.execute(sql`
        SELECT ms.id,
               ms.scope_category_code,
               ms.scope_region_code,
               ms.value::text AS value,
               ms.observed_at::text AS observed_at,
               ms.collector_id,
               ms.source_url,
               (ms.metadata->>'aggregate') AS aggregate,
               (ms.metadata->>'horizon')   AS horizon
        FROM market_signals ms
        WHERE ms.signal_type = 'wage_benchmark'
          AND ms.scope_category_code = ANY(${sql.raw(codesArr)})
          AND (ms.org_id IS NULL OR ms.org_id = ${orgId})
          AND ms.observed_at >= NOW() - INTERVAL '730 days'
          AND (ms.metadata->>'horizon') = 'hourly'
      `)).rows as unknown as WageSignalRow[];

      // Group by (scope_category_code, region), taking the most-recent
      // observation per aggregate within each (code, region) bucket.
      const tempByCodeRegion = new Map<
        string,
        Map<
          string,
          Map<
            string,
            {
              value: number;
              observedAt: string;
              signalId: string;
              collectorId: string;
              sourceUrl: string;
              region: string | null;
            }
          >
        >
      >();
      for (const r of wageRows) {
        if (!r.aggregate) continue;
        const value = Number(r.value);
        if (!isFinite(value) || value <= 0) continue;
        const regionKey = r.scope_region_code ?? "__null__";
        let perRegion = tempByCodeRegion.get(r.scope_category_code);
        if (!perRegion) {
          perRegion = new Map();
          tempByCodeRegion.set(r.scope_category_code, perRegion);
        }
        let perAgg = perRegion.get(regionKey);
        if (!perAgg) {
          perAgg = new Map();
          perRegion.set(regionKey, perAgg);
        }
        const existing = perAgg.get(r.aggregate);
        if (!existing || r.observed_at > existing.observedAt) {
          perAgg.set(r.aggregate, {
            value,
            observedAt: r.observed_at,
            signalId: r.id,
            collectorId: r.collector_id,
            sourceUrl: r.source_url,
            region: r.scope_region_code,
          });
        }
      }
      for (const [code, perRegion] of tempByCodeRegion) {
        const cornerByRegion = new Map<string, SignalCorner>();
        for (const [regionKey, perAgg] of perRegion) {
          const corner: SignalCorner = {
            signalIds: new Set<string>(),
            scopeRegionCode: null,
          };
          let latestAt = "";
          for (const [agg, obs] of perAgg) {
            corner.signalIds.add(obs.signalId);
            if (agg === "p25") corner.p25 = obs.value;
            if (agg === "median") corner.median = obs.value;
            if (agg === "p75") corner.p75 = obs.value;
            if (agg === "p90") corner.p90 = obs.value;
            if (obs.observedAt > latestAt) {
              latestAt = obs.observedAt;
              corner.latestObservedAt = obs.observedAt;
              corner.latestCollectorId = obs.collectorId;
              corner.latestSourceUrl = obs.sourceUrl;
              corner.scopeRegionCode = obs.region;
            }
          }
          cornerByRegion.set(regionKey, corner);
        }
        cornersByCodeRegion.set(code, cornerByRegion);
      }
    }

    /**
     * Pick the corner whose region best matches the rate-card line's
     * `geography`. Preference order:
     *   1. exact region match (`preferredOewsRegion(line.geography)`)
     *   2. `US-NATIONAL` (the broadest US series)
     *   3. any region we have data for
     * Returns null when there is no signal for the code at all.
     * Side effect: marks the chosen corner's signal IDs as consulted.
     */
    const resolveCornerForLine = (
      code: string,
      lineGeography: string | null,
    ): SignalCorner | null => {
      const perRegion = cornersByCodeRegion.get(code);
      if (!perRegion || perRegion.size === 0) return null;
      const preferred = preferredOewsRegion(lineGeography);
      const tryKeys: string[] = [];
      if (preferred) tryKeys.push(preferred);
      if (preferred !== "US-NATIONAL") tryKeys.push("US-NATIONAL");
      let chosen: SignalCorner | null = null;
      for (const k of tryKeys) {
        const c = perRegion.get(k);
        if (c) {
          chosen = c;
          break;
        }
      }
      if (!chosen) {
        // First arbitrary region with data.
        chosen = perRegion.values().next().value ?? null;
      }
      if (chosen) {
        for (const id of chosen.signalIds) consultedSignalIds.add(id);
      }
      return chosen;
    };

    // 3. Trailing-12 hours per (supplier, role[, seniority]). The
    //    spec sizes above-market lines on hours actually worked at
    //    the matching role/seniority, NOT on the rate-card line ID
    //    (which time entries don't always carry).
    const hoursRows = (await db.execute(sql`
      SELECT te.supplier_id,
             te.role,
             te.seniority,
             SUM(te.hours::numeric)::text AS total_hours,
             COALESCE(SUM(te.amount_usd::numeric), 0)::text AS total_amount
      FROM time_entries te
      WHERE te.org_id = ${orgId}
        AND te.work_date >= NOW() - make_interval(days => ${FALLBACK_HOURS_LOOKBACK_DAYS})
        AND te.role IS NOT NULL
      GROUP BY te.supplier_id, te.role, te.seniority
    `)).rows as unknown as TimeEntryAggRow[];

    const norm = (s: string | null | undefined) =>
      (s ?? "").trim().toLowerCase();
    const roleHoursKey = (
      supplier: string,
      role: string | null,
      seniority: string | null,
    ) => `${supplier}::${norm(role)}::${norm(seniority)}`;
    // Both the role+seniority specific bucket and a role-only roll-up
    // are stored — when a card line has no seniority the role-only
    // sum is the right grain.
    const hoursByRole = new Map<string, number>();
    const hoursByRoleOnly = new Map<string, number>();
    const supplierTotalHours = new Map<string, number>();
    for (const h of hoursRows) {
      const hrs = Number(h.total_hours);
      if (!isFinite(hrs) || hrs <= 0) continue;
      const k = roleHoursKey(h.supplier_id, h.role, h.seniority);
      hoursByRole.set(k, (hoursByRole.get(k) ?? 0) + hrs);
      const kRoleOnly = roleHoursKey(h.supplier_id, h.role, null);
      hoursByRoleOnly.set(
        kRoleOnly,
        (hoursByRoleOnly.get(kRoleOnly) ?? 0) + hrs,
      );
      supplierTotalHours.set(
        h.supplier_id,
        (supplierTotalHours.get(h.supplier_id) ?? 0) + hrs,
      );
    }

    // Fallback hours basis: spend / hourlyRate, assumed 100% labor.
    // Prefer PO-line spend (closer to actually-purchased commitment)
    // over invoice spend; either is used only when no time-entry
    // hours are bound to the line.
    const poSpendRows = (await db.execute(sql`
      SELECT po.supplier_id,
             COALESCE(SUM(pol.extended_usd::numeric), 0)::text AS spend_12mo
      FROM po_lines pol
      JOIN purchase_orders po ON po.id = pol.po_id
      WHERE pol.org_id = ${orgId}
        AND pol.order_date >= NOW() - INTERVAL '365 days'
      GROUP BY po.supplier_id
    `)).rows as unknown as Array<{ supplier_id: string; spend_12mo: string }>;
    const poSpendBySupplier = new Map<string, number>();
    for (const r of poSpendRows) {
      poSpendBySupplier.set(r.supplier_id, Number(r.spend_12mo));
    }
    const invSpendRows = (await db.execute(sql`
      SELECT inv.supplier_id,
             COALESCE(SUM(inv.amount_usd::numeric), 0)::text AS spend_12mo
      FROM invoices inv
      WHERE inv.org_id = ${orgId}
        AND inv.invoice_date >= NOW() - INTERVAL '365 days'
      GROUP BY inv.supplier_id
    `)).rows as unknown as Array<{ supplier_id: string; spend_12mo: string }>;
    const invSpendBySupplier = new Map<string, number>();
    for (const r of invSpendRows) {
      invSpendBySupplier.set(r.supplier_id, Number(r.spend_12mo));
    }

    const drafts: OpportunityDraft[] = [];

    // 4. Above-market detection per rate-card line.
    for (const { line, match } of lineMatches) {
      if (!match) continue;
      const rate = Number(line.hourly_rate);
      if (!isFinite(rate) || rate <= 0) continue;
      const corner = resolveCornerForLine(
        match.scopeCategoryCode,
        line.geography,
      );
      if (!corner) continue;
      if (!rateAboveThreshold(rate, corner, thresholdBand)) continue;
      const p75 = corner.p75 ?? corner.median ?? rate;
      if (rate <= p75) continue;

      // Hours estimate per task spec: trailing-12 time entries
      // bucketed by (supplier, role[, seniority]) — NOT by
      // rate_card_line_id. Falls back to spend ÷ rate when no
      // entries match, apportioned by line count for the supplier
      // so multi-line suppliers don't double-count their fallback
      // hours across every line.
      const lineCount = linesPerSupplier.get(line.supplier_id) ?? 1;
      let estHours =
        hoursByRole.get(
          roleHoursKey(line.supplier_id, line.role, line.seniority),
        ) ??
        hoursByRoleOnly.get(
          roleHoursKey(line.supplier_id, line.role, null),
        ) ??
        0;
      let hoursBasis:
        | "time_entries_role_seniority"
        | "time_entries_role"
        | "po_spend_apportioned"
        | "invoice_spend_apportioned"
        | "none" = estHours > 0
        ? hoursByRole.get(
              roleHoursKey(line.supplier_id, line.role, line.seniority),
            )
          ? "time_entries_role_seniority"
          : "time_entries_role"
        : "none";
      if (estHours <= 0) {
        const poSpend = poSpendBySupplier.get(line.supplier_id) ?? 0;
        if (poSpend > 0) {
          estHours = poSpend / rate / lineCount;
          hoursBasis = "po_spend_apportioned";
        } else {
          const invSpend = invSpendBySupplier.get(line.supplier_id) ?? 0;
          if (invSpend > 0) {
            estHours = invSpend / rate / lineCount;
            hoursBasis = "invoice_spend_apportioned";
          }
        }
      }
      if (estHours <= 0) continue;

      const savings = (rate - p75) * estHours;
      if (savings < MIN_SAVINGS_USD) continue;

      const sources: InsightSource[] = [];
      if (corner.latestCollectorId) {
        const collector = getCollector(corner.latestCollectorId);
        if (collector) {
          sources.push(
            buildInsightSource({
              collectorId: collector.id,
              collectorName: collector.name,
              sourceUrl: corner.latestSourceUrl ?? collector.sourceUrl,
              observedAt: corner.latestObservedAt
                ? new Date(corner.latestObservedAt)
                : new Date(),
              contract: collectorContract(collector),
            }),
          );
        }
      }

      drafts.push({
        leverId: "services_rate_card_benchmark",
        title: `Renegotiate ${line.role}${line.seniority ? ` (${line.seniority})` : ""} rate with ${line.supplier_name} — at/above ${match.label} ${thresholdBand === "p75" ? "75th" : thresholdBand === "p95" ? "95th" : "90th"}-pct wage`,
        rationale: `Rate-card line for ${line.role}${line.seniority ? ` (${line.seniority})` : ""} with ${line.supplier_name} bills at $${rate.toFixed(2)}/hr. The latest BLS OEWS hourly percentiles for ${match.label} (SOC ${match.socCode}${corner.scopeRegionCode ? `, ${corner.scopeRegionCode}` : ""}) place that at or above the configured ${thresholdBand.toUpperCase()} threshold (P75 = $${p75.toFixed(2)}, P90 = $${(corner.p90 ?? rate).toFixed(2)}). Trailing-12 hours estimate ${estHours.toFixed(0)} (basis: ${hoursBasis}). Resetting to the 75th-percentile anchor recovers ~$${savings.toFixed(0)}.`,
        recommendedAction: `Open a fact-based rate-card renegotiation: cite the OEWS ${match.label} P75 of $${p75.toFixed(2)}/hr as the target rate for ${line.role}${line.seniority ? ` (${line.seniority})` : ""}; if the supplier resists, scope the role's volume to a shorter renewal so the next cycle can capture the reset.`,
        supplierId: line.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          flavor: "above_market",
          rateCardLineId: line.id,
          rateCardId: line.rate_card_id,
          supplierId: line.supplier_id,
          role: line.role,
          seniority: line.seniority,
          cardHourlyRate: rate,
          oewsScopeCategoryCode: match.scopeCategoryCode,
          oewsSocCode: match.socCode,
          oewsRegionCode: corner.scopeRegionCode,
          oewsRegionMatch:
            preferredOewsRegion(line.geography) === corner.scopeRegionCode,
          lineGeography: line.geography,
          oewsP25: corner.p25,
          oewsMedian: corner.median,
          oewsP75: corner.p75,
          oewsP90: corner.p90,
          thresholdBand,
          estimatedAnnualHours: estHours,
          hoursBasis,
          consultedSignalIds: Array.from(corner.signalIds),
          sources,
        },
      });
    }

    // 5a. Off-card spend detection on time entries. Group entries by
    //    (supplier, role, seniority, billRateUsd) and check if every
    //    card line for the same role+seniority disagrees by more
    //    than the ±5% tolerance.
    const offCardRows = (await db.execute(sql`
      SELECT te.supplier_id,
             te.role,
             te.seniority,
             te.bill_rate_usd,
             SUM(te.hours::numeric)::text AS total_hours,
             COALESCE(SUM(te.amount_usd::numeric), 0)::text AS total_amount,
             COUNT(*)::text AS entry_count
      FROM time_entries te
      WHERE te.org_id = ${orgId}
        AND te.work_date >= NOW() - make_interval(days => ${FALLBACK_HOURS_LOOKBACK_DAYS})
        AND te.bill_rate_usd IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM rate_cards rc
          WHERE rc.org_id = ${orgId} AND rc.supplier_id = te.supplier_id
        )
      GROUP BY te.supplier_id, te.role, te.seniority, te.bill_rate_usd
    `)).rows as unknown as OffCardRow[];

    // Index card lines by (supplier, role.lower, seniority?.lower)
    const cardLinesBySupplierRole = new Map<string, RateCardLineRow[]>();
    for (const l of lines) {
      const key = `${l.supplier_id}:${(l.role ?? "").toLowerCase()}`;
      const arr = cardLinesBySupplierRole.get(key) ?? [];
      arr.push(l);
      cardLinesBySupplierRole.set(key, arr);
    }

    for (const r of offCardRows) {
      const billRate = Number(r.bill_rate_usd);
      if (!isFinite(billRate) || billRate <= 0) continue;
      if (!r.role) continue;
      const key = `${r.supplier_id}:${r.role.toLowerCase()}`;
      const candidates = (cardLinesBySupplierRole.get(key) ?? []).filter((c) => {
        if (!r.seniority || !c.seniority) return true;
        return c.seniority.toLowerCase() === r.seniority.toLowerCase();
      });
      if (candidates.length === 0) continue;
      // Within ±5% of any card line for matching role+seniority?
      let matchedCard: RateCardLineRow | null = null;
      let closest: RateCardLineRow | null = null;
      let closestDelta = Infinity;
      for (const c of candidates) {
        const cardRate = Number(c.hourly_rate);
        if (!isFinite(cardRate) || cardRate <= 0) continue;
        const delta = Math.abs(billRate - cardRate) / cardRate;
        if (delta <= OFF_CARD_TOLERANCE) {
          matchedCard = c;
          break;
        }
        if (delta < closestDelta) {
          closestDelta = delta;
          closest = c;
        }
      }
      if (matchedCard) continue;
      if (!closest) continue;
      const cardRate = Number(closest.hourly_rate);
      const hours = Number(r.total_hours);
      const delta = billRate - cardRate;
      if (delta <= 0) continue;
      const savings = delta * hours;
      if (savings < MIN_SAVINGS_USD) continue;
      drafts.push({
        leverId: "services_rate_card_benchmark",
        title: `Off-card billing: ${closest.supplier_name} billed ${r.role}${r.seniority ? ` (${r.seniority})` : ""} at $${billRate.toFixed(2)}/hr — card rate $${cardRate.toFixed(2)}`,
        rationale: `${r.entry_count} time entries from ${closest.supplier_name} for ${r.role}${r.seniority ? ` (${r.seniority})` : ""} cleared at $${billRate.toFixed(2)}/hr (${hours.toFixed(0)} total hrs in last 12 months). The active rate card prices the same role at $${cardRate.toFixed(2)}/hr — outside the ±${(OFF_CARD_TOLERANCE * 100).toFixed(0)}% tolerance. Recovering the delta on observed hours is ~$${savings.toFixed(0)}.`,
        recommendedAction: `Issue a recovery / credit-memo request to ${closest.supplier_name} for the rate delta on the observed off-card hours; require future entries to bind to a rate-card line at AP intake.`,
        supplierId: closest.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          flavor: "off_card",
          rateCardLineId: closest.id,
          rateCardId: closest.rate_card_id,
          supplierId: closest.supplier_id,
          role: r.role,
          seniority: r.seniority,
          cardHourlyRate: cardRate,
          billedHourlyRate: billRate,
          deltaUsd: delta,
          observedHours: hours,
          observedAmountUsd: Number(r.total_amount),
          tolerance: OFF_CARD_TOLERANCE,
          entryCount: Number(r.entry_count),
        },
      });
    }

    // 5b. Off-card spend detection on PO lines. Restrict to labor-
    //    shaped UOMs ('hour', 'hr', 'hrs', 'hours', 'day', 'days')
    //    so a $200/hr office-supply line can't masquerade as labor.
    //    Suppliers with no rate card on file are filtered out — the
    //    lever has no anchor to compare against.
    const poOffCardRows = (await db.execute(sql`
      SELECT pol.id            AS po_line_id,
             pol.po_id,
             po.supplier_id,
             pol.description,
             pol.uom,
             pol.unit_price_usd,
             pol.qty,
             pol.extended_usd
      FROM po_lines pol
      JOIN purchase_orders po ON po.id = pol.po_id
      WHERE pol.org_id = ${orgId}
        AND pol.unit_price_usd IS NOT NULL
        AND pol.order_date >= NOW() - INTERVAL '365 days'
        AND LOWER(COALESCE(pol.uom, '')) IN
          ('hour','hr','hrs','hours','day','days')
        AND EXISTS (
          SELECT 1 FROM rate_cards rc
          WHERE rc.org_id = ${orgId} AND rc.supplier_id = po.supplier_id
        )
    `)).rows as unknown as Array<{
      po_line_id: string;
      po_id: string;
      supplier_id: string;
      description: string;
      uom: string | null;
      unit_price_usd: string;
      qty: string;
      extended_usd: string;
    }>;

    // Index ALL card lines per supplier (regardless of role) for the
    // PO-line check — PO lines don't carry role/seniority, so we
    // compare against any line that has a hourly/daily rate.
    const cardLinesBySupplier = new Map<string, RateCardLineRow[]>();
    for (const l of lines) {
      const arr = cardLinesBySupplier.get(l.supplier_id) ?? [];
      arr.push(l);
      cardLinesBySupplier.set(l.supplier_id, arr);
    }

    for (const r of poOffCardRows) {
      const billRate = Number(r.unit_price_usd);
      if (!isFinite(billRate) || billRate <= 0) continue;
      const supplierLines = cardLinesBySupplier.get(r.supplier_id) ?? [];
      if (supplierLines.length === 0) continue;
      const uom = (r.uom ?? "").toLowerCase();
      const isDaily = uom === "day" || uom === "days";
      // Pick comparison rate per UOM: hourly_rate for hours, daily_rate
      // for days. Skip lines that don't carry the matching rate.
      let matched = false;
      let closestRate = Infinity;
      let closestLine: RateCardLineRow | null = null;
      for (const c of supplierLines) {
        const cardRateRaw = isDaily ? null : c.hourly_rate;
        const cardRate = cardRateRaw == null ? null : Number(cardRateRaw);
        if (cardRate == null || !isFinite(cardRate) || cardRate <= 0) continue;
        const delta = Math.abs(billRate - cardRate) / cardRate;
        if (delta <= OFF_CARD_TOLERANCE) {
          matched = true;
          break;
        }
        if (delta < (isFinite(closestRate) ? closestRate : Infinity)) {
          closestRate = delta;
          closestLine = c;
        }
      }
      if (matched) continue;
      if (!closestLine || !closestLine.hourly_rate) continue;
      const cardRate = Number(closestLine.hourly_rate);
      const qty = Number(r.qty);
      const delta = billRate - cardRate;
      if (delta <= 0) continue;
      const savings = delta * qty;
      if (savings < MIN_SAVINGS_USD) continue;
      drafts.push({
        leverId: "services_rate_card_benchmark",
        title: `Off-card PO billing: ${closestLine.supplier_name} PO line "${r.description.slice(0, 60)}" billed at $${billRate.toFixed(2)}/${uom || "unit"} — card rate $${cardRate.toFixed(2)}`,
        rationale: `PO line ${r.po_line_id} from ${closestLine.supplier_name} (${qty.toFixed(0)} ${uom || "units"} at $${billRate.toFixed(2)}, $${Number(r.extended_usd).toFixed(0)} extended) is outside the ±${(OFF_CARD_TOLERANCE * 100).toFixed(0)}% tolerance against the closest active rate-card line ($${cardRate.toFixed(2)}/hr, ${closestLine.role}${closestLine.seniority ? ` ${closestLine.seniority}` : ""}). Resetting to the card rate on the observed quantity recovers ~$${savings.toFixed(0)}.`,
        recommendedAction: `Issue a PO-amendment / credit-memo request to ${closestLine.supplier_name} for the rate delta on PO line ${r.po_line_id}; require future labor POs to reference a rate-card line ID at PO creation.`,
        supplierId: closestLine.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          flavor: "off_card_po",
          rateCardLineId: closestLine.id,
          rateCardId: closestLine.rate_card_id,
          supplierId: closestLine.supplier_id,
          poLineId: r.po_line_id,
          poId: r.po_id,
          uom,
          cardHourlyRate: cardRate,
          billedUnitPriceUsd: billRate,
          deltaUsd: delta,
          observedQty: qty,
          observedExtendedUsd: Number(r.extended_usd),
          tolerance: OFF_CARD_TOLERANCE,
        },
      });
    }

    // 5c. Off-card detection on invoices. Invoices in this schema are
    //    header-level (single `amount_usd`), so we recover an implied
    //    bill rate by bucketing per (supplier, calendar month) and
    //    dividing total invoice spend by total time-entry hours in
    //    the same month. If the implied rate is outside ±5% of every
    //    hourly card line for that supplier, we flag the month.
    //    Months with no time-entry hours are skipped (no anchor for
    //    the implied rate).
    const invoiceImpliedRows = (await db.execute(sql`
      WITH inv_month AS (
        SELECT inv.supplier_id,
               date_trunc('month', inv.invoice_date) AS month,
               SUM(inv.amount_usd::numeric) AS total_amount
        FROM invoices inv
        WHERE inv.org_id = ${orgId}
          AND inv.invoice_date >= NOW() - INTERVAL '365 days'
          AND inv.status IN ('received', 'approved', 'paid')
        GROUP BY inv.supplier_id, date_trunc('month', inv.invoice_date)
      ),
      te_month AS (
        SELECT te.supplier_id,
               date_trunc('month', te.work_date) AS month,
               SUM(te.hours::numeric) AS total_hours
        FROM time_entries te
        WHERE te.org_id = ${orgId}
          AND te.work_date >= NOW() - INTERVAL '365 days'
        GROUP BY te.supplier_id, date_trunc('month', te.work_date)
      )
      SELECT inv_month.supplier_id,
             to_char(inv_month.month, 'YYYY-MM')         AS month,
             inv_month.total_amount::text                AS total_amount,
             te_month.total_hours::text                  AS total_hours
      FROM inv_month
      JOIN te_month
        ON te_month.supplier_id = inv_month.supplier_id
       AND te_month.month       = inv_month.month
      WHERE te_month.total_hours > 0
        AND EXISTS (
          SELECT 1 FROM rate_cards rc
          WHERE rc.org_id = ${orgId}
            AND rc.supplier_id = inv_month.supplier_id
        )
    `)).rows as unknown as Array<{
      supplier_id: string;
      month: string;
      total_amount: string;
      total_hours: string;
    }>;

    for (const r of invoiceImpliedRows) {
      const totalAmount = Number(r.total_amount);
      const totalHours = Number(r.total_hours);
      if (
        !isFinite(totalAmount) ||
        !isFinite(totalHours) ||
        totalAmount <= 0 ||
        totalHours <= 0
      ) {
        continue;
      }
      const impliedRate = totalAmount / totalHours;
      const supplierLines = cardLinesBySupplier.get(r.supplier_id) ?? [];
      if (supplierLines.length === 0) continue;
      let matched = false;
      let closestDelta = Infinity;
      let closestLine: RateCardLineRow | null = null;
      for (const c of supplierLines) {
        const cardRate = c.hourly_rate == null ? null : Number(c.hourly_rate);
        if (cardRate == null || !isFinite(cardRate) || cardRate <= 0) continue;
        const delta = Math.abs(impliedRate - cardRate) / cardRate;
        if (delta <= OFF_CARD_TOLERANCE) {
          matched = true;
          break;
        }
        if (delta < closestDelta) {
          closestDelta = delta;
          closestLine = c;
        }
      }
      if (matched || !closestLine || !closestLine.hourly_rate) continue;
      const cardRate = Number(closestLine.hourly_rate);
      const delta = impliedRate - cardRate;
      if (delta <= 0) continue;
      const savings = delta * totalHours;
      if (savings < MIN_SAVINGS_USD) continue;
      drafts.push({
        leverId: "services_rate_card_benchmark",
        title: `Off-card invoiced billing in ${r.month}: ${closestLine.supplier_name} implied $${impliedRate.toFixed(2)}/hr — card rate $${cardRate.toFixed(2)}`,
        rationale: `Invoiced spend with ${closestLine.supplier_name} in ${r.month} totalled $${totalAmount.toFixed(0)} against ${totalHours.toFixed(0)} time-entry hours, implying a blended bill rate of $${impliedRate.toFixed(2)}/hr — outside the ±${(OFF_CARD_TOLERANCE * 100).toFixed(0)}% tolerance against the closest card line ($${cardRate.toFixed(2)}/hr, ${closestLine.role}${closestLine.seniority ? ` ${closestLine.seniority}` : ""}). Resetting to the card rate on the invoiced hours recovers ~$${savings.toFixed(0)} for that month.`,
        recommendedAction: `Open an invoice-rate audit with ${closestLine.supplier_name}: reconcile ${r.month} timesheets against the active card; require future invoices to call out role/seniority and reference the card line ID per timesheet.`,
        supplierId: closestLine.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          flavor: "off_card_invoice",
          rateCardLineId: closestLine.id,
          rateCardId: closestLine.rate_card_id,
          supplierId: closestLine.supplier_id,
          month: r.month,
          impliedHourlyRateUsd: impliedRate,
          cardHourlyRate: cardRate,
          deltaUsd: delta,
          observedAmountUsd: totalAmount,
          observedHours: totalHours,
          tolerance: OFF_CARD_TOLERANCE,
        },
      });
    }

    const result: AnalyzeResult = {
      drafts,
      consultedSignalIds: Array.from(consultedSignalIds),
      candidatesEvaluated:
        lines.length +
        offCardRows.length +
        poOffCardRows.length +
        invoiceImpliedRows.length,
    };
    return result;
  },
};
