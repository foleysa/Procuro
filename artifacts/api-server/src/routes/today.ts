/**
 * Today aggregator (#199 step 4 path b, extended in #204, enriched in #209).
 *
 * Thin server-side composition of existing handlers into a single
 * landing feed for the operator's morning. Per-source failures are
 * captured into `errors[]` and `partial` is set true rather than
 * failing the whole response — the daily flow must not stop because
 * one upstream source is down.
 *
 * Six sources, each contributing one feed item by `kind`:
 *   1. `alerts.summary`             — open total, open critical/high,
 *      and the most-recent open alert (title + age) so the morning
 *      glance gives the operator a thing to act on, not just a number.
 *   2. `opportunities.proposed`     — count + the top opportunity by
 *      projected savings (lever + USD) so the card answers "is the
 *      proposed bucket worth opening this morning?"
 *   3. `jobs.failed`                — last-24h failed jobs, plus the
 *      timestamp of the most recent successful analysis cycle so a
 *      green "0 failed" card still proves the engine ran.
 *   4. `approvals.pending`          — RT-83 split: needs-action-today
 *      (proposed in the last 24h) is the primary number; total pending
 *      and oldest-age are secondary structural-backlog context.
 *   5. `funnel.auto_annotations`    — recent stage_drop/spike annotations
 *      from the funnel substrate (#185, surfaced by #204).
 *   6. `funnel.conversion_deltas`   — per-transition conversion-rate
 *      diff between the two most recent funnel snapshots (#204).
 *
 * Alerts query uses the #117 alerts schema directly: only rows with
 * `state = 'open'` are counted as open. Acknowledged and snoozed
 * alerts are intentionally excluded — Today surfaces the unattended
 * queue, not all unresolved alerts. The earlier #209 workaround
 * (filtering on `resolved_at IS NULL`) was retired in #248 once the
 * dev DB was reconciled with the schema source-of-truth.
 *
 * No persistence; per-request cache only. Each call hits the database
 * fresh.
 */
import { Router, type IRouter, type Request } from "express";
import {
  db,
  alertsTable,
  opportunitiesTable,
  jobsTable,
  analysisCyclesTable,
} from "@workspace/db";
import { and, eq, desc, gte, sql } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { resolveRbacContext } from "../lib/rbac";
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

/**
 * Server-side error scrubber (#209 review fix).
 *
 * The original #209 patch put the scrubber on the client only, but the
 * /api/today/feed response payload still shipped raw `errors[].error`
 * strings to ALL callers — meaning a non-admin viewing devtools could
 * see SQL fragments, file paths, and stack frames even though the UI
 * hid them. Defense-in-depth: scrub at the network boundary, then the
 * UI scrubs again as a second layer.
 *
 * This is intentionally a copy of the rules in
 * `artifacts/command-center/src/lib/scrub-error.ts`. The two should
 * stay in lockstep until #204 ships and we promote the scrubber into
 * a shared `lib/safe-error/` package. The denylist is a stopgap; the
 * long-term fix is a template-allowlist (only ship error strings drawn
 * from a known-safe registry). Documented in `replit.md`.
 *
 * Side effect of this fix: the admin-only `<details>` disclosure on
 * the Today page is no longer load-bearing — the client never sees
 * the unscrubbed text. We keep the disclosure UI in place because the
 * scrubbed text is itself useful debugging context for admins, but
 * "what happened?" no longer reveals raw internals to anyone.
 */
const SQL_KEYWORD_RE =
  /\b(?:select|from|where|group\s+by|order\s+by|join|insert|update|delete|values|returning)\b/gi;
const DOLLAR_PARAM_RE = /\$\d+/g;
const PARAMS_BLOB_RE = /\bparams\s*:\s*[^]*$/i;
const FILE_PATH_RE = /(?:[A-Za-z]:)?(?:\/|\\)[^\s)]+\.(?:ts|tsx|js|mjs|cjs)/g;
const STACK_FRAME_RE = /\bat\s+[A-Za-z_$][\w$.]*\s*\([^)]*\)/g;
const FAILED_QUERY_RE = /\bFailed\s+query:\s*[^\n]*/gi;

function scrubServerError(raw: string): string {
  let s = raw;
  s = s.replace(FAILED_QUERY_RE, "");
  s = s.replace(PARAMS_BLOB_RE, "");
  s = s.replace(STACK_FRAME_RE, "");
  s = s.replace(FILE_PATH_RE, "");
  s = s.replace(SQL_KEYWORD_RE, "");
  s = s.replace(DOLLAR_PARAM_RE, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, "");
  if (s.length === 0) return "Source unavailable.";
  return s;
}

async function safe<T>(
  source: string,
  fn: () => Promise<T>,
  errors: Array<{ source: string; error: string }>,
  log: { error: (...args: unknown[]) => void },
  // Admin gate: when the caller is org_admin/platform_admin, we
  // PRESERVE the raw error text in the response so the client-side
  // <details>"What happened?" disclosure can show the real technical
  // detail to the operator who is actually allowed to see it. For
  // every other caller we scrub at the network boundary so raw SQL /
  // file paths / stack frames never reach a non-admin browser.
  // The client also runs scrubError() at render time, so non-admin
  // UIs get defense-in-depth even if a downstream caller bypasses
  // this gate.
  callerIsAdmin: boolean,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    // Log the FULL unscrubbed error to server logs for ops/observability,
    // regardless of role.
    log.error({ source, err: e }, "today.feed source failed");
    const raw = e instanceof Error ? e.message : String(e);
    errors.push({
      source,
      error: callerIsAdmin ? raw : scrubServerError(raw),
    });
    return null;
  }
}

/**
 * Fail-soft enrichment wrapper. A missing/failed inner enrichment must
 * never break the outer card — the card silently degrades to its
 * number-only rendering (which the client capability-gates per RT-92).
 */
async function softEnrich<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

router.get("/today/feed", tenantMiddleware, async (req: Request, res) => {
  const orgId = requireOrgId(req);
  const items: FeedItem[] = [];
  const errors: Array<{ source: string; error: string }> = [];
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Network-boundary scrubbing of `errors[].error` is gated on caller
  // role: admins (org_admin, platform_admin) get the raw text so the
  // client's `<details>` "What happened?" disclosure can show the
  // original technical detail to the operator authorized to see it;
  // every other role gets scrubbed text. The client also runs its own
  // scrubError() at render time as defense-in-depth.
  const rbac = await resolveRbacContext(req);
  const callerIsAdmin = rbac.roles.some(
    (r) => r === "org_admin" || r === "platform_admin",
  );

  // 1. Alerts summary (open + critical/high) — schema-drift-safe.
  await safe(
    "getAlertsSummary",
    async () => {
      // Group only by `severity`; "open" derived from `resolved_at IS NULL`.
      // Both columns exist in BOTH the legacy and the #117 schema.
      const rows = await db
        .select({
          severity: alertsTable.severity,
          n: sql<number>`COUNT(*)::int`,
        })
        .from(alertsTable)
        .where(
          and(
            eq(alertsTable.orgId, orgId),
            eq(alertsTable.state, "open"),
          ),
        )
        .groupBy(alertsTable.severity);

      let openCriticalOrHigh = 0;
      let openTotal = 0;
      for (const r of rows) {
        openTotal += r.n;
        if (r.severity === "high" || r.severity === "critical") {
          openCriticalOrHigh += r.n;
        }
      }

      // Top open alert: most-recent `resolved_at IS NULL`. Independently
      // fail-soft so a missing index or empty table never collapses the
      // outer count.
      const topAlert = await softEnrich(async () => {
        const top = await db
          .select({
            id: alertsTable.id,
            title: alertsTable.title,
            severity: alertsTable.severity,
            createdAt: alertsTable.createdAt,
          })
          .from(alertsTable)
          .where(
            and(
              eq(alertsTable.orgId, orgId),
              eq(alertsTable.state, "open"),
            ),
          )
          .orderBy(desc(alertsTable.createdAt))
          .limit(1);
        if (top.length === 0) return null;
        const r = top[0]!;
        return {
          id: r.id,
          title: r.title,
          severity: r.severity,
          ageMs: Math.max(0, now.getTime() - new Date(r.createdAt).getTime()),
        };
      });

      items.push({
        kind: "alerts.summary",
        source: "getAlertsSummary",
        payload: {
          openTotal,
          openCriticalOrHigh,
          ...(topAlert ? { topAlert } : {}),
        },
        occurredAt: now.toISOString(),
        severity: openCriticalOrHigh > 0 ? "warn" : "info",
      });
    },
    errors,
    req.log,
    callerIsAdmin,
  );

  // 2. Proposed-bucket opportunities (top 5 by projected savings).
  // Enrichment: explicitly stamp the top opportunity's lever and
  // savings on the payload root so the client doesn't have to grovel
  // through `top[0]` (which is shape-coupled to the listing query).
  await safe(
    "listOpportunities",
    async () => {
      const rows = await db
        .select({
          id: opportunitiesTable.id,
          title: opportunitiesTable.title,
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

      // The list query already returns the top 5 sorted by USD; pull
      // the head as the named-context "top". Casting to number guards
      // against drivers that return numerics as strings.
      const head = rows[0];
      const topOpp = head
        ? {
            id: head.id,
            title: head.title,
            leverId: head.leverId,
            projectedSavingsUsd: Number(head.projectedSavingsUsd),
          }
        : null;

      items.push({
        kind: "opportunities.proposed",
        source: "listOpportunities",
        payload: {
          count: rows.length,
          top: rows,
          ...(topOpp ? { topOpportunity: topOpp } : {}),
        },
        occurredAt: now.toISOString(),
        severity: "info",
      });
    },
    errors,
    req.log,
    callerIsAdmin,
  );

  // 3. Recently failed jobs (last 24h). Enrichment: when zero failed,
  // attach the most-recent successful analysis-cycle timestamp so a
  // green card still proves the engine ran.
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

      const topFailed = rows[0]
        ? {
            kind: rows[0].kind,
            ageMs: Math.max(
              0,
              now.getTime() -
                new Date(rows[0].completedAt ?? now).getTime(),
            ),
          }
        : null;

      // Last successful cycle — used as the "0 failed · last cycle ran
      // 47m ago" reassurance line. Independently fail-soft.
      const lastCycle = await softEnrich(async () => {
        const row = await db
          .select({
            generation: analysisCyclesTable.generation,
            completedAt: analysisCyclesTable.completedAt,
          })
          .from(analysisCyclesTable)
          .where(
            and(
              eq(analysisCyclesTable.orgId, orgId),
              eq(analysisCyclesTable.status, "completed"),
            ),
          )
          .orderBy(desc(analysisCyclesTable.completedAt))
          .limit(1);
        if (row.length === 0 || !row[0]!.completedAt) return null;
        return {
          generation: row[0]!.generation,
          completedAt: row[0]!.completedAt.toISOString(),
          ageMs: Math.max(
            0,
            now.getTime() - row[0]!.completedAt.getTime(),
          ),
        };
      });

      items.push({
        kind: "jobs.failed",
        source: "listJobs",
        payload: {
          count: rows.length,
          recent: rows,
          ...(topFailed ? { topFailed } : {}),
          ...(lastCycle ? { lastSuccessfulCycle: lastCycle } : {}),
        },
        occurredAt: now.toISOString(),
        severity: rows.length > 0 ? "warn" : "info",
      });
    },
    errors,
    req.log,
    callerIsAdmin,
  );

  // 4. Pending approvals = opportunities still in 'proposed' (no
  // separate approvals table; the proposed bucket *is* the approvals
  // queue). RT-83: split into the actionable "needs-action-today"
  // primary number and the structural-backlog secondary context.
  // The client renders `needsActionToday` as the headline number and
  // `pending` (total) muted underneath; the verification log lives in
  // the implementation summary.
  // RT-83: `needsActionToday` is the OPERATOR'S morning queue. It is
  // explicitly defined as the disjunction of TWO populations:
  //   (a) freshly-proposed opportunities (created in the last 24h) —
  //       new work the operator hasn't triaged yet, AND
  //   (b) opportunities aging into the soft deadline (default >7d
  //       still pending) — work the operator put off and that should
  //       no longer be ignored.
  // Implementing only (a) under-counts a real-world backlog where the
  // bulk of pending work isn't fresh — the situation we have today
  // (4080/4080 in the live data because everything was bulk-seeded
  // recently, but the moment the next cycle runs, only the new rows
  // would be "actionable" without (b)).
  // The 7-day soft deadline matches the verification log threshold;
  // the same constant is referenced in `replit.md`. If we ever need
  // it per-org, it can move to `orgs.settings`.
  const SOFT_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;
  const softDeadline = new Date(now.getTime() - SOFT_DEADLINE_MS);

  await safe(
    "approvalsPending",
    async () => {
      // Snooze gating (#220). A row is "currently snoozed" iff
      // `snoozed_until > now()`. Snoozed rows are explicitly hidden
      // from BOTH `pending` and `needsActionToday` so the operator's
      // morning queue matches what they see when they open the
      // opportunities list (which defaults to `snoozed=exclude`).
      // Reusing the SQL fragment via a constant keeps the two queries
      // in lock-step — the partial index `opps_snoozed_until_idx`
      // covers both.
      const notSnoozed = sql`(
        ${opportunitiesTable.snoozedUntil} IS NULL
        OR ${opportunitiesTable.snoozedUntil} <= now()
      )`;

      const [totalRow] = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(opportunitiesTable)
        .where(
          and(
            eq(opportunitiesTable.orgId, orgId),
            eq(opportunitiesTable.status, "proposed"),
            notSnoozed,
          ),
        );
      const pending = totalRow?.n ?? 0;

      // (a) OR (b) — single round-trip via OR-of-conditions in WHERE.
      const [todayRow] = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(opportunitiesTable)
        .where(
          and(
            eq(opportunitiesTable.orgId, orgId),
            eq(opportunitiesTable.status, "proposed"),
            notSnoozed,
            sql`(
              ${opportunitiesTable.createdAt} >= ${last24h}
              OR ${opportunitiesTable.createdAt} <= ${softDeadline}
            )`,
          ),
        );
      const needsActionToday = todayRow?.n ?? 0;

      // Oldest pending — gives the operator a sense of the backlog
      // tail without forcing them to open the page. We deliberately
      // leave snoozed rows OUT of this calculation as well so the
      // "oldest pending" age agrees with the visible queue.
      const oldest = await softEnrich(async () => {
        const [row] = await db
          .select({ createdAt: opportunitiesTable.createdAt })
          .from(opportunitiesTable)
          .where(
            and(
              eq(opportunitiesTable.orgId, orgId),
              eq(opportunitiesTable.status, "proposed"),
              notSnoozed,
            ),
          )
          .orderBy(opportunitiesTable.createdAt)
          .limit(1);
        if (!row) return null;
        return {
          oldestAgeMs: Math.max(
            0,
            now.getTime() - new Date(row.createdAt).getTime(),
          ),
        };
      });

      items.push({
        kind: "approvals.pending",
        source: "approvalsPending",
        payload: {
          pending,
          needsActionToday,
          ...(oldest ?? {}),
        },
        occurredAt: now.toISOString(),
        severity: needsActionToday > 0 ? "warn" : "info",
      });
    },
    errors,
    req.log,
    callerIsAdmin,
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
    req.log,
    callerIsAdmin,
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
    req.log,
    callerIsAdmin,
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
