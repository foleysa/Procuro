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
  itemsTable,
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

/**
 * Companion test for the explicit `material_code` tag path (#62).
 *
 * The first describe above exercises the alias-name fallback
 * (tenant `category.code = 'STEEL_PLATE'` matched via
 * `MATERIAL_TO_CATEGORY_CODES`). This block verifies the OTHER two
 * tagging paths the lever supports:
 *
 *   1. `categories.material_code` set explicitly to the canonical
 *      material code, on a category whose `code` is a tenant-specific
 *      string that is NOT in any alias list (e.g. an arbitrary BU
 *      code like "BU-RESIN-PKG-A1"). Without the explicit tag, the
 *      lever would never match this category — so emitting a draft
 *      proves the explicit tag drives the join.
 *
 *   2. `items.material_code` set on an item used on a po_line in a
 *      similarly arbitrary category. The lever rolls up the
 *      item-grain tag through `po_lines` to the category, so a draft
 *      against this contract proves the item-grain tag path works.
 *
 * Both fixtures are namespaced under per-run prefixes and torn down
 * in `after()`.
 */
const RUN_TAG = `t62tag-${randomUUID().replace(/-/g, "").slice(0, 10)}`;

let tagOrgId: string;
let tagSupplierId: string;
let tagExplicitCatId: string;
let tagItemTagCatId: string;
let tagExplicitContractId: string;
let tagItemContractId: string;
let tagExplicitPoId: string;
let tagItemPoId: string;
let tagItemId: string;
let tagEarliestSignalId: string;
let tagLatestSignalId: string;
let tagCollectorId: string;

const TAG_MATERIAL_CODE = "PLASTIC_RESINS";
// Arbitrary tenant-supplied codes that are NOT in MATERIAL_TO_CATEGORY_CODES
// for PLASTIC_RESINS — proves the matching is driven by the explicit
// material_code column, not by the category code naming.
const TAG_EXPLICIT_CATEGORY_CODE = `${RUN_TAG}-BU-RESIN-PKG-A1`;
const TAG_ITEM_CATEGORY_CODE = `${RUN_TAG}-PLANT-7-MOLDING`;

describe("material_index_arbitrage Tier-4 lever (#62, explicit material_code tag)", () => {
  before(async () => {
    tagOrgId = newId("org");
    await db.insert(orgsTable).values({
      id: tagOrgId,
      name: `${RUN_TAG} Test Org`,
      slug: `${RUN_TAG}-org`,
    });

    tagSupplierId = newId("sup");
    await db.insert(suppliersTable).values({
      id: tagSupplierId,
      orgId: tagOrgId,
      name: `${RUN_TAG} Resin Co`,
      normalizedName: `${RUN_TAG} resin co`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN_TAG}-sup`,
    });

    // (a) Category tagged explicitly with material_code = PLASTIC_RESINS,
    //     but with an arbitrary tenant code that is NOT in any alias list.
    tagExplicitCatId = newId("cat");
    await db.insert(categoriesTable).values({
      id: tagExplicitCatId,
      orgId: tagOrgId,
      code: TAG_EXPLICIT_CATEGORY_CODE,
      name: "Plant A1 Packaging Resins",
      class: "direct",
      materialCode: TAG_MATERIAL_CODE,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN_TAG}-cat-a`,
    });

    // (b) Category WITHOUT the explicit tag — its only signal is an
    //     item under it that carries the tag.
    tagItemTagCatId = newId("cat");
    await db.insert(categoriesTable).values({
      id: tagItemTagCatId,
      orgId: tagOrgId,
      code: TAG_ITEM_CATEGORY_CODE,
      name: "Plant 7 Injection Molding",
      class: "direct",
      // materialCode intentionally null — must come from the item.
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN_TAG}-cat-b`,
    });
    tagItemId = newId("itm");
    await db.insert(itemsTable).values({
      id: tagItemId,
      orgId: tagOrgId,
      sku: `${RUN_TAG}-RESIN-PELLETS-A`,
      description: `${RUN_TAG} polyethylene resin pellets`,
      normalizedKey: `${RUN_TAG}-resin-pellets-a`,
      categoryId: tagItemTagCatId,
      materialCode: TAG_MATERIAL_CODE,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN_TAG}-itm`,
    });

    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);

    // Contract + spend on the explicit-category-tag fixture.
    tagExplicitContractId = newId("con");
    await db.insert(contractsTable).values({
      id: tagExplicitContractId,
      orgId: tagOrgId,
      supplierId: tagSupplierId,
      categoryId: tagExplicitCatId,
      contractNumber: `${RUN_TAG}-MSA-A`,
      title: `${RUN_TAG} resin packaging MSA`,
      status: "active",
      startDate: today,
      endDate: inOneYear,
      annualBaselineUsd: "150000.00",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN_TAG}-con-a`,
    });
    tagExplicitPoId = newId("po");
    await db.insert(purchaseOrdersTable).values({
      id: tagExplicitPoId,
      orgId: tagOrgId,
      poNumber: `${RUN_TAG}-PO-A`,
      supplierId: tagSupplierId,
      contractId: tagExplicitContractId,
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN_TAG}-po-a`,
    });
    await db.insert(poLinesTable).values({
      id: newId("pol"),
      orgId: tagOrgId,
      poId: tagExplicitPoId,
      lineNumber: 1,
      sku: `${RUN_TAG}-RESIN-PKG-1`,
      description: `${RUN_TAG} resin packaging line 1`,
      categoryId: tagExplicitCatId,
      spendClass: "direct",
      qty: "1000",
      unitPriceUsd: "150.0000",
      extendedUsd: "150000.00",
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN_TAG}-pol-a`,
    });

    // Contract + spend on the item-tag fixture (po_line references the
    // tagged item; categoriesTable row itself has no material_code).
    tagItemContractId = newId("con");
    await db.insert(contractsTable).values({
      id: tagItemContractId,
      orgId: tagOrgId,
      supplierId: tagSupplierId,
      categoryId: tagItemTagCatId,
      contractNumber: `${RUN_TAG}-MSA-B`,
      title: `${RUN_TAG} molding feedstock MSA`,
      status: "active",
      startDate: today,
      endDate: inOneYear,
      annualBaselineUsd: "120000.00",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN_TAG}-con-b`,
    });
    tagItemPoId = newId("po");
    await db.insert(purchaseOrdersTable).values({
      id: tagItemPoId,
      orgId: tagOrgId,
      poNumber: `${RUN_TAG}-PO-B`,
      supplierId: tagSupplierId,
      contractId: tagItemContractId,
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN_TAG}-po-b`,
    });
    await db.insert(poLinesTable).values({
      id: newId("pol"),
      orgId: tagOrgId,
      poId: tagItemPoId,
      lineNumber: 1,
      sku: `${RUN_TAG}-RESIN-PELLETS-A`,
      description: `${RUN_TAG} polyethylene resin pellets`,
      categoryId: tagItemTagCatId,
      itemId: tagItemId,
      spendClass: "direct",
      qty: "1000",
      unitPriceUsd: "120.0000",
      extendedUsd: "120000.00",
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN_TAG}-pol-b`,
    });

    // Stub collector for FK + in-memory registry.
    tagCollectorId = newId("col");
    await db.insert(collectorsTable).values({
      id: tagCollectorId,
      name: `${RUN_TAG} fred-stub`,
      description: "Stub for material_index_arbitrage explicit-tag test",
      posture: "public-api",
      status: "approved",
      owner: "test",
      sourceUrl: "https://fred.stlouisfed.org/series/WPU072",
      rateLimitRpm: 30,
      killSwitch: 0,
    });
    const stubCollector: IntelligenceCollector = {
      id: tagCollectorId,
      name: `${RUN_TAG} fred-stub`,
      description: "Stub for material_index_arbitrage explicit-tag test",
      posture: "public-api",
      sourceUrl: "https://fred.stlouisfed.org/series/WPU072",
      defaultRateLimitRpm: 30,
      defaultScheduleCron: null,
      postureClass: "public_api",
      disclosureTier: "T1",
      jurisdiction: "US",
      retentionDays: 365,
      tenantOptInDefault: true,
      signalSchema: z.object({}).passthrough(),
      stableSignalKey: () => `${tagCollectorId}::stub`,
      collect: async () => [],
    };
    registerCollector(stubCollector);

    // Two FRED-style PLASTIC_RESINS signals — earliest at 200, latest at
    // 220, +10% move (PPI up → "lock-in" branch).
    const earliestAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    tagEarliestSignalId = newId("sig");
    await db.insert(marketSignalsTable).values({
      id: tagEarliestSignalId,
      orgId: null,
      collectorId: tagCollectorId,
      signalType: "economic_index",
      scopeMaterialCode: TAG_MATERIAL_CODE,
      value: "200.0000",
      unit: "index",
      currency: "USD",
      observedAt: earliestAt,
      sourceUrl: "https://fred.stlouisfed.org/series/WPU072",
      posture: "public-api",
      confidence: "0.9500",
      metadata: { seriesId: "WPU072", basis: "test_fixture" },
    });
    tagLatestSignalId = newId("sig");
    await db.insert(marketSignalsTable).values({
      id: tagLatestSignalId,
      orgId: null,
      collectorId: tagCollectorId,
      signalType: "economic_index",
      scopeMaterialCode: TAG_MATERIAL_CODE,
      value: "220.0000",
      unit: "index",
      currency: "USD",
      observedAt: new Date(),
      sourceUrl: "https://fred.stlouisfed.org/series/WPU072",
      posture: "public-api",
      confidence: "0.9500",
      metadata: { seriesId: "WPU072", basis: "test_fixture" },
    });
  });

  it("matches contracts via the explicit category-level material_code tag", async () => {
    const drafts = toAnalyzeResult(
      await materialIndexArbitrageLever.analyze({
        orgId: tagOrgId,
        cycleId: "test-cycle",
      }),
    ).drafts;

    const ours = drafts.find(
      (d) =>
        (d.inputs as { contractId?: string }).contractId ===
        tagExplicitContractId,
    );
    assert.ok(
      ours,
      `expected a draft for the explicit-tag contract; got ${drafts.length} drafts: ${drafts
        .map((d) => (d.inputs as { contractId?: string }).contractId)
        .join(", ")}`,
    );

    assert.equal(ours.leverId, "material_index_arbitrage");
    assert.equal(ours.categoryId, tagExplicitCatId);

    // +10% on $150,000 with 0.5 passthrough → $7,500.
    assert.equal(ours.rawProjectedSavingsUsd, 7500);

    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(inputs["materialScopeCode"], TAG_MATERIAL_CODE);
    // The category code on the draft is the tenant's arbitrary code,
    // proving the lever joined via the explicit material_code tag and
    // not via the alias-name fallback.
    assert.equal(inputs["categoryCode"], TAG_EXPLICIT_CATEGORY_CODE);
    assert.ok(Number(inputs["movePct"]) > 0);

    // PPI-up branch surfaces a lock-in / pull-forward action.
    assert.match(ours.title, /lock.?in/i);
    assert.match(ours.rationale, /WPU072/);
  });

  it("matches contracts via the explicit item-level material_code tag", async () => {
    const drafts = toAnalyzeResult(
      await materialIndexArbitrageLever.analyze({
        orgId: tagOrgId,
        cycleId: "test-cycle",
      }),
    ).drafts;

    const ours = drafts.find(
      (d) =>
        (d.inputs as { contractId?: string }).contractId ===
        tagItemContractId,
    );
    assert.ok(
      ours,
      `expected a draft for the item-tag contract; got ${drafts.length} drafts`,
    );
    assert.equal(ours.categoryId, tagItemTagCatId);
    // +10% on $120,000 with 0.5 passthrough → $6,000.
    assert.equal(ours.rawProjectedSavingsUsd, 6000);
    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(inputs["materialScopeCode"], TAG_MATERIAL_CODE);
    assert.equal(inputs["categoryCode"], TAG_ITEM_CATEGORY_CODE);
  });

  after(async () => {
    const safe = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* swallow */
      }
    };
    for (const sigId of [tagEarliestSignalId, tagLatestSignalId]) {
      if (sigId) {
        await safe(
          db
            .delete(marketSignalsTable)
            .where(eq(marketSignalsTable.id, sigId)),
        );
      }
    }
    if (tagCollectorId) {
      await safe(
        db
          .delete(collectorsTable)
          .where(eq(collectorsTable.id, tagCollectorId)),
      );
    }
    if (tagOrgId) {
      await safe(db.delete(orgsTable).where(eq(orgsTable.id, tagOrgId)));
      await safe(
        db
          .delete(poLinesTable)
          .where(like(poLinesTable.sourceExternalId, `${RUN_TAG}-%`)),
      );
      await safe(
        db
          .delete(purchaseOrdersTable)
          .where(like(purchaseOrdersTable.sourceExternalId, `${RUN_TAG}-%`)),
      );
      await safe(
        db
          .delete(contractsTable)
          .where(like(contractsTable.sourceExternalId, `${RUN_TAG}-%`)),
      );
      await safe(
        db
          .delete(itemsTable)
          .where(like(itemsTable.sourceExternalId, `${RUN_TAG}-%`)),
      );
      await safe(
        db
          .delete(suppliersTable)
          .where(like(suppliersTable.sourceExternalId, `${RUN_TAG}-%`)),
      );
      await safe(
        db
          .delete(categoriesTable)
          .where(
            or(
              like(categoriesTable.sourceExternalId, `${RUN_TAG}-%`),
              like(categoriesTable.code, `${RUN_TAG}-%`),
            ),
          ),
      );
    }
  });
});
