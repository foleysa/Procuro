import type { Band } from "@workspace/db";

/**
 * The fallback band used when a tenant string can't be mapped to any
 * canonical code. This is the *only* band that emits opportunities
 * tagged `mapped_via = 'unmapped_default'`, which calibration
 * subsequently excludes.
 */
export const FALLBACK_BAND: Band = "fragmented";

/** All bands in canonical order. */
export const ALL_BANDS: readonly Band[] = [
  "indexable",
  "concentrated",
  "fragmented",
  "subscription",
  "capital",
  "services",
];

/**
 * Convenience guard for switch-narrowing in callers that need to fan
 * out per band (admin UI summaries, health metrics, etc.).
 */
export function isBand(value: string): value is Band {
  return (ALL_BANDS as readonly string[]).includes(value);
}
