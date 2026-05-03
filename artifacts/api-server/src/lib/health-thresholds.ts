/**
 * Per-tenant System Health Strip thresholds (Task #295).
 *
 * The dashboard's System Health Strip used to evaluate Engine status
 * (🟢/🟡/🔴) against hardcoded numbers — `staleCollectors <= 1`,
 * `pendingJobs > 5`, the implicit `signals24h > 0` floor — that
 * worked for the seed tenant but broke down for tenants with very
 * different signal volumes and collector counts.
 *
 * These three knobs let an Org Admin tune what "Stalled" vs
 * "Degraded" means for their tenant from the Settings page without
 * a code change. They live alongside `disclosurePolicy` and
 * `contractRenewalAlertDays` in `orgs.settings` JSONB so the same
 * audit trail (`org_settings_audit_log`) covers them automatically.
 */

export const HEALTH_THRESHOLD_DEFAULTS = {
  /**
   * Daily floor for signals24h. The strip turns red the moment a
   * tenant ingests fewer signals than this in the last 24h. Default
   * `1` mirrors the original "0 signals" hard-stop; high-volume
   * tenants typically raise this to e.g. 50 so a 5-signal day still
   * trips an alert instead of looking healthy.
   */
  minSignalsPerDay: 1,
  /**
   * Maximum stale collectors before the strip stops being green. A
   * stale collector is one whose `lastRunAt` exceeded its expected
   * cadence; default `1` reproduces the original behaviour (one
   * tolerated, two flips the strip yellow).
   */
  maxStaleCollectors: 1,
  /**
   * Maximum pending jobs in flight before the strip turns red when
   * `runningJobs === 0`. Default `5` matches the original
   * `pendingJobs > 5 && runningJobs === 0` rule.
   */
  maxQueuedJobs: 5,
} as const;

export type HealthThresholds = {
  minSignalsPerDay: number;
  maxStaleCollectors: number;
  maxQueuedJobs: number;
};

export const HEALTH_THRESHOLD_BOUNDS = {
  minSignalsPerDay: { min: 0, max: 100_000 },
  maxStaleCollectors: { min: 0, max: 10_000 },
  maxQueuedJobs: { min: 0, max: 100_000 },
} as const;

function readClamped(
  raw: unknown,
  key: keyof typeof HEALTH_THRESHOLD_BOUNDS,
  fallback: number,
): number {
  const bounds = HEALTH_THRESHOLD_BOUNDS[key];
  let n: number | null = null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    n = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === null) return fallback;
  if (!Number.isInteger(n)) n = Math.floor(n);
  if (n < bounds.min || n > bounds.max) return fallback;
  return n;
}

/**
 * Read the resolved health thresholds for the given `orgs.settings`
 * blob, applying defaults and clamping out-of-range values so the
 * strip never crashes on legacy/garbage JSON.
 */
export function readHealthThresholds(
  settings: Record<string, unknown> | null | undefined,
): HealthThresholds {
  const raw = (settings?.["healthThresholds"] ?? null) as
    | Record<string, unknown>
    | null;
  return {
    minSignalsPerDay: readClamped(
      raw?.["minSignalsPerDay"],
      "minSignalsPerDay",
      HEALTH_THRESHOLD_DEFAULTS.minSignalsPerDay,
    ),
    maxStaleCollectors: readClamped(
      raw?.["maxStaleCollectors"],
      "maxStaleCollectors",
      HEALTH_THRESHOLD_DEFAULTS.maxStaleCollectors,
    ),
    maxQueuedJobs: readClamped(
      raw?.["maxQueuedJobs"],
      "maxQueuedJobs",
      HEALTH_THRESHOLD_DEFAULTS.maxQueuedJobs,
    ),
  };
}
