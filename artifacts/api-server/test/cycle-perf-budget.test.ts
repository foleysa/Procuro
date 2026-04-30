/**
 * OODA cycle perf budget (task #198).
 *
 * The funnel snapshot writer already has its own guardrail
 * (`funnel-perf-budget.test.ts`). This test extends the same pattern
 * to the rest of the analysis cycle so a slowdown in any of the
 * stages users feel directly — signal collection, lever analyze,
 * opportunity persist, learn-step priors — fails CI before slow
 * cycles ship to production.
 *
 * We seed a "realistic large tenant" footprint — ~5,000 opportunities
 * across 100 cohorts plus ~5,000 outcome decisions across the trailing
 * 90 days — and assert each stage stays under an explicit p95 budget.
 * The budgets are sized at multiples of measured baseline so they
 * catch pathological regressions without flapping on noisy CI.
 *
 * Stages covered:
 *   1. signal collection         — observeStep + collectOutcomesSinceLastCycle
 *   2. lever pipeline analyze    — every ALL_LEVERS analyzer run sequentially
 *   3. opportunity persist       — bulk-inserting a cycle's worth of opps
 *   4. learn-step priors         — applyLearnUpdates with realistic outcomes
 *   5. cycle end-to-end          — runAnalysisCycle as a single budget
 *
 * Fixtures are namespaced by a per-run prefix and torn down via the
 * orgs-cascade in `after()`, matching the funnel-perf-budget.test.ts
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
  learnedPriorsTable,
  exclusionRulesTable,
  type InsertOpportunityRow,
  type InsertDecisionRow,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";

import {
  runAnalysisCycle,
  observeStep,
  collectOutcomesSinceLastCycle,
} from "../src/lib/ooda/cycle";
import {
  applyLearnUpdates,
  ensurePriorsBootstrapped,
  type OutcomeStats,
} from "../src/lib/ooda/priors";
import { ALL_LEVERS } from "../src/lib/levers";

const RUN = `t198-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

// Tunable seed parameters. Match the funnel-perf-budget shape
// (~5,000 opps across many cohorts) so the two perf tests reason
// about the same "large tenant" footprint.
const COHORT_COUNT = 100;
const OPPS_PER_COHORT = 50;
const TOTAL_OPPS = COHORT_COUNT * OPPS_PER_COHORT;
// Decision events are spread across the trailing 89 days so the
// observe + learn queries have material data to scan.
const TOTAL_DECISIONS = TOTAL_OPPS;
// Number of synthetic opportunities the persist test inserts per
// iteration. Sized at a typical large-cycle output volume so the
// budget reflects realistic Act-step fanout.
const PERSIST_BATCH = 200;

// Per-stage iteration counts. The cheaper / lower-variance stages
// run more iterations so p95 is meaningful; runAnalysisCycle is
// expensive end-to-end so we run fewer.
const OBSERVE_ITERATIONS = 20;
const LEARN_ITERATIONS = 20;
const LEVER_ITERATIONS = 5;
const PERSIST_ITERATIONS = 10;
const E2E_ITERATIONS = 3;

// Per-stage p95 budgets (ms). Each is several multiples of the
// measured baseline (single-digit to low-hundred ms today) so a
// real regression (a missing index, an O(n^2) loop, an extra
// per-row round trip, etc.) trips the guardrail well before users
// feel it, while leaving enough headroom to absorb noisy CI.
const OBSERVE_P95_BUDGET_MS = 500;
const LEARN_P95_BUDGET_MS = 750;
const LEVER_P95_BUDGET_MS = 1500;
const PERSIST_P95_BUDGET_MS = 2000;
const E2E_P95_BUDGET_MS = 3000;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
let supplierId: string;
let categoryId: string;
// "Previous" cycle whose completedAt is far enough in the past that
// every seeded decision lands strictly after it — that way
// collectOutcomesSinceLastCycle has the full ~5,000 events to chew on.
let previousCycleId: string;

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

interface PerfRunResult {
  durations: number[];
  p50: number;
  p95: number;
  max: number;
}

async function runIterations(
  iterations: number,
  fn: () => Promise<unknown>,
): Promise<PerfRunResult> {
  const durations: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    durations.push(performance.now() - start);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    durations: sorted,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
  };
}

function fmtSamples(sorted: number[]): string {
  return sorted.map((d) => d.toFixed(0)).join(",");
}

describe("OODA cycle perf budget", () => {
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

    // Backdate the seed cycle so every decision created over the
    // trailing 89 days is strictly *after* its completedAt — that's
    // how collectOutcomesSinceLastCycle decides what counts as "new".
    previousCycleId = newId("cyc");
    await db.insert(analysisCyclesTable).values({
      id: previousCycleId,
      orgId,
      generation: 1,
      triggeredBy: "test",
      status: "completed",
      completedAt: new Date(Date.now() - 100 * 86400_000),
    });

    // Seed ~5,000 opps across COHORT_COUNT distinct cohort keys.
    const oppRows: InsertOpportunityRow[] = [];
    for (let i = 0; i < TOTAL_OPPS; i++) {
      const cohortIdx = i % COHORT_COUNT;
      const raw = 1000 + (i % 1000);
      // Spread across all real lever ids so applyLearnUpdates has
      // an outcome bucket per lever, exercising the full per-lever
      // update loop instead of just one row.
      const lever = ALL_LEVERS[i % ALL_LEVERS.length]!;
      oppRows.push({
        id: newId("opp"),
        orgId,
        cycleId: previousCycleId,
        leverId: lever.leverId,
        tier: lever.tier,
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

    // Seed decisions across the trailing 89 days so the observe +
    // learn queries both have material work to do. Mix event types
    // so the bucketing path inside collectOutcomesSinceLastCycle
    // exercises every branch.
    const decRows: InsertDecisionRow[] = [];
    const events: Array<"approve" | "execute" | "realize" | "reject"> = [
      "approve",
      "execute",
      "realize",
      "approve",
      "reject",
    ];
    for (let i = 0; i < TOTAL_DECISIONS; i++) {
      const opp = oppRows[i]!;
      const eventType = events[i % events.length]!;
      const ageDays = (i % 89) + 1;
      const createdAt = new Date(Date.now() - ageDays * 86400_000);
      decRows.push({
        id: newId("dec"),
        opportunityId: opp.id!,
        orgId,
        cycleId: previousCycleId,
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

    // Bootstrap priors so the learn step has rows to update.
    await ensurePriorsBootstrapped(orgId);
  });

  it(`signal collection p95 stays under ${OBSERVE_P95_BUDGET_MS}ms across ${OBSERVE_ITERATIONS} runs`, async () => {
    const result = await runIterations(OBSERVE_ITERATIONS, async () => {
      // Both queries together represent the OODA "Observe" step —
      // counts on tenant entities + outcome events since prev cycle.
      await observeStep(orgId, previousCycleId);
      await collectOutcomesSinceLastCycle(orgId, previousCycleId);
    });
    assert.ok(
      result.p95 < OBSERVE_P95_BUDGET_MS,
      `p95 observe ${result.p95.toFixed(1)}ms >= budget ${OBSERVE_P95_BUDGET_MS}ms ` +
        `(p50=${result.p50.toFixed(1)}ms, max=${result.max.toFixed(1)}ms, ` +
        `n=${result.durations.length}, samples=${fmtSamples(result.durations)})`,
    );
  });

  it(`learn-step priors p95 stays under ${LEARN_P95_BUDGET_MS}ms across ${LEARN_ITERATIONS} runs`, async () => {
    // Build a realistic OutcomeStats batch covering every lever so
    // the per-lever update loop runs end-to-end. Numbers loosely
    // match the seeded decisions: ~40% approvals, 20% rejections,
    // 20% realizations per lever.
    const perLever = Math.max(
      1,
      Math.floor(TOTAL_DECISIONS / ALL_LEVERS.length),
    );
    const outcomes: OutcomeStats[] = ALL_LEVERS.map((l) => ({
      leverId: l.leverId,
      approvals: Math.floor(perLever * 0.4),
      rejections: Math.floor(perLever * 0.2),
      realizations: Math.floor(perLever * 0.2),
      realizationRatioSum: Math.floor(perLever * 0.2) * 0.9,
      rejectionRules: [],
    }));

    const result = await runIterations(LEARN_ITERATIONS, async () => {
      // applyLearnUpdates is idempotent on prior rows (UPDATE) and
      // de-dupes exclusion rules — calling it N times is a fair
      // proxy for "Learn step ran on this outcome batch".
      await applyLearnUpdates({
        orgId,
        cycleId: previousCycleId,
        cycleGeneration: 1,
        outcomes,
      });
    });
    assert.ok(
      result.p95 < LEARN_P95_BUDGET_MS,
      `p95 learn ${result.p95.toFixed(1)}ms >= budget ${LEARN_P95_BUDGET_MS}ms ` +
        `(p50=${result.p50.toFixed(1)}ms, max=${result.max.toFixed(1)}ms, ` +
        `n=${result.durations.length}, samples=${fmtSamples(result.durations)})`,
    );
  });

  it(`lever pipeline analyze p95 stays under ${LEVER_P95_BUDGET_MS}ms across ${LEVER_ITERATIONS} runs`, async () => {
    // One iteration runs every lever's analyze() against the seeded
    // tenant — same shape as the cycle runner's Decide step. Levers
    // are read-only, so repeated iterations are safe.
    const result = await runIterations(LEVER_ITERATIONS, async () => {
      for (const lever of ALL_LEVERS) {
        await lever.analyze({ orgId, cycleId: previousCycleId });
      }
    });
    assert.ok(
      result.p95 < LEVER_P95_BUDGET_MS,
      `p95 lever ${result.p95.toFixed(1)}ms >= budget ${LEVER_P95_BUDGET_MS}ms ` +
        `(p50=${result.p50.toFixed(1)}ms, max=${result.max.toFixed(1)}ms, ` +
        `n=${result.durations.length}, samples=${fmtSamples(result.durations)})`,
    );
  });

  it(`opportunity persist p95 stays under ${PERSIST_P95_BUDGET_MS}ms across ${PERSIST_ITERATIONS} runs`, async () => {
    // Each iteration persists PERSIST_BATCH opps the same way the
    // cycle runner's Act step does (one INSERT per opp inside a
    // tight loop) so per-row overhead is measured honestly.
    let iter = 0;
    const result = await runIterations(PERSIST_ITERATIONS, async () => {
      const tag = iter++;
      for (let i = 0; i < PERSIST_BATCH; i++) {
        const lever = ALL_LEVERS[i % ALL_LEVERS.length]!;
        await db.insert(opportunitiesTable).values({
          id: newId("opp"),
          orgId,
          cycleId: previousCycleId,
          leverId: lever.leverId,
          tier: lever.tier,
          title: `${RUN} persist ${tag}-${i}`,
          rationale: "stub",
          recommendedAction: "stub",
          supplierId,
          categoryId,
          rawProjectedSavingsUsd: "100.00",
          projectedSavingsUsd: "80.00",
          confidence: "0.5000",
          inputs: {},
        });
      }
    });
    assert.ok(
      result.p95 < PERSIST_P95_BUDGET_MS,
      `p95 persist ${result.p95.toFixed(1)}ms >= budget ${PERSIST_P95_BUDGET_MS}ms ` +
        `(p50=${result.p50.toFixed(1)}ms, max=${result.max.toFixed(1)}ms, ` +
        `n=${result.durations.length}, samples=${fmtSamples(result.durations)})`,
    );
  });

  it(`runAnalysisCycle end-to-end p95 stays under ${E2E_P95_BUDGET_MS}ms across ${E2E_ITERATIONS} runs`, async () => {
    // End-to-end coverage: Observe + Learn + Orient + Decide + Act
    // + funnel snapshot. Catches regressions in stages we don't
    // cover individually (exclusion gate, ranking) and in the glue
    // between phases.
    const result = await runIterations(E2E_ITERATIONS, async () => {
      await runAnalysisCycle({ orgId, triggeredBy: "perf-test" });
    });
    assert.ok(
      result.p95 < E2E_P95_BUDGET_MS,
      `p95 cycle ${result.p95.toFixed(1)}ms >= budget ${E2E_P95_BUDGET_MS}ms ` +
        `(p50=${result.p50.toFixed(1)}ms, max=${result.max.toFixed(1)}ms, ` +
        `n=${result.durations.length}, samples=${fmtSamples(result.durations)})`,
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
    // Tear down via the orgs cascade — covers analysis_cycles,
    // opportunities, decisions, learned_priors, exclusion_rules,
    // funnel_snapshots, etc. Suppliers/categories also cascade but
    // we belt-and-suspenders by-prefix to cover any rows whose
    // org-cascade didn't reach (e.g., shared lookups in the future).
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
    // Clean up any global priors / exclusions that may have been
    // touched (no-ops if the orgs-cascade already removed them).
    await safe(
      db
        .delete(learnedPriorsTable)
        .where(eq(learnedPriorsTable.orgId, orgId)),
    );
    await safe(
      db
        .delete(exclusionRulesTable)
        .where(eq(exclusionRulesTable.orgId, orgId)),
    );
  });
});
