/**
 * Disclosure-tier renderer.
 *
 * Given a list of sources backing an insight + the tenant's disclosure
 * policy, returns the tier-appropriate citations + a label for the UI.
 *
 * The rules:
 *   - T1 sources surface their source name + URL (full attribution).
 *   - T2 sources surface a generic source category + jurisdiction.
 *   - T3 sources surface a class label + numeric confidence only.
 *   - T4 sources never appear in the citation list — they only contribute
 *     to the aggregate confidence boost.
 *
 * Tenant policies:
 *   - `conservative` → only T1 + T2 visible. Raises insight visibility
 *                       only if at least one T1/T2 source is present.
 *   - `standard`     → T1 + T2 + T3 visible.
 *   - `analyst`      → all tiers visible, with full provenance metadata.
 */

import type {
  DisclosureTier,
  SignalSource,
  TenantPolicy,
} from "../contracts/index.js";

export interface Citation {
  tier: DisclosureTier;
  /** Human-readable label suitable for direct display to the user. */
  label: string;
  /** Optional URL — only set for T1 (and `analyst` policy on T2+). */
  url: string | null;
  /** Always set for `analyst`; null for the other policies. */
  provenance: ProvenanceTrail | null;
}

export interface ProvenanceTrail {
  collectorId: string;
  collectorName: string;
  sourceUrl: string;
  observedAt: string;
  postureClass: string;
}

export interface RenderedInsight {
  visible: boolean;
  /** Highest tier surfaced. `T4` means "no public tier in the citation list". */
  tier: DisclosureTier;
  citations: Citation[];
  /**
   * Compact one-liner for the UI header, e.g. "Backed by 2 public-API
   * sources" / "Backed by 1 source category".
   */
  label: string;
}

const TIER_RANK: Record<DisclosureTier, number> = {
  T1: 4,
  T2: 3,
  T3: 2,
  T4: 1,
};

function highestTier(tiers: readonly DisclosureTier[]): DisclosureTier {
  let best: DisclosureTier = "T4";
  for (const t of tiers) {
    if (TIER_RANK[t] > TIER_RANK[best]) best = t;
  }
  return best;
}

function isVisibleForPolicy(
  tier: DisclosureTier,
  policy: TenantPolicy,
): boolean {
  if (tier === "T4") return false;
  if (policy === "conservative") return tier === "T1" || tier === "T2";
  // standard and analyst both see T1/T2/T3 (T4 already filtered above).
  return true;
}

function jurisdictionLabel(j: string): string {
  if (j === "GLOBAL") return "global";
  return j.toUpperCase();
}

function renderT1(s: SignalSource): Citation {
  return {
    tier: "T1",
    label: s.collectorName,
    url: s.sourceUrl,
    provenance: null,
  };
}

function renderT2(s: SignalSource): Citation {
  // Generic category — never the source name. Composed from the posture
  // class + jurisdiction so the user sees "public-api source • US" rather
  // than "FRED" when the tenant policy hides full attribution.
  const category =
    s.contract.postureClass === "public_api"
      ? "public-api source"
      : s.contract.postureClass === "tos_restricted"
        ? "permitted-crawl source"
        : "internal source";
  return {
    tier: "T2",
    label: `${category} • ${jurisdictionLabel(s.contract.jurisdiction)}`,
    url: null,
    provenance: null,
  };
}

function renderT3(s: SignalSource, confidence: number): Citation {
  const conf = Number.isFinite(confidence)
    ? Math.max(0, Math.min(1, confidence))
    : 0;
  return {
    tier: "T3",
    label: `${s.contract.postureClass.replace("_", "-")} • ${conf.toFixed(2)}`,
    url: null,
    provenance: null,
  };
}

function renderProvenance(s: SignalSource): Citation {
  return {
    tier: s.contract.disclosureTier,
    label: s.collectorName,
    url: s.sourceUrl,
    provenance: {
      collectorId: s.collectorId,
      collectorName: s.collectorName,
      sourceUrl: s.sourceUrl,
      observedAt: s.observedAt.toISOString(),
      postureClass: s.contract.postureClass,
    },
  };
}

/**
 * Render an insight's citations for the given tenant policy.
 *
 * `aggregateConfidence` is the insight-level confidence the caller already
 * computed across its sources; it's used only for T3 tags so the user sees
 * a numeric quality hint when source attribution is hidden.
 */
export function renderInsight(args: {
  sources: readonly SignalSource[];
  policy: TenantPolicy;
  aggregateConfidence?: number;
}): RenderedInsight {
  const { sources, policy } = args;
  const aggregateConfidence = args.aggregateConfidence ?? 0.7;

  // Analyst policy is the simplest: emit a provenance-rich citation per
  // source, regardless of tier (including T4, since the analyst is the
  // platform's audit/compliance role).
  if (policy === "analyst") {
    const citations = sources.map(renderProvenance);
    const tier =
      citations.length > 0
        ? highestTier(citations.map((c) => c.tier))
        : "T4";
    return {
      visible: citations.length > 0,
      tier,
      citations,
      label:
        citations.length === 0
          ? "no sources"
          : `Backed by ${citations.length} source${citations.length === 1 ? "" : "s"} (analyst view)`,
    };
  }

  const visibleSources = sources.filter((s) =>
    isVisibleForPolicy(s.contract.disclosureTier, policy),
  );
  const citations: Citation[] = visibleSources.map((s) => {
    if (s.contract.disclosureTier === "T1") return renderT1(s);
    if (s.contract.disclosureTier === "T2") return renderT2(s);
    return renderT3(s, aggregateConfidence);
  });

  const visible = citations.length > 0;
  const topTier = visible ? highestTier(citations.map((c) => c.tier)) : "T4";

  let label: string;
  if (!visible) {
    label = "no disclosable sources";
  } else if (topTier === "T1") {
    const named = citations.filter((c) => c.tier === "T1").length;
    label = `Backed by ${named} named source${named === 1 ? "" : "s"}`;
  } else if (topTier === "T2") {
    label = `Backed by ${citations.length} source categor${citations.length === 1 ? "y" : "ies"}`;
  } else {
    label = `Backed by ${citations.length} unattributed signal${citations.length === 1 ? "" : "s"}`;
  }

  return { visible, tier: topTier, citations, label };
}
