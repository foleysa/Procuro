import { Router, type IRouter } from "express";
import { db, adminAuditLogTable } from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { writeAdminAudit } from "../lib/admin-audit";

const router: IRouter = Router();

/**
 * Window the Org-Admin callout summarises. Anything older falls off the
 * widget so the list stays focused on teammates who are blocked *right
 * now*. The underlying audit rows are retained per the normal
 * `admin_audit_log` retention policy.
 */
const DENIAL_WINDOW_DAYS = 7;

/**
 * Records that the signed-in user just hit the AdminGuard "request
 * access" empty state on an admin-only route (Engine and friends, see
 * #207). Idempotent per actor per UTC day so refreshing the page or
 * navigating between admin routes doesn't spam the audit log.
 *
 * Auth: any signed-in tenant member (`read` permission). The whole
 * point is that non-admins can hit this — gating it on admin would
 * defeat the signal we're trying to capture.
 *
 * The route never returns an error in normal operation: if the audit
 * insert fails for any reason we log a warning and 204 anyway, because
 * the AdminGuard render must not be blocked on telemetry.
 */
router.post(
  "/admin/engine-access/denials",
  tenantMiddleware,
  requirePermission("read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const actor = req.actorEmail ?? "unknown@procuro.ai";
    const route =
      typeof req.body?.route === "string" ? req.body.route : "/engine";

    try {
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const [recent] = await db
        .select({ id: adminAuditLogTable.id })
        .from(adminAuditLogTable)
        .where(
          and(
            eq(adminAuditLogTable.orgId, orgId),
            eq(adminAuditLogTable.action, "engine.access_denied"),
            eq(adminAuditLogTable.actor, actor),
            gte(adminAuditLogTable.createdAt, dayStart),
          ),
        )
        .limit(1);
      if (!recent) {
        await writeAdminAudit({
          orgId,
          actor,
          action: "engine.access_denied",
          targetId: null,
          targetLabel: route,
          metadata: { route, authMode: req.authMode ?? "unknown" },
        });
      }
    } catch (err) {
      req.log.warn(
        { err, orgId, actor },
        "Failed to record engine.access_denied audit",
      );
    }

    res.status(204).end();
  },
);

/**
 * Aggregates the trailing-week `engine.access_denied` rows by actor so
 * the Org Admin Users tab can render a "N teammates requested Engine
 * access this week" callout with a one-click invite for each.
 *
 * Read permission is `users:manage` because the consumer is the admin
 * UI and the natural follow-up action (granting a role) requires the
 * same permission — keeps both surfaces consistent.
 */
router.get(
  "/admin/engine-access/denials",
  tenantMiddleware,
  requirePermission("users:manage"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const cutoff = new Date(
      Date.now() - DENIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const rows = await db
      .select({
        actor: adminAuditLogTable.actor,
        count: sql<number>`count(*)::int`,
        firstAt: sql<Date>`min(${adminAuditLogTable.createdAt})`,
        lastAt: sql<Date>`max(${adminAuditLogTable.createdAt})`,
      })
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, orgId),
          eq(adminAuditLogTable.action, "engine.access_denied"),
          gte(adminAuditLogTable.createdAt, cutoff),
        ),
      )
      .groupBy(adminAuditLogTable.actor)
      .orderBy(desc(sql`max(${adminAuditLogTable.createdAt})`));

    res.json({
      windowDays: DENIAL_WINDOW_DAYS,
      denials: rows.map((r) => ({
        actor: r.actor,
        count: Number(r.count),
        firstAt: r.firstAt,
        lastAt: r.lastAt,
      })),
    });
  },
);

export default router;
