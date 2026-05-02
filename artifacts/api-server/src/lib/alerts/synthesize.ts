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
 *   - `operational_collector_issuer_list_flip`: the SEC EDGAR /
 *     Companies House collector resolved a different issuer-list
 *     `listSource` than the previous tick (seed ↔ tenant ↔ override).
 *     The collectors record the transition in `collector_audit_log`
 *     under event=`issuer_list_source_changed`; this synthesizer
 *     fans the most recent transition per (collector, callSite) out
 *     to every opted-in tenant exactly once per day, severity
 *     `medium`. The `previousSource → listSource` direction in the
 *     payload tells on-call whether to celebrate (a tenant just
 *     onboarded watched issuers) or escalate (everyone deleted their
 *     rows and we silently fell back to the seed list). See the
 *     "Issuer-list resolution" runbook section.
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
  collectorAuditLogTable,
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
const ISSUER_LIST_FLIP_LOOKBACK_HOURS = 24;

export interface SynthesizeResult {
  jobFailedAlerts: number;
  collectorStaleAlerts: number;
  collectorNeverRunAlerts: number;
  collectorIssuerListFlipAlerts: number;
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
    collectorIssuerListFlipAlerts: 0,
    highConfidenceOpportunityAlerts: 0,
  };

  result.jobFailedAlerts = await synthesizeJobFailures(now);
  const collector = await synthesizeCollectorHealth(now, staleHours);
  result.collectorStaleAlerts = collector.stale;
  result.collectorNeverRunAlerts = collector.neverRun;
  result.collectorIssuerListFlipAlerts = await synthesizeIssuerListFlips(now);
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

/**
 * Scan `collector_audit_log` for issuer-list source flips
 * (event = `issuer_list_source_changed`) within the last 24h and
 * emit one `operational_collector_issuer_list_flip` alert per
 * opted-in tenant, per (collector, callSite), per day. Multiple
 * flaps within the window collapse onto the most-recent end-state
 * so we don't spam the inbox while a tenant tinkers with their
 * watched-issuer list.
 */
async function synthesizeIssuerListFlips(now: Date): Promise<number> {
  const cutoff = new Date(
    now.getTime() - ISSUER_LIST_FLIP_LOOKBACK_HOURS * 60 * 60 * 1000,
  );
  const rows = await db
    .select({
      collectorId: collectorAuditLogTable.collectorId,
      metadata: collectorAuditLogTable.metadata,
      createdAt: collectorAuditLogTable.createdAt,
    })
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.event, "issuer_list_source_changed"),
        gt(collectorAuditLogTable.createdAt, cutoff),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt));
  if (rows.length === 0) return 0;

  // Collapse to the latest flip per (collectorId, callSite). The
  // first row we see for a key is the most recent thanks to the
  // `desc(createdAt)` order above.
  interface FlipRow {
    collectorId: string;
    callSite: string;
    previousSource: string;
    listSource: string;
    issuerCount: number;
    createdAt: Date;
  }
  const latestByKey = new Map<string, FlipRow>();
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const callSite = String(meta["callSite"] ?? "unknown");
    const key = `${r.collectorId}:${callSite}`;
    if (latestByKey.has(key)) continue;
    latestByKey.set(key, {
      collectorId: r.collectorId,
      callSite,
      previousSource: String(meta["previousSource"] ?? "unknown"),
      listSource: String(meta["listSource"] ?? "unknown"),
      issuerCount: Number(meta["issuerCount"] ?? 0),
      createdAt: r.createdAt,
    });
  }

  // Fan-out to every tenant opted into the affected collector,
  // mirroring `synthesizeCollectorHealth`. An issuer-list flip is
  // platform-wide (the watched_issuers union spans tenants), so each
  // opted-in tenant sees the same alert routed to their configured
  // channel — same fan-out shape as `operational_collector_stale`.
  const optInRows = await db
    .select({
      orgId: collectorTenantOptInsTable.orgId,
      collectorId: collectorTenantOptInsTable.collectorId,
    })
    .from(collectorTenantOptInsTable)
    .where(eq(collectorTenantOptInsTable.optedIn, 1));
  const orgsByCollector = new Map<string, string[]>();
  for (const r of optInRows) {
    const arr = orgsByCollector.get(r.collectorId) ?? [];
    arr.push(r.orgId);
    orgsByCollector.set(r.collectorId, arr);
  }

  // Pull collector display names for nicer alert titles. Approved
  // status isn't required — a flip on a paused collector is still
  // worth knowing about.
  const collectorIds = Array.from(latestByKey.values()).map((f) => f.collectorId);
  const uniqueCollectorIds = Array.from(new Set(collectorIds));
  const collectorNameById = new Map<string, string>();
  if (uniqueCollectorIds.length > 0) {
    const collectorRows = await db
      .select({ id: collectorsTable.id, name: collectorsTable.name })
      .from(collectorsTable);
    for (const c of collectorRows) collectorNameById.set(c.id, c.name);
  }

  const dayKey = isoDayKey(now);
  let count = 0;
  for (const flip of latestByKey.values()) {
    const orgIds = orgsByCollector.get(flip.collectorId) ?? [];
    if (orgIds.length === 0) continue;
    const collectorName =
      collectorNameById.get(flip.collectorId) ?? flip.collectorId;
    const transition = `${flip.previousSource} → ${flip.listSource}`;
    // Direction-specific summary so on-call sees at a glance whether
    // to celebrate ("first tenant onboarded their watched issuers")
    // or escalate ("everyone deleted their rows and we fell back to
    // the seed list — fix it before the seed silently masks the
    // outage"). Mirrors the runbook decision tree.
    const direction =
      flip.listSource === "seed"
        ? "fell back to the built-in seed list — every tenant row was deleted (or never existed). Confirm this is intentional before a stale seed silently masks an outage."
        : flip.previousSource === "seed" && flip.listSource === "tenant"
          ? "switched off the seed list because a tenant just added their first watched issuer. Usually a healthy onboarding event — no action needed unless the issuer count looks wrong."
          : flip.listSource === "override"
            ? "switched to an explicit override list (likely an admin backfill). Expected to revert on the next normal tick."
            : `switched to ${flip.listSource}.`;
    for (const orgId of orgIds) {
      await createAlert({
        orgId,
        severity: "medium",
        source: "operational_collector_issuer_list_flip",
        kind: `collector_issuer_list_flip:${flip.collectorId}`,
        title: `Collector "${collectorName}" issuer-list source flipped: ${transition}`,
        summary: `${flip.collectorId} (${flip.callSite}) ${direction} Now polling ${flip.issuerCount} entr${flip.issuerCount === 1 ? "y" : "ies"}. See the "Issuer-list resolution" section of the collectors runbook.`,
        // Dedupe per (org, collector, callSite, day, direction) so a
        // sustained flip only fires once per day, but a flip that
        // *reverses* re-fires immediately (different direction).
        dedupeKey: `op:issuer_list_flip:${orgId}:${flip.collectorId}:${flip.callSite}:${dayKey}:${flip.previousSource}->${flip.listSource}`,
        payload: {
          collectorId: flip.collectorId,
          collectorName,
          callSite: flip.callSite,
          previousSource: flip.previousSource,
          listSource: flip.listSource,
          issuerCount: flip.issuerCount,
          flippedAt: flip.createdAt.toISOString(),
          runbookSection: "Issuer-list resolution & seed fallback",
          sources: [],
        },
      });
      count += 1;
    }
  }
  return count;
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
