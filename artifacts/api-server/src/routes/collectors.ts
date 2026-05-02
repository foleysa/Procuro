import { Router, type IRouter } from "express";
import {
  db,
  collectorsTable,
  collectorAuditLogTable,
  collectorTenantOptInsTable,
  marketSignalSchemaDriftTable,
  marketSignalsTable,
  suppliersTable,
  categoriesTable,
  orgsTable,
} from "@workspace/db";
import {
  getCollectorCostsFromBq,
  getCollectorCostsFromBilling,
} from "@workspace/intelligence";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { tenantMiddleware } from "../lib/tenant";
import { requirePlatformAdmin } from "../lib/platform-admin";
import {
  runCollector,
  getCollector,
  listRegisteredCollectorIds,
  setKillSwitch,
  approveCollector,
  disableCollector,
  setRateLimit,
  upsertCollectorRegistration,
  listCollectorAudit,
  runEcbFxRatesBackfill,
  runFredEconomicIndexBackfill,
  runSecEdgarBackfill,
  runOpenSanctionsBackfill,
  runGleifLeiBackfill,
  runClimateTraceBackfill,
  runCompaniesHouseBackfill,
} from "../lib/intelligence/runtime";
import { ECB_FX_RATES_COLLECTOR_ID } from "../lib/intelligence/collectors/ecb-fx-rates";
import { FRED_ECONOMIC_INDEX_COLLECTOR_ID } from "../lib/intelligence/collectors/fred-economic-index";
import { SEC_EDGAR_COLLECTOR_ID } from "../lib/intelligence/collectors/sec-edgar";
import { OPENSANCTIONS_COLLECTOR_ID } from "../lib/intelligence/collectors/opensanctions";
import { GLEIF_LEI_COLLECTOR_ID } from "../lib/intelligence/collectors/gleif-lei";
import { CLIMATE_TRACE_COLLECTOR_ID } from "../lib/intelligence/collectors/climate-trace";
import { COMPANIES_HOUSE_COLLECTOR_ID } from "../lib/intelligence/collectors/companies-house";
import { getWorkbenchMeta } from "../lib/intelligence/workbench-meta";
import {
  buildLineageGraph,
  classifyDataSourceVisibility,
  computeHealthScore,
  resolvePostureClass,
} from "../lib/intelligence/workbench-helpers";
import { z } from "zod";

const router: IRouter = Router();

const collectionPostureEnum = z.enum([
  "public-api",
  "published-data",
  "respect-robots-crawl",
  "aggressive-crawl",
]);

const RegisterCollectorSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  posture: collectionPostureEnum,
  owner: z.string().min(1).max(200),
  sourceUrl: z.string().url(),
  rateLimitRpm: z.number().int().min(1).max(10000).optional(),
  scheduleCron: z.string().max(120).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const PatchCollectorSchema = z.object({
  status: z.enum(["draft", "approved", "killed", "rejected"]).optional(),
  rateLimitRpm: z.number().int().min(1).max(10000).optional(),
  scheduleCron: z.string().max(120).nullable().optional(),
});

/**
 * Resolve the per-tenant opt-in matrix for the active org. Falls back
 * to the registered collector's `tenantOptInDefault` when there is no
 * explicit override row. Returns a Map<collectorId, boolean>.
 */
async function loadTenantOptIns(
  orgId: string | undefined,
): Promise<Map<string, boolean>> {
  if (!orgId) return new Map();
  const rows = await db
    .select({
      collectorId: collectorTenantOptInsTable.collectorId,
      optedIn: collectorTenantOptInsTable.optedIn,
    })
    .from(collectorTenantOptInsTable)
    .where(eq(collectorTenantOptInsTable.orgId, orgId));
  return new Map(rows.map((r) => [r.collectorId, r.optedIn === 1]));
}

/**
 * How many of the most-recent successful runs we look back at to decide
 * whether a collector is "stalled" — i.e. running cleanly but only
 * re-seeing yesterday's observations. If the last N successes all have
 * `inserted === 0`, we surface a `staleEmptyRuns: true` flag so the
 * Registry page can render a warning chip. 3 is the smallest window
 * that still distinguishes a single duplicate run (very common on
 * weekend feeds) from a genuinely stalled upstream.
 */
const STALE_RUN_WINDOW = 3;

/**
 * Pull the most-recent `fetch_succeeded` audit row per collector and
 * extract the runtime-recorded `inserted` / `duplicates` counts so the
 * Registry page can show operators whether the last run actually
 * landed any new data. We also compute a `staleEmptyRuns` flag from
 * the last `STALE_RUN_WINDOW` successes; when every one of them
 * inserted zero new rows the upstream is almost certainly stalled.
 *
 * One DB round-trip with a `row_number()` window keeps this cheap
 * regardless of how many runs each collector has accumulated.
 */
async function loadLastRunMetricsByCollector(): Promise<
  Map<
    string,
    {
      lastRunAt: Date;
      lastInsertedCount: number;
      lastDuplicateCount: number;
      staleEmptyRuns: boolean;
    }
  >
> {
  const result = await db.execute(sql`
    SELECT collector_id, created_at, metadata, rn
    FROM (
      SELECT
        collector_id,
        created_at,
        metadata,
        ROW_NUMBER() OVER (PARTITION BY collector_id ORDER BY created_at DESC) AS rn
      FROM collector_audit_log
      WHERE event = 'fetch_succeeded'
    ) ranked
    WHERE rn <= ${STALE_RUN_WINDOW}
  `);
  const rows = result.rows as Array<{
    collector_id: string;
    created_at: Date | string;
    metadata: unknown;
    rn: number;
  }>;
  const grouped = new Map<
    string,
    Array<{ createdAt: Date; inserted: number; duplicates: number }>
  >();
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const inserted = Number(meta["inserted"] ?? 0);
    const duplicates = Number(meta["duplicates"] ?? 0);
    // pg returns timestamptz columns as Date objects, but SQL helpers
    // can return ISO strings depending on the driver — normalize so the
    // sort comparator below always has a Date.
    const createdAt =
      r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
    const list = grouped.get(r.collector_id) ?? [];
    list.push({
      createdAt,
      inserted: Number.isFinite(inserted) ? inserted : 0,
      duplicates: Number.isFinite(duplicates) ? duplicates : 0,
    });
    grouped.set(r.collector_id, list);
  }
  const out = new Map<
    string,
    {
      lastRunAt: Date;
      lastInsertedCount: number;
      lastDuplicateCount: number;
      staleEmptyRuns: boolean;
    }
  >();
  for (const [collectorId, runs] of grouped) {
    // Window query already returns DESC, but sort defensively.
    runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latest = runs[0]!;
    // Only flag stale when we have a full window of successes to look
    // at — a single duplicate run is normal (weekend FX, untouched
    // filings), so demanding STALE_RUN_WINDOW data points keeps the
    // chip from over-firing on freshly-approved collectors.
    const staleEmptyRuns =
      runs.length >= STALE_RUN_WINDOW && runs.every((r) => r.inserted === 0);
    out.set(collectorId, {
      lastRunAt: latest.createdAt,
      lastInsertedCount: latest.inserted,
      lastDuplicateCount: latest.duplicates,
      staleEmptyRuns,
    });
  }
  return out;
}

router.get("/collectors", tenantMiddleware, async (req, res) => {
  const dbRows = await db
    .select()
    .from(collectorsTable)
    .orderBy(asc(collectorsTable.name));
  const tenantOptIns = await loadTenantOptIns(req.orgId);
  const lastRunMetrics = await loadLastRunMetricsByCollector();
  const resolveOptIn = (id: string, defaultOptIn: boolean | null): boolean | null =>
    tenantOptIns.has(id) ? (tenantOptIns.get(id) ?? defaultOptIn) : defaultOptIn;
  const items = dbRows.map((r) => {
    const reg = getCollector(r.id);
    const meta = getWorkbenchMeta(r.id);
    const tenantOptInDefault = reg?.tenantOptInDefault ?? null;
    const metrics = lastRunMetrics.get(r.id);
    return {
      id: r.id,
      name: r.name,
      description: reg?.description ?? r.description ?? "",
      posture: r.posture,
      status:
        r.killSwitch === 1
          ? "killed"
          : r.status === "approved"
            ? "enabled"
            : "disabled",
      registryStatus: r.status,
      killSwitch: r.killSwitch === 1,
      sourceUrl: reg?.sourceUrl ?? r.sourceUrl ?? null,
      rateLimitRpm: r.rateLimitRpm,
      defaultRateLimitRpm: reg?.defaultRateLimitRpm ?? r.rateLimitRpm ?? null,
      defaultScheduleCron: reg?.defaultScheduleCron ?? r.scheduleCron ?? null,
      owner: r.owner,
      lastRunAt: metrics?.lastRunAt ?? null,
      // `lastSignalCount` was the original "rows landed last run" field —
      // we keep it populated (mirroring `lastInsertedCount`) so any
      // older client still rendering it doesn't silently break, and
      // additionally surface the explicit new/duplicate split below.
      lastSignalCount: metrics?.lastInsertedCount ?? null,
      lastInsertedCount: metrics?.lastInsertedCount ?? null,
      lastDuplicateCount: metrics?.lastDuplicateCount ?? null,
      staleEmptyRuns: metrics?.staleEmptyRuns ?? false,
      postureClass: reg ? resolvePostureClass(reg) : "tos_restricted",
      disclosureTier: reg?.disclosureTier ?? "T1",
      jurisdiction: reg?.jurisdiction ?? "GLOBAL",
      flagEmoji: meta.flagEmoji,
      retentionDays: reg?.retentionDays ?? null,
      tenantOptInDefault,
      tenantOptedIn: resolveOptIn(r.id, tenantOptInDefault),
    };
  });
  const have = new Set(items.map((i) => i.id));
  for (const id of listRegisteredCollectorIds()) {
    if (have.has(id)) continue;
    const reg = getCollector(id)!;
    const meta = getWorkbenchMeta(id);
    const tenantOptInDefault = reg.tenantOptInDefault ?? null;
    const metrics = lastRunMetrics.get(id);
    items.push({
      id,
      name: reg.name,
      description: reg.description,
      posture: reg.posture,
      status: "disabled",
      registryStatus: "draft",
      killSwitch: false,
      sourceUrl: reg.sourceUrl,
      rateLimitRpm: reg.defaultRateLimitRpm,
      defaultRateLimitRpm: reg.defaultRateLimitRpm,
      defaultScheduleCron: reg.defaultScheduleCron,
      owner: "platform",
      lastRunAt: metrics?.lastRunAt ?? null,
      lastSignalCount: metrics?.lastInsertedCount ?? null,
      lastInsertedCount: metrics?.lastInsertedCount ?? null,
      lastDuplicateCount: metrics?.lastDuplicateCount ?? null,
      staleEmptyRuns: metrics?.staleEmptyRuns ?? false,
      postureClass: resolvePostureClass(reg),
      disclosureTier: reg.disclosureTier ?? "T1",
      jurisdiction: reg.jurisdiction ?? "GLOBAL",
      flagEmoji: meta.flagEmoji,
      retentionDays: reg.retentionDays ?? null,
      tenantOptInDefault,
      tenantOptedIn: resolveOptIn(id, tenantOptInDefault),
    });
  }
  res.json(items);
});

router.post("/collectors", requirePlatformAdmin, async (req, res) => {
  // Throw on invalid input and let the global error handler shape the
  // 400 response (`{ error, details }`). See global-error-handler.ts.
  const data = RegisterCollectorSchema.parse(req.body);
  const actor = req.actorEmail ?? "system@procuro.ai";
  const row = await upsertCollectorRegistration({ ...data, actor });
  res.status(201).json({ id: row.id, status: row.status });
});

router.patch("/collectors/:id", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  // Throw on invalid input and let the global error handler shape the
  // 400 response (`{ error, details }`). See global-error-handler.ts.
  const data = PatchCollectorSchema.parse(req.body);
  const actor = req.actorEmail ?? "system@procuro.ai";

  const [current] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, id));
  if (!current) {
    res.status(404).json({ error: "Collector not found" });
    return;
  }

  let updated = current;
  if (data.status === "approved") {
    updated = (await approveCollector(id, actor)) ?? updated;
  } else if (data.status === "rejected" || data.status === "draft") {
    updated = (await disableCollector(id, actor, data.status)) ?? updated;
  }
  if (typeof data.rateLimitRpm === "number") {
    updated = (await setRateLimit(id, data.rateLimitRpm, actor)) ?? updated;
  }
  if (data.scheduleCron !== undefined) {
    const [row] = await db
      .update(collectorsTable)
      .set({ scheduleCron: data.scheduleCron })
      .where(eq(collectorsTable.id, id))
      .returning();
    if (row) updated = row;
    await db.insert(collectorAuditLogTable).values({
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      collectorId: id,
      event: "schedule_set",
      metadata: { actor, cron: data.scheduleCron },
    });
  }
  res.json({ id: updated.id, status: updated.status, killSwitch: updated.killSwitch === 1, rateLimitRpm: updated.rateLimitRpm });
});

router.post("/collectors/:id/kill", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  const actor = req.actorEmail ?? "system@procuro.ai";
  const row = await setKillSwitch(id, true, actor);
  if (!row) {
    res.status(404).json({ error: "Collector not found" });
    return;
  }
  res.json({ id: row.id, killSwitch: true });
});

router.post("/collectors/:id/unkill", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  const actor = req.actorEmail ?? "system@procuro.ai";
  const row = await setKillSwitch(id, false, actor);
  if (!row) {
    res.status(404).json({ error: "Collector not found" });
    return;
  }
  res.json({ id: row.id, killSwitch: false });
});

router.get("/collectors/:id/audit", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  const limit = Math.min(
    Math.max(parseInt((req.query["limit"] as string) ?? "100", 10) || 100, 1),
    500,
  );
  const rows = await listCollectorAudit(id, limit);
  res.json(
    rows.map((r) => ({
      id: r.id,
      collectorId: r.collectorId,
      event: r.event,
      targetUrl: r.targetUrl,
      statusCode: r.statusCode,
      error: r.error,
      metadata: r.metadata ?? {},
      createdAt: r.createdAt,
    })),
  );
});

router.post(
  "/collectors/ecb-fx-rates/backfill",
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const result = await runEcbFxRatesBackfill();
      res.json({
        collectorId: result.collectorId,
        daysWritten: result.daysWritten,
        signalsInserted: result.signalsInserted,
        signalsSkipped: result.signalsSkipped,
        durationMs: result.durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Map common preflight errors back to the caller (kill switch / not approved)
      // so the System page can surface a useful toast instead of a 500.
      if (
        message.includes("kill switch") ||
        message.includes("approved") ||
        message.includes("approve")
      ) {
        res.status(409).json({ error: message, collectorId: ECB_FX_RATES_COLLECTOR_ID });
        return;
      }
      throw err;
    }
  },
);

router.post(
  "/collectors/fred-economic-index/backfill",
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const result = await runFredEconomicIndexBackfill();
      res.json({
        collectorId: result.collectorId,
        daysWritten: result.daysWritten,
        signalsInserted: result.signalsInserted,
        signalsSkipped: result.signalsSkipped,
        durationMs: result.durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Same shape as the ECB backfill: surface preflight gates as 409 so
      // the System page can show a clear toast instead of a 500.
      if (
        message.includes("kill switch") ||
        message.includes("approved") ||
        message.includes("approve") ||
        message.includes("FRED_API_KEY")
      ) {
        res
          .status(409)
          .json({ error: message, collectorId: FRED_ECONOMIC_INDEX_COLLECTOR_ID });
        return;
      }
      throw err;
    }
  },
);

/**
 * Generic backfill endpoint factory — every Phase 2 collector that
 * supports historical replay (EDGAR, OpenSanctions, GLEIF, ClimateTRACE,
 * Companies House) shares the same response shape and the same
 * preflight error handling (kill switch / not-approved / missing API
 * key all map to 409). Avoids the copy-pasted block we had for ECB +
 * FRED.
 */
function mountBackfillRoute<TOpts extends { force?: boolean }>(
  path: string,
  collectorId: string,
  run: (opts: TOpts) => Promise<{
    collectorId: string;
    daysWritten: number;
    signalsInserted: number;
    signalsSkipped: number;
    durationMs: number;
  }>,
  parseBody: (req: { body?: unknown }) => TOpts,
): void {
  router.post(path, requirePlatformAdmin, async (req, res) => {
    try {
      const opts = parseBody(req);
      const result = await run(opts);
      res.json({
        collectorId: result.collectorId,
        daysWritten: result.daysWritten,
        signalsInserted: result.signalsInserted,
        signalsSkipped: result.signalsSkipped,
        durationMs: result.durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("kill switch") ||
        message.includes("approved") ||
        message.includes("approve") ||
        message.includes("API_KEY") ||
        message.includes("USER_AGENT")
      ) {
        res.status(409).json({ error: message, collectorId });
        return;
      }
      throw err;
    }
  });
}

const SecEdgarBackfillSchema = z
  .object({
    force: z.boolean().optional(),
    issuers: z
      .array(
        z.object({
          cik: z.string().min(1),
          name: z.string().min(1),
          lei: z.string().optional(),
          ticker: z.string().optional(),
        }),
      )
      .optional(),
  })
  .optional();

mountBackfillRoute(
  "/collectors/sec-edgar/backfill",
  SEC_EDGAR_COLLECTOR_ID,
  runSecEdgarBackfill,
  (req) => SecEdgarBackfillSchema.parse(req.body) ?? {},
);

const OpenSanctionsBackfillSchema = z
  .object({
    force: z.boolean().optional(),
    cap: z.number().int().positive().max(2_000_000).optional(),
  })
  .optional();

mountBackfillRoute(
  "/collectors/opensanctions/backfill",
  OPENSANCTIONS_COLLECTOR_ID,
  runOpenSanctionsBackfill,
  (req) => OpenSanctionsBackfillSchema.parse(req.body) ?? {},
);

const GleifBackfillSchema = z
  .object({
    force: z.boolean().optional(),
    maxPages: z.number().int().positive().max(500).optional(),
    pageSize: z.number().int().positive().max(200).optional(),
  })
  .optional();

mountBackfillRoute(
  "/collectors/gleif-lei/backfill",
  GLEIF_LEI_COLLECTOR_ID,
  runGleifLeiBackfill,
  (req) => GleifBackfillSchema.parse(req.body) ?? {},
);

const ClimateTraceBackfillSchema = z
  .object({
    force: z.boolean().optional(),
    maxPages: z.number().int().positive().max(100).optional(),
    pageSize: z.number().int().positive().max(500).optional(),
    sector: z.string().min(1).max(120).optional(),
    country: z.string().min(2).max(120).optional(),
  })
  .optional();

mountBackfillRoute(
  "/collectors/climate-trace/backfill",
  CLIMATE_TRACE_COLLECTOR_ID,
  runClimateTraceBackfill,
  (req) => ClimateTraceBackfillSchema.parse(req.body) ?? {},
);

const CompaniesHouseBackfillSchema = z
  .object({
    force: z.boolean().optional(),
    numbers: z.array(z.string().min(1).max(20)).max(500).optional(),
  })
  .optional();

mountBackfillRoute(
  "/collectors/companies-house/backfill",
  COMPANIES_HOUSE_COLLECTOR_ID,
  runCompaniesHouseBackfill,
  (req) => CompaniesHouseBackfillSchema.parse(req.body) ?? {},
);

/**
 * Resolve the run-mode for `POST /collectors/:id/run` from its raw
 * query string. Exported so the route's contract — only `?backfill=true`
 * (case-sensitive, exactly the literal string) opts into backfill mode,
 * everything else falls back to `"latest"` — can be pinned by a focused
 * unit test without spinning up a full HTTP server.
 *
 * Express's `req.query` value is `string | string[] | ParsedQs | undefined`;
 * accepting `unknown` keeps the helper test-friendly and avoids leaking
 * Express's qs typing through to callers.
 */
export function resolveRunCollectorMode(
  rawBackfill: unknown,
): "latest" | "backfill" {
  return String(rawBackfill ?? "") === "true" ? "backfill" : "latest";
}

router.post("/collectors/:id/run", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  // `?backfill=true` flips the collector into history-replay mode for
  // this single run. Collectors that support it (e.g. BLS PPI/CPI/ECI)
  // emit a wider observation window so the trend-chart UI has history
  // to plot; collectors that don't differentiate ignore the flag. The
  // natural-key dedupe makes the wider write idempotent across re-runs.
  const mode = resolveRunCollectorMode(req.query["backfill"]);
  const result = await runCollector(
    id,
    mode === "backfill" ? { mode: "backfill" } : {},
  );
  res.json({
    collectorId: id,
    mode,
    signalsWritten: result.signalsCollected,
    durationMs: result.durationMs,
    skipped: result.skipped !== undefined,
    skipReason: result.skipped,
  });
});

// -------- Collector Workbench endpoints --------------------------------
//
// These power the new operator workbench tabs (Catalog, Source Health,
// Lineage, Coverage, Cost, Runs & Errors) and the client-facing
// `/data-sources` view. Posture-edit is the only mutating endpoint;
// everything else is read-only.

const PatchCollectorPostureSchema = z.object({
  notes: z.string().max(5000).nullable().optional(),
  tenantOptedIn: z.boolean().nullable().optional(),
});

/**
 * Read the posture summary for a single collector. Mirrors the shape
 * returned by PATCH /collectors/:id/posture so the workbench Posture
 * tab can prefill the form (and any other tab can reuse the
 * resolution) without round-tripping through /collectors. Tenant
 * membership is required because the response includes the per-tenant
 * `tenantOptedIn` resolution; admin gating is not — analysts read.
 */
router.get(
  "/collectors/:id/posture",
  tenantMiddleware,
  async (req, res) => {
    const id = String(req.params.id);
    const [current] = await db
      .select()
      .from(collectorsTable)
      .where(eq(collectorsTable.id, id));
    if (!current) {
      res.status(404).json({ error: "Collector not found" });
      return;
    }
    const reg = getCollector(id);
    const tenantOptInDefault = reg?.tenantOptInDefault ?? null;
    let resolvedOptIn: boolean | null = tenantOptInDefault;
    if (req.orgId) {
      const [row] = await db
        .select({ optedIn: collectorTenantOptInsTable.optedIn })
        .from(collectorTenantOptInsTable)
        .where(
          and(
            eq(collectorTenantOptInsTable.orgId, req.orgId),
            eq(collectorTenantOptInsTable.collectorId, id),
          ),
        );
      if (row) resolvedOptIn = row.optedIn === 1;
    }
    res.json({
      id: current.id,
      notes: current.notes ?? null,
      postureClass: reg ? resolvePostureClass(reg) : "tos_restricted",
      disclosureTier: reg?.disclosureTier ?? "T1",
      jurisdiction: reg?.jurisdiction ?? "GLOBAL",
      retentionDays: reg?.retentionDays ?? null,
      tenantOptInDefault,
      tenantOptedIn: resolvedOptIn,
    });
  },
);

router.patch(
  "/collectors/:id/posture",
  // tenantMiddleware first so we resolve `req.orgId` for the per-tenant
  // opt-in upsert; requirePlatformAdmin then enforces the platform-admin
  // gate on the mutation.
  tenantMiddleware,
  requirePlatformAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const data = PatchCollectorPostureSchema.parse(req.body);
    const actor = req.actorEmail ?? "system@procuro.ai";

    const [current] = await db
      .select()
      .from(collectorsTable)
      .where(eq(collectorsTable.id, id));
    if (!current) {
      res.status(404).json({ error: "Collector not found" });
      return;
    }

    let updated = current;
    if (data.notes !== undefined) {
      const [row] = await db
        .update(collectorsTable)
        .set({ notes: data.notes })
        .where(eq(collectorsTable.id, id))
        .returning();
      if (row) updated = row;
      await db.insert(collectorAuditLogTable).values({
        id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        collectorId: id,
        event: "posture_notes_set",
        metadata: { actor, length: (data.notes ?? "").length },
      });
    }

    if (data.tenantOptedIn !== undefined && req.orgId) {
      if (data.tenantOptedIn === null) {
        // Null = restore the default — drop the override row entirely
        // so the resolution falls back to `tenantOptInDefault` again.
        await db
          .delete(collectorTenantOptInsTable)
          .where(
            and(
              eq(collectorTenantOptInsTable.orgId, req.orgId),
              eq(collectorTenantOptInsTable.collectorId, id),
            ),
          );
      } else {
        // Upsert the per-tenant opt-in. We store 1/0 so the table can
        // be ported to SQLite later without a boolean-to-int dance.
        await db
          .insert(collectorTenantOptInsTable)
          .values({
            id: `cto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
            orgId: req.orgId,
            collectorId: id,
            optedIn: data.tenantOptedIn ? 1 : 0,
            updatedBy: actor,
          })
          .onConflictDoUpdate({
            target: [
              collectorTenantOptInsTable.orgId,
              collectorTenantOptInsTable.collectorId,
            ],
            set: {
              optedIn: data.tenantOptedIn ? 1 : 0,
              updatedAt: new Date(),
              updatedBy: actor,
            },
          });
      }
      await db.insert(collectorAuditLogTable).values({
        id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        collectorId: id,
        event: "tenant_opt_in_set",
        metadata: {
          actor,
          orgId: req.orgId,
          tenantOptedIn: data.tenantOptedIn,
        },
      });
    }

    const reg = getCollector(id);
    const tenantOptInDefault = reg?.tenantOptInDefault ?? null;
    let resolvedOptIn: boolean | null = tenantOptInDefault;
    if (req.orgId) {
      const [row] = await db
        .select({ optedIn: collectorTenantOptInsTable.optedIn })
        .from(collectorTenantOptInsTable)
        .where(
          and(
            eq(collectorTenantOptInsTable.orgId, req.orgId),
            eq(collectorTenantOptInsTable.collectorId, id),
          ),
        );
      if (row) resolvedOptIn = row.optedIn === 1;
    }

    res.json({
      id: updated.id,
      notes: updated.notes ?? null,
      postureClass: reg ? resolvePostureClass(reg) : "tos_restricted",
      disclosureTier: reg?.disclosureTier ?? "T1",
      jurisdiction: reg?.jurisdiction ?? "GLOBAL",
      retentionDays: reg?.retentionDays ?? null,
      tenantOptInDefault,
      tenantOptedIn: resolvedOptIn,
    });
  },
);

const BroadcastPostureSchema = z.object({
  tenantOptedIn: z.boolean().nullable(),
  reason: z.string().max(1000).optional(),
});

/**
 * Platform-admin only: broadcast a per-tenant opt-in decision for a
 * collector to every org in one transaction. This is the right hammer
 * when an upstream source's posture changes (e.g. flips to
 * `tos_restricted`) and the platform team wants to force-opt-out every
 * tenant pending a re-review, rather than waiting on per-tenant action.
 *
 * Writes are wrapped in a single DB transaction so a partial broadcast
 * can't happen, and a `tenant_opt_in_broadcast` audit row is emitted
 * per affected tenant for forensic reconstruction. No `x-org-id` is
 * required since the action is, by definition, fleet-wide.
 */
router.post(
  "/admin/collectors/:id/broadcast-posture",
  requirePlatformAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const data = BroadcastPostureSchema.parse(req.body);
    const actor = req.actorEmail ?? "system@procuro.ai";

    const [current] = await db
      .select()
      .from(collectorsTable)
      .where(eq(collectorsTable.id, id));
    if (!current) {
      res.status(404).json({ error: "Collector not found" });
      return;
    }

    // Validate the broadcast value is consistent with the collector's
    // registered allowed set: the registry's `tenantOptInDefault` is
    // either `true`, `false`, or `null` (meaning the contract has no
    // opinion). All three are valid broadcast targets — there is no
    // deny list — but we still confirm the collector exists in the
    // in-memory registry so that operators can't broadcast posture
    // for a stale row that's already been removed from the contract.
    const reg = getCollector(id);
    if (!reg) {
      res.status(404).json({
        error: "Collector is not registered with the runtime",
      });
      return;
    }

    const orgs = await db.select({ id: orgsTable.id }).from(orgsTable);
    let tenantsAffected = 0;
    await db.transaction(async (tx) => {
      for (const org of orgs) {
        if (data.tenantOptedIn === null) {
          // Drop the per-tenant override so resolution falls back to
          // `tenantOptInDefault` again.
          const result = await tx
            .delete(collectorTenantOptInsTable)
            .where(
              and(
                eq(collectorTenantOptInsTable.orgId, org.id),
                eq(collectorTenantOptInsTable.collectorId, id),
              ),
            );
          // drizzle returns nothing useful for delete; treat as
          // "applied" so the audit row still fires for this org.
          void result;
        } else {
          await tx
            .insert(collectorTenantOptInsTable)
            .values({
              id: `cto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
              orgId: org.id,
              collectorId: id,
              optedIn: data.tenantOptedIn ? 1 : 0,
              updatedBy: actor,
            })
            .onConflictDoUpdate({
              target: [
                collectorTenantOptInsTable.orgId,
                collectorTenantOptInsTable.collectorId,
              ],
              set: {
                optedIn: data.tenantOptedIn ? 1 : 0,
                updatedAt: new Date(),
                updatedBy: actor,
              },
            });
        }
        await tx.insert(collectorAuditLogTable).values({
          id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${tenantsAffected}`,
          collectorId: id,
          event: "tenant_opt_in_broadcast",
          metadata: {
            actor,
            orgId: org.id,
            tenantOptedIn: data.tenantOptedIn,
            reason: data.reason ?? null,
          },
        });
        tenantsAffected += 1;
      }
    });

    req.log?.info(
      { collectorId: id, tenantsAffected, tenantOptedIn: data.tenantOptedIn, actor },
      "Broadcast collector posture across tenants",
    );

    res.json({
      id,
      tenantOptedIn: data.tenantOptedIn,
      tenantsAffected,
    });
  },
);

/**
 * Pre-confirmation preview for the broadcast posture action.
 *
 * The UI calls this when the operator opens the AlertDialog so it can
 * surface "this will affect N tenants — M are currently opted in,
 * K opted out, T have no override" *before* the irreversible button
 * click. Without this endpoint the count is only known after the
 * broadcast has already been written, which the audit trail records
 * but operators reasonably want to see in advance.
 *
 * Read-only — no DB writes, no audit rows.
 */
router.get(
  "/admin/collectors/:id/broadcast-posture/preview",
  requirePlatformAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const [current] = await db
      .select()
      .from(collectorsTable)
      .where(eq(collectorsTable.id, id));
    if (!current) {
      res.status(404).json({ error: "Collector not found" });
      return;
    }
    const reg = getCollector(id);
    if (!reg) {
      res.status(404).json({
        error: "Collector is not registered with the runtime",
      });
      return;
    }
    const orgs = await db.select({ id: orgsTable.id }).from(orgsTable);
    const overrides = await db
      .select({
        orgId: collectorTenantOptInsTable.orgId,
        optedIn: collectorTenantOptInsTable.optedIn,
      })
      .from(collectorTenantOptInsTable)
      .where(eq(collectorTenantOptInsTable.collectorId, id));
    const optedInOrgs = overrides.filter((o) => o.optedIn === 1).length;
    const optedOutOrgs = overrides.filter((o) => o.optedIn === 0).length;
    const noOverrideOrgs = orgs.length - overrides.length;
    res.json({
      id,
      tenantsTotal: orgs.length,
      currentOptedIn: optedInOrgs,
      currentOptedOut: optedOutOrgs,
      currentNoOverride: noOverrideOrgs,
      registryDefault: reg.tenantOptInDefault,
    });
  },
);

// -----------------------------------------------------------------------
// Workbench access policy:
//   * READ tabs (catalog, source-health, lineage, coverage, cost, runs):
//     any authenticated tenant member may read. The codebase has no
//     "analyst" role distinct from a tenant token; any tenant-scoped
//     auth is treated as analyst-level. Cross-tenant data leakage is
//     prevented at the query layer (see coverage handler below).
//   * WRITE / mutating endpoints (PATCH posture, kill, unkill, etc.):
//     gated by requirePlatformAdmin. These remain admin-only.
// -----------------------------------------------------------------------

router.get(
  "/collectors/workbench/catalog",
  tenantMiddleware,
  async (req, res) => {
    const dbRows = await db
      .select()
      .from(collectorsTable)
      .orderBy(asc(collectorsTable.name));
    const dbById = new Map(dbRows.map((r) => [r.id, r]));
    const tenantOptIns = await loadTenantOptIns(req.orgId);

    const ids = new Set([
      ...dbRows.map((r) => r.id),
      ...listRegisteredCollectorIds(),
    ]);

    const entries = Array.from(ids)
      .map((id) => {
        const reg = getCollector(id);
        // Catalog is intentionally limited to in-process collectors —
        // a registry row without an implementation has no posture
        // class to render and the workbench would mis-tier it.
        if (!reg) return null;
        const meta = getWorkbenchMeta(id);
        const r = dbById.get(id);
        const tenantOptInDefault = reg.tenantOptInDefault ?? null;
        const status: "enabled" | "disabled" | "killed" = !r
          ? "disabled"
          : r.killSwitch === 1
            ? "killed"
            : r.status === "approved"
              ? "enabled"
              : "disabled";
        return {
          id,
          name: reg.name,
          description: reg.description,
          status,
          posture: reg.posture,
          postureClass: resolvePostureClass(reg),
          disclosureTier: reg.disclosureTier ?? "T1",
          jurisdiction: reg.jurisdiction ?? "GLOBAL",
          flagEmoji: meta.flagEmoji,
          sourceUrl: reg.sourceUrl ?? null,
          tosUrl: meta.tosUrl,
          licenseNote: meta.licenseNote,
          logoUrl: meta.logoUrl,
          cadenceLabel: meta.cadenceLabel,
          retentionDays: reg.retentionDays ?? null,
          piiClassification: meta.piiClassification,
          outputSignalTypes: [...meta.outputSignalTypes],
          scopeKinds: [...meta.scopeKinds],
          rateLimitRpm: r?.rateLimitRpm ?? reg.defaultRateLimitRpm ?? null,
          scheduleCron: r?.scheduleCron ?? reg.defaultScheduleCron ?? null,
          tenantOptInDefault,
          tenantOptedIn: tenantOptIns.has(id)
            ? (tenantOptIns.get(id) ?? tenantOptInDefault)
            : tenantOptInDefault,
          lastRunAt: null,
          lastSignalCount: null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ entries });
  },
);

router.get(
  "/collectors/workbench/source-health",
  tenantMiddleware,
  async (req, res) => {
    const lookbackHours = Math.min(
      Math.max(
        parseInt((req.query["lookbackHours"] as string) ?? "168", 10) || 168,
        1,
      ),
      720,
    );
    const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

    const ids = listRegisteredCollectorIds();
    const dbRows = await db.select().from(collectorsTable);
    const dbById = new Map(dbRows.map((r) => [r.id, r]));

    // One query for all relevant audit rows in the lookback. Filtering
    // in JS rather than 6×n SQL queries keeps the round-trip count low.
    const auditRows = ids.length
      ? await db
          .select()
          .from(collectorAuditLogTable)
          .where(
            and(
              gte(collectorAuditLogTable.createdAt, since),
              inArray(collectorAuditLogTable.collectorId, ids),
            ),
          )
          .orderBy(desc(collectorAuditLogTable.createdAt))
      : [];

    const driftRows = ids.length
      ? await db
          .select()
          .from(marketSignalSchemaDriftTable)
          .where(
            and(
              gte(marketSignalSchemaDriftTable.createdAt, since),
              inArray(marketSignalSchemaDriftTable.collectorId, ids),
            ),
          )
          .orderBy(desc(marketSignalSchemaDriftTable.createdAt))
      : [];

    const entries = ids
      .map((id) => {
        const reg = getCollector(id)!;
        const r = dbById.get(id);
        const status: "enabled" | "disabled" | "killed" = !r
          ? "disabled"
          : r.killSwitch === 1
            ? "killed"
            : r.status === "approved"
              ? "enabled"
              : "disabled";
        const audit = auditRows.filter((a) => a.collectorId === id);
        const drifts = driftRows.filter((d) => d.collectorId === id);
        const successEvents = ["fetch_succeeded", "backfill_succeeded"];
        const failureEvents = ["fetch_failed", "backfill_failed"];
        const runs = audit.filter((a) =>
          successEvents.includes(a.event),
        ).length;
        const failures = audit.filter((a) =>
          failureEvents.includes(a.event),
        ).length;
        const fetchErrors = audit.filter((a) => a.error !== null).length;
        const lastRunAt = audit.find((a) => successEvents.includes(a.event))
          ?.createdAt ?? null;
        const lastFailureAt = audit.find((a) => failureEvents.includes(a.event))
          ?.createdAt ?? null;
        const lastSchemaDriftAt = drifts[0]?.createdAt ?? null;
        // Most recent successful run that landed at least one row.
        // We walk the audit in DESC-by-createdAt order (already
        // ordered by the query above) so the first match wins.
        const lastNonEmptyRunAt =
          audit.find((a) => {
            if (!successEvents.includes(a.event)) return false;
            const md = (a.metadata ?? {}) as Record<string, unknown>;
            const inserted = Number(md["inserted"] ?? md["signalsInserted"] ?? 0);
            return Number.isFinite(inserted) && inserted > 0;
          })?.createdAt ?? null;
        // "Empty-source" chip: collector is still running (a recent
        // success exists) but has not landed a row within the
        // collector-kind-specific tolerance. The threshold lives on
        // the IntelligenceCollector contract
        // (`staleEmptyThresholdHours`); we fall back to 48h when a
        // collector hasn't declared one. Daily macro feeds want a
        // tighter window (24-48h); weekly filings sources need ≥ 8
        // days. We cap the gap measurement at the lookback window so
        // a 720h lookback doesn't accidentally suppress the alarm.
        const staleEmptyThresholdHours =
          reg.staleEmptyThresholdHours ?? 48;
        const staleEmptyGapMs = staleEmptyThresholdHours * 60 * 60 * 1000;
        const staleEmptyRuns =
          runs > 0 &&
          (lastNonEmptyRunAt === null ||
            (lastRunAt !== null &&
              lastRunAt.getTime() - lastNonEmptyRunAt.getTime() >
                staleEmptyGapMs));
        return {
          collectorId: id,
          name: reg.name,
          status,
          runs,
          failures,
          fetchErrors,
          schemaDriftEvents: drifts.length,
          lastRunAt,
          lastFailureAt,
          lastSchemaDriftAt,
          lastNonEmptyRunAt,
          staleEmptyRuns,
          recentDrifts: drifts.slice(0, 5).map((d) => ({
            signalType: (d.sample as Record<string, unknown>)["signalType"]
              ? String((d.sample as Record<string, unknown>)["signalType"])
              : "unknown",
            observedAt: d.createdAt,
            addedKeysCount: 0,
            removedKeysCount: 0,
            changedKeys: d.fieldPath ? [d.fieldPath] : [],
          })),
          healthScore: computeHealthScore({ runs, failures, fetchErrors }),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ lookbackHours, entries });
  },
);

router.get(
  "/collectors/workbench/lineage",
  tenantMiddleware,
  async (_req, res) => {
    res.json(buildLineageGraph());
  },
);

router.get(
  "/collectors/workbench/coverage",
  tenantMiddleware,
  async (req, res) => {
    // Tenant isolation: marketSignalsTable.orgId is nullable — global
    // signals (e.g. ECB FX rates) carry NULL and are visible to every
    // tenant; tenant-private signals are scoped to req.orgId. Without
    // this filter, one tenant's coverage view would be inflated by
    // other tenants' private signals.
    const tenantScope = or(
      eq(marketSignalsTable.orgId, req.orgId!),
      isNull(marketSignalsTable.orgId),
    );

    // Material codes the platform actually has signal coverage for
    // (lookback-agnostic — coverage is conceptually a "what *can* we
    // see for this material" lens, not a freshness lens).
    const materialRows = await db
      .selectDistinct({ code: marketSignalsTable.scopeMaterialCode })
      .from(marketSignalsTable)
      .where(
        and(isNotNull(marketSignalsTable.scopeMaterialCode), tenantScope),
      );

    const materials = materialRows
      .map((m) => m.code)
      .filter((c): c is string => typeof c === "string" && c.length > 0)
      .sort();

    // For each material, list collectors that have written it. Group
    // in a single query and bucket in JS — same trade-off as above
    // (one round-trip beats N).
    const matCovRows = await db
      .select({
        materialCode: marketSignalsTable.scopeMaterialCode,
        collectorId: marketSignalsTable.collectorId,
        signalCount: count(),
      })
      .from(marketSignalsTable)
      .where(
        and(isNotNull(marketSignalsTable.scopeMaterialCode), tenantScope),
      )
      .groupBy(
        marketSignalsTable.scopeMaterialCode,
        marketSignalsTable.collectorId,
      );

    type CoverageRow = {
      materialCode: string;
      signalCount: number;
      coveredBy: string[];
    };
    const coverageByMaterial = new Map<string, CoverageRow>();
    for (const row of matCovRows) {
      if (!row.materialCode) continue;
      const cur = coverageByMaterial.get(row.materialCode) ?? {
        materialCode: row.materialCode,
        signalCount: 0,
        coveredBy: [],
      };
      cur.signalCount += Number(row.signalCount);
      if (!cur.coveredBy.includes(row.collectorId)) {
        cur.coveredBy.push(row.collectorId);
      }
      coverageByMaterial.set(row.materialCode, cur);
    }
    const rows = materials.map(
      (code) =>
        coverageByMaterial.get(code) ?? {
          materialCode: code,
          signalCount: 0,
          coveredBy: [],
        },
    );

    // Tenant context: which countries do their suppliers live in?
    const supplierCountryRows = req.orgId
      ? await db
          .select({
            countryCode: suppliersTable.countryCode,
            supplierCount: count(),
          })
          .from(suppliersTable)
          .where(eq(suppliersTable.orgId, req.orgId))
          .groupBy(suppliersTable.countryCode)
      : [];

    // Distinct collector jurisdictions from the registry (not from the
    // signals — collectors may declare a jurisdiction without yet
    // having written rows).
    const jurisdictions = Array.from(
      new Set(
        listRegisteredCollectorIds()
          .map((id) => getCollector(id)?.jurisdiction)
          .filter((j): j is string => typeof j === "string" && j.length > 0),
      ),
    ).sort();

    // Materials list — return both the canonical code and a label
    // sourced from the tenant's `categories` table when available
    // (categories.code is per-tenant, but in practice tenants reuse
    // the same canonical codes — first label wins).
    let labelByCode = new Map<string, string>();
    if (req.orgId && materials.length > 0) {
      const labelRows = await db
        .select({ code: categoriesTable.code, name: categoriesTable.name })
        .from(categoriesTable)
        .where(
          and(
            eq(categoriesTable.orgId, req.orgId),
            inArray(categoriesTable.code, materials),
          ),
        );
      labelByCode = new Map(labelRows.map((r) => [r.code, r.name]));
    }

    res.json({
      materials: materials.map((code) => ({
        code,
        label: labelByCode.get(code) ?? null,
      })),
      jurisdictions,
      supplierCountryCounts: supplierCountryRows.map((r) => ({
        countryCode: r.countryCode,
        supplierCount: Number(r.supplierCount),
      })),
      rows,
    });
  },
);

router.get(
  "/collectors/workbench/cost",
  tenantMiddleware,
  async (req, res) => {
    const lookbackHours = Math.min(
      Math.max(
        parseInt((req.query["lookbackHours"] as string) ?? "168", 10) || 168,
        1,
      ),
      720,
    );
    const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const ids = listRegisteredCollectorIds();

    // Cost source priority:
    //   1. `billing` — real dollars from the GCP Cloud Billing export
    //      (set `GCP_BILLING_EXPORT_TABLE` to enable). Splits BigQuery
    //      query/analysis cost from Cloud Storage cost and attributes
    //      project totals proportionally to each collector's bytes_raw.
    //   2. `bigquery` — the on-demand-pricing estimate computed from
    //      `collector_runs.bytes_raw × $5 / 1 TB`. No storage cost.
    //   3. `proxy` — Postgres-audit-log throughput proxy used when GCP
    //      isn't configured or the BQ query fails.
    let billingRows: Awaited<
      ReturnType<typeof getCollectorCostsFromBilling>
    > = null;
    try {
      billingRows = await getCollectorCostsFromBilling({
        lookbackHours,
        collectorIds: ids,
      });
    } catch (err) {
      req.log?.warn(
        { err: (err as Error).message },
        "GCP Billing cost read failed; falling back to BigQuery estimate",
      );
      billingRows = null;
    }

    if (billingRows) {
      const byId = new Map(billingRows.map((r) => [r.collectorId, r]));
      const entries = ids
        .map((id) => {
          const reg = getCollector(id)!;
          const r = byId.get(id);
          return {
            collectorId: id,
            name: reg.name,
            runs: r?.runs ?? 0,
            rowsWritten: r?.rowsWritten ?? 0,
            estimateUsd: r?.estimateUsd ?? 0,
            queryUsd: r?.queryUsd ?? 0,
            storageUsd: r?.storageUsd ?? 0,
            notes:
              "Real billing dollars from the GCP Cloud Billing export (cached 24h). " +
              "Splits BigQuery query cost + Cloud Storage cost; per-collector " +
              "attribution by bytes_raw share.",
          };
        })
        .sort((a, b) => b.estimateUsd - a.estimateUsd);
      res.json({ source: "billing" as const, lookbackHours, entries });
      return;
    }

    let bqRows: Awaited<ReturnType<typeof getCollectorCostsFromBq>> = null;
    try {
      bqRows = await getCollectorCostsFromBq({
        lookbackHours,
        collectorIds: ids,
      });
    } catch (err) {
      req.log?.warn(
        { err: (err as Error).message },
        "BigQuery cost read failed; falling back to audit-log proxy",
      );
      bqRows = null;
    }

    if (bqRows) {
      const byId = new Map(bqRows.map((r) => [r.collectorId, r]));
      const entries = ids
        .map((id) => {
          const reg = getCollector(id)!;
          const r = byId.get(id);
          return {
            collectorId: id,
            name: reg.name,
            runs: r?.runs ?? 0,
            rowsWritten: r?.rowsWritten ?? 0,
            estimateUsd: r?.estimateUsd ?? 0,
            notes:
              "On-demand-pricing estimate from `collector_runs.bytes_raw × $5/TB` " +
              "(cached 24h). Set `GCP_BILLING_EXPORT_TABLE` for real billing dollars.",
          };
        })
        .sort((a, b) => b.estimateUsd - a.estimateUsd);
      res.json({ source: "bigquery" as const, lookbackHours, entries });
      return;
    }

    const auditRows = ids.length
      ? await db
          .select()
          .from(collectorAuditLogTable)
          .where(
            and(
              gte(collectorAuditLogTable.createdAt, since),
              inArray(collectorAuditLogTable.collectorId, ids),
            ),
          )
      : [];

    // Proxy cost model:
    //   estimateUsd = max(rowsWritten * 0.0000005, runs * 0.0001)
    // Documented as a *proxy* rather than real BQ slot/byte cost —
    // used when GCP isn't configured locally or the BQ query fails.
    const entries = ids
      .map((id) => {
        const reg = getCollector(id)!;
        const audit = auditRows.filter((a) => a.collectorId === id);
        const successes = audit.filter(
          (a) => a.event === "fetch_succeeded" || a.event === "backfill_succeeded",
        );
        const runs = successes.length;
        let rowsWritten = 0;
        for (const a of successes) {
          const meta = (a.metadata ?? {}) as Record<string, unknown>;
          const inserted = Number(meta["inserted"] ?? meta["signalsInserted"] ?? 0);
          if (Number.isFinite(inserted)) rowsWritten += inserted;
        }
        const estimateUsd = Number(
          (Math.max(rowsWritten * 0.0000005, runs * 0.0001)).toFixed(6),
        );
        return {
          collectorId: id,
          name: reg.name,
          runs,
          rowsWritten,
          estimateUsd,
          notes:
            "Proxy estimate from audit-log throughput (BigQuery cost read unavailable).",
        };
      })
      .sort((a, b) => b.estimateUsd - a.estimateUsd);

    res.json({ source: "proxy" as const, lookbackHours, entries });
  },
);

router.get(
  "/collectors/workbench/runs",
  tenantMiddleware,
  async (req, res) => {
    const lookbackHours = Math.min(
      Math.max(
        parseInt((req.query["lookbackHours"] as string) ?? "168", 10) || 168,
        1,
      ),
      720,
    );
    const limit = Math.min(
      Math.max(parseInt((req.query["limit"] as string) ?? "200", 10) || 200, 1),
      1000,
    );
    const collectorId = req.query["collectorId"]
      ? String(req.query["collectorId"])
      : undefined;
    const onlyErrors = String(req.query["onlyErrors"] ?? "") === "true";
    const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

    const conditions = [gte(collectorAuditLogTable.createdAt, since)];
    if (collectorId) {
      conditions.push(eq(collectorAuditLogTable.collectorId, collectorId));
    }
    if (onlyErrors) {
      conditions.push(
        or(
          isNotNull(collectorAuditLogTable.error),
          eq(collectorAuditLogTable.event, "fetch_failed"),
          eq(collectorAuditLogTable.event, "backfill_failed"),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(collectorAuditLogTable)
      .where(and(...conditions))
      .orderBy(desc(collectorAuditLogTable.createdAt))
      .limit(limit);

    res.json({
      lookbackHours,
      entries: rows.map((r) => ({
        id: r.id,
        collectorId: r.collectorId,
        event: r.event,
        targetUrl: r.targetUrl,
        statusCode: r.statusCode,
        error: r.error,
        metadata: r.metadata ?? {},
        createdAt: r.createdAt,
      })),
    });
  },
);

router.get("/data-sources", tenantMiddleware, async (req, res) => {
  // Client-facing view: only show what the active tenant has actually
  // opted into (resolved opt-in matrix), and only safe fields. No
  // posture-class, no kill criteria, no operator notes.
  const dbRows = await db.select().from(collectorsTable);
  const dbById = new Map(dbRows.map((r) => [r.id, r]));
  const tenantOptIns = await loadTenantOptIns(req.orgId);

  const ids = listRegisteredCollectorIds();
  const lastRunByCollector = new Map<string, Date>();
  if (ids.length) {
    const lastRunRows = await db
      .select({
        collectorId: collectorAuditLogTable.collectorId,
        latest: sql<Date>`max(${collectorAuditLogTable.createdAt})`,
      })
      .from(collectorAuditLogTable)
      .where(
        and(
          inArray(collectorAuditLogTable.collectorId, ids),
          or(
            eq(collectorAuditLogTable.event, "fetch_succeeded"),
            eq(collectorAuditLogTable.event, "backfill_succeeded"),
          )!,
        ),
      )
      .groupBy(collectorAuditLogTable.collectorId);
    for (const row of lastRunRows) {
      if (row.latest) lastRunByCollector.set(row.collectorId, row.latest);
    }
  }

  // Tier-disclosure policy for the client-facing surface:
  //   * T1, T2 → fully detailed cards
  //   * T3     → never named individually; collapsed into a single
  //              "additional restricted sources" summary entry
  //   * T4     → never disclosed under any circumstance
  // This mirrors the legal review for what tenants are allowed to see
  // about the operator-side collection fleet.
  type ClientEntry = {
    id: string;
    name: string;
    logoUrl?: string | null;
    jurisdiction: string;
    flagEmoji?: string | null;
    disclosureTier: "T1" | "T2" | "T3" | "T4";
    cadenceLabel: string;
    licenseNote: string;
    tosUrl?: string | null;
    lastRefreshedAt: Date | null;
  };

  const visible: ClientEntry[] = [];
  let t3OptedInCount = 0;

  for (const id of ids) {
    const reg = getCollector(id)!;
    const meta = getWorkbenchMeta(id);
    const r = dbById.get(id);
    // Honour the kill switch even for opted-in tenants.
    if (r && r.killSwitch === 1) continue;
    const tier = (reg.disclosureTier ?? "T1") as "T1" | "T2" | "T3" | "T4";
    const visibility = classifyDataSourceVisibility(tier);
    if (visibility === "hidden") continue;
    const tenantOptInDefault = reg.tenantOptInDefault ?? false;
    const optedIn = tenantOptIns.has(id)
      ? (tenantOptIns.get(id) ?? tenantOptInDefault)
      : tenantOptInDefault;
    if (!optedIn) continue;
    if (visibility === "summarised") {
      t3OptedInCount += 1;
      continue;
    }
    visible.push({
      id,
      name: reg.name,
      logoUrl: meta.logoUrl,
      jurisdiction: reg.jurisdiction ?? "GLOBAL",
      flagEmoji: meta.flagEmoji,
      disclosureTier: tier,
      cadenceLabel: meta.cadenceLabel,
      licenseNote: meta.licenseNote,
      tosUrl: meta.tosUrl,
      lastRefreshedAt: lastRunByCollector.get(id) ?? null,
    });
  }

  visible.sort((a, b) => a.name.localeCompare(b.name));

  // The summary line is appended at the end so the named T1/T2 cards
  // come first in the UI and the restricted bucket is clearly distinct.
  const entries: ClientEntry[] = visible;
  if (t3OptedInCount > 0) {
    entries.push({
      id: "t3-summary",
      name: `${t3OptedInCount} additional restricted source${t3OptedInCount === 1 ? "" : "s"}`,
      logoUrl: null,
      jurisdiction: "—",
      flagEmoji: null,
      disclosureTier: "T3",
      cadenceLabel: "Restricted disclosure",
      licenseNote:
        "Tier-3 sources are summarised rather than named. Contact your account team if you need to audit a specific feed.",
      tosUrl: null,
      lastRefreshedAt: null,
    });
  }

  res.json({ entries });
});

export default router;
