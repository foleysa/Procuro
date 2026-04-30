/**
 * Per-lever readiness-rule integration tests.
 *
 * The unit suite (`readiness-engine-unit.test.ts`) pins the score
 * arithmetic; this suite pins the actual SQL each rule emits against a
 * realistic-but-tiny fixture so a refactor that changes a column name
 * or predicate gets caught.
 *
 * For each lever exercised here we assert two states:
 *   1. Empty org — the lever's "table missing rows" hard blocker fires
 *      and the score collapses to 0.
 *   2. Seeded org — once the relevant rows exist, the hard blocker
 *      clears and the score climbs above 0 (or to 100 if no soft
 *      blockers remain).
 *
 * The fixture deliberately lives under one synthetic tenant so the
 * cleanup in `after()` can scope a single delete-by-org-id pass.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env["DATABASE_URL"]) {
  throw new Error("DATABASE_URL is required for the per-lever readiness suite");
}

import {
  db,
  orgsTable,
  contractsTable,
  invoicesTable,
  paymentsTable,
  poLinesTable,
  purchaseOrdersTable,
  suppliersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const { getReadinessRules } = await import("../src/lib/readiness/rules");
const { computeReadiness } = await import("../src/lib/readiness/index");

const RUN = `t122l-${randomUUID().slice(0, 8)}`;
const ORG_ID = `org-${RUN}`;

async function readReport() {
  return computeReadiness({ orgId: ORG_ID });
}

function leverFor(report: Awaited<ReturnType<typeof computeReadiness>>, id: string) {
  const lever = report.levers.find((l) => l.leverId === id);
  if (!lever) {
    throw new Error(`expected lever ${id} in report; saw ${report.levers.map((l) => l.leverId).join(",")}`);
  }
  return lever;
}

describe("readiness rules — per-lever behaviour against seeded data", () => {
  before(async () => {
    await db.insert(orgsTable).values({
      id: ORG_ID,
      name: `${RUN} Lever Org`,
      slug: `${RUN}-lever-org`,
    });
  });

  after(async () => {
    const safe = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* swallow — tear-down is best-effort */
      }
    };
    await safe(db.delete(paymentsTable).where(eq(paymentsTable.orgId, ORG_ID)));
    await safe(db.delete(invoicesTable).where(eq(invoicesTable.orgId, ORG_ID)));
    await safe(db.delete(poLinesTable).where(eq(poLinesTable.orgId, ORG_ID)));
    await safe(
      db
        .delete(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.orgId, ORG_ID)),
    );
    await safe(
      db.delete(contractsTable).where(eq(contractsTable.orgId, ORG_ID)),
    );
    await safe(
      db.delete(suppliersTable).where(eq(suppliersTable.orgId, ORG_ID)),
    );
    await safe(db.delete(orgsTable).where(eq(orgsTable.id, ORG_ID)));
  });

  it("rule registry surfaces all 12 levers", () => {
    const rules = getReadinessRules();
    assert.equal(rules.length, 12, `expected 12 rules, saw ${rules.length}`);
  });

  it("blocker fixUrls carry the matching ?missing= deep-link param", async () => {
    // The data-readiness card builds "Fix this" links from `fixUrl`, and
    // the suppliers/contracts/ingest pages pre-filter by the param. If a
    // rule drops the param the card silently regresses to landing on the
    // top of an unfiltered list, so pin the contract here.
    const report = await readReport();

    // Each entry is [blockerId, expected `?missing=…` substring]. We
    // intentionally pin the substring (not `endsWith`) so adding extra
    // query params later doesn't spuriously break this test.
    //
    // Three field-check blockers are intentionally omitted because they
    // use `hardWhenEmpty: false` and don't fire on an empty org:
    // `po_lines.item_id`, `contracts.owner`, and
    // `purchase_orders.contract_id` (the last is also covered by the
    // "no missing= param" assertion below).
    const expectations: Array<[string, string]> = [
      ["po_lines.sku", "/ingest?missing=sku"],
      ["contracts.annual_baseline_usd", "/contracts?missing=annual_baseline_usd"],
      ["invoices.dedup_key", "/ingest?missing=dedup_key"],
      ["purchase_orders.exists", "/ingest?missing=purchase_orders"],
      ["suppliers.payment_terms_days", "/suppliers?missing=payment_terms_days"],
      ["payments.exists", "/ingest?missing=payments"],
      ["po_lines.category_id", "/ingest?missing=category_id"],
      ["suppliers.billing_currency", "/suppliers?missing=billing_currency"],
      ["contracts.reference_index", "/contracts?missing=reference_index"],
    ];

    const allBlockers = report.levers.flatMap((l) => l.blockers);
    for (const [blockerId, needle] of expectations) {
      const b = allBlockers.find((x) => x.id === blockerId);
      assert.ok(
        b,
        `blocker ${blockerId} should be present on the empty org so we can verify its fixUrl`,
      );
      assert.ok(
        b.fixUrl?.includes(needle),
        `blocker ${blockerId} fixUrl should contain "${needle}", got ${b.fixUrl ?? "<none>"}`,
      );
    }

    // And conversely: the blockers we *deliberately* leave un-deep-linked
    // should not pick up an unrelated `?missing=` param by accident.
    // `contracts.end_date` is here because the column is `NOT NULL` in
    // the schema — a missing-end-date filter would always be empty, so
    // the rule sends operators to /contracts unfiltered.
    const noParamIds = [
      "purchase_orders.contract_id",
      "contracts.exists",
      "contracts.end_date",
    ];
    for (const id of noParamIds) {
      const b = allBlockers.find((x) => x.id === id);
      if (!b) continue;
      assert.ok(
        !b.fixUrl?.includes("missing="),
        `blocker ${id} should not carry a ?missing= param, got ${b.fixUrl}`,
      );
    }
  });

  it("empty org → contract_leakage / maverick_spend / duplicate_payment all hard-block at 0", async () => {
    const report = await readReport();
    for (const id of [
      "contract_leakage",
      "maverick_spend",
      "duplicate_payment",
    ] as const) {
      const lever = leverFor(report, id);
      assert.equal(
        lever.score,
        0,
        `${id} should hard-block to 0 with no rows; got ${lever.score}`,
      );
      assert.ok(
        lever.blockers.some((b) => b.hard),
        `${id} should surface a hard blocker`,
      );
    }
    assert.equal(report.hasIngestedData, false);
  });

  it("seeded contract with annual_baseline_usd clears the contract_leakage hard blocker", async () => {
    const supplierId = `sup-${RUN}`;
    await db.insert(suppliersTable).values({
      id: supplierId,
      orgId: ORG_ID,
      name: `${RUN} supplier`,
      normalizedName: `${RUN} supplier`.toLowerCase(),
    });
    const contractId = `ctr-${RUN}`;
    const now = new Date();
    const yearLater = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    await db.insert(contractsTable).values({
      id: contractId,
      orgId: ORG_ID,
      supplierId,
      contractNumber: `CN-${RUN}`,
      title: `${RUN} contract`,
      status: "active",
      startDate: now,
      endDate: yearLater,
      annualBaselineUsd: "1000000",
    });

    const report = await readReport();
    const leakage = leverFor(report, "contract_leakage");
    assert.ok(
      !leakage.blockers.some(
        (b) => b.hard && b.id === "contracts.annual_baseline_usd",
      ),
      "annual_baseline_usd hard blocker should be gone once a contract has a baseline",
    );
    assert.equal(
      leakage.score,
      100,
      `contract_leakage should be 100 once seeded, got ${leakage.score} (${leakage.blockers.map((b) => b.id).join(",")})`,
    );
  });

  it("seeded invoice with dedup_key clears the duplicate_payment hard blocker", async () => {
    await db.insert(invoicesTable).values({
      id: `inv-${RUN}`,
      orgId: ORG_ID,
      supplierId: `sup-${RUN}`,
      invoiceNumber: `INV-${RUN}`,
      invoiceDate: new Date(),
      amountUsd: "5000",
      dedupKey: `dedup-${RUN}`,
    });
    const report = await readReport();
    const dup = leverFor(report, "duplicate_payment");
    assert.ok(
      !dup.blockers.some((b) => b.hard),
      `duplicate_payment should no longer hard-block once invoices have dedup keys; saw ${JSON.stringify(dup.blockers)}`,
    );
    assert.equal(dup.score, 100);
  });

  it("once any sentinel rows exist, hasIngestedData flips to true", async () => {
    const report = await readReport();
    assert.equal(report.hasIngestedData, true);
  });

  it("overallScore is the average across the 12 levers and bounded to [0, 100]", async () => {
    const report = await readReport();
    assert.ok(report.overallScore >= 0 && report.overallScore <= 100);
    const expected = Math.round(
      report.levers.reduce((acc, l) => acc + l.score, 0) /
        Math.max(1, report.levers.length),
    );
    assert.equal(report.overallScore, expected);
  });
});
