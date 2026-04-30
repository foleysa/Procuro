/**
 * Evidence assembly for Defense Pack generation.
 *
 * Given a target (supplier + at least one of contract line / category /
 * material) and the active tenant policy, this module pulls the recent
 * `marketSignalsTable` rows that are eligible to back a citation.
 *
 * Eligibility rules:
 *  - Tenant scope: row.org_id = tenant OR row.org_id IS NULL (same as
 *    every other Fusion Center query).
 *  - Disclosure tier: only T1/T2 rows are admitted to the evidence
 *    pool. Conservative tenants see [T1, T2]; standard sees [T1, T2]
 *    (T3 ride along ONLY for the narrative-context paragraph, never as
 *    citations); analyst sees [T1, T2] for citations + T3 narrative.
 *    T4 rows never enter the evidence pool. Rationale: a memo a buyer
 *    takes into a negotiation must cite verifiable, attributable
 *    evidence — gray-hat / inferred sources are excluded by design.
 *  - Recency: only rows within the lookback window (default 365 days).
 *  - Scope match: each row must match at least one of the target's
 *    scope axes (supplier name, category code, material code).
 *
 * The returned snapshot is what the verifier checks claims against and
 * what gets persisted into `defense_packs.evidence_snapshot` as the
 * frozen Evidence Room state.
 */

import {
  db,
  marketSignalsTable,
  type MarketSignalRow,
  type MarketSignalType,
} from "@workspace/db";
import { and, desc, eq, gte, isNull, or, type SQL } from "drizzle-orm";
import type {
  DefensePackEvidenceSnapshotItem,
  DefensePackTarget,
} from "@workspace/db";
import type { TenantPolicy, DisclosureTier } from "@workspace/intelligence";
import { getCollector } from "../intelligence/runtime";
import type { IntelligenceCollector } from "../intelligence/collector";

/** Signal types eligible to back a procurement-memo claim. */
export const EVIDENCE_SIGNAL_TYPES: ReadonlyArray<MarketSignalType> = [
  "commodity_index",
  "freight_rate",
  "marketplace_price",
  "public_bid_award",
  "customs_trade",
  "supplier_financial",
  "supplier_risk_news",
  "services_rate_card",
  "economic_index",
  "fx_rate",
  "corporate_filing",
  "sanctions_match",
  "facility_emissions",
  "natural_hazard",
  "event_geocoded",
];

/** Tiers that may back a Defense Pack CITATION (never includes T3/T4). */
const CITATION_TIERS: ReadonlyArray<DisclosureTier> = ["T1", "T2"];

/** Tiers that may inform the narrative-only T3 paragraph. */
function narrativeTiersForPolicy(
  policy: TenantPolicy,
): ReadonlyArray<DisclosureTier> {
  if (policy === "conservative") return [];
  // standard + analyst tenants get a single T3 narrative paragraph.
  return ["T3"];
}

export interface EvidencePool {
  /** Rows verified to be T1/T2; eligible to back a claim. */
  citationItems: DefensePackEvidenceSnapshotItem[];
  /** Rows verified to be T3; eligible only for narrative paragraph. */
  narrativeItems: DefensePackEvidenceSnapshotItem[];
}

function tenantScopeCondition(orgId: string): SQL {
  return or(
    eq(marketSignalsTable.orgId, orgId),
    isNull(marketSignalsTable.orgId),
  )!;
}

function buildSnapshotItem(
  row: MarketSignalRow,
  collector: IntelligenceCollector | undefined,
): DefensePackEvidenceSnapshotItem {
  const tier: DisclosureTier = collector?.disclosureTier ?? "T4";
  return {
    signalId: row.id,
    collectorId: row.collectorId,
    collectorName: collector?.name ?? row.collectorId,
    signalType: row.signalType,
    tier,
    scope: {
      materialCode: row.scopeMaterialCode,
      categoryCode: row.scopeCategoryCode,
      supplierName: row.scopeSupplierName,
      laneKey: row.scopeLaneKey,
      sku: row.scopeSku,
    },
    value: Number(row.value),
    unit: row.unit,
    currency: row.currency,
    observedAt: row.observedAt.toISOString(),
    sourceUrl: row.sourceUrl,
    posture: row.posture,
  };
}

export interface AssembleEvidenceArgs {
  orgId: string;
  target: DefensePackTarget;
  policy: TenantPolicy;
  /** Days to look back. Default 365 — most macro indices update yearly. */
  lookbackDays?: number;
  /** Cap on rows pulled per pool. Default 30. */
  perPoolLimit?: number;
}

/**
 * Assemble the evidence pool for a Defense Pack. Returns the rows
 * eligible to back claims (T1/T2) plus T3 rows that may inform the
 * narrative-only context paragraph.
 *
 * The function does NOT call out to any LLM or persist anything — it is
 * pure DB read + in-memory tier filtering, so it is safe to call from
 * tests and from a dry-run/preview surface in the future.
 */
export async function assembleEvidence(
  args: AssembleEvidenceArgs,
): Promise<EvidencePool> {
  const { orgId, target, policy } = args;
  const lookbackDays = args.lookbackDays ?? 365;
  const perPoolLimit = args.perPoolLimit ?? 30;

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  // OR over scope axes — at least one of (supplier, material, category)
  // must match. We deliberately don't include `scope_lane_key` or
  // `scope_sku` here because Defense Pack targets are
  // supplier/material/category centric.
  const scopeMatchers: SQL[] = [];
  if (target.supplierName) {
    scopeMatchers.push(
      eq(marketSignalsTable.scopeSupplierName, target.supplierName),
    );
  }
  if (target.materialCode) {
    scopeMatchers.push(
      eq(marketSignalsTable.scopeMaterialCode, target.materialCode),
    );
  }
  if (target.categoryCode) {
    scopeMatchers.push(
      eq(marketSignalsTable.scopeCategoryCode, target.categoryCode),
    );
  }
  if (scopeMatchers.length === 0) {
    return { citationItems: [], narrativeItems: [] };
  }

  const where = and(
    tenantScopeCondition(orgId),
    gte(marketSignalsTable.observedAt, since),
    or(...scopeMatchers)!,
  );

  // Over-fetch and tier-filter in JS (we don't have collector tier in
  // the DB, only in the in-process registry).
  const rows = await db
    .select()
    .from(marketSignalsTable)
    .where(where)
    .orderBy(desc(marketSignalsTable.observedAt))
    .limit(Math.min(perPoolLimit * 6, 200));

  const eligibleSignalTypes = new Set<string>(EVIDENCE_SIGNAL_TYPES);
  const citationItems: DefensePackEvidenceSnapshotItem[] = [];
  const narrativeItems: DefensePackEvidenceSnapshotItem[] = [];
  const narrativeTiers = new Set<DisclosureTier>(
    narrativeTiersForPolicy(policy),
  );
  const citationTiers = new Set<DisclosureTier>(CITATION_TIERS);
  const seenCitationKeys = new Set<string>();

  for (const row of rows) {
    if (!eligibleSignalTypes.has(row.signalType)) continue;
    const collector = getCollector(row.collectorId);
    const item = buildSnapshotItem(row, collector);
    if (citationTiers.has(item.tier)) {
      // Dedupe by (collectorId, signalType, scope*, observedAt) so a
      // redundant fixture row doesn't crowd out other evidence.
      const key = [
        item.collectorId,
        item.signalType,
        item.scope.materialCode ?? "",
        item.scope.categoryCode ?? "",
        item.scope.supplierName ?? "",
        item.observedAt,
      ].join("|");
      if (seenCitationKeys.has(key)) continue;
      seenCitationKeys.add(key);
      if (citationItems.length < perPoolLimit) citationItems.push(item);
    } else if (narrativeTiers.has(item.tier)) {
      if (narrativeItems.length < perPoolLimit) narrativeItems.push(item);
    }
  }

  return { citationItems, narrativeItems };
}
