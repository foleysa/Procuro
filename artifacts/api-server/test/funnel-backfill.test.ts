/**
 * Task #196 — End-to-end verification for the funnel backfill helper.
 *
 * Seeds a tenant with a mix of cycles (completed-with-opps, completed-empty,
 * still-running, and one that already has a snapshot) and asserts that
 * `backfillFunnelSnapshotsForOrg`:
 *   (a) creates exactly one snapshot per missing completed cycle,
 *   (b) is idempotent on re-run (zero new snapshots),
 *   (c) skips non-completed cycles,
 *   (d) produces stage 6–10 counts that match a recompute of the same
 *       cycle (i.e. the same code path the admin recompute endpoint hits).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  opportunitiesTable,
  decisionsTable,
  analysisCyclesTable,
  funnelSnapshotsTable,
  type LeverId,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

import {
  backfillFunnelSnapshotsForOrg,
  captureFunnelSnapshot,
} from "../src/lib/ooda/funnel";
import type {
  AnalyzeResult,
  LeverAnalyzer,
  OpportunityDraft,
} from "../src/lib/levers/types";

const RUN = `t196-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

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
let supId: string;
let cycleCompletedA: string; // completed, has 2 opps + 1 decision
let cycleCompletedB: string; // completed, no opps
let cycleRunning: string;    // running -> must be skipped
let cycleAlreadySnapshotted: string; // completed, snapshot already exists

async function insertCycle(
  org: string,
  generation: number,
  status: "running" | "completed" | "failed",
): Promise<string> {
  const id = newId("cyc");
  await db.insert(analysisCyclesTable).values({
    id,
    orgId: org,
    generation,
    triggeredBy: "test",
    status,
    completedAt: status === "completed" ? new Date() : null,
  });
  return id;
}

async function insertOpp(args: {
  org: string;
  cycleId: string;
  raw: number;
  rescaleMultiplier: number;
  withDecision?: "approve" | "execute" | "realize";
  realizedRatio?: number;
}): Promise<string> {
  const projected = args.raw * args.rescaleMultiplier;
  const [row] = await db
    .insert(opportunitiesTable)
    .values({
      id: newId("opp"),
      orgId: args.org,
      cycleId: args.cycleId,
      leverId: stubLever.leverId,
      tier: 2,
      title: `${RUN} opp`,
      rationale: "stub",
      recommendedAction: "stub",
      supplierId: supId,
      categoryId: null,
      rawProjectedSavingsUsd: args.raw.toFixed(2),
      projectedSavingsUsd: projected.toFixed(2),
      confidence: "0.5000",
      inputs: { categoryCode: "X" },
    })
    .returning();
  if (args.withDecision) {
    await db.insert(decisionsTable).values({
      id: newId("dec"),
      opportunityId: row!.id,
      orgId: args.org,
      cycleId: args.cycleId,
      eventType: args.withDecision,
      actor: "test@example.com",
      createdAt: new Date(Date.now() - 86400_000),
      realizedSavingsUsd:
        args.withDecision === "realize" && args.realizedRatio != null
          ? (projected * args.realizedRatio).toFixed(2)
          : null,
    });
  }
  return row!.id;
}

describe("OODA funnel backfill (task #196)", () => {
  before(async () => {
    orgId = newId("org");
    supId = newId("sup");
    await db
      .insert(orgsTable)
      .values({ id: orgId, name: `${RUN}`, slug: `${RUN}-${orgId.slice(-6)}` });
    await db.insert(suppliersTable).values({
      id: supId,
      orgId,
      name: `${RUN} sup`,
      normalizedName: `${RUN} sup`,
      sourceSystem: "csv",
      sourceExternalId: `${RUN}-sup`,
    });

    // Generation 1: completed, has 2 opps (one approved).
    cycleCompletedA = await insertCycle(orgId, 1, "completed");
    await insertOpp({
      org: orgId,
      cycleId: cycleCompletedA,
      raw: 1000,
      rescaleMultiplier: 0.8,
      withDecision: "approve",
    });
    await insertOpp({
      org: orgId,
      cycleId: cycleCompletedA,
      raw: 500,
      rescaleMultiplier: 1.0,
    });

    // Generation 2: completed, no opportunities.
    cycleCompletedB = await insertCycle(orgId, 2, "completed");

    // Generation 3: still running — backfill must skip.
    cycleRunning = await insertCycle(orgId, 3, "running");

    // Generation 4: completed AND already has a snapshot — backfill
    // must leave it untouched (anti-join filters it from the cycle list).
    cycleAlreadySnapshotted = await insertCycle(orgId, 4, "completed");
    const pre = await captureFunnelSnapshot({
      orgId,
      cycleId: cycleAlreadySnapshotted,
      cycleGeneration: 4,
      leverResults: [
        {
          lever: stubLever,
          result: {
            drafts: [],
            consultedSignalIds: [],
            candidatesEvaluated: 0,
          } as AnalyzeResult,
        },
      ],
      draftsPostExclusion: [],
      persistedOpps: [],
      priorDeltas: [],
      source: "live",
    });
    assert.ok(pre.snapshotId, "pre-existing snapshot must seed correctly");
  });

  it("creates one snapshot per missing completed cycle and skips the rest", async () => {
    const report = await backfillFunnelSnapshotsForOrg(orgId, {
      ALL_LEVERS: [stubLever],
    });

    // Anti-join only returns cycles WITHOUT a snapshot, so the snapshotted
    // cycle never appears in `cyclesScanned`. We're left with the two
    // completed + the one running cycle.
    assert.equal(report.orgId, orgId);
    assert.equal(report.cyclesScanned, 3);
    assert.equal(report.snapshotsCreated, 2);
    assert.equal(report.skippedNotCompleted, 1);
    assert.equal(report.alreadyHadSnapshot, 0);
    assert.equal(report.failed, 0);

    const snapshots = await db
      .select()
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.orgId, orgId));
    // 2 backfilled + 1 pre-existing live snapshot = 3 rows total.
    assert.equal(snapshots.length, 3);

    // Backfilled rows are tagged with source='backfill'; the pre-existing
    // one stays 'live'.
    const backfilled = snapshots.filter((s) => s.source === "backfill");
    const live = snapshots.filter((s) => s.source === "live");
    assert.equal(backfilled.length, 2);
    assert.equal(live.length, 1);
    assert.equal(live[0]!.cycleId, cycleAlreadySnapshotted);

    // The running cycle must NOT have a snapshot row.
    const runningSnap = snapshots.find((s) => s.cycleId === cycleRunning);
    assert.equal(runningSnap, undefined);

    // Cycle A's snapshot must reflect its 2 persisted opps.
    const snapA = snapshots.find((s) => s.cycleId === cycleCompletedA)!;
    assert.ok(snapA, "snapshot for cycle A missing");
    const stagesA = snapA.stages as Record<string, { count: number }>;
    assert.equal(stagesA["opps_persisted"]!.count, 2);
    assert.equal(snapA.totalOppsPersisted, 2);
    // Stages 2–5 are zeroed on backfill (analyzer outputs aren't
    // replayable post-hoc — the helper passes empty leverResults +
    // draftsPostExclusion to captureFunnelSnapshot). Stage 1
    // (signals_collected) is still derived from live DB rows on
    // market_signals because the writer queries them directly, so we
    // don't pin its count here.
    assert.equal(stagesA["signals_mapped_to_levers"]!.count, 0);
    assert.equal(stagesA["signals_analyzed"]!.count, 0);
    assert.equal(stagesA["drafts_produced"]!.count, 0);
    assert.equal(stagesA["drafts_post_exclusion"]!.count, 0);
    // Stage 7 (approved within 7d) must include the approved opp.
    assert.equal(stagesA["opps_approved_7d"]!.count, 1);
    // Stage 10 (priors_updated) is zeroed — no per-cycle deltas to replay.
    assert.equal(stagesA["priors_updated"]!.count, 0);

    // Cycle B's snapshot has zero opps, so all stages are zero.
    const snapB = snapshots.find((s) => s.cycleId === cycleCompletedB)!;
    assert.ok(snapB, "snapshot for cycle B missing");
    const stagesB = snapB.stages as Record<string, { count: number }>;
    assert.equal(stagesB["opps_persisted"]!.count, 0);
    assert.equal(snapB.totalOppsPersisted, 0);
  });

  it("is idempotent — a second run creates zero new snapshots", async () => {
    const report = await backfillFunnelSnapshotsForOrg(orgId, {
      ALL_LEVERS: [stubLever],
    });
    // All four cycles now have snapshots (or are still running/excluded
    // from the anti-join), so the helper finds only the running cycle to
    // scan and skips it.
    assert.equal(report.snapshotsCreated, 0);
    assert.equal(report.cyclesScanned, 1);
    assert.equal(report.skippedNotCompleted, 1);
    assert.equal(report.failed, 0);

    const count = await db
      .select({ id: funnelSnapshotsTable.id })
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.orgId, orgId));
    // Still 3 total — no duplicates were inserted.
    assert.equal(count.length, 3);
  });

  it("stage 6–10 counts match a recompute of the same cycle", async () => {
    // Capture the backfilled snapshot's stage counts for cycle A.
    const [backfilled] = await db
      .select()
      .from(funnelSnapshotsTable)
      .where(
        and(
          eq(funnelSnapshotsTable.orgId, orgId),
          eq(funnelSnapshotsTable.cycleId, cycleCompletedA),
        ),
      )
      .limit(1);
    assert.ok(backfilled, "backfilled snapshot for cycle A missing");
    const beforeStages = backfilled!.stages as Record<
      string,
      { count: number }
    >;

    // Recompute path: drop the snapshot and re-capture from persisted
    // state — exactly what `POST /admin/funnel/snapshots/:cycleId/recompute`
    // does. The backfill helper and the recompute endpoint share
    // captureFunnelSnapshot with source='backfill', so stages 6–10 must
    // agree exactly for the same fixture.
    await db
      .delete(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.cycleId, cycleCompletedA));
    const persistedOpps = await db
      .select()
      .from(opportunitiesTable)
      .where(
        and(
          eq(opportunitiesTable.orgId, orgId),
          eq(opportunitiesTable.cycleId, cycleCompletedA),
        ),
      );
    const recomputed = await captureFunnelSnapshot({
      orgId,
      cycleId: cycleCompletedA,
      cycleGeneration: 1,
      leverResults: [stubLever].map((l) => ({
        lever: l,
        result: {
          drafts: [],
          consultedSignalIds: [],
          candidatesEvaluated: 0,
        } as AnalyzeResult,
      })),
      draftsPostExclusion: [],
      persistedOpps,
      priorDeltas: [],
      source: "backfill",
    });
    assert.equal(recomputed.failed, false);

    const [reSnap] = await db
      .select()
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.id, recomputed.snapshotId!))
      .limit(1);
    const afterStages = reSnap!.stages as Record<string, { count: number }>;

    // The stages we care about for backfill correctness are the persisted
    // opp stage (6), the cohort outcome stages (7–9), and the priors
    // stage (10). Compare counts directly.
    const STAGES_6_TO_10 = [
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
    for (const k of STAGES_6_TO_10) {
      assert.equal(
        afterStages[k]?.count,
        beforeStages[k]?.count,
        `stage ${k} count diverges between backfill and recompute`,
      );
    }
  });

  after(async () => {
    const safe = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* swallow */
      }
    };
    // Cascade from orgs handles snapshots / opps / decisions / cycles /
    // suppliers.
    if (orgId) await safe(db.delete(orgsTable).where(eq(orgsTable.id, orgId)));
  });
});
