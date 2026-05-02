import { Router, type IRouter } from "express";
import {
  db,
  rateCardsTable,
  rateCardLinesTable,
  timeEntriesTable,
  statementsOfWorkTable,
  suppliersTable,
  type RateCardRow,
  type RateCardLineRow,
} from "@workspace/db";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";

const router: IRouter = Router();

/** Derive the API status from `effectiveDate` / `expiryDate`. */
function deriveCardStatus(
  effective: Date,
  expiry: Date | null,
  now: Date = new Date(),
): "draft" | "active" | "expired" {
  if (effective > now) return "draft";
  if (expiry && expiry < now) return "expired";
  return "active";
}

function effectiveUnitRateUsd(line: RateCardLineRow): number {
  // Hourly preferred. Daily / 8 as approximate fallback so rate
  // benchmarks can compare apples-to-apples on the colour band.
  if (line.hourlyRate !== null) return Number(line.hourlyRate);
  if (line.dailyRate !== null) return Number(line.dailyRate) / 8;
  return 0;
}

function mapCardRow(args: {
  c: RateCardRow;
  supplierName: string | null;
  lineCount: number;
  offCardSpendUsd: number;
}): Record<string, unknown> {
  const { c, supplierName, lineCount, offCardSpendUsd } = args;
  return {
    id: c.id,
    name: c.name,
    status: deriveCardStatus(c.effectiveDate, c.expiryDate),
    supplierId: c.supplierId,
    supplierName,
    msaContractId: c.contractId,
    currency: c.currency,
    effectiveStart: c.effectiveDate,
    effectiveEnd: c.expiryDate,
    lineCount,
    offCardSpendUsd,
    createdAt: c.createdAt,
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

// ─── GET /rate-cards ─────────────────────────────────────────────────────

router.get("/rate-cards", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? "50", 10) || 50, 1),
    200,
  );
  const cursor = req.query.cursor as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();
  const statusFilter = req.query.status as string | undefined;
  const supplierIdFilter = req.query.supplierId as string | undefined;

  const where = [eq(rateCardsTable.orgId, orgId)];
  if (search) {
    where.push(ilike(rateCardsTable.name, `%${search}%`));
  }
  if (supplierIdFilter) {
    where.push(eq(rateCardsTable.supplierId, supplierIdFilter));
  }
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      const cond = or(
        sql`${rateCardsTable.createdAt} < ${decoded.createdAt}`,
        and(
          eq(rateCardsTable.createdAt, decoded.createdAt),
          sql`${rateCardsTable.id} > ${decoded.id}`,
        ),
      );
      if (cond) where.push(cond);
    }
  }
  // Status is derived from effective/expiry dates relative to NOW().
  // Apply the predicate in SQL (before pagination) so the cursor and
  // page sizing remain stable under filtering.
  if (statusFilter === "draft") {
    where.push(sql`${rateCardsTable.effectiveDate} > NOW()`);
  } else if (statusFilter === "expired") {
    where.push(
      sql`${rateCardsTable.expiryDate} IS NOT NULL AND ${rateCardsTable.expiryDate} < NOW()`,
    );
  } else if (statusFilter === "active") {
    where.push(
      sql`${rateCardsTable.effectiveDate} <= NOW() AND (${rateCardsTable.expiryDate} IS NULL OR ${rateCardsTable.expiryDate} >= NOW())`,
    );
  }

  const rows = await db
    .select({
      c: rateCardsTable,
      supplierName: suppliersTable.name,
    })
    .from(rateCardsTable)
    .leftJoin(suppliersTable, eq(rateCardsTable.supplierId, suppliersTable.id))
    .where(and(...where))
    .orderBy(desc(rateCardsTable.createdAt), asc(rateCardsTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;

  const cardIds = sliced.map((r) => r.c.id);
  const lineCounts = new Map<string, number>();
  const offCardSpend = new Map<string, number>();
  if (cardIds.length > 0) {
    const lc = await db.execute(sql`
      SELECT rate_card_id, COUNT(*) AS n
      FROM rate_card_lines
      WHERE org_id = ${orgId}
        AND rate_card_id = ANY(${cardIds}::text[])
      GROUP BY rate_card_id
    `);
    for (const r of lc.rows as Array<{ rate_card_id: string; n: string }>) {
      lineCounts.set(r.rate_card_id, Number(r.n));
    }

    // Off-card = trailing-365d time entries with rate_card_line_id NULL.
    const oc = await db.execute(sql`
      SELECT rate_card_id,
             COALESCE(SUM(amount_usd::numeric), 0) AS spend
      FROM time_entries
      WHERE org_id = ${orgId}
        AND rate_card_id = ANY(${cardIds}::text[])
        AND rate_card_line_id IS NULL
        AND work_date >= NOW() - INTERVAL '365 days'
      GROUP BY rate_card_id
    `);
    for (const r of oc.rows as Array<{ rate_card_id: string; spend: string }>) {
      offCardSpend.set(r.rate_card_id, Number(r.spend));
    }
  }

  const items = sliced.map((r) =>
    mapCardRow({
      c: r.c,
      supplierName: r.supplierName,
      lineCount: lineCounts.get(r.c.id) ?? 0,
      offCardSpendUsd: offCardSpend.get(r.c.id) ?? 0,
    }),
  );

  const last = sliced.at(-1);
  res.json({
    items,
    nextCursor: hasMore && last ? encodeCursor(last.c.createdAt, last.c.id) : null,
  });
});

// ─── GET /rate-cards/:id ─────────────────────────────────────────────────

router.get("/rate-cards/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);

  const [row] = await db
    .select({
      c: rateCardsTable,
      supplierName: suppliersTable.name,
    })
    .from(rateCardsTable)
    .leftJoin(suppliersTable, eq(rateCardsTable.supplierId, suppliersTable.id))
    .where(and(eq(rateCardsTable.orgId, orgId), eq(rateCardsTable.id, id)));
  if (!row) {
    res.status(404).json({ error: "Rate card not found" });
    return;
  }

  const [lines, recentOffCardEntries, linkedOppRows] = await Promise.all([
    db
      .select()
      .from(rateCardLinesTable)
      .where(
        and(
          eq(rateCardLinesTable.orgId, orgId),
          eq(rateCardLinesTable.rateCardId, id),
        ),
      )
      .orderBy(asc(rateCardLinesTable.role), asc(rateCardLinesTable.seniority)),
    db
      .select({
        t: timeEntriesTable,
        sowNumber: statementsOfWorkTable.sowNumber,
      })
      .from(timeEntriesTable)
      .leftJoin(
        statementsOfWorkTable,
        eq(timeEntriesTable.sowId, statementsOfWorkTable.id),
      )
      .where(
        and(
          eq(timeEntriesTable.orgId, orgId),
          eq(timeEntriesTable.rateCardId, id),
          isNull(timeEntriesTable.rateCardLineId),
          sql`${timeEntriesTable.workDate} >= NOW() - INTERVAL '365 days'`,
        ),
      )
      .orderBy(desc(timeEntriesTable.workDate))
      .limit(10),
    // Open services opportunities flagged against this card. We
    // accept any lever — the canonical one today is
    // `services_rate_card_benchmark` but future services-side levers
    // will use the same `inputs.rateCardId` convention.
    db.execute(sql`
      SELECT id, lever_id, status, title, projected_savings_usd::text AS savings, created_at
      FROM opportunities
      WHERE org_id = ${orgId}
        AND status IN ('proposed','approved','executing')
        AND inputs->>'rateCardId' = ${id}
      ORDER BY created_at DESC
      LIMIT 25
    `),
  ]);

  // Most-recent OEWS wage benchmark per role on this card.
  const roles = Array.from(new Set(lines.map((l) => l.role).filter(Boolean)));
  type BenchmarkRow = {
    role: string;
    p50_usd: string | null;
    p75_usd: string | null;
    p90_usd: string | null;
    observed_at: Date;
    source: string;
  };
  const benchmarks = new Map<string, BenchmarkRow>();
  if (roles.length > 0) {
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (LOWER(scope_material_code))
        LOWER(scope_material_code) AS role,
        (metadata->>'p50_usd')::numeric AS p50_usd,
        (metadata->>'p75_usd')::numeric AS p75_usd,
        (metadata->>'p90_usd')::numeric AS p90_usd,
        observed_at,
        collector_id AS source
      FROM market_signals
      WHERE signal_type = 'oews_wage'
        AND (org_id = ${orgId} OR org_id IS NULL)
        AND LOWER(scope_material_code) = ANY(${roles.map((r) => r.toLowerCase())}::text[])
      ORDER BY LOWER(scope_material_code), observed_at DESC
    `);
    for (const r of rows.rows as BenchmarkRow[]) {
      benchmarks.set(r.role, r);
    }
  }

  function bandFor(unitRateUsd: number, b: BenchmarkRow): "green" | "yellow" | "orange" | "red" {
    const p50 = b.p50_usd === null ? null : Number(b.p50_usd);
    const p75 = b.p75_usd === null ? null : Number(b.p75_usd);
    const p90 = b.p90_usd === null ? null : Number(b.p90_usd);
    if (p90 !== null && unitRateUsd > p90) return "red";
    if (p75 !== null && unitRateUsd > p75) return "orange";
    if (p50 !== null && unitRateUsd > p50) return "yellow";
    return "green";
  }

  const mappedLines = lines.map((l) => {
    const unitRate = effectiveUnitRateUsd(l);
    const unit = l.hourlyRate !== null ? "hour" : l.dailyRate !== null ? "day" : "hour";
    const benchmark = benchmarks.get(l.role.toLowerCase());
    const marketBenchmark = benchmark
      ? {
          band: bandFor(unitRate, benchmark),
          p50Usd: benchmark.p50_usd === null ? null : Number(benchmark.p50_usd),
          p75Usd: benchmark.p75_usd === null ? null : Number(benchmark.p75_usd),
          p90Usd: benchmark.p90_usd === null ? null : Number(benchmark.p90_usd),
          source: benchmark.source,
          observedAt: benchmark.observed_at,
        }
      : null;
    return {
      id: l.id,
      role: l.role,
      seniority: l.seniority,
      skill: null,
      geography: l.geography,
      billingModel: l.billingModel,
      unit,
      unitRate,
      unitRateUsd: unitRate,
      currency: row.c.currency,
      marketBenchmark,
    };
  });

  // Pivot lines into a role × seniority grid for the FE ladder view.
  const grid = new Map<
    string,
    {
      role: string;
      cells: {
        seniority: string | null;
        geography: string | null;
        billingModel: string | null;
        lineId: string;
        unitRateUsd: number;
        unit: string;
        band: "green" | "yellow" | "orange" | "red" | null;
      }[];
    }
  >();
  for (const l of mappedLines) {
    const g = grid.get(l.role) ?? { role: l.role, cells: [] };
    g.cells.push({
      seniority: l.seniority ?? null,
      geography: l.geography ?? null,
      billingModel: l.billingModel ?? null,
      lineId: l.id,
      unitRateUsd: l.unitRateUsd,
      unit: l.unit,
      band: l.marketBenchmark?.band ?? null,
    });
    grid.set(l.role, g);
  }
  const linesByRole = Array.from(grid.values());

  // Off-card leakage: (1) time-entry off-card, (2) PO-line
  // mismatches, (3) invoice off-card.
  const [
    offCardRow,
    offCardPoRow,
    offCardPoLinesRows,
    offCardInvoiceRow,
    offCardInvoiceLinesRows,
  ] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(SUM(amount_usd::numeric), 0) AS spend
      FROM time_entries
      WHERE org_id = ${orgId}
        AND rate_card_id = ${id}
        AND rate_card_line_id IS NULL
        AND work_date >= NOW() - INTERVAL '365 days'
    `),
    // PO-line mismatch aggregate.
    row.c.contractId
      ? db.execute(sql`
          WITH card_max AS (
            SELECT COALESCE(MAX(hourly_rate::numeric), 0) AS max_hourly
            FROM rate_card_lines
            WHERE org_id = ${orgId}
              AND rate_card_id = ${id}
          )
          SELECT COALESCE(SUM(pol.extended_usd::numeric), 0) AS spend
          FROM po_lines pol
          JOIN purchase_orders po ON po.id = pol.po_id
          LEFT JOIN categories cat ON cat.id = pol.category_id
          CROSS JOIN card_max
          WHERE pol.org_id = ${orgId}
            AND po.contract_id = ${row.c.contractId}
            AND pol.order_date >= NOW() - INTERVAL '365 days'
            AND cat.class = 'service'
            AND (
              card_max.max_hourly = 0
              OR pol.unit_price_usd::numeric > card_max.max_hourly
            )
        `)
      : Promise.resolve({ rows: [{ spend: "0" }] }),
    // Per-line PO-mismatch listing (capped at 50, ordered by extended desc).
    row.c.contractId
      ? db.execute(sql`
          WITH card_max AS (
            SELECT COALESCE(MAX(hourly_rate::numeric), 0) AS max_hourly
            FROM rate_card_lines
            WHERE org_id = ${orgId}
              AND rate_card_id = ${id}
          )
          SELECT
            pol.id AS line_id,
            po.id AS po_id,
            po.po_number AS po_number,
            po.supplier_id AS supplier_id,
            sup.name AS supplier_name,
            pol.order_date AS order_date,
            pol.description AS description,
            cat.id AS category_id,
            cat.name AS category_name,
            pol.unit_price_usd::text AS unit_price_usd,
            pol.extended_usd::text AS extended_usd,
            (SELECT max_hourly::text FROM card_max) AS card_max_hourly
          FROM po_lines pol
          JOIN purchase_orders po ON po.id = pol.po_id
          LEFT JOIN suppliers sup ON sup.id = po.supplier_id
          LEFT JOIN categories cat ON cat.id = pol.category_id
          CROSS JOIN card_max
          WHERE pol.org_id = ${orgId}
            AND po.contract_id = ${row.c.contractId}
            AND pol.order_date >= NOW() - INTERVAL '365 days'
            AND cat.class = 'service'
            AND (
              card_max.max_hourly = 0
              OR pol.unit_price_usd::numeric > card_max.max_hourly
            )
          ORDER BY pol.extended_usd::numeric DESC NULLS LAST
          LIMIT 50
        `)
      : Promise.resolve({ rows: [] as unknown[] }),
    // Invoice off-card aggregate (parent-MSA invoices, t-365d).
    row.c.contractId
      ? db.execute(sql`
          WITH card_max AS (
            SELECT COALESCE(MAX(hourly_rate::numeric), 0) AS max_hourly
            FROM rate_card_lines
            WHERE org_id = ${orgId}
              AND rate_card_id = ${id}
          )
          SELECT COALESCE(SUM(inv.amount_usd::numeric), 0) AS spend
          FROM invoices inv
          JOIN purchase_orders po ON po.id = inv.po_id
          CROSS JOIN card_max
          WHERE inv.org_id = ${orgId}
            AND po.contract_id = ${row.c.contractId}
            AND inv.status IN ('received','approved','paid')
            AND inv.invoice_date >= NOW() - INTERVAL '365 days'
        `)
      : Promise.resolve({ rows: [{ spend: "0" }] }),
    // Per-invoice off-card listing (capped at 50, ordered by amount desc).
    row.c.contractId
      ? db.execute(sql`
          SELECT
            inv.id AS invoice_id,
            inv.invoice_number AS invoice_number,
            inv.supplier_id AS supplier_id,
            sup.name AS supplier_name,
            inv.po_id AS po_id,
            po.po_number AS po_number,
            inv.invoice_date AS invoice_date,
            inv.status AS status,
            inv.amount_usd::text AS amount_usd
          FROM invoices inv
          JOIN purchase_orders po ON po.id = inv.po_id
          LEFT JOIN suppliers sup ON sup.id = inv.supplier_id
          WHERE inv.org_id = ${orgId}
            AND po.contract_id = ${row.c.contractId}
            AND inv.status IN ('received','approved','paid')
            AND inv.invoice_date >= NOW() - INTERVAL '365 days'
          ORDER BY inv.amount_usd::numeric DESC NULLS LAST
          LIMIT 50
        `)
      : Promise.resolve({ rows: [] as unknown[] }),
  ]);
  const offCardSpendUsd = Number(
    (offCardRow.rows[0] as { spend: string } | undefined)?.spend ?? 0,
  );
  const offCardPoMismatchUsd = Number(
    (offCardPoRow.rows[0] as { spend: string } | undefined)?.spend ?? 0,
  );
  const offCardInvoiceUsd = Number(
    (offCardInvoiceRow.rows[0] as { spend: string } | undefined)?.spend ?? 0,
  );
  type OffCardInvoiceRaw = {
    invoice_id: string;
    invoice_number: string | null;
    supplier_id: string | null;
    supplier_name: string | null;
    po_id: string | null;
    po_number: string | null;
    invoice_date: Date | string | null;
    status: string | null;
    amount_usd: string | null;
  };
  const recentOffCardInvoices = (
    offCardInvoiceLinesRows.rows as OffCardInvoiceRaw[]
  ).map((i) => ({
    invoiceId: i.invoice_id,
    invoiceNumber: i.invoice_number,
    supplierId: i.supplier_id,
    supplierName: i.supplier_name,
    poId: i.po_id,
    poNumber: i.po_number,
    invoiceDate:
      i.invoice_date instanceof Date
        ? i.invoice_date.toISOString().slice(0, 10)
        : i.invoice_date
          ? String(i.invoice_date).slice(0, 10)
          : null,
    status: i.status,
    amountUsd: i.amount_usd === null ? 0 : Number(i.amount_usd),
  }));
  type OffCardPoLineRaw = {
    line_id: string;
    po_id: string;
    po_number: string | null;
    supplier_id: string | null;
    supplier_name: string | null;
    order_date: Date | string | null;
    description: string | null;
    category_id: string | null;
    category_name: string | null;
    unit_price_usd: string | null;
    extended_usd: string | null;
    card_max_hourly: string | null;
  };
  const recentOffCardPoLines = (
    offCardPoLinesRows.rows as OffCardPoLineRaw[]
  ).map((p) => ({
    poLineId: p.line_id,
    poId: p.po_id,
    poNumber: p.po_number,
    supplierId: p.supplier_id,
    supplierName: p.supplier_name,
    orderDate:
      p.order_date instanceof Date
        ? p.order_date.toISOString().slice(0, 10)
        : p.order_date
          ? String(p.order_date).slice(0, 10)
          : null,
    description: p.description,
    categoryId: p.category_id,
    categoryName: p.category_name,
    unitPriceUsd: p.unit_price_usd === null ? null : Number(p.unit_price_usd),
    extendedUsd: p.extended_usd === null ? 0 : Number(p.extended_usd),
    cardMaxHourlyUsd:
      p.card_max_hourly === null || Number(p.card_max_hourly) === 0
        ? null
        : Number(p.card_max_hourly),
  }));

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

  res.json({
    ...mapCardRow({
      c: row.c,
      supplierName: row.supplierName,
      lineCount: lines.length,
      offCardSpendUsd,
    }),
    offCardPoMismatchUsd,
    offCardInvoiceUsd,
    lines: mappedLines,
    linesByRole,
    recentOffCardPoLines,
    recentOffCardInvoices,
    recentOffCardEntries: recentOffCardEntries.map((r) => ({
      id: r.t.id,
      workDate: r.t.workDate,
      role: r.t.role ?? "—",
      seniority: r.t.seniority,
      hours: Number(r.t.hours),
      unitRateUsd: r.t.billRateUsd === null ? null : Number(r.t.billRateUsd),
      billedAmount: r.t.amountUsd === null ? null : Number(r.t.amountUsd),
      billedAmountUsd: r.t.amountUsd === null ? 0 : Number(r.t.amountUsd),
      currency: row.c.currency,
      sowId: r.t.sowId,
      sowNumber: r.sowNumber,
    })),
    linkedOpportunities,
  });
});

export default router;
