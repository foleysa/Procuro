/**
 * Engine Health evaluator (task #296).
 *
 * Server-side equivalent of the client `computeHealthStatus` /
 * `buildHealthSummary` logic that previously lived only in
 * `artifacts/command-center/src/components/dashboard/SystemHealthStrip.tsx`.
 *
 * Two consumers:
 *   1. The `/engine-health` route — read-only per-tenant rollup the
 *      Command Center reads instead of firing client-side alerts.
 *   2. `synthesizeEngineStalled` (called from the operational alerts
 *      synth job) — fires/dedupes the `engine_stalled` alert per
 *      tenant on the scheduler cadence so multiple browser tabs no
 *      longer race to insert the same alert.
 *
 * The previous client implementation fired the alert directly from
 * React, which meant every open tab on every operator's machine raced
 * to insert the alert. Dedupe by (orgId, dedupeKey) made it correct
 * in steady state, but rapid re-renders could still queue concurrent
 * upserts before the first one's dedupe took effect, and any change
 * to the dedupeKey would orphan in-flight open alerts. Moving the
 * evaluation server-side eliminates the race and centralises the
 * threshold logic in one place.
 */

import {
  db,
  collectorsTable,
  jobsTable,
  marketSignalsTable,
  orgsTable,
} from "@workspace/db";
import { and, count, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";

export type EngineHealthStatus = "green" | "yellow" | "red";

export interface EngineHealthInputs {
  signals24h: number;
  signals7dayAvg: number;
  failedJobs24h: number;
  pendingJobs: number;
  runningJobs: number;
  staleCollectors: number;
}

export interface EngineHealth {
  orgId: string;
  status: EngineHealthStatus;
  summary: string;
  inputs: EngineHealthInputs;
  evaluatedAt: string;
}

const STALE_COLLECTOR_HOURS = 24;

/**
 * Mirrors `computeHealthStatus` in `SystemHealthStrip.tsx`. Keep the
 * two definitions in lock-step: the client component still uses its
 * local copy to drive the diagnostic-tile colours, but the alert
 * firing decision is owned by this module.
 */
export function computeEngineHealthStatus(
  i: EngineHealthInputs,
): EngineHealthStatus {
  const { signals24h, signals7dayAvg, failedJobs24h, pendingJobs, runningJobs, staleCollectors } = i;

  // Tier 3 — Red: any hard-stop condition.
  if (signals24h === 0) return "red";
  if (failedJobs24h > 0) return "red";
  if (pendingJobs > 5 && runningJobs === 0) return "red";

  // Tier 1 — Green: all clear thresholds.
  const sigOk = signals7dayAvg === 0 || signals24h >= signals7dayAvg * 0.5;
  const jobsOk = failedJobs24h === 0;
  const collectorsOk = staleCollectors <= 1;
  if (sigOk && jobsOk && collectorsOk) return "green";

  // Tier 2 — Yellow: any threshold breached but not hard-stop.
  return "yellow";
}

export function buildEngineHealthSummary(
  i: EngineHealthInputs,
  status: EngineHealthStatus,
): string {
  const { signals24h, failedJobs24h, pendingJobs, runningJobs, staleCollectors } = i;
  if (status === "green") {
    return `Engine healthy — ${signals24h} signals in 24h, no failed jobs, ${staleCollectors} stale collector${staleCollectors === 1 ? "" : "s"}.`;
  }
  if (status === "red") {
    const parts: string[] = [];
    if (signals24h === 0) parts.push("0 signals in 24h");
    if (failedJobs24h > 0) parts.push(`${failedJobs24h} failed job${failedJobs24h === 1 ? "" : "s"}`);
    if (pendingJobs > 0) parts.push(`${pendingJobs + runningJobs} jobs queued`);
    if (staleCollectors > 0) parts.push(`${staleCollectors} stale collector${staleCollectors === 1 ? "" : "s"}`);
    return `Engine intake stalled — ${parts.join(", ")}.`;
  }
  const warnings: string[] = [];
  if (staleCollectors > 1) warnings.push(`${staleCollectors} stale collectors`);
  if (failedJobs24h > 0) warnings.push(`${failedJobs24h} failed jobs`);
  return warnings.length > 0
    ? `Engine degraded — ${warnings.join(", ")}.`
    : "Engine degraded — some thresholds breached.";
}

/**
 * Compute the engine-health inputs for a single tenant. Numbers come
 * from the same telemetry tables the dashboard already reads:
 *
 *   - `signals24h` / `signals7dayAvg` from market_signals (org-scoped
 *     OR cross-tenant with org_id NULL — collectors emit either).
 *   - `failedJobs24h` / `pendingJobs` / `runningJobs` from jobs scoped
 *     to the org.
 *   - `staleCollectors` is platform-level (collectors are global) and
 *     mirrors the dashboard rule: enabled, lastRunAt set, last run
 *     older than 24h.
 */
export async function computeEngineHealthForOrg(
  orgId: string,
  now: Date = new Date(),
): Promise<EngineHealth> {
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // market_signals can be tenant-scoped or cross-tenant (org_id NULL).
  // Tenant scope = "this org's rows OR platform-wide rows", matching
  // the `/market-signals` route filter. Without the org filter a noisy
  // tenant could mask another tenant's stall and flip its engine
  // colour — exactly the multi-tenant pollution this task is fixing.
  const orgScope = or(
    eq(marketSignalsTable.orgId, orgId),
    isNull(marketSignalsTable.orgId),
  );
  const [signals24Row] = await db
    .select({ n: count() })
    .from(marketSignalsTable)
    .where(and(orgScope, gt(marketSignalsTable.observedAt, last24h)));
  const [signals7Row] = await db
    .select({ n: count() })
    .from(marketSignalsTable)
    .where(and(orgScope, gt(marketSignalsTable.observedAt, last7d)));

  const signals24h = Number(signals24Row?.n ?? 0);
  const signals7d = Number(signals7Row?.n ?? 0);
  const signals7dayAvg = signals7d / 7;

  // Jobs: org-scoped status counts.
  // - failed in last 24h (completedAt window),
  // - currently pending,
  // - currently running.
  const [failedRow] = await db
    .select({ n: count() })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.orgId, orgId),
        eq(jobsTable.status, "failed"),
        isNotNull(jobsTable.completedAt),
        gt(jobsTable.completedAt, last24h),
      ),
    );
  const [pendingRow] = await db
    .select({ n: count() })
    .from(jobsTable)
    .where(and(eq(jobsTable.orgId, orgId), eq(jobsTable.status, "pending")));
  const [runningRow] = await db
    .select({ n: count() })
    .from(jobsTable)
    .where(and(eq(jobsTable.orgId, orgId), eq(jobsTable.status, "running")));

  // Stale collectors: approved + non-killed, has produced at least one
  // signal, but most recent signal older than 24h. Collectors are
  // platform-level. Single grouped aggregate (MAX(observed_at) per
  // collector) instead of an N+1 latest-per-collector loop so the
  // synth scheduler tick stays cheap on tenants with many collectors.
  const staleCutoff = new Date(
    now.getTime() - STALE_COLLECTOR_HOURS * 60 * 60 * 1000,
  );
  const staleRows = await db
    .select({
      collectorId: marketSignalsTable.collectorId,
      latest: sql<Date>`MAX(${marketSignalsTable.observedAt})`,
    })
    .from(marketSignalsTable)
    .innerJoin(
      collectorsTable,
      eq(marketSignalsTable.collectorId, collectorsTable.id),
    )
    .where(
      and(
        eq(collectorsTable.status, "approved"),
        eq(collectorsTable.killSwitch, 0),
      ),
    )
    .groupBy(marketSignalsTable.collectorId);

  let staleCollectors = 0;
  for (const r of staleRows) {
    const latestMs =
      r.latest instanceof Date ? r.latest.getTime() : new Date(r.latest).getTime();
    if (latestMs < staleCutoff.getTime()) staleCollectors += 1;
  }

  const inputs: EngineHealthInputs = {
    signals24h,
    signals7dayAvg,
    failedJobs24h: Number(failedRow?.n ?? 0),
    pendingJobs: Number(pendingRow?.n ?? 0),
    runningJobs: Number(runningRow?.n ?? 0),
    staleCollectors,
  };
  const status = computeEngineHealthStatus(inputs);
  const summary = buildEngineHealthSummary(inputs, status);
  return { orgId, status, summary, inputs, evaluatedAt: now.toISOString() };
}

/** List every org id (used by the synth job). */
export async function listAllOrgIds(): Promise<string[]> {
  const rows = await db.select({ id: orgsTable.id }).from(orgsTable);
  return rows.map((r) => r.id);
}
