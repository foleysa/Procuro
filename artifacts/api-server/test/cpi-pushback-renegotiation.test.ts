/**
 * Integration spot check for #68 — CPI pushback context attached to
 * the `contract_renegotiation_trigger` lever.
 *
 * Seeds a per-run org with an active contract that has overrun its
 * baseline (actual > baseline × 1.20) on a CPI-mapped category
 * (`UTILITIES` → `ENERGY`), plus two BLS-style economic_index signals
 * scoped to `ENERGY` that bracket the lookback window with a +4% CPI
 * move. Asserts the analyzer:
 *
 *   1. Emits a renegotiation draft for the seeded contract.
 *   2. Attaches a `cpiPushback` block on `inputs` with verdict
 *      `pushback` (supplier ask outpaces CPI).
 *   3. Splices the CPI summary into both the rationale and the
 *      recommended action.
 *   4. Surfaces a disclosure-tier source descriptor on `inputs.sources`
 *      so the Command Center detail page can cite the BLS series.
 *
 * Self-cleaning per spot-vs-contract template.
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
  purchaseOrdersTable,
  poLinesTable,
  marketSignalsTable,
  collectorsTable,
} from "@workspace/db";
import { eq, like, or } from "drizzle-orm";
import { z } from "zod";

import { contractRenegotiationTriggerLever } from "../src/lib/levers/tier2";
import { toAnalyzeResult } from "../src/lib/levers/types";
import { registerCollector } from "../src/lib/intelligence/runtime";
import type { IntelligenceCollector } from "../src/lib/intelligence/collector";

const RUN = `t68-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
let supplierId: string;
let categoryId: string;
let contractId: string;
let poId: string;
let earliestSignalId: string;
let latestSignalId: string;
let collectorId: string;

const TENANT_CATEGORY_CODE = "UTILITIES";
const CPI_SCOPE = "ENERGY";

describe("contract_renegotiation_trigger CPI pushback (#68)", () => {
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
      name: `${RUN} Power Co`,
      normalizedName: `${RUN} power co`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sup`,
    });

    categoryId = newId("cat");
    await db.insert(categoriesTable).values({
      id: categoryId,
      orgId,
      code: TENANT_CATEGORY_CODE,
      name: "Facility Utilities",
      class: "indirect",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-cat`,
    });

    // Active contract with $100k baseline, overrun by recent spend.
    contractId = newId("con");
    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);
    await db.insert(contractsTable).values({
      id: contractId,
      orgId,
      supplierId,
      categoryId,
      contractNumber: `${RUN}-MSA-001`,
      title: `${RUN} utilities MSA`,
      status: "active",
      startDate: today,
      endDate: inOneYear,
      annualBaselineUsd: "100000.00",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-con`,
    });

    poId = newId("po");
    await db.insert(purchaseOrdersTable).values({
      id: poId,
      orgId,
      poNumber: `${RUN}-PO-001`,
      supplierId,
      contractId,
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-po`,
    });
    // $130,000 of recent spend → 30% overrun → supplier-implied ask 30%.
    await db.insert(poLinesTable).values({
      id: newId("pol"),
      orgId,
      poId,
      lineNumber: 1,
      sku: `${RUN}-UTIL-1`,
      description: `${RUN} utilities qty 1`,
      categoryId,
      spendClass: "indirect",
      qty: "1",
      unitPriceUsd: "130000.0000",
      extendedUsd: "130000.00",
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-pol-1`,
    });

    // Stub BLS collector + registry registration.
    collectorId = newId("col");
    await db.insert(collectorsTable).values({
      id: collectorId,
      name: `${RUN} bls-stub`,
      description: "Stub for cpi_pushback test",
      posture: "public-api",
      status: "approved",
      owner: "test",
      sourceUrl: "https://www.bls.gov/cpi/",
      rateLimitRpm: 30,
      killSwitch: 0,
    });
    const stubCollector: IntelligenceCollector = {
      id: collectorId,
      name: `${RUN} bls-stub`,
      description: "Stub for cpi_pushback test",
      posture: "public-api",
      sourceUrl: "https://www.bls.gov/cpi/",
      defaultRateLimitRpm: 30,
      defaultScheduleCron: null,
      postureClass: "public_api",
      disclosureTier: "T1",
      jurisdiction: "US",
      retentionDays: 365,
      tenantOptInDefault: true,
      signalSchema: z.object({}).passthrough(),
      stableSignalKey: () => `${collectorId}::stub`,
      collect: async () => [],
    };
    registerCollector(stubCollector);

    // Two CPI ENERGY observations: 250 → 260 = +4% over the window.
    const earliestAt = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
    earliestSignalId = newId("sig");
    await db.insert(marketSignalsTable).values({
      id: earliestSignalId,
      orgId: null,
      collectorId,
      signalType: "economic_index",
      scopeCategoryCode: CPI_SCOPE,
      value: "250.0000",
      unit: "index",
      currency: "USD",
      observedAt: earliestAt,
      sourceUrl: "https://data.bls.gov/timeseries/CUUR0000SA0E",
      posture: "public-api",
      confidence: "0.9500",
      metadata: { seriesId: "CUUR0000SA0E", basis: "test_fixture" },
    });
    latestSignalId = newId("sig");
    await db.insert(marketSignalsTable).values({
      id: latestSignalId,
      orgId: null,
      collectorId,
      signalType: "economic_index",
      scopeCategoryCode: CPI_SCOPE,
      value: "260.0000",
      unit: "index",
      currency: "USD",
      observedAt: today,
      sourceUrl: "https://data.bls.gov/timeseries/CUUR0000SA0E",
      posture: "public-api",
      confidence: "0.9500",
      metadata: { seriesId: "CUUR0000SA0E", basis: "test_fixture" },
    });
  });

  it("attaches CPI pushback context, source, and updated rationale/action", async () => {
    const drafts = toAnalyzeResult(
      await contractRenegotiationTriggerLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    ).drafts;

    const ours = drafts.find(
      (d) =>
        (d.inputs as { contractId?: string }).contractId === contractId,
    );
    assert.ok(
      ours,
      `expected a renegotiation draft for our seeded contract; got ${drafts.length} drafts`,
    );

    const inputs = ours.inputs as Record<string, unknown>;
    const pushback = inputs["cpiPushback"] as Record<string, unknown> | null;
    assert.ok(pushback, "expected inputs.cpiPushback to be populated");
    assert.equal(pushback["cpiScopeCode"], CPI_SCOPE);
    // 30% overrun → supplier ask = 30%; CPI moved +4%; verdict = pushback.
    assert.equal(pushback["verdict"], "pushback");
    assert.ok(Math.abs(Number(pushback["cpiMovePct"]) - 4) < 0.001);
    assert.ok(Math.abs(Number(pushback["supplierAskPct"]) - 30) < 0.001);
    assert.ok(Math.abs(Number(pushback["spreadPct"]) - 26) < 0.001);

    // Splice into rationale + action.
    assert.match(ours.rationale, /CPI moved/i);
    assert.match(ours.rationale, /ENERGY/);
    assert.match(
      ours.recommendedAction ?? "",
      /BLS ENERGY CPI move/i,
      "recommendedAction should reference the BLS CPI move",
    );

    // Disclosure-tier source descriptor on `inputs.sources`.
    const sources = inputs["sources"] as unknown[];
    assert.ok(
      Array.isArray(sources) && sources.length === 1,
      "expected exactly one CPI source descriptor",
    );
    const src = sources[0] as Record<string, unknown>;
    assert.equal(src["collectorId"], collectorId);
    assert.equal(
      src["sourceUrl"],
      "https://data.bls.gov/timeseries/CUUR0000SA0E",
    );
    const contract = src["contract"] as Record<string, unknown>;
    assert.equal(contract["postureClass"], "public_api");
    assert.equal(contract["disclosureTier"], "T1");
  });

  after(async () => {
    const safe = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* swallow */
      }
    };
    for (const sigId of [earliestSignalId, latestSignalId]) {
      if (sigId) {
        await safe(
          db
            .delete(marketSignalsTable)
            .where(eq(marketSignalsTable.id, sigId)),
        );
      }
    }
    if (collectorId) {
      await safe(
        db.delete(collectorsTable).where(eq(collectorsTable.id, collectorId)),
      );
    }
    if (orgId) {
      await safe(db.delete(orgsTable).where(eq(orgsTable.id, orgId)));
      await safe(
        db
          .delete(poLinesTable)
          .where(like(poLinesTable.sourceExternalId, `${RUN}-%`)),
      );
      await safe(
        db
          .delete(purchaseOrdersTable)
          .where(like(purchaseOrdersTable.sourceExternalId, `${RUN}-%`)),
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
      await safe(
        db
          .delete(categoriesTable)
          .where(
            or(
              like(categoriesTable.sourceExternalId, `${RUN}-%`),
              like(categoriesTable.code, `${RUN}-%`),
            ),
          ),
      );
    }
  });
});
