/**
 * First-class collector contract metadata. Every intelligence collector
 * declares these so the runtime can:
 *   - choose the correct legal posture and rate-limit policy
 *   - render insights at the correct disclosure tier per tenant policy
 *   - know how long the raw payload may live in GCS before deletion
 *   - validate parsed signals against the declared schema before persisting
 *   - merge re-runs idempotently using a stable signal key
 */

import { z } from "zod";

/**
 * What kind of source this collector pulls from. Drives the legal posture
 * + rate-limit defaults + which collectors require explicit per-tenant
 * opt-in.
 *
 * - `public_api`     — published REST/JSON/CSV/XML feed with terms allowing
 *                      programmatic access (FRED, BLS, ECB, EIA, World Bank).
 * - `tos_restricted` — public web data whose ToS limits programmatic access,
 *                      crawled on a respect-robots basis with explicit
 *                      per-source approval.
 * - `gray_hat`       — anything that requires headless browsing, cookie
 *                      handling, captcha, or proxies; disabled by default,
 *                      requires per-source legal sign-off + force flag at
 *                      runtime. We do not register any gray_hat collector
 *                      in v0.
 */
export type PostureClass = "public_api" | "tos_restricted" | "gray_hat";

/**
 * Disclosure tier the source can be cited at when surfaced to a user.
 *
 * - `T1` — fully attributable: source name + URL shown verbatim.
 * - `T2` — generic source category + jurisdiction (e.g. "central-bank
 *          reference rates, EU"). No URL.
 * - `T3` — class label + numeric confidence only ("commodity index • 0.92").
 *          Used for sources that don't allow attribution.
 * - `T4` — invisible: contributes only to confidence boost, never named.
 */
export type DisclosureTier = "T1" | "T2" | "T3" | "T4";

/** ISO 3166-1 alpha-2 country code or `GLOBAL` for cross-jurisdiction sources. */
export type Jurisdiction = string;

/** Tenant disclosure policy. Determines which tiers are surfaced. */
export type TenantPolicy = "conservative" | "standard" | "analyst";

/**
 * Mapping from the legacy posture enum (used by collectors registered
 * before this task) to the canonical `PostureClass`. The legacy column
 * stays in Postgres for now; we layer the newer concept on top.
 */
export const LEGACY_POSTURE_TO_CLASS: Record<string, PostureClass> = {
  "public-api": "public_api",
  "published-data": "public_api",
  "respect-robots-crawl": "tos_restricted",
  "aggressive-crawl": "gray_hat",
};

/** Default retention windows in days, indexed by posture class. */
export const DEFAULT_RETENTION_DAYS: Record<PostureClass, number> = {
  public_api: 365,
  tos_restricted: 180,
  gray_hat: 30,
};

/**
 * Static, declarative metadata exposed by every collector. Keeping this
 * shape separate from `IntelligenceCollector` lets non-collector code
 * (the runtime, the disclosure renderer, the Collector workbench) reason
 * about a source without depending on its `collect()` body.
 */
export interface CollectorContract {
  postureClass: PostureClass;
  disclosureTier: DisclosureTier;
  jurisdiction: Jurisdiction;
  /** How long raw payloads may sit in GCS before lifecycle-rule deletion. */
  retentionDays: number;
  /**
   * When `true`, every tenant gets this source's signals automatically.
   * When `false`, a tenant must opt in (recorded outside this contract).
   */
  tenantOptInDefault: boolean;
}

/**
 * Validate a `CollectorContract`-shaped object. Used by `registerCollector`
 * to refuse a half-declared collector at boot rather than silently emit
 * unscored signals that downstream lever analyzers can't evaluate.
 */
export const collectorContractSchema = z.object({
  postureClass: z.enum(["public_api", "tos_restricted", "gray_hat"]),
  disclosureTier: z.enum(["T1", "T2", "T3", "T4"]),
  jurisdiction: z.string().min(2).max(8),
  retentionDays: z.number().int().min(1).max(3650),
  tenantOptInDefault: z.boolean(),
});

/** Minimal cited source descriptor that flows through the tier renderer. */
export interface SignalSource {
  collectorId: string;
  collectorName: string;
  sourceUrl: string;
  observedAt: Date;
  contract: CollectorContract;
}
