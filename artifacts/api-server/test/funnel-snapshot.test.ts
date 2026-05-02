/**
 * Funnel substrate (task #185) tests.
 *
 * Exercises captureFunnelSnapshot and detectAndAnnotateDeltas against a
 * real database. We seed two orgs to assert cross-tenant isolation in
 * the same harness.
 *
 * Each fixture row is namespaced by a per-run prefix and torn down in
 * `after()` so concurrent test runs against the same database stay
 * isolated.
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
  funnelAnnotationsTable,
  funnelSnapshotFailuresTable,
  type OpportunityRow,
  type LeverId,
} from "@workspace/db";
import { eq, like, or, and, sql } from "drizzle-orm";

import {
  captureFunnelSnapshot,
  detectAndAnnotateDeltas,
} from "../src/lib/ooda/funnel";
import {
  composeCohortKey,
  type AnalyzeResult,
  type LeverAnalyzer,
  type OpportunityDraft,
} from "../src/lib/levers/types";

const RUN = `t185-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgA: string;
let orgB: string;
let supA: string;
let catA: string;
const cycleIds: string[] = [];
// Per-test orgs created by `setupCalibrationOrg()` — tracked so the
// `after()` teardown can drop them. Each calibration test gets its own
// org so `computeCalibration(orgId)` only sees the rows that test
// seeded; without this, sibling tests leak realized decisions into the
// `_all` rollup (n=36 instead of 24, n=57 instead of 0). The fix is
// test isolation rather than narrowing the production query, since the
// production behavior of "all realized rows for the org" is correct.
const dynamicOrgIds: string[] = [];

async function setupCalibrationOrg(): Promise<{
  orgId: string;
  supId: string;
}> {
  const orgId = newId("org");
  const supId = newId("sup");
  await db
    .insert(orgsTable)
    .values({ id: orgId, name: `${RUN} cal`, slug: `${RUN}-${orgId.slice(-6)}` });
  await db.insert(suppliersTable).values({
    id: supId,
    orgId,
    name: `${RUN} sup ${orgId.slice(-6)}`,
    normalizedName: `${RUN} sup ${orgId.slice(-6)}`,
    sourceSystem: "csv",
    sourceExternalId: `${RUN}-sup-${orgId.slice(-6)}`,
  });
  dynamicOrgIds.push(orgId);
  return { orgId, supId };
}

// Stub lever shaped like the real ones — used to feed cohortKey + result
// into the snapshot writer without having to set up the full pipeline.
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

function makeDraft(
  args: { categoryCode: string; raw: number; supplierId?: string; categoryId?: string },
): OpportunityDraft {
  return {
    leverId: stubLever.leverId,
    title: `${RUN} draft ${args.categoryCode}`,
    rationale: "stub",
    recommendedAction: "stub",
    supplierId: args.supplierId ?? null,
    categoryId: args.categoryId ?? null,
    rawProjectedSavingsUsd: args.raw,
    inputs: { categoryCode: args.categoryCode },
  };
}

async function insertCycle(orgId: string, generation: number): Promise<string> {
  const cycleId = newId("cyc");
  await db.insert(analysisCyclesTable).values({
    id: cycleId,
    orgId,
    generation,
    triggeredBy: "test",
    status: "completed",
    completedAt: new Date(),
  });
  cycleIds.push(cycleId);
  return cycleId;
}

async function persistOpp(args: {
  orgId: string;
  cycleId: string;
  raw: number;
  rescaleMultiplier: number;
  supplierId?: string | null;
  categoryId?: string | null;
  categoryCode: string;
  realizedRatio?: number;
  decisionEvent?: "approve" | "execute" | "realize";
  decisionAge?: number; // days ago
}): Promise<OpportunityRow> {
  const projected = args.raw * args.rescaleMultiplier;
  const [row] = await db
    .insert(opportunitiesTable)
    .values({
      id: newId("opp"),
      orgId: args.orgId,
      cycleId: args.cycleId,
      leverId: stubLever.leverId,
      tier: 2,
      title: `${RUN} opp`,
      rationale: "stub",
      recommendedAction: "stub",
      supplierId: args.supplierId ?? null,
      categoryId: args.categoryId ?? null,
      rawProjectedSavingsUsd: args.raw.toFixed(2),
      projectedSavingsUsd: projected.toFixed(2),
      confidence: "0.5000",
      inputs: { categoryCode: args.categoryCode },
    })
    .returning();
  if (args.decisionEvent) {
    const created = new Date(
      Date.now() - (args.decisionAge ?? 1) * 86400_000,
    );
    await db.insert(decisionsTable).values({
      id: newId("dec"),
      opportunityId: row!.id,
      orgId: args.orgId,
      cycleId: args.cycleId,
      eventType: args.decisionEvent,
      actor: "test@example.com",
      createdAt: created,
      realizedSavingsUsd:
        args.decisionEvent === "realize" && args.realizedRatio != null
          ? (projected * args.realizedRatio).toFixed(2)
          : null,
    });
  }
  return row!;
}

describe("OODA funnel substrate", () => {
  before(async () => {
    orgA = newId("org");
    orgB = newId("org");
    await db.insert(orgsTable).values([
      { id: orgA, name: `${RUN} A`, slug: `${RUN}-a` },
      { id: orgB, name: `${RUN} B`, slug: `${RUN}-b` },
    ]);
    supA = newId("sup");
    await db.insert(suppliersTable).values({
      id: supA,
      orgId: orgA,
      name: `${RUN} sup A`,
      normalizedName: `${RUN} sup a`,
      sourceSystem: "csv",
      sourceExternalId: `${RUN}-supA`,
    });
    catA = newId("cat");
    await db.insert(categoriesTable).values({
      id: catA,
      orgId: orgA,
      code: `${RUN}-CAT-A`,
      name: "Test cat A",
      class: "service",
      sourceSystem: "csv",
      sourceExternalId: `${RUN}-catA`,
    });
  });

  it("writes a snapshot with all 10 stages and derived totals", async () => {
    const cycleId = await insertCycle(orgA, 1);
    const drafts = [
      makeDraft({ categoryCode: "X", raw: 1000, supplierId: supA }),
      makeDraft({ categoryCode: "Y", raw: 2000, categoryId: catA }),
    ];
    const opp = await persistOpp({
      orgId: orgA,
      cycleId,
      raw: 1000,
      rescaleMultiplier: 0.8,
      supplierId: supA,
      categoryCode: "X",
    });
    const result: AnalyzeResult = {
      drafts,
      consultedSignalIds: ["sig-1", "sig-2"],
      candidatesEvaluated: 5,
    };
    const r = await captureFunnelSnapshot({
      orgId: orgA,
      cycleId,
      cycleGeneration: 1,
      leverResults: [{ lever: stubLever, result }],
      draftsPostExclusion: [{ lever: stubLever, draft: drafts[0]! }],
      persistedOpps: [opp],
      priorDeltas: [],
    });
    assert.equal(r.failed, false);
    assert.ok(r.snapshotId);

    const [snap] = await db
      .select()
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.id, r.snapshotId!))
      .limit(1);
    assert.ok(snap);
    const stages = snap.stages as Record<string, { count: number }>;
    // All 10 logical stages must be present (cohort stages expand to 9 keys
    // for the 7d/30d/90d windows).
    const expectedKeys = [
      "signals_collected",
      "signals_mapped_to_levers",
      "signals_analyzed",
      "drafts_produced",
      "drafts_post_exclusion",
      "opps_persisted",
      "opps_approved_7d",
      "opps_approved_30d",
      "opps_approved_90d",
      "opps_executed_7d",
      "opps_executed_30d",
      "opps_executed_90d",
      "opps_realized_7d",
      "opps_realized_30d",
      "opps_realized_90d",
      "priors_updated",
    ];
    for (const k of expectedKeys) {
      assert.ok(stages[k], `stage ${k} missing`);
    }
    // signals_analyzed reflects the analyzer's consultedSignalIds union.
    assert.equal(stages["signals_analyzed"]!.count, 2);
    assert.equal(stages["drafts_produced"]!.count, 2);
    assert.equal(stages["drafts_post_exclusion"]!.count, 1);
    assert.equal(stages["opps_persisted"]!.count, 1);
    // Lifted totals match what was produced.
    assert.equal(snap.totalDraftsProduced, 2);
    assert.equal(snap.totalDraftsPostExclusion, 1);
    assert.equal(snap.totalOppsPersisted, 1);
  });

  it("records cohort identity tuples in `cohorts.persisted`", async () => {
    const cycleId = await insertCycle(orgA, 2);
    const oppX = await persistOpp({
      orgId: orgA,
      cycleId,
      raw: 1000,
      rescaleMultiplier: 1,
      supplierId: supA,
      categoryCode: "X",
    });
    const oppY = await persistOpp({
      orgId: orgA,
      cycleId,
      raw: 1000,
      rescaleMultiplier: 1,
      supplierId: supA,
      categoryCode: "X", // same key as oppX -> count should be 2
    });
    const oppZ = await persistOpp({
      orgId: orgA,
      cycleId,
      raw: 1000,
      rescaleMultiplier: 1,
      supplierId: supA,
      categoryCode: "Z",
    });
    const r = await captureFunnelSnapshot({
      orgId: orgA,
      cycleId,
      cycleGeneration: 2,
      leverResults: [
        {
          lever: stubLever,
          result: { drafts: [], consultedSignalIds: [], candidatesEvaluated: 0 },
        },
      ],
      draftsPostExclusion: [],
      persistedOpps: [oppX, oppY, oppZ],
      priorDeltas: [],
    });
    const [snap] = await db
      .select()
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.id, r.snapshotId!))
      .limit(1);
    const cohorts = snap!.cohorts as Record<
      string,
      Array<{ key: string; count: number }>
    >;
    const persisted = cohorts["persisted"]!;
    // Two distinct identity tuples expected: X and Z, with X having count 2.
    const xKey = composeCohortKey(
      stubLever,
      makeDraft({ categoryCode: "X", raw: 1000, supplierId: supA }),
    );
    const zKey = composeCohortKey(
      stubLever,
      makeDraft({ categoryCode: "Z", raw: 1000, supplierId: supA }),
    );
    const x = persisted.find((c) => c.key === xKey);
    const z = persisted.find((c) => c.key === zKey);
    assert.ok(x, "cohort X missing");
    assert.equal(x!.count, 2);
    assert.ok(z, "cohort Z missing");
    assert.equal(z!.count, 1);
  });

  it("computes calibration verdicts when n >= 10 and gates otherwise", async () => {
    // Seed 12 realized decisions: prior multiplier 0.5 (rescaled) sits
    // closer to truth than raw, so verdict should be 'helping'.
    // Fresh org per calibration test — see `setupCalibrationOrg`.
    const { orgId, supId } = await setupCalibrationOrg();
    const calCycle = await insertCycle(orgId, 3);
    const opps: OpportunityRow[] = [];
    for (let i = 0; i < 12; i++) {
      const o = await persistOpp({
        orgId,
        cycleId: calCycle,
        raw: 1000,
        rescaleMultiplier: 0.5,
        supplierId: supId,
        categoryCode: "CAL",
        decisionEvent: "realize",
        realizedRatio: 1.0, // realized matches rescaled exactly -> rescaled MAE = 0
        decisionAge: 5,
      });
      opps.push(o);
    }
    const r = await captureFunnelSnapshot({
      orgId,
      cycleId: calCycle,
      cycleGeneration: 3,
      leverResults: [
        {
          lever: stubLever,
          result: { drafts: [], consultedSignalIds: [], candidatesEvaluated: 0 },
        },
      ],
      draftsPostExclusion: [],
      persistedOpps: opps,
      priorDeltas: [],
    });
    const [snap] = await db
      .select()
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.id, r.snapshotId!))
      .limit(1);
    const calibration = snap!.calibration as Record<
      string,
      {
        leverId: string;
        categoryCode?: string;
        n: number;
        verdict: string;
        rawMedianAbsErrorUsd: number;
        rescaledMedianAbsErrorUsd: number;
      }
    >;
    const cal30 = Object.values(calibration).find(
      (c) => c.leverId === stubLever.leverId && c.n >= 10,
    );
    assert.ok(cal30, "expected a calibration entry with n >= 10");
    // raw projected = $1000 vs realized $500 = $500 abs error per sample.
    // rescaled projected = $500 vs realized $500 = $0 abs error per sample.
    // improvement = $500 > $100 -> 'helping'.
    assert.equal(cal30!.verdict, "helping");
    assert.ok(cal30!.rescaledMedianAbsErrorUsd < cal30!.rawMedianAbsErrorUsd);
  });

  // ───────────── Per-(category, lever) calibration (task #218) ───────

  it(
    "buckets calibration by (lever, category) AND emits an `_all` rollup that matches the per-lever metric",
    async () => {
      // Seed two distinct categories on the same lever and realize 12
      // decisions in each — `_all` rollup must aggregate both buckets,
      // and per-bucket metrics must coexist alongside the rollup.
      // Fresh org per calibration test — see `setupCalibrationOrg`.
      const { orgId, supId } = await setupCalibrationOrg();
      const cycle = await insertCycle(orgId, 100);
      const catB = newId("cat");
      const catC = newId("cat");
      await db.insert(categoriesTable).values([
        {
          id: catB,
          orgId,
          code: `${RUN}-CAT-B-${orgId.slice(-6)}`,
          name: "Test cat B",
          class: "service",
          sourceSystem: "csv",
          sourceExternalId: `${RUN}-catB-${orgId.slice(-6)}`,
        },
        {
          id: catC,
          orgId,
          code: `${RUN}-CAT-C-${orgId.slice(-6)}`,
          name: "Test cat C",
          class: "service",
          sourceSystem: "csv",
          sourceExternalId: `${RUN}-catC-${orgId.slice(-6)}`,
        },
      ]);
      const opps: OpportunityRow[] = [];
      // 12 realized in catB (rescaled = realized -> rescaled MAE = 0,
      // raw MAE = $500). improvement +$500 -> 'helping'.
      for (let i = 0; i < 12; i++) {
        opps.push(
          await persistOpp({
            orgId,
            cycleId: cycle,
            raw: 1000,
            rescaleMultiplier: 0.5,
            supplierId: supId,
            categoryId: catB,
            categoryCode: `${RUN}-CAT-B-${orgId.slice(-6)}`,
            decisionEvent: "realize",
            realizedRatio: 1.0,
            decisionAge: 5,
          }),
        );
      }
      // 12 realized in catC with the OPPOSITE sign — rescaled (0.5 ×
      // raw) is *further* from realized than raw itself (1.5 × raw is
      // closer than 0.5 × raw vs realized = 1.5 × raw):
      //   raw=1000, projected=500, realized=1500
      //   raw |1000-1500| = 500;  rescaled |500-1500| = 1000
      //   improvement = -500 -> 'hurting'
      for (let i = 0; i < 12; i++) {
        opps.push(
          await persistOpp({
            orgId,
            cycleId: cycle,
            raw: 1000,
            rescaleMultiplier: 0.5,
            supplierId: supId,
            categoryId: catC,
            categoryCode: `${RUN}-CAT-C-${orgId.slice(-6)}`,
            decisionEvent: "realize",
            realizedRatio: 3.0, // realized = rescaled × 3 = $1500
            decisionAge: 5,
          }),
        );
      }
      const r = await captureFunnelSnapshot({
        orgId,
        cycleId: cycle,
        cycleGeneration: 100,
        leverResults: [
          {
            lever: stubLever,
            result: {
              drafts: [],
              consultedSignalIds: [],
              candidatesEvaluated: 0,
            },
          },
        ],
        draftsPostExclusion: [],
        persistedOpps: opps,
        priorDeltas: [],
      });
      const [snap] = await db
        .select()
        .from(funnelSnapshotsTable)
        .where(eq(funnelSnapshotsTable.id, r.snapshotId!))
        .limit(1);
      const cal = snap!.calibration as Record<
        string,
        {
          leverId: string;
          categoryCode: string;
          window: string;
          n: number;
          verdict: string;
          rawMedianAbsErrorUsd: number;
          rescaledMedianAbsErrorUsd: number;
          improvementUsd: number;
        }
      >;
      // Per-bucket entries exist with the canonical key shape.
      const lever = stubLever.leverId;
      const catBKey30 = `${lever}:${RUN}-CAT-B-${orgId.slice(-6)}:30d`;
      const catCKey30 = `${lever}:${RUN}-CAT-C-${orgId.slice(-6)}:30d`;
      const allKey30 = `${lever}:_all:30d`;
      assert.ok(cal[catBKey30], `missing bucket ${catBKey30}`);
      assert.ok(cal[catCKey30], `missing bucket ${catCKey30}`);
      assert.ok(cal[allKey30], `missing rollup ${allKey30}`);
      assert.equal(cal[catBKey30]!.n, 12);
      assert.equal(cal[catCKey30]!.n, 12);
      assert.equal(cal[allKey30]!.n, 24);
      // Verdicts at the dead-band edges.
      assert.equal(cal[catBKey30]!.verdict, "helping");
      assert.equal(cal[catCKey30]!.verdict, "hurting");
      // Backward compat: the `_all` rollup carries the same metric as
      // the previous per-lever-only calibration would have produced
      // over the union of samples. With opposite-sign improvements the
      // medians cancel; verdict ends up 'neutral' (within ±$100).
      // Concretely: rescaled errors over 24 samples are 12 × $0
      // (catB) + 12 × $1000 (catC) → median sits between sorted
      // positions 12 and 13 = (0+1000)/2 = $500. Raw errors are 24 ×
      // $500 → median = $500. improvement = $0 → 'neutral'.
      assert.equal(cal[allKey30]!.verdict, "neutral");
      assert.equal(cal[allKey30]!.improvementUsd, 0);
    },
  );

  it(
    "applies n >= 10 gating per (lever, category) bucket independently",
    async () => {
      // Fresh org per calibration test — see `setupCalibrationOrg`.
      const { orgId, supId } = await setupCalibrationOrg();
      const cycle = await insertCycle(orgId, 101);
      const catSmall = newId("cat");
      const catBig = newId("cat");
      await db.insert(categoriesTable).values([
        {
          id: catSmall,
          orgId,
          code: `${RUN}-CAT-SMALL-${orgId.slice(-6)}`,
          name: "Small cat",
          class: "service",
          sourceSystem: "csv",
          sourceExternalId: `${RUN}-catSmall-${orgId.slice(-6)}`,
        },
        {
          id: catBig,
          orgId,
          code: `${RUN}-CAT-BIG-${orgId.slice(-6)}`,
          name: "Big cat",
          class: "service",
          sourceSystem: "csv",
          sourceExternalId: `${RUN}-catBig-${orgId.slice(-6)}`,
        },
      ]);
      const opps: OpportunityRow[] = [];
      // 9 realized in catSmall — under threshold, should be
      // 'insufficient_evidence' for the per-bucket entry.
      for (let i = 0; i < 9; i++) {
        opps.push(
          await persistOpp({
            orgId,
            cycleId: cycle,
            raw: 1000,
            rescaleMultiplier: 0.5,
            supplierId: supId,
            categoryId: catSmall,
            categoryCode: `${RUN}-CAT-SMALL-${orgId.slice(-6)}`,
            decisionEvent: "realize",
            realizedRatio: 1.0,
            decisionAge: 5,
          }),
        );
      }
      // 12 realized in catBig — at threshold, should be 'helping'.
      for (let i = 0; i < 12; i++) {
        opps.push(
          await persistOpp({
            orgId,
            cycleId: cycle,
            raw: 1000,
            rescaleMultiplier: 0.5,
            supplierId: supId,
            categoryId: catBig,
            categoryCode: `${RUN}-CAT-BIG-${orgId.slice(-6)}`,
            decisionEvent: "realize",
            realizedRatio: 1.0,
            decisionAge: 5,
          }),
        );
      }
      const r = await captureFunnelSnapshot({
        orgId,
        cycleId: cycle,
        cycleGeneration: 101,
        leverResults: [
          {
            lever: stubLever,
            result: {
              drafts: [],
              consultedSignalIds: [],
              candidatesEvaluated: 0,
            },
          },
        ],
        draftsPostExclusion: [],
        persistedOpps: opps,
        priorDeltas: [],
      });
      const [snap] = await db
        .select()
        .from(funnelSnapshotsTable)
        .where(eq(funnelSnapshotsTable.id, r.snapshotId!))
        .limit(1);
      const cal = snap!.calibration as Record<
        string,
        { n: number; verdict: string }
      >;
      const lever = stubLever.leverId;
      const small = cal[`${lever}:${RUN}-CAT-SMALL-${orgId.slice(-6)}:30d`];
      const big = cal[`${lever}:${RUN}-CAT-BIG-${orgId.slice(-6)}:30d`];
      assert.ok(small, "small bucket missing");
      assert.ok(big, "big bucket missing");
      assert.equal(small!.n, 9);
      assert.equal(small!.verdict, "insufficient_evidence");
      assert.equal(big!.n, 12);
      assert.equal(big!.verdict, "helping");
    },
  );

  it(
    "excludes mappedVia='unmapped_default' from per-(category, lever) buckets AND the `_all` rollup",
    async () => {
      // Fresh org per calibration test — see `setupCalibrationOrg`.
      // With a fresh org, the only realized rows in scope are the 12
      // unmapped_default ones we seed here, so a correct exclusion
      // filter produces NEITHER a per-bucket entry NOR an `_all`
      // rollup. Asserting both at once in this test is the regression
      // guard the task plan asks for: if the filter ever drifts so it
      // applies to one dimension but not the other, this test breaks.
      const { orgId, supId } = await setupCalibrationOrg();
      const cycle = await insertCycle(orgId, 102);
      const cat = newId("cat");
      await db.insert(categoriesTable).values({
        id: cat,
        orgId,
        code: `${RUN}-CAT-EXCL-${orgId.slice(-6)}`,
        name: "Excl cat",
        class: "service",
        sourceSystem: "csv",
        sourceExternalId: `${RUN}-catExcl-${orgId.slice(-6)}`,
      });
      const opps: OpportunityRow[] = [];
      // 12 realized rows but every one is `unmapped_default` — must
      // not surface in either dimension.
      for (let i = 0; i < 12; i++) {
        const o = await persistOpp({
          orgId,
          cycleId: cycle,
          raw: 1000,
          rescaleMultiplier: 0.5,
          supplierId: supId,
          categoryId: cat,
          categoryCode: `${RUN}-CAT-EXCL-${orgId.slice(-6)}`,
          decisionEvent: "realize",
          realizedRatio: 1.0,
          decisionAge: 5,
        });
        opps.push(o);
      }
      // Force-flip mapped_via on every opportunity for this cycle.
      await db.execute(sql`
        UPDATE opportunities
           SET mapped_via = 'unmapped_default'
         WHERE cycle_id = ${cycle}
      `);
      const r = await captureFunnelSnapshot({
        orgId,
        cycleId: cycle,
        cycleGeneration: 102,
        leverResults: [
          {
            lever: stubLever,
            result: {
              drafts: [],
              consultedSignalIds: [],
              candidatesEvaluated: 0,
            },
          },
        ],
        draftsPostExclusion: [],
        persistedOpps: opps,
        priorDeltas: [],
      });
      const [snap] = await db
        .select()
        .from(funnelSnapshotsTable)
        .where(eq(funnelSnapshotsTable.id, r.snapshotId!))
        .limit(1);
      const cal = snap!.calibration as Record<
        string,
        { leverId?: string; categoryCode?: string }
      >;
      const lever = stubLever.leverId;
      const matching = Object.entries(cal).filter(
        ([, v]) =>
          v.leverId === lever &&
          v.categoryCode === `${RUN}-CAT-EXCL-${orgId.slice(-6)}`,
      );
      assert.equal(
        matching.length,
        0,
        "unmapped_default rows must not produce a per-(cat,lever) bucket",
      );
      // The `_all` rollup must ALSO exclude the unmapped_default rows.
      // With a fresh per-test org (`setupCalibrationOrg`) there are no
      // other realized decisions in scope for this lever, so a
      // correctly-applied filter produces no `_all` rollup at all.
      // This catches a class of regression where the exclusion filter
      // is applied to per-(lever, category) buckets but not to the
      // per-lever `_all` aggregation (or vice versa) — the original
      // production bug shape this test was added for.
      const rollup = Object.entries(cal).filter(
        ([k, v]) =>
          v.leverId === lever && v.categoryCode === "_all" && k.endsWith(":30d"),
      );
      assert.equal(
        rollup.length,
        0,
        `unmapped_default contaminated rollup: ${JSON.stringify(rollup)}`,
      );
    },
  );

  it("delta detection skips during warmup and fires on dual-threshold breach", async () => {
    // Snapshot insertion in earlier tests already populated org A. We need
    // at least 5 historical rows for warmup to be satisfied; create some
    // fresh ones for org B (currently empty) to test the warmup gate
    // independently.
    const orgBCycle1 = await insertCycle(orgB, 1);
    const r1 = await captureFunnelSnapshot({
      orgId: orgB,
      cycleId: orgBCycle1,
      cycleGeneration: 1,
      leverResults: [
        {
          lever: stubLever,
          result: { drafts: [], consultedSignalIds: [], candidatesEvaluated: 0 },
        },
      ],
      draftsPostExclusion: [],
      persistedOpps: [],
      priorDeltas: [],
    });
    // Force-call detection on org B with only ONE prior — should noop.
    const fired0 = await detectAndAnnotateDeltas({
      orgId: orgB,
      snapshotId: r1.snapshotId!,
      currentStages: {
        signals_collected: { count: 9999 },
      },
    });
    assert.equal(fired0, 0, "warmup must suppress firing");

    // Insert 5 cycles each with 100 baseline signals, then a 6th with
    // 9999 to trigger.
    const baselineSnapIds: string[] = [];
    for (let g = 2; g <= 6; g++) {
      const c = await insertCycle(orgB, g);
      const r = await captureFunnelSnapshot({
        orgId: orgB,
        cycleId: c,
        cycleGeneration: g,
        leverResults: [
          {
            lever: stubLever,
            result: {
              drafts: [],
              consultedSignalIds: Array.from({ length: 100 }, (_, i) => `s-${g}-${i}`),
              candidatesEvaluated: 100,
            },
          },
        ],
        draftsPostExclusion: [],
        persistedOpps: [],
        priorDeltas: [],
      });
      baselineSnapIds.push(r.snapshotId!);
    }

    const spikeCycle = await insertCycle(orgB, 7);
    const spikeRes = await captureFunnelSnapshot({
      orgId: orgB,
      cycleId: spikeCycle,
      cycleGeneration: 7,
      leverResults: [
        {
          lever: stubLever,
          result: {
            drafts: [],
            consultedSignalIds: Array.from({ length: 9999 }, (_, i) => `s-spike-${i}`),
            candidatesEvaluated: 9999,
          },
        },
      ],
      draftsPostExclusion: [],
      persistedOpps: [],
      priorDeltas: [],
    });
    // Snapshot writer auto-runs delta detection — verify annotations exist.
    const anns = await db
      .select()
      .from(funnelAnnotationsTable)
      .where(
        and(
          eq(funnelAnnotationsTable.orgId, orgB),
          eq(funnelAnnotationsTable.snapshotId, spikeRes.snapshotId!),
        ),
      );
    assert.ok(anns.length >= 1, `expected >=1 auto annotation, got ${anns.length}`);
    const spike = anns.find((a) => a.kind === "stage_spike");
    assert.ok(spike, "expected stage_spike annotation for signals_collected");
    assert.equal(spike!.source, "auto");
    // The hasAutoAnnotation flag must be set on the snapshot.
    const [refreshedSnap] = await db
      .select({
        hasAutoAnnotation: funnelSnapshotsTable.hasAutoAnnotation,
      })
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.id, spikeRes.snapshotId!));
    assert.equal(refreshedSnap!.hasAutoAnnotation, 1);
  });

  it("isolates snapshots across tenants", async () => {
    const aRows = await db
      .select({ orgId: funnelSnapshotsTable.orgId })
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.orgId, orgA));
    const bRows = await db
      .select({ orgId: funnelSnapshotsTable.orgId })
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.orgId, orgB));
    assert.ok(aRows.every((r) => r.orgId === orgA));
    assert.ok(bRows.every((r) => r.orgId === orgB));
    // No annotation for org A should reference an org B snapshot.
    const cross = await db
      .select({ id: funnelAnnotationsTable.id })
      .from(funnelAnnotationsTable)
      .innerJoin(
        funnelSnapshotsTable,
        eq(funnelAnnotationsTable.snapshotId, funnelSnapshotsTable.id),
      )
      .where(
        and(
          eq(funnelAnnotationsTable.orgId, orgA),
          eq(funnelSnapshotsTable.orgId, orgB),
        ),
      );
    assert.equal(cross.length, 0);
  });

  it("records a snapshot failure instead of throwing on bad inputs", async () => {
    // Pass a cycleId that doesn't exist as the FK target; the insert will
    // fail and the writer must record into funnel_snapshot_failures.
    const r = await captureFunnelSnapshot({
      orgId: orgA,
      cycleId: "cyc_does_not_exist",
      cycleGeneration: 999,
      leverResults: [
        {
          lever: stubLever,
          result: { drafts: [], consultedSignalIds: [], candidatesEvaluated: 0 },
        },
      ],
      draftsPostExclusion: [],
      persistedOpps: [],
      priorDeltas: [],
    });
    assert.equal(r.failed, true);
    assert.equal(r.snapshotId, null);
    const failures = await db
      .select()
      .from(funnelSnapshotFailuresTable)
      .where(eq(funnelSnapshotFailuresTable.orgId, orgA));
    assert.ok(
      failures.some((f) => f.cycleId === "cyc_does_not_exist"),
      "failure row must be recorded",
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
    // Cascade from orgs handles snapshots / annotations / failures /
    // opps / cycles / suppliers / categories. Belt-and-braces by RUN
    // prefix below.
    if (orgA) await safe(db.delete(orgsTable).where(eq(orgsTable.id, orgA)));
    if (orgB) await safe(db.delete(orgsTable).where(eq(orgsTable.id, orgB)));
    // Per-test orgs created via `setupCalibrationOrg`. Cascade FKs from
    // `orgs` clean up snapshots, opportunities, decisions, suppliers,
    // and categories that belong to each org.
    for (const id of dynamicOrgIds) {
      await safe(db.delete(orgsTable).where(eq(orgsTable.id, id)));
    }
    await safe(
      db
        .delete(suppliersTable)
        .where(like(suppliersTable.sourceExternalId, `${RUN}-%`)),
    );
    await safe(
      db
        .delete(categoriesTable)
        .where(
          or(
            like(categoriesTable.sourceExternalId, `${RUN}-%`),
            like(categoriesTable.code, `${RUN}-%`),
          ),
        ),
    );
  });
});
