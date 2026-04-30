/**
 * Integration test for the `supplier_fx_exposure` lever analyzer.
 *
 * Plants a controlled fixture in the seed org and runs the analyzer's SQL
 * end-to-end against the real database, asserting that:
 *
 *   1. A supplier whose pair has moved beyond the 3% threshold over the
 *      30-day lookback window IS surfaced.
 *   2. A supplier whose pair has barely moved (~1%) is NOT surfaced.
 *   3. Suppliers billing in the org base currency are skipped entirely.
 *   4. The emitted draft carries the right pair, move%, and supplier-12mo
 *      spend on its `inputs` and `rawProjectedSavingsUsd`.
 *
 * All inserts are namespaced behind a per-run `TEST_RUN_ID` and the test
 * cleans them up in foreign-key-safe order so concurrent test runs against
 * the same database stay isolated.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  contractsTable,
  invoicesTable,
  collectorsTable,
  marketSignalsTable,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";

import { supplierFxExposureLever } from "../src/lib/levers/fx-exposure";
import { pickOrgId } from "./helpers/csv-stream-fixtures";

const TEST_RUN_ID = `fxlev-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const SOURCE = `fx-exposure-test-${TEST_RUN_ID}`;
const COLLECTOR_ID = SOURCE;

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

interface Ctx {
  orgId: string;
  cycleId: string;
  origBaseCurrency: string;
  supplierGbpId: string;
  supplierJpyId: string;
  supplierUsdId: string;
}

const ctx: Ctx = {
  orgId: "",
  cycleId: `cycle_${TEST_RUN_ID}`,
  origBaseCurrency: "USD",
  supplierGbpId: id("sup"),
  supplierJpyId: id("sup"),
  supplierUsdId: id("sup"),
};

const supplierGbpExt = `${TEST_RUN_ID}-sup-gbp`;
const supplierJpyExt = `${TEST_RUN_ID}-sup-jpy`;
const supplierUsdExt = `${TEST_RUN_ID}-sup-usd`;

before(async () => {
  ctx.orgId = await pickOrgId();

  // Pin the org's base_currency to USD for the duration of the test, then
  // restore whatever was there afterwards.
  const [orig] = await db
    .select({ baseCurrency: orgsTable.baseCurrency })
    .from(orgsTable)
    .where(eq(orgsTable.id, ctx.orgId));
  ctx.origBaseCurrency = orig?.baseCurrency ?? "USD";
  await db
    .update(orgsTable)
    .set({ baseCurrency: "USD" })
    .where(eq(orgsTable.id, ctx.orgId));

  // 1. Suppliers — one billing in GBP (will move), one in JPY (won't move),
  //    one in USD (must be ignored regardless of any signals).
  await db.insert(suppliersTable).values([
    {
      id: ctx.supplierGbpId,
      orgId: ctx.orgId,
      name: `${TEST_RUN_ID} GBP Supplier`,
      normalizedName: `${TEST_RUN_ID} gbp supplier`,
      billingCurrency: "GBP",
      sourceSystem: SOURCE,
      sourceExternalId: supplierGbpExt,
    },
    {
      id: ctx.supplierJpyId,
      orgId: ctx.orgId,
      name: `${TEST_RUN_ID} JPY Supplier`,
      normalizedName: `${TEST_RUN_ID} jpy supplier`,
      billingCurrency: "JPY",
      sourceSystem: SOURCE,
      sourceExternalId: supplierJpyExt,
    },
    {
      id: ctx.supplierUsdId,
      orgId: ctx.orgId,
      name: `${TEST_RUN_ID} USD Supplier`,
      normalizedName: `${TEST_RUN_ID} usd supplier`,
      billingCurrency: "USD",
      sourceSystem: SOURCE,
      sourceExternalId: supplierUsdExt,
    },
  ]);

  // 2. Invoices — give each non-USD supplier a known 12mo spend.
  const recent = new Date();
  recent.setDate(recent.getDate() - 30);
  await db.insert(invoicesTable).values([
    {
      id: id("inv"),
      orgId: ctx.orgId,
      supplierId: ctx.supplierGbpId,
      invoiceNumber: `${TEST_RUN_ID}-GBP-01`,
      invoiceDate: recent,
      amountUsd: "200000.00",
      dedupKey: `${TEST_RUN_ID}-gbp-01`,
      sourceSystem: SOURCE,
      sourceExternalId: `${TEST_RUN_ID}-inv-gbp-1`,
    },
    {
      id: id("inv"),
      orgId: ctx.orgId,
      supplierId: ctx.supplierJpyId,
      invoiceNumber: `${TEST_RUN_ID}-JPY-01`,
      invoiceDate: recent,
      amountUsd: "150000.00",
      dedupKey: `${TEST_RUN_ID}-jpy-01`,
      sourceSystem: SOURCE,
      sourceExternalId: `${TEST_RUN_ID}-inv-jpy-1`,
    },
    {
      id: id("inv"),
      orgId: ctx.orgId,
      supplierId: ctx.supplierUsdId,
      invoiceNumber: `${TEST_RUN_ID}-USD-01`,
      invoiceDate: recent,
      amountUsd: "999999.00",
      dedupKey: `${TEST_RUN_ID}-usd-01`,
      sourceSystem: SOURCE,
      sourceExternalId: `${TEST_RUN_ID}-inv-usd-1`,
    },
  ]);

  // 3. Synthetic collector + fx_rate signals.
  //    USD/GBP moves 0.78 → 0.83 (~6.4% — should fire).
  //    USD/JPY moves 150 → 151.5 (~1% — should NOT fire).
  await db.insert(collectorsTable).values({
    id: COLLECTOR_ID,
    name: `Test FX Collector ${TEST_RUN_ID}`,
    description: "Synthetic collector for fx-exposure-analyzer test.",
    posture: "public-api",
    status: "approved",
    owner: "test",
    sourceUrl: "https://example.invalid/test",
  });

  const earlier = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  const now = new Date();
  await db.insert(marketSignalsTable).values([
    {
      id: id("msig"),
      orgId: null,
      collectorId: COLLECTOR_ID,
      signalType: "fx_rate",
      scopeMaterialCode: "USD/GBP",
      value: "0.780000",
      unit: "USD/GBP",
      currency: "GBP",
      observedAt: earlier,
      sourceUrl: "https://example.invalid/test",
      posture: "public-api",
      confidence: "0.99",
      metadata: { base: "USD", quote: "GBP", testRunId: TEST_RUN_ID },
    },
    {
      id: id("msig"),
      orgId: null,
      collectorId: COLLECTOR_ID,
      signalType: "fx_rate",
      scopeMaterialCode: "USD/GBP",
      value: "0.830000",
      unit: "USD/GBP",
      currency: "GBP",
      observedAt: now,
      sourceUrl: "https://example.invalid/test",
      posture: "public-api",
      confidence: "0.99",
      metadata: { base: "USD", quote: "GBP", testRunId: TEST_RUN_ID },
    },
    {
      id: id("msig"),
      orgId: null,
      collectorId: COLLECTOR_ID,
      signalType: "fx_rate",
      scopeMaterialCode: "USD/JPY",
      value: "150.000000",
      unit: "USD/JPY",
      currency: "JPY",
      observedAt: earlier,
      sourceUrl: "https://example.invalid/test",
      posture: "public-api",
      confidence: "0.99",
      metadata: { base: "USD", quote: "JPY", testRunId: TEST_RUN_ID },
    },
    {
      id: id("msig"),
      orgId: null,
      collectorId: COLLECTOR_ID,
      signalType: "fx_rate",
      scopeMaterialCode: "USD/JPY",
      value: "151.500000",
      unit: "USD/JPY",
      currency: "JPY",
      observedAt: now,
      sourceUrl: "https://example.invalid/test",
      posture: "public-api",
      confidence: "0.99",
      metadata: { base: "USD", quote: "JPY", testRunId: TEST_RUN_ID },
    },
  ]);
});

after(async () => {
  // Order matters: invoices → contracts → suppliers → market_signals → collector → org.
  await db
    .delete(invoicesTable)
    .where(
      and(
        eq(invoicesTable.sourceSystem, SOURCE),
        like(invoicesTable.sourceExternalId, `${TEST_RUN_ID}%`),
      ),
    );
  await db
    .delete(contractsTable)
    .where(
      and(
        eq(contractsTable.sourceSystem, SOURCE),
        like(contractsTable.sourceExternalId, `${TEST_RUN_ID}%`),
      ),
    );
  await db
    .delete(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, SOURCE),
        like(suppliersTable.sourceExternalId, `${TEST_RUN_ID}%`),
      ),
    );
  await db
    .delete(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, COLLECTOR_ID));
  await db.delete(collectorsTable).where(eq(collectorsTable.id, COLLECTOR_ID));
  await db
    .update(orgsTable)
    .set({ baseCurrency: ctx.origBaseCurrency })
    .where(eq(orgsTable.id, ctx.orgId));
});

describe("supplierFxExposureLever", () => {
  it("flags only suppliers whose FX pair moved beyond the threshold", async () => {
    const drafts = await supplierFxExposureLever.analyze({
      orgId: ctx.orgId,
      cycleId: ctx.cycleId,
    });

    const mine = drafts.filter(
      (d) =>
        d.supplierId === ctx.supplierGbpId ||
        d.supplierId === ctx.supplierJpyId ||
        d.supplierId === ctx.supplierUsdId,
    );

    // 1. The GBP supplier (~6.4% move) should be flagged.
    const gbp = mine.find((d) => d.supplierId === ctx.supplierGbpId);
    assert.ok(gbp, "expected an opportunity for the GBP supplier");

    // 2. The JPY supplier (~1% move) should not be.
    const jpy = mine.find((d) => d.supplierId === ctx.supplierJpyId);
    assert.equal(
      jpy,
      undefined,
      "JPY supplier moved less than the 3% threshold and should not be flagged",
    );

    // 3. The USD supplier (no FX exposure at all) should not be.
    const usd = mine.find((d) => d.supplierId === ctx.supplierUsdId);
    assert.equal(
      usd,
      undefined,
      "USD-billing supplier has no FX exposure and should never be flagged",
    );

    // 4. Inputs and direction normalization.
    assert.equal(gbp!.leverId, "supplier_fx_exposure");
    const inputs = gbp!.inputs as Record<string, unknown>;
    assert.equal(inputs.fxPair, "USD/GBP");
    assert.equal(inputs.fxOrientation, "base/billing");
    assert.equal(inputs.baseCurrency, "USD");
    assert.equal(inputs.billingCurrency, "GBP");
    assert.equal(inputs.thresholdPct, 3);
    assert.equal(inputs.lookbackDays, 30);
    assert.equal(Number(inputs.spend12moUsd), 200000);
    // Raw pair move: 0.83 / 0.78 - 1 ≈ +6.41% (USD strengthened vs GBP).
    const movePct = Number(inputs.movePct);
    assert.ok(
      movePct > 6.3 && movePct < 6.5,
      `expected raw pair move ~+6.4%, got ${movePct}`,
    );
    // Normalized USD-cost-per-GBP: 1/0.83 / (1/0.78) - 1 ≈ -6.02%
    // (GBP weakened ⇒ FAVORABLE for the USD buyer).
    const costChangePct = Number(inputs.costChangePct);
    assert.ok(
      costChangePct < -5.9 && costChangePct > -6.1,
      `expected ~-6.02% cost change, got ${costChangePct}`,
    );
    assert.equal(inputs.adverse, false, "GBP weakening is favorable for USD buyer");
    assert.match(
      gbp!.recommendedAction,
      /Favorable|capture|pull-forward/i,
      "favorable move should trigger a capture/pull-forward recommendation, not a hedge",
    );
    // rawProjectedSavingsUsd = absCostChangePct/100 * spend12mo
    const absCost = Number(inputs.absCostChangePct);
    const expectedExposure = (absCost / 100) * 200000;
    assert.ok(
      Math.abs(gbp!.rawProjectedSavingsUsd - expectedExposure) < 1,
      `expected exposure ~${expectedExposure}, got ${gbp!.rawProjectedSavingsUsd}`,
    );
  });

  it("treats contract.billing_currency as an independent exposure source", async () => {
    // Two real cases planted via contractsTable to exercise the
    // contract-level branch of the exposure-set UNION:
    //
    //   A. supplier-base / contract-foreign:
    //        supplier billing = USD (base), contract billing = GBP.
    //        ⇒ A non-base contract on a base-currency supplier MUST fire
    //          and the GBP contract number MUST appear in contractNumbers.
    //
    //   B. supplier-foreign / contract-base:
    //        supplier billing = GBP, plus one explicit USD-base contract.
    //        ⇒ The supplier already fires from the supplier-level branch;
    //          the USD contract must NOT show up under the GBP exposure
    //          row (only same-currency contracts are listed).
    const supA = id("sup");
    const supAext = `${TEST_RUN_ID}-sup-baseusd-contractgbp`;
    const supB = id("sup");
    const supBext = `${TEST_RUN_ID}-sup-gbp-with-usd-contract`;

    await db.insert(suppliersTable).values([
      {
        id: supA,
        orgId: ctx.orgId,
        name: `${TEST_RUN_ID} USD Supplier w/ GBP Contract`,
        normalizedName: `${TEST_RUN_ID} usd supplier w gbp contract`,
        billingCurrency: "USD",
        sourceSystem: SOURCE,
        sourceExternalId: supAext,
      },
      {
        id: supB,
        orgId: ctx.orgId,
        name: `${TEST_RUN_ID} GBP Supplier w/ USD Contract`,
        normalizedName: `${TEST_RUN_ID} gbp supplier w usd contract`,
        billingCurrency: "GBP",
        sourceSystem: SOURCE,
        sourceExternalId: supBext,
      },
    ]);

    // Both suppliers need above-threshold spend to clear MIN_SPEND_FOR_OPP_USD.
    const recent = new Date();
    recent.setDate(recent.getDate() - 30);
    await db.insert(invoicesTable).values([
      {
        id: id("inv"),
        orgId: ctx.orgId,
        supplierId: supA,
        invoiceNumber: `${TEST_RUN_ID}-CASE-A-01`,
        invoiceDate: recent,
        amountUsd: "100000.00",
        dedupKey: `${TEST_RUN_ID}-case-a-01`,
        sourceSystem: SOURCE,
        sourceExternalId: `${TEST_RUN_ID}-inv-case-a`,
      },
      {
        id: id("inv"),
        orgId: ctx.orgId,
        supplierId: supB,
        invoiceNumber: `${TEST_RUN_ID}-CASE-B-01`,
        invoiceDate: recent,
        amountUsd: "100000.00",
        dedupKey: `${TEST_RUN_ID}-case-b-01`,
        sourceSystem: SOURCE,
        sourceExternalId: `${TEST_RUN_ID}-inv-case-b`,
      },
    ]);

    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const endDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const gbpContractA = `${TEST_RUN_ID}-CT-A-GBP`;
    const usdContractB = `${TEST_RUN_ID}-CT-B-USD`;
    await db.insert(contractsTable).values([
      {
        id: id("ct"),
        orgId: ctx.orgId,
        supplierId: supA,
        contractNumber: gbpContractA,
        title: `${TEST_RUN_ID} GBP-denominated contract on USD supplier`,
        status: "active",
        startDate,
        endDate,
        billingCurrency: "GBP", // overrides supplier's USD default
        sourceSystem: SOURCE,
        sourceExternalId: `${TEST_RUN_ID}-ct-a-gbp`,
      },
      {
        id: id("ct"),
        orgId: ctx.orgId,
        supplierId: supB,
        contractNumber: usdContractB,
        title: `${TEST_RUN_ID} USD-denominated contract on GBP supplier`,
        status: "active",
        startDate,
        endDate,
        billingCurrency: "USD", // base currency — must NOT appear under GBP exposure
        sourceSystem: SOURCE,
        sourceExternalId: `${TEST_RUN_ID}-ct-b-usd`,
      },
    ]);

    const drafts = await supplierFxExposureLever.analyze({
      orgId: ctx.orgId,
      cycleId: ctx.cycleId,
    });

    // CASE A: USD supplier with one GBP contract should fire under the
    // contract-level branch.
    const caseA = drafts.find((d) => d.supplierId === supA);
    assert.ok(
      caseA,
      "USD-billing supplier with a GBP-denominated contract should fire on contract-level exposure",
    );
    const inputsA = caseA!.inputs as Record<string, unknown>;
    assert.equal(inputsA.billingCurrency, "GBP");
    assert.deepEqual(
      inputsA.contractNumbers,
      [gbpContractA],
      "the GBP contract number should be attributed to the GBP exposure row",
    );

    // CASE B: GBP supplier fires from the supplier-level branch; the
    // attached USD-base contract must NOT show up under the GBP exposure.
    const caseB = drafts.find((d) => d.supplierId === supB);
    assert.ok(caseB, "GBP-billing supplier should still fire on supplier-level exposure");
    const inputsB = caseB!.inputs as Record<string, unknown>;
    assert.equal(inputsB.billingCurrency, "GBP");
    const contractsB = inputsB.contractNumbers as string[];
    assert.ok(
      !contractsB.includes(usdContractB),
      "USD-denominated contract on a GBP supplier must NOT be listed under the GBP exposure row",
    );
  });
});
