/**
 * `stableSignalKey` builder. Every collector must produce a deterministic
 * merge key for BigQuery so a re-run of the same upstream payload MERGEs
 * as a no-op rather than producing duplicate rows.
 *
 * The natural identity of a market signal is:
 *
 *   collectorId, signalType, scope_*, observedAt
 *
 * matching the Postgres natural-key unique index. We hash the canonical
 * concatenation so the key is fixed-length and safe to use in BQ
 * `MERGE ... ON target.signal_key = source.signal_key`.
 *
 * The hash is intentionally `sha-1`: it is collision-resistant for the
 * cardinality we care about (millions of signals per collector per year)
 * and short enough to keep the BQ row narrow. We do not need
 * cryptographic strength here — only determinism.
 */

import { createHash } from "node:crypto";

export interface StableSignalKeyParts {
  collectorId: string;
  signalType: string;
  scopeCategoryCode?: string | null;
  scopeSku?: string | null;
  scopeMaterialCode?: string | null;
  scopeSupplierName?: string | null;
  scopeLaneKey?: string | null;
  /**
   * Region scope (e.g. ISO-3166 country, US state, MSA code) for
   * region-specific observations such as BLS OEWS wage benchmarks.
   *
   * Backward-compat note: when this field is unset (or empty after
   * normalization) the key falls back to the legacy 7-part canonical
   * form so existing collectors that don't emit a region produce the
   * exact same hash as before this column was introduced. Only signals
   * that explicitly carry a region pay the appended-segment cost.
   */
  scopeRegionCode?: string | null;
  observedAt: Date | string;
}

/**
 * Normalise a scope value the same way the Postgres natural-key index
 * does: `null`, `undefined`, and pure-whitespace strings all collapse
 * to the empty string. This guarantees that two drafts that differ only
 * in `null` vs `""` for a scope column produce the same key.
 */
function norm(v: string | null | undefined): string {
  if (v === null || v === undefined) return "";
  return v.trim();
}

function isoUtc(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toISOString();
}

export function computeStableSignalKey(parts: StableSignalKeyParts): string {
  const segments = [
    norm(parts.collectorId),
    norm(parts.signalType),
    norm(parts.scopeCategoryCode),
    norm(parts.scopeSku),
    norm(parts.scopeMaterialCode),
    norm(parts.scopeSupplierName),
    norm(parts.scopeLaneKey),
    isoUtc(parts.observedAt),
  ];
  // Append a region segment only when populated so collectors that
  // never emit a region produce the same hash as before this field
  // existed. Tagged with a `region:` prefix to keep the appended
  // segment unambiguous if other suffixes are added later.
  const region = norm(parts.scopeRegionCode);
  if (region !== "") {
    segments.push(`region:${region}`);
  }
  return createHash("sha1").update(segments.join("|")).digest("hex");
}
