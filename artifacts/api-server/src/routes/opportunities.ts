import { Router, type IRouter, type Request } from "express";
import {
  db,
  opportunitiesTable,
  opportunityStageHistoryTable,
  decisionsTable,
  suppliersTable,
  categoriesTable,
  rejectionReasonCodes,
  savingsClassificationValues,
  sourcingStrategyValues,
  type LeverId,
  type OpportunityStatus,
  type DecisionEventType,
  type RejectionReasonCode,
  type InsertDecisionRow,
  type CanonicalStage,
  type SavingsType,
  resolveDoaTierNumber,
  gateSlaBreach,
  computeBreachingDoaSla,
  computeTimeInCurrentStageHours,
} from "@workspace/db";
import { and, eq, desc, sql, or, lt, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission, resolveRbacContext, roleHasPermission } from "../lib/rbac";
import { newId } from "../lib/ids";
import { logger } from "../lib/logger";
import { extractSourcesFromInputs } from "../lib/insight-sources";
import { writeAdminAudit, type AdminAuditAction } from "../lib/admin-audit";
import {
  InvalidRequestError,
  NotFoundError,
  ConflictError,
} from "../lib/api-errors";

const router: IRouter = Router();

// Body schemas for the action endpoints. Defined at module scope so the
// validation tests can import them directly and share the exact shape
// the production routes ship with. The two routes call `.parse(...)`
// and rely on the global error handler to map any thrown `ZodError`
// to `400 { error, details }` (see `lib/global-error-handler.ts`),
// matching the wire shape the collectors routes use after task #92.
export const rejectOpportunityBodySchema = z.object({
  reasonCode: z.enum(rejectionReasonCodes),
  // Preserve the previous `asOptionalString` semantics: missing,
  // null, or empty-string values all collapse to `null` so the DB
  // column stores a single canonical "no note" form.
  reasonText: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === "string" && v.length > 0 ? v : null)),
});

export const realizeOpportunityBodySchema = z.object({
  // Preserve the previous `asNumber` semantics exactly:
  //   - JSON numbers must be finite (no NaN/Infinity).
  //   - Numeric strings (e.g. `"123.45"`) are accepted, but the empty
  //     string is rejected — naive `z.coerce.number()` would silently
  //     turn `""` into `0` and record a phantom realized-savings value
  //     on this state-changing endpoint, which the old hand-rolled
  //     validator explicitly guarded against (`v.length > 0`).
  realizedSavingsUsd: z.union([
    z.number().finite(),
    z
      .string()
      .min(1)
      .transform((s, ctx) => {
        const n = Number(s);
        if (!Number.isFinite(n)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Expected a finite number",
          });
          return z.NEVER;
        }
        return n;
      }),
  ]),
});

// Single SQL pass: refresh cycle counters + actPayload after a status change.
async function updateCycleAggregates(
  orgId: string,
  cycleId: string | null,
): Promise<void> {
  if (!cycleId) return;
  await db.execute(sql`
    WITH cnt AS (
      SELECT
        COUNT(*) FILTER (
          WHERE status IN ('approved', 'executing', 'realized')
        )::int AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE status = 'realized')::int AS realized,
        COALESCE(
          SUM(realized_savings_usd) FILTER (WHERE status = 'realized'),
          0
        )::numeric(18, 2) AS realized_usd
      FROM opportunities
      WHERE org_id = ${orgId} AND cycle_id = ${cycleId}
    )
    UPDATE analysis_cycles
    SET
      opportunities_approved = cnt.approved,
      opportunities_rejected = cnt.rejected,
      opportunities_realized = cnt.realized,
      total_realized_usd = cnt.realized_usd,
      act_payload = jsonb_set(
        jsonb_set(
          COALESCE(act_payload, '{}'::jsonb),
          '{decisionCounts}',
          jsonb_build_object(
            'approved', cnt.approved,
            'rejected', cnt.rejected,
            'realized', cnt.realized,
            'totalRealizedUsd', cnt.realized_usd
          ),
          true
        ),
        '{lastUpdatedAt}',
        to_jsonb(now()),
        true
      )
    FROM cnt
    WHERE analysis_cycles.id = ${cycleId}
      AND analysis_cycles.org_id = ${orgId};
  `);
}

function mapOpportunity(row: {
  opp: typeof opportunitiesTable.$inferSelect;
  supplierName?: string | null;
  categoryName?: string | null;
}) {
  const o = row.opp;

  // Compute S2P query-time fields from stored columns + doa-config.
  const timeInCurrentStageHours = computeTimeInCurrentStageHours(
    o.stageEnteredAt ?? null,
  );
  const slaBreach = gateSlaBreach({
    canonicalStage: o.canonicalStage ?? null,
    stageEnteredAt: o.stageEnteredAt ?? null,
  });
  // Tier-aware DOA breach (uses doa_tier identifiedSlaHours, not gate SLA).
  // True only while the row is in `Identified` and has exceeded the tier's
  // identifiedSlaHours window — independent of gateSlaBreach.
  const breachingDoaSla = computeBreachingDoaSla({
    canonicalStage: o.canonicalStage ?? null,
    stageEnteredAt: o.stageEnteredAt ?? null,
    doaTier: o.doaTier ?? null,
  });

  return {
    id: o.id,
    orgId: o.orgId,
    cycleId: o.cycleId,
    leverId: o.leverId,
    tier: o.tier,
    status: o.status,
    title: o.title,
    rationale: o.rationale,
    recommendedAction: o.recommendedAction,
    supplierId: o.supplierId,
    supplierName: row.supplierName ?? null,
    categoryId: o.categoryId,
    categoryName: row.categoryName ?? null,
    rawProjectedSavingsUsd: Number(o.rawProjectedSavingsUsd),
    projectedSavingsUsd: Number(o.projectedSavingsUsd),
    confidence: Number(o.confidence),
    realizedSavingsUsd: Number(o.realizedSavingsUsd),
    rejectedReasonCode: o.rejectedReasonCode,
    rejectedReasonText: o.rejectedReasonNote,
    realizedAt: o.realizedAt,
    snoozedUntil: o.snoozedUntil,
    lastSeenAt: o.lastSeenAt,
    expiryReason: o.expiryReason,
    createdAt: o.createdAt,
    // S2P fields (Task #284)
    savingsType: o.savingsType ?? null,
    savingsClassification: o.savingsClassification ?? null,
    classificationNeedsReview: o.classificationNeedsReview ?? false,
    canonicalStage: o.canonicalStage ?? null,
    stageEnteredAt: o.stageEnteredAt ?? null,
    doaTier: o.doaTier ?? null,
    sourcingStrategy: o.sourcingStrategy ?? null,
    baselineMethod: o.baselineMethod ?? null,
    baselineValue: o.baselineValue !== null && o.baselineValue !== undefined
      ? Number(o.baselineValue)
      : null,
    baselineSource: o.baselineSource ?? null,
    // Computed at query time — never stored
    timeInCurrentStageHours,
    breachingSla: slaBreach.breaching,
    breachingDoaSla,
    slaHours: slaBreach.slaHours,
  };
}

/**
 * Determine the canonical_stage + savings_type that should follow a given
 * status transition. Called from every approve/execute/realize/reject
 * endpoint to keep the S2P fields in sync with the status lifecycle.
 */
function s2pForStatusTransition(newStatus: string): {
  canonicalStage: CanonicalStage;
  savingsType: SavingsType;
} {
  switch (newStatus) {
    case "approved":
      return { canonicalStage: "Awarded", savingsType: "Negotiated" };
    case "executing":
      return { canonicalStage: "In Implementation", savingsType: "Implemented" };
    case "realized":
      return { canonicalStage: "Realized", savingsType: "Realized" };
    case "rejected":
    case "expired":
      return { canonicalStage: "Closed-No Action", savingsType: "Identified" };
    default:
      return { canonicalStage: "Identified", savingsType: "Identified" };
  }
}

/**
 * Write one row to opportunity_stage_history when canonical_stage changes.
 * Swallows errors so a history-write failure never blocks the state transition.
 */
async function writeStageHistory(args: {
  opportunityId: string;
  orgId: string;
  fromStage: CanonicalStage | null;
  toStage: CanonicalStage;
  actor: string | null;
  reason: string;
}): Promise<void> {
  try {
    await db.insert(opportunityStageHistoryTable).values({
      id: newId("sh"),
      opportunityId: args.opportunityId,
      orgId: args.orgId,
      fromStage: args.fromStage ?? undefined,
      toStage: args.toStage,
      transitionedAt: new Date(),
      transitionedByUserId: args.actor,
      transitionReason: args.reason,
    });
  } catch (err) {
    // History write failures must not block the actual state change, but
    // they MUST be observable: a silent drop here would leave the audit
    // trail incomplete with no signal to operators.
    logger.warn(
      {
        err,
        opportunityId: args.opportunityId,
        orgId: args.orgId,
        fromStage: args.fromStage,
        toStage: args.toStage,
        reason: args.reason,
      },
      "Failed to write opportunity_stage_history row",
    );
  }
}

// Snooze filter (#220). `exclude` (default) hides currently-snoozed
// rows so the operator's default opportunities view matches the Today
// page Pending approvals card. `only` returns just the snoozed rows so
// the UI can render a "Snoozed" filter chip without a second endpoint.
// `all` ignores the column entirely.
const snoozeFilterValues = ["exclude", "only", "all"] as const;
type SnoozeFilter = (typeof snoozeFilterValues)[number];

function parseSnoozeFilter(raw: unknown): SnoozeFilter {
  if (typeof raw === "string") {
    const found = snoozeFilterValues.find((v) => v === raw);
    if (found) return found;
  }
  return "exclude";
}

router.get("/opportunities", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const status = req.query.status as OpportunityStatus | undefined;
  const leverId = req.query.leverId as LeverId | undefined;
  const cycleId = req.query.cycleId as string | undefined;
  const supplierId = req.query.supplierId as string | undefined;
  const canonicalStageFilter = req.query.canonicalStage as CanonicalStage | undefined;
  const snoozed = parseSnoozeFilter(req.query.snoozed);
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? "100", 10) || 100, 1),
    200,
  );
  const cursor = req.query.cursor as string | undefined;

  // Composite (projectedSavingsUsd DESC, id ASC) keyset pagination — cursor
  // encodes both columns so paging is stable when many rows share a savings
  // value (which the projected_savings_usd numeric column allows).
  const where = [eq(opportunitiesTable.orgId, orgId)];
  if (status) where.push(eq(opportunitiesTable.status, status));
  if (leverId) where.push(eq(opportunitiesTable.leverId, leverId));
  if (cycleId) where.push(eq(opportunitiesTable.cycleId, cycleId));
  if (canonicalStageFilter) where.push(eq(opportunitiesTable.canonicalStage, canonicalStageFilter));
  if (snoozed === "exclude") {
    // A row is "currently snoozed" iff snoozed_until > now(). We OR with
    // `IS NULL` so unsnoozed rows are kept, matching the Today feed.
    where.push(
      sql`(${opportunitiesTable.snoozedUntil} IS NULL OR ${opportunitiesTable.snoozedUntil} <= now())`,
    );
  } else if (snoozed === "only") {
    where.push(
      sql`${opportunitiesTable.snoozedUntil} IS NOT NULL AND ${opportunitiesTable.snoozedUntil} > now()`,
    );
  }
  if (supplierId) {
    // Match both the canonical `supplier_id` column AND the
    // `inputs.supplierId` field that older lever code stamps before
    // a normalised supplier link is resolved. We OR them so a
    // Supplier 360 page surfaces every opportunity that touches the
    // supplier regardless of which path the lever took.
    const cond = or(
      eq(opportunitiesTable.supplierId, supplierId),
      sql`${opportunitiesTable.inputs}->>'supplierId' = ${supplierId}`,
    );
    if (cond) where.push(cond);
  }
  if (cursor) {
    const decoded = decodeOppCursor(cursor);
    if (decoded) {
      const { savings, id } = decoded;
      const cond = or(
        lt(opportunitiesTable.projectedSavingsUsd, savings),
        and(
          eq(opportunitiesTable.projectedSavingsUsd, savings),
          sql`${opportunitiesTable.id} > ${id}`,
        ),
      );
      if (cond) where.push(cond);
    }
  }

  const rows = await db
    .select({
      opp: opportunitiesTable,
      supplierName: suppliersTable.name,
      categoryName: categoriesTable.name,
    })
    .from(opportunitiesTable)
    .leftJoin(
      suppliersTable,
      eq(opportunitiesTable.supplierId, suppliersTable.id),
    )
    .leftJoin(
      categoriesTable,
      eq(opportunitiesTable.categoryId, categoriesTable.id),
    )
    .where(and(...where))
    .orderBy(
      desc(opportunitiesTable.projectedSavingsUsd),
      sql`${opportunitiesTable.id} ASC`,
    )
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const items = sliced.map(mapOpportunity);
  const last = sliced.at(-1);
  res.json({
    items,
    nextCursor:
      hasMore && last
        ? encodeOppCursor(last.opp.projectedSavingsUsd, last.opp.id)
        : null,
  });
});

function encodeOppCursor(savings: string, id: string): string {
  return Buffer.from(`${savings}|${id}`, "utf8").toString("base64url");
}
function decodeOppCursor(
  raw: string,
): { savings: string; id: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf("|");
    if (sep <= 0) return null;
    const savings = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!savings || !id || Number.isNaN(Number(savings))) return null;
    return { savings, id };
  } catch {
    return null;
  }
}

/**
 * GET /opportunities/gate-summary
 *
 * Server-side per-gate pipeline metrics for the active tenant.
 * Groups open opportunities by canonical_stage and computes
 * authoritative count, value, avg cycle time, and SLA breach count
 * — never limited by the 200-row pagination cap.
 */
router.get(
  "/opportunities/gate-summary",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);

    const rows = await db.execute(sql`
      SELECT
        canonical_stage,
        COUNT(*)::int                                                    AS count,
        COALESCE(SUM(projected_savings_usd::numeric), 0)::numeric       AS value_usd,
        AVG(
          CASE WHEN stage_entered_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (now() - stage_entered_at)) / 3600
          END
        )::numeric                                                       AS avg_hours_in_stage,
        COUNT(*) FILTER (
          WHERE stage_entered_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (now() - stage_entered_at)) / 3600 >
              CASE canonical_stage
                WHEN 'Identified' THEN
                  CASE doa_tier
                    WHEN 1 THEN 24
                    WHEN 2 THEN 48
                    WHEN 3 THEN 72
                    WHEN 4 THEN 168
                    ELSE 72
                  END
                WHEN 'Awarded'           THEN 120
                WHEN 'In Contracting'    THEN 168
                WHEN 'In Implementation' THEN 720
              END
        )::int                                                           AS breaching_count
      FROM opportunities
      WHERE org_id = ${orgId}
        AND status IN ('proposed', 'approved', 'executing')
        AND canonical_stage IN (
          'Identified', 'Awarded', 'In Contracting', 'In Implementation'
        )
        AND (snoozed_until IS NULL OR snoozed_until <= now())
      GROUP BY canonical_stage
    `);

    const gates = (
      rows.rows as Array<{
        canonical_stage: string;
        count: number;
        value_usd: string;
        avg_hours_in_stage: string | null;
        breaching_count: number;
      }>
    ).map((r) => ({
      canonicalStage: r.canonical_stage,
      count: Number(r.count),
      valueUsd: Number(r.value_usd),
      avgHoursInStage:
        r.avg_hours_in_stage != null ? Number(r.avg_hours_in_stage) : null,
      breachingCount: Number(r.breaching_count),
    }));

    res.json({ gates });
  },
);

/**
 * GET /opportunities/doa-summary
 *
 * Returns per-DOA-tier queue metrics for the active tenant:
 *   - inQueue:        opportunities in `proposed` or `approved` status
 *   - breachingCount: subset whose DOA SLA has been exceeded in `Identified`
 *   - valueUsd:       sum of projected_savings_usd for the queue
 *
 * Rows are grouped and breach-computed server-side so the result is
 * authoritative regardless of client-side pagination limits.
 */
router.get(
  "/opportunities/doa-summary",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);

    const rows = await db.execute(sql`
      SELECT
        doa_tier,
        COUNT(*)::int                                               AS in_queue,
        COUNT(*) FILTER (
          WHERE
            canonical_stage = 'Identified'
            AND stage_entered_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (now() - stage_entered_at)) / 3600 >
              CASE doa_tier
                WHEN 1 THEN 24
                WHEN 2 THEN 48
                WHEN 3 THEN 72
                ELSE          168
              END
        )::int                                                      AS breaching_count,
        COALESCE(SUM(projected_savings_usd::numeric), 0)::numeric  AS value_usd
      FROM opportunities
      WHERE org_id = ${orgId}
        AND status IN ('proposed', 'approved')
        AND (snoozed_until IS NULL OR snoozed_until <= now())
      GROUP BY doa_tier
      ORDER BY doa_tier NULLS LAST
    `);

    const tiers = (
      rows.rows as Array<{
        doa_tier: number | null;
        in_queue: number;
        breaching_count: number;
        value_usd: string;
      }>
    ).map((r) => ({
      doaTier: r.doa_tier,
      inQueue: Number(r.in_queue),
      breachingCount: Number(r.breaching_count),
      valueUsd: Number(r.value_usd),
    }));

    res.json({ tiers });
  },
);

router.get("/opportunities/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const [row] = await db
    .select({
      opp: opportunitiesTable,
      supplierName: suppliersTable.name,
      categoryName: categoriesTable.name,
    })
    .from(opportunitiesTable)
    .leftJoin(
      suppliersTable,
      eq(opportunitiesTable.supplierId, suppliersTable.id),
    )
    .leftJoin(
      categoriesTable,
      eq(opportunitiesTable.categoryId, categoriesTable.id),
    )
    .where(
      and(
        eq(opportunitiesTable.orgId, orgId),
        eq(opportunitiesTable.id, id),
      ),
    );
  if (!row) {
    throw new NotFoundError("Opportunity not found");
  }
  const decisions = await db
    .select()
    .from(decisionsTable)
    .where(eq(decisionsTable.opportunityId, id))
    .orderBy(desc(decisionsTable.createdAt));
  const stageHistory = await db
    .select()
    .from(opportunityStageHistoryTable)
    .where(eq(opportunityStageHistoryTable.opportunityId, id))
    .orderBy(opportunityStageHistoryTable.transitionedAt);
  const inputs = (row.opp.inputs ?? {}) as Record<string, unknown>;
  res.json({
    ...mapOpportunity(row),
    inputs,
    sources: extractSourcesFromInputs(inputs),
    decisions: decisions.map((d) => ({
      id: d.id,
      opportunityId: d.opportunityId,
      eventType: d.eventType,
      actorEmail: d.actor,
      rejectedReasonCode: d.rejectedReasonCode,
      rejectedReasonText: d.rejectedReasonNote,
      realizedSavingsUsd:
        d.realizedSavingsUsd !== null ? Number(d.realizedSavingsUsd) : null,
      notes: null,
      createdAt: d.createdAt,
    })),
    stageHistory: stageHistory.map((s) => ({
      id: s.id,
      fromStage: s.fromStage ?? null,
      toStage: s.toStage,
      transitionedAt: s.transitionedAt,
      transitionedByUserId: s.transitionedByUserId ?? null,
      transitionReason: s.transitionReason ?? null,
      notes: s.notes ?? null,
    })),
  });
});

async function loadOppOrThrow(orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(opportunitiesTable)
    .where(
      and(eq(opportunitiesTable.orgId, orgId), eq(opportunitiesTable.id, id)),
    );
  return row;
}

/**
 * Bulk action support (#220).
 *
 * The four bulk endpoints share most of the wiring: validate the
 * batch, fetch the eligible rows in this tenant, partition the
 * requested ids into the four buckets the client cares about
 * (`succeeded` / `skippedNoPermission` / `skippedWrongStatus` /
 * `failed`), apply the state change in a single UPDATE, write one
 * `decisions` audit event per affected row, and refresh the
 * `analysis_cycles` aggregates per touched cycle.
 *
 * Permission gating note. The route middleware `requirePermission(
 * "opp:approve")` already short-circuits the whole call when the
 * caller lacks the permission tenant-wide — RBAC has no row-level
 * granularity in H1 (see `lib/rbac.ts`), so the per-row
 * `skippedNoPermission` count exists in the response shape for
 * forward-compat with future row-level rules but will normally be 0.
 */
const MAX_BULK_IDS = 1000;

const bulkIdsSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BULK_IDS)
      .transform((v) => Array.from(new Set(v))),
  });

const bulkApproveBodySchema = bulkIdsSchema.extend({
  notes: z.string().optional(),
});

const bulkRejectBodySchema = bulkIdsSchema.extend({
  reasonCode: z.enum(rejectionReasonCodes),
  reasonText: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === "string" && v.length > 0 ? v : null)),
});

// Cap snooze deadlines at +365d so a dropdown UI bug can't
// accidentally hide a row forever.
const MAX_SNOOZE_MS = 365 * 24 * 60 * 60 * 1000;

const bulkSnoozeBodySchema = bulkIdsSchema.extend({
  snoozedUntil: z
    .union([z.string().min(1), z.date()])
    .transform((v, ctx) => {
      const d = v instanceof Date ? v : new Date(v);
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expected an ISO date-time string",
        });
        return z.NEVER;
      }
      const now = Date.now();
      if (d.getTime() <= now) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "snoozedUntil must be strictly in the future",
        });
        return z.NEVER;
      }
      if (d.getTime() - now > MAX_SNOOZE_MS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "snoozedUntil must not be more than 365 days in the future",
        });
        return z.NEVER;
      }
      return d;
    }),
});

const bulkUnsnoozeBodySchema = bulkIdsSchema;

interface BulkOpportunityActionResult {
  requested: number;
  succeeded: number;
  skippedNoPermission: number;
  skippedWrongStatus: number;
  failed: number;
  succeededIds: string[];
}

interface EligibleRow {
  id: string;
  cycleId: string | null;
  status: OpportunityStatus;
  snoozedUntil: Date | null;
}

/**
 * Fetch the requested ids that belong to this tenant and project the
 * fields needed to decide which bucket each falls in. Anything not
 * returned by this query is, by definition, not visible to the caller
 * (cross-tenant id) — we count those as `skippedNoPermission` so a
 * client batching ids across orgs gets a clear signal.
 */
async function loadBulkRows(
  orgId: string,
  ids: string[],
): Promise<Map<string, EligibleRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: opportunitiesTable.id,
      cycleId: opportunitiesTable.cycleId,
      status: opportunitiesTable.status,
      snoozedUntil: opportunitiesTable.snoozedUntil,
    })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.orgId, orgId),
        inArray(opportunitiesTable.id, ids),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        cycleId: r.cycleId,
        status: r.status,
        snoozedUntil: r.snoozedUntil,
      },
    ]),
  );
}

/**
 * Refresh per-cycle aggregates touched by a bulk transition. We
 * collect the `cycle_id` set up-front to keep the round-trip count
 * proportional to the number of distinct cycles, not the number of
 * rows.
 */
async function refreshCyclesForRows(
  orgId: string,
  rows: EligibleRow[],
): Promise<void> {
  const cycleIds = new Set<string>();
  for (const r of rows) {
    if (r.cycleId) cycleIds.add(r.cycleId);
  }
  for (const cycleId of cycleIds) {
    await updateCycleAggregates(orgId, cycleId);
  }
}

/**
 * Build the decisions rows for an affected batch in one shot. Caller
 * supplies the event type and any per-event payload columns
 * (rejection reason, etc.).
 */
function buildDecisionRows(
  orgId: string,
  actor: string,
  rows: EligibleRow[],
  eventType: DecisionEventType,
  extra?: {
    rejectedReasonCode?: RejectionReasonCode;
    rejectedReasonNote?: string | null;
  },
): InsertDecisionRow[] {
  return rows.map((r) => ({
    id: newId("dec"),
    orgId,
    opportunityId: r.id,
    // `cycle_id` is `notNull` on the decisions table; legacy rows that
    // somehow lack a cycle pointer fall back to a synthetic marker so
    // the audit insert never blows up on a NOT NULL violation.
    cycleId: r.cycleId ?? "unknown",
    eventType,
    actor,
    rejectedReasonCode: extra?.rejectedReasonCode ?? null,
    rejectedReasonNote: extra?.rejectedReasonNote ?? null,
  }));
}

function actorOf(req: Request): string {
  return req.actorEmail ?? "system@procuro.ai";
}

async function callerHasOppApprove(req: Request): Promise<boolean> {
  const ctx = await resolveRbacContext(req);
  return ctx.roles.some((r) => roleHasPermission(r, "opp:approve"));
}

/**
 * Append a single admin-audit row summarising a bulk opportunity
 * action. We deliberately emit ONE row per batch (with the affected
 * ids in metadata) instead of one row per opportunity — operators
 * routinely approve hundreds of rows in a single click and a 1:N
 * fan-out would drown the audit log without telling auditors anything
 * the per-batch row does not. Failures here are logged and swallowed
 * so a downstream audit-log issue can never hold up the actual
 * state-changing transaction the operator triggered.
 */
async function recordBulkOpportunityAudit(
  req: Request,
  args: {
    orgId: string;
    action: AdminAuditAction;
    succeededIds: string[];
    requested: number;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  if (args.succeededIds.length === 0) return;
  try {
    await writeAdminAudit({
      orgId: args.orgId,
      actor: actorOf(req),
      action: args.action,
      targetId: args.succeededIds[0] ?? null,
      targetLabel: `${args.succeededIds.length} opportunit${args.succeededIds.length === 1 ? "y" : "ies"}`,
      metadata: {
        succeededIds: args.succeededIds,
        requested: args.requested,
        ...(args.extra ?? {}),
      },
    });
  } catch (err) {
    req.log.warn({ err, action: args.action }, "Failed to write admin audit row");
  }
}

async function recordSingleOpportunityAudit(
  req: Request,
  args: {
    orgId: string;
    action: AdminAuditAction;
    opportunityId: string;
    label: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await writeAdminAudit({
      orgId: args.orgId,
      actor: actorOf(req),
      action: args.action,
      targetId: args.opportunityId,
      targetLabel: args.label,
      metadata: args.extra ?? {},
    });
  } catch (err) {
    req.log.warn({ err, action: args.action }, "Failed to write admin audit row");
  }
}

/**
 * Bucketise the requested ids. Anything not present in the loaded set
 * is `skippedNoPermission` (cross-tenant or non-existent — both look
 * the same to the caller, which prevents tenant-id enumeration).
 * Everything else is bucketised by the supplied `eligible` predicate.
 */
function partition(
  requested: string[],
  loaded: Map<string, EligibleRow>,
  eligible: (r: EligibleRow) => boolean,
  callerHasPerm: boolean,
): {
  succeed: EligibleRow[];
  skippedNoPermission: number;
  skippedWrongStatus: number;
} {
  let skippedNoPermission = 0;
  let skippedWrongStatus = 0;
  const succeed: EligibleRow[] = [];
  for (const id of requested) {
    const row = loaded.get(id);
    if (!row) {
      skippedNoPermission += 1;
      continue;
    }
    if (!callerHasPerm) {
      skippedNoPermission += 1;
      continue;
    }
    if (!eligible(row)) {
      skippedWrongStatus += 1;
      continue;
    }
    succeed.push(row);
  }
  return { succeed, skippedNoPermission, skippedWrongStatus };
}

router.post(
  "/opportunities/bulk-approve",
  tenantMiddleware,
  requirePermission("opp:approve"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const { ids } = bulkApproveBodySchema.parse(req.body);
    const callerHasPerm = await callerHasOppApprove(req);
    const loaded = await loadBulkRows(orgId, ids);
    const { succeed, skippedNoPermission, skippedWrongStatus } = partition(
      ids,
      loaded,
      (r) => r.status === "proposed",
      callerHasPerm,
    );
    let failed = 0;
    let succeededIds: string[] = [];
    if (succeed.length > 0) {
      try {
        const now = new Date();
        const s2p = s2pForStatusTransition("approved");
        await db.transaction(async (tx) => {
          await tx
            .update(opportunitiesTable)
            .set({
              status: "approved",
              canonicalStage: s2p.canonicalStage,
              savingsType: s2p.savingsType,
              stageEnteredAt: now,
            })
            .where(
              and(
                eq(opportunitiesTable.orgId, orgId),
                inArray(
                  opportunitiesTable.id,
                  succeed.map((r) => r.id),
                ),
                // Re-check status under the row lock so a concurrent
                // single-row transition can't double-approve.
                eq(opportunitiesTable.status, "proposed"),
              ),
            );
          await tx
            .insert(decisionsTable)
            .values(buildDecisionRows(orgId, actorOf(req), succeed, "approve"));
        });
        succeededIds = succeed.map((r) => r.id);
        // Write one stage_history row per opportunity so the audit trail
        // matches what the single-row /approve endpoint records.
        const actor = actorOf(req);
        for (const r of succeed) {
          await writeStageHistory({
            opportunityId: r.id,
            orgId,
            // Bulk endpoints only operate on `proposed` rows, which always
            // map to canonical_stage 'Identified'.
            fromStage: "Identified",
            toStage: s2p.canonicalStage,
            actor,
            reason: "STATUS_CHANGE",
          });
        }
        await refreshCyclesForRows(orgId, succeed);
      } catch (err) {
        req.log.error({ err }, "bulkApproveOpportunities failed");
        failed = succeed.length;
        succeededIds = [];
      }
    }
    await recordBulkOpportunityAudit(req, {
      orgId,
      action: "opportunity.bulk_approve",
      succeededIds,
      requested: ids.length,
    });
    const result: BulkOpportunityActionResult = {
      requested: ids.length,
      succeeded: succeededIds.length,
      skippedNoPermission,
      skippedWrongStatus,
      failed,
      succeededIds,
    };
    res.json(result);
  },
);

router.post(
  "/opportunities/bulk-reject",
  tenantMiddleware,
  requirePermission("opp:approve"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const { ids, reasonCode, reasonText } = bulkRejectBodySchema.parse(
      req.body,
    );
    const callerHasPerm = await callerHasOppApprove(req);
    const loaded = await loadBulkRows(orgId, ids);
    const { succeed, skippedNoPermission, skippedWrongStatus } = partition(
      ids,
      loaded,
      (r) => r.status === "proposed",
      callerHasPerm,
    );
    let failed = 0;
    let succeededIds: string[] = [];
    if (succeed.length > 0) {
      try {
        const now = new Date();
        const s2p = s2pForStatusTransition("rejected");
        await db.transaction(async (tx) => {
          await tx
            .update(opportunitiesTable)
            .set({
              status: "rejected",
              rejectedReasonCode: reasonCode,
              rejectedReasonNote: reasonText,
              canonicalStage: s2p.canonicalStage,
              savingsType: s2p.savingsType,
              stageEnteredAt: now,
            })
            .where(
              and(
                eq(opportunitiesTable.orgId, orgId),
                inArray(
                  opportunitiesTable.id,
                  succeed.map((r) => r.id),
                ),
                eq(opportunitiesTable.status, "proposed"),
              ),
            );
          await tx.insert(decisionsTable).values(
            buildDecisionRows(orgId, actorOf(req), succeed, "reject", {
              rejectedReasonCode: reasonCode,
              rejectedReasonNote: reasonText,
            }),
          );
        });
        succeededIds = succeed.map((r) => r.id);
        const actor = actorOf(req);
        for (const r of succeed) {
          await writeStageHistory({
            opportunityId: r.id,
            orgId,
            // Bulk endpoints only operate on `proposed` rows, which always
            // map to canonical_stage 'Identified'.
            fromStage: "Identified",
            toStage: s2p.canonicalStage,
            actor,
            reason: "STATUS_CHANGE",
          });
        }
        await refreshCyclesForRows(orgId, succeed);
      } catch (err) {
        req.log.error({ err }, "bulkRejectOpportunities failed");
        failed = succeed.length;
        succeededIds = [];
      }
    }
    await recordBulkOpportunityAudit(req, {
      orgId,
      action: "opportunity.bulk_reject",
      succeededIds,
      requested: ids.length,
      extra: { reasonCode, reasonText },
    });
    const result: BulkOpportunityActionResult = {
      requested: ids.length,
      succeeded: succeededIds.length,
      skippedNoPermission,
      skippedWrongStatus,
      failed,
      succeededIds,
    };
    res.json(result);
  },
);

router.post(
  "/opportunities/bulk-snooze",
  tenantMiddleware,
  requirePermission("opp:approve"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const { ids, snoozedUntil } = bulkSnoozeBodySchema.parse(req.body);
    const callerHasPerm = await callerHasOppApprove(req);
    const loaded = await loadBulkRows(orgId, ids);
    // Snooze only acts on `proposed` rows — once a row leaves the
    // approvals queue, snooze has no defined meaning. Already-snoozed
    // rows ARE eligible (this is how the UI extends a snooze).
    const { succeed, skippedNoPermission, skippedWrongStatus } = partition(
      ids,
      loaded,
      (r) => r.status === "proposed",
      callerHasPerm,
    );
    let failed = 0;
    let succeededIds: string[] = [];
    if (succeed.length > 0) {
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(opportunitiesTable)
            .set({ snoozedUntil })
            .where(
              and(
                eq(opportunitiesTable.orgId, orgId),
                inArray(
                  opportunitiesTable.id,
                  succeed.map((r) => r.id),
                ),
                eq(opportunitiesTable.status, "proposed"),
              ),
            );
          await tx
            .insert(decisionsTable)
            .values(buildDecisionRows(orgId, actorOf(req), succeed, "snooze"));
        });
        succeededIds = succeed.map((r) => r.id);
        // Snooze does not change `status`, so the cycle aggregate
        // counters (approved/rejected/realized) don't move. Skip the
        // refresh round-trip.
      } catch (err) {
        req.log.error({ err }, "bulkSnoozeOpportunities failed");
        failed = succeed.length;
        succeededIds = [];
      }
    }
    await recordBulkOpportunityAudit(req, {
      orgId,
      action: "opportunity.bulk_snooze",
      succeededIds,
      requested: ids.length,
      extra: { snoozedUntil: snoozedUntil.toISOString() },
    });
    const result: BulkOpportunityActionResult = {
      requested: ids.length,
      succeeded: succeededIds.length,
      skippedNoPermission,
      skippedWrongStatus,
      failed,
      succeededIds,
    };
    res.json(result);
  },
);

router.post(
  "/opportunities/bulk-unsnooze",
  tenantMiddleware,
  requirePermission("opp:approve"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const { ids } = bulkUnsnoozeBodySchema.parse(req.body);
    const callerHasPerm = await callerHasOppApprove(req);
    const loaded = await loadBulkRows(orgId, ids);
    // Unsnooze is only meaningful for rows that actually have a
    // snooze set — others go to `skippedWrongStatus`.
    const { succeed, skippedNoPermission, skippedWrongStatus } = partition(
      ids,
      loaded,
      (r) => r.snoozedUntil !== null,
      callerHasPerm,
    );
    let failed = 0;
    let succeededIds: string[] = [];
    if (succeed.length > 0) {
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(opportunitiesTable)
            .set({ snoozedUntil: null })
            .where(
              and(
                eq(opportunitiesTable.orgId, orgId),
                inArray(
                  opportunitiesTable.id,
                  succeed.map((r) => r.id),
                ),
                isNotNull(opportunitiesTable.snoozedUntil),
              ),
            );
          await tx
            .insert(decisionsTable)
            .values(
              buildDecisionRows(orgId, actorOf(req), succeed, "unsnooze"),
            );
        });
        succeededIds = succeed.map((r) => r.id);
      } catch (err) {
        req.log.error({ err }, "bulkUnsnoozeOpportunities failed");
        failed = succeed.length;
        succeededIds = [];
      }
    }
    await recordBulkOpportunityAudit(req, {
      orgId,
      action: "opportunity.bulk_unsnooze",
      succeededIds,
      requested: ids.length,
    });
    const result: BulkOpportunityActionResult = {
      requested: ids.length,
      succeeded: succeededIds.length,
      skippedNoPermission,
      skippedWrongStatus,
      failed,
      succeededIds,
    };
    res.json(result);
  },
);

router.post("/opportunities/:id/approve", tenantMiddleware, requirePermission("opp:approve"), async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const opp = await loadOppOrThrow(orgId, id);
  if (!opp) {
    throw new NotFoundError("Opportunity not found");
  }
  if (opp.status !== "proposed") {
    throw new ConflictError(`Cannot approve from status '${opp.status}'`);
  }
  const { canonicalStage: newStage, savingsType: newSavingsType } =
    s2pForStatusTransition("approved");
  const now = new Date();
  await db
    .update(opportunitiesTable)
    .set({
      status: "approved",
      canonicalStage: newStage,
      savingsType: newSavingsType,
      stageEnteredAt: now,
      doaTier: resolveDoaTierNumber(Number(opp.projectedSavingsUsd)),
    })
    .where(eq(opportunitiesTable.id, opp.id));
  await db.insert(decisionsTable).values({
    id: newId("dec"),
    orgId,
    opportunityId: opp.id,
    cycleId: opp.cycleId,
    eventType: "approve",
    actor: req.actorEmail ?? "system@procuro.ai",
  });
  await writeStageHistory({
    opportunityId: opp.id,
    orgId,
    fromStage: opp.canonicalStage ?? null,
    toStage: newStage,
    actor: req.actorEmail ?? null,
    reason: "STATUS_CHANGE",
  });
  await updateCycleAggregates(orgId, opp.cycleId);
  await recordSingleOpportunityAudit(req, {
    orgId,
    action: "opportunity.approve",
    opportunityId: opp.id,
    label: opp.title,
  });
  const [updated] = await db
    .select()
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opp.id));
  res.json(mapOpportunity({ opp: updated! }));
});

router.post("/opportunities/:id/reject", tenantMiddleware, requirePermission("opp:approve"), async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  // Throw on invalid input and let the global error handler shape the
  // 400 response (`{ error, details }`). See global-error-handler.ts.
  const { reasonCode, reasonText } = rejectOpportunityBodySchema.parse(
    req.body,
  );

  const opp = await loadOppOrThrow(orgId, id);
  if (!opp) {
    throw new NotFoundError("Opportunity not found");
  }
  if (opp.status !== "proposed") {
    throw new ConflictError(`Cannot reject from status '${opp.status}'`);
  }
  const { canonicalStage: newStage, savingsType: newSavingsType } =
    s2pForStatusTransition("rejected");
  const now = new Date();
  await db
    .update(opportunitiesTable)
    .set({
      status: "rejected",
      rejectedReasonCode: reasonCode,
      rejectedReasonNote: reasonText,
      canonicalStage: newStage,
      savingsType: newSavingsType,
      stageEnteredAt: now,
    })
    .where(eq(opportunitiesTable.id, opp.id));
  await db.insert(decisionsTable).values({
    id: newId("dec"),
    orgId,
    opportunityId: opp.id,
    cycleId: opp.cycleId,
    eventType: "reject",
    actor: req.actorEmail ?? "system@procuro.ai",
    rejectedReasonCode: reasonCode,
    rejectedReasonNote: reasonText,
  });
  await writeStageHistory({
    opportunityId: opp.id,
    orgId,
    fromStage: opp.canonicalStage ?? null,
    toStage: newStage,
    actor: req.actorEmail ?? null,
    reason: "STATUS_CHANGE",
  });
  await updateCycleAggregates(orgId, opp.cycleId);
  await recordSingleOpportunityAudit(req, {
    orgId,
    action: "opportunity.reject",
    opportunityId: opp.id,
    label: opp.title,
    extra: { reasonCode, reasonText },
  });
  const [updated] = await db
    .select()
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opp.id));
  res.json(mapOpportunity({ opp: updated! }));
});

router.post("/opportunities/:id/execute", tenantMiddleware, requirePermission("opp:execute"), async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const opp = await loadOppOrThrow(orgId, id);
  if (!opp) {
    throw new NotFoundError("Opportunity not found");
  }
  if (opp.status !== "approved") {
    throw new ConflictError(`Cannot mark executing from status '${opp.status}'`);
  }
  {
    const { canonicalStage: newStage, savingsType: newSavingsType } =
      s2pForStatusTransition("executing");
    const now = new Date();
    await db
      .update(opportunitiesTable)
      .set({
        status: "executing",
        canonicalStage: newStage,
        savingsType: newSavingsType,
        stageEnteredAt: now,
      })
      .where(eq(opportunitiesTable.id, opp.id));
    await db.insert(decisionsTable).values({
      id: newId("dec"),
      orgId,
      opportunityId: opp.id,
      cycleId: opp.cycleId,
      eventType: "execute",
      actor: req.actorEmail ?? "system@procuro.ai",
    });
    await writeStageHistory({
      opportunityId: opp.id,
      orgId,
      fromStage: opp.canonicalStage ?? null,
      toStage: newStage,
      actor: req.actorEmail ?? null,
      reason: "STATUS_CHANGE",
    });
  }
  await updateCycleAggregates(orgId, opp.cycleId);
  const [updated] = await db
    .select()
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opp.id));
  res.json(mapOpportunity({ opp: updated! }));
});

router.post("/opportunities/:id/realize", tenantMiddleware, requirePermission("opp:realize"), async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  // Throw on invalid input and let the global error handler shape the
  // 400 response (`{ error, details }`). See global-error-handler.ts.
  const { realizedSavingsUsd } = realizeOpportunityBodySchema.parse(req.body);

  const opp = await loadOppOrThrow(orgId, id);
  if (!opp) {
    throw new NotFoundError("Opportunity not found");
  }
  if (opp.status !== "executing" && opp.status !== "approved") {
    throw new ConflictError(`Cannot realize from status '${opp.status}'`);
  }
  const { canonicalStage: newStage, savingsType: newSavingsType } =
    s2pForStatusTransition("realized");
  const now = new Date();
  await db
    .update(opportunitiesTable)
    .set({
      status: "realized",
      realizedSavingsUsd: realizedSavingsUsd.toFixed(2),
      realizedAt: now,
      canonicalStage: newStage,
      savingsType: newSavingsType,
      stageEnteredAt: now,
    })
    .where(eq(opportunitiesTable.id, opp.id));
  await db.insert(decisionsTable).values({
    id: newId("dec"),
    orgId,
    opportunityId: opp.id,
    cycleId: opp.cycleId,
    eventType: "realize",
    actor: req.actorEmail ?? "system@procuro.ai",
    realizedSavingsUsd: realizedSavingsUsd.toFixed(2),
  });
  await writeStageHistory({
    opportunityId: opp.id,
    orgId,
    fromStage: opp.canonicalStage ?? null,
    toStage: newStage,
    actor: req.actorEmail ?? null,
    reason: "STATUS_CHANGE",
  });
  await updateCycleAggregates(orgId, opp.cycleId);
  const [updated] = await db
    .select()
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opp.id));
  res.json(mapOpportunity({ opp: updated! }));
});

const baselineMethodValues = [
  "Prior Unit Price",
  "Market Index",
  "Should-Cost Model",
  "Supplier Proposed Increase",
  "Internal Estimate",
  "N/A — Soft",
] as const;

export const patchOpportunityClassificationBodySchema = z.object({
  baselineValue: z
    .union([z.number().finite(), z.null()])
    .optional(),
  baselineMethod: z
    .enum(baselineMethodValues)
    .nullable()
    .optional(),
  baselineSource: z
    .string()
    .nullable()
    .optional(),
  sourcingStrategy: z
    .enum(sourcingStrategyValues)
    .nullable()
    .optional(),
  savingsClassification: z
    .enum(savingsClassificationValues)
    .nullable()
    .optional(),
});

router.patch(
  "/opportunities/:id",
  tenantMiddleware,
  requirePermission("opp:approve"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params.id);
    const body = patchOpportunityClassificationBodySchema.parse(req.body);

    const opp = await loadOppOrThrow(orgId, id);
    if (!opp) {
      throw new NotFoundError("Opportunity not found");
    }

    const hasAnyField =
      body.baselineValue !== undefined ||
      body.baselineMethod !== undefined ||
      body.baselineSource !== undefined ||
      body.sourcingStrategy !== undefined ||
      body.savingsClassification !== undefined;

    if (!hasAnyField) {
      throw new InvalidRequestError("At least one field must be provided");
    }

    const patch: Partial<typeof opportunitiesTable.$inferInsert> = {
      classificationNeedsReview: false,
    };
    if (body.baselineValue !== undefined) {
      patch.baselineValue =
        body.baselineValue !== null ? String(body.baselineValue) : null;
    }
    if (body.baselineMethod !== undefined) {
      patch.baselineMethod = body.baselineMethod ?? null;
    }
    if (body.baselineSource !== undefined) {
      patch.baselineSource = body.baselineSource ?? null;
    }
    if (body.sourcingStrategy !== undefined) {
      patch.sourcingStrategy = body.sourcingStrategy ?? "Unclassified";
    }
    if (body.savingsClassification !== undefined) {
      patch.savingsClassification = body.savingsClassification ?? null;
    }

    await db
      .update(opportunitiesTable)
      .set(patch)
      .where(
        and(eq(opportunitiesTable.orgId, orgId), eq(opportunitiesTable.id, id)),
      );

    await writeStageHistory({
      opportunityId: opp.id,
      orgId,
      fromStage: opp.canonicalStage ?? null,
      toStage: opp.canonicalStage ?? "Identified",
      actor: req.actorEmail ?? null,
      reason: "CLASSIFICATION_UPDATE",
    });

    await recordSingleOpportunityAudit(req, {
      orgId,
      action: "opportunity.classify",
      opportunityId: opp.id,
      label: opp.title,
      extra: {
        baselineMethod: body.baselineMethod,
        sourcingStrategy: body.sourcingStrategy,
        savingsClassification: body.savingsClassification,
      },
    });

    const [updated] = await db
      .select({
        opp: opportunitiesTable,
        supplierName: suppliersTable.name,
        categoryName: categoriesTable.name,
      })
      .from(opportunitiesTable)
      .leftJoin(
        suppliersTable,
        eq(opportunitiesTable.supplierId, suppliersTable.id),
      )
      .leftJoin(
        categoriesTable,
        eq(opportunitiesTable.categoryId, categoriesTable.id),
      )
      .where(eq(opportunitiesTable.id, opp.id));
    res.json(mapOpportunity(updated!));
  },
);

export default router;
