/**
 * Admin-only read surface for the `data_integrity_audit_log` table
 * (Task #326). The 11 reconciliation checks defined in
 * `@workspace/data-integrity` run every 15 minutes and append one row
 * per assertion per run; this router exposes:
 *
 *   - `/admin/data-integrity/latest` — newest result per assertion,
 *     used to render the pass/fail badge, family, message, and the
 *     `actual` vs `expected` payload when the row is failing.
 *   - `/admin/data-integrity/trend`  — per-assertion run-by-run
 *     pass/fail series within a trailing window (24h or 7d), used by
 *     the sparkline strip in the admin UI.
 *
 * The audit log has no `org_id` (the assertions are platform-wide),
 * so the data itself is not tenant-scoped. We still mount
 * `tenantMiddleware` first because `requireRole` resolves the RBAC
 * context against `req.orgId` — without it `resolveRbacContext`
 * short-circuits to an empty role set and the route 401s. To prevent
 * cross-tenant disclosure of platform-level audit data we restrict
 * authorization to `platform_admin` only (org admins of any tenant
 * cannot see the platform-wide audit log).
 */
import { Router, type IRouter } from "express";
import { db, dataIntegrityAuditLogTable } from "@workspace/db";
import { and, desc, gte, sql } from "drizzle-orm";
import { tenantMiddleware } from "../lib/tenant";
import { requireRole } from "../lib/rbac";

const router: IRouter = Router();

const MAX_TREND_HOURS = 24 * 7; // one week
const DEFAULT_TREND_HOURS = 24;

function parseHours(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TREND_HOURS;
  return Math.min(Math.floor(n), MAX_TREND_HOURS);
}

router.get(
  "/admin/data-integrity/latest",
  tenantMiddleware,
  requireRole("platform_admin"),
  async (_req, res) => {
    // DISTINCT ON (assertion_name) ORDER BY assertion_name, run_at DESC
    // gives us the freshest row per assertion in a single index-friendly
    // pass against `data_integrity_assertion_run_idx`.
    const rows = await db.execute<{
      id: string;
      assertion_name: string;
      family: string;
      passed: boolean;
      actual: Record<string, unknown> | null;
      expected: string;
      message: string;
      triggered_by: string;
      run_at: Date;
    }>(sql`
      SELECT DISTINCT ON (assertion_name)
        id, assertion_name, family, passed, actual, expected, message,
        triggered_by, run_at
      FROM data_integrity_audit_log
      ORDER BY assertion_name, run_at DESC
    `);
    res.json(
      rows.rows.map((r) => ({
        id: r.id,
        assertionName: r.assertion_name,
        family: r.family,
        passed: r.passed,
        actual: r.actual ?? {},
        expected: r.expected,
        message: r.message,
        triggeredBy: r.triggered_by,
        runAt:
          r.run_at instanceof Date
            ? r.run_at.toISOString()
            : new Date(r.run_at as unknown as string).toISOString(),
      })),
    );
  },
);

router.get(
  "/admin/data-integrity/trend",
  tenantMiddleware,
  requireRole("platform_admin"),
  async (req, res) => {
    const hours = parseHours(req.query["hours"]);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const rows = await db
      .select({
        assertionName: dataIntegrityAuditLogTable.assertionName,
        family: dataIntegrityAuditLogTable.family,
        passed: dataIntegrityAuditLogTable.passed,
        runAt: dataIntegrityAuditLogTable.runAt,
      })
      .from(dataIntegrityAuditLogTable)
      .where(and(gte(dataIntegrityAuditLogTable.runAt, since)))
      .orderBy(desc(dataIntegrityAuditLogTable.runAt));

    // Group oldest→newest per assertion so the sparkline reads
    // left-to-right chronologically.
    const grouped = new Map<
      string,
      {
        assertionName: string;
        family: string;
        points: Array<{ runAt: string; passed: boolean }>;
      }
    >();
    for (const r of rows) {
      const key = r.assertionName;
      let entry = grouped.get(key);
      if (!entry) {
        entry = {
          assertionName: r.assertionName,
          family: r.family,
          points: [],
        };
        grouped.set(key, entry);
      }
      entry.points.push({
        runAt:
          r.runAt instanceof Date
            ? r.runAt.toISOString()
            : new Date(r.runAt as unknown as string).toISOString(),
        passed: r.passed,
      });
    }
    for (const entry of grouped.values()) entry.points.reverse();

    res.json({
      windowHours: hours,
      assertions: Array.from(grouped.values()).sort((a, b) =>
        a.assertionName.localeCompare(b.assertionName),
      ),
    });
  },
);

export default router;
