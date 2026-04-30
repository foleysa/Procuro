import {
  db,
  collectorsTable,
  collectorAuditLogTable,
  marketSignalsTable,
  type CollectorRow,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";
import type { IntelligenceCollector, MarketSignalDraft } from "./collector";
import {
  ECB_FX_RATES_COLLECTOR_ID,
  fetchEcbBackfillDrafts,
} from "./collectors/ecb-fx-rates";

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
 * Insert a batch of MarketSignalDrafts for a collector, skipping rows that
 * already exist for the same `(scope_material_code, observed_at)` key.
 *
 * The ECB historical backfill anchors `observedAt` to a deterministic
 * `YYYY-MM-DDT15:00:00Z` (mirroring the live collector), so a simple
 * "already have a row at exactly this timestamp + pair" check is the
 * cheapest correct dedupe — and it does not require a schema migration.
 *
 * Existence is sampled once before the insert loop to avoid N round-trips.
 */
async function insertSignalsIdempotent(
  collectorRow: CollectorRow,
  drafts: MarketSignalDraft[],
): Promise<{ inserted: number; skipped: number }> {
  if (drafts.length === 0) return { inserted: 0, skipped: 0 };

  const existing = await db
    .select({
      key: marketSignalsTable.scopeMaterialCode,
      observedAt: marketSignalsTable.observedAt,
    })
    .from(marketSignalsTable)
    .where(
      and(
        eq(marketSignalsTable.collectorId, collectorRow.id),
        eq(marketSignalsTable.signalType, "fx_rate"),
      ),
    );

  const seen = new Set<string>();
  for (const r of existing) {
    if (r.key && r.observedAt) {
      seen.add(`${r.key}@${r.observedAt.toISOString()}`);
    }
  }

  let inserted = 0;
  let skipped = 0;
  for (const d of drafts) {
    const k = `${d.scopeMaterialCode ?? ""}@${d.observedAt.toISOString()}`;
    if (seen.has(k)) {
      skipped++;
      continue;
    }
    await db.insert(marketSignalsTable).values({
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
    seen.add(k);
    inserted++;
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
