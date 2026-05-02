/**
 * End-to-end spot check for the Tier-5 `sow_to_msa_conversion` lever
 * (#216).
 *
 * Seeds a supplier with 4 active SOW-style contracts (t_and_m,
 * fixed_price, milestone, retainer) — none with `msa_parent_id` set
 * and no goods contract on file. Asserts a draft is emitted sized at
 * 5% of the combined annual baseline.
 *
 * Also asserts the skip path: a supplier with a `goods` contract is
 * treated as already-MSA'd and produces no draft.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  contractsTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";

import { sowToMsaConversionLever } from "../src/lib/levers/services/sow-to-msa-conversion";
import { toAnalyzeResult } from "../src/lib/levers/types";

const RUN = `t216msa-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
let supplierId: string;
let coveredSupplierId: string;

const SOW_BASELINE = 100000;
const SOW_TYPES = ["t_and_m", "fixed_price", "milestone", "retainer"] as const;

describe("sow_to_msa_conversion Tier-5 lever (#216)", () => {
  before(async () => {
    orgId = newId("org");
    await db.insert(orgsTable).values({
      id: orgId,
      name: `${RUN} Test Org`,
      slug: `${RUN}-org`,
    });

    supplierId = newId("sup");
    await db.insert(suppliersTable).values({
      id: supplierId,
      orgId,
      name: `${RUN} Unhoused Co`,
      normalizedName: `${RUN} unhoused co`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sup`,
    });

    coveredSupplierId = newId("sup");
    await db.insert(suppliersTable).values({
      id: coveredSupplierId,
      orgId,
      name: `${RUN} Covered Co`,
      normalizedName: `${RUN} covered co`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sup-covered`,
    });

    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);

    // 4 SOW-style contracts, no MSA umbrella.
    for (const [i, type] of SOW_TYPES.entries()) {
      await db.insert(contractsTable).values({
        id: newId("con"),
        orgId,
        supplierId,
        contractNumber: `${RUN}-SOW-${i + 1}`,
        title: `${RUN} ${type} engagement ${i + 1}`,
        status: "active",
        contractType: type,
        startDate: today,
        endDate: inOneYear,
        annualBaselineUsd: String(SOW_BASELINE),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-con-${i}`,
      });
    }

    // Covered supplier: 3 SOW-style contracts + a goods MSA → should be skipped.
    await db.insert(contractsTable).values({
      id: newId("con"),
      orgId,
      supplierId: coveredSupplierId,
      contractNumber: `${RUN}-COV-MSA`,
      title: `${RUN} covered goods MSA`,
      status: "active",
      contractType: "goods",
      startDate: today,
      endDate: inOneYear,
      annualBaselineUsd: String(SOW_BASELINE),
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-con-cov-msa`,
    });
    for (let i = 0; i < 3; i++) {
      await db.insert(contractsTable).values({
        id: newId("con"),
        orgId,
        supplierId: coveredSupplierId,
        contractNumber: `${RUN}-COV-SOW-${i + 1}`,
        title: `${RUN} covered ${i + 1}`,
        status: "active",
        contractType: "fixed_price",
        startDate: today,
        endDate: inOneYear,
        annualBaselineUsd: String(SOW_BASELINE),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-con-cov-${i}`,
      });
    }
  });

  it("emits a draft for the unhoused supplier and skips the covered one", async () => {
    const result = toAnalyzeResult(
      await sowToMsaConversionLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const ours = result.drafts.find((d) => d.supplierId === supplierId);
    assert.ok(ours, `expected a draft for the unhoused supplier`);
    assert.equal(ours.leverId, "sow_to_msa_conversion");
    const expected = SOW_BASELINE * SOW_TYPES.length * 0.05;
    assert.equal(ours.rawProjectedSavingsUsd, expected);
    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(
      Number(inputs["unhousedContractCount"]),
      SOW_TYPES.length,
    );
    assert.equal(result.consultedSignalIds!.length, 0);

    const covered = result.drafts.find(
      (d) => d.supplierId === coveredSupplierId,
    );
    assert.equal(
      covered,
      undefined,
      "supplier with a goods MSA on file should be skipped",
    );
  });

  it("produces stable cohortKeys on re-runs (idempotent)", async () => {
    const first = toAnalyzeResult(
      await sowToMsaConversionLever.analyze({
        orgId,
        cycleId: "test-cycle-1",
      }),
    );
    const second = toAnalyzeResult(
      await sowToMsaConversionLever.analyze({
        orgId,
        cycleId: "test-cycle-2",
      }),
    );
    const ours1 = first.drafts.filter((d) => d.supplierId === supplierId);
    const ours2 = second.drafts.filter((d) => d.supplierId === supplierId);
    assert.ok(ours1.length > 0, "expected at least one draft on first run");
    assert.equal(ours1.length, ours2.length, "draft count should match");
    const keys1 = ours1
      .map((d) => sowToMsaConversionLever.cohortKey!(d))
      .sort();
    const keys2 = ours2
      .map((d) => sowToMsaConversionLever.cohortKey!(d))
      .sort();
    assert.deepEqual(keys2, keys1, "cohortKeys must be stable across re-runs");
    // Cohort identity for sow_to_msa_conversion is supplierId itself
    // (carried on draft.supplierId), so the lever-key contribution is
    // intentionally empty. Idempotency therefore comes from the
    // (leverId, supplierId, "") tuple — assert exactly one draft per
    // supplier on each re-run.
    const supplierIds1 = new Set(ours1.map((d) => d.supplierId));
    assert.equal(
      supplierIds1.size,
      ours1.length,
      "expected exactly one draft per supplier",
    );
    for (const k of keys1) {
      assert.equal(
        typeof k,
        "string",
        "cohortKey must be a string (may be empty)",
      );
    }
  });

  it("returns silently for an org with no contracts", async () => {
    const otherOrgId = newId("org");
    await db.insert(orgsTable).values({
      id: otherOrgId,
      name: `${RUN} Empty Org`,
      slug: `${RUN}-empty`,
    });
    try {
      const result = toAnalyzeResult(
        await sowToMsaConversionLever.analyze({
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
          .delete(contractsTable)
          .where(like(contractsTable.sourceExternalId, `${RUN}-%`)),
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
