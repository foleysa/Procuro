/**
 * End-to-end spot check for the Tier-4 `material_index_arbitrage` lever (#62).
 *
 * Exercises the FRED material PPI → tenant material category mapping:
 * a per-run org with a tenant category code that is a known alias for
 * `IRON_STEEL` (`STEEL_PLATE`) is wired up to a contract with material
 * 12-month spend, plus two market_signal rows that bracket the lookback
 * window so the analyzer can compute a clear PPI move. The test
 * asserts:
 *
 *   1. A draft is emitted for the seeded contract.
 *   2. `rawProjectedSavingsUsd` matches the documented formula
 *      (spend × |movePct/100| × passthroughFactor).
 *   3. The disclosure-tier source descriptor is populated with the
 *      registered collector (so the Command Center citation block
 *      renders).
 *   4. `inputs.materialScopeCode` carries the canonical material code
 *      and `inputs.fredSeries` lists the WPU series id.
 *
 * Self-cleaning: every fixture row is namespaced under a per-run prefix
 * and torn down in `after()`, so concurrent runs against the same
 * database stay isolated.
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

import { materialIndexArbitrageLever } from "../src/lib/levers/material-index-arbitrage";
import { toAnalyzeResult } from "../src/lib/levers/types";
import { registerCollector } from "../src/lib/intelligence/runtime";
import type { IntelligenceCollector } from "../src/lib/intelligence/collector";

const RUN = `t62-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
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

// Tenant category code is a documented alias for IRON_STEEL.
const TENANT_CATEGORY_CODE = "STEEL_PLATE";
const MATERIAL_CODE = "IRON_STEEL";

describe("material_index_arbitrage Tier-4 lever (#62)", () => {
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
      name: `${RUN} Steel Mill Co`,
      normalizedName: `${RUN} steel mill co`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sup`,
    });

    // Tenant-side category whose code matches a documented alias for
    // IRON_STEEL via MATERIAL_TO_CATEGORY_CODES.
    categoryId = newId("cat");
    await db.insert(categoriesTable).values({
      id: categoryId,
      orgId,
      code: TENANT_CATEGORY_CODE,
      name: "Hot-Rolled Steel Plate",
      class: "direct",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-cat`,
    });

    contractId = newId("con");
    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);
    await db.insert(contractsTable).values({
      id: contractId,
      orgId,
      supplierId,
      categoryId,
      contractNumber: `${RUN}-MSA-001`,
      title: `${RUN} steel plate MSA`,
      status: "active",
      startDate: today,
      endDate: inOneYear,
      annualBaselineUsd: "200000.00",
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
    // $200,000 of recent spend on the matched category.
    await db.insert(poLinesTable).values({
      id: newId("pol"),
      orgId,
      poId,
      lineNumber: 1,
      sku: `${RUN}-STEEL-PLATE-1`,
      description: `${RUN} steel plate qty 1`,
      categoryId,
      spendClass: "direct",
      qty: "1000",
      unitPriceUsd: "200.0000",
      extendedUsd: "200000.00",
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-pol-1`,
    });

    // Stub collector for the FK + in-memory registry.
    collectorId = newId("col");
    await db.insert(collectorsTable).values({
      id: collectorId,
      name: `${RUN} fred-stub`,
      description: "Stub for material_index_arbitrage test",
      posture: "public-api",
      status: "approved",
      owner: "test",
      sourceUrl: "https://fred.stlouisfed.org/series/WPU101",
      rateLimitRpm: 30,
      killSwitch: 0,
    });
    const stubCollector: IntelligenceCollector = {
      id: collectorId,
      name: `${RUN} fred-stub`,
      description: "Stub for material_index_arbitrage test",
      posture: "public-api",
      sourceUrl: "https://fred.stlouisfed.org/series/WPU101",
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

    // Two FRED-style economic_index signals scoped to the canonical
    // material code IRON_STEEL: an earlier endpoint at index=300.00 and
    // a more recent endpoint at index=270.00 — a -10% move (PPI down).
    const earliestAt = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
    earliestSignalId = newId("sig");
    await db.insert(marketSignalsTable).values({
      id: earliestSignalId,
      orgId: null,
      collectorId,
      signalType: "economic_index",
      scopeMaterialCode: MATERIAL_CODE,
      value: "300.0000",
      unit: "index",
      currency: "USD",
      observedAt: earliestAt,
      sourceUrl: "https://fred.stlouisfed.org/series/WPU101",
      posture: "public-api",
      confidence: "0.9500",
      metadata: { seriesId: "WPU101", basis: "test_fixture" },
    });
    latestSignalId = newId("sig");
    await db.insert(marketSignalsTable).values({
      id: latestSignalId,
      orgId: null,
      collectorId,
      signalType: "economic_index",
      scopeMaterialCode: MATERIAL_CODE,
      value: "270.0000",
      unit: "index",
      currency: "USD",
      observedAt: today,
      sourceUrl: "https://fred.stlouisfed.org/series/WPU101",
      posture: "public-api",
      confidence: "0.9500",
      metadata: { seriesId: "WPU101", basis: "test_fixture" },
    });
  });

  it("emits a draft for the matched contract with sized savings + sources", async () => {
    const drafts = toAnalyzeResult(
      await materialIndexArbitrageLever.analyze({
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
      `expected a draft for our seeded contract; got ${drafts.length} drafts`,
    );

    assert.equal(ours.leverId, "material_index_arbitrage");
    assert.equal(ours.supplierId, supplierId);
    assert.equal(ours.categoryId, categoryId);

    // -10% move on $200,000 with a 0.5 passthrough factor → $10,000.
    assert.equal(ours.rawProjectedSavingsUsd, 10000);

    // inputs carry through the canonical material code and FRED series.
    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(inputs["materialScopeCode"], MATERIAL_CODE);
    assert.equal(inputs["categoryCode"], TENANT_CATEGORY_CODE);
    assert.equal(Number(inputs["earliestValue"]), 300);
    assert.equal(Number(inputs["latestValue"]), 270);
    assert.ok(Number(inputs["movePct"]) < 0);
    const fredSeries = inputs["fredSeries"] as Array<{ seriesId: string }>;
    assert.ok(Array.isArray(fredSeries));
    assert.ok(
      fredSeries.some((f) => f.seriesId === "WPU101"),
      "expected WPU101 to be cited as a backing FRED series",
    );

    // PPI-down branch: the title and rationale should signal a reset
    // opportunity, not a lock-in.
    assert.match(ours.title, /down/i);
    assert.match(ours.rationale, /WPU101/);

    // Disclosure-tier source descriptor: collector resolved off the
    // in-memory registry and surfaced on `inputs.sources` so the
    // Command Center citation block renders.
    const sources = inputs["sources"] as unknown[];
    assert.ok(Array.isArray(sources) && sources.length === 1);
    const src = sources[0] as Record<string, unknown>;
    assert.equal(src["collectorId"], collectorId);
    assert.equal(
      src["sourceUrl"],
      "https://fred.stlouisfed.org/series/WPU101",
      "sources[].sourceUrl should prefer the per-signal URL",
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
