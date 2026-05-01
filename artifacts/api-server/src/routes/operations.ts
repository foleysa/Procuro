/**
 * Operations health aggregator (#199, step 5).
 *
 * Single thin endpoint that admins land on at /operations and that the
 * Operations sidebar group's other surfaces drill into. Composes
 * collectors (registry status + kill switch), jobs (last 24h status
 * mix), erp connections (data sources), and the funnel snapshot
 * failures rollup into one fail-soft response.
 *
 * Per-source failures populate `errors[]` and set `partial=true`. No
 * persistence. Tenant-scoped via `tenantMiddleware`.
 */
import { Router, type IRouter, type Request } from "express";
import {
  db,
  collectorsTable,
  jobsTable,
  erpConnectionsTable,
  funnelSnapshotFailuresTable,
} from "@workspace/db";
import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requireRole } from "../lib/rbac";

type FeedItem = {
  kind: string;
  source: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  severity: "info" | "warn" | "error";
};

const router: IRouter = Router();

async function safe<T>(
  source: string,
  fn: () => Promise<T>,
  errors: Array<{ source: string; error: string }>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    errors.push({
      source,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

router.get(
  "/operations/health",
  tenantMiddleware,
  // Operations health surfaces admin-oriented signals (collectors,
  // jobs, integrations, funnel pipeline failures). Gate it to org/platform
  // admins so non-admin authenticated users cannot pull operational
  // summaries via direct URL access — the sidebar already hides the
  // entry, but the endpoint must enforce on its own.
  requireRole("org_admin", "platform_admin"),
  async (req: Request, res) => {
  const orgId = requireOrgId(req);
  const items: FeedItem[] = [];
  const errors: Array<{ source: string; error: string }> = [];
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Collectors registry summary (cross-tenant — collectors are platform-level).
  await safe(
    "listCollectors",
    async () => {
      const rows = await db
        .select({
          status: collectorsTable.status,
          killSwitch: collectorsTable.killSwitch,
          n: sql<number>`COUNT(*)::int`,
        })
        .from(collectorsTable)
        .groupBy(collectorsTable.status, collectorsTable.killSwitch);
      let approved = 0;
      let killed = 0;
      let total = 0;
      for (const r of rows) {
        total += r.n;
        if (r.killSwitch === 1) killed += r.n;
        else if (r.status === "approved") approved += r.n;
      }
      items.push({
        kind: "collectors.summary",
        source: "listCollectors",
        payload: { total, approved, killed },
        occurredAt: now.toISOString(),
        severity: killed > 0 ? "warn" : "info",
      });
    },
    errors,
  );

  // 2. Jobs status mix in last 24h (org-scoped + global cross-tenant jobs
  // surfaced via NULL org_id, which the platform admin sees too).
  await safe(
    "listJobs",
    async () => {
      const rows = await db
        .select({
          status: jobsTable.status,
          n: sql<number>`COUNT(*)::int`,
        })
        .from(jobsTable)
        .where(
          and(
            or(eq(jobsTable.orgId, orgId), isNull(jobsTable.orgId)),
            gte(jobsTable.enqueuedAt, last24h),
          ),
        )
        .groupBy(jobsTable.status);
      const byStatus: Record<string, number> = {
        pending: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      };
      for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
      }
      const failed = byStatus["failed"] ?? 0;
      items.push({
        kind: "jobs.summary",
        source: "listJobs",
        payload: { byStatus, windowHours: 24 },
        occurredAt: now.toISOString(),
        severity: failed > 0 ? "warn" : "info",
      });
    },
    errors,
  );

  // 3. ERP connections / data-source health.
  await safe(
    "listDataSources",
    async () => {
      const rows = await db
        .select({
          adapterKey: erpConnectionsTable.adapterKey,
          status: erpConnectionsTable.status,
          n: sql<number>`COUNT(*)::int`,
        })
        .from(erpConnectionsTable)
        .where(eq(erpConnectionsTable.orgId, orgId))
        .groupBy(erpConnectionsTable.adapterKey, erpConnectionsTable.status);
      const byAdapter: Record<string, Record<string, number>> = {};
      let unhealthy = 0;
      for (const r of rows) {
        const k = r.adapterKey ?? "unknown";
        byAdapter[k] ??= {};
        byAdapter[k][r.status ?? "unknown"] = r.n;
        if (r.status && r.status !== "active") {
          unhealthy += r.n;
        }
      }
      items.push({
        kind: "data_sources.summary",
        source: "listDataSources",
        payload: { byAdapter, unhealthy },
        occurredAt: now.toISOString(),
        severity: unhealthy > 0 ? "warn" : "info",
      });
    },
    errors,
  );

  // 4. Integrations summary — same erp connections table is the
  // integrations surface in this codebase. Re-emit a separate item so the
  // UI can consume a stable kind, even though the data is similar.
  await safe(
    "listIntegrations",
    async () => {
      const [row] = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(erpConnectionsTable)
        .where(eq(erpConnectionsTable.orgId, orgId));
      items.push({
        kind: "integrations.summary",
        source: "listIntegrations",
        payload: { configured: row?.n ?? 0 },
        occurredAt: now.toISOString(),
        severity: "info",
      });
    },
    errors,
  );

  // 5. Funnel snapshot failures rollup (substrate signal: when the
  // snapshot pipeline itself drops a cycle).
  await safe(
    "funnelSnapshotFailures",
    async () => {
      const rows = await db
        .select({
          errorClass: funnelSnapshotFailuresTable.errorClass,
          ackedAt: funnelSnapshotFailuresTable.ackedAt,
          n: sql<number>`COUNT(*)::int`,
        })
        .from(funnelSnapshotFailuresTable)
        .where(
          and(
            eq(funnelSnapshotFailuresTable.orgId, orgId),
            gte(funnelSnapshotFailuresTable.lastSeenAt, last24h),
          ),
        )
        .groupBy(
          funnelSnapshotFailuresTable.errorClass,
          funnelSnapshotFailuresTable.ackedAt,
        );
      let unacked = 0;
      const byClass: Record<string, number> = {};
      for (const r of rows) {
        byClass[r.errorClass] = (byClass[r.errorClass] ?? 0) + r.n;
        if (!r.ackedAt) unacked += r.n;
      }
      items.push({
        kind: "funnel.failures",
        source: "funnelSnapshotFailures",
        payload: { unacked, byClass, windowHours: 24 },
        occurredAt: now.toISOString(),
        severity: unacked > 0 ? "error" : "info",
      });
    },
    errors,
  );

  res.setHeader("Cache-Control", "private, no-store");
  res.json({ items, partial: errors.length > 0, errors });
  },
);

export default router;
