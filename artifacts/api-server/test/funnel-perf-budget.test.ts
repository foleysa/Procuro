/**
 * Funnel snapshot perf budget (task #190).
 *
 * The snapshot writer runs synchronously inside every analysis cycle, so
 * a regression in any of its queries (cohort joins, calibration, etc.)
 * directly slows down the cycle itself. This test seeds a realistic
 * "large tenant" footprint — ~5,000 opportunities + ~5,000 decisions
 * spread across many cohorts and the trailing 90d window — then runs
 * `captureFunnelSnapshot` 20 times and asserts p95 captureDurationMs
 * stays under 500ms. If a future change adds an expensive join or a
 * cohort drill-down blow-up, this guardrail fails CI before slow cycles
 * ship to production.
 *
 * Fixtures are namespaced by a per-run prefix and torn down via the
 * orgs-cascade in `after()`, matching the funnel-snapshot.test.ts
 * pattern.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  categoriesTable,
  opportunitiesTable,
  decisionsTable,
  analysisCyclesTable,
  funnelSnapshotsTable,
  type OpportunityRow,
  type LeverId,
  type InsertOpportunityRow,
  type InsertDecisionRow,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";

import { captureFunnelSnapshot } from "../src/lib/ooda/funnel";
import {
  type AnalyzeResult,
  type LeverAnalyzer,
  type OpportunityDraft,
} from "../src/lib/levers/types";

const RUN = `t190-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

// Tunable seed parameters. Sized to match the task spec: ~5,000 opps
// across "many" cohorts. 100 distinct cohort keys × 50 opps each = 5,000.
const COHORT_COUNT = 100;
const OPPS_PER_COHORT = 50;
const TOTAL_OPPS = COHORT_COUNT * OPPS_PER_COHORT;
// Snapshot the writer this many times to compute p95.
const CAPTURE_ITERATIONS = 20;
// Per-cycle batch the writer treats as "just persisted" — realistic
// large-tenant fanout. Sized to exercise buildCohortDrilldown across
// every seeded cohort so regressions in that pure-JS path surface here.
const PERSISTED_OPPS_PER_CYCLE = TOTAL_OPPS;
// The capture budget. Single-digit ms today; 500ms gives plenty of
// headroom while still catching pathological regressions.
const P95_BUDGET_MS = 500;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

const stubLever: LeverAnalyzer = {
  leverId: "spot_vs_contract" as LeverId,
  tier: 2,
  label: "stub",
  description: "stub",
  analyze: async () => ({
    drafts: [],
    consultedSignalIds: [],
    candidatesEvaluated: 0,
  }),
  cohortKey(draft: OpportunityDraft): string {
    const i = draft.inputs as Record<string, unknown>;
    return String(i["categoryCode"] ?? "");
  },
};

let orgId: string;
let supplierId: string;
let categoryId: string;
let seedCycleId: string;
let captureCycleIds: string[] = [];
let persistedOpps: OpportunityRow[] = [];

async function bulkInsert<T>(
  rows: T[],
  insertChunk: (chunk: T[]) => Promise<unknown>,
  chunkSize = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insertChunk(rows.slice(i, i + chunkSize));
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

describe("OODA funnel snapshot perf budget", () => {
  before(async () => {
    orgId = newId("org");
    await db.insert(orgsTable).values({
      id: orgId,
      name: `${RUN} large`,
      slug: `${RUN}-large`,
    });

    supplierId = newId("sup");
    await db.insert(suppliersTable).values({
      id: supplierId,
      orgId,
      name: `${RUN} sup`,
      normalizedName: `${RUN} sup`,
      sourceSystem: "csv",
      sourceExternalId: `${RUN}-sup`,
    });

    categoryId = newId("cat");
    await db.insert(categoriesTable).values({
      id: categoryId,
      orgId,
      code: `${RUN}-CAT`,
      name: "Test cat",
      class: "service",
      sourceSystem: "csv",
      sourceExternalId: `${RUN}-cat`,
    });

    // One cycle is used as the FK target for the seeded opportunities;
    // each capture iteration gets its own cycle so the unique index on
    // `funnel_snapshots.cycle_id` is satisfied across the loop.
    seedCycleId = newId("cyc");
    await db.insert(analysisCyclesTable).values({
      id: seedCycleId,
      orgId,
      generation: 1,
      triggeredBy: "test",
      status: "completed",
      completedAt: new Date(),
    });
    const captureCycleRows = Array.from(
      { length: CAPTURE_ITERATIONS },
      (_, i) => ({
        id: newId("cyc"),
        orgId,
        generation: 1000 + i,
        triggeredBy: "test",
        status: "completed" as const,
        completedAt: new Date(),
      }),
    );
    await db.insert(analysisCyclesTable).values(captureCycleRows);
    captureCycleIds = captureCycleRows.map((r) => r.id);

    // Seed ~5,000 opps across COHORT_COUNT distinct cohort keys. The
    // cohort key on the stub lever is `inputs.categoryCode`, so each
    // distinct code = distinct cohort.
    const oppRows: InsertOpportunityRow[] = [];
    for (let i = 0; i < TOTAL_OPPS; i++) {
      const cohortIdx = i % COHORT_COUNT;
      const raw = 1000 + (i % 1000);
      oppRows.push({
        id: newId("opp"),
        orgId,
        cycleId: seedCycleId,
        leverId: stubLever.leverId,
        tier: 2,
        title: `${RUN} opp ${i}`,
        rationale: "stub",
        recommendedAction: "stub",
        supplierId,
        categoryId,
        rawProjectedSavingsUsd: raw.toFixed(2),
        projectedSavingsUsd: (raw * 0.8).toFixed(2),
        confidence: "0.5000",
        inputs: { categoryCode: `C${cohortIdx}` },
      });
    }
    await bulkInsert(oppRows, (chunk) =>
      db.insert(opportunitiesTable).values(chunk),
    );

    // Seed decisions across the trailing 90 days so cohort-stage and
    // calibration joins both have material work to do. Mix event types
    // and ages; ~20% realize events with realizedSavingsUsd populated
    // to exercise the calibration query.
    const decRows: InsertDecisionRow[] = [];
    const events: Array<"approve" | "execute" | "realize"> = [
      "approve",
      "execute",
      "realize",
      "approve",
      "execute",
    ];
    for (let i = 0; i < oppRows.length; i++) {
      const opp = oppRows[i]!;
      const eventType = events[i % events.length]!;
      // Spread decisions evenly across the last 89 days.
      const ageDays = (i % 89) + 1;
      const createdAt = new Date(Date.now() - ageDays * 86400_000);
      decRows.push({
        id: newId("dec"),
        opportunityId: opp.id!,
        orgId,
        cycleId: seedCycleId,
        eventType,
        actor: "perf@example.com",
        createdAt,
        realizedSavingsUsd:
          eventType === "realize"
            ? (Number(opp.projectedSavingsUsd) * 0.9).toFixed(2)
            : null,
      });
    }
    await bulkInsert(decRows, (chunk) =>
      db.insert(decisionsTable).values(chunk),
    );

    // Pull the seeded opps back so we can pass realistic OpportunityRow
    // objects into the snapshot writer (it loops over them for the
    // cohort drill-down).
    persistedOpps = await db
      .select()
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.orgId, orgId));
    assert.equal(
      persistedOpps.length,
      TOTAL_OPPS,
      "expected seeded opportunity count",
    );
  });

  it(`p95 captureDurationMs stays under ${P95_BUDGET_MS}ms across ${CAPTURE_ITERATIONS} runs`, async () => {
    const captureBatch = persistedOpps.slice(0, PERSISTED_OPPS_PER_CYCLE);
    // Build one analyze-result shaped like the cycle runner produces.
    // No drafts/signals — the perf cost we care about lives in the DB
    // queries and the cohort drill-down loop, both keyed off the
    // seeded data.
    const result: AnalyzeResult = {
      drafts: [],
      consultedSignalIds: [],
      candidatesEvaluated: 0,
    };

    const durations: number[] = [];
    const snapshotIds: string[] = [];
    for (let i = 0; i < CAPTURE_ITERATIONS; i++) {
      const r = await captureFunnelSnapshot({
        orgId,
        cycleId: captureCycleIds[i]!,
        cycleGeneration: 1000 + i,
        leverResults: [{ lever: stubLever, result }],
        draftsPostExclusion: [],
        persistedOpps: captureBatch,
        priorDeltas: [],
      });
      assert.equal(r.failed, false, `iteration ${i} must not fail`);
      assert.ok(r.snapshotId, `iteration ${i} must return a snapshot id`);
      snapshotIds.push(r.snapshotId!);
    }

    // Read captureDurationMs back from the inserted snapshots — that's
    // the value the snapshot writer itself recorded, which is what
    // production observability also tracks.
    const snaps = await db
      .select({
        id: funnelSnapshotsTable.id,
        captureDurationMs: funnelSnapshotsTable.captureDurationMs,
      })
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.orgId, orgId));
    const byId = new Map(snaps.map((s) => [s.id, s.captureDurationMs]));
    for (const id of snapshotIds) {
      const ms = byId.get(id);
      assert.ok(typeof ms === "number", `missing duration for snapshot ${id}`);
      durations.push(ms);
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const p50 = quantile(sorted, 0.5);
    const p95 = quantile(sorted, 0.95);
    const max = sorted[sorted.length - 1]!;
    // Surface the distribution on failure so a future investigator can
    // see what regressed.
    assert.ok(
      p95 < P95_BUDGET_MS,
      `p95 capture ${p95.toFixed(1)}ms >= budget ${P95_BUDGET_MS}ms ` +
        `(p50=${p50.toFixed(1)}ms, max=${max.toFixed(1)}ms, ` +
        `n=${durations.length}, samples=${sorted.map((d) => d.toFixed(0)).join(",")})`,
    );
  });

  after(async () => {
    const safe = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* swallow */
      }
    };
    if (orgId) await safe(db.delete(orgsTable).where(eq(orgsTable.id, orgId)));
    await safe(
      db
        .delete(suppliersTable)
        .where(like(suppliersTable.sourceExternalId, `${RUN}-%`)),
    );
    await safe(
      db
        .delete(categoriesTable)
        .where(like(categoriesTable.sourceExternalId, `${RUN}-%`)),
    );
  });
});
