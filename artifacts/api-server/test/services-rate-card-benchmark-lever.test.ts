/**
 * End-to-end spot check for the Tier-5 `services_rate_card_benchmark`
 * lever (#216).
 *
 * Seeds:
 *   - one rate card line for "Senior Software Engineer" priced at
 *     $300/hr (deliberately above OEWS p90)
 *   - OEWS hourly wage_benchmark percentiles (p25/median/p75/p90)
 *     scoped to IT_APP_DEV / US-NATIONAL
 *   - 1,000 hours of time entries over the last 12 months bound to
 *     that rate-card line
 *
 * Asserts:
 *   1. an above_market draft is emitted for the seeded rate-card line
 *   2. savings = (rate - p75) * estimatedAnnualHours
 *   3. consultedSignalIds includes every emitted OEWS signal
 *   4. when the org has no rate cards the analyzer returns silently
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  contractsTable,
  rateCardsTable,
  rateCardLinesTable,
  timeEntriesTable,
  marketSignalsTable,
  collectorsTable,
  purchaseOrdersTable,
  poLinesTable,
  invoicesTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";
import { z } from "zod";

import { servicesRateCardBenchmarkLever } from "../src/lib/levers/services/rate-card-benchmark";
import { toAnalyzeResult } from "../src/lib/levers/types";
import { registerCollector } from "../src/lib/intelligence/runtime";
import type { IntelligenceCollector } from "../src/lib/intelligence/collector";

const RUN = `t216rcb-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
let supplierId: string;
let contractId: string;
let rateCardId: string;
let rateCardLineId: string;
let collectorId: string;
let poId: string;
let offCardPoLineId: string;
const signalIds: string[] = [];

const CARD_RATE = 300;
const OEWS_P25 = 40;
const OEWS_MEDIAN = 60;
const OEWS_P75 = 80;
const OEWS_P90 = 100;
const HOURS = 1000;
// PO line for the same supplier billed at $400/hr — well outside the
// ±5% card tolerance vs the $300 card line.
const PO_OFF_CARD_RATE = 400;
const PO_OFF_CARD_QTY = 50;

describe("services_rate_card_benchmark Tier-5 lever (#216)", () => {
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
      name: `${RUN} Big Consulting Co`,
      normalizedName: `${RUN} big consulting co`,
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
      title: `${RUN} services MSA`,
      status: "active",
      contractType: "t_and_m",
      startDate: today,
      endDate: inOneYear,
      annualBaselineUsd: "500000.00",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-con`,
    });

    rateCardId = newId("rc");
    await db.insert(rateCardsTable).values({
      id: rateCardId,
      orgId,
      contractId,
      supplierId,
      name: `${RUN} default card`,
      currency: "USD",
      effectiveDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-rc`,
    });

    rateCardLineId = newId("rcl");
    await db.insert(rateCardLinesTable).values({
      id: rateCardLineId,
      orgId,
      rateCardId,
      role: "Senior Software Engineer",
      seniority: "Senior",
      hourlyRate: String(CARD_RATE),
    });

    // PO + an off-card labor PO line for the off_card_po detection path.
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
    offCardPoLineId = newId("pol");
    await db.insert(poLinesTable).values({
      id: offCardPoLineId,
      orgId,
      poId,
      lineNumber: 1,
      sku: `${RUN}-LABOR-1`,
      description: `${RUN} labor over card`,
      spendClass: "indirect",
      qty: String(PO_OFF_CARD_QTY),
      uom: "hour",
      unitPriceUsd: String(PO_OFF_CARD_RATE),
      extendedUsd: String(PO_OFF_CARD_RATE * PO_OFF_CARD_QTY),
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-pol-1`,
    });

    // Time entries — 1,000 hrs across the last 12 months bound to the line.
    for (let i = 0; i < 10; i++) {
      const day = new Date(today.getTime() - i * 30 * 24 * 60 * 60 * 1000);
      await db.insert(timeEntriesTable).values({
        id: newId("te"),
        orgId,
        supplierId,
        contractId,
        rateCardId,
        rateCardLineId,
        resource: `${RUN}-resource-1`,
        role: "Senior Software Engineer",
        seniority: "Senior",
        workDate: day,
        hours: String(HOURS / 10),
        billRateUsd: String(CARD_RATE),
        amountUsd: String((HOURS / 10) * CARD_RATE),
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-te-${i}`,
      });
    }

    // Stub OEWS collector for the FK + in-memory registry.
    collectorId = newId("col");
    await db.insert(collectorsTable).values({
      id: collectorId,
      name: `${RUN} oews-stub`,
      description: "Stub for services_rate_card_benchmark test",
      posture: "public-api",
      status: "approved",
      owner: "test",
      sourceUrl: "https://www.bls.gov/oes/",
      rateLimitRpm: 30,
      killSwitch: 0,
    });
    const stubCollector: IntelligenceCollector = {
      id: collectorId,
      name: `${RUN} oews-stub`,
      description: "Stub for services_rate_card_benchmark test",
      posture: "public-api",
      sourceUrl: "https://www.bls.gov/oes/",
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

    // Emit four wage_benchmark percentiles for IT_APP_DEV / US-NATIONAL.
    const aggregates: Array<[string, number]> = [
      ["p25", OEWS_P25],
      ["median", OEWS_MEDIAN],
      ["p75", OEWS_P75],
      ["p90", OEWS_P90],
    ];
    for (const [agg, value] of aggregates) {
      const sigId = newId("sig");
      signalIds.push(sigId);
      await db.insert(marketSignalsTable).values({
        id: sigId,
        orgId: null,
        collectorId,
        signalType: "wage_benchmark",
        scopeCategoryCode: "IT_APP_DEV",
        scopeRegionCode: "US-NATIONAL",
        value: String(value),
        unit: "USD/hour",
        currency: "USD",
        observedAt: today,
        sourceUrl: "https://www.bls.gov/oes/current/oes_nat.htm",
        posture: "public-api",
        confidence: "0.9500",
        metadata: {
          aggregate: agg,
          horizon: "hourly",
          socCode: "15-1252",
        },
      });
    }
  });

  it("emits an above_market draft with sized savings against OEWS p75", async () => {
    const result = toAnalyzeResult(
      await servicesRateCardBenchmarkLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const ours = result.drafts.find(
      (d) =>
        (d.inputs as { rateCardLineId?: string }).rateCardLineId ===
        rateCardLineId,
    );
    assert.ok(
      ours,
      `expected a draft for our seeded rate-card line; got ${result.drafts.length}`,
    );
    assert.equal(ours.leverId, "services_rate_card_benchmark");
    assert.equal(ours.supplierId, supplierId);
    const inputs = ours.inputs as Record<string, unknown>;
    assert.equal(inputs["flavor"], "above_market");
    assert.equal(inputs["oewsScopeCategoryCode"], "IT_APP_DEV");
    assert.equal(Number(inputs["oewsP75"]), OEWS_P75);
    assert.equal(Number(inputs["cardHourlyRate"]), CARD_RATE);

    const expectedSavings = (CARD_RATE - OEWS_P75) * HOURS;
    assert.equal(ours.rawProjectedSavingsUsd, expectedSavings);

    // consultedSignalIds picks up every emitted OEWS row.
    for (const sigId of signalIds) {
      assert.ok(
        result.consultedSignalIds!.includes(sigId),
        `expected consultedSignalIds to include ${sigId}`,
      );
    }
  });

  it("emits an off_card_po draft for labor PO lines outside ±5% of card", async () => {
    const result = toAnalyzeResult(
      await servicesRateCardBenchmarkLever.analyze({
        orgId,
        cycleId: "test-cycle",
      }),
    );
    const offCard = result.drafts.find(
      (d) =>
        (d.inputs as { flavor?: string; poLineId?: string }).flavor ===
          "off_card_po" &&
        (d.inputs as { poLineId?: string }).poLineId === offCardPoLineId,
    );
    assert.ok(offCard, `expected an off_card_po draft for the seeded PO line`);
    assert.equal(offCard.supplierId, supplierId);
    const inputs = offCard.inputs as Record<string, unknown>;
    assert.equal(inputs["rateCardLineId"], rateCardLineId);
    assert.equal(Number(inputs["billedUnitPriceUsd"]), PO_OFF_CARD_RATE);
    assert.equal(Number(inputs["cardHourlyRate"]), CARD_RATE);
    assert.equal(Number(inputs["observedQty"]), PO_OFF_CARD_QTY);
    assert.equal(
      offCard.rawProjectedSavingsUsd,
      (PO_OFF_CARD_RATE - CARD_RATE) * PO_OFF_CARD_QTY,
    );
  });

  it("cohort key is supplier+rateCardLine identity (idempotent across re-runs and flavours)", async () => {
    // Two runs of the same analyzer must produce the same draft and
    // cohort-key shape — we rely on cohort identity for upsert dedupe
    // in the cycle persistence layer.
    const a = toAnalyzeResult(
      await servicesRateCardBenchmarkLever.analyze({
        orgId,
        cycleId: "test-cycle-a",
      }),
    );
    const b = toAnalyzeResult(
      await servicesRateCardBenchmarkLever.analyze({
        orgId,
        cycleId: "test-cycle-b",
      }),
    );
    assert.equal(
      a.drafts.length,
      b.drafts.length,
      "draft counts should be stable across re-runs",
    );

    // Cohort key must equal `rateCardLineId` exactly — no flavour
    // suffix, no other discriminator (per task #216 spec).
    const lever = servicesRateCardBenchmarkLever;
    assert.ok(lever.cohortKey, "lever should expose cohortKey");
    const seen = new Set<string>();
    for (const d of a.drafts) {
      const key = lever.cohortKey!(d);
      const inputs = d.inputs as Record<string, unknown>;
      assert.equal(
        key,
        inputs["rateCardLineId"],
        "cohort key must equal rateCardLineId",
      );
      seen.add(`${d.supplierId}:${key}`);
    }
    // Above-market and off-card-po drafts that pin to the same line
    // must collapse to a single (supplierId, rateCardLineId) cohort,
    // proving the dedupe semantic the cycle layer relies on.
    const aboveMarket = a.drafts.find(
      (d) =>
        (d.inputs as { flavor?: string }).flavor === "above_market" &&
        (d.inputs as { rateCardLineId?: string }).rateCardLineId ===
          rateCardLineId,
    );
    const offCardPo = a.drafts.find(
      (d) =>
        (d.inputs as { flavor?: string }).flavor === "off_card_po" &&
        (d.inputs as { rateCardLineId?: string }).rateCardLineId ===
          rateCardLineId,
    );
    assert.ok(aboveMarket && offCardPo);
    assert.equal(
      lever.cohortKey!(aboveMarket),
      lever.cohortKey!(offCardPo),
      "both flavours pinning to the same line must share a cohort key",
    );
  });

  it("emits an off_card_invoice draft when invoice/hours imply a rate outside ±5% of card", async () => {
    // Seed one month of invoices + matching time entries that imply
    // ~$420/hr (vs the $300 card line). Use a fresh tenant so the
    // happy-path seed time entries (which already match the card)
    // don't dilute the implied bucket.
    const invOrgId = newId("org");
    await db.insert(orgsTable).values({
      id: invOrgId,
      name: `${RUN} inv Org`,
      slug: `${RUN}-inv`,
    });
    const invSupplierId = newId("sup");
    await db.insert(suppliersTable).values({
      id: invSupplierId,
      orgId: invOrgId,
      name: `${RUN} inv supplier`,
      normalizedName: `${RUN} inv supplier`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-inv-sup`,
    });
    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);
    const invContractId = newId("con");
    await db.insert(contractsTable).values({
      id: invContractId,
      orgId: invOrgId,
      supplierId: invSupplierId,
      contractNumber: `${RUN}-INV-MSA`,
      title: `${RUN} inv MSA`,
      status: "active",
      contractType: "t_and_m",
      startDate: today,
      endDate: inOneYear,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-inv-con`,
    });
    const invRateCardId = newId("rc");
    await db.insert(rateCardsTable).values({
      id: invRateCardId,
      orgId: invOrgId,
      supplierId: invSupplierId,
      contractId: invContractId,
      name: `${RUN} card`,
      effectiveDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-inv-rc`,
    });
    const invRateCardLineId = newId("rcl");
    await db.insert(rateCardLinesTable).values({
      id: invRateCardLineId,
      orgId: invOrgId,
      rateCardId: invRateCardId,
      role: "Software Developer",
      seniority: "Senior",
      hourlyRate: String(CARD_RATE),
    });
    // 100 hrs at $300 expected → invoice $42,000 = implied $420/hr.
    const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    await db.insert(timeEntriesTable).values({
      id: newId("te"),
      orgId: invOrgId,
      supplierId: invSupplierId,
      contractId: invContractId,
      resource: `${RUN} dev`,
      role: "Software Developer",
      seniority: "Senior",
      workDate: lastWeek,
      hours: "100",
      billRateUsd: "420",
      amountUsd: "42000",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-inv-te-1`,
    });
    await db.insert(invoicesTable).values({
      id: newId("inv"),
      orgId: invOrgId,
      invoiceNumber: `${RUN}-INV-001`,
      supplierId: invSupplierId,
      invoiceDate: lastWeek,
      amountUsd: "42000",
      status: "approved",
      dedupKey: `${RUN}-inv-1`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-inv-1`,
    });
    try {
      const result = toAnalyzeResult(
        await servicesRateCardBenchmarkLever.analyze({
          orgId: invOrgId,
          cycleId: "test-cycle",
        }),
      );
      const offInv = result.drafts.find(
        (d) =>
          (d.inputs as { flavor?: string }).flavor === "off_card_invoice" &&
          (d.inputs as { rateCardLineId?: string }).rateCardLineId ===
            invRateCardLineId,
      );
      assert.ok(
        offInv,
        `expected an off_card_invoice draft for the seeded invoice month`,
      );
      const inputs = offInv.inputs as Record<string, unknown>;
      assert.equal(Number(inputs["impliedHourlyRateUsd"]), 420);
      assert.equal(Number(inputs["cardHourlyRate"]), CARD_RATE);
      assert.equal(Number(inputs["observedHours"]), 100);
      assert.equal(
        offInv.rawProjectedSavingsUsd,
        (420 - CARD_RATE) * 100,
      );
    } finally {
      await db
        .delete(invoicesTable)
        .where(like(invoicesTable.sourceExternalId, `${RUN}-inv-%`));
      await db
        .delete(timeEntriesTable)
        .where(like(timeEntriesTable.sourceExternalId, `${RUN}-inv-%`));
      await db
        .delete(rateCardLinesTable)
        .where(eq(rateCardLinesTable.id, invRateCardLineId));
      await db
        .delete(rateCardsTable)
        .where(eq(rateCardsTable.id, invRateCardId));
      await db
        .delete(contractsTable)
        .where(eq(contractsTable.id, invContractId));
      await db
        .delete(suppliersTable)
        .where(eq(suppliersTable.id, invSupplierId));
      await db.delete(orgsTable).where(eq(orgsTable.id, invOrgId));
    }
  });

  it("honors RATE_CARD_BENCHMARK_PERCENTILE override (p75 fires lines above p75 that wouldn't trip p90)", async () => {
    // Seed a card line at $90/hr against an OEWS series with
    // p75=$80, p90=$100. Default (p90) won't fire ($90 < $100), but
    // a p75 override should fire ($90 >= $80).
    const ovOrgId = newId("org");
    await db.insert(orgsTable).values({
      id: ovOrgId,
      name: `${RUN} ov Org`,
      slug: `${RUN}-ov`,
    });
    const ovSupplierId = newId("sup");
    await db.insert(suppliersTable).values({
      id: ovSupplierId,
      orgId: ovOrgId,
      name: `${RUN} ov supplier`,
      normalizedName: `${RUN} ov supplier`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-ov-sup`,
    });
    const today = new Date();
    const inOneYear = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);
    const ovContractId = newId("con");
    await db.insert(contractsTable).values({
      id: ovContractId,
      orgId: ovOrgId,
      supplierId: ovSupplierId,
      contractNumber: `${RUN}-OV-MSA`,
      title: `${RUN} ov MSA`,
      status: "active",
      contractType: "t_and_m",
      startDate: today,
      endDate: inOneYear,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-ov-con`,
    });
    const ovRateCardId = newId("rc");
    await db.insert(rateCardsTable).values({
      id: ovRateCardId,
      orgId: ovOrgId,
      supplierId: ovSupplierId,
      contractId: ovContractId,
      name: `${RUN} card`,
      effectiveDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-ov-rc`,
    });
    const ovRateCardLineId = newId("rcl");
    const TWEENER_RATE = 90; // between p75 (80) and p90 (100)
    await db.insert(rateCardLinesTable).values({
      id: ovRateCardLineId,
      orgId: ovOrgId,
      rateCardId: ovRateCardId,
      role: "Software Developer",
      seniority: "Senior",
      hourlyRate: String(TWEENER_RATE),
    });
    // 100 hrs of time entries to make the savings non-trivial.
    await db.insert(timeEntriesTable).values({
      id: newId("te"),
      orgId: ovOrgId,
      supplierId: ovSupplierId,
      contractId: ovContractId,
      rateCardLineId: ovRateCardLineId,
      resource: `${RUN} ov dev`,
      role: "Software Developer",
      seniority: "Senior",
      workDate: today,
      hours: "100",
      billRateUsd: String(TWEENER_RATE),
      amountUsd: String(TWEENER_RATE * 100),
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-ov-te-1`,
    });
    // Reuse the OEWS signals seeded for the main supplier (they're
    // platform-wide, org_id NULL — the analyzer scopes to NULL).
    const prev = process.env.RATE_CARD_BENCHMARK_PERCENTILE;
    try {
      // Default (p90) — should NOT fire.
      delete process.env.RATE_CARD_BENCHMARK_PERCENTILE;
      const def = toAnalyzeResult(
        await servicesRateCardBenchmarkLever.analyze({
          orgId: ovOrgId,
          cycleId: "test-cycle",
        }),
      );
      const defAbove = def.drafts.find(
        (d) =>
          (d.inputs as { flavor?: string }).flavor === "above_market" &&
          (d.inputs as { rateCardLineId?: string }).rateCardLineId ===
            ovRateCardLineId,
      );
      assert.equal(
        defAbove,
        undefined,
        "default p90 threshold should not flag a $90 line under a $100 p90",
      );

      // Override to p75 — should fire.
      process.env.RATE_CARD_BENCHMARK_PERCENTILE = "p75";
      const overridden = toAnalyzeResult(
        await servicesRateCardBenchmarkLever.analyze({
          orgId: ovOrgId,
          cycleId: "test-cycle",
        }),
      );
      const ovAbove = overridden.drafts.find(
        (d) =>
          (d.inputs as { flavor?: string }).flavor === "above_market" &&
          (d.inputs as { rateCardLineId?: string }).rateCardLineId ===
            ovRateCardLineId,
      );
      assert.ok(
        ovAbove,
        "p75 override should flag a $90 line that exceeds the $80 p75",
      );
      assert.equal(
        (ovAbove.inputs as { thresholdBand?: string }).thresholdBand,
        "p75",
      );
    } finally {
      if (prev === undefined) delete process.env.RATE_CARD_BENCHMARK_PERCENTILE;
      else process.env.RATE_CARD_BENCHMARK_PERCENTILE = prev;
      await db
        .delete(timeEntriesTable)
        .where(like(timeEntriesTable.sourceExternalId, `${RUN}-ov-%`));
      await db
        .delete(rateCardLinesTable)
        .where(eq(rateCardLinesTable.id, ovRateCardLineId));
      await db
        .delete(rateCardsTable)
        .where(eq(rateCardsTable.id, ovRateCardId));
      await db
        .delete(contractsTable)
        .where(eq(contractsTable.id, ovContractId));
      await db
        .delete(suppliersTable)
        .where(eq(suppliersTable.id, ovSupplierId));
      await db.delete(orgsTable).where(eq(orgsTable.id, ovOrgId));
    }
  });

  it("returns silently for an org with no rate cards", async () => {
    const otherOrgId = newId("org");
    await db.insert(orgsTable).values({
      id: otherOrgId,
      name: `${RUN} Empty Org`,
      slug: `${RUN}-empty`,
    });
    try {
      const result = toAnalyzeResult(
        await servicesRateCardBenchmarkLever.analyze({
          orgId: otherOrgId,
          cycleId: "test-cycle",
        }),
      );
      assert.equal(result.drafts.length, 0);
      assert.equal(result.candidatesEvaluated, 0);
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
    for (const sigId of signalIds) {
      await safe(
        db.delete(marketSignalsTable).where(eq(marketSignalsTable.id, sigId)),
      );
    }
    if (collectorId) {
      await safe(
        db.delete(collectorsTable).where(eq(collectorsTable.id, collectorId)),
      );
    }
    if (orgId) {
      await safe(
        db
          .delete(timeEntriesTable)
          .where(like(timeEntriesTable.sourceExternalId, `${RUN}-%`)),
      );
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
          .delete(rateCardLinesTable)
          .where(eq(rateCardLinesTable.id, rateCardLineId)),
      );
      await safe(
        db
          .delete(rateCardsTable)
          .where(like(rateCardsTable.sourceExternalId, `${RUN}-%`)),
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
