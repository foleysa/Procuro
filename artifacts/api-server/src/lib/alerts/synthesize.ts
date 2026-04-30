/**
 * Operational alert synthesizer.
 *
 * Periodically scans the platform's own state and emits alerts for
 * operational conditions that warrant operator attention:
 *
 *   - `operational_job_failed`: any job that failed in the last 24h.
 *     Dedupe key includes the job's `kind` so successive failures of
 *     different kinds don't collapse, but successive failures of the
 *     same kind for the same tenant within 24h bump occurrences.
 *
 *   - `operational_collector_stale`: an enabled collector whose most
 *     recent successful market_signals row is older than the
 *     stale threshold (default 48h). Per-tenant: only fires if the
 *     collector is opted-in for that tenant. Dedupe per (tenant,
 *     collectorId, day) so we get at most one alert per day until
 *     the collector recovers.
 *
 *   - `operational_collector_never_run`: an enabled, approved,
 *     opted-in collector with zero market_signals rows ever. Same
 *     per-(tenant, collectorId) dedupe.
 *
 *   - `operational_high_confidence_opportunity`: a `proposed`
 *     opportunity with confidence ≥ 0.85 (high-confidence
 *     recommendation that no human has acted on yet). Dedupe per
 *     opportunity id so we re-fire only if the opportunity is
 *     resolved and re-proposed.
 *
 * Run from the `synthesize_operational_alerts` job kind. Cheap enough
 * to run every 15 minutes — every query is indexed and bounded.
 */

import {
  db,
  jobsTable,
  collectorsTable,
  collectorTenantOptInsTable,
  marketSignalsTable,
  opportunitiesTable,
  orgsTable,
  alertsTable,
  type AlertSeverity,
} from "@workspace/db";
import { and, eq, gt, isNotNull, isNull, sql, desc, lt } from "drizzle-orm";
import { createAlert } from "@workspace/intelligence";
import { logger } from "../logger";

const STALE_HOURS_DEFAULT = 48;
const HIGH_CONFIDENCE_THRESHOLD = 0.85;

export interface SynthesizeResult {
  jobFailedAlerts: number;
  collectorStaleAlerts: number;
  collectorNeverRunAlerts: number;
  highConfidenceOpportunityAlerts: number;
}

interface SynthesizeOptions {
  /** For tests: override "now". */
  now?: () => Date;
  /** Hours of inactivity before a collector counts as stale. Default 48. */
  staleHours?: number;
}

export async function synthesizeOperationalAlerts(
  opts: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const now = (opts.now ?? (() => new Date()))();
  const staleHours = Math.max(1, opts.staleHours ?? STALE_HOURS_DEFAULT);

  const result: SynthesizeResult = {
    jobFailedAlerts: 0,
    collectorStaleAlerts: 0,
    collectorNeverRunAlerts: 0,
    highConfidenceOpportunityAlerts: 0,
  };

  result.jobFailedAlerts = await synthesizeJobFailures(now);
  const collector = await synthesizeCollectorHealth(now, staleHours);
  result.collectorStaleAlerts = collector.stale;
  result.collectorNeverRunAlerts = collector.neverRun;
  result.highConfidenceOpportunityAlerts =
    await synthesizeHighConfidenceOpportunities(now);

  logger.info({ result }, "Operational alerts synthesized");
  return result;
}

async function synthesizeJobFailures(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Group failed jobs by (org, kind) so successive failures of the
  // same kind for the same tenant collapse into one alert with bumped
  // occurrences, instead of one alert per failed run.
  const rows = await db
    .select({
      orgId: jobsTable.orgId,
      kind: jobsTable.kind,
      count: sql<number>`COUNT(*)::int`,
      lastError: sql<string | null>`MAX(${jobsTable.error})`,
    })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.status, "failed"),
        isNotNull(jobsTable.orgId),
        gt(jobsTable.completedAt, cutoff),
      ),
    )
    .groupBy(jobsTable.orgId, jobsTable.kind);

  let count = 0;
  for (const r of rows) {
    if (!r.orgId) continue;
    const severity: AlertSeverity = r.count >= 5 ? "high" : "medium";
    const dedupeKey = `op:job_failed:${r.kind}:${r.orgId}`;
    await createAlert({
      orgId: r.orgId,
      severity,
      source: "operational_job_failed",
      kind: `job_failed:${r.kind}`,
      title: `${r.count} ${r.kind} job${r.count === 1 ? "" : "s"} failed in the last 24h`,
      summary: r.lastError
        ? `Most recent error: ${String(r.lastError).slice(0, 500)}`
        : "",
      dedupeKey,
      payload: {
        jobKind: r.kind,
        failedCount: r.count,
        windowHours: 24,
        sources: [],
      },
    });
    count += 1;
  }
  return count;
}

async function synthesizeCollectorHealth(
  now: Date,
  staleHours: number,
): Promise<{ stale: number; neverRun: number }> {
  const cutoff = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
  // Approved + non-killed collectors are the only ones we expect to be
  // producing signals. Fetch them once; we'll join per-tenant below.
  const approved = await db
    .select()
    .from(collectorsTable)
    .where(
      and(
        eq(collectorsTable.status, "approved"),
        eq(collectorsTable.killSwitch, 0),
      ),
    );
  if (approved.length === 0) return { stale: 0, neverRun: 0 };

  const orgs = await db.select().from(orgsTable);
  const optIns = await db.select().from(collectorTenantOptInsTable);
  const optInIndex = new Map<string, boolean>();
  for (const r of optIns) {
    optInIndex.set(`${r.orgId}|${r.collectorId}`, r.optedIn === 1);
  }

  let stale = 0;
  let neverRun = 0;

  for (const collector of approved) {
    // Most-recent observed_at for this collector, regardless of tenant.
    // Used to drive the per-tenant alert: signals can be tenant-agnostic
    // (orgId is nullable) so we compare the collector's freshness, not
    // per-tenant freshness.
    const [latest] = await db
      .select({ observedAt: marketSignalsTable.observedAt })
      .from(marketSignalsTable)
      .where(eq(marketSignalsTable.collectorId, collector.id))
      .orderBy(desc(marketSignalsTable.observedAt))
      .limit(1);
    const isStale = latest && latest.observedAt < cutoff;
    const everRan = !!latest;

    for (const org of orgs) {
      const optedIn = optInIndex.get(`${org.id}|${collector.id}`) ?? false;
      if (!optedIn) continue;
      const dayKey = isoDayKey(now);
      if (!everRan) {
        await createAlert({
          orgId: org.id,
          severity: "medium",
          source: "operational_collector_never_run",
          kind: `collector_never_run:${collector.id}`,
          title: `Collector "${collector.name}" has never produced a signal`,
          summary: `Approved + opted-in collector "${collector.id}" has zero market_signals rows. Investigate the run pipeline.`,
          dedupeKey: `op:collector_never_run:${org.id}:${collector.id}`,
          payload: {
            collectorId: collector.id,
            collectorName: collector.name,
            sources: [],
          },
        });
        neverRun += 1;
      } else if (isStale) {
        await createAlert({
          orgId: org.id,
          severity: "medium",
          source: "operational_collector_stale",
          kind: `collector_stale:${collector.id}`,
          title: `Collector "${collector.name}" hasn't produced signals in ${staleHours}h`,
          summary: `Last signal observed at ${latest!.observedAt.toISOString()}. Threshold: ${staleHours}h.`,
          dedupeKey: `op:collector_stale:${org.id}:${collector.id}:${dayKey}`,
          payload: {
            collectorId: collector.id,
            collectorName: collector.name,
            lastObservedAt: latest!.observedAt.toISOString(),
            staleHours,
            sources: [],
          },
        });
        stale += 1;
      }
    }
  }
  return { stale, neverRun };
}

async function synthesizeHighConfidenceOpportunities(
  now: Date,
): Promise<number> {
  // Only consider proposed opportunities created in the last 7 days
  // — older un-actioned ones are stale by some other definition we
  // don't want to alert on twice.
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.status, "proposed"),
        gt(opportunitiesTable.createdAt, cutoff),
      ),
    );

  let count = 0;
  for (const opp of rows) {
    const conf = Number(opp.confidence);
    if (!Number.isFinite(conf) || conf < HIGH_CONFIDENCE_THRESHOLD) continue;
    await createAlert({
      orgId: opp.orgId,
      severity: "low",
      source: "operational_high_confidence_opportunity",
      kind: `high_confidence_opportunity`,
      title: `High-confidence opportunity awaiting review: "${opp.title}"`,
      summary: `Lever ${opp.leverId} • confidence ${(conf * 100).toFixed(1)}% • projected savings $${Number(
        opp.projectedSavingsUsd,
      ).toLocaleString()}`,
      dedupeKey: `op:high_conf_opportunity:${opp.id}`,
      opportunityId: opp.id,
      supplierId: opp.supplierId ?? null,
      payload: {
        opportunityId: opp.id,
        confidence: conf,
        projectedSavingsUsd: Number(opp.projectedSavingsUsd),
        leverId: opp.leverId,
        sources: [],
      },
    });
    count += 1;
  }
  return count;
}

function isoDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Sweep alerts that have been resolved or whose underlying condition
 * has cleared. Currently a no-op stub — the cleanup discussion is
 * deferred to a follow-up; alerts persist until manually resolved.
 */
export async function sweepStaleAlerts(_now: Date): Promise<number> {
  // intentionally noop — placeholder so callers can wire it in now and
  // we can add real auto-resolve heuristics without an API change.
  void _now;
  void alertsTable;
  void isNull;
  void lt;
  return 0;
}
