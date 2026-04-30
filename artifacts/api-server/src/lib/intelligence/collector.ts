/**
 * Phase 1+2 contract for external intelligence sources.
 *
 * Phase 1 (legacy): the runtime gated each collector by its `posture`,
 * persisted parsed signals to Postgres, and let lever analyzers consume
 * them directly.
 *
 * Phase 2 (this task): every collector additionally declares the metadata
 * the analytical foundation needs to:
 *   - render insights at the correct disclosure tier per tenant policy
 *     (`postureClass`, `disclosureTier`, `jurisdiction`)
 *   - manage raw payload lifecycle in GCS (`retentionDays`)
 *   - decide whether every tenant gets the source by default or has to
 *     opt in (`tenantOptInDefault`)
 *   - validate parsed signals against the collector's declared shape
 *     before persisting (`signalSchema`)
 *   - merge re-runs idempotently into BigQuery using a stable key
 *     (`stableSignalKey(draft)`) — must be deterministic and depend only
 *     on the natural identity of the observation, never on wall-clock.
 *
 * `aggressive-crawl` (== `gray_hat`) collectors stay disabled-by-default
 * in the registry and require explicit per-source approval recorded in
 * `collectorsTable.status='approved'`. Production enablement of any
 * specific aggressive-crawl collector against a named third party is a
 * per-source legal/compliance decision the platform team makes outside
 * the agent.
 */

import type { z } from "zod";
import type {
  CollectorContract,
  PostureClass,
  DisclosureTier,
  Jurisdiction,
} from "@workspace/intelligence";
import type {
  CollectionPosture,
  MarketSignalType,
} from "@workspace/db";

export interface MarketSignalDraft {
  signalType: MarketSignalType;
  scopeCategoryCode?: string;
  scopeSku?: string;
  scopeMaterialCode?: string;
  scopeSupplierName?: string;
  scopeLaneKey?: string;
  value: number;
  unit: string;
  currency?: string;
  observedAt: Date;
  sourceUrl: string;
  /** [0..1] */
  confidence?: number;
  metadata?: Record<string, unknown>;
  /**
   * Optional pre-resolved canonical `entity_uid` (from
   * `@workspace/intelligence/entities → resolveEntity`). When set, the
   * runtime threads it into the BigQuery `entity_uid_nullable` column
   * (and mirrors it into Postgres `metadata.entityUid`) so downstream
   * graph traversals and Fusion Center surfaces can join cross-source
   * signals on the same canonical entity. Collectors that touch named
   * organisations (suppliers, sanctioned parties, facilities, issuers)
   * should populate this whenever resolution succeeds.
   */
  entityUid?: string | null;
}

export interface CollectorRunResult {
  signalsCollected: number;
  errors: number;
  durationMs: number;
}

/**
 * Optional raw-payload bundle a collector can return alongside its
 * drafts. The runtime lands the bytes in GCS (when configured) before
 * persisting any signal, so a future re-parse can rebuild the same
 * drafts without re-fetching the upstream source.
 *
 * Collectors that already buffer the upstream response (most do) should
 * implement `collectWithRaw` and return one entry per logical request.
 * Collectors that stream/transform on the fly can stay on the legacy
 * `collect()` shape — the runtime will simply skip the GCS landing for
 * those runs.
 */
export interface RawPayload {
  /** Logical name for the payload — used to disambiguate multi-fetch runs. */
  name: string;
  contentType: string;
  body: Buffer | string;
  /** Optional upstream URL the bytes came from. */
  sourceUrl?: string;
  /** Free-form context surfaced into the GCS payload pointer. */
  metadata?: Record<string, unknown>;
}

export interface CollectWithRawResult {
  drafts: MarketSignalDraft[];
  rawPayloads: RawPayload[];
}

export interface IntelligenceCollector<
  Schema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Legacy posture column, kept for the existing Postgres registry row. */
  readonly posture: CollectionPosture;
  readonly sourceUrl: string;
  /** Default rate limit (requests per minute) — registry can override. */
  readonly defaultRateLimitRpm: number;
  /** Cron-like schedule, or null for manual runs only. */
  readonly defaultScheduleCron: string | null;

  // -- Phase 2 contract additions ------------------------------------
  readonly postureClass: PostureClass;
  readonly disclosureTier: DisclosureTier;
  readonly jurisdiction: Jurisdiction;
  readonly retentionDays: number;
  readonly tenantOptInDefault: boolean;
  /**
   * How long an empty-result run window can persist before the
   * source-health endpoint flags this collector as a "stale empty
   * source". Different collector kinds tolerate different gaps —
   * e.g. a daily macro feed might tolerate 24-48h, a weekly filings
   * source needs 8+ days. Falls back to 48h when omitted.
   */
  readonly staleEmptyThresholdHours?: number;
  /**
   * Zod schema applied to every emitted draft after `collect()`. Drafts
   * that fail validation are recorded as schema-drift events and
   * dropped — they never reach Postgres or BigQuery.
   *
   * Defining the schema as a Zod object on the collector (rather than a
   * shared global) lets each source enforce its own metadata invariants
   * (e.g. FRED requires `metadata.seriesId`).
   */
  readonly signalSchema: Schema;
  /**
   * Deterministic merge key for BigQuery. Must depend only on the
   * natural identity of the observation (signalType + scope columns +
   * observedAt + collectorId), NEVER on wall-clock or random values, so
   * a re-run of the same upstream payload produces the same key and
   * MERGEs as a no-op.
   */
  stableSignalKey(draft: MarketSignalDraft): string;
  // ------------------------------------------------------------------

  /**
   * Run a collection pass. Returns drafts; the runtime persists them to
   * `marketSignalsTable` after gating.
   *
   * `since` is a watermark — the collector should return signals observed
   * after this time. The runtime enforces robots.txt (where applicable),
   * rate limits, retries, and the kill switch.
   */
  collect(args: {
    since: Date | null;
  }): Promise<MarketSignalDraft[]>;

  /**
   * Optional: run a collection pass and surface the upstream payload
   * bytes alongside the parsed drafts so the runtime can land them in
   * GCS for replay. When implemented, the runtime prefers this method
   * over `collect()`.
   */
  collectWithRaw?(args: { since: Date | null }): Promise<CollectWithRawResult>;
}

/**
 * Lift the contract metadata off a collector. Callers (the disclosure
 * renderer, the BQ writer, the workbench UI) usually want this without
 * re-typing the field list.
 */
export function collectorContract(c: IntelligenceCollector): CollectorContract {
  return {
    postureClass: c.postureClass,
    disclosureTier: c.disclosureTier,
    jurisdiction: c.jurisdiction,
    retentionDays: c.retentionDays,
    tenantOptInDefault: c.tenantOptInDefault,
  };
}
