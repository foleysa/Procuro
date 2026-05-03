/**
 * Funnel observability surface (task #185).
 *
 * Tenant-scoped routes are gated by `audit:read` (org admins / auditors
 * can see their own tenant's pipeline). The cross-tenant aggregate is
 * gated by `platform:manage` since it's only meaningful to the
 * platform operator.
 *
 *  GET    /admin/funnel/snapshots                       — list, filter
 *  GET    /admin/funnel/snapshots/:id                   — full row
 *  POST   /admin/funnel/snapshots/:cycleId/recompute    — re-emit one cycle
 *  GET    /admin/funnel/annotations                     — list (with ?ack=)
 *  POST   /admin/funnel/annotations                     — operator note
 *  PATCH  /admin/funnel/annotations/:id/ack             — ack
 *  GET    /admin/funnel/failures                        — list snapshot failures
 *  PATCH  /admin/funnel/failures/:id/ack                — ack
 *  GET    /admin/funnel/lowest-conversion               — slowest stages by lever
 *  GET    /admin/funnel/tier-matrix                     — per-(category, lever) tier matrix
 *  GET    /platform/funnel/aggregate                    — cross-tenant rollup
 */
import { Router, type IRouter } from "express";
import {
  db,
  funnelSnapshotsTable,
  funnelAnnotationsTable,
  funnelSnapshotFailuresTable,
  analysisCyclesTable,
  opportunitiesTable,
  decisionsTable,
  jobsTable,
  type LeverId,
} from "@workspace/db";
import { and, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { ApiError, InvalidRequestError, NotFoundError } from "../lib/api-errors";
import { newId } from "../lib/ids";
import {
  ensureBackfillFunnelSnapshotsJobScheduled,
  getFunnelSnapshotRetentionConfig,
} from "../lib/jobs/queue";
import {
  captureFunnelSnapshot,
  funnelSnapshotFailuresCounter,
} from "../lib/ooda/funnel";
import {
  getTierAutoApplySettings,
  setTierAutoApplyMode,
  DEFAULT_TIER_AUTO_APPLY_MODE,
  type TierAutoApplyMode,
} from "../lib/ooda/tier-auto-apply";
import { requirePlatformAdmin } from "../lib/platform-admin";
import { ALL_LEVERS } from "../lib/levers";
import { toAnalyzeResult } from "../lib/levers/types";
import { loadPriors } from "../lib/ooda/priors";
import {
  summarizeQueue,
  countOpportunitiesByMappedVia,
  checkRoutingHealth,
  suggestTierForCategoryLever,
} from "../lib/intelligence/routing";

const router: IRouter = Router();

const PAGE_LIMIT_MAX = 200;

function parseLimit(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), PAGE_LIMIT_MAX);
}

// ─────────────────────────────────────────────────────────────────────
// Snapshots
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/admin/funnel/snapshots",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const limit = parseLimit(req.query["limit"], 50);
    const filters: SQL[] = [eq(funnelSnapshotsTable.orgId, orgId)];
    const since = req.query["since"];
    if (typeof since === "string" && since) {
      const d = new Date(since);
      if (!isNaN(d.getTime())) {
        filters.push(gte(funnelSnapshotsTable.createdAt, d));
      }
    }
    if (req.query["hasAnnotation"] === "true") {
      filters.push(eq(funnelSnapshotsTable.hasAutoAnnotation, 1));
    }
    const rows = await db
      .select({
        id: funnelSnapshotsTable.id,
        cycleId: funnelSnapshotsTable.cycleId,
        cycleGeneration: funnelSnapshotsTable.cycleGeneration,
        totalDraftsProduced: funnelSnapshotsTable.totalDraftsProduced,
        totalDraftsPostExclusion: funnelSnapshotsTable.totalDraftsPostExclusion,
        totalOppsPersisted: funnelSnapshotsTable.totalOppsPersisted,
        totalProjectedUsd: funnelSnapshotsTable.totalProjectedUsd,
        captureDurationMs: funnelSnapshotsTable.captureDurationMs,
        hasAutoAnnotation: funnelSnapshotsTable.hasAutoAnnotation,
        source: funnelSnapshotsTable.source,
        createdAt: funnelSnapshotsTable.createdAt,
      })
      .from(funnelSnapshotsTable)
      .where(and(...filters))
      .orderBy(desc(funnelSnapshotsTable.cycleGeneration))
      .limit(limit);

    // Surface the warm-up state so the UI can badge "delta detection
    // pending" until the tenant has accumulated enough cycles.
    const totalSnapshotCount = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.orgId, orgId));
    const total = Number(totalSnapshotCount[0]?.c ?? 0);

    // Surface the configured retention windows alongside the listing
    // so the funnel observability page can show operators exactly how
    // long a snapshot (or its failure row) will live before the
    // `prune_funnel_snapshots` job removes it. Computed from env each
    // request — these are constants from `getFunnelSnapshotRetentionConfig`,
    // so the cost is negligible and we avoid a stale cache.
    const retention = await getFunnelSnapshotRetentionConfig();

    res.json({
      snapshots: rows,
      warmupComplete: total >= 5,
      totalSnapshotCount: total,
      retention: {
        snapshotsOlderThanMs: retention.snapshotsOlderThanMs,
        failuresOlderThanMs: retention.failuresOlderThanMs,
      },
    });
  },
);

/**
 * Mapping-data-health surface (task #213).
 *
 * Spec contract — top-level fields mandated by task #213:
 *   - `unmappedQueueDepth`     — count of open queue rows
 *   - `oldestUnmappedAgeDays`  — age of oldest open queue row, in days
 *   - `unmappedSpendPct`       — share of trailing-90d spend that is
 *                                still unmapped (queue spend / (queue
 *                                spend + mapped opportunity spend))
 *
 * `materializedView` carries the live drift verdict from
 * `checkRoutingHealth()` so admins get it in the same round trip.
 * `queue` and `opportunities` retain richer breakdowns for the admin UI.
 *
 * Surfaced under the existing audit-read permission since it sits on
 * the funnel observability page alongside snapshots — operators with
 * audit access already see the rest of the funnel.
 */
router.get(
  "/admin/funnel/mapping-data-health",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const [queue, byVia, mappedSpendRow, viewHealth] = await Promise.all([
      summarizeQueue(orgId),
      countOpportunitiesByMappedVia(orgId),
      // Mapped trailing-90d spend baseline: derived from active
      // contracts whose category is RESOLVED (categoryId IS NOT NULL,
      // i.e. they're attached to the canonical taxonomy). We
      // approximate trailing-90d as `annual_baseline_usd * 90/365`
      // since contracts carry an annual figure rather than a rolling
      // window. This is a real spend signal — `projected_savings_usd`
      // is a savings estimate, not spend, and would mis-anchor the
      // unmapped-spend ratio.
      db.execute(sql`
        SELECT COALESCE(SUM(annual_baseline_usd * 90.0 / 365.0), 0)::text
            AS mapped_spend
          FROM contracts
         WHERE org_id = ${orgId}
           AND status = 'active'
           AND category_id IS NOT NULL
      `),
      checkRoutingHealth(),
    ]);
    const total = Object.values(byVia).reduce((s, n) => s + n, 0);
    const unmapped = byVia["unmapped_default"] ?? 0;
    const unmappedDefaultPct = total > 0 ? unmapped / total : 0;
    const mappedSpendUsd = Number(
      (mappedSpendRow.rows?.[0] as { mapped_spend?: string } | undefined)
        ?.mapped_spend ?? 0,
    );
    const totalSpendBaseline = mappedSpendUsd + queue.unmappedSpendUsd;
    const unmappedSpendPct =
      totalSpendBaseline > 0 ? queue.unmappedSpendUsd / totalSpendBaseline : 0;
    const oldestUnmappedAgeDays = queue.oldestOpenAt
      ? Math.max(
          0,
          (Date.now() - new Date(queue.oldestOpenAt).getTime()) / 86_400_000,
        )
      : 0;
    res.json({
      // ── Spec-required top-level fields ─────────────────────────────
      unmappedQueueDepth: queue.openCount,
      oldestUnmappedAgeDays,
      unmappedSpendPct,
      // ── Richer breakdowns kept for the admin UI ───────────────────
      queue,
      opportunities: {
        total,
        byMappedVia: byVia,
        unmappedDefaultPct,
        mappedSpendUsd,
      },
      materializedView: viewHealth,
    });
  },
);

router.get(
  "/admin/funnel/snapshots/:id",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params.id);
    const [row] = await db
      .select()
      .from(funnelSnapshotsTable)
      .where(
        and(
          eq(funnelSnapshotsTable.orgId, orgId),
          eq(funnelSnapshotsTable.id, id),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError("not_found");
    const annotations = await db
      .select()
      .from(funnelAnnotationsTable)
      .where(eq(funnelAnnotationsTable.snapshotId, id))
      .orderBy(desc(funnelAnnotationsTable.createdAt));
    return res.json({ snapshot: row, annotations });
  },
);

/**
 * Re-run snapshot capture for an existing cycle. Useful after a bug fix
 * — the route deletes the prior snapshot row (cascade-removes its
 * annotations) and re-captures from the cycle's recorded inputs.
 *
 * NOTE: Re-capture only re-derives stages 6–10 from the persisted
 * opportunities + decisions; stages 1–5 (signals, drafts, post-exclusion)
 * are best-effort because the lever analyzers aren't re-run. This is
 * sufficient for cohort-correctness verification but not full lineage
 * recovery — see README.funnel.md.
 */
router.post(
  "/admin/funnel/snapshots/:cycleId/recompute",
  tenantMiddleware,
  requirePermission("platform:manage"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const cycleId = String(req.params.cycleId);
    const [cycle] = await db
      .select()
      .from(analysisCyclesTable)
      .where(
        and(
          eq(analysisCyclesTable.orgId, orgId),
          eq(analysisCyclesTable.id, cycleId),
        ),
      )
      .limit(1);
    if (!cycle) throw new NotFoundError("cycle_not_found");

    // Drop the existing snapshot (cascade removes annotations).
    await db
      .delete(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.cycleId, cycleId));

    // Re-fetch the persisted opportunities for this cycle and re-run
    // the snapshot. Lever results are reconstructed as empty AnalyzeResults
    // since we can't re-execute analyzers safely after the fact —
    // stages 1–5 will be 0 / sample-only.
    const persistedOpps = await db
      .select()
      .from(opportunitiesTable)
      .where(
        and(
          eq(opportunitiesTable.orgId, orgId),
          eq(opportunitiesTable.cycleId, cycleId),
        ),
      );

    const leverResults = ALL_LEVERS.map((lever) => ({
      lever,
      result: toAnalyzeResult([]),
    }));

    const result = await captureFunnelSnapshot({
      orgId,
      cycleId,
      cycleGeneration: cycle.generation,
      leverResults,
      draftsPostExclusion: [],
      persistedOpps,
      priorDeltas: [],
      // Recompute can only re-derive stages 6–10 from persisted state;
      // stages 1–5 (analyzer outputs) are zeroed exactly like the
      // backfill path. Tag the row as `backfill` so the admin badge
      // reflects that and trailing-baseline delta detection still
      // excludes it.
      source: "backfill",
    });
    if (result.failed) {
      throw new ApiError(500, "internal_error", "snapshot_capture_failed");
    }
    return res.json({ snapshotId: result.snapshotId, recomputed: true });
  },
);

// ─────────────────────────────────────────────────────────────────────
// Annotations
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/admin/funnel/annotations",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const limit = parseLimit(req.query["limit"], 100);
    const filters: SQL[] = [eq(funnelAnnotationsTable.orgId, orgId)];
    if (req.query["ack"] === "false") {
      filters.push(isNull(funnelAnnotationsTable.ackedAt));
    }
    if (typeof req.query["source"] === "string") {
      filters.push(
        eq(funnelAnnotationsTable.source, req.query["source"] as "auto" | "operator"),
      );
    }
    if (typeof req.query["snapshotId"] === "string") {
      filters.push(
        eq(funnelAnnotationsTable.snapshotId, String(req.query["snapshotId"])),
      );
    }
    const rows = await db
      .select()
      .from(funnelAnnotationsTable)
      .where(and(...filters))
      .orderBy(desc(funnelAnnotationsTable.createdAt))
      .limit(limit);
    res.json({ annotations: rows });
  },
);

router.post(
  "/admin/funnel/annotations",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const body = req.body as {
      snapshotId?: string;
      summary?: string;
      detail?: Record<string, unknown>;
      targetStage?: string | null;
      targetLeverId?: string | null;
      targetCohortWindow?: string | null;
    };
    if (!body.snapshotId || !body.summary) {
      throw new InvalidRequestError("snapshotId_and_summary_required");
    }
    const [snap] = await db
      .select({ id: funnelSnapshotsTable.id })
      .from(funnelSnapshotsTable)
      .where(
        and(
          eq(funnelSnapshotsTable.orgId, orgId),
          eq(funnelSnapshotsTable.id, body.snapshotId),
        ),
      )
      .limit(1);
    if (!snap) throw new NotFoundError("snapshot_not_found");

    const [row] = await db
      .insert(funnelAnnotationsTable)
      .values({
        id: newId("fnlann"),
        orgId,
        snapshotId: body.snapshotId,
        source: "operator",
        kind: "operator_note",
        targetStage: body.targetStage ?? null,
        targetLeverId: body.targetLeverId ?? null,
        targetCohortWindow: body.targetCohortWindow ?? null,
        summary: body.summary,
        detail: body.detail ?? {},
        createdBy: (req as { user?: { id?: string } }).user?.id ?? null,
      })
      .returning();
    return res.status(201).json({ annotation: row });
  },
);

router.patch(
  "/admin/funnel/annotations/:id/ack",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params.id);
    const userId = (req as { user?: { id?: string } }).user?.id ?? null;
    const [row] = await db
      .update(funnelAnnotationsTable)
      .set({ ackedBy: userId, ackedAt: new Date() })
      .where(
        and(
          eq(funnelAnnotationsTable.orgId, orgId),
          eq(funnelAnnotationsTable.id, id),
        ),
      )
      .returning();
    if (!row) throw new NotFoundError("not_found");
    return res.json({ annotation: row });
  },
);

// ─────────────────────────────────────────────────────────────────────
// Failures
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/admin/funnel/failures",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const limit = parseLimit(req.query["limit"], 50);
    const filters: SQL[] = [eq(funnelSnapshotFailuresTable.orgId, orgId)];
    if (req.query["ack"] === "false") {
      filters.push(isNull(funnelSnapshotFailuresTable.ackedAt));
    }
    const rows = await db
      .select()
      .from(funnelSnapshotFailuresTable)
      .where(and(...filters))
      .orderBy(desc(funnelSnapshotFailuresTable.lastSeenAt))
      .limit(limit);
    res.json({ failures: rows, counters: funnelSnapshotFailuresCounter.snapshot() });
  },
);

router.patch(
  "/admin/funnel/failures/:id/ack",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params.id);
    const userId = (req as { user?: { id?: string } }).user?.id ?? null;
    const [row] = await db
      .update(funnelSnapshotFailuresTable)
      .set({ ackedBy: userId, ackedAt: new Date() })
      .where(
        and(
          eq(funnelSnapshotFailuresTable.orgId, orgId),
          eq(funnelSnapshotFailuresTable.id, id),
        ),
      )
      .returning();
    if (!row) throw new NotFoundError("not_found");
    return res.json({ failure: row });
  },
);

// ─────────────────────────────────────────────────────────────────────
// Lowest-conversion identification
// ─────────────────────────────────────────────────────────────────────

/**
 * For each lever, compute the conversion rate at each stage transition
 * (drafts → post-exclusion → persisted → approved → realized) over the
 * trailing N cycles, and surface the worst transitions so an admin can
 * see which lever is bleeding pipeline. Fall back to "insufficient
 * data" if a lever has no drafts in window.
 */
router.get(
  "/admin/funnel/lowest-conversion",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const cyclesBack = parseLimit(req.query["cycles"], 10);
    const snapshots = await db
      .select({
        stages: funnelSnapshotsTable.stages,
      })
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.orgId, orgId))
      .orderBy(desc(funnelSnapshotsTable.cycleGeneration))
      .limit(cyclesBack);

    type StagePayload = {
      count?: number;
      by_lever?: Record<string, number>;
    };

    function sumByLever(stageKey: string): Record<string, number> {
      const out: Record<string, number> = {};
      for (const s of snapshots) {
        const stages = s.stages as Record<string, StagePayload>;
        const v = stages?.[stageKey];
        if (!v?.by_lever) continue;
        for (const [k, n] of Object.entries(v.by_lever)) {
          out[k] = (out[k] ?? 0) + Number(n);
        }
      }
      return out;
    }

    const drafts = sumByLever("drafts_produced");
    const postEx = sumByLever("drafts_post_exclusion");
    const persisted = sumByLever("opps_persisted");
    const approved30 = sumByLever("opps_approved_30d");
    const realized30 = sumByLever("opps_realized_30d");

    const allLeverIds = new Set<string>([
      ...Object.keys(drafts),
      ...Object.keys(postEx),
      ...Object.keys(persisted),
      ...Object.keys(approved30),
      ...Object.keys(realized30),
    ]);

    type Row = {
      leverId: string;
      stages: { drafts: number; postEx: number; persisted: number; approved30: number; realized30: number };
      worstTransition: string | null;
      worstRate: number | null;
    };
    const rows: Row[] = [];
    for (const leverId of allLeverIds) {
      const s = {
        drafts: drafts[leverId] ?? 0,
        postEx: postEx[leverId] ?? 0,
        persisted: persisted[leverId] ?? 0,
        approved30: approved30[leverId] ?? 0,
        realized30: realized30[leverId] ?? 0,
      };
      const transitions: Array<[string, number, number]> = [
        ["drafts→post_exclusion", s.drafts, s.postEx],
        ["post_exclusion→persisted", s.postEx, s.persisted],
        ["persisted→approved_30d", s.persisted, s.approved30],
        ["approved_30d→realized_30d", s.approved30, s.realized30],
      ];
      let worstName: string | null = null;
      let worstRate: number | null = null;
      for (const [name, num, den] of transitions) {
        if (den === 0 && num > 0) continue; // numerator > 0 with no downstream
        const baseDen = num;
        if (baseDen === 0) continue;
        const rate = den / baseDen;
        if (worstRate === null || rate < worstRate) {
          worstRate = rate;
          worstName = name;
        }
      }
      rows.push({ leverId, stages: s, worstTransition: worstName, worstRate });
    }
    rows.sort((a, b) => (a.worstRate ?? 1) - (b.worstRate ?? 1));
    res.json({ rows, cyclesAnalyzed: snapshots.length });
  },
);

// ─────────────────────────────────────────────────────────────────────
// Per-(category, lever) tier matrix (task #218)
//
// Reads the latest funnel_snapshot for the tenant and explodes the
// `calibration` block into a 2-D matrix that the admin-funnel UI
// renders as rows = levers, cols = categories. Each cell carries the
// raw calibration entry alongside the classified `tier` so the UI can
// badge insufficient_evidence / tier_a / tier_b / tier_c_or_d
// uniformly without re-implementing the dead-band rule.
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/admin/funnel/tier-matrix",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const windowParam = req.query["window"];
    const window: "30d" | "90d" =
      windowParam === "30d" ? "30d" : "90d";

    // Pull the latest snapshot's calibration map. We don't recompute
    // tiers here off live opportunities — tier suggestions are a
    // *snapshot-derived* surface so they line up with what the admin
    // already sees in the calibration table.
    const [latest] = await db
      .select({
        snapshotId: funnelSnapshotsTable.id,
        cycleGeneration: funnelSnapshotsTable.cycleGeneration,
        createdAt: funnelSnapshotsTable.createdAt,
        calibration: funnelSnapshotsTable.calibration,
      })
      .from(funnelSnapshotsTable)
      .where(eq(funnelSnapshotsTable.orgId, orgId))
      .orderBy(desc(funnelSnapshotsTable.cycleGeneration))
      .limit(1);

    if (!latest) {
      return res.json({
        snapshot: null,
        window,
        levers: [],
        categories: [],
        cells: [],
        rollups: [],
      });
    }

    interface RawEntry {
      leverId?: string;
      categoryCode?: string;
      window?: string;
      n?: number;
      improvementUsd?: number;
      rawMedianAbsErrorUsd?: number;
      rescaledMedianAbsErrorUsd?: number;
      verdict?: string;
    }
    const calibration = (latest.calibration ?? {}) as Record<string, RawEntry>;

    const TIER_MIN_N = 10;
    const TIER_DEAD_BAND_USD = 100;
    function classify(
      e: RawEntry,
    ): "tier_a" | "tier_b" | "tier_c_or_d" | "insufficient_data" {
      const n = e.n ?? 0;
      const imp = e.improvementUsd;
      if (n < TIER_MIN_N || typeof imp !== "number") return "insufficient_data";
      if (imp > TIER_DEAD_BAND_USD) return "tier_a";
      if (imp < -TIER_DEAD_BAND_USD) return "tier_c_or_d";
      return "tier_b";
    }

    const ROLLUP = "_all";
    type Tier = "tier_a" | "tier_b" | "tier_c_or_d" | "insufficient_data";
    interface Cell {
      leverId: string;
      categoryCode: string;
      n: number;
      improvementUsd: number | null;
      rawMedianAbsErrorUsd: number | null;
      rescaledMedianAbsErrorUsd: number | null;
      verdict: string;
      tier: Tier;
    }
    interface Driver extends Cell {
      sampleSharePct: number | null;
      disagreesWithRollup: boolean;
    }
    interface RollupCell extends Cell {
      drivers: Driver[];
    }
    const cells: Cell[] = [];
    const rollupsByLever = new Map<string, RollupCell>();
    const cellsByLever = new Map<string, Cell[]>();
    const leversSet = new Set<string>();
    const categoriesSet = new Set<string>();

    for (const [key, entry] of Object.entries(calibration)) {
      // Keys are `<leverId>:<categoryCode>:<window>`. Filter by the
      // requested window and skip anything that doesn't parse — old
      // snapshots from before task #218 used `<leverId>:<window>` and
      // we want the matrix to be silent about them rather than crash.
      const parts = key.split(":");
      if (parts.length !== 3) continue;
      const [leverId, categoryCode, w] = parts as [string, string, string];
      if (w !== window) continue;
      const cell: Cell = {
        leverId,
        categoryCode,
        n: entry.n ?? 0,
        improvementUsd:
          typeof entry.improvementUsd === "number" ? entry.improvementUsd : null,
        rawMedianAbsErrorUsd:
          typeof entry.rawMedianAbsErrorUsd === "number"
            ? entry.rawMedianAbsErrorUsd
            : null,
        rescaledMedianAbsErrorUsd:
          typeof entry.rescaledMedianAbsErrorUsd === "number"
            ? entry.rescaledMedianAbsErrorUsd
            : null,
        verdict: entry.verdict ?? "neutral",
        tier: classify(entry),
      };
      leversSet.add(leverId);
      if (categoryCode === ROLLUP) {
        rollupsByLever.set(leverId, { ...cell, drivers: [] });
      } else {
        categoriesSet.add(categoryCode);
        cells.push(cell);
        const arr = cellsByLever.get(leverId) ?? [];
        arr.push(cell);
        cellsByLever.set(leverId, arr);
      }
    }

    // Driver breakdown (task #230): for each per-lever `_all` rollup,
    // attach the per-(category, lever) cells that fed it ranked by
    // sample count, including the share of the rollup's sample volume
    // and a flag for cells whose decisive verdict disagrees with the
    // rollup. Operators use this to spot the one bad category dragging
    // an otherwise-helping lever to neutral. We cap at 10 drivers so
    // the payload stays small; the matrix itself still carries every
    // per-(category, lever) cell unfiltered.
    const TOP_DRIVERS = 10;
    // A driver "disagrees" with the rollup whenever both sides have a
    // computed verdict (i.e. enough samples to escape
    // `insufficient_evidence`) and those verdicts differ. This
    // explicitly includes the motivating case from task #230 — a
    // single hurting category dragging an otherwise-helping lever to
    // `neutral` — by treating `neutral` as a real verdict to compare
    // against, not as "no opinion".
    for (const [leverId, rollup] of rollupsByLever.entries()) {
      const driverCells = cellsByLever.get(leverId) ?? [];
      const rollupHasVerdict =
        rollup.verdict !== "insufficient_evidence";
      const drivers: Driver[] = driverCells
        .slice()
        .sort((a, b) => b.n - a.n)
        .slice(0, TOP_DRIVERS)
        .map((c) => ({
          ...c,
          sampleSharePct:
            rollup.n > 0 ? Math.round((c.n / rollup.n) * 1000) / 10 : null,
          disagreesWithRollup:
            rollupHasVerdict &&
            c.verdict !== "insufficient_evidence" &&
            c.verdict !== rollup.verdict,
        }));
      rollup.drivers = drivers;
    }

    const rollups = Array.from(rollupsByLever.values());

    return res.json({
      snapshot: {
        id: latest.snapshotId,
        cycleGeneration: latest.cycleGeneration,
        createdAt: latest.createdAt,
      },
      window,
      levers: Array.from(leversSet).sort(),
      categories: Array.from(categoriesSet).sort(),
      cells,
      rollups,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────
// Single (category, lever) tier suggestion (task #218)
//
// Convenience wrapper around `suggestTierForCategoryLever()` so the
// engine UI / programmatic callers can ask about one cell without
// pulling the whole matrix. Same `audit:read` gate as the matrix
// endpoint.
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/admin/funnel/tier-suggestion",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const categoryCode = String(req.query["categoryCode"] ?? "").trim();
    const leverId = String(req.query["leverId"] ?? "").trim();
    if (!categoryCode || !leverId) {
      throw new InvalidRequestError("categoryCode and leverId are required");
    }
    const windowParam = req.query["window"];
    const window: "30d" | "90d" =
      windowParam === "30d" ? "30d" : "90d";
    const result = await suggestTierForCategoryLever({
      orgId,
      categoryCode,
      leverId: leverId as LeverId,
      window,
    });
    return res.json(result);
  },
);

// ─────────────────────────────────────────────────────────────────────
// Tier auto-apply toggle (task #229)
//
// Cross-tenant `app_settings` knob controlling whether the OODA cycle
// is allowed to mutate per-(category, lever) prior scales from
// snapshot tier suggestions. `advisory` (default) → suggestions only
// surface in admin UI, no priors change. `auto` → cycle's
// post-snapshot step runs the hysteresis machine and applies
// promotions/demotions, with a `calibration_change` annotation per
// flip. Platform-admin gated since it's cross-tenant by design.
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/admin/funnel/tier-auto-apply",
  requirePlatformAdmin,
  async (_req, res) => {
    const s = await getTierAutoApplySettings();
    res.json({
      mode: s.mode,
      defaultMode: DEFAULT_TIER_AUTO_APPLY_MODE,
      isOverride: s.isOverride,
      lastChangedAt: s.lastChangedAt ? s.lastChangedAt.toISOString() : null,
      lastChangedBy: s.lastChangedBy,
    });
  },
);

router.put(
  "/admin/funnel/tier-auto-apply",
  requirePlatformAdmin,
  async (req, res) => {
    const body = (req.body ?? {}) as { mode?: unknown };
    const raw = body.mode;
    if (raw !== "advisory" && raw !== "auto") {
      throw new InvalidRequestError('Body must include `mode` of "advisory" or "auto"');
    }
    const mode = raw as TierAutoApplyMode;
    const actor = req.actorEmail ?? "system@procuro.ai";
    const updated = await setTierAutoApplyMode({ mode, actorEmail: actor });
    req.log.info(
      { mode: updated.mode, actor },
      "Operator updated tier_auto_apply",
    );
    res.json({
      mode: updated.mode,
      defaultMode: DEFAULT_TIER_AUTO_APPLY_MODE,
      isOverride: updated.isOverride,
      lastChangedAt: updated.lastChangedAt
        ? updated.lastChangedAt.toISOString()
        : null,
      lastChangedBy: updated.lastChangedBy,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────
// Cross-tenant aggregate (platform admins only)
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/platform/funnel/aggregate",
  requirePermission("platform:manage"),
  async (req, res) => {
    const cyclesBack = parseLimit(req.query["cycles"], 10);
    const rows = await db.execute(sql`
      WITH recent AS (
        SELECT org_id,
               total_drafts_produced,
               total_drafts_post_exclusion,
               total_opps_persisted,
               total_projected_usd,
               cycle_generation,
               created_at,
               ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY cycle_generation DESC) AS rn
        FROM funnel_snapshots
      )
      SELECT org_id,
             SUM(total_drafts_produced)::int          AS total_drafts,
             SUM(total_drafts_post_exclusion)::int    AS total_post_exclusion,
             SUM(total_opps_persisted)::int           AS total_persisted,
             SUM(total_projected_usd)::numeric        AS total_projected_usd,
             COUNT(*)::int                            AS cycles
      FROM recent
      WHERE rn <= ${cyclesBack}
      GROUP BY org_id
      ORDER BY total_persisted DESC
    `);
    const failures = await db.execute(sql`
      SELECT org_id,
             SUM(recurrence_count)::int AS total_failures,
             COUNT(*)::int              AS distinct_classes,
             MAX(last_seen_at)          AS last_seen_at
      FROM funnel_snapshot_failures
      WHERE acked_at IS NULL
      GROUP BY org_id
    `);
    res.json({
      tenants: rows.rows,
      failures: failures.rows,
      cyclesPerTenant: cyclesBack,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────
// Backfill (task #188 / #195) — fill in funnel_snapshots for cycles
// that completed before the snapshot writer shipped. Cross-tenant by
// design so a platform operator can light up the observability page
// for every established tenant in one call. Per-tenant invocation is
// opt-in via the `orgId` body field; absence means "all tenants".
//
// Routed through the existing job queue (task #195): the request
// enqueues a `backfill_funnel_snapshots` job and returns 202 with
// the job id so the System page can poll for status / results
// instead of blocking the HTTP request for what may be tens of
// minutes on an established workspace. Concurrent requests are
// coalesced (only one in-flight backfill platform-wide), mirroring
// the cleanup card pattern.
// ─────────────────────────────────────────────────────────────────────

router.post(
  "/platform/funnel/backfill",
  requirePlatformAdmin,
  async (req, res) => {
    const body = (req.body ?? {}) as { orgId?: string | null };
    const trimmed =
      typeof body.orgId === "string" ? body.orgId.trim() : "";
    const orgId = trimmed.length > 0 ? trimmed : null;
    const job = await ensureBackfillFunnelSnapshotsJobScheduled(orgId);
    if (!job) {
      // A backfill is already pending or running. Find and return it
      // so the UI can poll instead of blocking the operator on a
      // duplicate enqueue. Same shape as the cleanup endpoints.
      const [existing] = await db
        .select({ id: jobsTable.id, status: jobsTable.status })
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.kind, "backfill_funnel_snapshots"),
            sql`${jobsTable.status} IN ('pending', 'running')`,
          ),
        )
        .orderBy(desc(jobsTable.enqueuedAt))
        .limit(1);
      res.status(202).json({
        jobId: existing?.id ?? null,
        status: existing?.status ?? "pending",
        reused: true,
      });
      req.log.info(
        { jobId: existing?.id ?? null, requestedOrgId: orgId },
        "Reused in-flight backfill_funnel_snapshots for manual request",
      );
      return;
    }
    req.log.info(
      { jobId: job.id, orgId },
      "Enqueued backfill_funnel_snapshots from manual request",
    );
    res.status(202).json({
      jobId: job.id,
      status: job.status,
      reused: false,
    });
  },
);

/**
 * Backfill status — returns the most recent
 * `backfill_funnel_snapshots` row (regardless of status) plus the id
 * of any in-flight run, so the System page can render the per-tenant
 * report from `lastJob.result` once the worker finishes and poll
 * `activeJobId` while the job is still running. Mirrors the
 * `/system/cleanup/funnel-snapshots/status` shape.
 */
router.get(
  "/platform/funnel/backfill/status",
  requirePlatformAdmin,
  async (_req, res) => {
    const [last] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.kind, "backfill_funnel_snapshots"))
      .orderBy(desc(jobsTable.enqueuedAt))
      .limit(1);

    const [active] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.kind, "backfill_funnel_snapshots"),
          sql`${jobsTable.status} IN ('pending', 'running')`,
        ),
      )
      .limit(1);

    res.json({
      lastJob: last
        ? {
            id: last.id,
            status: last.status,
            enqueuedAt: last.enqueuedAt,
            startedAt: last.startedAt,
            completedAt: last.completedAt,
            result: last.result ?? null,
            error: last.error,
            payload: last.payload ?? null,
          }
        : null,
      activeJobId: active?.id ?? null,
    });
  },
);

export default router;
