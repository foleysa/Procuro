/**
 * #204 — Substrate readers used by the Today aggregator.
 *
 * Pins the contract of the two thin readers we added so the Today feed
 * keeps surfacing "what changed since yesterday":
 *
 *   - `getRecentAutoAnnotations` returns only `source='auto'` rows for
 *     the given org, joined to the snapshot they were emitted from
 *     (so the UI can render `cycle #N`), in newest-first order.
 *
 *   - `getCycleConversionRateDeltas` computes per-transition conversion
 *     rates from the two most-recent funnel snapshots for the org, with
 *     null-rate handling when the denominator is 0, and an empty
 *     `transitions` array when fewer than two snapshots exist
 *     ("insufficient history" — a legitimate state, not an error).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  analysisCyclesTable,
  funnelSnapshotsTable,
  funnelAnnotationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  getRecentAutoAnnotations,
  getCycleConversionRateDeltas,
} from "../src/lib/ooda/funnel";

const RUN = `t204-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const newId = (p: string) =>
  `${p}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;

let orgId: string;
let otherOrgId: string;

async function makeSnapshot(args: {
  orgId: string;
  generation: number;
  stages: Record<string, { count: number }>;
}): Promise<string> {
  const cycleId = newId("cyc");
  await db.insert(analysisCyclesTable).values({
    id: cycleId,
    orgId: args.orgId,
    generation: args.generation,
    triggeredBy: "test",
    status: "completed",
    completedAt: new Date(),
  });
  const snapshotId = newId("fnl");
  await db.insert(funnelSnapshotsTable).values({
    id: snapshotId,
    orgId: args.orgId,
    cycleId,
    cycleGeneration: args.generation,
    stages: args.stages as unknown as Record<string, unknown>,
    cohorts: {},
    calibration: {},
  });
  return snapshotId;
}

describe("Today substrate readers (#204)", () => {
  // Isolation strategy (#252 audit): two fresh orgs are minted per
  // file run; the count-sensitive conversion-rate tests further mint
  // their own per-test isolated orgs (`isolatedOrg`, `cmpOrg`, `zOrg`)
  // so the "two most recent snapshots" lookup is deterministic. Org
  // teardown cascades to cycles/snapshots/annotations via FK. No
  // assertion keys off org-wide aggregates of orgs the test does not
  // own, so sibling test files cannot contaminate this suite.
  before(async () => {
    orgId = newId("org");
    otherOrgId = newId("org");
    await db.insert(orgsTable).values([
      { id: orgId, name: `${RUN} A`, slug: `${RUN}-a` },
      { id: otherOrgId, name: `${RUN} B`, slug: `${RUN}-b` },
    ]);
  });

  after(async () => {
    // FK cascade from orgs cleans up cycles/snapshots/annotations.
    await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
    await db.delete(orgsTable).where(eq(orgsTable.id, otherOrgId));
  });

  it("getRecentAutoAnnotations returns auto-only rows newest-first, joined to cycle generation, scoped to org", async () => {
    // One snapshot to attach annotations to, plus a sibling org snapshot
    // we'll seed annotations against to verify tenant scoping.
    const snapId = await makeSnapshot({
      orgId,
      generation: 100,
      stages: { drafts_produced: { count: 0 } },
    });
    const otherSnapId = await makeSnapshot({
      orgId: otherOrgId,
      generation: 1,
      stages: {},
    });

    // Two auto annotations + one operator note. The reader must skip
    // the operator note and return the two auto rows newest-first.
    await db.insert(funnelAnnotationsTable).values([
      {
        id: newId("fnlann"),
        orgId,
        snapshotId: snapId,
        source: "auto",
        kind: "stage_drop",
        targetStage: "drafts_produced",
        summary: "drafts dropped 30%",
        detail: {},
        createdAt: new Date(Date.now() - 60_000),
      },
      {
        id: newId("fnlann"),
        orgId,
        snapshotId: snapId,
        source: "auto",
        kind: "stage_spike",
        targetStage: "opps_persisted",
        summary: "persisted spiked 40%",
        detail: {},
        createdAt: new Date(),
      },
      {
        id: newId("fnlann"),
        orgId,
        snapshotId: snapId,
        source: "operator",
        kind: "operator_note",
        summary: "human-written note that must NOT appear",
        detail: {},
      },
      // Other-tenant auto annotation must NOT appear.
      {
        id: newId("fnlann"),
        orgId: otherOrgId,
        snapshotId: otherSnapId,
        source: "auto",
        kind: "stage_drop",
        summary: "leak guard",
        detail: {},
      },
    ]);

    const out = await getRecentAutoAnnotations(orgId);
    assert.equal(out.length, 2, "operator + cross-tenant rows excluded");
    assert.equal(out[0]?.kind, "stage_spike", "newest first");
    assert.equal(out[1]?.kind, "stage_drop");
    for (const a of out) {
      assert.equal(a.cycleGeneration, 100, "joined to snapshot generation");
      assert.equal(typeof a.createdAt, "string");
    }
  });

  it("getCycleConversionRateDeltas returns empty transitions when there's only one snapshot", async () => {
    // Use a brand-new org so we control the snapshot count exactly.
    const isolatedOrg = newId("org");
    await db.insert(orgsTable).values({
      id: isolatedOrg,
      name: `${RUN} Iso`,
      slug: `${RUN}-iso`,
    });
    try {
      await makeSnapshot({
        orgId: isolatedOrg,
        generation: 1,
        stages: {
          drafts_produced: { count: 100 },
          drafts_post_exclusion: { count: 50 },
        },
      });
      const r = await getCycleConversionRateDeltas(isolatedOrg);
      assert.equal(r.transitions.length, 0, "single snapshot → no deltas");
      assert.equal(r.currentCycleGeneration, 1);
      assert.equal(r.prevCycleGeneration, null);
    } finally {
      await db.delete(orgsTable).where(eq(orgsTable.id, isolatedOrg));
    }
  });

  it("getCycleConversionRateDeltas computes per-transition rates and sorts by |delta| desc", async () => {
    // Use a fresh isolated org so the prior test's snapshot for `orgId`
    // doesn't pollute the "two most recent" lookup.
    const cmpOrg = newId("org");
    await db.insert(orgsTable).values({
      id: cmpOrg,
      name: `${RUN} Cmp`,
      slug: `${RUN}-cmp`,
    });
    try {
      // Cycle #10 (older): 100 drafts → 80 post-ex → 40 persisted →
      //                     20 approved_30d → 10 realized_30d
      await makeSnapshot({
        orgId: cmpOrg,
        generation: 10,
        stages: {
          drafts_produced: { count: 100 },
          drafts_post_exclusion: { count: 80 },
          opps_persisted: { count: 40 },
          opps_approved_30d: { count: 20 },
          opps_realized_30d: { count: 10 },
        },
      });
      // Cycle #11 (newer): 100 drafts → 80 post-ex → 20 persisted →
      //                     20 approved_30d → 10 realized_30d
      // → drafts→post_ex unchanged (0 pp), post_ex→persisted dropped
      //   from 0.5 to 0.25 (-25 pp), persisted→approved went 0.5→1.0
      //   (+50 pp), approved→realized unchanged (0 pp).
      await makeSnapshot({
        orgId: cmpOrg,
        generation: 11,
        stages: {
          drafts_produced: { count: 100 },
          drafts_post_exclusion: { count: 80 },
          opps_persisted: { count: 20 },
          opps_approved_30d: { count: 20 },
          opps_realized_30d: { count: 10 },
        },
      });

      const r = await getCycleConversionRateDeltas(cmpOrg);
      assert.equal(r.currentCycleGeneration, 11);
      assert.equal(r.prevCycleGeneration, 10);
      assert.equal(r.transitions.length, 4);

      // Largest |delta| first: persisted→approved_30d (+0.5)
      assert.equal(r.transitions[0]?.transition, "persisted→approved_30d");
      assert.equal(r.transitions[0]?.delta, 0.5);
      assert.equal(r.transitions[0]?.prevRate, 0.5);
      assert.equal(r.transitions[0]?.currentRate, 1);

      // Second largest: post_exclusion→persisted (-0.25)
      assert.equal(r.transitions[1]?.transition, "post_exclusion→persisted");
      assert.equal(r.transitions[1]?.delta, -0.25);

      // Two zero-delta transitions tied at the bottom.
      const tail = r.transitions.slice(2).map((t) => t.delta);
      assert.deepEqual(tail.sort(), [0, 0]);
    } finally {
      await db.delete(orgsTable).where(eq(orgsTable.id, cmpOrg));
    }
  });

  it("getCycleConversionRateDeltas surfaces null rates when the denominator is 0", async () => {
    const zOrg = newId("org");
    await db.insert(orgsTable).values({
      id: zOrg,
      name: `${RUN} Z`,
      slug: `${RUN}-z`,
    });
    try {
      // Both cycles have 0 drafts_produced, so drafts→post_ex is null
      // in both cycles → delta is null (not 0) so the UI can show a
      // "no signal" state rather than misleadingly "no change."
      await makeSnapshot({
        orgId: zOrg,
        generation: 1,
        stages: {
          drafts_produced: { count: 0 },
          drafts_post_exclusion: { count: 0 },
        },
      });
      await makeSnapshot({
        orgId: zOrg,
        generation: 2,
        stages: {
          drafts_produced: { count: 0 },
          drafts_post_exclusion: { count: 0 },
        },
      });
      const r = await getCycleConversionRateDeltas(zOrg);
      const drafts = r.transitions.find(
        (t) => t.transition === "drafts→post_exclusion",
      );
      assert.ok(drafts, "drafts transition emitted");
      assert.equal(drafts?.prevRate, null);
      assert.equal(drafts?.currentRate, null);
      assert.equal(drafts?.delta, null);
    } finally {
      await db.delete(orgsTable).where(eq(orgsTable.id, zOrg));
    }
  });
});
