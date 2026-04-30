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
  type LeverId,
} from "@workspace/db";
import { and, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { newId } from "../lib/ids";
import { getFunnelSnapshotRetentionConfig } from "../lib/jobs/queue";
import {
  captureFunnelSnapshot,
  funnelSnapshotFailuresCounter,
  backfillFunnelSnapshotsForOrg,
  backfillFunnelSnapshotsForAllTenants,
} from "../lib/ooda/funnel";
import { requirePlatformAdmin } from "../lib/platform-admin";
import { ALL_LEVERS } from "../lib/levers";
import { toAnalyzeResult, type LeverAnalyzer } from "../lib/levers/types";
import { loadPriors } from "../lib/ooda/priors";

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
    const retention = getFunnelSnapshotRetentionConfig();

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
    if (!row) return res.status(404).json({ error: "not_found" });
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
    if (!cycle) return res.status(404).json({ error: "cycle_not_found" });

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
    });
    if (result.failed) {
      return res.status(500).json({ error: "snapshot_capture_failed" });
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
      return res
        .status(400)
        .json({ error: "snapshotId_and_summary_required" });
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
    if (!snap) return res.status(404).json({ error: "snapshot_not_found" });

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
    if (!row) return res.status(404).json({ error: "not_found" });
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
    if (!row) return res.status(404).json({ error: "not_found" });
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
// Backfill (task #188) — fill in funnel_snapshots for cycles that
// completed before the snapshot writer shipped. Cross-tenant by design
// so a platform operator can light up the observability page for every
// established tenant in one call. Per-tenant invocation is opt-in via
// the `orgId` body field; absence means "all tenants".
//
// Long-running (proportional to historical cycle count × tenants), so
// we keep it synchronous and guarded by the platform-admin token.
// Idempotent: cycles that already have a snapshot are skipped.
// ─────────────────────────────────────────────────────────────────────

router.post(
  "/platform/funnel/backfill",
  requirePlatformAdmin,
  async (req, res) => {
    const body = (req.body ?? {}) as { orgId?: string | null };
    const orgId =
      typeof body.orgId === "string" && body.orgId ? body.orgId : null;
    const startedAt = Date.now();
    const reports = orgId
      ? [await backfillFunnelSnapshotsForOrg(orgId, { ALL_LEVERS })]
      : await backfillFunnelSnapshotsForAllTenants({ ALL_LEVERS });
    const totals = reports.reduce(
      (acc, r) => ({
        cyclesScanned: acc.cyclesScanned + r.cyclesScanned,
        snapshotsCreated: acc.snapshotsCreated + r.snapshotsCreated,
        alreadyHadSnapshot: acc.alreadyHadSnapshot + r.alreadyHadSnapshot,
        skippedNotCompleted:
          acc.skippedNotCompleted + r.skippedNotCompleted,
        failed: acc.failed + r.failed,
      }),
      {
        cyclesScanned: 0,
        snapshotsCreated: 0,
        alreadyHadSnapshot: 0,
        skippedNotCompleted: 0,
        failed: 0,
      },
    );
    res.json({
      tenants: reports,
      totals,
      durationMs: Date.now() - startedAt,
    });
  },
);

export default router;
