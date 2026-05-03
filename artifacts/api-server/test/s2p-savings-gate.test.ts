/**
 * Integration tests for the S2P Hard Savings aggregate gate ("CFO insurance")
 * and the full 5-stage opportunity lifecycle.
 *
 * These tests require DATABASE_URL and a live schema (the `pretest` hook in
 * package.json runs `@workspace/db sync` before tests execute).
 *
 * Key coverage:
 *   1. Hard Savings total EXCLUDES records with classification_needs_review=true
 *   2. All-review-flagged records produce $0 total
 *   3. Full 5-stage lifecycle produces correct ordered history rows
 *   4. stage_entered_at updates on each transition
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import {
  db,
  pool,
  orgsTable,
  opportunitiesTable,
  opportunityStageHistoryTable,
  computeHardSavingsTotal,
  type InsertOpportunityRow,
} from "@workspace/db";
import { makeOpportunity } from "@workspace/db/test-fixtures";
import { eq, and, asc } from "drizzle-orm";
import app from "../src/app";
import { newId } from "../src/lib/ids";

// Dev-mode requests with x-org-id header land in the `dev-header` auth path,
// which sets req.actorEmail = "system@procuro.ai". This is the actor value
// the route stamps into opportunity_stage_history.transitioned_by_user_id.
const EXPECTED_DEV_ACTOR = "system@procuro.ai";

// ---------------------------------------------------------------------------
// Helpers
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

async function call(
  port: number,
  method: string,
  path: string,
  opts: { orgId?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
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
    // FK cascade handles child rows
  }
}

async function seedOrg(orgId: string): Promise<void> {
  await db
    .insert(orgsTable)
    .values({ id: orgId, name: orgId, slug: orgId.replace(/_/g, "-") })
    .onConflictDoNothing();
}

async function seedCycle(cycleId: string, orgId: string): Promise<void> {
  await pool.query(
    `INSERT INTO analysis_cycles
       (id, org_id, generation, triggered_by, status, started_at, completed_at)
     VALUES ($1, $2, 1, 'test', 'completed', now(), now())
     ON CONFLICT DO NOTHING`,
    [cycleId, orgId],
  );
}

/**
 * Typed insert helper using the shared lib/db `makeOpportunity` factory.
 * Provides default values for required columns and accepts overrides for
 * fields under test. Drizzle gives us compile-time type checking against
 * `InsertOpportunityRow`, so schema drift is caught by the typecheck step
 * rather than failing at runtime.
 */
async function insertOpp(
  overrides: Partial<InsertOpportunityRow> &
    Pick<InsertOpportunityRow, "id" | "orgId" | "cycleId">,
): Promise<void> {
  const row = makeOpportunity({
    leverId: "supplier_consolidation",
    confidence: "0.7000",
    ...overrides,
  });
  await db.insert(opportunitiesTable).values(row).onConflictDoNothing();
}

// ===========================================================================
// Section 1 — CFO Insurance: Hard Savings aggregate gate
// ===========================================================================

describe("computeHardSavingsTotal — aggregate gate (CFO insurance)", () => {
  test("excludes classification_needs_review=true records from Hard Savings total", async (t) => {
    if (!process.env["DATABASE_URL"]) {
      t.skip("DATABASE_URL required");
      return;
    }

    const tag = `cfo-${Date.now()}-${process.pid}`;
    const orgId = `org_${tag}`;
    const cycleId = `cyc_${tag}`;

    await seedOrg(orgId);
    await seedCycle(cycleId, orgId);
    t.after(() => cleanupOrg(orgId));

    await insertOpp({
      id: `opp_reviewed_${tag}`,
      orgId,
      cycleId,
      status: "realized",
      projectedSavingsUsd: "1000000.00",
      realizedSavingsUsd: "1000000.00",
      savingsClassification: "Hard",
      classificationNeedsReview: false,
      canonicalStage: "Realized",
      savingsType: "Realized",
    });

    await insertOpp({
      id: `opp_backfill_${tag}`,
      orgId,
      cycleId,
      status: "realized",
      projectedSavingsUsd: "5000000.00",
      realizedSavingsUsd: "5000000.00",
      savingsClassification: "Hard",
      classificationNeedsReview: true,
      canonicalStage: "Realized",
      savingsType: "Realized",
    });

    const total = await computeHardSavingsTotal(db, orgId);
    assert.equal(
      total,
      1_000_000,
      "Hard Savings total must EXCLUDE backfilled (classification_needs_review=true) records; expected $1M, not $6M",
    );
  });

  test("all-review-flagged records produce $0 total", async (t) => {
    if (!process.env["DATABASE_URL"]) {
      t.skip("DATABASE_URL required");
      return;
    }

    const tag = `cfo0-${Date.now()}-${process.pid}`;
    const orgId = `org_${tag}`;
    const cycleId = `cyc_${tag}`;

    await seedOrg(orgId);
    await seedCycle(cycleId, orgId);
    t.after(() => cleanupOrg(orgId));

    await insertOpp({
      id: `opp_bf1_${tag}`,
      orgId,
      cycleId,
      status: "realized",
      projectedSavingsUsd: "2000000.00",
      realizedSavingsUsd: "2000000.00",
      savingsClassification: "Hard",
      classificationNeedsReview: true,
      canonicalStage: "Realized",
      savingsType: "Realized",
    });

    await insertOpp({
      id: `opp_bf2_${tag}`,
      orgId,
      cycleId,
      status: "realized",
      projectedSavingsUsd: "3000000.00",
      realizedSavingsUsd: "3000000.00",
      savingsClassification: "Hard",
      classificationNeedsReview: true,
      canonicalStage: "Realized",
      savingsType: "Realized",
    });

    const total = await computeHardSavingsTotal(db, orgId);
    assert.equal(
      total,
      0,
      "When ALL Hard/Realized records have classification_needs_review=true, total must be $0",
    );
  });

  test("non-Hard classifications are excluded from Hard Savings total", async (t) => {
    if (!process.env["DATABASE_URL"]) {
      t.skip("DATABASE_URL required");
      return;
    }

    const tag = `cfonh-${Date.now()}-${process.pid}`;
    const orgId = `org_${tag}`;
    const cycleId = `cyc_${tag}`;

    await seedOrg(orgId);
    await seedCycle(cycleId, orgId);
    t.after(() => cleanupOrg(orgId));

    await insertOpp({
      id: `opp_hard_${tag}`,
      orgId,
      cycleId,
      status: "realized",
      projectedSavingsUsd: "500000.00",
      realizedSavingsUsd: "500000.00",
      savingsClassification: "Hard",
      classificationNeedsReview: false,
      canonicalStage: "Realized",
      savingsType: "Realized",
    });

    await insertOpp({
      id: `opp_soft_${tag}`,
      orgId,
      cycleId,
      status: "realized",
      projectedSavingsUsd: "300000.00",
      realizedSavingsUsd: "300000.00",
      savingsClassification: "Soft",
      classificationNeedsReview: false,
      canonicalStage: "Realized",
      savingsType: "Realized",
    });

    const total = await computeHardSavingsTotal(db, orgId);
    assert.equal(
      total,
      500_000,
      "Hard Savings total must only include Hard classification records",
    );
  });
});

// ===========================================================================
// Section 2 — Full 5-stage lifecycle with history and stage_entered_at
// ===========================================================================

describe("full 5-stage lifecycle", () => {
  let handle: Handle;

  test.before(async () => {
    handle = await startServer();
  });

  test.after(async () => {
    await handle.close();
  });

  /**
   * Tests the API-driven lifecycle: propose → approve → execute → realize,
   * which produces canonical stages Identified → Awarded → In Implementation
   * → Realized. The "In Contracting" stage has no dedicated API route yet
   * (approved transitions directly to executing); it is exercised by the
   * separate "data model supports In Contracting" test below.
   *
   * Asserts: from_stage, to_stage, transition_reason, transitioned_by_user_id
   * (= "system@procuro.ai" in dev-header auth mode), and stage_entered_at
   * monotonic advancement at each step.
   */
  test("Identified→Awarded→In Implementation→Realized: API lifecycle with from_stage, to_stage, and actor", async (t) => {
    if (!process.env["DATABASE_URL"]) {
      t.skip("DATABASE_URL required");
      return;
    }

    const tag = `lc-${Date.now()}-${process.pid}`;
    const orgId = `org_${tag}`;
    const cycleId = `cyc_${tag}`;
    const oppId = `opp_${tag}`;

    await seedOrg(orgId);
    await seedCycle(cycleId, orgId);
    t.after(() => cleanupOrg(orgId));

    await insertOpp({
      id: oppId,
      orgId,
      cycleId,
      title: oppId,
      status: "proposed",
      projectedSavingsUsd: "1500000.00",
      canonicalStage: "Identified",
      savingsType: "Identified",
      doaTier: 2,
    });

    // --- Step 1: approve (Identified → Awarded) ---
    const approve = await call(
      handle.port,
      "POST",
      `/api/opportunities/${oppId}/approve`,
      { orgId },
    );
    assert.equal(approve.status, 200, `approve failed: ${JSON.stringify(approve.body)}`);

    const [afterApprove] = await db
      .select({
        canonicalStage: opportunitiesTable.canonicalStage,
        stageEnteredAt: opportunitiesTable.stageEnteredAt,
      })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, oppId));
    assert.equal(afterApprove!.canonicalStage, "Awarded");
    assert.ok(afterApprove!.stageEnteredAt, "stage_entered_at must be set after approve");
    const approveTs = afterApprove!.stageEnteredAt!.getTime();

    await new Promise((r) => setTimeout(r, 50));

    // --- Step 2: execute (Awarded → In Implementation) ---
    const execute = await call(
      handle.port,
      "POST",
      `/api/opportunities/${oppId}/execute`,
      { orgId },
    );
    assert.equal(execute.status, 200, `execute failed: ${JSON.stringify(execute.body)}`);

    const [afterExecute] = await db
      .select({
        canonicalStage: opportunitiesTable.canonicalStage,
        stageEnteredAt: opportunitiesTable.stageEnteredAt,
      })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, oppId));
    assert.equal(afterExecute!.canonicalStage, "In Implementation");
    const executeTs = afterExecute!.stageEnteredAt!.getTime();
    assert.ok(
      executeTs >= approveTs,
      "stage_entered_at must advance on execute",
    );

    await new Promise((r) => setTimeout(r, 50));

    // --- Step 3: realize (In Implementation → Realized) ---
    const realize = await call(
      handle.port,
      "POST",
      `/api/opportunities/${oppId}/realize`,
      { orgId, body: { realizedSavingsUsd: 1_250_000 } },
    );
    assert.equal(realize.status, 200, `realize failed: ${JSON.stringify(realize.body)}`);

    const [afterRealize] = await db
      .select({
        canonicalStage: opportunitiesTable.canonicalStage,
        stageEnteredAt: opportunitiesTable.stageEnteredAt,
      })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, oppId));
    assert.equal(afterRealize!.canonicalStage, "Realized");
    const realizeTs = afterRealize!.stageEnteredAt!.getTime();
    assert.ok(
      realizeTs >= executeTs,
      "stage_entered_at must advance on realize",
    );

    // --- Assert history rows: from_stage, to_stage, reason, actor ---
    const history = await db
      .select({
        fromStage: opportunityStageHistoryTable.fromStage,
        toStage: opportunityStageHistoryTable.toStage,
        transitionReason: opportunityStageHistoryTable.transitionReason,
        transitionedByUserId:
          opportunityStageHistoryTable.transitionedByUserId,
      })
      .from(opportunityStageHistoryTable)
      .where(
        and(
          eq(opportunityStageHistoryTable.orgId, orgId),
          eq(opportunityStageHistoryTable.opportunityId, oppId),
        ),
      )
      .orderBy(asc(opportunityStageHistoryTable.transitionedAt));

    assert.equal(history.length, 3, "3 transitions: approve, execute, realize");

    // Transition 1: Identified → Awarded
    assert.equal(history[0]!.fromStage, "Identified", "approve from_stage must be Identified");
    assert.equal(history[0]!.toStage, "Awarded", "approve to_stage must be Awarded");
    assert.equal(history[0]!.transitionReason, "STATUS_CHANGE");
    assert.equal(
      history[0]!.transitionedByUserId,
      EXPECTED_DEV_ACTOR,
      `approve must stamp actor = req.actorEmail (${EXPECTED_DEV_ACTOR}) in dev-header mode`,
    );

    // Transition 2: Awarded → In Implementation
    assert.equal(history[1]!.fromStage, "Awarded", "execute from_stage must be Awarded");
    assert.equal(history[1]!.toStage, "In Implementation", "execute to_stage must be In Implementation");
    assert.equal(history[1]!.transitionReason, "STATUS_CHANGE");
    assert.equal(
      history[1]!.transitionedByUserId,
      EXPECTED_DEV_ACTOR,
      `execute must stamp actor = req.actorEmail (${EXPECTED_DEV_ACTOR})`,
    );

    // Transition 3: In Implementation → Realized
    assert.equal(history[2]!.fromStage, "In Implementation", "realize from_stage must be In Implementation");
    assert.equal(history[2]!.toStage, "Realized", "realize to_stage must be Realized");
    assert.equal(history[2]!.transitionReason, "STATUS_CHANGE");
    assert.equal(
      history[2]!.transitionedByUserId,
      EXPECTED_DEV_ACTOR,
      `realize must stamp actor = req.actorEmail (${EXPECTED_DEV_ACTOR})`,
    );
  });

  /**
   * Validates the data model supports the FULL 5-stage canonical lifecycle
   * including "In Contracting", which has no API route yet. We exercise the
   * stage by directly writing the opportunity_stage_history row and
   * advancing canonical_stage + stage_entered_at — the same operations a
   * future contracting endpoint would perform — and assert the schema
   * accepts the value and history rows are ordered correctly across all
   * 5 stages: Identified → Awarded → In Contracting → In Implementation
   * → Realized.
   */
  test("data model supports full 5-stage lifecycle including In Contracting", async (t) => {
    if (!process.env["DATABASE_URL"]) {
      t.skip("DATABASE_URL required");
      return;
    }

    const tag = `lc5-${Date.now()}-${process.pid}`;
    const orgId = `org_${tag}`;
    const cycleId = `cyc_${tag}`;
    const oppId = `opp_${tag}`;
    const actor = "contracting-test@procuro.ai";

    await seedOrg(orgId);
    await seedCycle(cycleId, orgId);
    t.after(() => cleanupOrg(orgId));

    await insertOpp({
      id: oppId,
      orgId,
      cycleId,
      title: oppId,
      status: "proposed",
      projectedSavingsUsd: "2000000.00",
      canonicalStage: "Identified",
      savingsType: "Identified",
    });

    const stages = [
      { from: "Identified", to: "Awarded", reason: "STATUS_CHANGE" },
      { from: "Awarded", to: "In Contracting", reason: "CONTRACT_SIGNED" },
      { from: "In Contracting", to: "In Implementation", reason: "STATUS_CHANGE" },
      { from: "In Implementation", to: "Realized", reason: "STATUS_CHANGE" },
    ] as const;

    const stageTimestamps: number[] = [];

    for (const step of stages) {
      const now = new Date();
      await db
        .update(opportunitiesTable)
        .set({ canonicalStage: step.to, stageEnteredAt: now })
        .where(eq(opportunitiesTable.id, oppId));

      await db.insert(opportunityStageHistoryTable).values({
        id: newId("sh"),
        opportunityId: oppId,
        orgId,
        fromStage: step.from,
        toStage: step.to,
        transitionedAt: now,
        transitionedByUserId: actor,
        transitionReason: step.reason,
      });

      stageTimestamps.push(now.getTime());
      // Ensure a strictly increasing transitioned_at sequence
      await new Promise((r) => setTimeout(r, 10));
    }

    // Final state must be Realized
    const [finalRow] = await db
      .select({
        canonicalStage: opportunitiesTable.canonicalStage,
        stageEnteredAt: opportunitiesTable.stageEnteredAt,
      })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, oppId));
    assert.equal(finalRow!.canonicalStage, "Realized");
    assert.ok(finalRow!.stageEnteredAt, "final stage_entered_at must be set");

    // Assert all 4 history rows in canonical order with full from/to/actor
    const history = await db
      .select({
        fromStage: opportunityStageHistoryTable.fromStage,
        toStage: opportunityStageHistoryTable.toStage,
        transitionReason: opportunityStageHistoryTable.transitionReason,
        transitionedByUserId:
          opportunityStageHistoryTable.transitionedByUserId,
        transitionedAt: opportunityStageHistoryTable.transitionedAt,
      })
      .from(opportunityStageHistoryTable)
      .where(
        and(
          eq(opportunityStageHistoryTable.orgId, orgId),
          eq(opportunityStageHistoryTable.opportunityId, oppId),
        ),
      )
      .orderBy(asc(opportunityStageHistoryTable.transitionedAt));

    assert.equal(history.length, 4, "4 transitions across 5 stages");

    for (let i = 0; i < stages.length; i++) {
      const expected = stages[i]!;
      const actual = history[i]!;
      assert.equal(actual.fromStage, expected.from, `step ${i} from_stage`);
      assert.equal(actual.toStage, expected.to, `step ${i} to_stage`);
      assert.equal(actual.transitionReason, expected.reason, `step ${i} reason`);
      assert.equal(
        actual.transitionedByUserId,
        actor,
        `step ${i} must record explicit actor`,
      );
    }

    // Specifically verify the In Contracting transition exists
    const contractingTransition = history.find(
      (h) => h.toStage === "In Contracting",
    );
    assert.ok(
      contractingTransition,
      "schema must support In Contracting as a valid canonical_stage in stage history",
    );
    assert.equal(contractingTransition!.fromStage, "Awarded");
    assert.equal(contractingTransition!.transitionedByUserId, actor);
  });
});
