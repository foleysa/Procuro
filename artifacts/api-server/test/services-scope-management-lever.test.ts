/**
 * End-to-end spot check for the Tier-5 `scope_management` lever (#216).
 *
 * Seeds an active SOW with $100k NTE plus 4 approved change orders
 * worth $40k → 40% over original (both triggers fire). Asserts a
 * single draft is emitted with the dollar-overrun trigger preferred,
 * and that the change-order count is included in `inputs`.
 *
 * Also asserts the silent path: an org with no SOWs at all emits
 * nothing.
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
  sowChangeOrdersTable,
  timeEntriesTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";

import { scopeManagementLever } from "../src/lib/levers/services/scope-management";
import { toAnalyzeResult } from "../src/lib/levers/types";

const RUN = `t216scp-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
let supplierId: string;
let contractId: string;
let sowId: string;

const NTE = 100000;
const CHANGE_ORDER_VALUE = 10000;
const CHANGE_ORDER_COUNT = 4;

describe("scope_management Tier-5 lever (#216)", () => {
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
      name: `${RUN} Engagement Partner`,
      normalizedName: `${RUN} engagement partner`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sup`,
    });

    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);
    contractId = newId("con");
    await db.insert(contractsTable).values({
      id: contractId,
      orgId,
      supplierId,
      contractNumber: `${RUN}-MSA`,
      title: `${RUN} parent MSA`,
      status: "active",
      contractType: "t_and_m",
      startDate: today,
      endDate: inOneYear,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-con`,
    });

    sowId = newId("sow");
    await db.insert(statementsOfWorkTable).values({
      id: sowId,
      orgId,
      contractId,
      supplierId,
      sowNumber: `${RUN}-SOW-001`,
      title: `${RUN} engagement`,
      status: "active",
      startDate: today,
      endDate: inOneYear,
      totalValueUsd: String(NTE),
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sow`,
    });

    for (let i = 0; i < CHANGE_ORDER_COUNT; i++) {
      await db.insert(sowChangeOrdersTable).values({
        id: newId("co"),
        orgId,
        sowId,
        changeOrderNumber: `CO-${i + 1}`,
        title: `${RUN} change order ${i + 1}`,
        status: "approved",
        valueDeltaUsd: String(CHANGE_ORDER_VALUE),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-co-${i}`,
      });
    }
  });

  it("includes a runway × burn forward projection in the sized savings", async () => {
    // Seed a second SOW that fires the dollar trigger AND has a
    // measurable trailing-30 burn so the forward-projection branch is
    // exercised. SOW: $50k NTE + $10k approved CO (1.20× over), ends
    // in 60 days, $9k of time entries logged in the trailing 30 days.
    const projOrgId = newId("org");
    await db.insert(orgsTable).values({
      id: projOrgId,
      name: `${RUN} Proj Org`,
      slug: `${RUN}-proj`,
    });
    const projSupplierId = newId("sup");
    await db.insert(suppliersTable).values({
      id: projSupplierId,
      orgId: projOrgId,
      name: `${RUN} proj supplier`,
      normalizedName: `${RUN} proj supplier`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-proj-sup`,
    });
    const today = new Date();
    const in60Days = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
    const projContractId = newId("con");
    await db.insert(contractsTable).values({
      id: projContractId,
      orgId: projOrgId,
      supplierId: projSupplierId,
      contractNumber: `${RUN}-PROJ-MSA`,
      title: `${RUN} proj MSA`,
      status: "active",
      contractType: "t_and_m",
      startDate: today,
      endDate: in60Days,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-proj-con`,
    });
    const projSowId = newId("sow");
    await db.insert(statementsOfWorkTable).values({
      id: projSowId,
      orgId: projOrgId,
      contractId: projContractId,
      supplierId: projSupplierId,
      sowNumber: `${RUN}-PROJ-SOW-001`,
      title: `${RUN} proj engagement`,
      status: "active",
      startDate: today,
      endDate: in60Days,
      totalValueUsd: "50000",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-proj-sow`,
    });
    await db.insert(sowChangeOrdersTable).values({
      id: newId("co"),
      orgId: projOrgId,
      sowId: projSowId,
      changeOrderNumber: "CO-1",
      title: `${RUN} proj CO 1`,
      status: "approved",
      valueDeltaUsd: "10000",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-proj-co`,
    });
    // 3 time entries totalling $9k inside the 30-day window.
    for (let i = 0; i < 3; i++) {
      const day = new Date(today.getTime() - (i * 7 + 1) * 24 * 60 * 60 * 1000);
      await db.insert(timeEntriesTable).values({
        id: newId("te"),
        orgId: projOrgId,
        supplierId: projSupplierId,
        sowId: projSowId,
        contractId: projContractId,
        resource: `${RUN} consultant`,
        role: "Consultant",
        seniority: "Senior",
        workDate: day,
        hours: "20",
        billRateUsd: "150",
        amountUsd: "3000",
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-proj-te-${i}`,
      });
    }
    try {
      const result = toAnalyzeResult(
        await scopeManagementLever.analyze({
          orgId: projOrgId,
          cycleId: "test-cycle",
        }),
      );
      const ours = result.drafts.find(
        (d) => (d.inputs as { sowId?: string }).sowId === projSowId,
      );
      assert.ok(ours, "expected a draft for the projection-test SOW");
      const inputs = ours.inputs as Record<string, unknown>;
      assert.ok(
        Number(inputs["burn30dUsd"]) >= 9000 - 0.01,
        `burn30dUsd should reflect ~$9k, got ${inputs["burn30dUsd"]}`,
      );
      const burnPerDay = Number(inputs["burnPerDayUsd"]);
      assert.ok(burnPerDay > 0, "burnPerDayUsd should be > 0");
      const projected = Number(inputs["projectedRemainingSpendUsd"]);
      assert.ok(
        projected > 0,
        "projectedRemainingSpendUsd must be > 0 when burn>0 and runway>0",
      );
      // Sized savings = currentOverrun ($10k) + forward projection.
      // With ~$300/day burn × ~60 days remaining ≈ $18k forward,
      // total ≈ $28k. Assert the savings strictly exceed the
      // overrun-only number by at least the projection.
      assert.ok(
        ours.rawProjectedSavingsUsd >= 10000 + projected - 0.01,
        `savings (${ours.rawProjectedSavingsUsd}) should equal overrun + projection (${10000 + projected})`,
      );
    } finally {
      await db
        .delete(timeEntriesTable)
        .where(like(timeEntriesTable.sourceExternalId, `${RUN}-proj-%`));
      await db
        .delete(sowChangeOrdersTable)
        .where(like(sowChangeOrdersTable.sourceExternalId, `${RUN}-proj-%`));
      await db
        .delete(statementsOfWorkTable)
        .where(like(statementsOfWorkTable.sourceExternalId, `${RUN}-proj-%`));
      await db
        .delete(contractsTable)
        .where(like(contractsTable.sourceExternalId, `${RUN}-proj-%`));
      await db
        .delete(suppliersTable)
        .where(like(suppliersTable.sourceExternalId, `${RUN}-proj-%`));
      await db.delete(orgsTable).where(eq(orgsTable.id, projOrgId));
    }
  });

  it("emits a draft with overrun-sized savings", async () => {
    const result = toAnalyzeResult(
      await scopeManagementLever.analyze({ orgId, cycleId: "test-cycle" }),
    );
    const ours = result.drafts.find(
      (d) => (d.inputs as { sowId?: string }).sowId === sowId,
    );
    assert.ok(ours, `expected a draft for the seeded SOW`);
    assert.equal(ours.leverId, "scope_management");
    assert.equal(ours.supplierId, supplierId);

    const expectedOverrun = CHANGE_ORDER_VALUE * CHANGE_ORDER_COUNT;
    assert.equal(ours.rawProjectedSavingsUsd, expectedOverrun);

    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(Number(inputs["nteUsd"]), NTE);
    assert.equal(
      Number(inputs["committedValueUsd"]),
      NTE + expectedOverrun,
    );
    assert.equal(
      Number(inputs["changeOrderCount"]),
      CHANGE_ORDER_COUNT,
    );
    assert.equal(inputs["triggerKind"], "dollar_overrun");
    assert.equal(result.consultedSignalIds!.length, 0);
  });

  it("produces stable cohortKeys on re-runs (idempotent)", async () => {
    const first = toAnalyzeResult(
      await scopeManagementLever.analyze({ orgId, cycleId: "test-cycle-1" }),
    );
    const second = toAnalyzeResult(
      await scopeManagementLever.analyze({ orgId, cycleId: "test-cycle-2" }),
    );
    const ours1 = first.drafts.filter((d) => d.supplierId === supplierId);
    const ours2 = second.drafts.filter((d) => d.supplierId === supplierId);
    assert.ok(ours1.length > 0, "expected at least one draft on first run");
    assert.equal(ours1.length, ours2.length, "draft count should match");
    const keys1 = ours1.map((d) => scopeManagementLever.cohortKey!(d)).sort();
    const keys2 = ours2.map((d) => scopeManagementLever.cohortKey!(d)).sort();
    assert.deepEqual(keys2, keys1, "cohortKeys must be stable across re-runs");
    // Cohort key for scope_management is keyed on sowId so the same
    // SOW is collapsed to a single cohort entry per re-run.
    for (const k of keys1) {
      assert.ok(
        typeof k === "string" && k.length > 0,
        "cohortKey must be set",
      );
      assert.ok(
        k.includes(sowId),
        `cohortKey should reference the SOW id; got ${k}`,
      );
    }
  });

  it("returns silently for an org with no active SOWs", async () => {
    const otherOrgId = newId("org");
    await db.insert(orgsTable).values({
      id: otherOrgId,
      name: `${RUN} Empty Org`,
      slug: `${RUN}-empty`,
    });
    try {
      const result = toAnalyzeResult(
        await scopeManagementLever.analyze({
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
          .delete(sowChangeOrdersTable)
          .where(like(sowChangeOrdersTable.sourceExternalId, `${RUN}-%`)),
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
