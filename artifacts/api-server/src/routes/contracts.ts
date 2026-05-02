import { Router, type IRouter } from "express";
import {
  db,
  contractsTable,
  contractItemsTable,
  contractAuditLogTable,
  suppliersTable,
  categoriesTable,
  orgsTable,
  opportunitiesTable,
  marketSignalsTable,
  statementsOfWorkTable,
  sowMilestonesTable,
  type ContractRow,
} from "@workspace/db";
import { and, asc, count, desc, eq, ilike, or, sql, isNull } from "drizzle-orm";
import { z } from "zod";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { newId } from "../lib/ids";
import {
  extractSourcesFromInputs,
  dedupeSources,
  type InsightSource,
} from "../lib/insight-sources";
import { readRenewalAlertDays } from "../lib/contract-settings";
import { cpiScopeForCategoryCode } from "../lib/intelligence/cpi-mapping";

const router: IRouter = Router();

// ─── Derived status / days-to-expiry ─────────────────────────────────────
//
// Computed server-side so the contract list, the renewal calendar, and
// the colour-coded badges on supplier/opportunity cross-links can never
// disagree on whether a contract is "expiring soon".

export type ContractDerivedStatus =
  | "active"
  | "expiring"
  | "expired"
  | "pending"
  | "cancelled";

export function daysToExpiry(end: Date, now: Date = new Date()): number {
  const ms = end.getTime() - now.getTime();
  // Round to whole days, with negative numbers for already-expired
  // contracts so the UI can show "-12 days" without a special branch.
  return Math.ceil(ms / (24 * 3600 * 1000));
}

export function deriveContractStatus(
  status: ContractRow["status"],
  end: Date,
  thresholdDays: number,
  now: Date = new Date(),
): ContractDerivedStatus {
  // Stored statuses other than `active` win: a manually-cancelled
  // contract is "cancelled" even if its end_date is in the future,
  // and a `pending` contract awaiting countersignature is not
  // "expiring" no matter where end_date lands.
  if (status === "cancelled") return "cancelled";
  if (status === "pending") return "pending";
  if (status === "expired") return "expired";
  const days = daysToExpiry(end, now);
  if (days <= 0) return "expired";
  if (days <= thresholdDays) return "expiring";
  return "active";
}

// ─── PATCH body schema ──────────────────────────────────────────────────
//
// Exported so the body-validation tests can import the exact shape the
// production route ships with. Every field is optional; explicit
// `null` clears a nullable field, omitted fields are left untouched.

function nullableTrimmedString(maxLength: number) {
  // Mirror the existing PATCH semantics: empty string collapses to
  // null so the DB column stores a single canonical "no value" form.
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

export const patchContractBodySchema = z.object({
  owner: nullableTrimmedString(200),
  internalNotes: nullableTrimmedString(5000),
  renewalTargetAction: nullableTrimmedString(1000),
  renewalTargetDate: z
    .union([z.string().datetime({ offset: true }), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      return new Date(v);
    }),
  // Mirrors the supplier PATCH semantics: a 3-letter ISO 4217 code,
  // uppercased, or `null` to clear (which means "fall back to the
  // supplier's billing currency / org base"). Loose shape check —
  // we don't validate against the full ISO list so the operator
  // isn't blocked on rare/legacy codes the FX-exposure analyzer
  // simply won't find a rate for.
  billingCurrency: z
    .union([z.string().max(3), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const trimmed = v.trim().toUpperCase();
      if (trimmed.length === 0) return null;
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
});

export type PatchContractBody = z.infer<typeof patchContractBodySchema>;

// ─── Mappers ─────────────────────────────────────────────────────────────

function mapContractRow(args: {
  c: ContractRow;
  supplierName: string | null;
  categoryName: string | null;
  threshold: number;
}): Record<string, unknown> {
  const { c, supplierName, categoryName, threshold } = args;
  return {
    id: c.id,
    orgId: c.orgId,
    supplierId: c.supplierId,
    supplierName,
    categoryId: c.categoryId,
    categoryName,
    contractNumber: c.contractNumber,
    title: c.title,
    status: c.status,
    contractType: c.contractType,
    msaParentId: c.msaParentId,
    serviceLevelTerms: c.serviceLevelTerms ?? null,
    acceptanceCriteria: c.acceptanceCriteria,
    derivedStatus: deriveContractStatus(c.status, c.endDate, threshold),
    daysToExpiry: daysToExpiry(c.endDate),
    startDate: c.startDate,
    endDate: c.endDate,
    paymentTermsDays: c.paymentTermsDays,
    referenceIndex: c.referenceIndex,
    billingCurrency: c.billingCurrency,
    annualBaselineUsd:
      c.annualBaselineUsd === null ? null : Number(c.annualBaselineUsd),
    owner: c.owner,
    internalNotes: c.internalNotes,
    renewalTargetDate: c.renewalTargetDate,
    renewalTargetAction: c.renewalTargetAction,
    renewalAlertedThresholds: c.renewalAlertedThresholds ?? [],
    sourceSystem: c.sourceSystem,
    sourceExternalId: c.sourceExternalId,
    createdAt: c.createdAt,
  };
}

// Cursor: `${endDateIso}|${id}` base64url-encoded. The list orders by
// `(end_date ASC, id ASC)` because the renewal calendar / "soonest
// expiring first" is the dominant read pattern, and ties on end_date
// (uncommon but possible) resolve deterministically by id.
function encodeContractCursor(endDate: Date, id: string): string {
  return Buffer.from(`${endDate.toISOString()}|${id}`, "utf8").toString(
    "base64url",
  );
}
function decodeContractCursor(
  raw: string,
): { endDate: Date; id: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf("|");
    if (sep <= 0) return null;
    const dateStr = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    const endDate = new Date(dateStr);
    if (Number.isNaN(endDate.getTime()) || !id) return null;
    return { endDate, id };
  } catch {
    return null;
  }
}

// ─── GET /contracts ──────────────────────────────────────────────────────

router.get("/contracts", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? "50", 10) || 50, 1),
    200,
  );
  const cursor = req.query.cursor as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();
  const statusFilter = req.query.status as string | undefined;
  const supplierIdFilter = req.query.supplierId as string | undefined;
  const categoryIdFilter = req.query.categoryId as string | undefined;
  const currencyFilter = req.query.currency as string | undefined;
  const ownerFilter = (req.query.owner as string | undefined)?.trim();
  const missingFilter = (req.query.missing as string | undefined)?.trim();

  // Threshold is per-tenant — read once for the whole list so each row
  // gets the same `derivedStatus` boundary even if the request races
  // with a `PATCH /me/settings` that flips the value mid-page.
  const [orgRow] = await db
    .select({ settings: orgsTable.settings })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId));
  const threshold = readRenewalAlertDays(orgRow?.settings ?? null);

  const where = [eq(contractsTable.orgId, orgId)];

  if (statusFilter === "expiring") {
    // Derived bucket: active contracts whose end_date is within the
    // tenant threshold window, but not yet expired. Mirror the
    // computation in `deriveContractStatus` so list filtering and
    // colour coding can never disagree.
    where.push(eq(contractsTable.status, "active"));
    where.push(
      sql`${contractsTable.endDate} > NOW()`,
      sql`${contractsTable.endDate} <= NOW() + (${threshold} || ' days')::interval`,
    );
  } else if (
    statusFilter === "active" ||
    statusFilter === "pending" ||
    statusFilter === "expired" ||
    statusFilter === "cancelled"
  ) {
    where.push(eq(contractsTable.status, statusFilter));
  }

  if (search) {
    const like = `%${search}%`;
    const cond = or(
      ilike(contractsTable.contractNumber, like),
      ilike(contractsTable.title, like),
    );
    if (cond) where.push(cond);
  }
  if (supplierIdFilter) {
    where.push(eq(contractsTable.supplierId, supplierIdFilter));
  }
  if (categoryIdFilter) {
    where.push(eq(contractsTable.categoryId, categoryIdFilter));
  }
  if (currencyFilter) {
    where.push(eq(contractsTable.billingCurrency, currencyFilter));
  }
  if (ownerFilter) {
    where.push(ilike(contractsTable.owner, `%${ownerFilter}%`));
  }
  // `?missing=<field>` narrows to the rows the data-readiness card flagged
  // so the operator lands on the exact gap. Unknown values are silently
  // ignored so adding new readiness checks never 400s the existing list
  // page if the FE/BE roll out is staggered.
  //
  // `end_date` is intentionally not handled here — the column is `NOT NULL`
  // in the schema, so a filter for null end-dates would always be empty.
  // The matching readiness rule sends operators to /contracts unfiltered.
  if (missingFilter === "annual_baseline_usd") {
    where.push(
      or(
        isNull(contractsTable.annualBaselineUsd),
        sql`${contractsTable.annualBaselineUsd}::numeric <= 0`,
      )!,
    );
  } else if (missingFilter === "owner") {
    where.push(
      or(isNull(contractsTable.owner), eq(contractsTable.owner, ""))!,
    );
  } else if (missingFilter === "reference_index") {
    where.push(
      or(
        isNull(contractsTable.referenceIndex),
        eq(contractsTable.referenceIndex, ""),
      )!,
    );
  }
  if (cursor) {
    const decoded = decodeContractCursor(cursor);
    if (decoded) {
      const cond = or(
        sql`${contractsTable.endDate} > ${decoded.endDate}`,
        and(
          eq(contractsTable.endDate, decoded.endDate),
          sql`${contractsTable.id} > ${decoded.id}`,
        ),
      );
      if (cond) where.push(cond);
    }
  }

  const rows = await db
    .select({
      c: contractsTable,
      supplierName: suppliersTable.name,
      categoryName: categoriesTable.name,
    })
    .from(contractsTable)
    .leftJoin(suppliersTable, eq(contractsTable.supplierId, suppliersTable.id))
    .leftJoin(
      categoriesTable,
      eq(contractsTable.categoryId, categoriesTable.id),
    )
    .where(and(...where))
    .orderBy(asc(contractsTable.endDate), asc(contractsTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const items = sliced.map((r) =>
    mapContractRow({
      c: r.c,
      supplierName: r.supplierName,
      categoryName: r.categoryName,
      threshold,
    }),
  );
  const last = sliced.at(-1);
  res.json({
    items,
    nextCursor:
      hasMore && last ? encodeContractCursor(last.c.endDate, last.c.id) : null,
  });
});

// ─── Shared detail loader (used by GET + PATCH) ──────────────────────────
//
// PATCH responses are required to match `ContractDetail` exactly so the
// FE can swap the row in cache without a follow-up GET. Extracting the
// detail projection avoids drifting between GET and PATCH if the wire
// shape ever changes.

async function loadContractDetail(
  orgId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({
      c: contractsTable,
      supplierName: suppliersTable.name,
      categoryName: categoriesTable.name,
      categoryCode: categoriesTable.code,
      orgSettings: orgsTable.settings,
    })
    .from(contractsTable)
    .leftJoin(suppliersTable, eq(contractsTable.supplierId, suppliersTable.id))
    .leftJoin(
      categoriesTable,
      eq(contractsTable.categoryId, categoriesTable.id),
    )
    .innerJoin(orgsTable, eq(contractsTable.orgId, orgsTable.id))
    .where(and(eq(contractsTable.orgId, orgId), eq(contractsTable.id, id)));
  if (!row) return null;

  const threshold = readRenewalAlertDays(row.orgSettings ?? null);

  // Items, opportunities, FX/PPI signals, audit log — issued in
  // parallel; each query is independent and the contract detail page
  // renders the union, so we don't gain anything from sequencing them.
  const [items, oppRows, fxSignals, ppiSignals, auditRows] = await Promise.all([
    db
      .select()
      .from(contractItemsTable)
      .where(
        and(
          eq(contractItemsTable.orgId, orgId),
          eq(contractItemsTable.contractId, id),
        ),
      )
      .orderBy(asc(contractItemsTable.sku)),
    // Opportunities whose lever stamped this contract id into
    // `inputs.contractId` (currently the contract_renegotiation_trigger
    // and spot_vs_contract levers from `lib/levers/tier2.ts`).
    db
      .select()
      .from(opportunitiesTable)
      .where(
        and(
          eq(opportunitiesTable.orgId, orgId),
          sql`${opportunitiesTable.inputs}->>'contractId' = ${id}`,
        ),
      )
      .orderBy(sql`${opportunitiesTable.createdAt} DESC`),
    // Most-recent FX rate observations for any pair that touches this
    // contract's billing currency. Keep org-scoped + global rows
    // (ECB feed is platform-wide so org_id IS NULL is the common
    // case) and limit to a small recent window so the FX card isn't
    // flooded by months of history — the card's chart/sparkline
    // handles the rest.
    row.c.billingCurrency
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
                eq(marketSignalsTable.scopeMaterialCode, `EUR/${row.c.billingCurrency}`),
                eq(marketSignalsTable.scopeMaterialCode, `USD/${row.c.billingCurrency}`),
              )!,
              sql`${marketSignalsTable.observedAt} >= NOW() - INTERVAL '180 days'`,
            ),
          )
          .orderBy(sql`${marketSignalsTable.observedAt} DESC`)
          .limit(180)
      : Promise.resolve([] as Array<typeof marketSignalsTable.$inferSelect>),
    // PPI / economic_index observations for the contract's category
    // code. The lever join key is `categories.code` (UPPER), so we
    // match on the same column.
    row.categoryCode
      ? db
          .select()
          .from(marketSignalsTable)
          .where(
            and(
              or(
                eq(marketSignalsTable.orgId, orgId),
                isNull(marketSignalsTable.orgId),
              )!,
              or(
                eq(marketSignalsTable.signalType, "economic_index"),
                eq(marketSignalsTable.signalType, "commodity_index"),
              )!,
              sql`UPPER(${marketSignalsTable.scopeCategoryCode}) = ${row.categoryCode.toUpperCase()}`,
              sql`${marketSignalsTable.observedAt} >= NOW() - INTERVAL '365 days'`,
            ),
          )
          .orderBy(sql`${marketSignalsTable.observedAt} DESC`)
          .limit(60)
      : Promise.resolve([] as Array<typeof marketSignalsTable.$inferSelect>),
    db
      .select()
      .from(contractAuditLogTable)
      .where(
        and(
          eq(contractAuditLogTable.orgId, orgId),
          eq(contractAuditLogTable.contractId, id),
        ),
      )
      .orderBy(sql`${contractAuditLogTable.createdAt} DESC`)
      .limit(200),
  ]);

  // Child SOWs: only relevant for MSA-shaped contracts. We always
  // run the query (cheap with the `sow_contract_idx` index) so the
  // section can render an empty state for non-MSA contracts. The
  // `openMilestoneCount` aggregate uses the same terminal-status set
  // as the SOW list/detail endpoints so the badges agree.
  const childSowRowsRaw = await db.execute(sql`
    SELECT
      s.id,
      s.sow_number,
      s.title,
      s.status,
      s.start_date,
      s.end_date,
      s.total_value_usd,
      COUNT(m.id)::int AS milestone_count,
      COUNT(m.id) FILTER (
        WHERE m.status NOT IN ('accepted','invoiced','paid','cancelled')
      )::int AS open_milestone_count
    FROM statements_of_work s
    LEFT JOIN sow_milestones m ON m.sow_id = s.id
    WHERE s.org_id = ${orgId}
      AND s.contract_id = ${id}
    GROUP BY s.id
    ORDER BY s.start_date DESC
    LIMIT 50
  `);
  type ChildSowRaw = {
    id: string;
    sow_number: string;
    title: string;
    status: string;
    start_date: Date | string | null;
    end_date: Date | string | null;
    total_value_usd: string | null;
    milestone_count: number;
    open_milestone_count: number;
  };
  const childSowRows = childSowRowsRaw.rows as ChildSowRaw[];

  // Fold the linked opportunities' citations into a single
  // de-duplicated InsightSource[] for the detail page's footer.
  const sources: InsightSource[] = dedupeSources(
    oppRows.flatMap((o) =>
      extractSourcesFromInputs(o.inputs as Record<string, unknown> | null),
    ),
  );

  return {
    ...mapContractRow({
      c: row.c,
      supplierName: row.supplierName,
      categoryName: row.categoryName,
      threshold,
    }),
    // CPI pushback context (#68): expose the contract's category code
    // and — when it maps to a consumer-facing CPI sub-series — the
    // canonical BLS scope code. Lets the Command Center render the
    // matching CPI trend chart alongside the supplier price history
    // without re-running the lever-side mapping client-side.
    categoryCode: row.categoryCode,
    cpiScopeCode: cpiScopeForCategoryCode(row.categoryCode),
    items: items.map((it) => ({
      id: it.id,
      sku: it.sku,
      itemId: it.itemId,
      contractedUnitPriceUsd: Number(it.contractedUnitPriceUsd),
      tiers: (it.tiers ?? []).map((t) => ({
        minQty: Number(t.minQty),
        unitPriceUsd: Number(t.unitPriceUsd),
      })),
    })),
    linkedOpportunities: oppRows.map((o) => ({
      id: o.id,
      leverId: o.leverId,
      status: o.status,
      title: o.title,
      projectedSavingsUsd: Number(o.projectedSavingsUsd),
      createdAt: o.createdAt,
    })),
    marketSignals: [...fxSignals, ...ppiSignals].map((s) => ({
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
    sources,
    auditLog: auditRows.map((a) => ({
      id: a.id,
      field: a.field,
      actorEmail: a.actorEmail,
      oldValue: a.oldValue,
      newValue: a.newValue,
      createdAt: a.createdAt,
    })),
    childSows: childSowRows.map((r) => ({
      id: r.id,
      sowNumber: r.sow_number,
      title: r.title,
      status: r.status,
      startDate:
        r.start_date instanceof Date
          ? r.start_date.toISOString()
          : r.start_date,
      endDate:
        r.end_date instanceof Date ? r.end_date.toISOString() : r.end_date,
      totalValueUsd: r.total_value_usd === null ? 0 : Number(r.total_value_usd),
      milestoneCount: Number(r.milestone_count ?? 0),
      openMilestoneCount: Number(r.open_milestone_count ?? 0),
    })),
  };
}

// ─── GET /contracts/:id ──────────────────────────────────────────────────

router.get("/contracts/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const detail = await loadContractDetail(orgId, id);
  if (!detail) {
    res.status(404).json({ error: "Contract not found" });
    return;
  }
  res.json(detail);
});

// ─── PATCH /contracts/:id ────────────────────────────────────────────────

router.patch("/contracts/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const body = patchContractBodySchema.parse(req.body);

  const [current] = await db
    .select()
    .from(contractsTable)
    .where(and(eq(contractsTable.orgId, orgId), eq(contractsTable.id, id)));
  if (!current) {
    res.status(404).json({ error: "Contract not found" });
    return;
  }

  // Build the diff the audit log will record. Only changed fields
  // produce a row; sending the same value back is a no-op edit and
  // shouldn't pollute the timeline.
  const updates: Partial<typeof contractsTable.$inferInsert> = {};
  const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> =
    [];

  if (body.owner !== undefined && body.owner !== current.owner) {
    updates.owner = body.owner;
    changes.push({ field: "owner", oldValue: current.owner, newValue: body.owner });
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
  if (
    body.renewalTargetAction !== undefined &&
    body.renewalTargetAction !== current.renewalTargetAction
  ) {
    updates.renewalTargetAction = body.renewalTargetAction;
    changes.push({
      field: "renewalTargetAction",
      oldValue: current.renewalTargetAction,
      newValue: body.renewalTargetAction,
    });
  }
  if (body.renewalTargetDate !== undefined) {
    const incoming = body.renewalTargetDate;
    const same =
      (incoming === null && current.renewalTargetDate === null) ||
      (incoming instanceof Date &&
        current.renewalTargetDate instanceof Date &&
        incoming.getTime() === current.renewalTargetDate.getTime());
    if (!same) {
      updates.renewalTargetDate = incoming;
      changes.push({
        field: "renewalTargetDate",
        oldValue: current.renewalTargetDate,
        newValue: incoming,
      });
    }
  }
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

  if (changes.length > 0) {
    const actor = req.actorEmail ?? "system@procuro.ai";
    await db.transaction(async (tx) => {
      await tx
        .update(contractsTable)
        .set(updates)
        .where(eq(contractsTable.id, id));
      for (const change of changes) {
        await tx.insert(contractAuditLogTable).values({
          id: newId("aud"),
          orgId,
          contractId: id,
          actorEmail: actor,
          field: change.field,
          oldValue: change.oldValue as never,
          newValue: change.newValue as never,
        });
      }
    });
  }

  const detail = await loadContractDetail(orgId, id);
  if (!detail) {
    // Race: row was deleted between our SELECT and the projection.
    // Treat as not-found rather than echoing a stale snapshot.
    res.status(404).json({ error: "Contract not found" });
    return;
  }
  res.json(detail);
});

export default router;
