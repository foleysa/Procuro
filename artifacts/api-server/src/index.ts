import app from "./app";
import { logger } from "./lib/logger";
import { maybeWarnSharedScimTokenMisuse } from "./routes/scim";
import {
  registerCollector,
  upsertCollectorRegistration,
} from "./lib/intelligence/runtime";
import { publishedCommodityIndexCollector } from "./lib/intelligence/collectors/published-commodity-index";
import { ecbFxRatesCollector } from "./lib/intelligence/collectors/ecb-fx-rates";
import { fredEconomicIndexCollector } from "./lib/intelligence/collectors/fred-economic-index";
import { eiaEnergyCollector } from "./lib/intelligence/collectors/eia-energy";
import { worldBankPinkSheetCollector } from "./lib/intelligence/collectors/world-bank-pink-sheet";
import { usdaNassEconomicIndexCollector } from "./lib/intelligence/collectors/usda-nass-economic-index";
import { blsEconomicIndexCollector } from "./lib/intelligence/collectors/bls-economic-index";
import { blsOewsCollector } from "./lib/intelligence/collectors/bls-oews";
import { secEdgarCollector } from "./lib/intelligence/collectors/sec-edgar";
import { gdeltEventsCollector } from "./lib/intelligence/collectors/gdelt-events";
import { governmentSanctionsCollector } from "./lib/intelligence/collectors/government-sanctions";
import { opensanctionsCollector } from "./lib/intelligence/collectors/opensanctions";
import { gleifLeiCollector } from "./lib/intelligence/collectors/gleif-lei";
import { climateTraceCollector } from "./lib/intelligence/collectors/climate-trace";
import { naturalHazardsCollector } from "./lib/intelligence/collectors/natural-hazards";
import { companiesHouseCollector } from "./lib/intelligence/collectors/companies-house";
import { epaEchoCollector } from "./lib/intelligence/collectors/epa-echo";
import { oshaInspectionsCollector } from "./lib/intelligence/collectors/osha-inspections";
import type { IntelligenceCollector } from "./lib/intelligence/collector";
import {
  registerJobHandler,
  startWorker,
  startJobPruner,
  startFunnelSnapshotPruner,
  startRenewalScanScheduler,
  startAnalysisCycleScheduler,
  startExpireStaleOpportunitiesScheduler,
  startClearExpiredSnoozesScheduler,
  startRoutingHealthScheduler,
  startDefensePackStalenessScheduler,
  startErpSyncScheduler,
  enqueueJob as _enqueueJob,
} from "./lib/jobs/queue";
import {
  deliverAlertsHandler,
  escalateAlertsHandler,
  expireStaleOpportunitiesHandler,
  clearExpiredSnoozesHandler,
  ingestCsvHandler,
  ingestMockErpHandler,
  pruneFunnelSnapshotsHandler,
  backfillFunnelSnapshotsHandler,
  pruneJobsHandler,
  runAnalysisCycleHandler,
  runAnalysisCycleFanoutHandler,
  runCollectorHandler,
  syncErpConnectionHandler,
  runRenewalAlertScanHandler,
  synthesizeOperationalAlertsHandler,
  runRoutingHealthCheckHandler,
  runDefensePackStalenessScanHandler,
} from "./lib/jobs/handlers";
import { registerErpConnector } from "./lib/connectors/erp-connector";
import { coupaConnector } from "./lib/connectors/coupa/adapter";
import { netsuiteConnector } from "./lib/connectors/netsuite/adapter";
import { aribaConnector } from "./lib/connectors/ariba/adapter";
import {
  startAlertsDeliveryScheduler,
  startAlertsEscalationScheduler,
  startOperationalSynthScheduler,
} from "./lib/alerts/schedulers";
import {
  bootstrapCategoryLeverMappings,
  bootstrapTrigramSuggestions,
} from "./lib/intelligence/routing";
import { ensureWarehouseSchema } from "@workspace/intelligence";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Register intelligence collectors (in-memory registry for runtime
// dispatch + DB seed so each collector has a `collectors` row that can
// be approved, throttled, killed, and run via the platform admin
// routes from first boot).
const COLLECTORS: ReadonlyArray<IntelligenceCollector> = [
  publishedCommodityIndexCollector,
  ecbFxRatesCollector,
  fredEconomicIndexCollector,
  eiaEnergyCollector,
  worldBankPinkSheetCollector,
  // USDA NASS QuickStats — US monthly Prices Received for a curated
  // set of agricultural commodities (corn/wheat/soybeans, dairy,
  // beef/pork/poultry, cotton). Task #244.
  usdaNassEconomicIndexCollector,
  blsEconomicIndexCollector,
  // BLS OEWS — annual, region-aware occupational wage benchmarks
  // anchoring services-band rate-card negotiations (Task #215).
  blsOewsCollector,
  // Phase 2 (task #78) — high-ROI free public-API collectors.
  secEdgarCollector,
  gdeltEventsCollector,
  governmentSanctionsCollector,
  opensanctionsCollector,
  gleifLeiCollector,
  climateTraceCollector,
  naturalHazardsCollector,
  companiesHouseCollector,
  // Task #246 — supplier-risk collectors covering US-regulated
  // facilities. Both query per-watched-supplier and emit one draft per
  // upstream record (EPA enforcement case / OSHA inspection).
  epaEchoCollector,
  oshaInspectionsCollector,
];

for (const c of COLLECTORS) {
  registerCollector(c);
}

async function seedCollectorRegistry(): Promise<void> {
  for (const c of COLLECTORS) {
    try {
      await upsertCollectorRegistration({
        id: c.id,
        name: c.name,
        description: c.description,
        posture: c.posture,
        owner: "procurement-platform@procuro.ai",
        sourceUrl: c.sourceUrl,
        rateLimitRpm: c.defaultRateLimitRpm,
        scheduleCron: c.defaultScheduleCron,
        actor: "system@procuro.ai",
      });
    } catch (err) {
      logger.error(
        { err, collectorId: c.id },
        "Failed to seed collector registration",
      );
    }
  }
}

// Register job handlers. The handler bodies live in `lib/jobs/handlers`
// so they can be imported (and exercised) from integration tests.
//
// Two cross-cutting concerns are baked into those handlers:
//
//   1. Cooperative cancellation — each long-running handler threads
//      `() => isJobCancelRequested(job.id)` into its underlying worker
//      so an operator pressing Cancel on the System / Jobs page
//      short-circuits the run within seconds at the next safe
//      checkpoint (between OODA phases / CSV entity batches / mock ERP
//      pages / before a collector's HTTP fetch). When the helper sees a
//      cancel flag it throws `Error("Cancelled by operator")`, and
//      `processOnce` in the queue translates that into a terminal
//      `failed` row — no half-written batches, no orphaned "running"
//      jobs.
//
//   2. Unrecoverable input wrapping — known-permanent input failures
//      (missing orgId, malformed payload, unknown collector ID, etc.)
//      are thrown as `UnrecoverableJobError` so the queue's
//      retry/backoff loop short-circuits to "permanent failure" on
//      attempt #1 instead of burning the full retry budget on inputs
//      guaranteed to fail again.
registerJobHandler("run_analysis_cycle", runAnalysisCycleHandler);
registerJobHandler("ingest_csv", ingestCsvHandler);
registerJobHandler("ingest_mock_erp", ingestMockErpHandler);
registerJobHandler("run_collector", runCollectorHandler);
registerJobHandler("prune_jobs", pruneJobsHandler);
registerJobHandler("prune_funnel_snapshots", pruneFunnelSnapshotsHandler);
registerJobHandler(
  "backfill_funnel_snapshots",
  backfillFunnelSnapshotsHandler,
);
registerJobHandler("sync_erp_connection", syncErpConnectionHandler);
registerJobHandler("renewal_alert_scan", runRenewalAlertScanHandler);
registerJobHandler("analysis_cycle_fanout", runAnalysisCycleFanoutHandler);
registerJobHandler("deliver_alerts", deliverAlertsHandler);
registerJobHandler("escalate_alerts", escalateAlertsHandler);
registerJobHandler(
  "synthesize_operational_alerts",
  synthesizeOperationalAlertsHandler,
);
registerJobHandler(
  "expire_stale_opportunities",
  expireStaleOpportunitiesHandler,
);
registerJobHandler("clear_expired_snoozes", clearExpiredSnoozesHandler);
registerJobHandler("routing_health_check", runRoutingHealthCheckHandler);
registerJobHandler(
  "defense_pack_staleness_scan",
  runDefensePackStalenessScanHandler,
);

// Register live ERP connectors. Same pattern as the intelligence
// collectors above — registry is in-memory and adapter keys are
// constrained at the schema level (`erpAdapterKeyValues`) so we can't
// register a connector that no DB row could ever reference.
registerErpConnector(coupaConnector);
registerErpConnector(netsuiteConnector);
registerErpConnector(aribaConnector);

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  // Bootstrap the routing materialized view + refresh triggers BEFORE
  // any worker / scheduler starts. Routing reads (cycle.ts,
  // health.ts, queue health checks) hit the view directly, so a race
  // where workers fire while the view does not yet exist would
  // surface as runtime errors. Idempotent: see
  // lib/intelligence/routing/materialized-view.ts.
  try {
    await bootstrapCategoryLeverMappings();
    // Layer D suggestions need pg_trgm + the GIN index on
    // synonym_registry.normalized to be in place before the admin
    // queue endpoint serves its first request.
    await bootstrapTrigramSuggestions();
    logger.info("Routing materialized view bootstrapped");
  } catch (e) {
    logger.error(
      { err: e },
      "Routing materialized view bootstrap failed — refusing to start workers",
    );
    process.exit(1);
  }

  // Surface SCIM_BEARER_TOKEN misconfig (multi-tenant + shared token).
  // See SCIM.md §2 and routes/scim.ts maybeWarnSharedScimTokenMisuse.
  await maybeWarnSharedScimTokenMisuse();

  // Idempotent BigQuery dataset + table bootstrap (CREATE TABLE IF NOT
  // EXISTS + ALTER TABLE ADD COLUMN IF NOT EXISTS). Best-effort: if
  // GCP isn't configured `ensureWarehouseSchema` returns false and is
  // a no-op; if the actual schema apply fails we log and continue
  // because the Postgres path is the system of record. This is the
  // hook that backfills new columns (e.g. `raw_landing_failed`,
  // task #133) onto pre-existing warehouses on next boot — without it
  // BigQuery's `ignoreUnknownValues: true` would silently drop them.
  try {
    const applied = await ensureWarehouseSchema();
    logger.info(
      { applied },
      applied
        ? "BigQuery warehouse schema ensured"
        : "BigQuery warehouse schema bootstrap skipped (intelligence not configured)",
    );
  } catch (e) {
    logger.warn(
      { err: e },
      "BigQuery warehouse schema bootstrap failed; new columns may be silently dropped on insert",
    );
  }

  startWorker(1500);
  startJobPruner();
  startFunnelSnapshotPruner();
  startRenewalScanScheduler();
  startAnalysisCycleScheduler();
  startAlertsDeliveryScheduler();
  startAlertsEscalationScheduler();
  startOperationalSynthScheduler();
  startExpireStaleOpportunitiesScheduler();
  startClearExpiredSnoozesScheduler();
  startRoutingHealthScheduler();
  startDefensePackStalenessScheduler();
  startErpSyncScheduler();
  logger.info(
    { port },
    "Server listening; job worker + pruner + renewal-scan + analysis-cycle + alert schedulers + expire-stale-opportunities + clear-expired-snoozes + erp-sync scheduler started",
  );

  void seedCollectorRegistry().then(
    () => logger.info("Collector registry seeded"),
    (err) =>
      logger.error({ err }, "Collector registry seed failed (continuing)"),
  );
});
