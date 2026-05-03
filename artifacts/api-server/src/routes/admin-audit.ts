import { Router, type IRouter } from "express";
import { db, adminAuditLogTable } from "@workspace/db";
import { and, eq, desc, sql, type SQL } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission, resolveRbacContext } from "../lib/rbac";
import { writeAdminAudit } from "../lib/admin-audit";

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

/**
 * Tamper-evident append-only enforcement for the admin audit log.
 *
 * UAT v2 §3 (D-19) requires that PATCH / DELETE on /api/admin/audit/:id
 * MUST return 403 *and* generate a new audit row recording the failed
 * attempt. The point is observability: a probe of the audit surface
 * leaves a trail an auditor can see, instead of being silently dropped
 * as a 404.
 *
 * The DB-level trigger installed by `bootstrapAuditLogImmutability`
 * is the second line of defense — even a direct SQL UPDATE/DELETE by
 * the app role is rejected by Postgres.
 */
async function recordMutationAttempt(
  req: import("express").Request,
  verb: "PATCH" | "DELETE",
  targetId: string,
): Promise<void> {
  const orgId = requireOrgId(req);
  let actor = req.actorEmail ?? "unknown@procuro.ai";
  let roles: string[] = [];
  try {
    const ctx = await resolveRbacContext(req);
    actor = ctx.email || actor;
    roles = ctx.roles;
  } catch {
    // RBAC context resolution failed — still record the attempt with
    // whatever actor info the tenant middleware attached.
  }
  await writeAdminAudit({
    orgId,
    actor,
    action: "audit.mutation_attempt_blocked",
    targetId,
    targetLabel: `${verb} /api/admin/audit/${targetId}`,
    metadata: {
      verb,
      path: req.originalUrl,
      authMode: req.authMode ?? null,
      roles,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    },
  });
}

const APPEND_ONLY_BODY = {
  error: "Forbidden",
  reason: "audit_log_append_only",
  message:
    "The admin audit log is append-only. PATCH and DELETE are not " +
    "permitted; this attempt has been recorded as a new audit row.",
} as const;

router.patch(
  "/admin/audit/:id",
  tenantMiddleware,
  async (req, res, next) => {
    try {
      await recordMutationAttempt(req, "PATCH", String(req.params["id"]));
      res.status(403).json(APPEND_ONLY_BODY);
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/admin/audit/:id",
  tenantMiddleware,
  async (req, res, next) => {
    try {
      await recordMutationAttempt(req, "DELETE", String(req.params["id"]));
      res.status(403).json(APPEND_ONLY_BODY);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
