/**
 * Composite risk-scoring model used by the Fusion Center Heatmap and the
 * Entity 360 risk panel.
 *
 * Design goals:
 *   - **Documented** — every score is a transparent weighted sum, never
 *     an opaque ML output. The full formula is in
 *     `references/risk-scoring.md`.
 *   - **Inspectable** — `decompose()` returns the per-signal contribution
 *     so the UI's "why" affordance can render the contributing rows with
 *     their disclosure tier badges.
 *   - **Time-decayed** — older signals weigh less than recent ones via an
 *     exponential half-life per dimension.
 *   - **Confidence-weighted** — every signal carries a `[0..1]`
 *     confidence; we multiply each signal's normalised contribution by it
 *     so a low-confidence rumor never dominates a high-confidence
 *     filing.
 *   - **Tier-clamped** — T4 contributions only nudge the aggregate, never
 *     drive it on their own (capped at `T4_MAX_DELTA` per dimension).
 *   - **Deterministic** — given the same input list, two callers produce
 *     the same score and decomposition.
 *
 * Output is normalised to a `0..100` integer per dimension. `0 = clean`
 * and `100 = maximum observed risk`.
 */

import type { DisclosureTier } from "../contracts/index.js";

/** The six risk dimensions surfaced on the Heatmap and Entity 360. */
export const RISK_DIMENSIONS = [
  "geo",
  "financial",
  "cyber",
  "esg",
  "climate",
  "sanctions",
] as const;
export type RiskDimension = (typeof RISK_DIMENSIONS)[number];

/**
 * Minimal per-signal record the scorer needs. Callers flatten DB rows
 * into this shape — the scorer never reaches into the schema directly.
 */
export interface ScoringSignal {
  /** Stable id from `marketSignalsTable.id` (used for decomposition). */
  id: string;
  /** Concrete signal type from `marketSignalTypes`. */
  signalType: string;
  /** Tier inherited from the contributing collector's contract. */
  tier: DisclosureTier;
  /** [0..1]; defaults to 0.7 if not supplied (matches DB default). */
  confidence?: number | null;
  /**
   * Raw signal magnitude on the source's own scale (e.g. CAMEO event
   * code, hazard severity 0-3, emissions tonnes/yr). The scorer
   * normalises per signal-type via `SIGNAL_TYPE_NORMALISERS`.
   */
  value: number;
  /** Wall-clock observation time of the upstream event. */
  observedAt: Date;
  /** Optional collector id for attribution in decomposition. */
  collectorId?: string;
  /** Optional collector display name for citation rendering. */
  collectorName?: string;
}

export interface ScoringOptions {
  /**
   * Wall-clock anchor for time decay. Defaults to `new Date()`. Tests
   * pass a fixed value to keep snapshots stable.
   */
  now?: Date;
}

export interface ScoreContribution {
  signalId: string;
  signalType: string;
  tier: DisclosureTier;
  collectorId?: string;
  collectorName?: string;
  /** Normalised severity in `[0,1]` BEFORE confidence/decay scaling. */
  rawSeverity: number;
  /** Final weighted contribution to the aggregate (clamped). */
  weighted: number;
  /** Confidence used for this signal (after default fallback). */
  confidence: number;
  /** Time-decay multiplier in `[0,1]`. */
  decay: number;
  observedAt: Date;
}

export interface ScoreResult {
  dimension: RiskDimension;
  /** Final composite score in `[0,100]`. */
  score: number;
  /** Sum of weighted contributions before scaling — useful for tests. */
  rawAggregate: number;
  /** Top-N (default 5) contributing signals, descending. */
  topContributors: ScoreContribution[];
  /** Total number of signals considered for this dimension. */
  signalCount: number;
}

// ---------------------------------------------------------------------
// Per-dimension weights & half-lives.
// ---------------------------------------------------------------------

/**
 * How quickly a dimension's signals fade. Half-life in DAYS — after this
 * many days a signal contributes half as much.
 *
 * Geo events (riots, conflict, transit disruption) move fast and become
 * irrelevant quickly. Sanctions are persistent (delisting is rare) so
 * they decay slowly. Climate / emissions are medium-term.
 */
const HALF_LIFE_DAYS: Record<RiskDimension, number> = {
  geo: 14,
  financial: 90,
  cyber: 30,
  esg: 180,
  climate: 365,
  sanctions: 730,
};

/**
 * Maximum impact of any single signal-type on each dimension. The
 * scorer multiplies the normalised severity by this weight before
 * adding to the aggregate.
 *
 * The mapping is sparse on purpose: a sanctions hit doesn't move the
 * climate score, and a facility emissions row doesn't move the
 * sanctions score.
 */
type DimensionWeights = Partial<Record<string, number>>;
const SIGNAL_WEIGHTS: Record<RiskDimension, DimensionWeights> = {
  geo: {
    event_geocoded: 1.0,
    natural_hazard: 0.9,
    entity_news_event: 0.5,
  },
  financial: {
    corporate_filing: 1.0,
    supplier_financial: 0.9,
    supplier_risk_news: 0.7,
    fx_rate: 0.4,
  },
  cyber: {
    // v0 has no first-class cyber feed yet; entity_news_event acts as
    // a low-confidence proxy until the cyber-posture collector ships.
    entity_news_event: 0.5,
    risk_screening_match: 0.7,
  },
  esg: {
    facility_emissions: 1.0,
    risk_screening_match: 0.6,
    entity_news_event: 0.4,
  },
  climate: {
    natural_hazard: 1.0,
    facility_emissions: 0.6,
  },
  sanctions: {
    sanctions_match: 1.0,
    risk_screening_match: 0.85,
  },
};

/**
 * T4 (never-disclosed) signals are capped at this fraction of the
 * aggregate so a non-attributable feed cannot single-handedly drive a
 * score on its own.
 */
const T4_MAX_DELTA = 0.15;

/**
 * Tier multipliers — a T1 signal is trusted at face value; T3/T4
 * signals are slightly damped so the aggregate is conservatively
 * weighted toward attributable evidence.
 */
const TIER_MULTIPLIER: Record<DisclosureTier, number> = {
  T1: 1.0,
  T2: 0.9,
  T3: 0.75,
  T4: 0.6,
};

/**
 * Per-signal-type severity normalisers — turn a raw value into a
 * `[0,1]` severity. The scorer never sees the raw upstream units
 * directly; everything goes through this map. Adding a new signal type
 * means deciding how to project it onto `[0,1]`.
 */
const SIGNAL_TYPE_NORMALISERS: Record<string, (raw: number) => number> = {
  // GDELT CAMEO event codes: 14-20 are protest/violence/conflict (high).
  // 1-9 are statements/cooperation (low). We bucket coarsely.
  event_geocoded: (raw) => {
    if (!Number.isFinite(raw)) return 0;
    if (raw >= 18) return 1.0; // assault, fight, mass-violence
    if (raw >= 14) return 0.7; // protest, threats
    if (raw >= 10) return 0.4; // disapprove / reject
    return 0.15;
  },
  // Natural hazards collector packs a source-code in `value`; severity
  // lives in metadata. We treat the presence of a hazard as a 0.6
  // baseline so the dimension reacts even before metadata-aware code.
  natural_hazard: () => 0.6,
  // Sanctions match — value = list code (1=OFAC,2=EU,3=UK,4=UN). All are
  // hard hits.
  sanctions_match: () => 1.0,
  risk_screening_match: () => 0.8,
  // Corporate filings (8-K, etc) — value = filing code; treat as a
  // medium prior since filing kind classification is downstream work.
  corporate_filing: () => 0.5,
  supplier_financial: (raw) =>
    !Number.isFinite(raw) ? 0 : Math.max(0, Math.min(1, raw / 100)),
  supplier_risk_news: () => 0.55,
  entity_news_event: () => 0.4,
  // Facility emissions: value = tonnes CO2e/yr. We bucket so a
  // 50,000 t/yr facility is mid-risk and 1,000,000 t/yr is high.
  facility_emissions: (raw) => {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    const log = Math.log10(raw);
    // log10(1e3)=3, log10(1e6)=6. Project [3,6] -> [0,1].
    return Math.max(0, Math.min(1, (log - 3) / 3));
  },
  // FX moves are mild on financial dimension.
  fx_rate: () => 0.25,
};

const DEFAULT_NORMALISER = (raw: number): number =>
  !Number.isFinite(raw) ? 0 : Math.max(0, Math.min(1, Math.abs(raw) / 10));

// ---------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------

/**
 * Score a single risk dimension for one entity given its contributing
 * signals. Returns the aggregate score and the top contributors so the
 * UI can show "why".
 */
export function scoreDimension(
  dimension: RiskDimension,
  signals: readonly ScoringSignal[],
  opts: ScoringOptions = {},
): ScoreResult {
  const now = opts.now ?? new Date();
  const halfLifeMs = HALF_LIFE_DAYS[dimension] * 24 * 60 * 60 * 1000;
  const weights = SIGNAL_WEIGHTS[dimension];

  const contributions: ScoreContribution[] = [];
  let aggregate = 0;
  let t4Aggregate = 0;

  for (const sig of signals) {
    const w = weights[sig.signalType];
    if (typeof w !== "number" || w <= 0) continue;
    const norm =
      (SIGNAL_TYPE_NORMALISERS[sig.signalType] ?? DEFAULT_NORMALISER)(sig.value);
    if (norm <= 0) continue;

    const ageMs = Math.max(0, now.getTime() - sig.observedAt.getTime());
    const decay = Math.pow(0.5, ageMs / halfLifeMs);

    const conf =
      typeof sig.confidence === "number" && Number.isFinite(sig.confidence)
        ? Math.max(0, Math.min(1, sig.confidence))
        : 0.7;

    const tierMult = TIER_MULTIPLIER[sig.tier];
    const weighted = norm * w * decay * conf * tierMult;
    if (sig.tier === "T4") {
      t4Aggregate += weighted;
    } else {
      aggregate += weighted;
    }

    contributions.push({
      signalId: sig.id,
      signalType: sig.signalType,
      tier: sig.tier,
      collectorId: sig.collectorId,
      collectorName: sig.collectorName,
      rawSeverity: norm,
      weighted,
      confidence: conf,
      decay,
      observedAt: sig.observedAt,
    });
  }

  // Cap T4 nudges and fold into the aggregate.
  const cappedT4 = Math.min(t4Aggregate, T4_MAX_DELTA * Math.max(1, aggregate));
  const rawAggregate = aggregate + cappedT4;

  // Map raw aggregate to a 0..100 score using a saturating curve. The
  // anchor `2.5` was picked so that ~3 strong contributions saturate to
  // the high-90s; tweaking it shifts the whole heatmap proportionally
  // and is documented in references/risk-scoring.md.
  const score = Math.round(100 * (1 - Math.exp(-rawAggregate / 2.5)));

  contributions.sort((a, b) => b.weighted - a.weighted);
  return {
    dimension,
    score,
    rawAggregate,
    topContributors: contributions.slice(0, 5),
    signalCount: contributions.length,
  };
}

/**
 * Score every dimension at once. Convenience for the Heatmap endpoint
 * which renders all dimensions side-by-side.
 */
export function scoreAllDimensions(
  signals: readonly ScoringSignal[],
  opts: ScoringOptions = {},
): Record<RiskDimension, ScoreResult> {
  const out: Partial<Record<RiskDimension, ScoreResult>> = {};
  for (const d of RISK_DIMENSIONS) {
    out[d] = scoreDimension(d, signals, opts);
  }
  return out as Record<RiskDimension, ScoreResult>;
}

/**
 * Bucket a 0-100 score into a coarse band for UI colouring.
 */
export function scoreBand(
  score: number,
): "low" | "moderate" | "elevated" | "high" {
  if (score >= 70) return "high";
  if (score >= 40) return "elevated";
  if (score >= 15) return "moderate";
  return "low";
}
