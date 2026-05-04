/**
 * Regression tests for the eleven data-integrity assertions in
 * `lib/data-integrity` (Task #314 / #328).
 *
 * The assertion library runs against production every 15 minutes and
 * is the safety net for "the dashboard's dollars match the records'
 * dollars" + the #284 hard gates. A regression in one of the SQL
 * probes (wrong JOIN, missing predicate, swapped column) could
 * silently turn an assertion into an always-pass — losing the safety
 * net without anyone noticing. This suite locks each probe's
 * behaviour in: every assertion is exercised against a known-bad
 * fixture (must FAIL and surface the seeded violation) AND a clean
 * fixture (must NOT surface the seeded rows).
 *
 * The assertions are GLOBAL queries — they don't take an org_id —
 * so the dev DB this test runs against may already contain pre-existing
 * violations. We therefore avoid asserting on the global `passed`
 * boolean directly when the test seeds aggregate-style violations and
 * instead rely on:
 *   - For id-bearing assertions (#1–#4, #6–#9): we use the assertion's
 *     own `query` string (from the result), strip the LIMIT, and run
 *     an EXISTS check scoped to our seeded id — proving the assertion's
 *     SQL shape catches our row. This avoids the LIMIT-25 cap problem
 *     without duplicating the assertion's SQL by hand.
 *   - For count-only assertions (#5, #10, #11): snapshot the baseline
 *     count, then assert delta-after-seed == expected and
 *     delta-after-clean == 0.
 *
 * All seeded rows are namespaced with a per-run prefix and torn down
 * in `after()` so concurrent runs against the same database stay
 * isolated.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  opportunitiesTable,
  analysisCyclesTable,
  funnelSnapshotsTable,
  opportunityStageHistoryTable,
} from "@workspace/db";
import { eq, inArray, like, sql } from "drizzle-orm";

import {
  assertion_realized_matches_record_sum,
  assertion_pipeline_value_decomposition,
  assertion_lever_totals_match_aggregate,
  assertion_funnel_counts_match_records,
  assertion_no_null_savings_tags,
  assertion_savings_type_consistent_with_stage,
  assertion_realized_records_have_baseline,
  assertion_stage_history_matches_current,
  assertion_every_opportunity_has_history_row,
  assertion_hard_savings_excludes_review_flagged,
  assertion_no_realized_without_baseline,
  ALL_ASSERTIONS,
} from "@workspace/data-integrity";

const RUN = `dia-${randomUUID().replace(/-/g, "").slice(0, 10)}`;

async function assertionQueryMatchesId(
  result: { query: string },
  id: string,
): Promise<boolean> {
  const inner = result.query.replace(/LIMIT\s+25\s*$/im, "");
  const r = await db.execute<{ found: boolean }>(
    sql`SELECT EXISTS(SELECT 1 FROM (${sql.raw(inner)}) _sub WHERE _sub.id = ${id}) AS found`,
  );
  return r.rows[0]?.found === true;
}

function newId(prefix: string): string {
  return `${prefix}_${RUN}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

const orgIds: string[] = [];
const cycleIds: string[] = [];
const oppIds: string[] = [];
const snapshotIds: string[] = [];
const historyIds: string[] = [];

async function makeOrg(): Promise<string> {
  const id = newId("org");
  await db.insert(orgsTable).values({
    id,
    name: `${RUN} org`,
    slug: `${RUN}-${id.slice(-8)}`,
  });
  orgIds.push(id);
  return id;
}

async function makeCycle(args: {
  orgId: string;
  status?: "running" | "completed" | "failed";
  totalRealizedUsd?: string;
  totalProjectedUsd?: string;
  generation?: number;
}): Promise<string> {
  const id = newId("cyc");
  await db.insert(analysisCyclesTable).values({
    id,
    orgId: args.orgId,
    generation: args.generation ?? 1,
    status: args.status ?? "completed",
    triggeredBy: "data-integrity-test",
    completedAt: new Date(),
    totalRealizedUsd: args.totalRealizedUsd ?? "0",
    totalProjectedUsd: args.totalProjectedUsd ?? "0",
  });
  cycleIds.push(id);
  return id;
}

interface OppArgs {
  orgId: string;
  cycleId: string;
  leverId?:
    | "sku_price_benchmark"
    | "maverick_spend"
    | "contract_leakage";
  projectedSavingsUsd?: string;
  realizedSavingsUsd?: string;
  canonicalStage?:
    | "Identified"
    | "Awarded"
    | "In Contracting"
    | "In Implementation"
    | "Realized"
    | null;
  savingsType?: "Identified" | "Negotiated" | "Implemented" | "Realized" | null;
  savingsClassification?: "Hard" | "Cost Avoidance" | "Soft" | null;
  classificationNeedsReview?: boolean;
  baselineMethod?:
    | "Prior Unit Price"
    | "Market Index"
    | "Should-Cost Model"
    | "Supplier Proposed Increase"
    | "Internal Estimate"
    | "N/A — Soft"
    | null;
  baselineValue?: string | null;
}

async function makeOpp(args: OppArgs): Promise<string> {
  const id = newId("opp");
  await db.insert(opportunitiesTable).values({
    id,
    orgId: args.orgId,
    cycleId: args.cycleId,
    leverId: args.leverId ?? "sku_price_benchmark",
    tier: 1,
    title: `${RUN} opp`,
    rationale: "test",
    recommendedAction: "test",
    rawProjectedSavingsUsd: args.projectedSavingsUsd ?? "0",
    projectedSavingsUsd: args.projectedSavingsUsd ?? "0",
    confidence: "0.5",
    realizedSavingsUsd: args.realizedSavingsUsd ?? "0",
    canonicalStage: args.canonicalStage ?? null,
    savingsType: args.savingsType ?? null,
    savingsClassification: args.savingsClassification ?? null,
    classificationNeedsReview: args.classificationNeedsReview ?? false,
    baselineMethod: args.baselineMethod ?? null,
    baselineValue: args.baselineValue ?? null,
  });
  oppIds.push(id);
  return id;
}

async function makeSnapshot(args: {
  orgId: string;
  cycleId: string;
  totalProjectedUsd?: string;
  totalOppsPersisted?: number;
  generation?: number;
}): Promise<string> {
  const id = newId("snap");
  await db.insert(funnelSnapshotsTable).values({
    id,
    orgId: args.orgId,
    cycleId: args.cycleId,
    cycleGeneration: args.generation ?? 1,
    totalProjectedUsd: args.totalProjectedUsd ?? "0",
    totalOppsPersisted: args.totalOppsPersisted ?? 0,
  });
  snapshotIds.push(id);
  return id;
}

async function makeHistory(args: {
  orgId: string;
  opportunityId: string;
  toStage:
    | "Identified"
    | "Awarded"
    | "In Contracting"
    | "In Implementation"
    | "Realized";
  transitionedAt?: Date;
}): Promise<string> {
  const id = newId("hist");
  await db.insert(opportunityStageHistoryTable).values({
    id,
    orgId: args.orgId,
    opportunityId: args.opportunityId,
    toStage: args.toStage,
    transitionedAt: args.transitionedAt ?? new Date(),
    transitionReason: "TEST",
  });
  historyIds.push(id);
  return id;
}

describe("data-integrity assertions — regression suite", () => {
  before(async () => {
    // Sanity check: every exported assertion is in ALL_ASSERTIONS, and
    // the suite covers the full eleven. If a future PR adds a
    // twelfth, this fails loudly so the test author remembers to
    // extend coverage.
    assert.equal(
      ALL_ASSERTIONS.length,
      11,
      "ALL_ASSERTIONS should still contain exactly 11 assertions; if you added one, add a regression test for it too.",
    );
  });

  after(async () => {
    // Teardown in FK-safe order. Each table is filtered by the
    // per-run id prefix so concurrent runs don't clobber each other.
    if (historyIds.length) {
      await db
        .delete(opportunityStageHistoryTable)
        .where(inArray(opportunityStageHistoryTable.id, historyIds));
    }
    if (snapshotIds.length) {
      await db
        .delete(funnelSnapshotsTable)
        .where(inArray(funnelSnapshotsTable.id, snapshotIds));
    }
    if (oppIds.length) {
      await db
        .delete(opportunitiesTable)
        .where(inArray(opportunitiesTable.id, oppIds));
    }
    if (cycleIds.length) {
      await db
        .delete(analysisCyclesTable)
        .where(inArray(analysisCyclesTable.id, cycleIds));
    }
    if (orgIds.length) {
      await db.delete(orgsTable).where(inArray(orgsTable.id, orgIds));
    }
    // Belt-and-braces: any rows that slipped past the id tracking
    // (e.g. if a future helper inserts directly) get swept by the
    // per-run name/slug prefix.
    await db.delete(orgsTable).where(like(orgsTable.slug, `${RUN}-%`));
  });

  // -------------------------------------------------------------------------
  // #1 realized_savings_matches_record_sum
  // -------------------------------------------------------------------------
  it("#1 realized_savings_matches_record_sum: catches cycle/record drift", async () => {
    const orgId = await makeOrg();
    // Bad: cycle says $200, records sum to $100 → drift = $100.
    const cycleId = await makeCycle({
      orgId,
      status: "completed",
      totalRealizedUsd: "200",
    });
    await makeOpp({
      orgId,
      cycleId,
      canonicalStage: "Realized",
      realizedSavingsUsd: "100",
    });

    const bad = await assertion_realized_matches_record_sum.run(db);
    assert.equal(bad.passed, false);
    const examples = bad.actual.examples as Array<{ cycleId: string }>;
    assert.ok(
      examples.some((e) => e.cycleId === cycleId),
      "seeded cycle should appear in violations",
    );

    // Clean: fix the cycle total to match the record sum.
    await db
      .update(analysisCyclesTable)
      .set({ totalRealizedUsd: "100" })
      .where(eq(analysisCyclesTable.id, cycleId));

    const clean = await assertion_realized_matches_record_sum.run(db);
    const cleanExamples = clean.actual.examples as Array<{ cycleId: string }>;
    assert.ok(
      !cleanExamples.some((e) => e.cycleId === cycleId),
      "fixed cycle must not appear in violations",
    );
  });

  // -------------------------------------------------------------------------
  // #2 pipeline_value_decomposition_intact
  // -------------------------------------------------------------------------
  it("#2 pipeline_value_decomposition_intact: catches snapshot/record drift", async () => {
    const orgId = await makeOrg();
    const cycleId = await makeCycle({ orgId });
    await makeOpp({
      orgId,
      cycleId,
      projectedSavingsUsd: "500",
      canonicalStage: "Identified",
    });
    // Bad: snapshot persists $1000, records sum to $500.
    const snapshotId = await makeSnapshot({
      orgId,
      cycleId,
      totalProjectedUsd: "1000",
    });

    const bad = await assertion_pipeline_value_decomposition.run(db);
    assert.equal(bad.passed, false);
    const examples = bad.actual.examples as Array<{ snapshotId: string }>;
    assert.ok(
      examples.some((e) => e.snapshotId === snapshotId),
      "seeded snapshot should appear in violations",
    );

    await db
      .update(funnelSnapshotsTable)
      .set({ totalProjectedUsd: "500" })
      .where(eq(funnelSnapshotsTable.id, snapshotId));

    const clean = await assertion_pipeline_value_decomposition.run(db);
    const cleanExamples = clean.actual.examples as Array<{ snapshotId: string }>;
    assert.ok(
      !cleanExamples.some((e) => e.snapshotId === snapshotId),
      "fixed snapshot must not appear in violations",
    );
  });

  // -------------------------------------------------------------------------
  // #3 lever_totals_sum_to_aggregate
  // -------------------------------------------------------------------------
  it("#3 lever_totals_sum_to_aggregate: catches per-lever rollup drift", async () => {
    const orgId = await makeOrg();
    // Bad: cycle persists $500, but per-lever rollup sums to $300
    // ($100 from sku_price_benchmark + $200 from maverick_spend).
    const cycleId = await makeCycle({
      orgId,
      status: "completed",
      totalRealizedUsd: "500",
    });
    await makeOpp({
      orgId,
      cycleId,
      leverId: "sku_price_benchmark",
      canonicalStage: "Realized",
      realizedSavingsUsd: "100",
    });
    await makeOpp({
      orgId,
      cycleId,
      leverId: "maverick_spend",
      canonicalStage: "Realized",
      realizedSavingsUsd: "200",
    });

    const bad = await assertion_lever_totals_match_aggregate.run(db);
    assert.equal(bad.passed, false);
    const examples = bad.actual.examples as Array<{
      cycleId: string;
      leverCount: number;
    }>;
    const ours = examples.find((e) => e.cycleId === cycleId);
    assert.ok(ours, "seeded cycle should appear in lever-rollup violations");
    assert.equal(
      ours.leverCount,
      2,
      "lever_count should reflect both seeded levers (proves the per-lever decomposition is being computed, not just a flat SUM)",
    );

    await db
      .update(analysisCyclesTable)
      .set({ totalRealizedUsd: "300" })
      .where(eq(analysisCyclesTable.id, cycleId));

    const clean = await assertion_lever_totals_match_aggregate.run(db);
    const cleanExamples = clean.actual.examples as Array<{ cycleId: string }>;
    assert.ok(
      !cleanExamples.some((e) => e.cycleId === cycleId),
      "fixed cycle must not appear in lever-rollup violations",
    );
  });

  // -------------------------------------------------------------------------
  // #4 funnel_counts_match_records
  // -------------------------------------------------------------------------
  it("#4 funnel_counts_match_records: catches count drift", async () => {
    const orgId = await makeOrg();
    const cycleId = await makeCycle({ orgId });
    await makeOpp({ orgId, cycleId });
    await makeOpp({ orgId, cycleId });
    // Bad: snapshot says 5, records show 2.
    const snapshotId = await makeSnapshot({
      orgId,
      cycleId,
      totalOppsPersisted: 5,
    });

    const bad = await assertion_funnel_counts_match_records.run(db);
    assert.equal(bad.passed, false);
    const examples = bad.actual.examples as Array<{ cycle_id: string }>;
    assert.ok(
      examples.some((e) => e.cycle_id === cycleId),
      "seeded cycle should appear in count-mismatch violations",
    );

    await db
      .update(funnelSnapshotsTable)
      .set({ totalOppsPersisted: 2 })
      .where(eq(funnelSnapshotsTable.id, snapshotId));

    const clean = await assertion_funnel_counts_match_records.run(db);
    const cleanExamples = clean.actual.examples as Array<{ cycle_id: string }>;
    assert.ok(
      !cleanExamples.some((e) => e.cycle_id === cycleId),
      "fixed snapshot must not appear in count-mismatch violations",
    );
  });

  // -------------------------------------------------------------------------
  // #5 no_null_savings_types_or_classifications (count-only — delta check)
  // -------------------------------------------------------------------------
  it("#5 no_null_savings_types_or_classifications: catches missing #284 tags", async () => {
    const baseline = await assertion_no_null_savings_tags.run(db);
    const baselineNullTypes = (baseline.actual as { nullTypes: number })
      .nullTypes;
    const baselineNullClass = (baseline.actual as { nullClass: number })
      .nullClass;

    const orgId = await makeOrg();
    const cycleId = await makeCycle({ orgId });
    // Bad: canonical_stage set but BOTH tags missing → both counters bump.
    const oppId = await makeOpp({
      orgId,
      cycleId,
      canonicalStage: "Identified",
      savingsType: null,
      savingsClassification: null,
    });

    const bad = await assertion_no_null_savings_tags.run(db);
    assert.equal(bad.passed, false);
    assert.equal(
      (bad.actual as { nullTypes: number }).nullTypes,
      baselineNullTypes + 1,
      "nullTypes count should grow by exactly 1",
    );
    assert.equal(
      (bad.actual as { nullClass: number }).nullClass,
      baselineNullClass + 1,
      "nullClass count should grow by exactly 1",
    );

    // Clean: backfill the tags on our seeded row.
    await db
      .update(opportunitiesTable)
      .set({ savingsType: "Identified", savingsClassification: "Hard" })
      .where(eq(opportunitiesTable.id, oppId));

    const clean = await assertion_no_null_savings_tags.run(db);
    assert.equal(
      (clean.actual as { nullTypes: number }).nullTypes,
      baselineNullTypes,
      "nullTypes should return to baseline once tags are backfilled",
    );
    assert.equal(
      (clean.actual as { nullClass: number }).nullClass,
      baselineNullClass,
      "nullClass should return to baseline once tags are backfilled",
    );
  });

  // -------------------------------------------------------------------------
  // #6 savings_type_consistent_with_canonical_stage
  // -------------------------------------------------------------------------
  it("#6 savings_type_consistent_with_canonical_stage: catches stage/type mismatch", async () => {
    const orgId = await makeOrg();
    const cycleId = await makeCycle({ orgId });
    const oppId = await makeOpp({
      orgId,
      cycleId,
      canonicalStage: "Identified",
      savingsType: "Realized",
      savingsClassification: "Hard",
    });

    const bad = await assertion_savings_type_consistent_with_stage.run(db);
    assert.equal(bad.passed, false);
    assert.ok(
      await assertionQueryMatchesId(bad, oppId),
      "assertion's own query must find our seeded mismatched opp",
    );

    await db
      .update(opportunitiesTable)
      .set({ savingsType: "Identified" })
      .where(eq(opportunitiesTable.id, oppId));

    const clean = await assertion_savings_type_consistent_with_stage.run(db);
    assert.ok(
      !(await assertionQueryMatchesId(clean, oppId)),
      "assertion's own query must no longer find the fixed opp",
    );
  });

  // -------------------------------------------------------------------------
  // #7 realized_records_have_baseline_value_or_soft_marker
  // -------------------------------------------------------------------------
  it("#7 realized_records_have_baseline_value_or_soft_marker: catches missing baseline", async () => {
    const orgId = await makeOrg();
    const cycleId = await makeCycle({ orgId });
    const oppId = await makeOpp({
      orgId,
      cycleId,
      canonicalStage: "Realized",
      savingsType: "Realized",
      savingsClassification: "Hard",
      baselineMethod: "Internal Estimate",
      baselineValue: null,
    });

    const bad = await assertion_realized_records_have_baseline.run(db);
    assert.equal(bad.passed, false);
    assert.ok(
      await assertionQueryMatchesId(bad, oppId),
      "assertion's own query must find our seeded baseline-less opp",
    );

    await db
      .update(opportunitiesTable)
      .set({ baselineMethod: "N/A — Soft" })
      .where(eq(opportunitiesTable.id, oppId));

    const clean = await assertion_realized_records_have_baseline.run(db);
    assert.ok(
      !(await assertionQueryMatchesId(clean, oppId)),
      "assertion's own query must no longer find the soft-marked opp",
    );
  });

  // -------------------------------------------------------------------------
  // #8 stage_history_latest_row_matches_current_canonical_stage
  // -------------------------------------------------------------------------
  it("#8 stage_history_latest_row_matches_current_canonical_stage: catches history desync", async () => {
    const orgId = await makeOrg();
    const cycleId = await makeCycle({ orgId });
    const oppId = await makeOpp({
      orgId,
      cycleId,
      canonicalStage: "Realized",
      savingsType: "Realized",
      savingsClassification: "Hard",
      baselineMethod: "N/A — Soft",
    });
    await makeHistory({
      orgId,
      opportunityId: oppId,
      toStage: "Identified",
      transitionedAt: new Date(Date.now() - 60_000),
    });

    const bad = await assertion_stage_history_matches_current.run(db);
    assert.equal(bad.passed, false);
    assert.ok(
      await assertionQueryMatchesId(bad, oppId),
      "assertion's own query must find our seeded out-of-sync opp",
    );

    await makeHistory({
      orgId,
      opportunityId: oppId,
      toStage: "Realized",
      transitionedAt: new Date(),
    });

    const clean = await assertion_stage_history_matches_current.run(db);
    assert.ok(
      !(await assertionQueryMatchesId(clean, oppId)),
      "assertion's own query must no longer find the synced opp",
    );
  });

  // -------------------------------------------------------------------------
  // #9 every_opportunity_has_at_least_one_history_row
  // -------------------------------------------------------------------------
  it("#9 every_opportunity_has_at_least_one_history_row: catches orphan opps", async () => {
    const orgId = await makeOrg();
    const cycleId = await makeCycle({ orgId });
    const oppId = await makeOpp({
      orgId,
      cycleId,
      canonicalStage: "Identified",
      savingsType: "Identified",
      savingsClassification: "Hard",
    });

    const bad = await assertion_every_opportunity_has_history_row.run(db);
    assert.equal(bad.passed, false);
    assert.ok(
      await assertionQueryMatchesId(bad, oppId),
      "assertion's own query must find our seeded orphan opp",
    );

    await makeHistory({ orgId, opportunityId: oppId, toStage: "Identified" });

    const clean = await assertion_every_opportunity_has_history_row.run(db);
    assert.ok(
      !(await assertionQueryMatchesId(clean, oppId)),
      "assertion's own query must no longer find the opp after adding history",
    );
  });

  // -------------------------------------------------------------------------
  // #10 hard_savings_aggregate_excludes_classification_needs_review
  //     (count-only — delta check)
  // -------------------------------------------------------------------------
  it("#10 hard_savings_excludes_classification_needs_review: THE CFO TEST", async () => {
    const baseline =
      await assertion_hard_savings_excludes_review_flagged.run(db);
    const baselineCount = (baseline.actual as { forbiddenCount: number })
      .forbiddenCount;
    const baselineAmount = (baseline.actual as { forbiddenAmount: number })
      .forbiddenAmount;

    const orgId = await makeOrg();
    const cycleId = await makeCycle({ orgId });
    // Bad: Realized + Hard + needs_review=true (the forbidden intersection).
    const oppId = await makeOpp({
      orgId,
      cycleId,
      canonicalStage: "Realized",
      savingsType: "Realized",
      savingsClassification: "Hard",
      classificationNeedsReview: true,
      realizedSavingsUsd: "1234",
      baselineMethod: "N/A — Soft",
    });

    const bad = await assertion_hard_savings_excludes_review_flagged.run(db);
    assert.equal(bad.passed, false);
    assert.equal(
      (bad.actual as { forbiddenCount: number }).forbiddenCount,
      baselineCount + 1,
    );
    assert.equal(
      (bad.actual as { forbiddenAmount: number }).forbiddenAmount,
      baselineAmount + 1234,
    );

    // Clean: clear the review flag.
    await db
      .update(opportunitiesTable)
      .set({ classificationNeedsReview: false })
      .where(eq(opportunitiesTable.id, oppId));

    const clean =
      await assertion_hard_savings_excludes_review_flagged.run(db);
    assert.equal(
      (clean.actual as { forbiddenCount: number }).forbiddenCount,
      baselineCount,
      "forbiddenCount returns to baseline once review flag is cleared",
    );
  });

  // -------------------------------------------------------------------------
  // #11 dashboard_does_not_count_realized_records_missing_baseline
  //     (count-only — delta check; gating-family complement of #7)
  // -------------------------------------------------------------------------
  it("#11 dashboard_does_not_count_realized_records_missing_baseline: catches un-baselined Realized", async () => {
    const baseline = await assertion_no_realized_without_baseline.run(db);
    const baselineCount = (baseline.actual as { missingCount: number })
      .missingCount;
    const baselineAmount = (baseline.actual as { missingAmount: number })
      .missingAmount;

    const orgId = await makeOrg();
    const cycleId = await makeCycle({ orgId });
    // Bad: savings_type='Realized' + baseline_value=null + non-soft method.
    const oppId = await makeOpp({
      orgId,
      cycleId,
      savingsType: "Realized",
      savingsClassification: "Hard",
      baselineMethod: "Internal Estimate",
      baselineValue: null,
      realizedSavingsUsd: "777",
    });

    const bad = await assertion_no_realized_without_baseline.run(db);
    assert.equal(bad.passed, false);
    assert.equal(
      (bad.actual as { missingCount: number }).missingCount,
      baselineCount + 1,
    );
    assert.equal(
      (bad.actual as { missingAmount: number }).missingAmount,
      baselineAmount + 777,
    );

    await db
      .update(opportunitiesTable)
      .set({ baselineMethod: "N/A — Soft" })
      .where(eq(opportunitiesTable.id, oppId));

    const clean = await assertion_no_realized_without_baseline.run(db);
    assert.equal(
      (clean.actual as { missingCount: number }).missingCount,
      baselineCount,
      "missingCount returns to baseline once row is opted out via 'N/A — Soft'",
    );
  });
});
