import {
  db,
  learnedPriorsTable,
  exclusionRulesTable,
  type LearnedPriorRow,
  type LeverId,
} from "@workspace/db";
import { eq, and, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { newId } from "../ids";
import { ALL_LEVERS } from "../levers";

/** Bounds for sanity. */
const PROJ_MULT_MIN = 0.2;
const PROJ_MULT_MAX = 1.5;
const CONF_MIN = 0.1;
const CONF_MAX = 0.99;
/** Strength of the prior — higher = slower learning. */
const PRIOR_WEIGHT = 6;

/** Ensure a row exists for every (org, lever) pair plus the global rows. */
export async function ensurePriorsBootstrapped(orgId: string): Promise<void> {
  const existing = await db
    .select({ leverId: learnedPriorsTable.leverId })
    .from(learnedPriorsTable)
    .where(eq(learnedPriorsTable.orgId, orgId));
  const have = new Set(existing.map((r) => r.leverId));
  // Global rows (orgId IS NULL).
  const globalExisting = await db
    .select({ leverId: learnedPriorsTable.leverId })
    .from(learnedPriorsTable)
    .where(isNull(learnedPriorsTable.orgId));
  const haveGlobal = new Set(globalExisting.map((r) => r.leverId));

  for (const lever of ALL_LEVERS) {
    if (!haveGlobal.has(lever.leverId)) {
      await db.insert(learnedPriorsTable).values({
        id: newId("prior"),
        orgId: null,
        leverId: lever.leverId,
        projectionMultiplier: "1.0000",
        confidenceWeight: "0.5000",
      });
    }
    if (!have.has(lever.leverId)) {
      await db.insert(learnedPriorsTable).values({
        id: newId("prior"),
        orgId,
        leverId: lever.leverId,
        projectionMultiplier: "1.0000",
        confidenceWeight: "0.5000",
      });
    }
  }
}

export type PriorMap = Record<
  LeverId,
  { projectionMultiplier: number; confidenceWeight: number; evidenceCount: number }
>;

export async function loadPriors(orgId: string): Promise<PriorMap> {
  const tenantRows = await db
    .select()
    .from(learnedPriorsTable)
    .where(eq(learnedPriorsTable.orgId, orgId));
  const globalRows = await db
    .select()
    .from(learnedPriorsTable)
    .where(isNull(learnedPriorsTable.orgId));

  const byLever = new Map<LeverId, LearnedPriorRow>();
  for (const r of globalRows) byLever.set(r.leverId, r);
  for (const r of tenantRows) byLever.set(r.leverId, r);

  const out: PriorMap = {} as PriorMap;
  for (const lever of ALL_LEVERS) {
    const row = byLever.get(lever.leverId);
    out[lever.leverId] = {
      projectionMultiplier: row ? Number(row.projectionMultiplier) : 1.0,
      confidenceWeight: row ? Number(row.confidenceWeight) : 0.5,
      evidenceCount: row?.evidenceCount ?? 0,
    };
  }
  return out;
}

export interface PriorDelta {
  leverId: LeverId;
  prevProjectionMultiplier: number;
  newProjectionMultiplier: number;
  prevConfidenceWeight: number;
  newConfidenceWeight: number;
  newEvidence: number;
  approvals: number;
  rejections: number;
  realizations: number;
  rationale: string;
}

export interface ExclusionDelta {
  leverId: LeverId | null;
  supplierId: string | null;
  categoryId: string | null;
  reasonCode: string;
  description: string;
}

export interface OutcomeStats {
  leverId: LeverId;
  approvals: number;
  rejections: number;
  realizations: number;
  /** Sum of (realized $ / projected $) ratios across realized opportunities */
  realizationRatioSum: number;
  /** New rejection-rule deltas */
  rejectionRules: ExclusionDelta[];
}

/**
 * Apply weighted prior updates from this cycle's outcomes (the OODA Learn step).
 * Returns the named, inspectable deltas applied for each lever.
 */
export async function applyLearnUpdates(args: {
  orgId: string;
  cycleId: string;
  cycleGeneration: number;
  outcomes: OutcomeStats[];
}): Promise<{ priorDeltas: PriorDelta[]; exclusionDeltas: ExclusionDelta[] }> {
  const { orgId, cycleId, cycleGeneration, outcomes } = args;
  const priorDeltas: PriorDelta[] = [];
  const exclusionDeltas: ExclusionDelta[] = [];

  for (const o of outcomes) {
    const [row] = await db
      .select()
      .from(learnedPriorsTable)
      .where(
        and(
          eq(learnedPriorsTable.leverId, o.leverId),
          eq(learnedPriorsTable.orgId, orgId),
        ),
      );
    if (!row) continue;
    const prevMult = Number(row.projectionMultiplier);
    const prevConf = Number(row.confidenceWeight);
    const prevEvidence = row.evidenceCount;

    let newMult = prevMult;
    if (o.realizations > 0) {
      const meanRealization = o.realizationRatioSum / o.realizations;
      // Bayesian-style weighted update: blend prior (weight=PRIOR_WEIGHT) with
      // new evidence (weight = realizations).
      newMult =
        (prevMult * PRIOR_WEIGHT + meanRealization * o.realizations) /
        (PRIOR_WEIGHT + o.realizations);
      newMult = Math.max(PROJ_MULT_MIN, Math.min(PROJ_MULT_MAX, newMult));
    }

    let newConf = prevConf;
    const decisions = o.approvals + o.rejections;
    if (decisions > 0) {
      const approvalRate = o.approvals / decisions;
      const realizationRate =
        o.approvals > 0 ? o.realizations / Math.max(1, o.approvals) : 0;
      const newSignal = approvalRate * (0.5 + 0.5 * realizationRate);
      newConf =
        (prevConf * PRIOR_WEIGHT + newSignal * decisions) /
        (PRIOR_WEIGHT + decisions);
      newConf = Math.max(CONF_MIN, Math.min(CONF_MAX, newConf));
    }

    const rationaleParts: string[] = [];
    if (o.realizations > 0) {
      rationaleParts.push(
        `${o.realizations} realized outcome(s) at avg ${(
          o.realizationRatioSum / o.realizations
        ).toFixed(2)}× projection`,
      );
    }
    if (decisions > 0) {
      rationaleParts.push(
        `${o.approvals}/${decisions} approval rate`,
      );
    }
    const rationale =
      rationaleParts.length > 0
        ? rationaleParts.join("; ")
        : "no new outcomes — priors held";

    if (
      Math.abs(newMult - prevMult) > 1e-4 ||
      Math.abs(newConf - prevConf) > 1e-4 ||
      decisions > 0 ||
      o.realizations > 0
    ) {
      await db
        .update(learnedPriorsTable)
        .set({
          projectionMultiplier: newMult.toFixed(4),
          confidenceWeight: newConf.toFixed(4),
          evidenceCount: prevEvidence + o.realizations,
          approvalCount: row.approvalCount + o.approvals,
          rejectionCount: row.rejectionCount + o.rejections,
          realizationCount: row.realizationCount + o.realizations,
          updatedAtCycle: cycleGeneration,
          updatedAt: new Date(),
        })
        .where(eq(learnedPriorsTable.id, row.id));

      priorDeltas.push({
        leverId: o.leverId,
        prevProjectionMultiplier: prevMult,
        newProjectionMultiplier: newMult,
        prevConfidenceWeight: prevConf,
        newConfidenceWeight: newConf,
        newEvidence: o.realizations,
        approvals: o.approvals,
        rejections: o.rejections,
        realizations: o.realizations,
        rationale,
      });
    }

    for (const rule of o.rejectionRules) {
      // Idempotent: don't re-insert identical exclusion.
      const existing = await db
        .select({ id: exclusionRulesTable.id })
        .from(exclusionRulesTable)
        .where(
          and(
            eq(exclusionRulesTable.orgId, orgId),
            eq(exclusionRulesTable.reasonCode, rule.reasonCode),
            rule.leverId
              ? eq(exclusionRulesTable.leverId, rule.leverId)
              : isNull(exclusionRulesTable.leverId),
            rule.supplierId
              ? eq(exclusionRulesTable.supplierId, rule.supplierId)
              : isNull(exclusionRulesTable.supplierId),
            rule.categoryId
              ? eq(exclusionRulesTable.categoryId, rule.categoryId)
              : isNull(exclusionRulesTable.categoryId),
          ),
        );
      if (existing.length === 0) {
        await db.insert(exclusionRulesTable).values({
          id: newId("excl"),
          orgId,
          leverId: rule.leverId,
          supplierId: rule.supplierId,
          categoryId: rule.categoryId,
          reasonCode: rule.reasonCode,
          description: rule.description,
          sourceCycleId: cycleId,
        });
        exclusionDeltas.push(rule);
      }
    }
  }

  return { priorDeltas, exclusionDeltas };
}

export interface ActiveExclusion {
  leverId: LeverId | null;
  supplierId: string | null;
  categoryId: string | null;
}

export async function loadActiveExclusions(
  orgId: string,
): Promise<ActiveExclusion[]> {
  const rows = await db
    .select({
      leverId: exclusionRulesTable.leverId,
      supplierId: exclusionRulesTable.supplierId,
      categoryId: exclusionRulesTable.categoryId,
    })
    .from(exclusionRulesTable)
    .where(
      and(
        eq(exclusionRulesTable.orgId, orgId),
        eq(exclusionRulesTable.active, 1),
      ),
    );
  return rows;
}
