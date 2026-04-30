import { Router, type IRouter } from "express";
import { db, adminAuditLogTable } from "@workspace/db";
import { and, eq, desc, sql, type SQL } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";

const router: IRouter = Router();

const PAGE_LIMIT_MAX = 200;
const CSV_EXPORT_LIMIT = 10_000;

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function buildFilters(
  orgId: string,
  query: Record<string, unknown>,
): SQL[] {
  const filters: SQL[] = [eq(adminAuditLogTable.orgId, orgId)];
  if (typeof query["actor"] === "string" && query["actor"]) {
    filters.push(eq(adminAuditLogTable.actor, String(query["actor"])));
  }
  if (typeof query["action"] === "string" && query["action"]) {
    filters.push(eq(adminAuditLogTable.action, String(query["action"])));
  }
  if (typeof query["targetId"] === "string" && query["targetId"]) {
    filters.push(
      eq(adminAuditLogTable.targetId, String(query["targetId"])),
    );
  }
  return filters;
}

router.get(
  "/admin/audit-log",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const limit = parseLimit(req.query["limit"], 100, PAGE_LIMIT_MAX);
    const filters = buildFilters(orgId, req.query as Record<string, unknown>);

    const rows = await db
      .select()
      .from(adminAuditLogTable)
      .where(and(...filters))
      .orderBy(desc(adminAuditLogTable.createdAt))
      .limit(limit);

    res.json(
      rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        targetId: r.targetId,
        targetLabel: r.targetLabel,
        metadata: r.metadata,
        createdAt: r.createdAt,
      })),
    );
  },
);

function escapeCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get(
  "/admin/audit-log/export.csv",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const filters = buildFilters(orgId, req.query as Record<string, unknown>);

    const rows = await db
      .select()
      .from(adminAuditLogTable)
      .where(and(...filters))
      .orderBy(desc(adminAuditLogTable.createdAt))
      .limit(CSV_EXPORT_LIMIT);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="admin-audit-${orgId}.csv"`,
    );
    res.write(
      ["createdAt", "actor", "action", "targetId", "targetLabel", "metadata"]
        .map(escapeCsv)
        .join(",") + "\n",
    );
    for (const r of rows) {
      res.write(
        [
          r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
          r.actor,
          r.action,
          r.targetId,
          r.targetLabel,
          r.metadata,
        ]
          .map(escapeCsv)
          .join(",") + "\n",
      );
    }
    res.end();
  },
);

router.get(
  "/admin/audit-log/actions",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const rows = await db
      .select({
        action: adminAuditLogTable.action,
        cnt: sql<number>`count(*)::int`,
      })
      .from(adminAuditLogTable)
      .where(eq(adminAuditLogTable.orgId, orgId))
      .groupBy(adminAuditLogTable.action);
    res.json(rows.map((r) => ({ action: r.action, count: Number(r.cnt) })));
  },
);

export default router;
