/**
 * Intelligence Fusion Center routes.
 *
 * All endpoints share these contract guarantees:
 *  - Tenant isolation via `tenantMiddleware` + `requireOrgId(req)`. Every
 *    SQL filter joins on `org_id = $tenant OR org_id IS NULL` so a
 *    request only ever sees its own tenant's signals + the platform
 *    "global" feeds (fx, commodity index, …).
 *  - Disclosure-policy filtering is applied SERVER-SIDE before the wire:
 *    `conservative` tenants never see T3/T4 rows (they're stripped and
 *    counted in `droppedByPolicy`); `standard` sees T1/T2/T3; `analyst`
 *    sees everything including T4.
 *  - Every signal row carries a built `InsightSource` so the client-side
 *    `<InsightCitations>` renderer can decide how to render the
 *    citation per the active policy.
 */

import { Router, type IRouter } from "express";
import {
  db,
  marketSignalsTable,
  collectorsTable,
  suppliersTable,
  categoriesTable,
  contractsTable,
  itemsTable,
  orgsTable,
  analysisCyclesTable,
  type MarketSignalType,
  type MarketSignalRow,
} from "@workspace/db";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  RISK_DIMENSIONS,
  scoreAllDimensions,
  scoreBand,
  type ScoringSignal,
  type RiskDimension,
} from "@workspace/intelligence/scoring";
import type {
  DisclosureTier,
  TenantPolicy,
} from "@workspace/intelligence";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { InvalidRequestError, NotFoundError } from "../lib/api-errors";
import { readDisclosurePolicy } from "../lib/disclosure-policy";
import { getCollector } from "../lib/intelligence/runtime";
import {
  MATERIAL_TO_CATEGORY_CODES,
  materialCodeForCategoryCode,
} from "../lib/intelligence/scope-taxonomy";
import type { IntelligenceCollector } from "../lib/intelligence/collector";
import { subscribeMarketSignalIds } from "../lib/intelligence/event-bus";

const router: IRouter = Router();

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

/**
 * Express's `req.query` typing returns `string | qs.ParsedQs |
 * (string | qs.ParsedQs)[] | undefined` for every key. We only ever
 * accept scalar string values for our intelligence endpoints — anything
 * else is treated as absent.
 */
function readStringQuery(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Resolve the active tenant's policy from `orgs.settings`. */
async function loadPolicy(orgId: string): Promise<TenantPolicy> {
  const [row] = await db
    .select({ settings: orgsTable.settings })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId))
    .limit(1);
  return readDisclosurePolicy(row?.settings ?? null);
}

/**
 * The set of disclosure tiers the active policy is allowed to see.
 * `conservative` is the most restrictive; `analyst` sees everything.
 */
function visibleTiersForPolicy(policy: TenantPolicy): readonly DisclosureTier[] {
  if (policy === "analyst") return ["T1", "T2", "T3", "T4"];
  if (policy === "standard") return ["T1", "T2", "T3"];
  return ["T1", "T2"];
}

/** Build an in-memory map of collectorId -> in-process collector. */
function collectMap(ids: readonly string[]): Map<string, IntelligenceCollector> {
  const out = new Map<string, IntelligenceCollector>();
  for (const id of ids) {
    const c = getCollector(id);
    if (c) out.set(id, c);
  }
  return out;
}

interface SignalCitation {
  collectorId: string;
  collectorName: string;
  sourceUrl: string;
  observedAt: string;
  contract: {
    postureClass: "public_api" | "tos_restricted" | "gray_hat";
    disclosureTier: DisclosureTier;
    jurisdiction: string;
    retentionDays: number;
    tenantOptInDefault: boolean;
  };
}

function buildCitation(
  row: MarketSignalRow,
  collector: IntelligenceCollector | undefined,
): SignalCitation {
  // Best-effort posture-class fallback: rows with no in-process
  // collector default to the most restrictive class so the renderer
  // never accidentally elevates an unknown source.
  const postureClass = collector?.postureClass ?? "gray_hat";
  return {
    collectorId: row.collectorId,
    collectorName: collector?.name ?? row.collectorId,
    sourceUrl: row.sourceUrl,
    observedAt: row.observedAt.toISOString(),
    contract: {
      postureClass,
      disclosureTier: collector?.disclosureTier ?? "T4",
      jurisdiction: collector?.jurisdiction ?? "GLOBAL",
      retentionDays: collector?.retentionDays ?? 0,
      tenantOptInDefault: collector?.tenantOptInDefault ?? false,
    },
  };
}

interface ResolvedScope {
  kind: "material" | "category" | "supplier" | "sku" | "lane" | "none";
  label: string;
  materialCode: string | null;
  categoryCode: string | null;
  supplierName: string | null;
  supplierId: string | null;
  laneKey: string | null;
}

function resolveScope(
  row: MarketSignalRow,
  supplierIdByName?: Map<string, string>,
): ResolvedScope {
  if (row.scopeSupplierName) {
    return {
      kind: "supplier",
      label: row.scopeSupplierName,
      materialCode: null,
      categoryCode: null,
      supplierName: row.scopeSupplierName,
      // Best-effort name → id resolution so the Signal Browser can deep
      // link supplier rows into Entity 360 without a follow-up RPC.
      supplierId: supplierIdByName?.get(row.scopeSupplierName) ?? null,
      laneKey: null,
    };
  }
  if (row.scopeMaterialCode) {
    return {
      kind: "material",
      label: row.scopeMaterialCode,
      materialCode: row.scopeMaterialCode,
      categoryCode: null,
      supplierName: null,
      supplierId: null,
      laneKey: null,
    };
  }
  if (row.scopeCategoryCode) {
    return {
      kind: "category",
      label: row.scopeCategoryCode,
      materialCode: null,
      categoryCode: row.scopeCategoryCode,
      supplierName: null,
      supplierId: null,
      laneKey: null,
    };
  }
  if (row.scopeSku) {
    return {
      kind: "sku",
      label: row.scopeSku,
      materialCode: null,
      categoryCode: null,
      supplierName: null,
      supplierId: null,
      laneKey: null,
    };
  }
  if (row.scopeLaneKey) {
    return {
      kind: "lane",
      label: row.scopeLaneKey,
      materialCode: null,
      categoryCode: null,
      supplierName: null,
      supplierId: null,
      laneKey: row.scopeLaneKey,
    };
  }
  return {
    kind: "none",
    label: row.signalType,
    materialCode: null,
    categoryCode: null,
    supplierName: null,
    supplierId: null,
    laneKey: null,
  };
}

interface IntelligenceSignalDto {
  id: string;
  signalType: string;
  value: number;
  unit: string | null;
  currency: string | null;
  confidence: number | null;
  observedAt: string;
  sourceUrl: string | null;
  tier: DisclosureTier;
  scope: ResolvedScope;
  metadata: Record<string, unknown> | null;
  source: SignalCitation;
}

/**
 * Materialise rows into wire DTOs and apply the tenant disclosure
 * policy. Returns both the visible set and how many rows were dropped
 * by the policy so the UI can show "N hidden by policy".
 */
async function materialiseSignals(
  orgId: string,
  rows: readonly MarketSignalRow[],
  collectors: Map<string, IntelligenceCollector>,
  policy: TenantPolicy,
): Promise<{ items: IntelligenceSignalDto[]; droppedByPolicy: number }> {
  const visibleTiers = new Set<DisclosureTier>(visibleTiersForPolicy(policy));
  // Pre-resolve supplier name → id for the rows we're about to render so
  // every supplier-scoped Signal Browser row carries a `supplierId` and
  // can deep-link into Entity 360 without an extra RPC. We only ever
  // resolve names against this tenant's suppliers — no cross-tenant
  // leak of the id.
  const supplierNames = Array.from(
    new Set(
      rows.map((r) => r.scopeSupplierName).filter((n): n is string => !!n),
    ),
  );
  const supplierIdByName = new Map<string, string>();
  if (supplierNames.length > 0) {
    const matched = await db
      .select({ id: suppliersTable.id, name: suppliersTable.name })
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.orgId, orgId),
          inArray(suppliersTable.name, supplierNames),
        ),
      );
    for (const m of matched) supplierIdByName.set(m.name, m.id);
  }
  const items: IntelligenceSignalDto[] = [];
  let dropped = 0;
  for (const row of rows) {
    const collector = collectors.get(row.collectorId);
    const tier: DisclosureTier = collector?.disclosureTier ?? "T4";
    if (!visibleTiers.has(tier)) {
      dropped += 1;
      continue;
    }
    items.push({
      id: row.id,
      signalType: row.signalType,
      value: Number(row.value),
      unit: row.unit ?? null,
      currency: row.currency ?? null,
      confidence: row.confidence !== null ? Number(row.confidence) : null,
      observedAt: row.observedAt.toISOString(),
      sourceUrl: row.sourceUrl ?? null,
      tier,
      scope: resolveScope(row, supplierIdByName),
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      source: buildCitation(row, collector),
    });
  }
  return { items, droppedByPolicy: dropped };
}

/** Tenant-scoped base WHERE: own-tenant rows + global (orgId IS NULL). */
function tenantScopeCondition(orgId: string): SQL {
  return or(
    eq(marketSignalsTable.orgId, orgId),
    isNull(marketSignalsTable.orgId),
  )!;
}

// ---------------------------------------------------------------------
// GET /intelligence/signals  — Signal Browser
// ---------------------------------------------------------------------

router.get("/intelligence/signals", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const policy = await loadPolicy(orgId);

  const limit = Math.min(
    Math.max(parseInt(String(req.query["limit"] ?? "100"), 10) || 100, 1),
    500,
  );

  const conditions: SQL[] = [tenantScopeCondition(orgId)];

  const signalType = readStringQuery(req.query["signalType"]);
  if (signalType) {
    conditions.push(
      eq(marketSignalsTable.signalType, signalType as MarketSignalType),
    );
  }

  const country = readStringQuery(req.query["country"]);
  if (country) {
    conditions.push(eq(marketSignalsTable.scopeLaneKey, country.toUpperCase()));
  }

  const supplierIdQ = readStringQuery(req.query["supplierId"]);
  if (supplierIdQ) {
    // Resolve to supplier name (signals key by name, not id).
    const [s] = await db
      .select({ name: suppliersTable.name })
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.id, supplierIdQ),
          eq(suppliersTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (s?.name) {
      conditions.push(eq(marketSignalsTable.scopeSupplierName, s.name));
    } else {
      // Unknown supplier id for this tenant — return an empty result
      // rather than leaking signals tagged with a name that happens to
      // match across tenants.
      res.json({
        items: [],
        nextCursor: null,
        totalCount: 0,
        droppedByPolicy: 0,
        policy,
      });
      return;
    }
  }

  const since = readStringQuery(req.query["since"]);
  if (since) {
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) {
      conditions.push(gte(marketSignalsTable.observedAt, d));
    }
  }

  const q = readStringQuery(req.query["q"]);
  if (q) {
    const like = `%${q}%`;
    conditions.push(
      or(
        ilike(marketSignalsTable.scopeSupplierName, like),
        ilike(marketSignalsTable.scopeMaterialCode, like),
        ilike(marketSignalsTable.scopeCategoryCode, like),
        ilike(marketSignalsTable.scopeLaneKey, like),
      )!,
    );
  }

  // Over-fetch a little to allow for policy drops without making the
  // page look short. Cap at 2x the requested limit.
  const fetchLimit = Math.min(limit * 2, 500);
  const rows = await db
    .select()
    .from(marketSignalsTable)
    .where(and(...conditions))
    .orderBy(desc(marketSignalsTable.observedAt))
    .limit(fetchLimit);

  const collectorIds = Array.from(new Set(rows.map((r) => r.collectorId)));
  const collectors = collectMap(collectorIds);
  const { items, droppedByPolicy } = await materialiseSignals(
    orgId,
    rows,
    collectors,
    policy,
  );
  const trimmed = items.slice(0, limit);

  req.log.info(
    { orgId, returned: trimmed.length, droppedByPolicy, policy },
    "intelligence.signals.served",
  );

  res.json({
    items: trimmed,
    nextCursor: null,
    totalCount: trimmed.length,
    droppedByPolicy,
    policy,
  });
});

// ---------------------------------------------------------------------
// GET /intelligence/entity/:kind/:id  — Entity 360
// ---------------------------------------------------------------------
//
// Six entity kinds are supported:
//   - supplier  → DB UUID, scopes signals on `scope_supplier_name`
//   - material  → SKU code, scopes on `scope_material_code`
//   - category  → category code, scopes on `scope_category_code`
//   - lane      → ISO-2 country / lane key, scopes on `scope_lane_key`
//   - contract  → DB UUID, scopes on the contract's bound supplier name
//                 plus, when the contract has a category, the category code
//   - site      → currently a SUPPLIER-AS-SITE proxy (id is supplierId).
//                 Returns the supplier's HQ coordinates as the "site
//                 location" plus the same supplier-scoped signals — the
//                 dedicated `sites` table is on the v2 roadmap.

const ENTITY_LOOKBACK_DAYS = 90;
const VALID_ENTITY_KINDS = [
  "supplier",
  "material",
  "category",
  "lane",
  "contract",
  "site",
] as const;
type EntityKind = (typeof VALID_ENTITY_KINDS)[number];

router.get(
  "/intelligence/entity/:kind/:id",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const policy = await loadPolicy(orgId);
    const kindRaw = String(req.params["kind"] ?? "");
    const id = String(req.params["id"] ?? "");
    if (!VALID_ENTITY_KINDS.includes(kindRaw as EntityKind)) {
      throw new InvalidRequestError(`unknown entity kind: ${kindRaw}`);
    }
    const kind = kindRaw as EntityKind;
    if (id.length === 0) {
      throw new InvalidRequestError("id is required");
    }

    // Resolve a human label + scope-condition for this entity.
    let label = id;
    let country: string | null = null;
    let recentSpend: number | null = null;
    let scopeCondition: SQL | null = null;
    let details: Record<string, unknown> | null = null;

    if (kind === "supplier" || kind === "site") {
      const [s] = await db
        .select({
          id: suppliersTable.id,
          name: suppliersTable.name,
          countryCode: suppliersTable.countryCode,
        })
        .from(suppliersTable)
        .where(and(eq(suppliersTable.id, id), eq(suppliersTable.orgId, orgId)))
        .limit(1);
      if (!s) {
        throw new NotFoundError(kind === "site" ? "Site not found" : "Supplier not found");
      }
      label = s.name;
      country = s.countryCode ?? null;
      scopeCondition = eq(marketSignalsTable.scopeSupplierName, s.name);
      const spendRow = await db.execute(sql`
        SELECT COALESCE(SUM(extended_usd::numeric), 0) AS spend
        FROM po_lines
        WHERE org_id = ${orgId}
          AND supplier_id = ${id}
          AND order_date >= NOW() - INTERVAL '90 days'
      `);
      recentSpend = Number(
        (spendRow.rows[0] as { spend: string } | undefined)?.spend ?? 0,
      );
      if (kind === "site") {
        const centroid = country ? countryCentroid(country) : null;
        details = {
          proxiedAs: "supplier",
          supplierId: s.id,
          supplierName: s.name,
          country: country,
          lat: centroid?.lat ?? null,
          lng: centroid?.lng ?? null,
        };
      }
    } else if (kind === "contract") {
      const [c] = await db
        .select({
          id: contractsTable.id,
          contractNumber: contractsTable.contractNumber,
          title: contractsTable.title,
          status: contractsTable.status,
          startDate: contractsTable.startDate,
          endDate: contractsTable.endDate,
          annualBaselineUsd: contractsTable.annualBaselineUsd,
          supplierId: contractsTable.supplierId,
          categoryId: contractsTable.categoryId,
          supplierName: suppliersTable.name,
          categoryCode: categoriesTable.code,
          categoryName: categoriesTable.name,
        })
        .from(contractsTable)
        .leftJoin(
          suppliersTable,
          eq(suppliersTable.id, contractsTable.supplierId),
        )
        .leftJoin(
          categoriesTable,
          eq(categoriesTable.id, contractsTable.categoryId),
        )
        .where(
          and(eq(contractsTable.id, id), eq(contractsTable.orgId, orgId)),
        )
        .limit(1);
      if (!c) {
        throw new NotFoundError("Contract not found");
      }
      label = c.title;
      // Pull every signal scoped to this contract's supplier OR to the
      // contract's category (when present).
      const supplierName = c.supplierName ?? null;
      const categoryCode = c.categoryCode ?? null;
      const conds: SQL[] = [];
      if (supplierName) {
        conds.push(eq(marketSignalsTable.scopeSupplierName, supplierName));
      }
      if (categoryCode) {
        conds.push(eq(marketSignalsTable.scopeCategoryCode, categoryCode));
        // Mirror the category branch: when the contract's category
        // code resolves to a canonical material via the alias map,
        // also pull material-scoped signals (USDA NASS, FRED PPI,
        // World Bank Pink Sheet) so contract pages don't miss the
        // commodity feeds for food/dairy/meat/cotton contracts.
        const resolvedMaterial = materialCodeForCategoryCode(categoryCode);
        if (resolvedMaterial) {
          const aliases = MATERIAL_TO_CATEGORY_CODES[resolvedMaterial];
          conds.push(
            inArray(
              marketSignalsTable.scopeMaterialCode,
              aliases as unknown as string[],
            ),
          );
        }
      }
      scopeCondition = conds.length > 0 ? or(...conds)! : sql`FALSE`;
      details = {
        contractNumber: c.contractNumber,
        title: c.title,
        status: c.status,
        supplierId: c.supplierId,
        supplierName,
        categoryCode,
        categoryName: c.categoryName,
        startDate: c.startDate.toISOString(),
        endDate: c.endDate.toISOString(),
        annualBaselineUsd:
          c.annualBaselineUsd !== null ? Number(c.annualBaselineUsd) : null,
      };
      recentSpend =
        c.annualBaselineUsd !== null ? Number(c.annualBaselineUsd) : null;
    } else if (kind === "category") {
      const [c] = await db
        .select({ name: categoriesTable.name, code: categoriesTable.code })
        .from(categoriesTable)
        .where(
          and(eq(categoriesTable.code, id), eq(categoriesTable.orgId, orgId)),
        )
        .limit(1);
      if (!c) {
        throw new NotFoundError("Category not found");
      }
      label = c.name;
      // Always pull signals scoped directly to this category code.
      // Additionally, when the category code resolves to a canonical
      // material via the alias map (e.g. tenant code "BEEF" →
      // BEEF_CATTLE, "MAIZE" → CORN, "WHEAT" → WHEAT), surface every
      // material-scoped signal whose scope_material_code is one of
      // that material's aliases. This lets food/dairy/meat/cotton
      // category pages show USDA NASS observations alongside the
      // World Bank Pink Sheet equivalents — both feeds emit on the
      // same canonical alias set.
      const catConds: SQL[] = [
        eq(marketSignalsTable.scopeCategoryCode, id),
      ];
      const resolvedMaterial = materialCodeForCategoryCode(id);
      if (resolvedMaterial) {
        const aliases = MATERIAL_TO_CATEGORY_CODES[resolvedMaterial];
        catConds.push(
          inArray(
            marketSignalsTable.scopeMaterialCode,
            aliases as unknown as string[],
          ),
        );
      }
      scopeCondition = catConds.length === 1 ? catConds[0]! : or(...catConds)!;
    } else if (kind === "material") {
      // We key signals by `scope_material_code` which collectors stamp
      // with the SKU value; resolve a friendlier label from items.
      const [m] = await db
        .select({ description: itemsTable.description })
        .from(itemsTable)
        .where(and(eq(itemsTable.sku, id), eq(itemsTable.orgId, orgId)))
        .limit(1);
      label = m?.description ?? id;
      scopeCondition = eq(marketSignalsTable.scopeMaterialCode, id);
    } else {
      // lane
      label = id;
      country = id.toUpperCase();
      scopeCondition = eq(marketSignalsTable.scopeLaneKey, id);
    }

    const since = new Date(Date.now() - ENTITY_LOOKBACK_DAYS * 86400 * 1000);
    const rows = await db
      .select()
      .from(marketSignalsTable)
      .where(
        and(
          tenantScopeCondition(orgId),
          scopeCondition,
          gte(marketSignalsTable.observedAt, since),
        ),
      )
      .orderBy(desc(marketSignalsTable.observedAt))
      .limit(500);

    const collectorIds = Array.from(new Set(rows.map((r) => r.collectorId)));
    const collectors = collectMap(collectorIds);
    const { items, droppedByPolicy } = await materialiseSignals(
      orgId,
      rows,
      collectors,
      policy,
    );

    // Composite risk uses the same visible-tier set so we never base a
    // score on a row the user can't see.
    const scoringSignals: ScoringSignal[] = items.map((s) => ({
      id: s.id,
      signalType: s.signalType,
      tier: s.tier,
      confidence: s.confidence,
      value: s.value,
      observedAt: new Date(s.observedAt),
      collectorId: s.source.collectorId,
      collectorName: s.source.collectorName,
    }));
    const scored = scoreAllDimensions(scoringSignals);
    const risk = RISK_DIMENSIONS.map((d) => {
      const r = scored[d];
      return {
        dimension: d,
        score: r.score,
        band: scoreBand(r.score),
        signalCount: r.signalCount,
        topContributors: r.topContributors.map((c) => ({
          signalId: c.signalId,
          signalType: c.signalType,
          tier: c.tier,
          collectorId: c.collectorId ?? null,
          collectorName: c.collectorName ?? null,
          weighted: c.weighted,
          observedAt: c.observedAt.toISOString(),
        })),
      };
    });

    req.log.info(
      { orgId, kind, id, signals: items.length, droppedByPolicy, policy },
      "intelligence.entity360.served",
    );

    res.json({
      kind,
      id,
      label,
      country,
      recentSpend,
      risk,
      signals: items,
      policy,
      droppedByPolicy,
      details,
    });
  },
);

// ---------------------------------------------------------------------
// GET /intelligence/risk/heatmap  — Risk Heatmap
// ---------------------------------------------------------------------

router.get(
  "/intelligence/risk/heatmap",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const policy = await loadPolicy(orgId);
    const lookbackDays = Math.min(
      Math.max(
        parseInt(String(req.query["lookbackDays"] ?? "90"), 10) || 90,
        1,
      ),
      730,
    );
    const since = new Date(Date.now() - lookbackDays * 86400 * 1000);

    // Pull every signal with a country scope (lane_key) for the window.
    const rows = await db
      .select()
      .from(marketSignalsTable)
      .where(
        and(
          tenantScopeCondition(orgId),
          gte(marketSignalsTable.observedAt, since),
          sql`${marketSignalsTable.scopeLaneKey} IS NOT NULL`,
        ),
      )
      .orderBy(desc(marketSignalsTable.observedAt))
      .limit(5000);

    const collectorIds = Array.from(new Set(rows.map((r) => r.collectorId)));
    const collectors = collectMap(collectorIds);

    // Bucket by country, then score each bucket.
    const visibleTiers = new Set<DisclosureTier>(
      visibleTiersForPolicy(policy),
    );
    const byCountry = new Map<string, ScoringSignal[]>();
    for (const row of rows) {
      const country = row.scopeLaneKey?.toUpperCase();
      if (!country) continue;
      const collector = collectors.get(row.collectorId);
      const tier: DisclosureTier = collector?.disclosureTier ?? "T4";
      if (!visibleTiers.has(tier)) continue;
      const bucket = byCountry.get(country) ?? [];
      bucket.push({
        id: row.id,
        signalType: row.signalType,
        tier,
        confidence: row.confidence !== null ? Number(row.confidence) : null,
        value: Number(row.value),
        observedAt: row.observedAt,
        collectorId: row.collectorId,
        collectorName: collector?.name ?? row.collectorId,
      });
      byCountry.set(country, bucket);
    }

    const cells: Array<{
      country: string;
      dimension: RiskDimension;
      score: number;
      band: "low" | "moderate" | "elevated" | "high";
      signalCount: number;
      topContributors: Array<{
        signalId: string;
        signalType: string;
        tier: DisclosureTier;
        collectorName: string | null;
        weighted: number;
        observedAt: string;
      }>;
    }> = [];
    const countries = Array.from(byCountry.keys()).sort();
    for (const country of countries) {
      const signals = byCountry.get(country) ?? [];
      const scored = scoreAllDimensions(signals);
      for (const d of RISK_DIMENSIONS) {
        const r = scored[d];
        if (r.signalCount === 0) continue;
        cells.push({
          country,
          dimension: d,
          score: r.score,
          band: scoreBand(r.score),
          signalCount: r.signalCount,
          topContributors: r.topContributors.slice(0, 3).map((c) => ({
            signalId: c.signalId,
            signalType: c.signalType,
            tier: c.tier,
            collectorName: c.collectorName ?? null,
            weighted: c.weighted,
            observedAt: c.observedAt.toISOString(),
          })),
        });
      }
    }

    // Site-level risk view: v1 emits one map point per supplier
    // (supplier-as-site proxy) located at the supplier's HQ country
    // centroid. The point's score is the *max* composite across all
    // dimensions for the disclosure-policy-visible signals attached
    // to that supplier's name. A future revision will swap this for
    // a dedicated `sites` table with real per-facility coordinates.
    const supplierRows = await db
      .select({
        id: suppliersTable.id,
        name: suppliersTable.name,
        countryCode: suppliersTable.countryCode,
      })
      .from(suppliersTable)
      .where(eq(suppliersTable.orgId, orgId));

    // Bucket signals by supplier name (matches how collectors stamp
    // `scope_supplier_name`).
    const bySupplierName = new Map<string, ScoringSignal[]>();
    for (const row of rows) {
      const sn = row.scopeSupplierName;
      if (!sn) continue;
      const collector = collectors.get(row.collectorId);
      const tier: DisclosureTier = collector?.disclosureTier ?? "T4";
      if (!visibleTiers.has(tier)) continue;
      const bucket = bySupplierName.get(sn) ?? [];
      bucket.push({
        id: row.id,
        signalType: row.signalType,
        tier,
        confidence: row.confidence !== null ? Number(row.confidence) : null,
        value: Number(row.value),
        observedAt: row.observedAt,
        collectorId: row.collectorId,
        collectorName: collector?.name ?? row.collectorId,
      });
      bySupplierName.set(sn, bucket);
    }

    // Recent (90d) supplier spend in one round-trip.
    //
    // Pass IDs as ONE comma-joined string param and split server-side
    // with `string_to_array(...)`. Two prior approaches both blow up
    // on tenants with thousands of suppliers:
    //   1) `IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})` —
    //      sql.join wraps each id in its own SQL chunk and drizzle's
    //      mergeQueries recurses once per chunk, hitting the V8
    //      stack ceiling around ~5–10k items.
    //   2) `= ANY(${ids}::text[])` — drizzle's tagged-template
    //      handler treats a JS array template value as nested chunks
    //      `[(, p0, ,, p1, …, )]` and recurses identically.
    // The string-split form sends a single text parameter and lets
    // Postgres do the splitting; supplier IDs are UUIDs so a comma
    // delimiter is safe.
    const supplierIds = supplierRows.map((s) => s.id);
    const spendBySupplier = new Map<string, number>();
    if (supplierIds.length > 0) {
      // `po_lines` carries the spend amount but supplier_id lives on
      // the parent `purchase_orders` header — join through po_id.
      const supplierIdCsv = supplierIds.join(",");
      const spendRows = await db.execute(sql`
        SELECT po.supplier_id AS supplier_id,
               COALESCE(SUM(pol.extended_usd::numeric), 0) AS spend
        FROM po_lines pol
        JOIN purchase_orders po ON po.id = pol.po_id
        WHERE pol.org_id = ${orgId}
          AND po.supplier_id = ANY(string_to_array(${supplierIdCsv}, ','))
          AND pol.order_date >= NOW() - INTERVAL '90 days'
        GROUP BY po.supplier_id
      `);
      for (const r of spendRows.rows as Array<{
        supplier_id: string;
        spend: string;
      }>) {
        spendBySupplier.set(r.supplier_id, Number(r.spend));
      }
    }

    const sites: Array<{
      siteId: string;
      supplierId: string | null;
      label: string;
      country: string;
      lat: number | null;
      lng: number | null;
      riskScore: number;
      band: "low" | "moderate" | "elevated" | "high";
      signalCount: number;
      recentSpend: number | null;
    }> = [];
    for (const s of supplierRows) {
      const country = s.countryCode?.toUpperCase();
      if (!country) continue;
      const supplierSignals = bySupplierName.get(s.name) ?? [];
      if (supplierSignals.length === 0) continue;
      const scored = scoreAllDimensions(supplierSignals);
      let maxScore = 0;
      let totalSignalCount = 0;
      for (const d of RISK_DIMENSIONS) {
        const r = scored[d];
        if (r.score > maxScore) maxScore = r.score;
        totalSignalCount += r.signalCount;
      }
      const centroid = countryCentroid(country);
      sites.push({
        // v1 site identifier is the supplier id; keeps the Entity 360
        // deep-link a stable `/intelligence/entity/site/:supplierId`.
        siteId: s.id,
        supplierId: s.id,
        label: s.name,
        country,
        lat: centroid?.lat ?? null,
        lng: centroid?.lng ?? null,
        riskScore: maxScore,
        band: scoreBand(maxScore),
        signalCount: totalSignalCount,
        recentSpend: spendBySupplier.get(s.id) ?? null,
      });
    }

    req.log.info(
      {
        orgId,
        countries: countries.length,
        cells: cells.length,
        sites: sites.length,
        policy,
      },
      "intelligence.heatmap.served",
    );

    res.json({
      dimensions: [...RISK_DIMENSIONS],
      countries,
      cells,
      sites,
      generatedAt: new Date().toISOString(),
      policy,
    });
  },
);

// ---------------------------------------------------------------------
// GET /intelligence/events  — War Room event stream
// ---------------------------------------------------------------------
//
// Signal types surfaced into the war room:
//   - event_geocoded   (GDELT global event firehose)
//   - natural_hazard   (USGS / NOAA / EONET / GDACS)
//   - sanctions_match  (OFAC / EU / UN / OpenSanctions hits)
//   - corporate_filing (SEC EDGAR / Companies House — filtered by
//                       severityMin so we don't drown the war room
//                       in routine 8-K / RNS noise)
//
// Each row is decorated with `impactPath`: a propagation chain
// (event → site → supplier → contract → category → spend) so the UI
// can deep-link from any link straight into Entity 360.

const EVENT_SIGNAL_TYPES = [
  "event_geocoded",
  "natural_hazard",
  "sanctions_match",
  "corporate_filing",
] as const satisfies readonly MarketSignalType[];

interface ImpactPathStep {
  step: "event" | "site" | "supplier" | "contract" | "category" | "spend";
  kind: "event" | "site" | "supplier" | "contract" | "category" | "spend";
  id: string | null;
  label: string;
  exposureUsd: number | null;
}

interface EventDto {
  id: string;
  signalType: string;
  observedAt: string;
  title: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  severity: number | null;
  actor: string | null;
  eventCode: string | null;
  tier: DisclosureTier;
  source: SignalCitation;
  impactPath: ImpactPathStep[] | null;
}

/**
 * Shared event-row materializer used by both the polled `GET
 * /intelligence/events` endpoint and the live `GET
 * /intelligence/events/stream` SSE push. Applies the tenant disclosure
 * policy + (optional) `corporate_filing` severity floor and decorates
 * every row with its impact-propagation chain.
 *
 * Pulled out as a function so the SSE consumer doesn't fork a parallel
 * (and inevitably divergent) materialization path — every byte the war
 * room sees flows through here, regardless of transport.
 */
async function materialiseEventRows(
  orgId: string,
  rows: readonly MarketSignalRow[],
  policy: TenantPolicy,
  opts: { severityMin: number },
): Promise<{
  items: EventDto[];
  droppedByPolicy: number;
  droppedBySeverity: number;
}> {
  const collectorIds = Array.from(new Set(rows.map((r) => r.collectorId)));
  const collectors = collectMap(collectorIds);
  const visibleTiers = new Set<DisclosureTier>(visibleTiersForPolicy(policy));

  const supplierNames = Array.from(
    new Set(
      rows.map((r) => r.scopeSupplierName).filter((n): n is string => !!n),
    ),
  );
  const supplierMeta = new Map<
    string,
    { id: string; country: string | null }
  >();
  if (supplierNames.length > 0) {
    const matched = await db
      .select({
        id: suppliersTable.id,
        name: suppliersTable.name,
        countryCode: suppliersTable.countryCode,
      })
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.orgId, orgId),
          inArray(suppliersTable.name, supplierNames),
        ),
      );
    for (const m of matched) {
      supplierMeta.set(m.name, {
        id: m.id,
        country: m.countryCode ?? null,
      });
    }
  }

  const supplierIds = Array.from(supplierMeta.values()).map((s) => s.id);
  const spendBySupplier = new Map<string, number>();
  const contractBySupplier = new Map<
    string,
    {
      id: string;
      title: string;
      categoryId: string | null;
      categoryCode: string | null;
      categoryName: string | null;
    }
  >();
  if (supplierIds.length > 0) {
    const supplierIdCsv = supplierIds.join(",");
    const spendRows = await db.execute(sql`
      SELECT po.supplier_id AS supplier_id,
             COALESCE(SUM(pol.extended_usd::numeric), 0) AS spend
      FROM po_lines pol
      JOIN purchase_orders po ON po.id = pol.po_id
      WHERE pol.org_id = ${orgId}
        AND po.supplier_id = ANY(string_to_array(${supplierIdCsv}, ','))
        AND pol.order_date >= NOW() - INTERVAL '90 days'
      GROUP BY po.supplier_id
    `);
    for (const r of spendRows.rows as Array<{
      supplier_id: string;
      spend: string;
    }>) {
      spendBySupplier.set(r.supplier_id, Number(r.spend));
    }
    const contractRows = await db
      .select({
        id: contractsTable.id,
        title: contractsTable.title,
        supplierId: contractsTable.supplierId,
        categoryId: contractsTable.categoryId,
        categoryCode: categoriesTable.code,
        categoryName: categoriesTable.name,
      })
      .from(contractsTable)
      .leftJoin(
        categoriesTable,
        eq(categoriesTable.id, contractsTable.categoryId),
      )
      .where(
        and(
          eq(contractsTable.orgId, orgId),
          inArray(contractsTable.supplierId, supplierIds),
        ),
      )
      .orderBy(desc(contractsTable.startDate));
    for (const r of contractRows) {
      if (!contractBySupplier.has(r.supplierId)) {
        contractBySupplier.set(r.supplierId, {
          id: r.id,
          title: r.title,
          categoryId: r.categoryId ?? null,
          categoryCode: r.categoryCode ?? null,
          categoryName: r.categoryName ?? null,
        });
      }
    }
  }

  let droppedByPolicy = 0;
  let droppedBySeverity = 0;
  const items: EventDto[] = [];

  for (const row of rows) {
    const collector = collectors.get(row.collectorId);
    const tier: DisclosureTier = collector?.disclosureTier ?? "T4";
    if (!visibleTiers.has(tier)) {
      droppedByPolicy += 1;
      continue;
    }
    const severity = row.confidence !== null ? Number(row.confidence) : null;
    if (
      row.signalType === "corporate_filing" &&
      severity !== null &&
      severity < opts.severityMin
    ) {
      droppedBySeverity += 1;
      continue;
    }
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    const lat = readNumber(meta["lat"] ?? meta["latitude"]);
    const lng = readNumber(meta["lng"] ?? meta["longitude"] ?? meta["long"]);
    const title =
      readString(meta["title"]) ??
      readString(meta["headline"]) ??
      readString(meta["summary"]) ??
      null;
    const actor =
      readString(meta["actor"]) ??
      readString(meta["actor1Name"]) ??
      row.scopeSupplierName ??
      null;
    const eventCode =
      readString(meta["eventCode"]) ?? readString(meta["cameoCode"]) ?? null;
    const country = row.scopeLaneKey?.toUpperCase() ?? null;

    const path: ImpactPathStep[] = [
      {
        step: "event",
        kind: "event",
        id: row.id,
        label: title ?? eventCode ?? row.signalType,
        exposureUsd: null,
      },
    ];
    const supplierInfo = row.scopeSupplierName
      ? supplierMeta.get(row.scopeSupplierName)
      : undefined;
    if (supplierInfo) {
      path.push({
        step: "site",
        kind: "site",
        id: supplierInfo.id,
        label: row.scopeSupplierName!,
        exposureUsd: null,
      });
      path.push({
        step: "supplier",
        kind: "supplier",
        id: supplierInfo.id,
        label: row.scopeSupplierName!,
        exposureUsd: null,
      });
      const contract = contractBySupplier.get(supplierInfo.id);
      if (contract) {
        path.push({
          step: "contract",
          kind: "contract",
          id: contract.id,
          label: contract.title,
          exposureUsd: null,
        });
        if (contract.categoryCode) {
          path.push({
            step: "category",
            kind: "category",
            id: contract.categoryCode,
            label: contract.categoryName ?? contract.categoryCode,
            exposureUsd: null,
          });
        }
      }
      const spend = spendBySupplier.get(supplierInfo.id);
      if (spend && spend > 0) {
        path.push({
          step: "spend",
          kind: "spend",
          id: null,
          label: "Spend exposure (90d)",
          exposureUsd: spend,
        });
      }
    } else if (row.scopeCategoryCode) {
      path.push({
        step: "category",
        kind: "category",
        id: row.scopeCategoryCode,
        label: row.scopeCategoryCode,
        exposureUsd: null,
      });
    }

    items.push({
      id: row.id,
      signalType: row.signalType,
      observedAt: row.observedAt.toISOString(),
      title,
      country,
      lat,
      lng,
      severity,
      actor,
      eventCode,
      tier,
      source: buildCitation(row, collector),
      impactPath: path.length > 1 ? path : null,
    });
  }

  return { items, droppedByPolicy, droppedBySeverity };
}

router.get("/intelligence/events", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const policy = await loadPolicy(orgId);
  let hours = Math.min(
    Math.max(parseInt(String(req.query["hours"] ?? "72"), 10) || 72, 1),
    720,
  );
  const limit = Math.min(
    Math.max(parseInt(String(req.query["limit"] ?? "200"), 10) || 200, 1),
    500,
  );
  const severityMinRaw = Number(req.query["severityMin"] ?? "0.7");
  const severityMin = Number.isFinite(severityMinRaw)
    ? Math.min(Math.max(severityMinRaw, 0), 1)
    : 0.7;
  const cycleId = readStringQuery(req.query["cycleId"]);

  // Optional cycleId preload: when the OODA cycle card cross-links into
  // the war room we widen `hours` to span that cycle's window so the
  // user lands on the events that drove the cycle's outcomes instead
  // of the default 72h tail. Strict tenant check — a cycleId from a
  // different tenant is silently ignored (no info leak via 404).
  let cycleWindow: { startedAt: Date; completedAt: Date | null } | null = null;
  if (cycleId) {
    const [c] = await db
      .select({
        startedAt: analysisCyclesTable.startedAt,
        completedAt: analysisCyclesTable.completedAt,
      })
      .from(analysisCyclesTable)
      .where(
        and(
          eq(analysisCyclesTable.id, cycleId),
          eq(analysisCyclesTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (c) {
      cycleWindow = { startedAt: c.startedAt, completedAt: c.completedAt };
      const endMs = (c.completedAt ?? new Date()).getTime();
      const spanHrs = Math.ceil(
        (endMs - c.startedAt.getTime()) / (3600 * 1000),
      );
      hours = Math.min(Math.max(spanHrs, 1), 720);
    }
  }

  const since = cycleWindow
    ? cycleWindow.startedAt
    : new Date(Date.now() - hours * 3600 * 1000);
  const until = cycleWindow?.completedAt ?? null;

  const baseConds: SQL[] = [
    tenantScopeCondition(orgId),
    inArray(marketSignalsTable.signalType, [...EVENT_SIGNAL_TYPES]),
    gte(marketSignalsTable.observedAt, since),
  ];
  if (until) {
    baseConds.push(sql`${marketSignalsTable.observedAt} <= ${until}`);
  }

  const rows = await db
    .select()
    .from(marketSignalsTable)
    .where(and(...baseConds))
    .orderBy(desc(marketSignalsTable.observedAt))
    .limit(limit * 4);

  const materialised = await materialiseEventRows(orgId, rows, policy, {
    severityMin,
  });
  const items = materialised.items.slice(0, limit);
  const droppedByPolicy = materialised.droppedByPolicy;
  const droppedBySeverity = materialised.droppedBySeverity;

  req.log.info(
    {
      orgId,
      returned: items.length,
      droppedByPolicy,
      droppedBySeverity,
      hours,
      cycleId: cycleId ?? null,
      policy,
    },
    "intelligence.events.served",
  );

  res.json({
    items,
    generatedAt: new Date().toISOString(),
    policy,
    droppedByPolicy,
  });
});

// ---------------------------------------------------------------------
// GET /intelligence/events/stream  — Server-Sent Events live push
// ---------------------------------------------------------------------
//
// Browsers cannot attach custom headers to an `EventSource`, so we let
// the client pass `?orgId=` and shim it onto the `x-org-id` header
// before `tenantMiddleware` runs. Auth itself still flows through the
// session/bearer paths the middleware enforces — the query param only
// chooses *which* of the user's tenants this stream should scope to.
router.get(
  "/intelligence/events/stream",
  (req, _res, next) => {
    if (
      !req.header("x-org-id") &&
      typeof req.query["orgId"] === "string" &&
      req.query["orgId"].length > 0
    ) {
      req.headers["x-org-id"] = req.query["orgId"];
    }
    next();
  },
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const policy = await loadPolicy(orgId);
    const severityMinRaw = Number(req.query["severityMin"] ?? "0.7");
    const severityMin = Number.isFinite(severityMinRaw)
      ? Math.min(Math.max(severityMinRaw, 0), 1)
      : 0.7;

    // SSE response framing. `X-Accel-Buffering: no` keeps reverse
    // proxies (Nginx, the Replit shared proxy) from holding bytes back
    // until a 4 KiB chunk fills.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`: connected ${new Date().toISOString()}\n\n`);

    // Heartbeat every 25s so any intermediary that drops idle TCP
    // connections at 30s keeps this one alive. SSE comments
    // (`: anything\n\n`) are ignored by the EventSource parser.
    const heartbeat = setInterval(() => {
      res.write(": ping\n\n");
    }, 25_000);

    const unsubscribe = subscribeMarketSignalIds(async ({ ids }) => {
      try {
        // Re-fetch under the tenant scope so we never leak rows the
        // requester wouldn't normally see via the GET endpoint, and so
        // non-event signal types from the same publish batch are
        // filtered out at the database level.
        const rows = await db
          .select()
          .from(marketSignalsTable)
          .where(
            and(
              tenantScopeCondition(orgId),
              inArray(marketSignalsTable.signalType, [...EVENT_SIGNAL_TYPES]),
              inArray(marketSignalsTable.id, ids),
            ),
          );
        if (rows.length === 0) return;
        const { items } = await materialiseEventRows(orgId, rows, policy, {
          severityMin,
        });
        for (const it of items) {
          res.write(`event: signal\ndata: ${JSON.stringify(it)}\n\n`);
        }
      } catch (err) {
        req.log.warn(
          { err: (err as Error).message, orgId },
          "intelligence.events.stream.publish_failed",
        );
      }
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);

    req.log.info({ orgId, policy }, "intelligence.events.stream.opened");
  },
);

/**
 * Country centroid lookup used to place "site" map points.
 *
 * v1 ships a small ISO-2 → (lat, lng) table for the most common
 * supplier countries. Returns null for codes we don't carry — the UI
 * will then drop the point onto the country band on the heatmap
 * instead. A future revision will swap this for a dedicated `sites`
 * table with real coordinates per facility.
 */
function countryCentroid(
  iso2: string,
): { lat: number; lng: number } | null {
  const c = iso2.toUpperCase();
  const M: Record<string, [number, number]> = {
    US: [39.8, -98.6],
    CA: [56.1, -106.3],
    MX: [23.6, -102.5],
    BR: [-14.2, -51.9],
    DE: [51.2, 10.4],
    FR: [46.2, 2.2],
    GB: [54.0, -2.0],
    IE: [53.4, -8.2],
    NL: [52.1, 5.3],
    ES: [40.5, -3.7],
    IT: [41.9, 12.6],
    PL: [52.0, 19.1],
    SE: [60.1, 18.6],
    CH: [46.8, 8.2],
    CN: [35.9, 104.2],
    JP: [36.2, 138.3],
    KR: [35.9, 127.8],
    IN: [20.6, 78.9],
    SG: [1.4, 103.8],
    TW: [23.7, 120.9],
    TH: [15.9, 100.9],
    VN: [14.1, 108.3],
    MY: [4.2, 101.9],
    ID: [-0.8, 113.9],
    PH: [12.9, 121.8],
    AU: [-25.3, 133.8],
    NZ: [-40.9, 174.9],
    ZA: [-30.6, 22.9],
    AE: [23.4, 53.8],
    SA: [23.9, 45.1],
    TR: [38.9, 35.2],
    IL: [31.0, 34.9],
  };
  const hit = M[c];
  return hit ? { lat: hit[0], lng: hit[1] } : null;
}

function readNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function readString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------
// GET /intelligence/coverage-gaps  — Spend-weighted blind spots
// ---------------------------------------------------------------------

router.get(
  "/intelligence/coverage-gaps",
  tenantMiddleware,
  async (req, res) => {
    const orgId = requireOrgId(req);
    const lookbackDays = Math.min(
      Math.max(
        parseInt(String(req.query["lookbackDays"] ?? "90"), 10) || 90,
        1,
      ),
      365,
    );

    // Top suppliers by spend with their signal counts in the window.
    const supplierRows = await db.execute(sql`
      WITH spend AS (
        SELECT s.id AS supplier_id,
               s.name AS supplier_name,
               s.country_code AS country,
               COALESCE(SUM(po.total_usd::numeric), 0) AS spend_usd
        FROM suppliers s
        LEFT JOIN purchase_orders po
          ON po.supplier_id = s.id
         AND po.org_id = ${orgId}
         AND po.order_date >= NOW() - (${lookbackDays} || ' days')::interval
        WHERE s.org_id = ${orgId}
        GROUP BY s.id, s.name, s.country_code
      ),
      sigs AS (
        SELECT scope_supplier_name,
               COUNT(*) AS signal_count,
               MAX(observed_at) AS last_signal_at
        FROM market_signals
        WHERE (org_id = ${orgId} OR org_id IS NULL)
          AND scope_supplier_name IS NOT NULL
          AND observed_at >= NOW() - (${lookbackDays} || ' days')::interval
        GROUP BY scope_supplier_name
      )
      SELECT spend.supplier_id,
             spend.supplier_name,
             spend.country,
             spend.spend_usd,
             COALESCE(sigs.signal_count, 0) AS signal_count,
             sigs.last_signal_at
      FROM spend
      LEFT JOIN sigs ON sigs.scope_supplier_name = spend.supplier_name
      WHERE spend.spend_usd > 0
      ORDER BY spend.spend_usd DESC
      LIMIT 25
    `);

    const categoryRows = await db.execute(sql`
      WITH spend AS (
        SELECT cat.id AS category_id,
               cat.code AS category_code,
               cat.name AS category_name,
               COALESCE(SUM(pol.extended_usd::numeric), 0) AS spend_usd
        FROM categories cat
        LEFT JOIN po_lines pol
          ON pol.category_id = cat.id
         AND pol.org_id = ${orgId}
         AND pol.order_date >= NOW() - (${lookbackDays} || ' days')::interval
        WHERE cat.org_id = ${orgId}
        GROUP BY cat.id, cat.code, cat.name
      ),
      sigs AS (
        SELECT scope_category_code,
               COUNT(*) AS signal_count,
               MAX(observed_at) AS last_signal_at
        FROM market_signals
        WHERE (org_id = ${orgId} OR org_id IS NULL)
          AND scope_category_code IS NOT NULL
          AND observed_at >= NOW() - (${lookbackDays} || ' days')::interval
        GROUP BY scope_category_code
      )
      SELECT spend.category_id,
             spend.category_code,
             spend.category_name,
             spend.spend_usd,
             COALESCE(sigs.signal_count, 0) AS signal_count,
             sigs.last_signal_at
      FROM spend
      LEFT JOIN sigs ON sigs.scope_category_code = spend.category_code
      WHERE spend.spend_usd > 0
      ORDER BY spend.spend_usd DESC
      LIMIT 25
    `);

    /** Bucket a (spend, coverage) pair into a severity label. */
    function bucket(
      spend: number,
      signals: number,
    ): "critical" | "high" | "medium" | "low" {
      if (signals === 0 && spend > 1_000_000) return "critical";
      if (signals < 3 && spend > 500_000) return "high";
      if (signals < 10 && spend > 100_000) return "medium";
      return "low";
    }

    const items: Array<{
      scopeKind: "supplier" | "category" | "material";
      scopeId: string | null;
      scopeLabel: string;
      scopeCode: string | null;
      country: string | null;
      recentSpend: number;
      signalCount: number;
      lastSignalAt: string | null;
      severity: "critical" | "high" | "medium" | "low";
      recommendedCollectors: string[];
    }> = [];

    for (const r of supplierRows.rows as Array<{
      supplier_id: string;
      supplier_name: string;
      country: string | null;
      spend_usd: string;
      signal_count: string;
      last_signal_at: string | null;
    }>) {
      const spend = Number(r.spend_usd);
      const sigCount = Number(r.signal_count);
      items.push({
        scopeKind: "supplier",
        scopeId: r.supplier_id,
        scopeLabel: r.supplier_name,
        scopeCode: null,
        country: r.country,
        recentSpend: spend,
        signalCount: sigCount,
        lastSignalAt: r.last_signal_at,
        severity: bucket(spend, sigCount),
        recommendedCollectors: recommendCollectors("supplier"),
      });
    }
    for (const r of categoryRows.rows as Array<{
      category_id: string;
      category_code: string;
      category_name: string;
      spend_usd: string;
      signal_count: string;
      last_signal_at: string | null;
    }>) {
      const spend = Number(r.spend_usd);
      const sigCount = Number(r.signal_count);
      items.push({
        scopeKind: "category",
        scopeId: r.category_id,
        scopeLabel: r.category_name,
        scopeCode: r.category_code,
        country: null,
        recentSpend: spend,
        signalCount: sigCount,
        lastSignalAt: r.last_signal_at,
        severity: bucket(spend, sigCount),
        recommendedCollectors: recommendCollectors("category"),
      });
    }

    // Sort by severity-then-spend so the worst gaps surface first.
    const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;
    items.sort((a, b) => {
      const r = SEV_RANK[b.severity] - SEV_RANK[a.severity];
      return r !== 0 ? r : b.recentSpend - a.recentSpend;
    });

    req.log.info(
      { orgId, items: items.length, lookbackDays },
      "intelligence.coverage-gaps.served",
    );

    res.json({
      items,
      lookbackDays,
      generatedAt: new Date().toISOString(),
    });
  },
);

/**
 * Heuristic "which collectors would close this gap?" lookup. Walks the
 * registered in-process collector contracts and returns the ids whose
 * `scopeKinds` overlap the requested entity kind, capped to keep the
 * response light.
 *
 * Currently this short-list is hard-coded to a couple of safe-by-default
 * defaults per kind; we'd swap in a registry walk once the catalogued
 * `scopeKinds` are wired into a runtime API.
 */
function recommendCollectors(kind: "supplier" | "category" | "material"): string[] {
  if (kind === "supplier") {
    return ["sec-edgar", "opensanctions", "gleif-lei", "companies-house"];
  }
  if (kind === "category") {
    return ["world-bank-pink-sheet", "fred-economic-index", "bls-economic-index"];
  }
  return ["world-bank-pink-sheet", "fred-economic-index"];
}

export default router;
