/**
 * End-to-end spot check for the Tier-5 `outcome_based_contract`
 * lever (#242).
 *
 * Seeds an active T&M contract with a $200k annual baseline plus 3
 * completed SOWs (sow-cadence trigger). Asserts a draft is emitted
 * sized at 10% of the baseline and that the unrelated retainer
 * contract with no cadence evidence is skipped.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  contractsTable,
  statementsOfWorkTable,
  timeEntriesTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";

import { outcomeBasedContractLever } from "../src/lib/levers/services/outcome-based-contract";
import { toAnalyzeResult } from "../src/lib/levers/types";

const RUN = `t242obc-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
let supplierId: string;
let contractId: string;
let smallContractId: string;
let tenureContractId: string;
let tenureSupplierId: string;

const BASELINE = 200_000;
const SMALL_BASELINE = 10_000;

describe("outcome_based_contract Tier-5 lever (#242)", () => {
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
      name: `${RUN} Stable Supplier`,
      normalizedName: `${RUN} stable supplier`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sup`,
    });
    tenureSupplierId = newId("sup");
    await db.insert(suppliersTable).values({
      id: tenureSupplierId,
      orgId,
      name: `${RUN} Tenure Supplier`,
      normalizedName: `${RUN} tenure supplier`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sup-tenure`,
    });

    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);

    // Eligible T&M contract with 3 SOWs (sow-cadence trigger).
    contractId = newId("con");
    await db.insert(contractsTable).values({
      id: contractId,
      orgId,
      supplierId,
      contractNumber: `${RUN}-TM-MSA`,
      title: `${RUN} stable T&M MSA`,
      status: "active",
      contractType: "t_and_m",
      startDate: today,
      endDate: inOneYear,
      annualBaselineUsd: String(BASELINE),
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-con-tm`,
    });
    for (let i = 0; i < 3; i++) {
      await db.insert(statementsOfWorkTable).values({
        id: newId("sow"),
        orgId,
        contractId,
        supplierId,
        sowNumber: `${RUN}-SOW-${i + 1}`,
        title: `${RUN} sow ${i + 1}`,
        status: i === 0 ? "active" : "completed",
        startDate: today,
        endDate: inOneYear,
        totalValueUsd: String(BASELINE / 3),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-sow-${i}`,
      });
    }

    // Tenure-trigger T&M contract: no SOWs, but >9mo of time entries.
    tenureContractId = newId("con");
    await db.insert(contractsTable).values({
      id: tenureContractId,
      orgId,
      supplierId: tenureSupplierId,
      contractNumber: `${RUN}-TM-TENURE`,
      title: `${RUN} tenure T&M`,
      status: "active",
      contractType: "t_and_m",
      startDate: new Date(today.getTime() - 400 * 24 * 60 * 60 * 1000),
      endDate: inOneYear,
      annualBaselineUsd: String(BASELINE),
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-con-tenure`,
    });
    // Two entries spanning ~300 days.
    for (const [i, daysAgo] of [310, 5].entries()) {
      await db.insert(timeEntriesTable).values({
        id: newId("te"),
        orgId,
        supplierId: tenureSupplierId,
        contractId: tenureContractId,
        resource: `${RUN} consultant`,
        role: "Consultant",
        seniority: "Senior",
        workDate: new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000),
        hours: "40",
        billRateUsd: "150",
        amountUsd: "6000",
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-te-tenure-${i}`,
      });
    }

    // Small T&M contract with cadence but baseline below floor → skip.
    smallContractId = newId("con");
    await db.insert(contractsTable).values({
      id: smallContractId,
      orgId,
      supplierId,
      contractNumber: `${RUN}-TM-SMALL`,
      title: `${RUN} small T&M`,
      status: "active",
      contractType: "t_and_m",
      startDate: today,
      endDate: inOneYear,
      annualBaselineUsd: String(SMALL_BASELINE),
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-con-small`,
    });
    for (let i = 0; i < 3; i++) {
      await db.insert(statementsOfWorkTable).values({
        id: newId("sow"),
        orgId,
        contractId: smallContractId,
        supplierId,
        sowNumber: `${RUN}-SOW-SMALL-${i + 1}`,
        title: `${RUN} small sow ${i + 1}`,
        status: "completed",
        startDate: today,
        endDate: inOneYear,
        totalValueUsd: String(SMALL_BASELINE / 3),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-sow-small-${i}`,
      });
    }

    // Already-outcome contract → must be skipped even with cadence.
    await db.insert(contractsTable).values({
      id: newId("con"),
      orgId,
      supplierId,
      contractNumber: `${RUN}-OUTCOME`,
      title: `${RUN} already outcome`,
      status: "active",
      contractType: "outcome",
      startDate: today,
      endDate: inOneYear,
      annualBaselineUsd: String(BASELINE),
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-con-outcome`,
    });
  });

  it("emits a draft for the eligible T&M contract sized at the 10% uplift", async () => {
    const result = toAnalyzeResult(
      await outcomeBasedContractLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const ours = result.drafts.find(
      (d) => (d.inputs as { contractId?: string }).contractId === contractId,
    );
    assert.ok(ours, "expected a draft for the eligible T&M contract");
    assert.equal(ours.leverId, "outcome_based_contract");
    assert.equal(ours.supplierId, supplierId);
    assert.equal(ours.rawProjectedSavingsUsd, BASELINE * 0.1);
    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(Number(inputs["annualBaselineUsd"]), BASELINE);
    assert.equal(Number(inputs["sowCount"]), 3);
    assert.equal(inputs["triggerKind"], "sow_cadence");
    assert.equal(result.consultedSignalIds!.length, 0);

    // Tenure-trigger contract should also fire.
    const tenure = result.drafts.find(
      (d) =>
        (d.inputs as { contractId?: string }).contractId === tenureContractId,
    );
    assert.ok(tenure, "expected a draft for the tenure-trigger T&M contract");
    assert.equal(
      (tenure.inputs as Record<string, unknown>)["triggerKind"],
      "engagement_tenure",
    );

    // Small-baseline contract should be skipped.
    const small = result.drafts.find(
      (d) =>
        (d.inputs as { contractId?: string }).contractId === smallContractId,
    );
    assert.equal(
      small,
      undefined,
      "contract under the baseline floor must be skipped",
    );

    // No draft for the outcome-typed contract.
    for (const d of result.drafts) {
      assert.notEqual(
        (d.inputs as Record<string, unknown>)["contractType"],
        "outcome",
        "already-outcome contracts must never produce a draft",
      );
    }
  });

  it("produces stable cohortKeys keyed on contractId (idempotent)", async () => {
    const first = toAnalyzeResult(
      await outcomeBasedContractLever.analyze({
        orgId,
        cycleId: "c1",
      }),
    );
    const second = toAnalyzeResult(
      await outcomeBasedContractLever.analyze({
        orgId,
        cycleId: "c2",
      }),
    );
    const keys1 = first.drafts
      .map((d) => outcomeBasedContractLever.cohortKey!(d))
      .sort();
    const keys2 = second.drafts
      .map((d) => outcomeBasedContractLever.cohortKey!(d))
      .sort();
    assert.deepEqual(keys2, keys1, "cohortKeys must be stable");
    for (const k of keys1) {
      assert.ok(k.length > 0, "cohortKey must be non-empty (contractId)");
    }
    assert.equal(
      new Set(keys1).size,
      keys1.length,
      "expected one cohort per eligible contract",
    );
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
        await outcomeBasedContractLever.analyze({
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
          .delete(statementsOfWorkTable)
          .where(like(statementsOfWorkTable.sourceExternalId, `${RUN}-%`)),
      );
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
