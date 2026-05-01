/**
 * Today aggregator (#199 step 4 path b, extended in #204).
 *
 * Thin server-side composition of existing handlers into a single
 * landing feed for the operator's morning. Per-source failures are
 * captured into `errors[]` and `partial` is set true rather than
 * failing the whole response — the daily flow must not stop because
 * one upstream source is down.
 *
 * Six sources today, each contributing one feed item by `kind`:
 *   1. `alerts.summary`             — open critical/high alert counts
 *   2. `opportunities.proposed`     — top proposed-bucket savings
 *   3. `jobs.failed`                — last-24h failed jobs
 *   4. `approvals.pending`          — count of pending approvals
 *   5. `funnel.auto_annotations`    — recent stage_drop/spike annotations
 *      from the funnel substrate (#185)
 *   6. `funnel.conversion_deltas`   — per-transition conversion-rate
 *      diff between the two most recent funnel snapshots
 *
 * No persistence; per-request cache only. Each call hits the database
 * fresh.
 */
import { Router, type IRouter, type Request } from "express";
import { db, alertsTable, opportunitiesTable, jobsTable } from "@workspace/db";
import { and, eq, desc, gte, sql } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import {
  getRecentAutoAnnotations,
  getCycleConversionRateDeltas,
} from "../lib/ooda/funnel";

type FeedItem = {
  kind: string;
  source: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  severity: "info" | "warn" | "error";
};

type FeedResponse = {
  items: FeedItem[];
  partial: boolean;
  errors: Array<{ source: string; error: string }>;
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

router.get("/today/feed", tenantMiddleware, async (req: Request, res) => {
  const orgId = requireOrgId(req);
  const items: FeedItem[] = [];
  const errors: Array<{ source: string; error: string }> = [];
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Alerts summary (open + critical/high)
  await safe(
    "getAlertsSummary",
    async () => {
      const rows = await db
        .select({
          state: alertsTable.state,
          severity: alertsTable.severity,
          n: sql<number>`COUNT(*)::int`,
        })
        .from(alertsTable)
        .where(eq(alertsTable.orgId, orgId))
        .groupBy(alertsTable.state, alertsTable.severity);

      let openCriticalOrHigh = 0;
      let openTotal = 0;
      for (const r of rows) {
        if (r.state === "open") {
          openTotal += r.n;
          if (r.severity === "high" || r.severity === "critical") {
            openCriticalOrHigh += r.n;
          }
        }
      }
      items.push({
        kind: "alerts.summary",
        source: "getAlertsSummary",
        payload: { openTotal, openCriticalOrHigh },
        occurredAt: now.toISOString(),
        severity: openCriticalOrHigh > 0 ? "warn" : "info",
      });
    },
    errors,
  );

  // 2. Proposed-bucket opportunities (top 5 by projected savings)
  await safe(
    "listOpportunities",
    async () => {
      const rows = await db
        .select({
          id: opportunitiesTable.id,
          leverId: opportunitiesTable.leverId,
          projectedSavingsUsd: opportunitiesTable.projectedSavingsUsd,
          createdAt: opportunitiesTable.createdAt,
        })
        .from(opportunitiesTable)
        .where(
          and(
            eq(opportunitiesTable.orgId, orgId),
            eq(opportunitiesTable.status, "proposed"),
          ),
        )
        .orderBy(desc(opportunitiesTable.projectedSavingsUsd))
        .limit(5);
      items.push({
        kind: "opportunities.proposed",
        source: "listOpportunities",
        payload: { count: rows.length, top: rows },
        occurredAt: now.toISOString(),
        severity: "info",
      });
    },
    errors,
  );

  // 3. Recently failed jobs (last 24h)
  await safe(
    "listJobs",
    async () => {
      const rows = await db
        .select({
          id: jobsTable.id,
          kind: jobsTable.kind,
          error: jobsTable.error,
          completedAt: jobsTable.completedAt,
        })
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.orgId, orgId),
            eq(jobsTable.status, "failed"),
            gte(jobsTable.completedAt, last24h),
          ),
        )
        .orderBy(desc(jobsTable.completedAt))
        .limit(10);
      items.push({
        kind: "jobs.failed",
        source: "listJobs",
        payload: { count: rows.length, recent: rows },
        occurredAt: now.toISOString(),
        severity: rows.length > 0 ? "warn" : "info",
      });
    },
    errors,
  );

  // 4. Pending approvals = opportunities still in 'proposed' (no separate
  // approvals table; the proposed bucket *is* the approvals queue).
  await safe(
    "approvalsPending",
    async () => {
      const [row] = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(opportunitiesTable)
        .where(
          and(
            eq(opportunitiesTable.orgId, orgId),
            eq(opportunitiesTable.status, "proposed"),
          ),
        );
      const n = row?.n ?? 0;
      items.push({
        kind: "approvals.pending",
        source: "approvalsPending",
        payload: { pending: n },
        occurredAt: now.toISOString(),
        severity: "info",
      });
    },
    errors,
  );

  // 5. Recent auto-annotations from the funnel substrate (#185 → #204).
  // These are "what changed since yesterday" deltas the substrate's
  // delta detector emitted post-snapshot. Operator notes are excluded —
  // the today feed is for substrate-emitted signals, not free-form
  // engine-page commentary.
  await safe(
    "funnelAutoAnnotations",
    async () => {
      const annotations = await getRecentAutoAnnotations(orgId, { limit: 10 });
      // `stage_drop` is operator-meaningful (the funnel got worse) so we
      // surface it as `warn`; spikes and other kinds are informational.
      const hasDrop = annotations.some((a) => a.kind === "stage_drop");
      items.push({
        kind: "funnel.auto_annotations",
        source: "funnelAutoAnnotations",
        payload: { count: annotations.length, recent: annotations },
        occurredAt: now.toISOString(),
        severity: hasDrop ? "warn" : "info",
      });
    },
    errors,
  );

  // 6. Conversion-rate deltas between the two most recent funnel
  // snapshots. Empty `transitions` (fewer than two snapshots) is a
  // legitimate "insufficient history" state, not an error — the UI
  // renders it as a hint.
  await safe(
    "funnelConversionDeltas",
    async () => {
      const result = await getCycleConversionRateDeltas(orgId);
      // Treat any negative delta as a warn — the funnel got worse on at
      // least one transition vs the previous cycle.
      const hasNegative = result.transitions.some(
        (t) => t.delta !== null && t.delta < 0,
      );
      items.push({
        kind: "funnel.conversion_deltas",
        source: "funnelConversionDeltas",
        payload: { ...result },
        occurredAt: now.toISOString(),
        severity: hasNegative ? "warn" : "info",
      });
    },
    errors,
  );

  const response: FeedResponse = {
    items,
    partial: errors.length > 0,
    errors,
  };
  // Mark intent: per-request only, no shared cache, no CDN.
  res.setHeader("Cache-Control", "private, no-store");
  res.json(response);
});

export default router;
