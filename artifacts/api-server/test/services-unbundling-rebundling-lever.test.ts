/**
 * End-to-end spot check for the Tier-5 `unbundling_rebundling`
 * lever (#242).
 *
 * Two scenarios in one fixture:
 *
 *   1. **Rebundle.** Three suppliers each billing trailing-12 hours
 *      against the "Lawyers" SOC category (PROF_LEGAL) — combined
 *      spend $90k. Expect a single category-level draft sized at 7%
 *      with no `supplierId`.
 *   2. **Unbundle.** One supplier ("Generalist Co") billing across 5
 *      distinct mapped role categories with $300k combined spend
 *      (top-2 roles concentrated, bottom-3 long-tail). Expect a
 *      supplier-level draft sized at 5% of the long-tail spend.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  timeEntriesTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";

import { unbundlingRebundlingLever } from "../src/lib/levers/services/unbundling-rebundling";
import { toAnalyzeResult } from "../src/lib/levers/types";

const RUN = `t242ub-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
const lawyerSupplierIds: string[] = [];
let generalistSupplierId: string;

const REBUNDLE_PER_SUPPLIER = 30_000; // x3 = $90k → above $25k threshold
const UNBUNDLE_TOP_ROLE_SPEND = 100_000; // top-2 = $200k
const UNBUNDLE_TAIL_ROLE_SPEND = 33_500; // bottom-3 = $100.5k → floor satisfied

// Roles chosen so that mapRoleToScopeCategory produces 5 distinct
// categories — all DISJOINT from the rebundle scenario's PROF_LEGAL
// bucket so the two test fixtures don't cross-contaminate each
// other's spend totals.
const UNBUNDLE_ROLES: Array<{ role: string; spend: number }> = [
  { role: "Senior Recruiter", spend: UNBUNDLE_TOP_ROLE_SPEND },
  { role: "Tax Manager", spend: UNBUNDLE_TOP_ROLE_SPEND },
  { role: "Management Consultant", spend: UNBUNDLE_TAIL_ROLE_SPEND },
  { role: "Senior Software Engineer", spend: UNBUNDLE_TAIL_ROLE_SPEND },
  { role: "Mechanical Engineer", spend: UNBUNDLE_TAIL_ROLE_SPEND },
];

describe("unbundling_rebundling Tier-5 lever (#242)", () => {
  before(async () => {
    orgId = newId("org");
    await db.insert(orgsTable).values({
      id: orgId,
      name: `${RUN} Test Org`,
      slug: `${RUN}-org`,
    });

    const today = new Date();
    const recent = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);

    // Rebundle scenario: 3 suppliers all billing the same role.
    for (let i = 0; i < 3; i++) {
      const supId = newId("sup");
      lawyerSupplierIds.push(supId);
      await db.insert(suppliersTable).values({
        id: supId,
        orgId,
        name: `${RUN} Law Firm ${i + 1}`,
        normalizedName: `${RUN} law firm ${i + 1}`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-law-${i}`,
      });
      await db.insert(timeEntriesTable).values({
        id: newId("te"),
        orgId,
        supplierId: supId,
        resource: `${RUN} attorney ${i + 1}`,
        role: "Lawyer",
        seniority: "Partner",
        workDate: recent,
        hours: "60",
        billRateUsd: "500",
        amountUsd: String(REBUNDLE_PER_SUPPLIER),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-te-law-${i}`,
      });
    }

    // Unbundle scenario: one supplier across 5 distinct roles.
    generalistSupplierId = newId("sup");
    await db.insert(suppliersTable).values({
      id: generalistSupplierId,
      orgId,
      name: `${RUN} Generalist Co`,
      normalizedName: `${RUN} generalist co`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-gen`,
    });
    for (const [i, { role, spend }] of UNBUNDLE_ROLES.entries()) {
      await db.insert(timeEntriesTable).values({
        id: newId("te"),
        orgId,
        supplierId: generalistSupplierId,
        resource: `${RUN} resource ${i + 1}`,
        role,
        seniority: "Senior",
        workDate: recent,
        hours: "100",
        billRateUsd: "200",
        amountUsd: String(spend),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-te-gen-${i}`,
      });
    }
  });

  it("emits a category-level rebundle draft when 3+ suppliers cover the same role", async () => {
    const result = toAnalyzeResult(
      await unbundlingRebundlingLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const rebundle = result.drafts.find(
      (d) =>
        (d.inputs as Record<string, unknown>)["flavor"] === "rebundle" &&
        (d.inputs as Record<string, unknown>)["scopeCategoryCode"] ===
          "PROF_LEGAL",
    );
    assert.ok(rebundle, "expected a rebundle draft for PROF_LEGAL");
    assert.equal(rebundle.leverId, "unbundling_rebundling");
    assert.equal(
      rebundle.supplierId,
      null,
      "rebundle drafts are category-level (no supplierId)",
    );
    const totalSpend = REBUNDLE_PER_SUPPLIER * 3;
    // Round to cents to dodge FP noise from `n * 0.07`.
    assert.equal(
      rebundle.rawProjectedSavingsUsd,
      Math.round(totalSpend * 0.07 * 100) / 100,
    );
    const inputs = rebundle.inputs as Record<string, unknown>;
    assert.equal(Number(inputs["supplierCount"]), 3);
    assert.equal(Number(inputs["totalSpend12moUsd"]), totalSpend);
    assert.equal(result.consultedSignalIds!.length, 0);
  });

  it("emits an unbundle draft when one supplier covers 5+ role categories", async () => {
    const result = toAnalyzeResult(
      await unbundlingRebundlingLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const unbundle = result.drafts.find(
      (d) =>
        (d.inputs as Record<string, unknown>)["flavor"] === "unbundle" &&
        d.supplierId === generalistSupplierId,
    );
    assert.ok(
      unbundle,
      "expected an unbundle draft for the generalist supplier",
    );
    const inputs = unbundle.inputs as Record<string, unknown>;
    assert.ok(
      Number(inputs["distinctRoleCategoryCount"]) >= 5,
      `expected >=5 distinct role categories, got ${inputs["distinctRoleCategoryCount"]}`,
    );
    const tailSpend = Number(inputs["longTailSpendUsd"]);
    assert.ok(tailSpend > 0, "long-tail spend must be > 0");
    // tailStart = ceil(5/2) = 3, so the long-tail is the bottom-2
    // roles by spend = 2 × $33,500 = $67,000.
    const expectedTail = UNBUNDLE_TAIL_ROLE_SPEND * 2;
    assert.equal(tailSpend, expectedTail);
    assert.equal(
      unbundle.rawProjectedSavingsUsd,
      Math.round(expectedTail * 0.05 * 100) / 100,
    );
  });

  it("produces stable cohortKeys for both flavours (idempotent)", async () => {
    const first = toAnalyzeResult(
      await unbundlingRebundlingLever.analyze({
        orgId,
        cycleId: "c1",
      }),
    );
    const second = toAnalyzeResult(
      await unbundlingRebundlingLever.analyze({
        orgId,
        cycleId: "c2",
      }),
    );
    const keys1 = first.drafts
      .map((d) => unbundlingRebundlingLever.cohortKey!(d))
      .sort();
    const keys2 = second.drafts
      .map((d) => unbundlingRebundlingLever.cohortKey!(d))
      .sort();
    assert.deepEqual(keys2, keys1, "cohortKeys must be stable across re-runs");
    // Rebundle key carries the category code; unbundle is the bare
    // discriminator (supplierId is on draft.supplierId).
    assert.ok(
      keys1.some((k) => k.startsWith("rebundle:PROF_LEGAL")),
      "expected a rebundle:PROF_LEGAL cohort key",
    );
    assert.ok(
      keys1.some((k) => k === "unbundle"),
      "expected an unbundle cohort key",
    );
  });

  it("returns silently for an org with no time entries", async () => {
    const otherOrgId = newId("org");
    await db.insert(orgsTable).values({
      id: otherOrgId,
      name: `${RUN} Empty Org`,
      slug: `${RUN}-empty`,
    });
    try {
      const result = toAnalyzeResult(
        await unbundlingRebundlingLever.analyze({
          orgId: otherOrgId,
          cycleId: "test-cycle",
        }),
      );
      assert.equal(result.drafts.length, 0);
    } finally {
      await db.delete(orgsTable).where(eq(orgsTable.id, otherOrgId));
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
          .delete(timeEntriesTable)
          .where(like(timeEntriesTable.sourceExternalId, `${RUN}-%`)),
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
