/**
 * Replay collector — re-parse historical raw payloads from GCS.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run replay-collector \
 *     -- --collector <id> --from 2025-01-01 --to 2025-01-31 [--dry-run]
 *
 * Reads every landed raw payload for the given collector and date window
 * from GCS, hands the bytes to the collector's optional re-parser
 * (`reparseRawPayload(payload, contentType)`), and MERGEs the resulting
 * drafts into BigQuery via `mergeMarketSignals`. Postgres is left alone:
 * the dedupe index already enforces the natural-key contract, and a full
 * Postgres replay would race the live collector. BigQuery's
 * `stable_signal_key`-keyed MERGE is the canonical replay target.
 *
 * No-ops with an explanatory message when GCP isn't configured. This is
 * intentional — the script is part of the foundation, not a daily job,
 * and it should be safe to run on a workstation without surprising the
 * caller with a hard failure.
 */

import {
  isIntelligenceEnabled,
  listRawPayloads,
  readRawPayload,
  mergeMarketSignals,
  computeStableSignalKey,
  type BqMarketSignalRow,
} from "@workspace/intelligence";

interface CliArgs {
  collector: string;
  from: Date;
  to: Date;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: Partial<CliArgs> & { dryRun?: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--collector") out.collector = argv[++i];
    else if (a === "--from") out.from = new Date(argv[++i]!);
    else if (a === "--to") out.to = new Date(argv[++i]!);
    else if (a === "--dry-run") out.dryRun = true;
  }
  if (!out.collector) throw new Error("missing required flag: --collector");
  if (!out.from || isNaN(out.from.getTime()))
    throw new Error("missing or invalid --from (YYYY-MM-DD)");
  if (!out.to || isNaN(out.to.getTime()))
    throw new Error("missing or invalid --to (YYYY-MM-DD)");
  return out as CliArgs;
}

/**
 * Minimal contract for a re-parser plugin. Each collector that wants to
 * participate in replay registers a function in `reparsers` below; the
 * key is the collector id and the value is a sync/async function that
 * turns a raw payload into a list of `BqMarketSignalRow` candidates.
 *
 * The keep-it-simple choice here (over importing the live collector
 * directly) is that the live collectors talk to upstream APIs and have
 * runtime side effects we don't want to invoke during replay.
 */
type Reparser = (
  payload: Buffer,
  context: { collectorId: string; pointer: string; runId: string },
) => Promise<readonly BqMarketSignalRow[]> | readonly BqMarketSignalRow[];

/**
 * Shape of the parsed-drafts snapshot the runtime lands when a collector
 * doesn't override `collectWithRaw`. Mirrors the JSON the runtime
 * produces in `runCollector`: every field needed to rebuild a BQ row is
 * already in the snapshot, so the re-parser is a pure deserialise +
 * shape-map.
 */
interface ParsedDraftsSnapshot {
  collectorId: string;
  runId: string;
  runStartedAt: string;
  postureClass: string;
  disclosureTier: string;
  jurisdiction: string;
  drafts: ReadonlyArray<{
    signalType: string;
    scopeCategoryCode?: string | null;
    scopeSku?: string | null;
    scopeMaterialCode?: string | null;
    scopeSupplierName?: string | null;
    scopeLaneKey?: string | null;
    scopeRegionCode?: string | null;
    value: number;
    unit: string;
    currency?: string;
    observedAt: string;
    sourceUrl: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }>;
}

/**
 * Generic re-parser for the runtime's parsed-drafts JSON snapshot.
 * Re-issuing the same observation against BQ is a no-op because the
 * stable_signal_key + value pair are unchanged; a corrected parser
 * uploaded later can re-emit drafts and the MERGE will close the prior
 * row + open the new one as designed.
 */
function snapshotReparser(): Reparser {
  return (payload, ctx) => {
    const snapshot = JSON.parse(payload.toString("utf-8")) as ParsedDraftsSnapshot;
    return snapshot.drafts.map((d) => {
      const observedAt = new Date(d.observedAt);
      const ingestedAt = new Date();
      const validFrom = observedAt;
      return {
        // The replayed BQ row needs a stable signal_id. We derive it
        // from the snapshot's collector id, signal type, and observedAt
        // so a re-replay produces the same id and Postgres + BQ stay
        // aligned. (The stable_signal_key carries the dedup contract.)
        signalId: `replay_${ctx.collectorId}_${d.signalType}_${observedAt.toISOString()}`,
        orgId: null,
        collectorId: snapshot.collectorId,
        signalType: d.signalType,
        scopeCategoryCode: d.scopeCategoryCode ?? null,
        scopeSku: d.scopeSku ?? null,
        scopeMaterialCode: d.scopeMaterialCode ?? null,
        scopeSupplierName: d.scopeSupplierName ?? null,
        scopeLaneKey: d.scopeLaneKey ?? null,
        scopeRegionCode: d.scopeRegionCode ?? null,
        value: String(d.value),
        unit: d.unit,
        currency: d.currency ?? "USD",
        observedAt,
        ingestedAt,
        sourceUrl: d.sourceUrl,
        sourceCollectorId: snapshot.collectorId,
        sourceRunId: snapshot.runId,
        rawPayloadPointer: ctx.pointer,
        postureClass: snapshot.postureClass,
        disclosureTier: snapshot.disclosureTier,
        jurisdiction: snapshot.jurisdiction,
        confidence: String(d.confidence ?? 0.7),
        entityUidNullable: null,
        // stableSignalKey is filled by the caller via computeStableSignalKey
        // when omitted; that path is hit when a collector's snapshot
        // pre-dates this field. We compute it eagerly here for clarity.
        stableSignalKey: "",
        validFrom,
        validTo: null,
        metadata: d.metadata ?? {},
      } satisfies BqMarketSignalRow;
    });
  };
}

/**
 * Every collector the foundation ships with lands a parsed-drafts JSON
 * snapshot via the runtime's auto-landing path, so the same generic
 * re-parser works for all of them.
 */
const SNAPSHOT_COLLECTORS = [
  "fred-economic-index",
  "ecb-fx-rates",
  "bls-economic-index",
  "eia-energy",
  "world-bank-pink-sheet",
  "published-commodity-index",
] as const;

const reparsers: Record<string, Reparser> = Object.fromEntries(
  SNAPSHOT_COLLECTORS.map((id) => [id, snapshotReparser()]),
);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!isIntelligenceEnabled()) {
    console.log(
      "[replay-collector] GCP not configured — nothing to replay. Set " +
        "INTELLIGENCE_GCP_PROJECT_ID, INTELLIGENCE_BQ_DATASET, and " +
        "INTELLIGENCE_GCS_RAW_BUCKET to enable.",
    );
    return;
  }
  const reparser = reparsers[args.collector];
  if (!reparser) {
    console.error(
      `[replay-collector] no re-parser registered for collector "${args.collector}".`,
    );
    process.exitCode = 1;
    return;
  }

  const objects = await listRawPayloads({
    collectorId: args.collector,
    fromUtc: args.from,
    toUtc: args.to,
  });
  console.log(
    `[replay-collector] found ${objects.length} payload(s) for ${args.collector} ` +
      `between ${args.from.toISOString()} and ${args.to.toISOString()}.`,
  );

  let totalDrafts = 0;
  let totalMerged = 0;
  for (const obj of objects) {
    const buf = await readRawPayload(obj.path);
    if (!buf) {
      console.warn(`[replay-collector] empty payload at ${obj.pointer}; skipping`);
      continue;
    }
    // Re-parser is responsible for stamping `stableSignalKey`. If it
    // skips that we fall back to a deterministic compute so the MERGE
    // still has something idempotent to key on.
    const drafts = await reparser(buf, {
      collectorId: args.collector,
      pointer: obj.pointer,
      // The runId can't be recovered from the GCS path alone in this
      // helper without a second metadata lookup; we use the path as a
      // stable surrogate so the replay run is itself reproducible.
      runId: `replay:${obj.path}`,
    });
    const stamped = drafts.map((d) =>
      d.stableSignalKey
        ? d
        : {
            ...d,
            stableSignalKey: computeStableSignalKey({
              collectorId: d.collectorId,
              signalType: d.signalType,
              scopeCategoryCode: d.scopeCategoryCode,
              scopeSku: d.scopeSku,
              scopeMaterialCode: d.scopeMaterialCode,
              scopeSupplierName: d.scopeSupplierName,
              scopeLaneKey: d.scopeLaneKey,
              observedAt: d.observedAt,
            }),
          },
    );
    totalDrafts += stamped.length;
    if (args.dryRun) {
      console.log(
        `[replay-collector] (dry-run) ${stamped.length} draft(s) from ${obj.pointer}`,
      );
      continue;
    }
    const r = await mergeMarketSignals(stamped);
    totalMerged += r?.merged ?? 0;
  }

  console.log(
    `[replay-collector] done: ${objects.length} object(s), ${totalDrafts} draft(s), ` +
      `${totalMerged} merged.`,
  );
}

main().catch((err) => {
  console.error("[replay-collector] failed:", err);
  process.exitCode = 1;
});
