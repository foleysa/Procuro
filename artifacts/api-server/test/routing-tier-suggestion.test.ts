/**
 * `suggestTierForCategoryLever` (task #218).
 *
 * The helper reads the latest `funnel_snapshots.calibration` block for
 * the org and classifies a (category, lever) bucket against the same
 * dead-band gating the snapshot writer applies (n ≥ 10, ±$100 swing).
 * These tests exercise:
 *   - the dead-band edges (improvement = +100 → tier_b not tier_a;
 *     +101 → tier_a; -101 → tier_c_or_d)
 *   - n < 10 → insufficient_data
 *   - fallback to the `_all` rollup when the per-(cat, lever) bucket
 *     is missing (`fellBackToLeverRollup: true`)
 *   - empty / missing snapshot → insufficient_data with null metrics
 *
 * The fixture writes the calibration map directly into a fresh
 * snapshot row rather than going through the writer, so we can
 * deterministically construct each edge case without seeding 10+
 * realized opportunities per scenario.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  funnelSnapshotsTable,
  analysisCyclesTable,
  type LeverId,
} from "@workspace/db";
import { eq } from "drizzle-orm";

import { suggestTierForCategoryLever } from "../src/lib/intelligence/routing";

const RUN = `t218s-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

const LEVER: LeverId = "spot_vs_contract" as LeverId;
const CAT_PRIMARY = `${RUN}-CAT-PRIMARY`;
const CAT_MISSING = `${RUN}-CAT-MISSING`;

let orgId: string;
let cycleId: string;

async function writeSnapshot(
  generation: number,
  calibration: Record<string, unknown>,
): Promise<string> {
  const snapId = newId("snap");
  await db.insert(funnelSnapshotsTable).values({
    id: snapId,
    orgId,
    cycleId,
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

function entry(args: {
  categoryCode: string;
  window: "30d" | "90d";
  n: number;
  improvementUsd: number;
}): {
  leverId: string;
  categoryCode: string;
  window: "30d" | "90d";
  n: number;
  rawMedianAbsErrorUsd: number;
  rescaledMedianAbsErrorUsd: number;
  improvementUsd: number;
  verdict: string;
} {
  // Verdict mirrors the writer's logic so the entry round-trips
  // realistically. The helper itself only reads `n` and
  // `improvementUsd`, so the other fields are cosmetic here.
  const verdict =
    args.n < 10
      ? "insufficient_evidence"
      : args.improvementUsd > 100
        ? "helping"
        : args.improvementUsd < -100
          ? "hurting"
          : "neutral";
  return {
    leverId: LEVER,
    categoryCode: args.categoryCode,
    window: args.window,
    n: args.n,
    rawMedianAbsErrorUsd: 1000,
    rescaledMedianAbsErrorUsd: 1000 - args.improvementUsd,
    improvementUsd: args.improvementUsd,
    verdict,
  };
}

describe("suggestTierForCategoryLever (task #218)", () => {
  before(async () => {
    orgId = newId("org");
    await db.insert(orgsTable).values({
      id: orgId,
      name: `${RUN}`,
      slug: `${RUN}`,
    });
    cycleId = newId("cyc");
    await db.insert(analysisCyclesTable).values({
      id: cycleId,
      orgId,
      generation: 1,
      triggeredBy: "test",
      status: "completed",
      completedAt: new Date(),
    });
  });

  it(
    "returns insufficient_data with null metrics when no snapshot exists",
    async () => {
      const orphanOrgId = newId("org");
      await db.insert(orgsTable).values({
        id: orphanOrgId,
        name: `${RUN}-orphan`,
        slug: `${RUN}-orphan`,
      });
      const r = await suggestTierForCategoryLever({
        orgId: orphanOrgId,
        categoryCode: CAT_PRIMARY,
        leverId: LEVER,
      });
      assert.equal(r.tier, "insufficient_data");
      assert.equal(r.improvementUsd, null);
      assert.equal(r.n, null);
      assert.equal(r.window, "90d");
      assert.equal(r.fellBackToLeverRollup, false);
      // Cleanup
      await db.delete(orgsTable).where(eq(orgsTable.id, orphanOrgId));
    },
  );

  it(
    "classifies improvement > +$100 as tier_a (uses 90d window by default)",
    async () => {
      const cal = {
        [`${LEVER}:${CAT_PRIMARY}:90d`]: entry({
          categoryCode: CAT_PRIMARY,
          window: "90d",
          n: 20,
          improvementUsd: 250,
        }),
      };
      await writeSnapshot(10, cal);
      const r = await suggestTierForCategoryLever({
        orgId,
        categoryCode: CAT_PRIMARY,
        leverId: LEVER,
      });
      assert.equal(r.tier, "tier_a");
      assert.equal(r.improvementUsd, 250);
      assert.equal(r.n, 20);
      assert.equal(r.window, "90d");
      assert.equal(r.fellBackToLeverRollup, false);
    },
  );

  it(
    "classifies improvement at the +$100 dead-band edge as tier_b (NOT tier_a)",
    async () => {
      const cal = {
        [`${LEVER}:${CAT_PRIMARY}:90d`]: entry({
          categoryCode: CAT_PRIMARY,
          window: "90d",
          n: 15,
          improvementUsd: 100,
        }),
      };
      await writeSnapshot(11, cal);
      const r = await suggestTierForCategoryLever({
        orgId,
        categoryCode: CAT_PRIMARY,
        leverId: LEVER,
      });
      assert.equal(
        r.tier,
        "tier_b",
        "improvement = +$100 must NOT classify as tier_a (strict >)",
      );
    },
  );

  it("classifies improvement at +$101 as tier_a (just past the edge)", async () => {
    const cal = {
      [`${LEVER}:${CAT_PRIMARY}:90d`]: entry({
        categoryCode: CAT_PRIMARY,
        window: "90d",
        n: 15,
        improvementUsd: 101,
      }),
    };
    await writeSnapshot(12, cal);
    const r = await suggestTierForCategoryLever({
      orgId,
      categoryCode: CAT_PRIMARY,
      leverId: LEVER,
    });
    assert.equal(r.tier, "tier_a");
  });

  it(
    "classifies improvement at the -$100 dead-band edge as tier_b (NOT tier_c_or_d)",
    async () => {
      const cal = {
        [`${LEVER}:${CAT_PRIMARY}:90d`]: entry({
          categoryCode: CAT_PRIMARY,
          window: "90d",
          n: 15,
          improvementUsd: -100,
        }),
      };
      await writeSnapshot(13, cal);
      const r = await suggestTierForCategoryLever({
        orgId,
        categoryCode: CAT_PRIMARY,
        leverId: LEVER,
      });
      assert.equal(r.tier, "tier_b");
    },
  );

  it("classifies improvement at -$101 as tier_c_or_d", async () => {
    const cal = {
      [`${LEVER}:${CAT_PRIMARY}:90d`]: entry({
        categoryCode: CAT_PRIMARY,
        window: "90d",
        n: 15,
        improvementUsd: -101,
      }),
    };
    await writeSnapshot(14, cal);
    const r = await suggestTierForCategoryLever({
      orgId,
      categoryCode: CAT_PRIMARY,
      leverId: LEVER,
    });
    assert.equal(r.tier, "tier_c_or_d");
  });

  it("returns insufficient_data when n < 10 even with helping-shaped improvement", async () => {
    const cal = {
      [`${LEVER}:${CAT_PRIMARY}:90d`]: entry({
        categoryCode: CAT_PRIMARY,
        window: "90d",
        n: 9,
        improvementUsd: 500,
      }),
    };
    await writeSnapshot(15, cal);
    const r = await suggestTierForCategoryLever({
      orgId,
      categoryCode: CAT_PRIMARY,
      leverId: LEVER,
    });
    assert.equal(r.tier, "insufficient_data");
    assert.equal(r.n, 9);
    // Metrics still surface so callers can show "n=9 (need 10)"
    assert.equal(r.improvementUsd, 500);
    assert.equal(r.fellBackToLeverRollup, false);
  });

  it(
    "falls back to the `_all` rollup when the per-(cat, lever) bucket is missing",
    async () => {
      const cal = {
        // Only the rollup is present — primary bucket missing.
        [`${LEVER}:_all:90d`]: entry({
          categoryCode: "_all",
          window: "90d",
          n: 30,
          improvementUsd: 200,
        }),
      };
      await writeSnapshot(16, cal);
      const r = await suggestTierForCategoryLever({
        orgId,
        categoryCode: CAT_MISSING,
        leverId: LEVER,
      });
      assert.equal(r.tier, "tier_a");
      assert.equal(r.improvementUsd, 200);
      assert.equal(r.n, 30);
      assert.equal(
        r.fellBackToLeverRollup,
        true,
        "must badge the answer as a coarser rollup-derived estimate",
      );
    },
  );

  it("respects an explicit window override (30d vs 90d)", async () => {
    const cal = {
      [`${LEVER}:${CAT_PRIMARY}:30d`]: entry({
        categoryCode: CAT_PRIMARY,
        window: "30d",
        n: 12,
        improvementUsd: -300,
      }),
      [`${LEVER}:${CAT_PRIMARY}:90d`]: entry({
        categoryCode: CAT_PRIMARY,
        window: "90d",
        n: 25,
        improvementUsd: 400,
      }),
    };
    await writeSnapshot(17, cal);
    const r30 = await suggestTierForCategoryLever({
      orgId,
      categoryCode: CAT_PRIMARY,
      leverId: LEVER,
      window: "30d",
    });
    assert.equal(r30.tier, "tier_c_or_d");
    assert.equal(r30.window, "30d");
    const r90 = await suggestTierForCategoryLever({
      orgId,
      categoryCode: CAT_PRIMARY,
      leverId: LEVER,
      window: "90d",
    });
    assert.equal(r90.tier, "tier_a");
    assert.equal(r90.window, "90d");
  });

  it(
    "uses ONLY the latest snapshot — older snapshots are ignored",
    async () => {
      // Older snapshot says tier_a; newer says tier_c_or_d. The helper
      // must read newer.
      await writeSnapshot(20, {
        [`${LEVER}:${CAT_PRIMARY}:90d`]: entry({
          categoryCode: CAT_PRIMARY,
          window: "90d",
          n: 30,
          improvementUsd: 800,
        }),
      });
      await writeSnapshot(21, {
        [`${LEVER}:${CAT_PRIMARY}:90d`]: entry({
          categoryCode: CAT_PRIMARY,
          window: "90d",
          n: 30,
          improvementUsd: -800,
        }),
      });
      const r = await suggestTierForCategoryLever({
        orgId,
        categoryCode: CAT_PRIMARY,
        leverId: LEVER,
      });
      assert.equal(r.tier, "tier_c_or_d");
    },
  );

  after(async () => {
    if (orgId) {
      try {
        await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
      } catch {
        /* swallow */
      }
    }
  });
});
