/**
 * End-to-end spot check for the Tier-5 `unbundling_rebundling`
 * lever (#234).
 *
 * Two scenarios share an org:
 *
 *   - Rebundle: one category ("Consulting") with 3 t_and_m contracts
 *     across 3 distinct suppliers totalling $600k baseline. Asserts a
 *     draft sized at 5% of combined baseline ($30k) anchored to the
 *     category.
 *   - Unbundle: one supplier ("Generalist Co") holding 3 active
 *     contracts in 3 distinct categories totalling $900k baseline.
 *     Asserts a draft sized at 4% of combined baseline ($36k)
 *     anchored to the supplier.
 *
 * Also seeds a no-op category (single contract / single supplier) to
 * prove neither branch fires when the shape thresholds aren't met.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  categoriesTable,
  contractsTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";

import { unbundlingRebundlingLever } from "../src/lib/levers/services/unbundling-rebundling";
import { toAnalyzeResult } from "../src/lib/levers/types";

const RUN = `t234ubr-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
// Rebundle scenario
let rebundleCategoryId: string;
const rebundleSupplierIds: string[] = [];
const REBUNDLE_BASELINE = 200_000; // 3 × $200k = $600k
// Unbundle scenario
let generalistSupplierId: string;
const unbundleCategoryIds: string[] = [];
const UNBUNDLE_BASELINE = 300_000; // 3 × $300k = $900k
// Negative scenario
let noopSupplierId: string;
let noopCategoryId: string;

describe("unbundling_rebundling Tier-5 lever (#234)", () => {
  before(async () => {
    orgId = newId("org");
    await db.insert(orgsTable).values({
      id: orgId,
      name: `${RUN} Test Org`,
      slug: `${RUN}-org`,
    });

    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);

    const seedCategory = async (label: string, code: string) => {
      const id = newId("cat");
      await db.insert(categoriesTable).values({
        id,
        orgId,
        code: `${RUN}-${code}`,
        name: `${RUN} ${label}`,
        class: "service",
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-cat-${code}`,
      });
      return id;
    };
    const seedSupplier = async (label: string) => {
      const id = newId("sup");
      await db.insert(suppliersTable).values({
        id,
        orgId,
        name: `${RUN} ${label}`,
        normalizedName: `${RUN} ${label}`.toLowerCase(),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-sup-${label}`,
      });
      return id;
    };
    const seedContract = async (
      supplierId: string,
      categoryId: string,
      label: string,
      baseline: number,
    ) => {
      const id = newId("con");
      await db.insert(contractsTable).values({
        id,
        orgId,
        supplierId,
        categoryId,
        contractNumber: `${RUN}-${label}`,
        title: `${RUN} ${label}`,
        status: "active",
        contractType: "t_and_m",
        startDate: today,
        endDate: inOneYear,
        annualBaselineUsd: String(baseline),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-con-${label}`,
      });
      return id;
    };

    // Rebundle: 1 category, 3 suppliers, 3 contracts.
    rebundleCategoryId = await seedCategory("Consulting", "CONSULTING");
    for (let i = 0; i < 3; i++) {
      const sup = await seedSupplier(`RebundleSup${i + 1}`);
      rebundleSupplierIds.push(sup);
      await seedContract(
        sup,
        rebundleCategoryId,
        `REB-${i + 1}`,
        REBUNDLE_BASELINE,
      );
    }

    // Unbundle: 1 supplier, 3 categories, 3 contracts.
    generalistSupplierId = await seedSupplier("Generalist");
    for (let i = 0; i < 3; i++) {
      const cat = await seedCategory(`Tower${i + 1}`, `TOWER-${i + 1}`);
      unbundleCategoryIds.push(cat);
      await seedContract(
        generalistSupplierId,
        cat,
        `UNB-${i + 1}`,
        UNBUNDLE_BASELINE,
      );
    }

    // Noop: a category with one supplier / one contract — too small
    // for either branch.
    noopSupplierId = await seedSupplier("Noop");
    noopCategoryId = await seedCategory("NoopCat", "NOOP");
    await seedContract(noopSupplierId, noopCategoryId, "NOOP-1", 100_000);
  });

  it("emits a rebundle draft anchored to the consulting category", async () => {
    const result = toAnalyzeResult(
      await unbundlingRebundlingLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const ours = result.drafts.find(
      (d) =>
        d.categoryId === rebundleCategoryId &&
        (d.inputs as { flavour?: string }).flavour === "rebundle",
    );
    assert.ok(ours, "expected a rebundle draft for the consulting category");
    assert.equal(ours.leverId, "unbundling_rebundling");
    assert.equal(ours.supplierId ?? null, null);
    assert.equal(ours.rawProjectedSavingsUsd, REBUNDLE_BASELINE * 3 * 0.05);
    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(Number(inputs["contractCount"]), 3);
    assert.equal(Number(inputs["supplierCount"]), 3);
    assert.equal(
      Number(inputs["combinedBaselineUsd"]),
      REBUNDLE_BASELINE * 3,
    );
  });

  it("emits an unbundle draft anchored to the generalist supplier", async () => {
    const result = toAnalyzeResult(
      await unbundlingRebundlingLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const ours = result.drafts.find(
      (d) =>
        d.supplierId === generalistSupplierId &&
        (d.inputs as { flavour?: string }).flavour === "unbundle",
    );
    assert.ok(ours, "expected an unbundle draft for the generalist supplier");
    assert.equal(ours.leverId, "unbundling_rebundling");
    assert.equal(ours.rawProjectedSavingsUsd, UNBUNDLE_BASELINE * 3 * 0.04);
    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(Number(inputs["contractCount"]), 3);
    assert.equal(Number(inputs["categoryCount"]), 3);
    assert.equal(
      Number(inputs["combinedBaselineUsd"]),
      UNBUNDLE_BASELINE * 3,
    );
  });

  it("does not emit drafts for the small noop category / supplier", async () => {
    const result = toAnalyzeResult(
      await unbundlingRebundlingLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const noopRebundle = result.drafts.find(
      (d) => d.categoryId === noopCategoryId,
    );
    assert.equal(
      noopRebundle,
      undefined,
      "noop category should not emit a rebundle draft",
    );
    const noopUnbundle = result.drafts.find(
      (d) => d.supplierId === noopSupplierId,
    );
    assert.equal(
      noopUnbundle,
      undefined,
      "noop supplier should not emit an unbundle draft",
    );
  });

  it("produces stable cohortKeys on re-runs (idempotent)", async () => {
    const first = toAnalyzeResult(
      await unbundlingRebundlingLever.analyze({
        orgId,
        cycleId: "test-cycle-1",
      }),
    );
    const second = toAnalyzeResult(
      await unbundlingRebundlingLever.analyze({
        orgId,
        cycleId: "test-cycle-2",
      }),
    );
    assert.equal(first.drafts.length, second.drafts.length);
    const keys1 = first.drafts
      .map((d) => unbundlingRebundlingLever.cohortKey!(d))
      .sort();
    const keys2 = second.drafts
      .map((d) => unbundlingRebundlingLever.cohortKey!(d))
      .sort();
    assert.deepEqual(keys2, keys1, "cohortKeys must be stable across re-runs");
    for (const k of keys1) {
      assert.ok(
        k === "rebundle" || k === "unbundle",
        `cohortKey contribution must be the flavour string; got ${k}`,
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
    if (orgId) {
      await safe(
        db
          .delete(contractsTable)
          .where(like(contractsTable.sourceExternalId, `${RUN}-%`)),
      );
      await safe(
        db
          .delete(categoriesTable)
          .where(like(categoriesTable.sourceExternalId, `${RUN}-%`)),
      );
      await safe(
        db
          .delete(suppliersTable)
          .where(like(suppliersTable.sourceExternalId, `${RUN}-%`)),
      );
      await safe(db.delete(orgsTable).where(eq(orgsTable.id, orgId)));
    }
  });
});
