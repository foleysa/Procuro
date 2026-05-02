/**
 * End-to-end spot check for the Tier-5 `hours_audit` lever (#216).
 *
 * Seeds an active SOW with $50k NTE that has burned $40k over the
 * trailing 30 days at $300/hr. With ~6 weeks remaining, projected
 * end-state blows past NTE. Asserts a burn_overrun draft is emitted.
 *
 * Also asserts the silent path: an org with no SOWs / time entries
 * emits nothing.
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

import { hoursAuditLever } from "../src/lib/levers/services/hours-audit";
import { toAnalyzeResult } from "../src/lib/levers/types";

const RUN = `t216hrs-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
let supplierId: string;
let contractId: string;
let sowId: string;

const NTE = 50000;
const RATE = 300;

describe("hours_audit Tier-5 lever (#216)", () => {
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
      name: `${RUN} Burn Co`,
      normalizedName: `${RUN} burn co`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sup`,
    });

    const today = new Date();
    const endDate = new Date(today.getTime() + 6 * 7 * 24 * 60 * 60 * 1000);
    contractId = newId("con");
    await db.insert(contractsTable).values({
      id: contractId,
      orgId,
      supplierId,
      contractNumber: `${RUN}-MSA`,
      title: `${RUN} MSA`,
      status: "active",
      contractType: "t_and_m",
      startDate: today,
      endDate,
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
      endDate,
      totalValueUsd: String(NTE),
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sow`,
    });

    // Burn $40k in trailing 30 days at $300/hr → ~133 hrs.
    const totalHours = 40000 / RATE;
    for (let i = 0; i < 5; i++) {
      const day = new Date(today.getTime() - i * 5 * 24 * 60 * 60 * 1000);
      await db.insert(timeEntriesTable).values({
        id: newId("te"),
        orgId,
        supplierId,
        contractId,
        sowId,
        resource: `${RUN}-resource-1`,
        role: "Software Engineer",
        workDate: day,
        hours: String(totalHours / 5),
        billRateUsd: String(RATE),
        amountUsd: String((totalHours / 5) * RATE),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-te-${i}`,
      });
    }
  });

  it("emits a burn_overrun draft when projected exceeds NTE", async () => {
    const result = toAnalyzeResult(
      await hoursAuditLever.analyze({ orgId, cycleId: "test-cycle" }),
    );
    const ours = result.drafts.find(
      (d) =>
        (d.inputs as { sowId?: string; flavor?: string }).sowId === sowId &&
        (d.inputs as { flavor?: string }).flavor === "burn_overrun",
    );
    assert.ok(ours, `expected a burn_overrun draft for the seeded SOW`);
    assert.equal(ours.leverId, "hours_audit");
    assert.equal(ours.supplierId, supplierId);
    assert.ok(
      (ours.rawProjectedSavingsUsd ?? 0) > 0,
      `expected positive overrun savings; got ${ours.rawProjectedSavingsUsd}`,
    );
    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(Number(inputs["nteUsd"]), NTE);
    assert.ok(
      Number(inputs["projectedAtCompletionUsd"]) > NTE,
      "projected end-state should exceed NTE",
    );
    assert.equal(result.consultedSignalIds!.length, 0);
  });

  it("produces stable cohortKeys on re-runs (idempotent)", async () => {
    const first = toAnalyzeResult(
      await hoursAuditLever.analyze({ orgId, cycleId: "test-cycle-1" }),
    );
    const second = toAnalyzeResult(
      await hoursAuditLever.analyze({ orgId, cycleId: "test-cycle-2" }),
    );
    const ours1 = first.drafts.filter(
      (d) => (d.inputs as { sowId?: string }).sowId === sowId,
    );
    const ours2 = second.drafts.filter(
      (d) => (d.inputs as { sowId?: string }).sowId === sowId,
    );
    assert.ok(ours1.length > 0, "expected at least one draft on first run");
    assert.equal(ours1.length, ours2.length, "draft count should match");
    const keys1 = ours1.map((d) => hoursAuditLever.cohortKey!(d)).sort();
    const keys2 = ours2.map((d) => hoursAuditLever.cohortKey!(d)).sort();
    assert.deepEqual(keys2, keys1, "cohortKeys must be stable across re-runs");
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

  it("returns silently for an org with no time entries", async () => {
    const otherOrgId = newId("org");
    await db.insert(orgsTable).values({
      id: otherOrgId,
      name: `${RUN} Empty Org`,
      slug: `${RUN}-empty`,
    });
    try {
      const result = toAnalyzeResult(
        await hoursAuditLever.analyze({
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
