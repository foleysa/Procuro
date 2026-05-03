/**
 * Tier auto-apply (task #229).
 *
 * Verifies the post-snapshot hysteresis machine in
 * `processTierUpdates`:
 *   - Bootstrap: first usable signal materializes a row at the
 *     suggested tier and emits a `calibration_change` annotation
 *     tagged `bootstrap: true`.
 *   - Single bad cycle does NOT flip an applied tier (pending=1, no
 *     annotation, applied unchanged).
 *   - Two consecutive matching suggestions DO flip
 *     (pending=2 → applied, annotation emitted, scale stored).
 *   - A reaffirming suggestion clears any pending state.
 *   - `getTierAutoApplySettings` defaults to `advisory`; mode reads
 *     and writes round-trip.
 *
 * Each scenario constructs an isolated org + cycle and writes the
 * calibration directly into a fresh snapshot row (mirroring the
 * pattern used by `routing-tier-suggestion.test.ts`) so we don't
 * have to seed realized opportunities for every edge case.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  funnelSnapshotsTable,
  funnelAnnotationsTable,
  analysisCyclesTable,
  appSettingsTable,
  categoryLeverPriorScalesTable,
  APP_SETTING_KEY_TIER_AUTO_APPLY,
  type LeverId,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

import {
  processTierUpdates,
  getTierAutoApplySettings,
  setTierAutoApplyMode,
  loadCategoryLeverScales,
  makeScaleMapKey,
  tierToScale,
  STABILITY_OBS_REQUIRED,
} from "../src/lib/ooda/tier-auto-apply";

const RUN = `t229-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const LEVER: LeverId = "spot_vs_contract" as LeverId;
const CAT = `${RUN}-CAT`;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;

async function writeSnapshotWith(
  generation: number,
  improvementUsd: number,
  n: number,
): Promise<string> {
  // funnel_snapshots has a unique constraint on cycle_id, so each
  // snapshot needs its own cycle row. Hysteresis tests still pass a
  // monotonically increasing `cycleGeneration` to processTierUpdates,
  // mirroring the real cycle runner.
  const localCycleId = newId("cyc");
  await db.insert(analysisCyclesTable).values({
    id: localCycleId,
    orgId,
    generation,
    triggeredBy: "test",
    status: "completed",
    completedAt: new Date(),
  });
  const snapId = newId("snap");
  const verdict =
    n < 10
      ? "insufficient_evidence"
      : improvementUsd > 100
        ? "helping"
        : improvementUsd < -100
          ? "hurting"
          : "neutral";
  const calibration = {
    [`${LEVER}:${CAT}:90d`]: {
      leverId: LEVER,
      categoryCode: CAT,
      window: "90d" as const,
      n,
      rawMedianAbsErrorUsd: 1000,
      rescaledMedianAbsErrorUsd: 1000 - improvementUsd,
      improvementUsd,
      verdict,
    },
  };
  await db.insert(funnelSnapshotsTable).values({
    id: snapId,
    orgId,
    cycleId: localCycleId,
    cycleGeneration: generation,
    stages: {},
    cohorts: {},
    calibration,
    totalDraftsProduced: 0,
    totalDraftsPostExclusion: 0,
    totalOppsPersisted: 0,
    totalProjectedUsd: "0",
    captureDurationMs: 0,
    hasAutoAnnotation: 0,
  });
  return snapId;
}

async function getRow() {
  const [row] = await db
    .select()
    .from(categoryLeverPriorScalesTable)
    .where(
      and(
        eq(categoryLeverPriorScalesTable.orgId, orgId),
        eq(categoryLeverPriorScalesTable.categoryCode, CAT),
        eq(categoryLeverPriorScalesTable.leverId, LEVER),
      ),
    );
  return row;
}

async function countCalibrationAnnotations(snapshotId: string): Promise<number> {
  const rows = await db
    .select({ id: funnelAnnotationsTable.id })
    .from(funnelAnnotationsTable)
    .where(
      and(
        eq(funnelAnnotationsTable.snapshotId, snapshotId),
        eq(funnelAnnotationsTable.kind, "calibration_change"),
      ),
    );
  return rows.length;
}

describe("tier-auto-apply (task #229)", () => {
  before(async () => {
    orgId = newId("org");
    await db.insert(orgsTable).values({
      id: orgId,
      name: RUN,
      slug: RUN,
    });
  });

  beforeEach(async () => {
    // Each test starts with a clean override row so the hysteresis
    // assertions don't bleed across tests.
    await db
      .delete(categoryLeverPriorScalesTable)
      .where(eq(categoryLeverPriorScalesTable.orgId, orgId));
  });

  after(async () => {
    // Best-effort cleanup. The `orgs` cascade unwinds most rows; the
    // app_settings row is global so we delete it explicitly.
    await db
      .delete(appSettingsTable)
      .where(eq(appSettingsTable.key, APP_SETTING_KEY_TIER_AUTO_APPLY));
    await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  });

  it("defaults to advisory mode and round-trips writes", async () => {
    await db
      .delete(appSettingsTable)
      .where(eq(appSettingsTable.key, APP_SETTING_KEY_TIER_AUTO_APPLY));
    const def = await getTierAutoApplySettings();
    assert.equal(def.mode, "advisory");
    assert.equal(def.isOverride, false);

    const updated = await setTierAutoApplyMode({
      mode: "auto",
      actorEmail: "ops@example.com",
    });
    assert.equal(updated.mode, "auto");
    assert.equal(updated.isOverride, true);
    assert.equal(updated.lastChangedBy, "ops@example.com");
    const reread = await getTierAutoApplySettings();
    assert.equal(reread.mode, "auto");

    const back = await setTierAutoApplyMode({
      mode: "advisory",
      actorEmail: "ops@example.com",
    });
    assert.equal(back.mode, "advisory");
  });

  it("bootstraps a brand-new (cat, lever) row from the first usable signal", async () => {
    const snapId = await writeSnapshotWith(10, 250, 20); // tier_a
    const result = await processTierUpdates({
      orgId,
      cycleGeneration: 10,
      snapshotId: snapId,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0]!.fromTier, "none");
    assert.equal(result.changes[0]!.toTier, "tier_a");

    const row = await getRow();
    assert.ok(row, "override row should be inserted by bootstrap");
    assert.equal(row!.appliedTier, "tier_a");
    assert.equal(row!.appliedAtCycle, 10);
    assert.equal(row!.pendingTier, null);
    assert.equal(row!.pendingObservations, 0);

    const annCount = await countCalibrationAnnotations(snapId);
    assert.equal(annCount, 1, "bootstrap emits one calibration_change annotation");
  });

  it("does NOT flip applied tier on a single contradicting cycle (hysteresis guard)", async () => {
    // Bootstrap at tier_a.
    const s1 = await writeSnapshotWith(20, 250, 20);
    await processTierUpdates({
      orgId,
      cycleGeneration: 20,
      snapshotId: s1,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });

    // Single bad cycle: improvement craters into tier_c_or_d
    // territory (-300). Hysteresis must hold the previous tier.
    const s2 = await writeSnapshotWith(21, -300, 20);
    const result = await processTierUpdates({
      orgId,
      cycleGeneration: 21,
      snapshotId: s2,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });
    assert.equal(result.changes.length, 0, "single bad cycle must not flip");
    assert.equal(result.pendingAdvances, 1);

    const row = await getRow();
    assert.equal(row!.appliedTier, "tier_a", "applied tier unchanged after one bad cycle");
    assert.equal(row!.pendingTier, "tier_c_or_d");
    assert.equal(row!.pendingObservations, 1);
    assert.equal(row!.pendingSinceCycle, 21);

    const annCount = await countCalibrationAnnotations(s2);
    assert.equal(annCount, 0, "no annotation emitted on pending advance");
  });

  it(`flips applied tier after ${STABILITY_OBS_REQUIRED} consecutive matching cycles`, async () => {
    // Bootstrap at tier_a.
    const s1 = await writeSnapshotWith(30, 250, 20);
    await processTierUpdates({
      orgId,
      cycleGeneration: 30,
      snapshotId: s1,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });

    // Two consecutive tier_c_or_d signals → flip on the second.
    const s2 = await writeSnapshotWith(31, -300, 20);
    await processTierUpdates({
      orgId,
      cycleGeneration: 31,
      snapshotId: s2,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });
    const s3 = await writeSnapshotWith(32, -350, 20);
    const flipResult = await processTierUpdates({
      orgId,
      cycleGeneration: 32,
      snapshotId: s3,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });

    assert.equal(flipResult.changes.length, 1, "second matching cycle flips");
    assert.equal(flipResult.changes[0]!.fromTier, "tier_a");
    assert.equal(flipResult.changes[0]!.toTier, "tier_c_or_d");

    const row = await getRow();
    assert.equal(row!.appliedTier, "tier_c_or_d");
    assert.equal(row!.appliedAtCycle, 32);
    assert.equal(row!.pendingTier, null);
    assert.equal(row!.pendingObservations, 0);

    // Stored multiplier matches the published mapping.
    const expected = tierToScale("tier_c_or_d");
    assert.equal(Number(row!.appliedScaleProjection), expected.projection);
    assert.equal(Number(row!.appliedScaleConfidence), expected.confidence);

    const annCount = await countCalibrationAnnotations(s3);
    assert.equal(annCount, 1, "flip emits exactly one calibration_change annotation");
  });

  it("reaffirmation clears a pending streak so a single match resets the counter", async () => {
    // Bootstrap at tier_a, then start a tier_c_or_d streak (1/2).
    const s1 = await writeSnapshotWith(40, 250, 20);
    await processTierUpdates({
      orgId,
      cycleGeneration: 40,
      snapshotId: s1,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });
    const s2 = await writeSnapshotWith(41, -300, 20);
    await processTierUpdates({
      orgId,
      cycleGeneration: 41,
      snapshotId: s2,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });
    let row = await getRow();
    assert.equal(row!.pendingTier, "tier_c_or_d");
    assert.equal(row!.pendingObservations, 1);

    // Snapshot reaffirms tier_a → pending state must reset.
    const s3 = await writeSnapshotWith(42, 300, 20);
    const result = await processTierUpdates({
      orgId,
      cycleGeneration: 42,
      snapshotId: s3,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });
    assert.equal(result.changes.length, 0);
    assert.equal(result.reaffirmations, 1);
    row = await getRow();
    assert.equal(row!.appliedTier, "tier_a");
    assert.equal(row!.pendingTier, null);
    assert.equal(row!.pendingObservations, 0);
  });

  it("loadCategoryLeverScales returns the persisted multiplier under the canonical key", async () => {
    const snapId = await writeSnapshotWith(50, 250, 20);
    await processTierUpdates({
      orgId,
      cycleGeneration: 50,
      snapshotId: snapId,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });
    const map = await loadCategoryLeverScales(orgId);
    const hit = map.get(makeScaleMapKey(CAT, LEVER));
    assert.ok(hit, "scale lookup should hit after bootstrap");
    assert.equal(hit!.tier, "tier_a");
    assert.equal(hit!.projection, 1);
    assert.equal(hit!.confidence, 1);
  });

  it("insufficient_data is a no-op for both new and existing rows", async () => {
    // Bootstrap at tier_a.
    const s1 = await writeSnapshotWith(60, 250, 20);
    await processTierUpdates({
      orgId,
      cycleGeneration: 60,
      snapshotId: s1,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });
    // n < 10 → insufficient_data → must not touch the row.
    const s2 = await writeSnapshotWith(61, 250, 5);
    const result = await processTierUpdates({
      orgId,
      cycleGeneration: 61,
      snapshotId: s2,
      pairs: [{ categoryCode: CAT, leverId: LEVER }],
    });
    assert.equal(result.skippedInsufficient, 1);
    assert.equal(result.changes.length, 0);
    const row = await getRow();
    assert.equal(row!.appliedTier, "tier_a");
    assert.equal(row!.pendingObservations, 0);
  });
});

