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
    paymentTermsDays: s.paymentTermsDays,
    isStrategic: s.isStrategic,
    isPreferred: s.isPreferred,
    tags: s.tags ?? [],
    internalNotes: s.internalNotes,
  };
}

router.get("/suppliers", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const search = (req.query.search as string | undefined)?.trim();
  const missing = (req.query.missing as string | undefined)?.trim();
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
    // Top-N category breakdown for the Spend tab.
    db.execute(sql`
      SELECT
        cat.id AS category_id,
        cat.name AS category_name,
        COALESCE(SUM(pol.extended_usd::numeric), 0) AS spend_usd
      FROM po_lines pol
      JOIN purchase_orders po ON po.id = pol.po_id
      JOIN categories cat ON cat.id = pol.category_id
      WHERE pol.org_id = ${orgId}
        AND po.supplier_id = ${id}
        AND pol.order_date >= NOW() - INTERVAL '365 days'
      GROUP BY cat.id, cat.name
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
    // counts can never disagree.
    db
      .select()
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
      spend_usd: string;
    }>
  ).map((r) => ({
    categoryId: r.category_id,
    categoryName: r.category_name,
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
    const actor = req.actorEmail ?? "system@procuro.ai";
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

    const rows = await db
      .select()
      .from(marketSignalsTable)
      .where(and(orgScope, typeFilter, matchPredicate))
      .orderBy(desc(marketSignalsTable.observedAt))
      .limit(SUPPLIER_INTELLIGENCE_ROW_CAP);

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
