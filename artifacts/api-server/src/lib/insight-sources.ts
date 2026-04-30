/**
 * Server-side helpers for the disclosure-tier renderer's source descriptors.
 *
 * Lever analyzers persist a list of `InsightSource` objects on each
 * opportunity's `inputs.sources` JSON. The Command Center then calls
 * `renderInsight()` from `@workspace/intelligence/tier` against the
 * tenant's disclosure policy to derive the citation block to display.
 *
 * Keeping the read/write helpers in one place ensures the wire shape
 * surfaced by `/opportunities/:id` and `/cycles/:id` always matches the
 * `InsightSource` schema in `lib/api-spec/openapi.yaml` — and that the
 * Zod-validated shape on the client matches what the levers persist.
 */

import type {
  CollectorContract,
  SignalSource,
} from "@workspace/intelligence/contracts";

/**
 * Wire shape mirroring `InsightSource` in the OpenAPI spec. We re-declare
 * it here rather than importing the generated client type because the
 * server should never depend on `@workspace/api-zod`'s generated
 * imports for runtime types — those are validation schemas, not source
 * of truth for outgoing payloads.
 */
export interface InsightSource {
  collectorId: string;
  collectorName: string;
  sourceUrl: string;
  /** ISO-8601 string. Must be parseable by the client `new Date(...)`. */
  observedAt: string;
  contract: CollectorContract;
}

/**
 * Build a wire-safe `InsightSource` from a `SignalSource`-shaped input.
 * Coerces `Date` → ISO string so it survives JSON serialisation
 * unchanged when the route handler later calls `JSON.stringify()`.
 */
export function buildInsightSource(args: {
  collectorId: string;
  collectorName: string;
  sourceUrl: string;
  observedAt: Date | string;
  contract: CollectorContract;
}): InsightSource {
  return {
    collectorId: args.collectorId,
    collectorName: args.collectorName,
    sourceUrl: args.sourceUrl,
    observedAt:
      args.observedAt instanceof Date
        ? args.observedAt.toISOString()
        : args.observedAt,
    contract: args.contract,
  };
}

const VALID_POSTURE_CLASSES = new Set([
  "public_api",
  "tos_restricted",
  "gray_hat",
]);
const VALID_DISCLOSURE_TIERS = new Set(["T1", "T2", "T3", "T4"]);

/**
 * Lift the persisted `InsightSource[]` off an opportunity's `inputs`
 * JSON. Skips any entry that doesn't satisfy the wire schema rather
 * than reject the whole opportunity — a malformed legacy row should
 * not 500 the read path.
 */
export function extractSourcesFromInputs(
  inputs: Record<string, unknown> | null | undefined,
): InsightSource[] {
  if (!inputs) return [];
  const raw = inputs["sources"];
  if (!Array.isArray(raw)) return [];
  const out: InsightSource[] = [];
  for (const entry of raw) {
    const parsed = parseInsightSource(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseInsightSource(entry: unknown): InsightSource | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const c = e["contract"];
  if (
    typeof e["collectorId"] !== "string" ||
    typeof e["collectorName"] !== "string" ||
    typeof e["sourceUrl"] !== "string" ||
    typeof e["observedAt"] !== "string" ||
    !c ||
    typeof c !== "object"
  ) {
    return null;
  }
  // `observedAt` is consumed by `renderInsight()` via `new Date(...)`
  // (analyst policy serialises it back to ISO via `.toISOString()`),
  // so a non-parseable string would silently produce an "Invalid Date"
  // citation. Reject the source instead — better to omit a citation
  // than to render a broken provenance trail.
  if (Number.isNaN(Date.parse(e["observedAt"] as string))) {
    return null;
  }
  const contract = c as Record<string, unknown>;
  if (
    typeof contract["postureClass"] !== "string" ||
    !VALID_POSTURE_CLASSES.has(contract["postureClass"] as string) ||
    typeof contract["disclosureTier"] !== "string" ||
    !VALID_DISCLOSURE_TIERS.has(contract["disclosureTier"] as string) ||
    typeof contract["jurisdiction"] !== "string" ||
    typeof contract["retentionDays"] !== "number" ||
    typeof contract["tenantOptInDefault"] !== "boolean"
  ) {
    return null;
  }
  return {
    collectorId: e["collectorId"] as string,
    collectorName: e["collectorName"] as string,
    sourceUrl: e["sourceUrl"] as string,
    observedAt: e["observedAt"] as string,
    contract: contract as unknown as CollectorContract,
  };
}

/**
 * De-duplicate sources by `(collectorId, sourceUrl)`, keeping the row
 * with the most recent `observedAt`. Used to fold every opportunity's
 * sources up into the cycle-level citation list without showing the
 * same collector five times.
 */
export function dedupeSources(sources: readonly InsightSource[]): InsightSource[] {
  const byKey = new Map<string, InsightSource>();
  for (const s of sources) {
    const key = `${s.collectorId}::${s.sourceUrl}`;
    const existing = byKey.get(key);
    if (!existing || existing.observedAt < s.observedAt) {
      byKey.set(key, s);
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.collectorName.localeCompare(b.collectorName),
  );
}

/**
 * Re-export so callers wanting the canonical `SignalSource` shape can
 * convert wire `InsightSource`s back into the renderer's input form.
 * Kept type-only — the renderer parses `observedAt` itself.
 */
export type { SignalSource };
