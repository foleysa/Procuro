import { Router, type IRouter } from "express";
import { db, a11yScanResultsTable } from "@workspace/db";
import { and, desc, gte, lt, sql, eq, count, sum } from "drizzle-orm";
import { tenantMiddleware } from "../lib/tenant";
import { requireRole } from "../lib/rbac";
import crypto from "node:crypto";

const router: IRouter = Router();

const MAX_TREND_DAYS = 90;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_TREND_DAYS = 30;

function parseDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TREND_DAYS;
  return Math.min(Math.floor(n), MAX_TREND_DAYS);
}

router.post(
  "/admin/a11y/ingest",
  tenantMiddleware,
  requireRole("platform_admin"),
  async (req, res): Promise<void> => {
    const body = req.body;

    if (!body || !Array.isArray(body.results)) {
      res.status(400).json({ error: "Body must contain a `results` array." });
      return;
    }

    const runId = body.runId ?? crypto.randomUUID();
    const scannedAt = body.scannedAt ? new Date(body.scannedAt) : new Date();

    const rows = [];
    for (const r of body.results) {
      if (!r.route || !r.routeName || !Array.isArray(r.violations)) continue;

      const violations: Array<{
        id: string;
        impact: string;
        description: string;
        helpUrl: string;
        nodeCount: number;
      }> = [];

      let criticalCount = 0;
      let seriousCount = 0;
      let moderateCount = 0;
      let minorCount = 0;
      let totalNodes = 0;

      for (const v of r.violations) {
        const nodeCount = Array.isArray(v.nodes) ? v.nodes.length : 0;
        totalNodes += nodeCount;
        violations.push({
          id: v.id,
          impact: v.impact ?? "minor",
          description: v.description ?? "",
          helpUrl: v.helpUrl ?? "",
          nodeCount,
        });
        switch (v.impact) {
          case "critical":
            criticalCount++;
            break;
          case "serious":
            seriousCount++;
            break;
          case "moderate":
            moderateCount++;
            break;
          default:
            minorCount++;
        }
      }

      rows.push({
        id: crypto.randomUUID(),
        runId,
        scannedAt,
        route: r.route,
        routeName: r.routeName,
        totalViolations: r.violations.length,
        criticalCount,
        seriousCount,
        moderateCount,
        minorCount,
        newCount: r.newCount ?? 0,
        baselinedCount: r.baselinedCount ?? 0,
        totalNodes,
        violations,
      });
    }

    if (rows.length > 0) {
      await db.insert(a11yScanResultsTable).values(rows);
    }

    res.status(201).json({ runId, inserted: rows.length });
  },
);

router.get(
  "/admin/a11y/runs",
  tenantMiddleware,
  requireRole("platform_admin"),
  async (req, res): Promise<void> => {
    const days = parseDays(req.query["days"]);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const runs = await db
      .select({
        runId: a11yScanResultsTable.runId,
        scannedAt: sql<string>`MIN(${a11yScanResultsTable.scannedAt})`.as(
          "scannedAt",
        ),
        routeCount: count(a11yScanResultsTable.id).as("routeCount"),
        totalViolations:
          sum(a11yScanResultsTable.totalViolations).as("totalViolations"),
        criticalCount:
          sum(a11yScanResultsTable.criticalCount).as("criticalCount"),
        seriousCount:
          sum(a11yScanResultsTable.seriousCount).as("seriousCount"),
        moderateCount:
          sum(a11yScanResultsTable.moderateCount).as("moderateCount"),
        minorCount: sum(a11yScanResultsTable.minorCount).as("minorCount"),
        newCount: sum(a11yScanResultsTable.newCount).as("newCount"),
        baselinedCount:
          sum(a11yScanResultsTable.baselinedCount).as("baselinedCount"),
      })
      .from(a11yScanResultsTable)
      .where(gte(a11yScanResultsTable.scannedAt, since))
      .groupBy(a11yScanResultsTable.runId)
      .orderBy(sql`MIN(${a11yScanResultsTable.scannedAt}) DESC`);

    res.json({
      windowDays: days,
      runs: runs.map((r) => ({
        runId: r.runId,
        scannedAt: r.scannedAt,
        routeCount: Number(r.routeCount),
        totalViolations: Number(r.totalViolations),
        criticalCount: Number(r.criticalCount),
        seriousCount: Number(r.seriousCount),
        moderateCount: Number(r.moderateCount),
        minorCount: Number(r.minorCount),
        newCount: Number(r.newCount),
        baselinedCount: Number(r.baselinedCount),
      })),
    });
  },
);

router.get(
  "/admin/a11y/trend",
  tenantMiddleware,
  requireRole("platform_admin"),
  async (req, res): Promise<void> => {
    const days = parseDays(req.query["days"]);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        runId: a11yScanResultsTable.runId,
        scannedAt: sql<string>`MIN(${a11yScanResultsTable.scannedAt})`.as(
          "scannedAt",
        ),
        totalViolations:
          sum(a11yScanResultsTable.totalViolations).as("totalViolations"),
        criticalCount:
          sum(a11yScanResultsTable.criticalCount).as("criticalCount"),
        seriousCount:
          sum(a11yScanResultsTable.seriousCount).as("seriousCount"),
        moderateCount:
          sum(a11yScanResultsTable.moderateCount).as("moderateCount"),
        minorCount: sum(a11yScanResultsTable.minorCount).as("minorCount"),
        newCount: sum(a11yScanResultsTable.newCount).as("newCount"),
        baselinedCount:
          sum(a11yScanResultsTable.baselinedCount).as("baselinedCount"),
        totalNodes: sum(a11yScanResultsTable.totalNodes).as("totalNodes"),
      })
      .from(a11yScanResultsTable)
      .where(gte(a11yScanResultsTable.scannedAt, since))
      .groupBy(a11yScanResultsTable.runId)
      .orderBy(sql`MIN(${a11yScanResultsTable.scannedAt}) ASC`);

    res.json({
      windowDays: days,
      points: rows.map((r) => ({
        runId: r.runId,
        scannedAt: r.scannedAt,
        totalViolations: Number(r.totalViolations),
        criticalCount: Number(r.criticalCount),
        seriousCount: Number(r.seriousCount),
        moderateCount: Number(r.moderateCount),
        minorCount: Number(r.minorCount),
        newCount: Number(r.newCount),
        baselinedCount: Number(r.baselinedCount),
        totalNodes: Number(r.totalNodes),
      })),
    });
  },
);

router.get(
  "/admin/a11y/by-route",
  tenantMiddleware,
  requireRole("platform_admin"),
  async (req, res): Promise<void> => {
    const days = parseDays(req.query["days"]);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        route: a11yScanResultsTable.route,
        routeName: a11yScanResultsTable.routeName,
        runId: a11yScanResultsTable.runId,
        scannedAt: a11yScanResultsTable.scannedAt,
        totalViolations: a11yScanResultsTable.totalViolations,
        criticalCount: a11yScanResultsTable.criticalCount,
        seriousCount: a11yScanResultsTable.seriousCount,
        moderateCount: a11yScanResultsTable.moderateCount,
        minorCount: a11yScanResultsTable.minorCount,
      })
      .from(a11yScanResultsTable)
      .where(gte(a11yScanResultsTable.scannedAt, since))
      .orderBy(a11yScanResultsTable.route, desc(a11yScanResultsTable.scannedAt));

    type ByRouteEntry = {
      route: string;
      routeName: string;
      points: Array<{
        runId: string;
        scannedAt: string;
        totalViolations: number;
        criticalCount: number;
        seriousCount: number;
        moderateCount: number;
        minorCount: number;
      }>;
    };

    const grouped = new Map<string, ByRouteEntry>();
    for (const r of rows) {
      let entry = grouped.get(r.route);
      if (!entry) {
        entry = { route: r.route, routeName: r.routeName, points: [] };
        grouped.set(r.route, entry);
      }
      entry.points.push({
        runId: r.runId,
        scannedAt:
          r.scannedAt instanceof Date
            ? r.scannedAt.toISOString()
            : new Date(r.scannedAt as unknown as string).toISOString(),
        totalViolations: r.totalViolations,
        criticalCount: r.criticalCount,
        seriousCount: r.seriousCount,
        moderateCount: r.moderateCount,
        minorCount: r.minorCount,
      });
    }
    for (const entry of grouped.values()) entry.points.reverse();

    res.json({
      windowDays: days,
      routes: Array.from(grouped.values()).sort((a, b) =>
        a.route.localeCompare(b.route),
      ),
    });
  },
);

router.delete(
  "/admin/a11y/prune",
  tenantMiddleware,
  requireRole("platform_admin"),
  async (req, res): Promise<void> => {
    const retentionDays = Math.max(1, Math.floor(Number(req.query["days"]) || DEFAULT_RETENTION_DAYS));
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const result = await db
      .delete(a11yScanResultsTable)
      .where(lt(a11yScanResultsTable.scannedAt, cutoff));

    const deleted = result.rowCount ?? 0;
    req.log.info({ retentionDays, cutoff, deleted }, "a11y scan results pruned");

    res.json({ retentionDays, cutoff: cutoff.toISOString(), deleted });
  },
);

router.get(
  "/admin/a11y/run/:runId",
  tenantMiddleware,
  requireRole("platform_admin"),
  async (req, res): Promise<void> => {
    const runId = Array.isArray(req.params.runId)
      ? req.params.runId[0]
      : req.params.runId;

    const rows = await db
      .select()
      .from(a11yScanResultsTable)
      .where(eq(a11yScanResultsTable.runId, runId))
      .orderBy(a11yScanResultsTable.route);

    if (rows.length === 0) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    res.json({
      runId,
      scannedAt:
        rows[0].scannedAt instanceof Date
          ? rows[0].scannedAt.toISOString()
          : new Date(
              rows[0].scannedAt as unknown as string,
            ).toISOString(),
      routes: rows.map((r) => ({
        route: r.route,
        routeName: r.routeName,
        totalViolations: r.totalViolations,
        criticalCount: r.criticalCount,
        seriousCount: r.seriousCount,
        moderateCount: r.moderateCount,
        minorCount: r.minorCount,
        newCount: r.newCount,
        baselinedCount: r.baselinedCount,
        totalNodes: r.totalNodes,
        violations: r.violations,
      })),
    });
  },
);

export default router;
