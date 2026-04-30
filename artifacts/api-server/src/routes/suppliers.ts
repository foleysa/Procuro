import { Router, type IRouter } from "express";
import {
  db,
  suppliersTable,
  marketSignalsTable,
  type MarketSignalRow,
} from "@workspace/db";
import { and, eq, ilike, gt, asc, desc, isNull, or, sql } from "drizzle-orm";
import { resolveEntity, type ResolvedEntity } from "@workspace/intelligence";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { getCollector } from "../lib/intelligence/runtime";
import { collectorContract } from "../lib/intelligence/collector";
import {
  SUPPLIER_INTELLIGENCE_SIGNAL_TYPES,
  renderSupplierIntelligenceHeadline,
  type SupplierIntelligenceSignalType,
} from "../lib/supplier-intelligence";

const router: IRouter = Router();

router.get("/suppliers", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const search = (req.query.search as string | undefined)?.trim();
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? "50", 10) || 50, 1),
    200,
  );
  const cursor = req.query.cursor as string | undefined;

  const where = [eq(suppliersTable.orgId, orgId)];
  if (search) where.push(ilike(suppliersTable.name, `%${search}%`));
  if (cursor) where.push(gt(suppliersTable.id, cursor));

  const rows = await db
    .select({
      id: suppliersTable.id,
      name: suppliersTable.name,
      countryCode: suppliersTable.countryCode,
      paymentTermsDays: suppliersTable.paymentTermsDays,
      isStrategic: suppliersTable.isStrategic,
      isPreferred: suppliersTable.isPreferred,
      tags: suppliersTable.tags,
    })
    .from(suppliersTable)
    .where(and(...where))
    .orderBy(asc(suppliersTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    items,
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
  });
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
      resolvedEntityUid,
      resolvedMatchType,
      countsByType,
      totalCount: items.length,
      items,
    });
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
