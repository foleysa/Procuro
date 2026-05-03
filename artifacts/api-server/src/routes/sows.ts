import { Router, type IRouter } from "express";
import {
  db,
  statementsOfWorkTable,
  sowMilestonesTable,
  sowChangeOrdersTable,
  suppliersTable,
  contractsTable,
  type StatementOfWorkRow,
  type SowMilestoneRow,
  type SowChangeOrderRow,
} from "@workspace/db";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { NotFoundError } from "../lib/api-errors";

const router: IRouter = Router();

const TERMINAL_MILESTONE_STATUSES = [
  "accepted",
  "invoiced",
  "paid",
  "cancelled",
] as const;

function isOpenMilestone(status: string): boolean {
  return !(TERMINAL_MILESTONE_STATUSES as readonly string[]).includes(status);
}

const EARNED_MILESTONE_STATUSES = ["accepted", "invoiced", "paid"] as const;
const INVOICED_MILESTONE_STATUSES = ["invoiced", "paid"] as const;

function mapSowRow(args: {
  s: StatementOfWorkRow;
  supplierName: string | null;
  msaContractNumber: string | null;
  msaContractTitle: string | null;
  milestoneCount: number;
  openMilestoneCount: number;
  earnedUsd: number;
  changeOrderCount: number;
}): Record<string, unknown> {
  const {
    s,
    supplierName,
    msaContractNumber,
    msaContractTitle,
    milestoneCount,
    openMilestoneCount,
    earnedUsd,
    changeOrderCount,
  } = args;
  const nteUsd = s.totalValueUsd === null ? 0 : Number(s.totalValueUsd);
  const burnedPct = nteUsd > 0 ? Math.min(1, earnedUsd / nteUsd) : 0;
  return {
    id: s.id,
    sowNumber: s.sowNumber,
    title: s.title,
    status: s.status,
    supplierId: s.supplierId,
    supplierName,
    msaContractId: s.contractId,
    msaContractNumber,
    msaContractTitle,
    startDate: s.startDate,
    endDate: s.endDate,
    currency: s.billingCurrency ?? "USD",
    totalValue: s.totalValueUsd === null ? null : Number(s.totalValueUsd),
    totalValueUsd: nteUsd,
    nteUsd,
    earnedUsd,
    burnedPct,
    milestoneCount,
    openMilestoneCount,
    changeOrderCount,
    owner: null,
    createdAt: s.createdAt,
  };
}

function mapMilestone(m: SowMilestoneRow, currency: string | null): Record<string, unknown> {
  const open = isOpenMilestone(m.status);
  const isOverdue =
    open && m.dueDate !== null && m.dueDate.getTime() < Date.now();
  return {
    id: m.id,
    sowId: m.sowId,
    sequence: m.milestoneNumber,
    title: m.title,
    status: m.status,
    dueDate: m.dueDate,
    deliveredDate: m.deliveredAt,
    acceptedDate: m.acceptedAt,
    amount: m.valueUsd === null ? null : Number(m.valueUsd),
    amountUsd: m.valueUsd === null ? 0 : Number(m.valueUsd),
    currency,
    acceptanceCriteria: m.description,
    isOverdue,
  };
}

function mapChangeOrder(c: SowChangeOrderRow, currency: string | null): Record<string, unknown> {
  // Map storage statuses to API enum (proposed/approved/rejected/executed → pending/approved/rejected).
  const apiStatus =
    c.status === "approved" || c.status === "executed"
      ? "approved"
      : c.status === "rejected"
        ? "rejected"
        : "pending";
  return {
    id: c.id,
    sowId: c.sowId,
    changeNumber: c.changeOrderNumber,
    title: c.title,
    status: apiStatus,
    amountDelta: c.valueDeltaUsd === null ? null : Number(c.valueDeltaUsd),
    amountDeltaUsd: c.valueDeltaUsd === null ? 0 : Number(c.valueDeltaUsd),
    currency,
    reason: c.description,
    approver: c.approver,
    createdAt: c.createdAt,
    approvedAt: c.executedAt,
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}
function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf("|");
    if (sep <= 0) return null;
    const dateStr = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    const createdAt = new Date(dateStr);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

// ─── GET /sows ───────────────────────────────────────────────────────────

router.get("/sows", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? "50", 10) || 50, 1),
    200,
  );
  const cursor = req.query.cursor as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();
  const statusFilter = req.query.status as string | undefined;
  const supplierIdFilter = req.query.supplierId as string | undefined;
  const msaContractIdFilter = req.query.msaContractId as string | undefined;

  const where = [eq(statementsOfWorkTable.orgId, orgId)];

  if (
    statusFilter === "draft" ||
    statusFilter === "active" ||
    statusFilter === "completed" ||
    statusFilter === "cancelled"
  ) {
    where.push(eq(statementsOfWorkTable.status, statusFilter));
  } else if (statusFilter !== "all") {
    // Default to active; pass `?status=all` to see every SOW.
    where.push(eq(statementsOfWorkTable.status, "active"));
  }
  if (search) {
    const like = `%${search}%`;
    const cond = or(
      ilike(statementsOfWorkTable.sowNumber, like),
      ilike(statementsOfWorkTable.title, like),
    );
    if (cond) where.push(cond);
  }
  if (supplierIdFilter) {
    where.push(eq(statementsOfWorkTable.supplierId, supplierIdFilter));
  }
  if (msaContractIdFilter) {
    where.push(eq(statementsOfWorkTable.contractId, msaContractIdFilter));
  }
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      const cond = or(
        sql`${statementsOfWorkTable.createdAt} < ${decoded.createdAt}`,
        and(
          eq(statementsOfWorkTable.createdAt, decoded.createdAt),
          sql`${statementsOfWorkTable.id} > ${decoded.id}`,
        ),
      );
      if (cond) where.push(cond);
    }
  }

  const rows = await db
    .select({
      s: statementsOfWorkTable,
      supplierName: suppliersTable.name,
      msaContractNumber: contractsTable.contractNumber,
      msaContractTitle: contractsTable.title,
    })
    .from(statementsOfWorkTable)
    .leftJoin(suppliersTable, eq(statementsOfWorkTable.supplierId, suppliersTable.id))
    .leftJoin(contractsTable, eq(statementsOfWorkTable.contractId, contractsTable.id))
    .where(and(...where))
    .orderBy(desc(statementsOfWorkTable.createdAt), asc(statementsOfWorkTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;

  // Milestone + earned + change-order roll-ups per SOW (one query each).
  const sowIds = sliced.map((r) => r.s.id);
  const milestoneCounts = new Map<
    string,
    { total: number; open: number; earnedUsd: number }
  >();
  const changeOrderCounts = new Map<string, number>();
  if (sowIds.length > 0) {
    // Pass IDs as a single comma-joined string param and split server-side
    // with `string_to_array(...)`. Drizzle's tagged template treats a JS
    // array template value as nested chunks `(p0, p1, …)`, which Postgres
    // cannot cast to `text[]`; the string-split form sends a single
    // parameter and lets Postgres do the splitting. SOW IDs are
    // `sow_…`-prefixed UUID slugs, so a comma delimiter is safe.
    const sowIdsCsv = sowIds.join(",");
    const [counts, coCounts] = await Promise.all([
      db.execute(sql`
        SELECT sow_id,
               COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE status NOT IN ('accepted','invoiced','paid','cancelled')
               ) AS open,
               COALESCE(SUM(value_usd::numeric) FILTER (
                 WHERE status IN ('accepted','invoiced','paid')
               ), 0)::text AS earned_usd
        FROM sow_milestones
        WHERE org_id = ${orgId}
          AND sow_id = ANY(string_to_array(${sowIdsCsv}, ','))
        GROUP BY sow_id
      `),
      db.execute(sql`
        SELECT sow_id, COUNT(*) AS n
        FROM sow_change_orders
        WHERE org_id = ${orgId}
          AND sow_id = ANY(string_to_array(${sowIdsCsv}, ','))
        GROUP BY sow_id
      `),
    ]);
    for (const c of counts.rows as Array<{
      sow_id: string;
      total: string;
      open: string;
      earned_usd: string;
    }>) {
      milestoneCounts.set(c.sow_id, {
        total: Number(c.total),
        open: Number(c.open),
        earnedUsd: Number(c.earned_usd),
      });
    }
    for (const c of coCounts.rows as Array<{ sow_id: string; n: string }>) {
      changeOrderCounts.set(c.sow_id, Number(c.n));
    }
  }

  const items = sliced.map((r) => {
    const counts = milestoneCounts.get(r.s.id) ?? {
      total: 0,
      open: 0,
      earnedUsd: 0,
    };
    return mapSowRow({
      s: r.s,
      supplierName: r.supplierName,
      msaContractNumber: r.msaContractNumber,
      msaContractTitle: r.msaContractTitle,
      milestoneCount: counts.total,
      openMilestoneCount: counts.open,
      earnedUsd: counts.earnedUsd,
      changeOrderCount: changeOrderCounts.get(r.s.id) ?? 0,
    });
  });
  const last = sliced.at(-1);
  res.json({
    items,
    nextCursor: hasMore && last ? encodeCursor(last.s.createdAt, last.s.id) : null,
  });
});

// ─── GET /sows/:id ───────────────────────────────────────────────────────

router.get("/sows/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);

  const [row] = await db
    .select({
      s: statementsOfWorkTable,
      supplierName: suppliersTable.name,
      msaContractNumber: contractsTable.contractNumber,
      msaContractTitle: contractsTable.title,
      msaContractType: contractsTable.contractType,
    })
    .from(statementsOfWorkTable)
    .leftJoin(suppliersTable, eq(statementsOfWorkTable.supplierId, suppliersTable.id))
    .leftJoin(contractsTable, eq(statementsOfWorkTable.contractId, contractsTable.id))
    .where(
      and(eq(statementsOfWorkTable.orgId, orgId), eq(statementsOfWorkTable.id, id)),
    );
  if (!row) {
    throw new NotFoundError("SOW not found");
  }

  const [milestones, changeOrders, linkedOppRows, weeklyBurnRows, byResourceRows] = await Promise.all([
    db
      .select()
      .from(sowMilestonesTable)
      .where(
        and(eq(sowMilestonesTable.orgId, orgId), eq(sowMilestonesTable.sowId, id)),
      )
      .orderBy(asc(sowMilestonesTable.milestoneNumber)),
    db
      .select()
      .from(sowChangeOrdersTable)
      .where(
        and(
          eq(sowChangeOrdersTable.orgId, orgId),
          eq(sowChangeOrdersTable.sowId, id),
        ),
      )
      .orderBy(desc(sowChangeOrdersTable.createdAt)),
    // Open linked opportunities — OODA-actionable statuses only
    // ('realized'/'rejected'/'expired' are archive states and don't
    // belong on the active surface). Three linkage modes are unioned
    // so future scope/hours-audit levers (which key cohorts off the
    // SOW id rather than carrying it on `inputs.sowId`) still
    // surface here:
    //   1. `inputs->>'sowId'` — explicit SOW reference written by the
    //      lever (current convention for SOW-aware levers).
    //   2. `inputs->>'cohortKey'` equals the sow id — convention for
    //      levers that anchor cohorts on the SOW itself.
    //   3. `signal_key` ends in `:<sowId>` — composeSignalKey uses
    //      `<lever>:<supplier>:<category>:<leverCohortKey>`, so when
    //      a lever's `cohortKey()` returns the sowId the trailing
    //      segment matches. This mode is what `scope_management` and
    //      `hours_audit` (planned tier-3 levers) will use.
    db.execute(sql`
      SELECT id, lever_id, status, title, projected_savings_usd::text AS savings, created_at
      FROM opportunities
      WHERE org_id = ${orgId}
        AND status IN ('proposed','approved','executing')
        AND (
          inputs->>'sowId' = ${id}
          OR inputs->>'cohortKey' = ${id}
          OR signal_key LIKE ${"%:" + id}
        )
      ORDER BY created_at DESC
      LIMIT 25
    `),
    // Weekly burn from time_entries against this SOW. Bucketed to ISO
    // week so the chart renders Mon-anchored bars regardless of when
    // hours were logged. The 26-week window keeps the chart readable
    // even on long-running SOWs; older history rolls off.
    db.execute(sql`
      SELECT
        DATE_TRUNC('week', work_date)::date AS week_start,
        COALESCE(SUM(hours::numeric), 0)::text AS hours_billed,
        COALESCE(SUM(amount_usd::numeric), 0)::text AS amount_usd
      FROM time_entries
      WHERE org_id = ${orgId}
        AND sow_id = ${id}
        AND work_date >= NOW() - INTERVAL '26 weeks'
      GROUP BY DATE_TRUNC('week', work_date)
      ORDER BY DATE_TRUNC('week', work_date) ASC
    `),
    // Per-resource rollup over the trailing 365 days. Sorted by
    // billed amount desc so the heaviest contributors land on top.
    // Role/seniority pick the most recent values seen for the
    // resource, which is good enough to colour the row even when a
    // person rolled across roles inside the window.
    db.execute(sql`
      SELECT
        resource,
        (ARRAY_AGG(role ORDER BY work_date DESC) FILTER (WHERE role IS NOT NULL))[1] AS role,
        (ARRAY_AGG(seniority ORDER BY work_date DESC) FILTER (WHERE seniority IS NOT NULL))[1] AS seniority,
        COALESCE(SUM(hours::numeric), 0)::text AS hours_billed,
        COALESCE(SUM(amount_usd::numeric), 0)::text AS amount_usd,
        COUNT(*) AS entry_count,
        CASE
          WHEN SUM(hours::numeric) > 0
            THEN (SUM(amount_usd::numeric) / SUM(hours::numeric))::text
          ELSE NULL
        END AS avg_bill_rate_usd,
        MAX(work_date)::date AS last_work_date
      FROM time_entries
      WHERE org_id = ${orgId}
        AND sow_id = ${id}
        AND work_date >= NOW() - INTERVAL '365 days'
      GROUP BY resource
      ORDER BY SUM(amount_usd::numeric) DESC NULLS LAST, resource ASC
      LIMIT 50
    `),
  ]);

  const open = milestones.filter((m) => isOpenMilestone(m.status)).length;
  const currency = row.s.billingCurrency ?? "USD";

  const committedUsd =
    row.s.totalValueUsd === null ? 0 : Number(row.s.totalValueUsd);
  const earnedUsd = milestones
    .filter((m) =>
      (EARNED_MILESTONE_STATUSES as readonly string[]).includes(m.status),
    )
    .reduce((sum, m) => sum + (m.valueUsd === null ? 0 : Number(m.valueUsd)), 0);
  const invoicedUsd = milestones
    .filter((m) =>
      (INVOICED_MILESTONE_STATUSES as readonly string[]).includes(m.status),
    )
    .reduce((sum, m) => sum + (m.valueUsd === null ? 0 : Number(m.valueUsd)), 0);

  // Weekly burn series from time_entries — the new chart on the SOW
  // detail page. Each row carries the bucketed dollar burn AND a
  // running cumulative so the FE can stack a "spent vs NTE ceiling"
  // chart without needing to scan again.
  type WeeklyBurnRowRaw = {
    week_start: Date | string;
    hours_billed: string;
    amount_usd: string;
  };
  let cumulativeUsd = 0;
  const weeklyBurn = (weeklyBurnRows.rows as WeeklyBurnRowRaw[]).map((r) => {
    const amountUsd = Number(r.amount_usd);
    cumulativeUsd += amountUsd;
    return {
      weekStart:
        r.week_start instanceof Date
          ? r.week_start.toISOString().slice(0, 10)
          : String(r.week_start).slice(0, 10),
      hoursBilled: Number(r.hours_billed),
      amountUsd,
      cumulativeUsd,
    };
  });

  // NTE-anchored runway. The SOW's `total_value_usd` is the
  // not-to-exceed ceiling; we project how many weeks of remaining
  // capacity exist at the trailing 4-week average burn rate. When
  // there's no recent burn history we fall back to the full window's
  // average so a brand-new SOW still gets a (rough) projection. Null
  // when the SOW has zero NTE or no time_entries at all.
  const nteUsd = committedUsd;
  const totalBurnedUsd = cumulativeUsd;
  const burnedPct = nteUsd > 0 ? Math.min(1, totalBurnedUsd / nteUsd) : 0;
  const remainingUsd = Math.max(0, nteUsd - totalBurnedUsd);
  const trailing = weeklyBurn.slice(-4);
  const trailingAvgWeeklyUsd =
    trailing.length > 0
      ? trailing.reduce((s, w) => s + w.amountUsd, 0) / trailing.length
      : weeklyBurn.length > 0
        ? totalBurnedUsd / weeklyBurn.length
        : 0;
  const runwayDays =
    trailingAvgWeeklyUsd > 0
      ? Math.round((remainingUsd / trailingAvgWeeklyUsd) * 7)
      : null;

  // Per-resource rollup. Mirrors the weekly series but bucketed by
  // person rather than time, capped at 50 to keep the table on screen.
  type ByResourceRowRaw = {
    resource: string;
    role: string | null;
    seniority: string | null;
    hours_billed: string;
    amount_usd: string;
    entry_count: string;
    avg_bill_rate_usd: string | null;
    last_work_date: Date | string | null;
  };
  const byResource = (byResourceRows.rows as ByResourceRowRaw[]).map((r) => ({
    resource: r.resource,
    role: r.role,
    seniority: r.seniority,
    hoursBilled: Number(r.hours_billed),
    amountUsd: Number(r.amount_usd),
    entryCount: Number(r.entry_count),
    avgBillRateUsd: r.avg_bill_rate_usd === null ? null : Number(r.avg_bill_rate_usd),
    lastWorkDate:
      r.last_work_date === null
        ? null
        : r.last_work_date instanceof Date
          ? r.last_work_date.toISOString().slice(0, 10)
          : String(r.last_work_date).slice(0, 10),
  }));

  const burn = {
    committedUsd,
    nteUsd,
    earnedUsd,
    burnedUsd: totalBurnedUsd,
    burnedPct,
    invoicedUsd,
    runwayDays,
    avgWeeklyBurnUsd: trailingAvgWeeklyUsd,
    weekly: weeklyBurn,
    byResource,
  };

  const linkedOpportunities = (
    linkedOppRows.rows as Array<{
      id: string;
      lever_id: string;
      status: string;
      title: string;
      savings: string | null;
      created_at: Date | string;
    }>
  ).map((o) => ({
    id: o.id,
    leverId: o.lever_id,
    status: o.status,
    title: o.title,
    projectedSavingsUsd: Number(o.savings ?? 0),
    createdAt: o.created_at instanceof Date ? o.created_at.toISOString() : String(o.created_at),
  }));

  // Billing model = the parent MSA contract's commercial structure.
  // Falls back to null when the SOW has no parent contract or the
  // contract has no contract_type set.
  const billingModel = row.msaContractType ?? null;

  res.json({
    ...mapSowRow({
      s: row.s,
      supplierName: row.supplierName,
      msaContractNumber: row.msaContractNumber,
      msaContractTitle: row.msaContractTitle,
      milestoneCount: milestones.length,
      openMilestoneCount: open,
      earnedUsd,
      changeOrderCount: changeOrders.length,
    }),
    description: null,
    scope: row.s.scope ?? null,
    billingModel,
    acceptanceCriteria: row.s.acceptanceCriteria,
    burn,
    linkedOpportunities,
    milestones: milestones.map((m) => mapMilestone(m, currency)),
    changeOrders: changeOrders.map((c) => mapChangeOrder(c, currency)),
  });
});

export default router;
