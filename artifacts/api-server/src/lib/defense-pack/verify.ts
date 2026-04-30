/**
 * Citation verifier for Defense Pack outputs.
 *
 * Every claim emitted by the LLM declares a `signalId` and a quoted
 * value. The verifier confirms:
 *  1. `signalId` exists in the frozen evidence snapshot.
 *  2. The cited signal is T1 or T2 (claims may not cite T3/T4 even if
 *     the LLM "saw" T3 narrative items).
 *  3. The numeric value(s) extracted from `valueQuoted` are within
 *     tolerance of `signal.value`. Tolerance defaults to 1% relative
 *     OR 0.01 absolute, whichever is larger — accommodates rounding
 *     ("$182.40 / tonne" vs DB value 182.395).
 *
 * Claims that fail any of these checks are dropped. The
 * Generator orchestrates one regeneration pass when the verified-claim
 * count falls below the per-section minimum.
 */

import type {
  DefensePackClaim,
  DefensePackEvidenceSnapshotItem,
  DefensePackSection,
} from "@workspace/db";

export interface VerifyOptions {
  /** Relative tolerance, e.g. 0.01 = 1%. Default 0.01. */
  relativeTolerance?: number;
  /** Absolute tolerance floor. Default 0.01. */
  absoluteTolerance?: number;
}

export interface VerificationResult {
  sections: DefensePackSection[];
  /** Total claims emitted by the model, before verification. */
  claimsEmitted: number;
  /** Total claims that survived verification. */
  claimsVerified: number;
  /**
   * Per-claim explanations of why a claim was dropped. Surfaced on the
   * server log to aid debugging; not exposed on the wire.
   */
  drops: Array<{
    sectionKey: string;
    text: string;
    signalId: string;
    reason: string;
  }>;
}

const NUMBER_RE = /-?\d{1,3}(?:[, ]\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const cleaned = m[0].replace(/[, ]/g, "");
    const n = Number(cleaned);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function withinTolerance(
  expected: number,
  actual: number,
  rel: number,
  abs: number,
): boolean {
  const tol = Math.max(Math.abs(expected) * rel, abs);
  return Math.abs(expected - actual) <= tol;
}

/**
 * Verify the claims in a draft set of sections against the frozen
 * evidence snapshot. Returns a new array of sections with
 * unverifiable claims stripped, plus diagnostic counts.
 *
 * The `proprietary_signal_context` and `position` sections never carry
 * verifiable claims and are passed through unchanged.
 */
export function verifyClaims(
  sections: DefensePackSection[],
  snapshot: DefensePackEvidenceSnapshotItem[],
  opts: VerifyOptions = {},
): VerificationResult {
  const rel = opts.relativeTolerance ?? 0.01;
  const abs = opts.absoluteTolerance ?? 0.01;
  const byId = new Map<string, DefensePackEvidenceSnapshotItem>();
  for (const s of snapshot) byId.set(s.signalId, s);

  let emitted = 0;
  let verified = 0;
  const drops: VerificationResult["drops"] = [];

  const out: DefensePackSection[] = sections.map((section) => {
    if (
      section.key === "proprietary_signal_context" ||
      section.key === "position"
    ) {
      return { ...section, claims: [] };
    }
    const kept: DefensePackClaim[] = [];
    for (const claim of section.claims) {
      emitted += 1;
      const reasons: string[] = [];
      const signal = byId.get(claim.signalId);
      if (!signal) {
        reasons.push("signalId not in evidence snapshot");
      } else if (signal.tier !== "T1" && signal.tier !== "T2") {
        reasons.push(`signal tier ${signal.tier} not eligible for citation`);
      } else {
        const numbers = extractNumbers(claim.valueQuoted ?? "");
        if (numbers.length === 0) {
          reasons.push("no numeric value extractable from valueQuoted");
        } else {
          const ok = numbers.some((n) =>
            withinTolerance(signal.value, n, rel, abs),
          );
          if (!ok) {
            reasons.push(
              `quoted value ${claim.valueQuoted} out of tolerance vs ${signal.value} ${signal.unit}`,
            );
          }
        }
      }
      if (reasons.length === 0) {
        kept.push(claim);
        verified += 1;
      } else {
        drops.push({
          sectionKey: section.key,
          text: claim.text,
          signalId: claim.signalId,
          reason: reasons.join("; "),
        });
      }
    }
    return { ...section, claims: kept };
  });

  return { sections: out, claimsEmitted: emitted, claimsVerified: verified, drops };
}

/**
 * Decide whether the verified output is "good enough" to publish. The
 * Defense Pack contract requires every cited section to retain at
 * least one verified claim; sections without claims are admissible
 * only when they are the position / narrative-only sections.
 */
export function meetsCitationFloor(
  sections: DefensePackSection[],
  minClaimsPerCitedSection = 1,
): boolean {
  for (const section of sections) {
    if (
      section.key === "position" ||
      section.key === "proprietary_signal_context"
    ) {
      continue;
    }
    if (section.claims.length < minClaimsPerCitedSection) {
      return false;
    }
  }
  return true;
}
