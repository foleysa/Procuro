import { Router, type IRouter } from "express";
import {
  db,
  suppliersTable,
  supplierAuditLogTable,
  contractsTable,
  categoriesTable,
  opportunitiesTable,
  marketSignalsTable,
  orgsTable,
  type MarketSignalRow,
  type SupplierRow,
} from "@workspace/db";
import { and, eq, ilike, gt, asc, desc, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { resolveEntity, type ResolvedEntity } from "@workspace/intelligence";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { newId } from "../lib/ids";
import { readRenewalAlertDays } from "../lib/contract-settings";
import {
  deriveContractStatus,
  daysToExpiry,
} from "./contracts";
import { getCollector } from "../lib/intelligence/runtime";
import { collectorContract } from "../lib/intelligence/collector";
import {
  SUPPLIER_INTELLIGENCE_SIGNAL_TYPES,
  renderSupplierIntelligenceHeadline,
  type SupplierIntelligenceSignalType,
} from "../lib/supplier-intelligence";
import { cpiScopeForCategoryCode } from "../lib/intelligence/cpi-mapping";

const router: IRouter = Router();

// ─── Supplier mapper ─────────────────────────────────────────────────────
//
// One row mapper shared by list + detail + patch responses so the wire
// shape stays in lockstep across endpoints. Drift here would silently
// break the codegen-derived `Supplier` type the FE binds against.

function mapSupplier(s: SupplierRow): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    countryCode: s.countryCode,
    billingCurrency: s.billingCurrency,
    // Surfaced on the supplier ingest review screen so the operator can
    // see how each row's billing currency was inferred (and how
    // confident the resolver was). The Supplier 360 detail page already
    // exposes the same two fields via `getSupplierIntelligence`; here
    // they're also returned at list-time so the review table can render
    // a confidence chip + low-confidence highlight without N+1 detail
    // fetches. Both are null when `billingCurrency` is null.
    billingCurrencySource: s.billingCurrencySource,
    billingCurrencyConfidence: s.billingCurrencyConfidence,
    paymentTermsDays: s.paymentTermsDays,
    isStrategic: s.isStrategic,
    isPreferred: s.isPreferred,
    tags: s.tags ?? [],
    internalNotes: s.internalNotes,
  };
}

/**
 * Whitelist of values accepted by the `?confidence=` query filter on the
 * suppliers list endpoint. Mirrors the `BillingCurrencyConfidence`
 * OpenAPI enum exactly. Validated as a set rather than a Zod schema so
 * unknown values are quietly ignored (consistent with the `?missing=`
 * filter), which keeps backwards-compatibility if the enum widens
 * before the FE catches up.
 */
const CONFIDENCE_FILTER_VALUES: ReadonlySet<string> = new Set([
  "high",
  "medium",
  "low",
]);

router.get("/suppliers", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const search = (req.query.search as string | undefined)?.trim();
  const missing = (req.query.missing as string | undefined)?.trim();
  const confidence = (req.query.confidence as string | undefined)?.trim();
  // `?strategic=` / `?preferred=` accept the string "true"/"false" so the
  // FE can persist the toggle state in the URL with no extra encoding.
  // Anything else (incl. omitted) leaves the flag untouched.
  const strategicParam = (req.query.strategic as string | undefined)?.trim();
  const preferredParam = (req.query.preferred as string | undefined)?.trim();
  const strategic =
    strategicParam === "true" ? true : strategicParam === "false" ? false : undefined;
  const preferred =
    preferredParam === "true" ? true : preferredParam === "false" ? false : undefined;
  // `?currency=` is a 3-letter ISO 4217 code; we uppercase for storage
  // parity. Invalid shapes are ignored to match the `?missing=` /
  // `?confidence=` quiet-ignore convention.
  const currencyRaw = (req.query.currency as string | undefined)?.trim().toUpperCase();
  const currency =
    currencyRaw && /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : undefined;
  // `?tag=` matches a single value against the jsonb `tags` array via
  // the `@>` containment operator. Empty values are ignored.
  const tag = (req.query.tag as string | undefined)?.trim();
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? "50", 10) || 50, 1),
    200,
  );
  const cursor = req.query.cursor as string | undefined;

  const where = [eq(suppliersTable.orgId, orgId)];
  if (search) where.push(ilike(suppliersTable.name, `%${search}%`));
  // `?missing=<field>` narrows to the rows the data-readiness card flagged
  // so the operator lands on the exact gap. Unknown values are silently
  // ignored so adding new readiness checks never 400s the existing list
  // page if the FE/BE roll out is staggered.
  if (missing === "billing_currency") {
    where.push(
      or(
        isNull(suppliersTable.billingCurrency),
        eq(suppliersTable.billingCurrency, ""),
      )!,
    );
  } else if (missing === "payment_terms_days") {
    where.push(isNull(suppliersTable.paymentTermsDays));
  }
  // `?confidence=<level>` narrows to suppliers whose detected billing
  // currency carries the named confidence rating, used by the supplier
  // ingest review screen to surface low-confidence guesses across all
  // pages (the per-page client-side sort would otherwise miss them).
  // Unknown values are silently ignored — same convention as `?missing=`.
  if (confidence && CONFIDENCE_FILTER_VALUES.has(confidence)) {
    where.push(eq(suppliersTable.billingCurrencyConfidence, confidence));
  }
  if (strategic !== undefined) {
    where.push(eq(suppliersTable.isStrategic, strategic));
  }
  if (preferred !== undefined) {
    where.push(eq(suppliersTable.isPreferred, preferred));
  }
  if (currency) {
    where.push(eq(suppliersTable.billingCurrency, currency));
  }
  if (tag) {
    // jsonb containment: row matches when its `tags` array contains the
    // requested value. Parameterised JSON literal keeps it injection-safe.
    where.push(sql`${suppliersTable.tags} @> ${JSON.stringify([tag])}::jsonb`);
  }
  if (cursor) where.push(gt(suppliersTable.id, cursor));

  const rows = await db
    .select()
    .from(suppliersTable)
    .where(and(...where))
    .orderBy(asc(suppliersTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    items: sliced.map(mapSupplier),
    nextCursor: hasMore ? sliced.at(-1)?.id ?? null : null,
  });
});

// ─── PATCH body schema ──────────────────────────────────────────────────
//
// Inline-edit shape for the Supplier 360 page. Mirrors the
// `patchContractBodySchema` semantics: every field optional, `null`
// clears nullable fields, omitted fields are left untouched, and
// empty/whitespace strings collapse to `null` on the nullable
// trimmed fields. Subsumes #53 (billing currency) and the supplier
// half of #60 (internal notes).

function nullableTrimmedString(maxLength: number) {
  return z
    .union([z.string().max(maxLength), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    });
}

export const patchSupplierBodySchema = z.object({
  billingCurrency: z
    .union([z.string().max(3), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const trimmed = v.trim().toUpperCase();
      if (trimmed.length === 0) return null;
      // Loose ISO-4217 shape check: 3 alpha chars. We don't pull in
      // the full currency table here; downstream FX lookup still
      // works on whatever code the operator types and quietly
      // surfaces an empty FX panel for unknown codes.
      if (!/^[A-Z]{3}$/.test(trimmed)) {
        throw new z.ZodError([
          {
            code: z.ZodIssueCode.custom,
            path: ["billingCurrency"],
            message: "Expected a 3-letter ISO 4217 currency code",
          },
        ]);
      }
      return trimmed;
    }),
  isStrategic: z.boolean().optional(),
  isPreferred: z.boolean().optional(),
  tags: z
    .array(z.string().max(64).transform((s) => s.trim()).pipe(z.string().min(1)))
    .max(50)
    .optional(),
  internalNotes: nullableTrimmedString(5000),
});

export type PatchSupplierBody = z.infer<typeof patchSupplierBodySchema>;

// ─── Detail loader (used by GET + PATCH) ─────────────────────────────────

async function loadSupplierDetail(
  orgId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ s: suppliersTable, orgSettings: orgsTable.settings })
    .from(suppliersTable)
    .innerJoin(orgsTable, eq(suppliersTable.orgId, orgsTable.id))
    .where(and(eq(suppliersTable.orgId, orgId), eq(suppliersTable.id, id)));
  if (!row) return null;

  const threshold = readRenewalAlertDays(row.orgSettings ?? null);
  const billingCurrency = row.s.billingCurrency;

  const [
    spendTotalRow,
    monthlyRows,
    topCategoryRows,
    contractRows,
    oppRows,
    fxSignals,
    auditRows,
    servicesEngagementRows,
  ] = await Promise.all([
    // Trailing-365d spend total + PO count from po_lines joined to
    // purchase_orders. We sum at the line level (extended_usd is the
    // canonical spend metric) and count distinct POs to give a quick
    // "how active is this supplier" signal in the Overview tab.
    db.execute(sql`
      SELECT
        COALESCE(SUM(pol.extended_usd::numeric), 0) AS total_usd,
        COUNT(DISTINCT po.id)::int AS po_count
      FROM po_lines pol
      JOIN purchase_orders po ON po.id = pol.po_id
      WHERE pol.org_id = ${orgId}
        AND po.supplier_id = ${id}
        AND pol.order_date >= NOW() - INTERVAL '365 days'
    `),
    // Monthly spend series for the 12-month sparkline. We bucket on
    // `date_trunc('month', order_date)` so the series stays stable
    // across DST/timezone shifts; the FE renders this oldest-first
    // (ASC) without re-sorting.
    db.execute(sql`
      SELECT
        date_trunc('month', pol.order_date) AS month,
        COALESCE(SUM(pol.extended_usd::numeric), 0) AS spend_usd
      FROM po_lines pol
      JOIN purchase_orders po ON po.id = pol.po_id
      WHERE pol.org_id = ${orgId}
        AND po.supplier_id = ${id}
        AND pol.order_date >= NOW() - INTERVAL '365 days'
      GROUP BY 1
      ORDER BY 1 ASC
    `),
    // Top-N category breakdown for the Spend tab. `cat.code` is
    // surfaced alongside the display name so the Command Center can
    // hang the CPI pushback trend chart (#68) off the matching
    // consumer-facing categories without an extra round-trip.
    db.execute(sql`
      SELECT
        cat.id AS category_id,
        cat.name AS category_name,
        cat.code AS category_code,
        COALESCE(SUM(pol.extended_usd::numeric), 0) AS spend_usd
      FROM po_lines pol
      JOIN purchase_orders po ON po.id = pol.po_id
      JOIN categories cat ON cat.id = pol.category_id
      WHERE pol.org_id = ${orgId}
        AND po.supplier_id = ${id}
        AND pol.order_date >= NOW() - INTERVAL '365 days'
      GROUP BY cat.id, cat.name, cat.code
      ORDER BY spend_usd DESC
      LIMIT 10
    `),
    db
      .select({
        c: contractsTable,
        categoryName: categoriesTable.name,
      })
      .from(contractsTable)
      .leftJoin(
        categoriesTable,
        eq(contractsTable.categoryId, categoriesTable.id),
      )
      .where(
        and(
          eq(contractsTable.orgId, orgId),
          eq(contractsTable.supplierId, id),
        ),
      )
      .orderBy(asc(contractsTable.endDate)),
    // Opportunities scoped to this supplier. Same OR predicate as
    // the list endpoint's `?supplierId=` filter so the cross-link
    // counts can never disagree. Narrowed projection because the
    // drizzle schema declares opportunity columns (signal_key,
    // mapped_via, snoozed_until, last_seen_at, source_tenant_category_string,
    // re_categorized_after_persistence) that have not yet been pushed
    // to this database. See follow-up #238 for the full schema-drift
    // backfill; until that lands a `select()` would 500.
    db
      .select({
        id: opportunitiesTable.id,
        leverId: opportunitiesTable.leverId,
        status: opportunitiesTable.status,
        title: opportunitiesTable.title,
        projectedSavingsUsd: opportunitiesTable.projectedSavingsUsd,
        createdAt: opportunitiesTable.createdAt,
      })
      .from(opportunitiesTable)
      .where(
        and(
          eq(opportunitiesTable.orgId, orgId),
          or(
            eq(opportunitiesTable.supplierId, id),
            sql`${opportunitiesTable.inputs}->>'supplierId' = ${id}`,
          )!,
        ),
      )
      .orderBy(desc(opportunitiesTable.createdAt))
      .limit(100),
    // FX rate observations for the supplier's billing currency. ECB
    // feed is platform-wide (org_id IS NULL) so we union with the
    // tenant's own org_id rows. 180-day window keeps the chart
    // bounded; the FxTrendChart component handles its own thinning.
    billingCurrency
      ? db
          .select()
          .from(marketSignalsTable)
          .where(
            and(
              or(
                eq(marketSignalsTable.orgId, orgId),
                isNull(marketSignalsTable.orgId),
              )!,
              eq(marketSignalsTable.signalType, "fx_rate"),
              or(
                eq(
                  marketSignalsTable.scopeMaterialCode,
                  `EUR/${billingCurrency}`,
                ),
                eq(
                  marketSignalsTable.scopeMaterialCode,
                  `USD/${billingCurrency}`,
                ),
              )!,
              sql`${marketSignalsTable.observedAt} >= NOW() - INTERVAL '180 days'`,
            ),
          )
          .orderBy(sql`${marketSignalsTable.observedAt} DESC`)
          .limit(180)
      : Promise.resolve([] as Array<typeof marketSignalsTable.$inferSelect>),
    db
      .select()
      .from(supplierAuditLogTable)
      .where(
        and(
          eq(supplierAuditLogTable.orgId, orgId),
          eq(supplierAuditLogTable.supplierId, id),
        ),
      )
      .orderBy(desc(supplierAuditLogTable.createdAt))
      .limit(200),
    // Services-engagement KPIs: drives the "Services engagement"
    // card on Supplier 360. Combines the operational counters
    // (active SOWs / open milestones / active rate cards) with the
    // four operator-grade headline metrics — average blended bill
    // rate, off-card spend share, change-order ratio, and the count
    // of active services-utilization opportunities — in a single
    // round-trip so the overview tab doesn't N+1. All time-windowed
    // values are trailing-365d.
    db.execute(sql`
      WITH sow_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::int AS active,
          COALESCE(SUM(total_value_usd::numeric) FILTER (
            WHERE created_at >= NOW() - INTERVAL '365 days'
              OR (start_date IS NOT NULL AND start_date >= NOW() - INTERVAL '365 days')
          ), 0) AS recent_committed
        FROM statements_of_work
        WHERE org_id = ${orgId} AND supplier_id = ${id}
      ),
      rate_cards_count AS (
        SELECT COUNT(*)::int AS active
        FROM rate_cards
        WHERE org_id = ${orgId}
          AND supplier_id = ${id}
          AND effective_date <= NOW()
          AND (expiry_date IS NULL OR expiry_date >= NOW())
      ),
      milestones AS (
        SELECT
          COUNT(*) FILTER (
            WHERE m.status NOT IN ('accepted','invoiced','paid','cancelled')
          )::int AS open_count,
          MIN(m.due_date) FILTER (
            WHERE m.status NOT IN ('accepted','invoiced','paid','cancelled')
              AND m.due_date IS NOT NULL
          ) AS upcoming_due
        FROM sow_milestones m
        JOIN statements_of_work s ON s.id = m.sow_id
        WHERE m.org_id = ${orgId} AND s.supplier_id = ${id}
      ),
      services_spend AS (
        SELECT
          COALESCE(SUM(pol.extended_usd::numeric), 0) AS total_spend,
          COALESCE(SUM(pol.extended_usd::numeric) FILTER (
            WHERE c.contract_type = 't_and_m'
          ), 0) AS tm_spend,
          COALESCE(SUM(pol.extended_usd::numeric) FILTER (
            WHERE c.contract_type = 'fixed_price'
          ), 0) AS fp_spend
        FROM po_lines pol
        JOIN purchase_orders po ON po.id = pol.po_id
        LEFT JOIN contracts c ON c.id = po.contract_id
        WHERE pol.org_id = ${orgId}
          AND po.supplier_id = ${id}
          AND pol.order_date >= NOW() - INTERVAL '365 days'
          AND c.contract_type IS NOT NULL
          AND c.contract_type <> 'goods'
      ),
      time_rollup AS (
        -- Trailing-90d: avg blended bill rate ($ ÷ hours) and
        -- off-card share (portion of spend with rate_card_line_id NULL).
        SELECT
          COALESCE(SUM(t.amount_usd::numeric), 0) AS total_amount,
          COALESCE(SUM(t.hours::numeric), 0) AS total_hours,
          COALESCE(SUM(t.amount_usd::numeric) FILTER (
            WHERE t.rate_card_line_id IS NULL
          ), 0) AS off_card_amount
        FROM time_entries t
        WHERE t.org_id = ${orgId}
          AND t.supplier_id = ${id}
          AND t.work_date >= NOW() - INTERVAL '90 days'
      ),
      active_sow_totals AS (
        -- NTE roll-up across the supplier's currently active SOWs.
        -- Denominator for the change-order ratio.
        SELECT
          COALESCE(SUM(total_value_usd::numeric), 0) AS active_nte
        FROM statements_of_work
        WHERE org_id = ${orgId}
          AND supplier_id = ${id}
          AND status = 'active'
      ),
      change_order_rollup AS (
        -- Sum of committed (approved/executed) change-order value
        -- across the supplier's active SOWs. Numerator for the ratio.
        SELECT
          COALESCE(SUM(co.value_delta_usd::numeric), 0) AS committed_total
        FROM sow_change_orders co
        JOIN statements_of_work s ON s.id = co.sow_id
        WHERE co.org_id = ${orgId}
          AND s.supplier_id = ${id}
          AND s.status = 'active'
          AND co.status IN ('approved','executed')
      ),
      services_presence AS (
        -- Has any services activity: any services contract, any SOW
        -- (any status), or any time entry. Drives the FE card-visibility
        -- guard so suppliers with services engagement but no recent
        -- numeric spend still show the card.
        SELECT (
          EXISTS (
            SELECT 1 FROM contracts
            WHERE org_id = ${orgId}
              AND supplier_id = ${id}
              AND contract_type IN ('t_and_m','fixed_price')
          )
          OR EXISTS (
            SELECT 1 FROM statements_of_work
            WHERE org_id = ${orgId} AND supplier_id = ${id}
          )
          OR EXISTS (
            SELECT 1 FROM time_entries
            WHERE org_id = ${orgId} AND supplier_id = ${id}
          )
        )::boolean AS has_activity
      ),
      utilization_signals AS (
        -- Person-level hours-audit signals over the last 90 days,
        -- bucketed to ISO week. A "signal" is a (resource, week)
        -- pair where weekly hours either exceed an overload
        -- threshold (>50 hrs ~ sustained overtime) OR fall below
        -- an under-utilization threshold (<10 hrs while the
        -- resource is otherwise active that quarter — proxy for
        -- bench time burning rate). The sustained-active check
        -- avoids flagging brand-new or rolled-off resources.
        WITH person_weeks AS (
          SELECT
            t.resource,
            DATE_TRUNC('week', t.work_date) AS wk,
            SUM(t.hours::numeric) AS weekly_hours
          FROM time_entries t
          WHERE t.org_id = ${orgId}
            AND t.supplier_id = ${id}
            AND t.work_date >= NOW() - INTERVAL '90 days'
          GROUP BY t.resource, DATE_TRUNC('week', t.work_date)
        ),
        active_resources AS (
          SELECT resource
          FROM person_weeks
          GROUP BY resource
          HAVING COUNT(*) >= 4
        )
        SELECT
          COUNT(*) FILTER (WHERE pw.weekly_hours > 50)::int AS overload,
          COUNT(*) FILTER (
            WHERE pw.weekly_hours < 10
              AND pw.resource IN (SELECT resource FROM active_resources)
          )::int AS underutil,
          (
            COUNT(*) FILTER (WHERE pw.weekly_hours > 50)
            + COUNT(*) FILTER (
                WHERE pw.weekly_hours < 10
                  AND pw.resource IN (SELECT resource FROM active_resources)
              )
          )::int AS active
        FROM person_weeks pw
      )
      SELECT
        sow_counts.active AS sow_active,
        sow_counts.recent_committed AS sow_recent_committed,
        rate_cards_count.active AS rate_cards_active,
        milestones.open_count AS milestones_open,
        milestones.upcoming_due AS milestones_upcoming_due,
        services_spend.total_spend::numeric AS total_services_spend,
        services_spend.tm_spend::numeric AS tm_spend,
        services_spend.fp_spend::numeric AS fp_spend,
        time_rollup.total_amount::numeric AS time_total_amount,
        time_rollup.total_hours::numeric AS time_total_hours,
        time_rollup.off_card_amount::numeric AS time_off_card_amount,
        change_order_rollup.committed_total::numeric AS co_committed_total,
        active_sow_totals.active_nte::numeric AS active_sow_nte,
        services_presence.has_activity AS has_services_activity,
        utilization_signals.active AS utilization_active,
        utilization_signals.overload AS utilization_overload,
        utilization_signals.underutil AS utilization_underutil
      FROM sow_counts, rate_cards_count, milestones, services_spend,
           time_rollup, change_order_rollup, active_sow_totals,
           services_presence, utilization_signals
    `),
  ]);

  const totalRow = spendTotalRow.rows[0] as
    | { total_usd: string; po_count: number }
    | undefined;
  const totalSpendUsd = Number(totalRow?.total_usd ?? 0);
  const poCount = Number(totalRow?.po_count ?? 0);
  const monthly = (
    monthlyRows.rows as Array<{ month: Date | string; spend_usd: string }>
  ).map((r) => ({
    month:
      r.month instanceof Date
        ? r.month.toISOString().slice(0, 10)
        : String(r.month).slice(0, 10),
    spendUsd: Number(r.spend_usd),
  }));
  const topCategories = (
    topCategoryRows.rows as Array<{
      category_id: string;
      category_name: string;
      category_code: string | null;
      spend_usd: string;
    }>
  ).map((r) => ({
    categoryId: r.category_id,
    categoryName: r.category_name,
    categoryCode: r.category_code,
    cpiScopeCode: cpiScopeForCategoryCode(r.category_code),
    spendUsd: Number(r.spend_usd),
  }));

  return {
    ...mapSupplier(row.s),
    spend: {
      totalSpendUsd,
      poCount,
      monthly,
      topCategories,
    },
    contracts: contractRows.map((r) => ({
      id: r.c.id,
      contractNumber: r.c.contractNumber,
      title: r.c.title,
      status: r.c.status,
      derivedStatus: deriveContractStatus(
        r.c.status,
        r.c.endDate,
        threshold,
      ),
      endDate: r.c.endDate,
      daysToExpiry: daysToExpiry(r.c.endDate),
      billingCurrency: r.c.billingCurrency,
      annualBaselineUsd:
        r.c.annualBaselineUsd === null
          ? null
          : Number(r.c.annualBaselineUsd),
    })),
    opportunities: oppRows.map((o) => ({
      id: o.id,
      leverId: o.leverId,
      status: o.status,
      title: o.title,
      projectedSavingsUsd: Number(o.projectedSavingsUsd),
      createdAt: o.createdAt,
    })),
    fxSignals: fxSignals.map((s) => ({
      id: s.id,
      collectorId: s.collectorId,
      signalType: s.signalType,
      scopeMaterialCode: s.scopeMaterialCode,
      scopeCategoryId: null,
      scopeSupplierId: null,
      value: Number(s.value),
      unit: s.unit,
      currency: s.currency,
      confidence: s.confidence !== null ? Number(s.confidence) : null,
      observedAt: s.observedAt,
      sourceUrl: s.sourceUrl,
      createdAt: s.fetchedAt,
    })),
    auditLog: auditRows.map((a) => ({
      id: a.id,
      field: a.field,
      actorEmail: a.actorEmail,
      oldValue: a.oldValue,
      newValue: a.newValue,
      createdAt: a.createdAt,
    })),
    services: (() => {
      const r = servicesEngagementRows.rows[0] as
        | {
            sow_active: string | number | null;
            sow_recent_committed: string | null;
            rate_cards_active: string | number | null;
            milestones_open: string | number | null;
            milestones_upcoming_due: Date | string | null;
            total_services_spend: string | null;
            tm_spend: string | null;
            fp_spend: string | null;
            time_total_amount: string | null;
            time_total_hours: string | null;
            time_off_card_amount: string | null;
            co_committed_total: string | null;
            active_sow_nte: string | null;
            has_services_activity: boolean | null;
            utilization_active: string | number | null;
            utilization_overload: string | number | null;
            utilization_underutil: string | number | null;
          }
        | undefined;
      const upcoming = r?.milestones_upcoming_due ?? null;
      const totalAmount = Number(r?.time_total_amount ?? 0);
      const totalHours = Number(r?.time_total_hours ?? 0);
      const offCardAmount = Number(r?.time_off_card_amount ?? 0);
      const activeNte = Number(r?.active_sow_nte ?? 0);
      const coCommitted = Number(r?.co_committed_total ?? 0);
      const avgBlendedRateUsd =
        totalHours > 0 ? totalAmount / totalHours : null;
      const offCardSpendShare =
        totalAmount > 0 ? offCardAmount / totalAmount : 0;
      const changeOrderRatio =
        activeNte > 0 ? coCommitted / activeNte : 0;
      return {
        activeSowCount: Number(r?.sow_active ?? 0),
        openMilestoneCount: Number(r?.milestones_open ?? 0),
        rateCardCount: Number(r?.rate_cards_active ?? 0),
        totalServicesSpendUsd: Number(r?.total_services_spend ?? 0),
        timeAndMaterialsSpendUsd: Number(r?.tm_spend ?? 0),
        fixedPriceSpendUsd: Number(r?.fp_spend ?? 0),
        upcomingMilestoneDueDate:
          upcoming === null
            ? null
            : upcoming instanceof Date
              ? upcoming.toISOString()
              : String(upcoming),
        avgBlendedRateUsd,
        offCardSpendShare,
        changeOrderRatio,
        hasServicesActivity: Boolean(r?.has_services_activity ?? false),
        utilizationSignalCount: Number(r?.utilization_active ?? 0),
        utilizationOverloadCount: Number(r?.utilization_overload ?? 0),
        utilizationUnderutilCount: Number(r?.utilization_underutil ?? 0),
      };
    })(),
  };
}

// ─── GET /suppliers/:id ──────────────────────────────────────────────────

router.get("/suppliers/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const detail = await loadSupplierDetail(orgId, id);
  if (!detail) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }
  res.json(detail);
});

// ─── PATCH /suppliers/:id ────────────────────────────────────────────────
//
// Inline-edit billing currency / strategic / preferred / tags /
// internal notes. Each changed field becomes one row in the supplier
// audit log so the Activity tab can answer "who flipped this and
// when?". Subsumes #53 and the supplier half of #60.

router.patch("/suppliers/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const body = patchSupplierBodySchema.parse(req.body);

  const [current] = await db
    .select()
    .from(suppliersTable)
    .where(and(eq(suppliersTable.orgId, orgId), eq(suppliersTable.id, id)));
  if (!current) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const updates: Partial<typeof suppliersTable.$inferInsert> = {};
  const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> =
    [];

  if (
    body.billingCurrency !== undefined &&
    body.billingCurrency !== current.billingCurrency
  ) {
    updates.billingCurrency = body.billingCurrency;
    changes.push({
      field: "billingCurrency",
      oldValue: current.billingCurrency,
      newValue: body.billingCurrency,
    });
  }
  if (
    body.isStrategic !== undefined &&
    body.isStrategic !== current.isStrategic
  ) {
    updates.isStrategic = body.isStrategic;
    changes.push({
      field: "isStrategic",
      oldValue: current.isStrategic,
      newValue: body.isStrategic,
    });
  }
  if (
    body.isPreferred !== undefined &&
    body.isPreferred !== current.isPreferred
  ) {
    updates.isPreferred = body.isPreferred;
    changes.push({
      field: "isPreferred",
      oldValue: current.isPreferred,
      newValue: body.isPreferred,
    });
  }
  if (body.tags !== undefined) {
    // Tag arrays are equal when their sorted-deduped contents match —
    // a re-order or duplicate insert is not an audit-worthy change.
    const norm = (xs: string[]) =>
      Array.from(new Set(xs.map((x) => x.trim()).filter(Boolean))).sort();
    const incoming = norm(body.tags);
    const existing = norm(current.tags ?? []);
    const same =
      incoming.length === existing.length &&
      incoming.every((v, i) => v === existing[i]);
    if (!same) {
      updates.tags = incoming;
      changes.push({
        field: "tags",
        oldValue: existing,
        newValue: incoming,
      });
    }
  }
  if (
    body.internalNotes !== undefined &&
    body.internalNotes !== current.internalNotes
  ) {
    updates.internalNotes = body.internalNotes;
    changes.push({
      field: "internalNotes",
      oldValue: current.internalNotes,
      newValue: body.internalNotes,
    });
  }

  if (changes.length > 0) {
    // Audit actor is whatever `tenantMiddleware` resolved from the
    // request — Clerk session email (preferred), Clerk user id when the
    // session token doesn't carry an email claim, or the API-key /
    // legacy-token identity for system-to-system callers. We don't fall
    // back to a static "system@procuro.ai" here: the middleware
    // guarantees `req.actorEmail` is set on every authenticated path,
    // and a missing value means the route was reached without auth
    // (which should be impossible) — surface that as a 401 rather than
    // silently mis-attributing the change to "system" in the Activity
    // tab. Keeps audit integrity regardless of how the FE sends the
    // request (cookie-based Clerk session, bearer api-key, etc.).
    const actor = req.actorEmail ?? req.clerkUserId;
    if (!actor) {
      res.status(401).json({ error: "Authenticated actor required" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(suppliersTable)
        .set(updates)
        .where(eq(suppliersTable.id, id));
      for (const change of changes) {
        await tx.insert(supplierAuditLogTable).values({
          id: newId("sup_aud"),
          orgId,
          supplierId: id,
          actorEmail: actor,
          field: change.field,
          oldValue: change.oldValue as never,
          newValue: change.newValue as never,
        });
      }
    });
    req.log.info(
      { supplierId: id, fields: changes.map((c) => c.field), actor },
      "supplier.patch",
    );
  }

  const detail = await loadSupplierDetail(orgId, id);
  if (!detail) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }
  res.json(detail);
});

/**
 * Hard cap on the number of timeline rows we return per request. Risk
 * & Filings is meant to surface the most recent signals — beyond ~100
 * rows the UI gets overwhelming and the BQ-side queries should drive
 * deeper analysis. We keep this server-side rather than as a query
 * param so the route stays simple and the OpenAPI schema doesn't
 * generate a path/query name collision in the codegen.
 */
const SUPPLIER_INTELLIGENCE_ROW_CAP = 100;

router.get(
  "/suppliers/:id/intelligence",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const supplierId = String(req.params.id);

    const [supplier] = await db
      .select({
        id: suppliersTable.id,
        name: suppliersTable.name,
        countryCode: suppliersTable.countryCode,
        billingCurrency: suppliersTable.billingCurrency,
        billingCurrencySource: suppliersTable.billingCurrencySource,
        billingCurrencyConfidence: suppliersTable.billingCurrencyConfidence,
      })
      .from(suppliersTable)
      .where(
        and(eq(suppliersTable.orgId, orgId), eq(suppliersTable.id, supplierId)),
      )
      .limit(1);
    if (!supplier) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    // Best-effort entity resolution. Without identifiers on the
    // supplier row (no LEI/CIK columns yet), this falls back to BQ
    // deterministic-name matching when BQ is configured, otherwise
    // returns `{ entity_uid: null, match_type: "unresolved" }`. We
    // still always run the name-based fallback below so a supplier
    // with no resolved uid still surfaces matching `scope_supplier_name`
    // signals.
    let resolved: ResolvedEntity | null = null;
    try {
      resolved = await resolveEntity({
        name: supplier.name,
        ...(supplier.countryCode ? { country: supplier.countryCode } : {}),
      });
    } catch {
      // resolveEntity already swallows BQ errors and returns
      // `unresolved` for the deterministic-name path; this catch is
      // belt-and-braces for the rare cache-write failure that does
      // bubble out, so a transient DB hiccup never 500s the route.
      resolved = null;
    }

    const resolvedEntityUid =
      resolved && resolved.entity_uid ? resolved.entity_uid : null;
    const resolvedMatchType = resolved ? resolved.match_type : null;

    // Build a single SQL pass that:
    //   - scopes by org (this org OR platform-wide null-org rows),
    //   - filters to the Phase-2 supplier-intelligence signal types,
    //   - matches on `metadata->>'entityUid' = <uid>` when we have one,
    //     OR on case-insensitive `scopeSupplierName = supplier.name`,
    //   - orders newest-first and caps the row count.
    const orgScope = or(
      eq(marketSignalsTable.orgId, orgId),
      isNull(marketSignalsTable.orgId),
    )!;

    const typeFilter = sql`${marketSignalsTable.signalType} = ANY(${sql.raw(
      `ARRAY[${SUPPLIER_INTELLIGENCE_SIGNAL_TYPES.map(
        (t) => `'${t}'`,
      ).join(",")}]::text[]`,
    )})`;

    // The match predicate — at least one of the two strategies must
    // hold. We always include the name-based predicate (a no-cost
    // ilike on the indexed-by-collector table is cheap at the row
    // counts we expect) so a supplier with a resolved uid still picks
    // up legacy rows that didn't carry an `entityUid`.
    const nameMatch = ilike(
      marketSignalsTable.scopeSupplierName,
      supplier.name,
    );
    const matchPredicate = resolvedEntityUid
      ? or(
          sql`${marketSignalsTable.metadata}->>'entityUid' = ${resolvedEntityUid}`,
          nameMatch,
        )!
      : nameMatch;

    // Federal-spend roll-up (trailing 12 months). Computed against the
    // same org/name/uid match predicate as the timeline so the totals
    // can never disagree with the rows the operator sees, but scoped to
    // the USAspending collector's `public_bid_award` rows only and run
    // as an aggregate so it's not bounded by the 100-row timeline cap.
    // We surface the obligation total, the count of awards in the
    // window, and the agency that received the largest share so the
    // header can render "$X to <agency> across N awards" at a glance.
    const federalMatchPredicate = resolvedEntityUid
      ? or(
          sql`${marketSignalsTable.metadata}->>'entityUid' = ${resolvedEntityUid}`,
          nameMatch,
        )!
      : nameMatch;

    const [rows, federalRollupRes] = await Promise.all([
      db
        .select()
        .from(marketSignalsTable)
        .where(and(orgScope, typeFilter, matchPredicate))
        .orderBy(desc(marketSignalsTable.observedAt))
        .limit(SUPPLIER_INTELLIGENCE_ROW_CAP),
      db.execute(sql`
        WITH matched AS (
          SELECT
            ${marketSignalsTable.value}::numeric AS amount,
            ${marketSignalsTable.metadata}->>'awardingAgency' AS awarding_agency
          FROM ${marketSignalsTable}
          WHERE (${marketSignalsTable.orgId} = ${orgId}
                 OR ${marketSignalsTable.orgId} IS NULL)
            AND ${marketSignalsTable.collectorId} = 'usaspending'
            AND ${marketSignalsTable.signalType} = 'public_bid_award'
            AND ${marketSignalsTable.observedAt} >= NOW() - INTERVAL '365 days'
            AND ${federalMatchPredicate}
        ),
        totals AS (
          SELECT
            COALESCE(SUM(amount), 0)::numeric AS total_obligated,
            COUNT(*)::int AS award_count
          FROM matched
        ),
        top_agency AS (
          SELECT awarding_agency, COALESCE(SUM(amount), 0)::numeric AS agency_total
          FROM matched
          WHERE awarding_agency IS NOT NULL
          GROUP BY awarding_agency
          ORDER BY agency_total DESC
          LIMIT 1
        )
        SELECT
          totals.total_obligated,
          totals.award_count,
          top_agency.awarding_agency AS top_awarding_agency,
          top_agency.agency_total AS top_awarding_agency_obligated
        FROM totals
        LEFT JOIN top_agency ON true
      `),
    ]);

    const federalRow = federalRollupRes.rows[0] as
      | {
          total_obligated: string | number | null;
          award_count: number | string | null;
          top_awarding_agency: string | null;
          top_awarding_agency_obligated: string | number | null;
        }
      | undefined;
    const federalAwardCount = Number(federalRow?.award_count ?? 0);
    const federalSpend = {
      windowDays: 365,
      totalObligatedUsd: Number(federalRow?.total_obligated ?? 0),
      awardCount: federalAwardCount,
      topAwardingAgency:
        federalAwardCount > 0 ? federalRow?.top_awarding_agency ?? null : null,
      topAwardingAgencyObligatedUsd:
        federalAwardCount > 0 && federalRow?.top_awarding_agency
          ? Number(federalRow.top_awarding_agency_obligated ?? 0)
          : null,
    };

    const items = rows
      .map((r) => buildSupplierIntelligenceItem(r, resolvedEntityUid))
      // A row may be skipped when its collector isn't registered
      // in-process — this only happens for rows authored by a
      // collector that's been removed since the row was persisted.
      // We drop rather than 500 so the timeline still renders.
      .filter((x): x is SupplierIntelligenceItem => x !== null);

    const countsByType: Partial<Record<SupplierIntelligenceSignalType, number>> = {};
    for (const it of items) {
      countsByType[it.signalType] = (countsByType[it.signalType] ?? 0) + 1;
    }

    res.json({
      supplierId: supplier.id,
      supplierName: supplier.name,
      countryCode: supplier.countryCode,
      // Billing-currency surface for the Supplier 360 header card.
      // `source` is one of `provided | country | invoice_iso |
      // invoice_symbol | backfill_invoice | manual_override` (see
      // `lib/db/src/schema/suppliers.ts`); `confidence` is `high |
      // medium | low`. Both are null when `billingCurrency` itself
      // is null.
      billingCurrency: supplier.billingCurrency,
      billingCurrencySource: supplier.billingCurrencySource,
      billingCurrencyConfidence: supplier.billingCurrencyConfidence,
      resolvedEntityUid,
      resolvedMatchType,
      countsByType,
      federalSpend,
      totalCount: items.length,
      items,
    });
  },
);

/**
 * Manual override for `suppliers.billing_currency`. Operators hit this
 * from the Supplier 360 page when the auto-detected value is wrong (or
 * when a low/medium confidence row needs human confirmation).
 *
 * The override is persisted with `source = 'manual_override'` and
 * `confidence = 'high'`. The ingest re-upsert logic uses `coalesce` on
 * the inbound `excluded.billing_currency` so a subsequent CSV upload
 * that omits the column will NOT clobber the override.
 *
 * Body:
 *   { billingCurrency: string }   // ISO 4217, 3 letters, will be uppercased
 */
router.post(
  "/suppliers/:id/billing-currency",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const supplierId = String(req.params.id);
    const raw = (req.body as { billingCurrency?: unknown } | null | undefined)
      ?.billingCurrency;
    if (typeof raw !== "string" || !/^[A-Za-z]{3}$/.test(raw.trim())) {
      res.status(400).json({
        error:
          "billingCurrency must be a 3-letter ISO 4217 code (e.g. 'EUR')",
      });
      return;
    }
    const currency = raw.trim().toUpperCase();
    const [updated] = await db
      .update(suppliersTable)
      .set({
        billingCurrency: currency,
        billingCurrencySource: "manual_override",
        billingCurrencyConfidence: "high",
      })
      .where(
        and(eq(suppliersTable.orgId, orgId), eq(suppliersTable.id, supplierId)),
      )
      .returning({
        id: suppliersTable.id,
        billingCurrency: suppliersTable.billingCurrency,
        billingCurrencySource: suppliersTable.billingCurrencySource,
        billingCurrencyConfidence: suppliersTable.billingCurrencyConfidence,
      });
    if (!updated) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }
    res.json(updated);
  },
);

interface SupplierIntelligenceItem {
  id: string;
  signalType: SupplierIntelligenceSignalType;
  observedAt: Date;
  matchKind: "entity_uid" | "supplier_name";
  collectorId: string;
  collectorName: string;
  sourceUrl: string;
  contract: ReturnType<typeof collectorContract>;
  scopeSupplierName: string | null;
  scopeCategoryCode: string | null;
  scopeSku: string | null;
  scopeLaneKey: string | null;
  value: number;
  unit: string;
  currency: string;
  confidence: number;
  entityUid: string | null;
  headline: string;
  detail: string | null;
}

function buildSupplierIntelligenceItem(
  row: MarketSignalRow,
  resolvedEntityUid: string | null,
): SupplierIntelligenceItem | null {
  const collector = getCollector(row.collectorId);
  if (!collector) return null;
  if (
    !(SUPPLIER_INTELLIGENCE_SIGNAL_TYPES as readonly string[]).includes(
      row.signalType,
    )
  ) {
    // Defensive: `signalType` enum is enforced at write time, but a
    // future enum widening shouldn't smuggle non-supplier signals
    // into this response. The `as` below is then narrowed safely.
    return null;
  }
  const signalType = row.signalType as SupplierIntelligenceSignalType;

  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const entityUidFromRow =
    typeof meta["entityUid"] === "string" && meta["entityUid"].length > 0
      ? (meta["entityUid"] as string)
      : null;

  const matchKind: SupplierIntelligenceItem["matchKind"] =
    resolvedEntityUid !== null && entityUidFromRow === resolvedEntityUid
      ? "entity_uid"
      : "supplier_name";

  const value = Number(row.value);
  const { headline, detail } = renderSupplierIntelligenceHeadline({
    signalType,
    collectorId: collector.id,
    collectorName: collector.name,
    value,
    unit: row.unit,
    scopeSupplierName: row.scopeSupplierName,
    scopeCategoryCode: row.scopeCategoryCode,
    scopeSku: row.scopeSku,
    scopeLaneKey: row.scopeLaneKey,
    metadata: meta,
  });

  return {
    id: row.id,
    signalType,
    observedAt: row.observedAt,
    matchKind,
    collectorId: collector.id,
    collectorName: collector.name,
    sourceUrl: row.sourceUrl,
    contract: collectorContract(collector),
    scopeSupplierName: row.scopeSupplierName,
    scopeCategoryCode: row.scopeCategoryCode,
    scopeSku: row.scopeSku,
    scopeLaneKey: row.scopeLaneKey,
    value,
    unit: row.unit,
    currency: row.currency,
    confidence: Number(row.confidence),
    entityUid: entityUidFromRow,
    headline,
    detail,
  };
}

export default router;
