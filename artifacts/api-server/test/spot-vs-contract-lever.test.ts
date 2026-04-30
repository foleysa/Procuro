/**
 * End-to-end spot check for the Tier-2 `spot_vs_contract` lever.
 *
 * Proves that a FRED-style market_signal (scoped to a canonical procurement
 * category code) is matched against a tenant's category by `code` and
 * surfaced as an opportunity for an active contract with material recent
 * spend. This is the required "FRED → real procurement opportunity"
 * round-trip from task #43.
 *
 * The test is fully self-cleaning: every fixture row is namespaced under a
 * per-run prefix and torn down in `after()`, so concurrent runs against the
 * same database stay isolated. The market_signal row is global (org_id NULL)
 * and tenant-isolated by an org-specific category code prefix.
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

import { spotVsContractLever } from "../src/lib/levers/tier2";
import {
  CANONICAL_CATEGORY_CODES,
  type CanonicalCategoryCode,
} from "../src/lib/intelligence/scope-taxonomy";

const RUN = `t43-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
let supplierId: string;
let categoryId: string;
let contractId: string;
let poId: string;
let signalId: string;
let collectorId: string;

const SCOPE_CODE: CanonicalCategoryCode = "FREIGHT_TRUCKING_TL";

describe("spot_vs_contract Tier-2 lever", () => {
  before(async () => {
    // Ensure the canonical scope code we use for the test is still part of
    // the taxonomy — guards against future renames.
    assert.ok(
      (CANONICAL_CATEGORY_CODES as readonly string[]).includes(SCOPE_CODE),
      `${SCOPE_CODE} should be in CANONICAL_CATEGORY_CODES`,
    );

    // Use a fresh test org so we own the canonical category code outright
    // (the unique constraint is (orgId, code) — a seeded tenant might
    // already use FREIGHT_TRUCKING_TL).
    orgId = newId("org");
    await db.insert(orgsTable).values({
      id: orgId,
      name: `${RUN} Test Org`,
      slug: `${RUN}-org`,
    });

    // --- Tenant fixtures (namespaced by RUN) ---
    supplierId = newId("sup");
    await db.insert(suppliersTable).values({
      id: supplierId,
      orgId,
      name: `${RUN} Trucking Co`,
      normalizedName: `${RUN} trucking co`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-sup`,
    });

    // Tenant-side category whose code matches the canonical FRED scope code.
    // The lever joins on UPPER(code) = scope_category_code.
    categoryId = newId("cat");
    await db.insert(categoriesTable).values({
      id: categoryId,
      orgId,
      code: SCOPE_CODE,
      name: "Long-distance Truckload Freight",
      class: "service",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-cat`,
    });

    // Active contract in the matched category, large enough that the
    // analyzer's $25K floor + $750 savings floor are both cleared.
    contractId = newId("con");
    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);
    await db.insert(contractsTable).values({
      id: contractId,
      orgId,
      supplierId,
      categoryId,
      contractNumber: `${RUN}-MSA-001`,
      title: `${RUN} freight MSA`,
      status: "active",
      startDate: today,
      endDate: inOneYear,
      annualBaselineUsd: "100000.00",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-con`,
    });

    // PO + line under the contract with $50K of recent spend, so the
    // category's 12-month spend = $50K (above the $25K materiality bar).
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
    await db.insert(poLinesTable).values({
      id: newId("pol"),
      orgId,
      poId,
      lineNumber: 1,
      sku: `${RUN}-FREIGHT-LANE-1`,
      description: `${RUN} freight lane 1`,
      categoryId,
      spendClass: "service",
      qty: "100",
      unitPriceUsd: "500.0000",
      extendedUsd: "50000.00",
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-pol-1`,
    });

    // Register a stub collector for the FK on market_signals.collector_id.
    collectorId = newId("col");
    await db.insert(collectorsTable).values({
      id: collectorId,
      name: `${RUN} fred-stub`,
      description: "Stub for spot_vs_contract test",
      posture: "public-api",
      status: "approved",
      owner: "test",
      sourceUrl: "https://fred.stlouisfed.org/series/PCU484121484121",
      rateLimitRpm: 30,
      killSwitch: 0,
    });

    // Insert a global FRED-style economic_index signal scoped to the
    // canonical category code. The lever filters org_id IS NULL OR =
    // orgId, so global signals reach every tenant.
    signalId = newId("sig");
    await db.insert(marketSignalsTable).values({
      id: signalId,
      orgId: null,
      collectorId,
      signalType: "economic_index",
      scopeCategoryCode: SCOPE_CODE,
      value: "245.6700",
      unit: "index",
      currency: "USD",
      observedAt: today,
      sourceUrl: "https://fred.stlouisfed.org/series/PCU484121484121",
      posture: "public-api",
      confidence: "0.9500",
      metadata: { seriesId: "PCU484121484121", basis: "test_fixture" },
    });
  });

  it("emits an opportunity citing the FRED signal for the matched contract", async () => {
    const drafts = await spotVsContractLever.analyze({
      orgId,
      cycleId: "test-cycle",
    });

    // There may be other tenant data in the DB matching the same canonical
    // code; pick the draft tied to OUR seeded contract.
    const ours = drafts.find(
      (d) =>
        (d.inputs as { contractId?: string }).contractId === contractId,
    );
    assert.ok(
      ours,
      `expected a draft for our seeded contract; got ${drafts.length} drafts`,
    );

    assert.equal(ours.leverId, "spot_vs_contract");
    assert.equal(ours.supplierId, supplierId);
    assert.equal(ours.categoryId, categoryId);
    // 3% of $50K = $1500.
    assert.equal(ours.rawProjectedSavingsUsd, 1500);

    // The market signal must be carried through on `inputs.marketSignal` so
    // downstream review / OODA learn can cite it.
    const ms = (ours.inputs as { marketSignal?: Record<string, unknown> })
      .marketSignal;
    assert.ok(ms, "draft.inputs.marketSignal missing");
    assert.equal(ms["id"], signalId);
    assert.equal(ms["scopeCategoryCode"], SCOPE_CODE);
    assert.equal(ms["collectorId"], collectorId);
    assert.equal(ms["value"], 245.67);

    // Rationale should reference the FRED PPI value + observation date.
    assert.match(
      ours.rationale,
      /245\.67/,
      "rationale should include the index value",
    );
    assert.match(
      ours.rationale,
      /PCU484121484121/,
      "rationale should include the FRED series id from the catalog",
    );
  });

  after(async () => {
    // Tear down in FK-safe order. Catch errors so a partially-set-up test
    // still cleans what it can.
    const safe = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* swallow */
      }
    };
    if (signalId) {
      await safe(
        db.delete(marketSignalsTable).where(eq(marketSignalsTable.id, signalId)),
      );
    }
    if (collectorId) {
      await safe(
        db.delete(collectorsTable).where(eq(collectorsTable.id, collectorId)),
      );
    }
    // Deleting the test org cascades through suppliers/categories/contracts/
    // POs/po_lines, but we still scrub by prefix as belt-and-braces in case
    // a partial run left orphans somewhere.
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
