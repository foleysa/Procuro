/**
 * Targeted coverage for the S2P (Source-to-Pay) fields and stage history
 * introduced in Task #284.
 *
 * Sections
 * --------
 * 1. Unit — gateSlaBreach: returns breaching:true exactly *past* the
 *    configured SLA boundary per stage; false at the boundary and for
 *    terminal / null-SLA stages.
 * 2. Unit — resolveDoaTier / resolveDoaTierNumber: returns tier 1/2/3/4 at
 *    the $5M / $1M / $250K thresholds and below $250K.
 * 3. Integration — approve / reject / execute / realize each write exactly
 *    one opportunity_stage_history row with transition_reason='STATUS_CHANGE'.
 * 4. Integration — the cycle INSERT SQL (cycle.ts Act step) sets the S2P
 *    defaults: canonical_stage='Identified', doa_tier derived from
 *    projected_savings_usd, baseline_method='Internal Estimate', and
 *    classification_needs_review=true.
 *
 * Tests in sections 3–4 require DATABASE_URL and a live schema.
 * Tests in sections 1–2 are pure unit tests (no DB).
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
// Allow the dev x-org-id header so the stage-history HTTP tests can bypass
// Clerk/API-key auth and target their isolated org directly.
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import {
  db,
  pool,
  orgsTable,
  suppliersTable,
  purchaseOrdersTable,
  poLinesTable,
  opportunitiesTable,
  opportunityStageHistoryTable,
  gateSlaBreach,
  resolveDoaTierNumber,
  resolveDoaTier,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import app from "../src/app";
import { newId } from "../src/lib/ids";
import { runAnalysisCycle } from "../src/lib/ooda/cycle";
import { bootstrapCategoryLeverMappings } from "../src/lib/intelligence/routing";

// ---------------------------------------------------------------------------
// Helpers shared by the HTTP integration tests
// ---------------------------------------------------------------------------

interface Handle {
  port: number;
  close: () => Promise<void>;
}

async function startServer(): Promise<Handle> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Could not bind ephemeral port");
  }
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Resp {
  status: number;
  body: unknown;
}

async function call(
  port: number,
  method: string,
  path: string,
  opts: { orgId?: string; body?: unknown } = {},
): Promise<Resp> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.orgId) headers["x-org-id"] = opts.orgId;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

async function cleanupOrg(orgId: string): Promise<void> {
  try {
    await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  } catch {
    // ignore — FK cascade handles child rows
  }
}

/**
 * Seed a minimal org + cycle + one opportunity row.
 * Returns the orgId, cycleId, and opportunityId for use in HTTP tests.
 *
 * Uses raw pool.query so the INSERT succeeds against the live schema
 * regardless of which optional columns drizzle declares.
 */
async function seedOppForTransition(
  runTag: string,
  status: "proposed" | "approved" | "executing",
): Promise<{ orgId: string; cycleId: string; oppId: string }> {
  const orgId = `org_s2p_${runTag}`;
  const cycleId = `cyc_s2p_${runTag}`;
  const oppId = `opp_s2p_${runTag}`;

  await db
    .insert(orgsTable)
    .values({ id: orgId, name: orgId, slug: orgId.replace(/_/g, "-") })
    .onConflictDoNothing();

  await pool.query(
    `INSERT INTO analysis_cycles
       (id, org_id, generation, triggered_by, status, started_at, completed_at)
     VALUES ($1, $2, 1, 'test', 'completed', now(), now())
     ON CONFLICT DO NOTHING`,
    [cycleId, orgId],
  );

  await pool.query(
    `INSERT INTO opportunities (
       id, org_id, cycle_id, lever_id, tier, title,
       rationale, recommended_action,
       raw_projected_savings_usd, projected_savings_usd, confidence,
       inputs, status,
       baseline_value, baseline_method
     )
     VALUES ($1,$2,$3,'supplier_consolidation',1,$4,
             'test','test',
             '1500000.00','1500000.00','0.7000',
             '{}'::jsonb, $5,
             '1500000.0000','Internal Estimate')
     ON CONFLICT DO NOTHING`,
    [oppId, orgId, cycleId, oppId, status],
  );

  return { orgId, cycleId, oppId };
}

/**
 * Load all stage_history rows for a given opportunity, ordered by
 * transitioned_at so tests can assert on position.
 */
async function loadStageHistory(
  orgId: string,
  oppId: string,
): Promise<
  Array<{
    fromStage: string | null;
    toStage: string;
    transitionReason: string | null;
  }>
> {
  const rows = await db
    .select({
      fromStage: opportunityStageHistoryTable.fromStage,
      toStage: opportunityStageHistoryTable.toStage,
      transitionReason: opportunityStageHistoryTable.transitionReason,
    })
    .from(opportunityStageHistoryTable)
    .where(
      and(
        eq(opportunityStageHistoryTable.orgId, orgId),
        eq(opportunityStageHistoryTable.opportunityId, oppId),
      ),
    );
  return rows;
}

// ===========================================================================
// Section 1 — Unit: gateSlaBreach
// ===========================================================================

describe("gateSlaBreach — boundary semantics per stage", () => {
  /**
   * Helper: returns a fixed `nowMs` and a `stageEnteredAt` that places the
   * opportunity exactly at (atBoundary=true) or just 1 ms past
   * (atBoundary=false) the given SLA.
   *
   * We pin `nowMs` so that the `gateSlaBreach` call uses the same instant
   * that we used to compute `stageEnteredAt`; without this, a few
   * microseconds elapse between building the date and calling the function,
   * causing the "exactly at boundary" case to spuriously report a breach.
   */
  function makeScenario(
    slaHours: number,
    atBoundary: boolean,
  ): { stageEnteredAt: Date; nowMs: number } {
    const nowMs = Date.now();
    const slaMs = slaHours * 60 * 60 * 1000;
    // elapsed = slaMs [exact] → not breaching, or slaMs + 1 ms → breaching
    const elapsed = atBoundary ? slaMs : slaMs + 1;
    return { stageEnteredAt: new Date(nowMs - elapsed), nowMs };
  }

  const stages: Array<{ stage: string; slaHours: number }> = [
    { stage: "Identified", slaHours: 72 },
    { stage: "Awarded", slaHours: 120 },
    { stage: "In Contracting", slaHours: 168 },
    { stage: "In Implementation", slaHours: 720 },
    { stage: "Under Re-evaluation", slaHours: 336 },
  ];

  for (const { stage, slaHours } of stages) {
    test(`${stage}: not breaching at exactly the SLA boundary (${slaHours}h)`, () => {
      const { stageEnteredAt, nowMs } = makeScenario(slaHours, true);
      const result = gateSlaBreach({ canonicalStage: stage, stageEnteredAt, nowMs });
      assert.equal(result.slaHours, slaHours, "slaHours should match config");
      assert.equal(result.breaching, false, "elapsed === slaHours must NOT breach (strict >)");
    });

    test(`${stage}: breaching 1 ms past the SLA boundary (${slaHours}h)`, () => {
      const { stageEnteredAt, nowMs } = makeScenario(slaHours, false);
      const result = gateSlaBreach({ canonicalStage: stage, stageEnteredAt, nowMs });
      assert.equal(result.slaHours, slaHours);
      assert.equal(result.breaching, true, "elapsed > slaHours must breach");
    });
  }

  test("Realized (terminal): never breaches regardless of elapsed time", () => {
    const result = gateSlaBreach({
      canonicalStage: "Realized",
      stageEnteredAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });
    assert.equal(result.slaHours, null);
    assert.equal(result.breaching, false);
  });

  test("Closed-No Action (terminal): never breaches regardless of elapsed time", () => {
    const result = gateSlaBreach({
      canonicalStage: "Closed-No Action",
      stageEnteredAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });
    assert.equal(result.slaHours, null);
    assert.equal(result.breaching, false);
  });

  test("null canonicalStage: never breaches", () => {
    const result = gateSlaBreach({
      canonicalStage: null,
      stageEnteredAt: new Date(Date.now() - 999 * 24 * 60 * 60 * 1000),
    });
    assert.equal(result.slaHours, null);
    assert.equal(result.breaching, false);
  });

  test("null stageEnteredAt: never breaches (avoids false positives on legacy rows)", () => {
    const result = gateSlaBreach({
      canonicalStage: "Identified",
      stageEnteredAt: null,
    });
    assert.equal(result.breaching, false);
  });

  test("nowMs override: can simulate future to force breach", () => {
    const slaHours = 72;
    const stageEnteredAt = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10h ago
    const futureNow = stageEnteredAt.getTime() + (slaHours + 1) * 60 * 60 * 1000;
    const result = gateSlaBreach({
      canonicalStage: "Identified",
      stageEnteredAt,
      nowMs: futureNow,
    });
    assert.equal(result.breaching, true, "simulated future past SLA must breach");
  });
});

// ===========================================================================
// Section 2 — Unit: resolveDoaTier / resolveDoaTierNumber
// ===========================================================================

describe("resolveDoaTier / resolveDoaTierNumber — tier ladder thresholds", () => {
  test("$5,000,000 exactly → Tier 1 (Strategic, ≥ $5M)", () => {
    assert.equal(resolveDoaTierNumber(5_000_000), 1);
    assert.equal(resolveDoaTier(5_000_000).tier, 1);
    assert.equal(resolveDoaTier(5_000_000).approverRole, "board");
  });

  test("$5,000,001 → Tier 1 (above the $5M threshold)", () => {
    assert.equal(resolveDoaTierNumber(5_000_001), 1);
  });

  test("$4,999,999 → Tier 2 (just below $5M)", () => {
    assert.equal(resolveDoaTierNumber(4_999_999), 2);
    assert.equal(resolveDoaTier(4_999_999).tier, 2);
    assert.equal(resolveDoaTier(4_999_999).approverRole, "c_suite");
  });

  test("$1,000,000 exactly → Tier 2 (Major, ≥ $1M < $5M)", () => {
    assert.equal(resolveDoaTierNumber(1_000_000), 2);
    assert.equal(resolveDoaTier(1_000_000).tier, 2);
  });

  test("$999,999 → Tier 3 (just below $1M)", () => {
    assert.equal(resolveDoaTierNumber(999_999), 3);
    assert.equal(resolveDoaTier(999_999).tier, 3);
    assert.equal(resolveDoaTier(999_999).approverRole, "vp");
  });

  test("$250,000 exactly → Tier 3 (Significant, ≥ $250K < $1M)", () => {
    assert.equal(resolveDoaTierNumber(250_000), 3);
    assert.equal(resolveDoaTier(250_000).tier, 3);
  });

  test("$249,999 → Tier 4 (just below $250K)", () => {
    assert.equal(resolveDoaTierNumber(249_999), 4);
    assert.equal(resolveDoaTier(249_999).tier, 4);
    assert.equal(resolveDoaTier(249_999).approverRole, "manager");
  });

  test("$0 → Tier 4 (Standard, below $250K)", () => {
    assert.equal(resolveDoaTierNumber(0), 4);
    assert.equal(resolveDoaTier(0).tier, 4);
  });

  test("negative value → Tier 4 (clamped to lowest tier)", () => {
    assert.equal(resolveDoaTierNumber(-1), 4);
  });
});

// ===========================================================================
// Section 3 — Integration: stage-history rows on each action endpoint
//
// Each sub-test seeds an opportunity in the required source status, calls
// the relevant endpoint via HTTP (dev x-org-id header), then asserts
// exactly one opportunity_stage_history row was written with
// transition_reason = 'STATUS_CHANGE'.
// ===========================================================================

describe("stage history written on every status transition", () => {
  let handle: Handle;

  test.before(async () => {
    handle = await startServer();
  });

  test.after(async () => {
    await handle.close();
  });

  test("POST /opportunities/:id/approve writes one stage_history row (STATUS_CHANGE)", async (t) => {
    if (!process.env["DATABASE_URL"]) {
      t.skip("DATABASE_URL required");
      return;
    }
    const tag = `appr-${Date.now()}-${process.pid}`;
    const { orgId, oppId } = await seedOppForTransition(tag, "proposed");
    t.after(() => cleanupOrg(orgId));

    const res = await call(handle.port, "POST", `/api/opportunities/${oppId}/approve`, {
      orgId,
    });
    assert.equal(res.status, 200, `approve returned ${res.status}: ${JSON.stringify(res.body)}`);

    const history = await loadStageHistory(orgId, oppId);
    assert.equal(history.length, 1, "exactly one stage_history row after approve");
    assert.equal(history[0]!.transitionReason, "STATUS_CHANGE");
    assert.equal(history[0]!.toStage, "Awarded");
  });

  test("POST /opportunities/:id/reject writes one stage_history row (STATUS_CHANGE)", async (t) => {
    if (!process.env["DATABASE_URL"]) {
      t.skip("DATABASE_URL required");
      return;
    }
    const tag = `rej-${Date.now()}-${process.pid}`;
    const { orgId, oppId } = await seedOppForTransition(tag, "proposed");
    t.after(() => cleanupOrg(orgId));

    const res = await call(handle.port, "POST", `/api/opportunities/${oppId}/reject`, {
      orgId,
      body: { reasonCode: "data_quality_issue" },
    });
    assert.equal(res.status, 200, `reject returned ${res.status}: ${JSON.stringify(res.body)}`);

    const history = await loadStageHistory(orgId, oppId);
    assert.equal(history.length, 1, "exactly one stage_history row after reject");
    assert.equal(history[0]!.transitionReason, "STATUS_CHANGE");
    assert.equal(history[0]!.toStage, "Closed-No Action");
  });

  test("POST /opportunities/:id/execute writes one stage_history row (STATUS_CHANGE)", async (t) => {
    if (!process.env["DATABASE_URL"]) {
      t.skip("DATABASE_URL required");
      return;
    }
    const tag = `exec-${Date.now()}-${process.pid}`;
    const { orgId, oppId } = await seedOppForTransition(tag, "approved");
    t.after(() => cleanupOrg(orgId));

    const res = await call(handle.port, "POST", `/api/opportunities/${oppId}/execute`, {
      orgId,
    });
    assert.equal(res.status, 200, `execute returned ${res.status}: ${JSON.stringify(res.body)}`);

    const history = await loadStageHistory(orgId, oppId);
    assert.equal(history.length, 1, "exactly one stage_history row after execute");
    assert.equal(history[0]!.transitionReason, "STATUS_CHANGE");
    assert.equal(history[0]!.toStage, "In Implementation");
  });

  test("POST /opportunities/:id/realize writes one stage_history row (STATUS_CHANGE)", async (t) => {
    if (!process.env["DATABASE_URL"]) {
      t.skip("DATABASE_URL required");
      return;
    }
    const tag = `real-${Date.now()}-${process.pid}`;
    const { orgId, oppId } = await seedOppForTransition(tag, "executing");
    t.after(() => cleanupOrg(orgId));

    const res = await call(handle.port, "POST", `/api/opportunities/${oppId}/realize`, {
      orgId,
      body: { realizedSavingsUsd: 1_250_000 },
    });
    assert.equal(res.status, 200, `realize returned ${res.status}: ${JSON.stringify(res.body)}`);

    const history = await loadStageHistory(orgId, oppId);
    assert.equal(history.length, 1, "exactly one stage_history row after realize");
    assert.equal(history[0]!.transitionReason, "STATUS_CHANGE");
    assert.equal(history[0]!.toStage, "Realized");
  });
});

// ===========================================================================
// Section 4 — Integration: runAnalysisCycle Act step populates S2P defaults
//
// Seeds a minimal org + 1 supplier + 3 purchase orders + 3 po_lines (same
// SKU, ≥10% price spread, >$5K spend, po_count ≥ 3) so the real
// sku_price_benchmark lever fires.  Then calls runAnalysisCycle end-to-end
// (Observe → Learn → Orient → Decide → Act) and reads back every newly
// created opportunity to assert the S2P defaults written by cycle.ts Act
// step lines ~542–549:
//   canonical_stage             = 'Identified'
//   baseline_method             = 'Internal Estimate'
//   classification_needs_review = true
//   doa_tier derived from projectedSavingsUsd via resolveDoaTierNumber
//
// This test goes through the production cycle.ts code path, so any regression
// in the real INSERT logic (e.g. a missing S2P column, a wrong default literal)
// will be caught here.
// ===========================================================================

test("runAnalysisCycle: Act step sets S2P defaults on new opportunities", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    t.skip("DATABASE_URL required");
    return;
  }

  const tag = `cycs2p-${Date.now()}-${process.pid}`;
  const orgId = `org_${tag}`;

  // v_category_lever_mappings is required by the band-filter gate inside
  // runAnalysisCycle. bootstrapCategoryLeverMappings is idempotent — safe to
  // call even if a prior test already created the view.
  await bootstrapCategoryLeverMappings();

  await db.insert(orgsTable).values({ id: orgId, name: orgId, slug: orgId.replace(/_/g, "-") });
  t.after(() => cleanupOrg(orgId));

  // One supplier is enough — sku_price_benchmark groups by SKU across all POs.
  const supplierId = `sup_${tag}`;
  await db.insert(suppliersTable).values({
    id: supplierId,
    orgId,
    name: "S2P Cycle Test Supplier",
    normalizedName: "s2p cycle test supplier",
    sourceSystem: "test",
    sourceExternalId: `${tag}-sup`,
  });

  // Seed 3 POs with 1 po_line each.  Same SKU, prices $1 000 / $1 500 / $2 000.
  //   max (2 000) > min (1 000) × 1.10  →  spread check passes
  //   total spend $4.5M               →  $5 000 threshold passes
  //   po_count = 3                    →  count threshold passes
  //   savings = (avg 1 500 − min 1 000) × qty 3 000 = $1 500 000  →  Tier 2
  const sku = `SKU-S2P-${tag}`;
  const prices = [1000, 1500, 2000];
  const lineQty = 1000;

  for (let i = 0; i < 3; i++) {
    const poId = `po_${tag}_${i}`;
    await db.insert(purchaseOrdersTable).values({
      id: poId,
      orgId,
      poNumber: `PO-${tag}-${i}`,
      supplierId,
      orderDate: new Date(),
      totalUsd: (prices[i]! * lineQty).toFixed(2),
      sourceSystem: "test",
      sourceExternalId: `${tag}-po-${i}`,
    });
    await db.insert(poLinesTable).values({
      id: `pol_${tag}_${i}`,
      orgId,
      poId,
      lineNumber: 1,
      sku,
      description: "S2P cycle test item",
      spendClass: "direct",
      qty: lineQty.toFixed(4),
      unitPriceUsd: prices[i]!.toFixed(4),
      extendedUsd: (prices[i]! * lineQty).toFixed(2),
      orderDate: new Date(),
      sourceSystem: "test",
      sourceExternalId: `${tag}-pol-${i}`,
    });
  }

  const result = await runAnalysisCycle({ orgId, triggeredBy: "test-s2p" });

  assert.ok(
    result.opportunitiesCreated >= 1,
    `sku_price_benchmark lever must create ≥1 opportunity; got ${result.opportunitiesCreated}`,
  );

  const opps = await db
    .select({
      canonicalStage: opportunitiesTable.canonicalStage,
      doaTier: opportunitiesTable.doaTier,
      baselineMethod: opportunitiesTable.baselineMethod,
      classificationNeedsReview: opportunitiesTable.classificationNeedsReview,
      projectedSavingsUsd: opportunitiesTable.projectedSavingsUsd,
    })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.orgId, orgId),
        eq(opportunitiesTable.leverId, "sku_price_benchmark"),
      ),
    );

  assert.ok(opps.length >= 1, "at least one sku_price_benchmark opportunity must be stored");

  for (const opp of opps) {
    assert.equal(
      opp.canonicalStage,
      "Identified",
      "cycle Act step must set canonical_stage = 'Identified' on every new opportunity",
    );
    assert.equal(
      opp.baselineMethod,
      "Internal Estimate",
      "cycle Act step must set baseline_method = 'Internal Estimate'",
    );
    assert.equal(
      opp.classificationNeedsReview,
      true,
      "cycle Act step must set classification_needs_review = true so Finance must review before the row counts as Hard savings",
    );
    const expectedTier = resolveDoaTierNumber(Number(opp.projectedSavingsUsd));
    assert.equal(
      opp.doaTier,
      expectedTier,
      `doa_tier must equal resolveDoaTierNumber(${opp.projectedSavingsUsd}) = ${expectedTier}`,
    );
  }
});

// Also verify the DOA tier thresholds that the cycle uses to compute
// doa_tier in the INSERT (resolveDoaTierNumber is called by cycle.ts Act step).
describe("cycle doa_tier ladder — resolveDoaTierNumber thresholds", () => {
  const cases: Array<{ savings: number; expectedTier: 1 | 2 | 3 | 4 }> = [
    { savings: 5_000_000, expectedTier: 1 },
    { savings: 2_500_000, expectedTier: 2 },
    { savings: 500_000, expectedTier: 3 },
    { savings: 100_000, expectedTier: 4 },
  ];

  for (const { savings, expectedTier } of cases) {
    test(`$${savings.toLocaleString()} projected savings → doa_tier ${expectedTier} via resolveDoaTierNumber`, () => {
      assert.equal(resolveDoaTierNumber(savings), expectedTier);
    });
  }
});
