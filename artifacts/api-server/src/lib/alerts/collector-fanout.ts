/**
 * Collector-output → tenant-alert fan-out.
 *
 * Called from `runCollector` after a successful run, with the drafts
 * that were just persisted. We pick out signal types that warrant a
 * tenant alert (sanctions hits, corporate filings on watched suppliers,
 * geocoded disruption events, natural-hazard thresholds, etc.) and
 * call `createAlert` per matching tenant.
 *
 * Tenant matching:
 *   - If the draft carries `entityUid`, any tenant whose `suppliers`
 *     row points at that uid via `metadata.entityUid` matches.
 *   - Else if the draft carries `scopeSupplierName`, any tenant whose
 *     supplier `name` matches case-insensitively gets the alert.
 *   - Otherwise the signal is org-agnostic (commodity prices, FX) and
 *     no tenant alert is fanned out — those go to the OODA cycle, not
 *     the alerts inbox.
 *
 * Deliberately fail-soft: a fan-out exception is logged but never
 * raised back into `runCollector`, because (a) the collector run has
 * already succeeded and (b) we never want a flaky alerts table to
 * block intelligence ingestion.
 */

import {
  db,
  suppliersTable,
  type CollectorRow,
  type AlertSeverity,
  type AlertSource,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  createAlert,
  evaluateRulesForSignal,
} from "@workspace/intelligence";
import { logger } from "../logger";

/**
 * Subset of `MarketSignalDraft` we depend on. Re-declared locally so
 * this module doesn't have to import the runtime's draft type and
 * thereby create a circular dependency.
 *
 * `marketSignalId` is the persisted `market_signals.id` of the row this
 * draft was inserted as (when known). Stamped into `payload.marketSignalId`
 * so the alert can cross-link to the same row in the Fusion war-room
 * event stream (`GET /intelligence/events`, Task #161). Optional because
 * not every fan-out caller emits a war-room-eligible signal.
 */
export interface CollectorFanoutDraft {
  signalType: string;
  scopeSupplierName?: string | null | undefined;
  entityUid?: string | null | undefined;
  observedAt: Date;
  sourceUrl: string;
  metadata?: Record<string, unknown> | null | undefined;
  value: number | string;
  unit: string;
  marketSignalId?: string | null | undefined;
}

/**
 * Map signal_type → (alert source, default severity, kind, title fn).
 * Anything not in this map is org-agnostic and not fanned out.
 */
interface FanoutSpec {
  source: AlertSource;
  severity: AlertSeverity;
  kind: string;
  buildTitle: (d: CollectorFanoutDraft) => string;
  buildSummary: (d: CollectorFanoutDraft) => string;
}

export const FANOUT_BY_SIGNAL_TYPE: Record<string, FanoutSpec> = {
  sanctions_match: {
    source: "sanctions",
    severity: "critical",
    kind: "sanctions_match",
    buildTitle: (d) =>
      `Sanctions hit on ${d.scopeSupplierName ?? "supplier"}`,
    buildSummary: (d) =>
      `Sanctions list match observed at ${d.observedAt.toISOString()}. Source: ${d.sourceUrl}`,
  },
  risk_screening_match: {
    source: "risk_screening",
    severity: "high",
    kind: "risk_screening_match",
    buildTitle: (d) =>
      `Risk-screening hit on ${d.scopeSupplierName ?? "supplier"}`,
    buildSummary: (d) =>
      `Adverse-media / PEP / risk-screening match observed at ${d.observedAt.toISOString()}.`,
  },
  corporate_filing: {
    source: "corporate_filing",
    severity: "medium",
    kind: "corporate_filing",
    buildTitle: (d) =>
      `Corporate filing detected: ${d.scopeSupplierName ?? "supplier"}`,
    buildSummary: (d) =>
      `New corporate filing observed at ${d.observedAt.toISOString()}. Source: ${d.sourceUrl}`,
  },
  event_geocoded: {
    source: "disruption_event",
    severity: "medium",
    kind: "event_geocoded",
    buildTitle: (d) =>
      `Disruption event near ${d.scopeSupplierName ?? "watched supplier"}`,
    buildSummary: (d) =>
      `Geocoded event observed at ${d.observedAt.toISOString()}. Goldstein/severity: ${String(d.value)}.`,
  },
  natural_hazard: {
    source: "natural_hazard",
    severity: "high",
    kind: "natural_hazard",
    buildTitle: (d) =>
      `Natural hazard near ${d.scopeSupplierName ?? "watched supplier"}`,
    buildSummary: (d) =>
      `Hazard alert observed at ${d.observedAt.toISOString()}. Severity proxy: ${String(d.value)} ${d.unit}.`,
  },
  environmental_violation: {
    source: "risk_screening",
    severity: "high",
    kind: "environmental_violation",
    buildTitle: (d) =>
      `EPA enforcement against ${d.scopeSupplierName ?? "supplier"}`,
    buildSummary: (d) =>
      `Environmental enforcement case observed at ${d.observedAt.toISOString()}. Source: ${d.sourceUrl}`,
  },
  workplace_safety_incident: {
    source: "risk_screening",
    severity: "medium",
    kind: "workplace_safety_incident",
    buildTitle: (d) =>
      `OSHA inspection of ${d.scopeSupplierName ?? "supplier"}`,
    buildSummary: (d) =>
      `Workplace-safety inspection observed at ${d.observedAt.toISOString()}. Source: ${d.sourceUrl}`,
  },
};

interface FanoutCounts {
  draftsConsidered: number;
  alertsCreated: number;
}

export async function fanOutCollectorAlerts(args: {
  collector: CollectorRow;
  drafts: CollectorFanoutDraft[];
}): Promise<FanoutCounts> {
  const counts: FanoutCounts = { draftsConsidered: 0, alertsCreated: 0 };
  for (const draft of args.drafts) {
    const spec = FANOUT_BY_SIGNAL_TYPE[draft.signalType];
    if (!spec) continue;
    counts.draftsConsidered += 1;
    try {
      counts.alertsCreated += await fanOutOne(args.collector, draft, spec);
    } catch (err) {
      logger.warn(
        {
          collectorId: args.collector.id,
          signalType: draft.signalType,
          err: (err as Error).message,
        },
        "Alert fan-out failed for draft",
      );
    }
  }
  return counts;
}

async function fanOutOne(
  collector: CollectorRow,
  draft: CollectorFanoutDraft,
  spec: FanoutSpec,
): Promise<number> {
  // Resolve matching tenant suppliers. Each tenant supplier becomes a
  // separate alert so the inbox / supplier drawer renders correctly.
  const matches = await resolveTenantSuppliers(draft);
  if (matches.length === 0) return 0;

  let created = 0;
  for (const match of matches) {
    // Stable dedupe key: the same upstream observation (collector +
    // sourceUrl + observedAt + supplier) collapses into one alert with
    // bumped occurrences across re-runs.
    const dedupeKey = [
      "coll",
      collector.id,
      spec.kind,
      match.orgId,
      match.supplierId,
      draft.observedAt.toISOString(),
    ].join(":");

    const ruleMatches = await evaluateRulesForSignal(match.orgId, {
      source: spec.source,
      severity: spec.severity,
      supplierId: match.supplierId,
      entityUid: draft.entityUid ?? null,
    });
    let effectiveSeverity = spec.severity;
    let effectiveSource: AlertSource = spec.source;
    if (ruleMatches.length > 0) {
      const top = ruleMatches.reduce((a, b) =>
        severityRank(a.effectiveSeverity) >= severityRank(b.effectiveSeverity)
          ? a
          : b,
      );
      effectiveSeverity = top.effectiveSeverity;
      effectiveSource = "rule_match";
    }

    await createAlert({
      orgId: match.orgId,
      severity: effectiveSeverity,
      source: effectiveSource,
      kind: spec.kind,
      title: spec.buildTitle(draft),
      summary: spec.buildSummary(draft),
      dedupeKey,
      payload: {
        collectorId: collector.id,
        signalType: draft.signalType,
        observedAt: draft.observedAt.toISOString(),
        sourceUrl: draft.sourceUrl,
        value: draft.value,
        unit: draft.unit,
        ...(draft.metadata ?? {}),
        // Cross-link to the Fusion war-room event stream (Task #161).
        // The persisted `market_signals.id` is the same id the war room
        // uses; surfacing it here lets the alert detail view deep-link
        // back to the originating event, and lets the war room query
        // alerts triggered by a given event via
        // `GET /alerts?marketSignalId=<id>` (a `payload->>marketSignalId`
        // JSONB filter). `marketSignalIds` is an array form so future
        // multi-signal alerts can fan multiple events into one row
        // without breaking the existing single-id readers.
        ...(draft.marketSignalId
          ? {
              marketSignalId: draft.marketSignalId,
              marketSignalIds: [draft.marketSignalId],
            }
          : {}),
        sources: [
          {
            kind: "collector",
            collectorId: collector.id,
            url: draft.sourceUrl,
            label: collector.name,
            observedAt: draft.observedAt.toISOString(),
            disclosureTier: collector.posture,
          },
        ],
      },
      supplierId: match.supplierId,
      entityUid: draft.entityUid ?? null,
    });
    created += 1;
  }
  return created;
}

interface TenantSupplierMatch {
  orgId: string;
  supplierId: string;
}

async function resolveTenantSuppliers(
  draft: CollectorFanoutDraft,
): Promise<TenantSupplierMatch[]> {
  // The suppliers table stores `normalizedName`; we lowercase the
  // collector's supplier-name scope and compare against it for a
  // direct match. `entityUid` resolution against per-tenant suppliers
  // would require a join through `entityResolutionCache` which is
  // intentionally global; for now we surface the alert via the name
  // path only and let watchlists carry the entity-uid path explicitly
  // (a watchlist member can declare `entityUid`).
  if (!draft.scopeSupplierName) return [];
  const needle = normalizeSupplierName(draft.scopeSupplierName);
  if (!needle) return [];
  const rows = await db
    .select({
      orgId: suppliersTable.orgId,
      supplierId: suppliersTable.id,
    })
    .from(suppliersTable)
    .where(eq(suppliersTable.normalizedName, needle));
  // De-dupe defensively in case the same (orgId, supplierId) appears
  // via more than one row variant in future.
  const seen = new Set<string>();
  return rows.filter((m) => {
    const k = `${m.orgId}|${m.supplierId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Match the suppliers table's `normalized_name` convention: lowercase,
 * trim, collapse whitespace. Mirrors the ingestion path's normalizer
 * so a supplier created from CSV "Acme Corp Ltd " resolves to the
 * same key as a collector emitting "acme corp ltd".
 */
function normalizeSupplierName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function severityRank(s: AlertSeverity): number {
  return SEVERITY_RANK[s];
}
