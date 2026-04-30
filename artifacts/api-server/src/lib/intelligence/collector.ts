/**
 * Phase 1 contract for external intelligence sources.
 *
 * The runtime gates each collector by its `posture`. `aggressive-crawl`
 * collectors are disabled-by-default in the registry and require explicit
 * per-source approval recorded in `collectorsTable.status='approved'`.
 *
 * Production enablement of any specific aggressive-crawl collector against a
 * named third party is a per-source legal/compliance decision the platform
 * team makes outside the agent. The framework, registry, kill switch, and
 * audit log are all in place.
 */

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
}

export interface CollectorRunResult {
  signalsCollected: number;
  errors: number;
  durationMs: number;
}

export interface IntelligenceCollector {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly posture: CollectionPosture;
  readonly sourceUrl: string;
  /** Default rate limit (requests per minute) — registry can override. */
  readonly defaultRateLimitRpm: number;
  /** Cron-like schedule, or null for manual runs only. */
  readonly defaultScheduleCron: string | null;

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
}
