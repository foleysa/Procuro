import {
  db,
  analysisCyclesTable,
  opportunitiesTable,
  decisionsTable,
  type LeverId,
  type OpportunityRow,
  type AnalysisCycleRow,
} from "@workspace/db";
import { eq, and, asc, desc, gt, lte, sql } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";
import { CANCELLED_ERROR_MESSAGE } from "../jobs/queue";
import { ALL_LEVERS } from "../levers";
import {
  applyLearnUpdates,
  ensurePriorsBootstrapped,
  loadActiveExclusions,
  loadPriors,
  type OutcomeStats,
  type PriorDelta,
  type ExclusionDelta,
  type PriorMap,
} from "./priors";
import {
  toAnalyzeResult,
  type AnalyzeResult,
  type LeverAnalyzer,
  type OpportunityDraft,
} from "../levers/types";
import { captureFunnelSnapshot } from "./funnel";

export interface RunCycleResult {
  cycleId: string;
  generation: number;
  opportunitiesCreated: number;
  totalProjectedUsd: number;
  priorDeltas: PriorDelta[];
  exclusionDeltas: ExclusionDelta[];
}

/**
 * Run a full OODA cycle for a tenant.
 * Observe → Orient → Decide → Act → Learn (Learn applies to outcomes from
 * the previous cycle and shapes the priors used by THIS cycle).
 *
 * Concrete order:
 *   1. Observe: snapshot data + outcome events since last cycle.
 *   2. Learn (from previous cycle's outcomes): apply weighted updates to
 *      priors and exclusion rules — this updates the priors loaded next.
 *   3. Orient: load now-current priors + active exclusion rules.
 *   4. Decide: run all lever analyzers, apply priors, drop exclusions, rank.
 *   5. Act: persist opportunities. Approvals/rejections/realizations after
 *      this cycle will feed the NEXT cycle's Learn step.
 */
export async function runAnalysisCycle(args: {
  orgId: string;
  triggeredBy: string;
  /**
   * Optional cooperative-cancellation hook. Wired up by the job worker as
   * `() => isJobCancelRequested(job.id)` so an operator pressing Cancel
   * on the System / Jobs page short-circuits a running cycle within
   * seconds at the next phase / lever / opportunity boundary instead of
   * waiting for every analyzer to finish. We deliberately check between
   * phases (Observe / Learn / Orient / Decide / Act) and inside the per-
   * lever and per-opportunity loops — these are the only safe spots:
   * the cycle row is already in `running`, and bailing out causes the
   * surrounding `try/catch` to flip it to `failed` along with the
   * job itself. Direct callers (REST routes) just don't pass this.
   */
  isCancelled?: () => Promise<boolean>;
}): Promise<RunCycleResult> {
  const { orgId, triggeredBy, isCancelled } = args;
  const checkpoint = async (): Promise<void> => {
    if (isCancelled && (await isCancelled())) {
      throw new Error(CANCELLED_ERROR_MESSAGE);
    }
  };

  await ensurePriorsBootstrapped(orgId);

  // --- Determine generation ---
  const [last] = await db
    .select({ generation: analysisCyclesTable.generation, id: analysisCyclesTable.id })
    .from(analysisCyclesTable)
    .where(eq(analysisCyclesTable.orgId, orgId))
    .orderBy(desc(analysisCyclesTable.generation))
    .limit(1);
  const generation = (last?.generation ?? 0) + 1;
  const cycleId = newId("cyc");
  const previousCycleId = last?.id ?? null;

  // --- Insert running cycle stub ---
  await db.insert(analysisCyclesTable).values({
    id: cycleId,
    orgId,
    generation,
    triggeredBy,
    status: "running",
  });

  try {
    await checkpoint();
    // --- 1. Observe ---
    const observe = await observeStep(orgId, previousCycleId);

    await checkpoint();
    // --- 2. Learn (from outcomes since previous cycle) ---
    const outcomes = await collectOutcomesSinceLastCycle(
      orgId,
      previousCycleId,
    );
    const priorsBeforeLearn = await loadPriors(orgId);
    const { priorDeltas, exclusionDeltas } = await applyLearnUpdates({
      orgId,
      cycleId,
      cycleGeneration: generation,
      outcomes,
    });

    await checkpoint();
    // --- 3. Orient ---
    const priors = await loadPriors(orgId);
    const exclusions = await loadActiveExclusions(orgId);
    const orientPayload = {
      priors,
      priorsDiffVsPrevious: diffPriors(priorsBeforeLearn, priors),
      activeExclusionCount: exclusions.length,
    };

    await checkpoint();
    // --- 4. Decide ---
    // Per-lever analyzers are the slowest part of a typical cycle, so
    // checkpoint between each one to get sub-second cancel response on
    // big tenants.
    //
    // We retain per-lever AnalyzeResult and the per-lever draft mapping
    // so the funnel snapshot writer (downstream) can attribute signals
    // → drafts → persisted opportunities along the actual lever lineage
    // instead of guessing post-hoc from opportunity rows.
    const leverResults: Array<{ lever: LeverAnalyzer; result: AnalyzeResult }> = [];
    const drafts: {
      lever: LeverAnalyzer;
      draft: OpportunityDraft;
      rank: number;
    }[] = [];
    for (const lever of ALL_LEVERS) {
      await checkpoint();
      const rawResult = await lever.analyze({ orgId, cycleId });
      const result = toAnalyzeResult(rawResult);
      leverResults.push({ lever, result });
      for (const d of result.drafts) {
        if (
          exclusions.some(
            (e) =>
              (e.leverId === null || e.leverId === d.leverId) &&
              (e.supplierId === null || e.supplierId === (d.supplierId ?? null)) &&
              (e.categoryId === null || e.categoryId === (d.categoryId ?? null)),
          )
        ) {
          continue;
        }
        const prior = priors[d.leverId];
        const projected = d.rawProjectedSavingsUsd * prior.projectionMultiplier;
        const confidence = prior.confidenceWeight;
        drafts.push({
          lever,
          draft: d,
          rank: projected * confidence,
        });
      }
    }
    drafts.sort((a, b) => b.rank - a.rank);

    await checkpoint();
    // --- 5. Act ---
    // Each opportunity insert is its own DB round trip; checkpoint inside
    // the loop so a 200-opportunity write doesn't ignore Cancel.
    const created: OpportunityRow[] = [];
    let totalProjected = 0;
    for (const { draft } of drafts) {
      await checkpoint();
      const prior = priors[draft.leverId];
      const projected = draft.rawProjectedSavingsUsd * prior.projectionMultiplier;
      totalProjected += projected;
      const tier = ALL_LEVERS.find((l) => l.leverId === draft.leverId)!.tier;
      const [row] = await db
        .insert(opportunitiesTable)
        .values({
          id: newId("opp"),
          orgId,
          cycleId,
          leverId: draft.leverId,
          tier,
          title: draft.title,
          rationale: draft.rationale,
          recommendedAction: draft.recommendedAction,
          supplierId: draft.supplierId ?? null,
          categoryId: draft.categoryId ?? null,
          rawProjectedSavingsUsd: draft.rawProjectedSavingsUsd.toFixed(2),
          projectedSavingsUsd: projected.toFixed(2),
          confidence: prior.confidenceWeight.toFixed(4),
          inputs: {
            ...draft.inputs,
            __priorApplied: {
              projectionMultiplier: prior.projectionMultiplier,
              confidenceWeight: prior.confidenceWeight,
            },
          },
        })
        .returning();
      if (row) created.push(row);
    }

    const decidePayload = {
      candidatesEvaluated: drafts.length,
      opportunitiesCreated: created.length,
      topByLever: summarizeTopByLever(created),
    };

    const learnPayload = {
      priorDeltas,
      exclusionDeltas,
      outcomeStats: outcomes,
    };

    const actPayload = {
      pendingApproval: created.length,
      previousCycleId,
    };

    await db
      .update(analysisCyclesTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        observePayload: observe as unknown as Record<string, unknown>,
        orientPayload: orientPayload as unknown as Record<string, unknown>,
        decidePayload: decidePayload as unknown as Record<string, unknown>,
        actPayload: actPayload as unknown as Record<string, unknown>,
        learnPayload: learnPayload as unknown as Record<string, unknown>,
        opportunitiesCreated: created.length,
        totalProjectedUsd: totalProjected.toFixed(2),
      })
      .where(eq(analysisCyclesTable.id, cycleId));

    logger.info(
      { orgId, cycleId, generation, created: created.length },
      "Cycle completed",
    );

    // Capture the per-cycle funnel snapshot after the cycle has been
    // marked completed. This is wrapped internally — a snapshot bug
    // must NEVER fail the cycle (the value of the snapshot is purely
    // observational; degrading it shouldn't degrade tenant analysis).
    await captureFunnelSnapshot({
      orgId,
      cycleId,
      cycleGeneration: generation,
      leverResults,
      draftsPostExclusion: drafts.map(({ lever, draft }) => ({ lever, draft })),
      persistedOpps: created,
      priorDeltas,
    });

    return {
      cycleId,
      generation,
      opportunitiesCreated: created.length,
      totalProjectedUsd: totalProjected,
      priorDeltas,
      exclusionDeltas,
    };
  } catch (err) {
    await db
      .update(analysisCyclesTable)
      .set({
        status: "failed",
        completedAt: new Date(),
        learnPayload: { error: (err as Error).message },
      })
      .where(eq(analysisCyclesTable.id, cycleId));
    throw err;
  }
}

async function observeStep(
  orgId: string,
  previousCycleId: string | null,
): Promise<Record<string, unknown>> {
  const stats = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM suppliers WHERE org_id = ${orgId}) AS suppliers,
      (SELECT COUNT(*) FROM purchase_orders WHERE org_id = ${orgId}) AS pos,
      (SELECT COUNT(*) FROM po_lines WHERE org_id = ${orgId}) AS po_lines,
      (SELECT COUNT(*) FROM contracts WHERE org_id = ${orgId} AND status = 'active') AS active_contracts,
      (SELECT COUNT(*) FROM invoices WHERE org_id = ${orgId}) AS invoices,
      (SELECT COUNT(*) FROM payments WHERE org_id = ${orgId}) AS payments,
      (SELECT COUNT(*) FROM shipments WHERE org_id = ${orgId}) AS shipments
  `);
  const counts = stats.rows[0] as Record<string, string>;

  let outcomeEvents = 0;
  if (previousCycleId) {
    const cycleRow = await db
      .select({ completedAt: analysisCyclesTable.completedAt })
      .from(analysisCyclesTable)
      .where(eq(analysisCyclesTable.id, previousCycleId))
      .limit(1);
    const since = cycleRow[0]?.completedAt ?? new Date(0);
    const evRow = await db.execute(sql`
      SELECT COUNT(*) AS c FROM decisions
      WHERE org_id = ${orgId} AND created_at > ${since}
    `);
    outcomeEvents = Number(
      (evRow.rows[0] as { c: string } | undefined)?.c ?? 0,
    );
  }

  return {
    snapshot: {
      suppliers: Number(counts.suppliers),
      purchaseOrders: Number(counts.pos),
      poLines: Number(counts.po_lines),
      activeContracts: Number(counts.active_contracts),
      invoices: Number(counts.invoices),
      payments: Number(counts.payments),
      shipments: Number(counts.shipments),
    },
    outcomeEventsSincePrev: outcomeEvents,
    previousCycleId,
  };
}

async function collectOutcomesSinceLastCycle(
  orgId: string,
  previousCycleId: string | null,
): Promise<OutcomeStats[]> {
  if (!previousCycleId) return [];
  const cycleRow = await db
    .select({ completedAt: analysisCyclesTable.completedAt })
    .from(analysisCyclesTable)
    .where(eq(analysisCyclesTable.id, previousCycleId))
    .limit(1);
  const since = cycleRow[0]?.completedAt;
  if (!since) return [];

  // Pull every decision event since `since` joined with its opportunity.
  const rows = await db
    .select({
      decisionId: decisionsTable.id,
      eventType: decisionsTable.eventType,
      rejectedReasonCode: decisionsTable.rejectedReasonCode,
      realizedSavingsUsd: decisionsTable.realizedSavingsUsd,
      opportunityId: decisionsTable.opportunityId,
      leverId: opportunitiesTable.leverId,
      projectedSavingsUsd: opportunitiesTable.projectedSavingsUsd,
      supplierId: opportunitiesTable.supplierId,
      categoryId: opportunitiesTable.categoryId,
    })
    .from(decisionsTable)
    .innerJoin(
      opportunitiesTable,
      eq(decisionsTable.opportunityId, opportunitiesTable.id),
    )
    .where(
      and(
        eq(decisionsTable.orgId, orgId),
        gt(decisionsTable.createdAt, since),
      ),
    );

  const by = new Map<LeverId, OutcomeStats>();
  function bucket(leverId: LeverId): OutcomeStats {
    let b = by.get(leverId);
    if (!b) {
      b = {
        leverId,
        approvals: 0,
        rejections: 0,
        realizations: 0,
        realizationRatioSum: 0,
        rejectionRules: [],
      };
      by.set(leverId, b);
    }
    return b;
  }
  for (const r of rows) {
    const b = bucket(r.leverId);
    if (r.eventType === "approve") b.approvals += 1;
    else if (r.eventType === "reject") {
      b.rejections += 1;
      // Translate structured rejection-reason codes to exclusion rules.
      if (r.rejectedReasonCode === "supplier_strategic_do_not_consolidate" && r.supplierId) {
        b.rejectionRules.push({
          leverId: r.leverId,
          supplierId: r.supplierId,
          categoryId: null,
          reasonCode: r.rejectedReasonCode,
          description: `Supplier flagged strategic — exclude from ${r.leverId} candidates.`,
        });
      } else if (r.rejectedReasonCode === "supplier_dei_or_diverse_program" && r.supplierId) {
        b.rejectionRules.push({
          leverId: r.leverId,
          supplierId: r.supplierId,
          categoryId: null,
          reasonCode: r.rejectedReasonCode,
          description: `Supplier protected under DEI/diverse program — exclude from ${r.leverId}.`,
        });
      } else if (r.rejectedReasonCode === "compliance_or_legal_block" && r.categoryId) {
        b.rejectionRules.push({
          leverId: r.leverId,
          supplierId: null,
          categoryId: r.categoryId,
          reasonCode: r.rejectedReasonCode,
          description: `Category blocked by compliance/legal — exclude from ${r.leverId}.`,
        });
      }
    } else if (r.eventType === "realize") {
      b.realizations += 1;
      const projected = Number(r.projectedSavingsUsd);
      const realized = Number(r.realizedSavingsUsd ?? 0);
      const ratio = projected > 0 ? realized / projected : 0;
      b.realizationRatioSum += ratio;
    }
  }
  return Array.from(by.values());
}

function summarizeTopByLever(opps: OpportunityRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of opps) {
    const lever = o.leverId as string;
    out[lever] = (out[lever] ?? 0) + Number(o.projectedSavingsUsd);
  }
  return out;
}

function diffPriors(
  before: PriorMap,
  after: PriorMap,
): Record<string, { multiplier: [number, number]; confidence: [number, number] }> {
  const out: Record<
    string,
    { multiplier: [number, number]; confidence: [number, number] }
  > = {};
  for (const lever of ALL_LEVERS) {
    const a = before[lever.leverId];
    const b = after[lever.leverId];
    if (
      Math.abs(a.projectionMultiplier - b.projectionMultiplier) > 1e-4 ||
      Math.abs(a.confidenceWeight - b.confidenceWeight) > 1e-4
    ) {
      out[lever.leverId] = {
        multiplier: [a.projectionMultiplier, b.projectionMultiplier],
        confidence: [a.confidenceWeight, b.confidenceWeight],
      };
    }
  }
  return out;
}
