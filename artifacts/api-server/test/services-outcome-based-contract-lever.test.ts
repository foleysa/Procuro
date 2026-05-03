/**
 * End-to-end spot check for the Tier-5 `outcome_based_contract`
 * lever (#234).
 *
 * Seeds:
 *   - One eligible supplier with an active `t_and_m` contract,
 *     $400k annual baseline, and 6 months of stable monthly time-
 *     entry burn (~$30k/mo, low coefficient of variation). Asserts a
 *     single draft sized at 8% of baseline.
 *   - One ineligible supplier with the same baseline but volatile
 *     burn (alternating $5k / $50k months). Asserts the lever skips
 *     it because CoV exceeds the threshold.
 *   - One ineligible contract that is already `outcome`-typed.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  contractsTable,
  timeEntriesTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";

import { outcomeBasedContractLever } from "../src/lib/levers/services/outcome-based-contract";
import { toAnalyzeResult } from "../src/lib/levers/types";

const RUN = `t234obc-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";
const BASELINE = 400_000;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
let stableSupplierId: string;
let stableContractId: string;
let volatileSupplierId: string;
let volatileContractId: string;
let alreadyOutcomeSupplierId: string;
let alreadyOutcomeContractId: string;

describe("outcome_based_contract Tier-5 lever (#234)", () => {
  before(async () => {
    orgId = newId("org");
    await db.insert(orgsTable).values({
      id: orgId,
      name: `${RUN} Test Org`,
      slug: `${RUN}-org`,
    });

    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);

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
      label: string,
      contractType: "t_and_m" | "outcome",
    ) => {
      const id = newId("con");
      await db.insert(contractsTable).values({
        id,
        orgId,
        supplierId,
        contractNumber: `${RUN}-${label}`,
        title: `${RUN} ${label} engagement`,
        status: "active",
        contractType,
        startDate: today,
        endDate: inOneYear,
        annualBaselineUsd: String(BASELINE),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-con-${label}`,
      });
      return id;
    };

    stableSupplierId = await seedSupplier("Stable");
    stableContractId = await seedContract(stableSupplierId, "STABLE", "t_and_m");
    volatileSupplierId = await seedSupplier("Volatile");
    volatileContractId = await seedContract(
      volatileSupplierId,
      "VOLATILE",
      "t_and_m",
    );
    alreadyOutcomeSupplierId = await seedSupplier("AlreadyOutcome");
    alreadyOutcomeContractId = await seedContract(
      alreadyOutcomeSupplierId,
      "OUTCOME",
      "outcome",
    );

    // Seed monthly time entries spanning the trailing ~6 months.
    // Stable contract: ~$30k/mo with ±5% jitter (low CoV).
    // Volatile contract: alternating $5k / $55k (high CoV).
    // Already-outcome contract: $30k/mo (should still be skipped on
    // type filter, not on cadence).
    for (let monthOffset = 0; monthOffset < 6; monthOffset++) {
      const day = new Date(today.getTime());
      day.setMonth(day.getMonth() - monthOffset);
      day.setDate(15);
      const stableSpend = 30_000 + (monthOffset % 2 === 0 ? 1_000 : -1_000);
      const volatileSpend = monthOffset % 2 === 0 ? 5_000 : 55_000;
      const outcomeSpend = 30_000;

      const insertEntry = async (
        supplierId: string,
        contractId: string,
        amount: number,
        label: string,
      ) => {
        await db.insert(timeEntriesTable).values({
          id: newId("te"),
          orgId,
          supplierId,
          contractId,
          resource: `${RUN} consultant`,
          role: "Consultant",
          seniority: "Senior",
          workDate: day,
          hours: String(amount / 150),
          billRateUsd: "150",
          amountUsd: String(amount),
          sourceSystem: SOURCE,
          sourceExternalId: `${RUN}-te-${label}-${monthOffset}`,
        });
      };
      await insertEntry(
        stableSupplierId,
        stableContractId,
        stableSpend,
        "stable",
      );
      await insertEntry(
        volatileSupplierId,
        volatileContractId,
        volatileSpend,
        "volatile",
      );
      await insertEntry(
        alreadyOutcomeSupplierId,
        alreadyOutcomeContractId,
        outcomeSpend,
        "outcome",
      );
    }
  });

  it("emits a draft for the stable engagement sized at 8% of baseline", async () => {
    const result = toAnalyzeResult(
      await outcomeBasedContractLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const ours = result.drafts.find((d) => d.supplierId === stableSupplierId);
    assert.ok(ours, "expected a draft for the stable supplier");
    assert.equal(ours.leverId, "outcome_based_contract");
    assert.equal(ours.rawProjectedSavingsUsd, BASELINE * 0.08);
    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(inputs["contractId"], stableContractId);
    assert.equal(Number(inputs["annualBaselineUsd"]), BASELINE);
    assert.ok(
      Number(inputs["coefficientOfVariation"]) < 0.35,
      `CoV should be under threshold; got ${inputs["coefficientOfVariation"]}`,
    );
    assert.equal(result.consultedSignalIds!.length, 0);
  });

  it("skips volatile and already-outcome contracts", async () => {
    const result = toAnalyzeResult(
      await outcomeBasedContractLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const volatile = result.drafts.find(
      (d) => d.supplierId === volatileSupplierId,
    );
    assert.equal(
      volatile,
      undefined,
      "volatile burn cadence should not produce a draft",
    );
    const outcomeAlready = result.drafts.find(
      (d) => d.supplierId === alreadyOutcomeSupplierId,
    );
    assert.equal(
      outcomeAlready,
      undefined,
      "contracts already typed as outcome should be skipped",
    );
  });

  it("produces stable cohortKeys on re-runs (idempotent)", async () => {
    const first = toAnalyzeResult(
      await outcomeBasedContractLever.analyze({
        orgId,
        cycleId: "test-cycle-1",
      }),
    );
    const second = toAnalyzeResult(
      await outcomeBasedContractLever.analyze({
        orgId,
        cycleId: "test-cycle-2",
      }),
    );
    const ours1 = first.drafts.filter((d) => d.supplierId === stableSupplierId);
    const ours2 = second.drafts.filter((d) => d.supplierId === stableSupplierId);
    assert.ok(ours1.length > 0, "expected at least one draft on first run");
    assert.equal(ours1.length, ours2.length, "draft count should match");
    const keys1 = ours1
      .map((d) => outcomeBasedContractLever.cohortKey!(d))
      .sort();
    const keys2 = ours2
      .map((d) => outcomeBasedContractLever.cohortKey!(d))
      .sort();
    assert.deepEqual(keys2, keys1, "cohortKeys must be stable across re-runs");
    for (const k of keys1) {
      assert.ok(
        typeof k === "string" && k.includes(stableContractId),
        `cohortKey should reference the contract id; got ${k}`,
      );
    }
  });

  it("returns silently for an org with no eligible contracts", async () => {
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
