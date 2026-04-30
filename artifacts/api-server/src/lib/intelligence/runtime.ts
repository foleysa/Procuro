import {
  db,
  collectorsTable,
  collectorAuditLogTable,
  marketSignalsTable,
  type CollectorRow,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";
import { CANCELLED_ERROR_MESSAGE, UnrecoverableJobError } from "../jobs/queue";
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

/**
 * Inference target matching the unique *index* defined in
 * `lib/db/src/schema/marketSignals.ts`:
 *
 *   UNIQUE (collector_id, signal_type,
 *           COALESCE(scope_category_code, ''),
 *           COALESCE(scope_sku, ''),
 *           COALESCE(scope_material_code, ''),
 *           COALESCE(scope_supplier_name, ''),
 *           COALESCE(scope_lane_key, ''),
 *           observed_at)
 *
 * `uniqueIndex(...)` in drizzle creates a Postgres index, not a
 * constraint — so `ON CONFLICT ON CONSTRAINT <name>` can't see it. The
 * expression-list form below makes Postgres *infer* exactly this index
 * (and only this index) for the conflict target. That's still much
 * stricter than an unqualified `ON CONFLICT DO NOTHING`: a PK collision
 * or any future unique index/constraint won't match this inference list,
 * so they will fail loudly instead of being silently swallowed as a
 * "duplicate".
 */
const NATURAL_KEY_ON_CONFLICT = sql`ON CONFLICT (
  collector_id, signal_type,
  COALESCE(scope_category_code, ''),
  COALESCE(scope_sku, ''),
  COALESCE(scope_material_code, ''),
  COALESCE(scope_supplier_name, ''),
  COALESCE(scope_lane_key, ''),
  observed_at
) DO NOTHING`;

/**
 * Coerce empty/whitespace strings to `null` for the nullable scope_* columns.
 *
 * The natural-key unique index uses `COALESCE(col, '')` so a `NULL` and an
 * empty string in the same column collide. Without normalization, a
 * collector that accidentally emitted `""` for a scope field would
 * silently overwrite (or be overwritten by) an unscoped row from a
 * different collector. Treating blank as null makes the dedupe contract
 * unambiguous: blank means "no scope", same as `null`.
 */
function normalizeScope(v: string | undefined | null): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build a parameterized `INSERT ... ON CONFLICT ON CONSTRAINT … DO NOTHING
 * RETURNING id` for `market_signals`.
 *
 * Drizzle's typed `onConflictDoNothing({ target })` API in this version
 * only accepts plain column references — it can't express the COALESCE
 * expression list our index uses, and an unqualified
 * `onConflictDoNothing()` would silence *any* unique-constraint violation
 * (PK, future constraints), which is too forgiving. Targeting the index
 * by name keeps the semantics tight and obvious.
 */
async function insertSignalsWithDedupe(
  rows: Array<typeof marketSignalsTable.$inferInsert>,
): Promise<{ inserted: number; duplicates: number }> {
  if (rows.length === 0) return { inserted: 0, duplicates: 0 };

  const valuesClause = sql.join(
    rows.map(
      (r) => sql`(
        ${r.id},
        ${r.orgId ?? null},
        ${r.collectorId},
        ${r.signalType},
        ${r.scopeCategoryCode ?? null},
        ${r.scopeSku ?? null},
        ${r.scopeMaterialCode ?? null},
        ${r.scopeSupplierName ?? null},
        ${r.scopeLaneKey ?? null},
        ${String(r.value)}::numeric,
        ${r.unit},
        ${r.currency ?? "USD"},
        ${r.observedAt},
        ${r.sourceUrl},
        ${r.posture},
        ${String(r.confidence ?? "0.7")}::numeric,
        ${JSON.stringify(r.metadata ?? {})}::jsonb
      )`,
    ),
    sql`, `,
  );

  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO ${marketSignalsTable}
      (id, org_id, collector_id, signal_type,
       scope_category_code, scope_sku, scope_material_code,
       scope_supplier_name, scope_lane_key,
       value, unit, currency,
       observed_at, source_url, posture, confidence, metadata)
    VALUES ${valuesClause}
    ${NATURAL_KEY_ON_CONFLICT}
    RETURNING id
  `);

  const inserted = result.rows.length;
  return { inserted, duplicates: rows.length - inserted };
}

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
  opts: {
    force?: boolean;
    /**
     * Optional cooperative-cancellation hook from the job worker. We
     * check it at the two points that matter: right before the
     * potentially-long `collector.collect()` HTTP fetch, and right
     * before persisting signals (so we don't half-write a batch).
     * The skip-gates above are pure DB lookups and run fast enough
     * that an extra check there would just add noise.
     */
    isCancelled?: () => Promise<boolean>;
  } = {},
): Promise<{ signalsCollected: number; durationMs: number; skipped?: string }> {
  const start = Date.now();

  // Deterministic input validation: an empty / missing collector ID can
  // never succeed on a retry with the same payload. Throwing
  // UnrecoverableJobError here ensures the job runner skips the backoff
  // ladder and fails the job immediately.
  if (typeof collectorId !== "string" || collectorId.trim() === "") {
    throw new UnrecoverableJobError(
      "runCollector requires a non-empty collectorId",
    );
  }

  const checkCancel = async (): Promise<void> => {
    if (opts.isCancelled && (await opts.isCancelled())) {
      throw new Error(CANCELLED_ERROR_MESSAGE);
    }
  };

  const [reg] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, collectorId))
    .limit(1);

  if (!reg) {
    // Unknown collector ID is a deterministic permanent failure for this
    // payload — no amount of retrying will create the registry row.
    throw new UnrecoverableJobError(
      `Collector ${collectorId} not registered`,
    );
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
    // The registry row exists but no in-process implementation is wired
    // up. Retrying with the same payload cannot fix this — the only
    // remedy is shipping new code that registers the collector.
    throw new UnrecoverableJobError(
      `Collector ${collectorId} registered in DB but no runtime implementation`,
    );
  }

  try {
    await checkCancel();
    await audit(collectorId, "fetch_started");
    const drafts = await collector.collect({ since: null });
    await checkCancel();
    const rows = drafts.map((d) => ({
      id: newId("sig"),
      orgId: null,
      collectorId,
      signalType: d.signalType,
      scopeCategoryCode: normalizeScope(d.scopeCategoryCode),
      scopeSku: normalizeScope(d.scopeSku),
      scopeMaterialCode: normalizeScope(d.scopeMaterialCode),
      scopeSupplierName: normalizeScope(d.scopeSupplierName),
      scopeLaneKey: normalizeScope(d.scopeLaneKey),
      value: String(d.value),
      unit: d.unit,
      currency: d.currency ?? "USD",
      observedAt: d.observedAt,
      sourceUrl: d.sourceUrl,
      posture: reg.posture,
      confidence: String(d.confidence ?? 0.7),
      metadata: d.metadata ?? {},
    }));
    const { inserted, duplicates } = await insertSignalsWithDedupe(rows);
    await audit(collectorId, "fetch_succeeded", {
      inserted,
      duplicates,
      drafts: drafts.length,
    });
    logger.info(
      { collectorId, inserted, duplicates, drafts: drafts.length },
      "Collector run completed",
    );
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
 * already exist on the natural-key unique index.
 *
 * Used by the ECB and FRED historical backfills, which can produce
 * thousands of rows spanning years. Two protections against duplicates
 * apply:
 *   1. **In-batch**: a `signalDedupeKey` Set collapses drafts that an
 *      upstream feed accidentally repeats inside the same payload —
 *      Postgres would otherwise reject the second occurrence within a
 *      single INSERT statement ("command cannot affect row a second
 *      time") even with ON CONFLICT DO NOTHING. The key spans every
 *      column in the natural index so it's safe across signal types
 *      (ECB's `fx_rate` and FRED's `economic_index` use different
 *      scope columns).
 *   2. **Across runs**: chunked inserts go through
 *      `insertSignalsWithDedupe`, which targets the
 *      `market_signals_natural_key_uq` index by expression-list
 *      inference — already-persisted rows are silently skipped at the
 *      database, so repeat backfills are atomic and race-free.
 */
async function insertSignalsIdempotent(
  collectorRow: CollectorRow,
  drafts: MarketSignalDraft[],
): Promise<{ inserted: number; skipped: number }> {
  if (drafts.length === 0) return { inserted: 0, skipped: 0 };

  const seenInBatch = new Set<string>();
  const toInsert: Array<typeof marketSignalsTable.$inferInsert> = [];
  let inBatchSkipped = 0;
  for (const d of drafts) {
    const scopeMaterialCode = normalizeScope(d.scopeMaterialCode);
    const scopeCategoryCode = normalizeScope(d.scopeCategoryCode);
    const scopeSku = normalizeScope(d.scopeSku);
    const scopeSupplierName = normalizeScope(d.scopeSupplierName);
    const scopeLaneKey = normalizeScope(d.scopeLaneKey);
    const k = signalDedupeKey({
      signalType: d.signalType,
      scopeMaterialCode,
      scopeCategoryCode,
      scopeSku,
      scopeSupplierName,
      scopeLaneKey,
      observedAt: d.observedAt,
    });
    if (seenInBatch.has(k)) {
      inBatchSkipped++;
      continue;
    }
    seenInBatch.add(k);
    toInsert.push({
      id: newId("sig"),
      orgId: null,
      collectorId: collectorRow.id,
      signalType: d.signalType,
      scopeCategoryCode,
      scopeSku,
      scopeMaterialCode,
      scopeSupplierName,
      scopeLaneKey,
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

  // Chunked to keep each round-trip's parameter count well under
  // Postgres' 65535-parameter limit. Signal row ≈ 17 columns, so
  // 500 rows × 17 ≈ 8.5k params per statement — comfortably safe.
  const CHUNK_SIZE = 500;
  let inserted = 0;
  let crossRunDuplicates = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
    const r = await insertSignalsWithDedupe(chunk);
    inserted += r.inserted;
    crossRunDuplicates += r.duplicates;
  }
  return { inserted, skipped: inBatchSkipped + crossRunDuplicates };
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
