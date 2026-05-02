import { Router, type IRouter } from "express";
import { db, adminAuditLogTable } from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";

const router: IRouter = Router();

/**
 * Trust Center engagement signal for the active tenant. Operators use
 * this on Org Admin to spot tenants that are actively sharing posture
 * with auditors / prospects — a high view count usually correlates
 * with an in-flight security review or live deal motion.
 *
 * The data is sourced from `admin_audit_log` rows where
 * `action = 'trust.view'`. Writes are deduped server-side (5-minute
 * window per actor), so the count here approximates "distinct view
 * sessions" rather than raw fetches.
 */
router.get(
  "/admin/trust-engagement",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [countRow] = await db
      .select({
        cnt: sql<number>`count(*)::int`,
        viewers: sql<number>`count(distinct ${adminAuditLogTable.actor})::int`,
      })
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, orgId),
          eq(adminAuditLogTable.action, "trust.view"),
          gte(adminAuditLogTable.createdAt, cutoff),
        ),
      );

    const [lastRow] = await db
      .select({
        createdAt: adminAuditLogTable.createdAt,
        actor: adminAuditLogTable.actor,
      })
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, orgId),
          eq(adminAuditLogTable.action, "trust.view"),
        ),
      )
      .orderBy(desc(adminAuditLogTable.createdAt))
      .limit(1);

    res.json({
      windowDays: 30,
      viewCount30d: Number(countRow?.cnt ?? 0),
      distinctViewers30d: Number(countRow?.viewers ?? 0),
      lastViewAt: lastRow?.createdAt ?? null,
      lastViewer: lastRow?.actor ?? null,
    });
  },
);

export default router;
