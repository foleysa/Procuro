import {
  db,
  collectorsTable,
  collectorAuditLogTable,
  marketSignalsTable,
  type CollectorRow,
  type MarketSignalType,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";
import type { IntelligenceCollector, MarketSignalDraft } from "./collector";
import {
  ECB_FX_RATES_COLLECTOR_ID,
  fetchEcbBackfillDrafts,
} from "./collectors/ecb-fx-rates";
import {
  FRED_ECONOMIC_INDEX_COLLECTOR_ID,
  fetchFredBackfillDrafts,
  FRED_SERIES,
} from "./collectors/fred-economic-index";

const registry = new Map<string, IntelligenceCollector>();

export function registerCollector(c: IntelligenceCollector): void {
  registry.set(c.id, c);
}

export function getCollector(id: string): IntelligenceCollector | undefined {
  return registry.get(id);
}

export function listRegisteredCollectorIds(): string[] {
  return Array.from(registry.keys());
}

async function audit(
  collectorId: string,
  event: string,
  metadata: Record<string, unknown> = {},
  error?: string,
): Promise<void> {
  await db.insert(collectorAuditLogTable).values({
    id: newId("aud"),
    collectorId,
    event,
    metadata,
    error: error ?? null,
  });
}

export async function runCollector(
  collectorId: string,
  opts: { force?: boolean } = {},
): Promise<{ signalsCollected: number; durationMs: number; skipped?: string }> {
  const start = Date.now();
  const [reg] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, collectorId))
    .limit(1);

  if (!reg) {
    throw new Error(`Collector ${collectorId} not registered`);
  }

  // Hard gates: kill switch, posture, status.
  if (reg.killSwitch === 1) {
    await audit(collectorId, "skipped_kill_switch");
    return { signalsCollected: 0, durationMs: Date.now() - start, skipped: "kill_switch" };
  }
  if (reg.status !== "approved" && !opts.force) {
    await audit(collectorId, "skipped_not_approved", { status: reg.status });
    return {
      signalsCollected: 0,
      durationMs: Date.now() - start,
      skipped: "not_approved",
    };
  }
  if (reg.posture === "aggressive-crawl" && !opts.force) {
    // Enforce: aggressive collectors require an approved=true row AND explicit
    // force flag. The platform legal/compliance gate is recorded by approval.
    await audit(collectorId, "aggressive_requires_force");
    return {
      signalsCollected: 0,
      durationMs: Date.now() - start,
      skipped: "aggressive_requires_force",
    };
  }

  const collector = registry.get(collectorId);
  if (!collector) {
    await audit(collectorId, "no_implementation");
    throw new Error(
      `Collector ${collectorId} registered in DB but no runtime implementation`,
    );
  }

  try {
    await audit(collectorId, "fetch_started");
    const drafts = await collector.collect({ since: null });
    let inserted = 0;
    for (const d of drafts) {
      await db.insert(marketSignalsTable).values({
        id: newId("sig"),
        orgId: null,
        collectorId,
        signalType: d.signalType,
        scopeCategoryCode: d.scopeCategoryCode ?? null,
        scopeSku: d.scopeSku ?? null,
        scopeMaterialCode: d.scopeMaterialCode ?? null,
        scopeSupplierName: d.scopeSupplierName ?? null,
        scopeLaneKey: d.scopeLaneKey ?? null,
        value: String(d.value),
        unit: d.unit,
        currency: d.currency ?? "USD",
        observedAt: d.observedAt,
        sourceUrl: d.sourceUrl,
        posture: reg.posture,
        confidence: String(d.confidence ?? 0.7),
        metadata: d.metadata ?? {},
      });
      inserted++;
    }
    await audit(collectorId, "fetch_succeeded", { inserted });
    logger.info({ collectorId, inserted }, "Collector run completed");
    return { signalsCollected: inserted, durationMs: Date.now() - start };
  } catch (err) {
    const e = err as Error;
    await audit(collectorId, "fetch_failed", {}, e.message);
    throw e;
  }
}

export interface BackfillResult {
  collectorId: string;
  daysWritten: number;
  signalsInserted: number;
  signalsSkipped: number;
  durationMs: number;
}

/**
 * Build the dedupe key for an idempotent backfill insert. We key on the
 * combination of `signalType` plus all scope columns plus `observedAt` —
 * empty string when a column is null. This matches the natural identity of
 * a market signal: "the same source measurement of the same scope at the
 * same time", regardless of which scope column is populated.
 *
 * Backfill collectors (ECB, FRED) all anchor `observedAt` to a deterministic
 * timestamp matching what their live collector would write, so this string
 * key is a correct dedupe and does not require a schema migration.
 */
function signalDedupeKey(args: {
  signalType: string;
  scopeMaterialCode: string | null;
  scopeCategoryCode: string | null;
  scopeSku: string | null;
  scopeSupplierName: string | null;
  scopeLaneKey: string | null;
  observedAt: Date;
}): string {
  return [
    args.signalType,
    args.scopeMaterialCode ?? "",
    args.scopeCategoryCode ?? "",
    args.scopeSku ?? "",
    args.scopeSupplierName ?? "",
    args.scopeLaneKey ?? "",
    args.observedAt.toISOString(),
  ].join("|");
}

/**
 * Insert a batch of MarketSignalDrafts for a collector, skipping rows that
 * already exist for the same `(signal_type, scope_*, observed_at)` key.
 *
 * Backfills anchor `observedAt` to a deterministic UTC timestamp (e.g. the
 * ECB run anchors to `YYYY-MM-DDT15:00:00Z`, the FRED run anchors to
 * `YYYY-MM-DDT00:00:00Z`) so a string-key dedupe is correct without a
 * schema migration.
 *
 * Existence is sampled once before the insert loop (filtered to this
 * collector + the `signalType`s present in the draft batch) to avoid N
 * round-trips.
 */
async function insertSignalsIdempotent(
  collectorRow: CollectorRow,
  drafts: MarketSignalDraft[],
): Promise<{ inserted: number; skipped: number }> {
  if (drafts.length === 0) return { inserted: 0, skipped: 0 };

  // We could SELECT *only* for the signal types present in the drafts, but
  // collectors emit a single signal_type today (fx_rate for ECB,
  // economic_index for FRED). Filtering by collectorId + signalType
  // narrows the scan to the relevant slice.
  const signalTypes = Array.from(new Set(drafts.map((d) => d.signalType)));
  const existing: Array<{
    signalType: MarketSignalType;
    scopeMaterialCode: string | null;
    scopeCategoryCode: string | null;
    scopeSku: string | null;
    scopeSupplierName: string | null;
    scopeLaneKey: string | null;
    observedAt: Date | null;
  }> = [];
  for (const st of signalTypes) {
    const rows = await db
      .select({
        signalType: marketSignalsTable.signalType,
        scopeMaterialCode: marketSignalsTable.scopeMaterialCode,
        scopeCategoryCode: marketSignalsTable.scopeCategoryCode,
        scopeSku: marketSignalsTable.scopeSku,
        scopeSupplierName: marketSignalsTable.scopeSupplierName,
        scopeLaneKey: marketSignalsTable.scopeLaneKey,
        observedAt: marketSignalsTable.observedAt,
      })
      .from(marketSignalsTable)
      .where(
        and(
          eq(marketSignalsTable.collectorId, collectorRow.id),
          eq(marketSignalsTable.signalType, st),
        ),
      );
    existing.push(...rows);
  }

  const seen = new Set<string>();
  for (const r of existing) {
    if (!r.observedAt) continue;
    seen.add(
      signalDedupeKey({
        signalType: r.signalType,
        scopeMaterialCode: r.scopeMaterialCode,
        scopeCategoryCode: r.scopeCategoryCode,
        scopeSku: r.scopeSku,
        scopeSupplierName: r.scopeSupplierName,
        scopeLaneKey: r.scopeLaneKey,
        observedAt: r.observedAt,
      }),
    );
  }

  // Filter to just the new rows, deduping within the batch as well so a
  // single backfill payload that accidentally contains the same
  // (scope_material_code, observed_at) twice doesn't violate the implicit
  // uniqueness we rely on.
  const toInsert: Array<typeof marketSignalsTable.$inferInsert> = [];
  let skipped = 0;
  for (const d of drafts) {
    const k = signalDedupeKey({
      signalType: d.signalType,
      scopeMaterialCode: d.scopeMaterialCode ?? null,
      scopeCategoryCode: d.scopeCategoryCode ?? null,
      scopeSku: d.scopeSku ?? null,
      scopeSupplierName: d.scopeSupplierName ?? null,
      scopeLaneKey: d.scopeLaneKey ?? null,
      observedAt: d.observedAt,
    });
    if (seen.has(k)) {
      skipped++;
      continue;
    }
    seen.add(k);
    toInsert.push({
      id: newId("sig"),
      orgId: null,
      collectorId: collectorRow.id,
      signalType: d.signalType,
      scopeCategoryCode: d.scopeCategoryCode ?? null,
      scopeSku: d.scopeSku ?? null,
      scopeMaterialCode: d.scopeMaterialCode ?? null,
      scopeSupplierName: d.scopeSupplierName ?? null,
      scopeLaneKey: d.scopeLaneKey ?? null,
      value: String(d.value),
      unit: d.unit,
      currency: d.currency ?? "USD",
      observedAt: d.observedAt,
      sourceUrl: d.sourceUrl,
      posture: collectorRow.posture,
      confidence: String(d.confidence ?? 0.7),
      metadata: d.metadata ?? {},
    });
  }

  // Bulk-insert in chunks to keep each round-trip's parameter count well
  // under Postgres' 65535-parameter limit. The signal row has ~16 columns,
  // so 500 rows × 16 ≈ 8k params per statement — comfortably safe.
  const CHUNK_SIZE = 500;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
    await db.insert(marketSignalsTable).values(chunk);
    inserted += chunk.length;
  }
  return { inserted, skipped };
}

/**
 * Run the one-shot historical backfill for the ECB FX collector.
 *
 * Fetches `eurofxref-hist.xml` (one HTTP call), expands it to per-day
 * EUR-base + USD-derived drafts using the same shape the live collector
 * writes, and inserts only the day/pair rows that aren't already in
 * `market_signals`. Re-running is therefore a safe no-op.
 *
 * Gated on the same kill switch + approval status as the live collector so
 * a paused collector cannot be force-fed through the backfill path.
 */
export async function runEcbFxRatesBackfill(
  opts: { force?: boolean } = {},
): Promise<BackfillResult> {
  const start = Date.now();
  const collectorId = ECB_FX_RATES_COLLECTOR_ID;
  const [reg] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, collectorId))
    .limit(1);
  if (!reg) {
    throw new Error(`Collector ${collectorId} not registered`);
  }
  if (reg.killSwitch === 1) {
    await audit(collectorId, "backfill_skipped_kill_switch");
    throw new Error("Collector is killed; release the kill switch first.");
  }
  if (reg.status !== "approved" && !opts.force) {
    await audit(collectorId, "backfill_skipped_not_approved", {
      status: reg.status,
    });
    throw new Error(
      `Collector status is ${reg.status}; approve it before backfilling.`,
    );
  }

  await audit(collectorId, "backfill_started");
  try {
    const drafts = await fetchEcbBackfillDrafts();
    const days = new Set(
      drafts.map((d) => d.observedAt.toISOString().slice(0, 10)),
    ).size;
    const { inserted, skipped } = await insertSignalsIdempotent(reg, drafts);
    const result: BackfillResult = {
      collectorId,
      daysWritten: days,
      signalsInserted: inserted,
      signalsSkipped: skipped,
      durationMs: Date.now() - start,
    };
    await audit(collectorId, "backfill_succeeded", {
      days,
      inserted,
      skipped,
      drafts: drafts.length,
    });
    logger.info(
      { collectorId, days, inserted, skipped },
      "ECB FX backfill completed",
    );
    return result;
  } catch (err) {
    const e = err as Error;
    await audit(collectorId, "backfill_failed", {}, e.message);
    throw e;
  }
}

/**
 * Run the one-shot historical backfill for the FRED economic index
 * collector.
 *
 * Walks the curated `FRED_SERIES` list, fetches each series' observation
 * history (default: last 5 years) from the FRED API, and inserts only the
 * (series × observed_at) rows that aren't already in `market_signals`.
 * Re-running is therefore a safe no-op.
 *
 * Gated on the same kill switch + approval status as the live collector so
 * a paused collector cannot be force-fed through the backfill path. The
 * regular daily collector (`collect()`) is unaffected — it still emits
 * latest-observation-only signals on its cron.
 *
 * `observationStart` overrides the default 5-year window when the caller
 * needs a deeper or shallower history (admin tooling or tests).
 */
export async function runFredEconomicIndexBackfill(
  opts: { force?: boolean; observationStart?: string } = {},
): Promise<BackfillResult> {
  const start = Date.now();
  const collectorId = FRED_ECONOMIC_INDEX_COLLECTOR_ID;
  const [reg] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, collectorId))
    .limit(1);
  if (!reg) {
    throw new Error(`Collector ${collectorId} not registered`);
  }
  if (reg.killSwitch === 1) {
    await audit(collectorId, "backfill_skipped_kill_switch");
    throw new Error("Collector is killed; release the kill switch first.");
  }
  if (reg.status !== "approved" && !opts.force) {
    await audit(collectorId, "backfill_skipped_not_approved", {
      status: reg.status,
    });
    throw new Error(
      `Collector status is ${reg.status}; approve it before backfilling.`,
    );
  }

  await audit(collectorId, "backfill_started", {
    observationStart: opts.observationStart ?? null,
  });
  try {
    const { drafts, failedSeries } = await fetchFredBackfillDrafts(
      opts.observationStart ? { observationStart: opts.observationStart } : {},
    );
    // If every tracked series failed to fetch, the run is genuinely broken
    // (bad API key, FRED outage, network) — surface it to the caller so the
    // audit log records a failure instead of "succeeded with 0 inserts".
    if (drafts.length === 0 && failedSeries.length === FRED_SERIES.length) {
      const sample = failedSeries.slice(0, 3).map((f) => f.error).join("; ");
      throw new Error(
        `FRED backfill: all ${FRED_SERIES.length} series failed. Sample errors: ${sample}`,
      );
    }
    const days = new Set(
      drafts.map((d) => d.observedAt.toISOString().slice(0, 10)),
    ).size;
    const { inserted, skipped } = await insertSignalsIdempotent(reg, drafts);
    const result: BackfillResult = {
      collectorId,
      daysWritten: days,
      signalsInserted: inserted,
      signalsSkipped: skipped,
      durationMs: Date.now() - start,
    };
    await audit(collectorId, "backfill_succeeded", {
      days,
      inserted,
      skipped,
      drafts: drafts.length,
      failedSeries: failedSeries.length,
    });
    logger.info(
      { collectorId, days, inserted, skipped, failedSeries: failedSeries.length },
      "FRED economic index backfill completed",
    );
    return result;
  } catch (err) {
    const e = err as Error;
    await audit(collectorId, "backfill_failed", {}, e.message);
    throw e;
  }
}

export async function setKillSwitch(
  collectorId: string,
  on: boolean,
  actor?: string,
): Promise<CollectorRow | null> {
  const [row] = await db
    .update(collectorsTable)
    .set({ killSwitch: on ? 1 : 0 })
    .where(eq(collectorsTable.id, collectorId))
    .returning();
  await audit(collectorId, on ? "kill_switch_on" : "kill_switch_off", {
    actor: actor ?? null,
  });
  return row ?? null;
}

export async function approveCollector(
  collectorId: string,
  actor: string,
): Promise<CollectorRow | null> {
  const [row] = await db
    .update(collectorsTable)
    .set({ status: "approved", approvedBy: actor, approvedAt: new Date() })
    .where(eq(collectorsTable.id, collectorId))
    .returning();
  await audit(collectorId, "approved", { actor });
  return row ?? null;
}

export async function disableCollector(
  collectorId: string,
  actor: string,
  reason: "rejected" | "draft" = "rejected",
): Promise<CollectorRow | null> {
  const [row] = await db
    .update(collectorsTable)
    .set({ status: reason })
    .where(eq(collectorsTable.id, collectorId))
    .returning();
  await audit(collectorId, "disabled", { actor, reason });
  return row ?? null;
}

export async function setRateLimit(
  collectorId: string,
  rpm: number,
  actor: string,
): Promise<CollectorRow | null> {
  const safe = Math.max(1, Math.min(10000, Math.floor(rpm)));
  const [row] = await db
    .update(collectorsTable)
    .set({ rateLimitRpm: safe })
    .where(eq(collectorsTable.id, collectorId))
    .returning();
  await audit(collectorId, "rate_limit_set", { actor, rpm: safe });
  return row ?? null;
}

export async function upsertCollectorRegistration(args: {
  id: string;
  name: string;
  description: string;
  posture: CollectorRow["posture"];
  owner: string;
  sourceUrl: string;
  rateLimitRpm?: number;
  scheduleCron?: string | null;
  notes?: string | null;
  actor: string;
}): Promise<CollectorRow> {
  const existing = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, args.id))
    .limit(1);
  if (existing.length > 0) {
    const [updated] = await db
      .update(collectorsTable)
      .set({
        name: args.name,
        description: args.description,
        posture: args.posture,
        owner: args.owner,
        sourceUrl: args.sourceUrl,
        rateLimitRpm: args.rateLimitRpm ?? existing[0]!.rateLimitRpm,
        scheduleCron: args.scheduleCron ?? existing[0]!.scheduleCron,
        notes: args.notes ?? existing[0]!.notes,
      })
      .where(eq(collectorsTable.id, args.id))
      .returning();
    await audit(args.id, "registration_updated", { actor: args.actor });
    return updated!;
  }
  const [inserted] = await db
    .insert(collectorsTable)
    .values({
      id: args.id,
      name: args.name,
      description: args.description,
      posture: args.posture,
      status: "draft",
      owner: args.owner,
      sourceUrl: args.sourceUrl,
      rateLimitRpm: args.rateLimitRpm ?? 10,
      scheduleCron: args.scheduleCron ?? null,
      notes: args.notes ?? null,
    })
    .returning();
  await audit(args.id, "registered", { actor: args.actor });
  return inserted!;
}

export async function listCollectorAudit(
  collectorId: string,
  limit = 100,
): Promise<Array<typeof collectorAuditLogTable.$inferSelect>> {
  const { desc } = await import("drizzle-orm");
  return await db
    .select()
    .from(collectorAuditLogTable)
    .where(eq(collectorAuditLogTable.collectorId, collectorId))
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(Math.max(1, Math.min(500, limit)));
}
