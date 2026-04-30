import app from "./app";
import { logger } from "./lib/logger";
import {
  registerCollector,
  upsertCollectorRegistration,
} from "./lib/intelligence/runtime";
import { publishedCommodityIndexCollector } from "./lib/intelligence/collectors/published-commodity-index";
import { ecbFxRatesCollector } from "./lib/intelligence/collectors/ecb-fx-rates";
import { fredEconomicIndexCollector } from "./lib/intelligence/collectors/fred-economic-index";
import { eiaEnergyCollector } from "./lib/intelligence/collectors/eia-energy";
import { worldBankPinkSheetCollector } from "./lib/intelligence/collectors/world-bank-pink-sheet";
import { blsEconomicIndexCollector } from "./lib/intelligence/collectors/bls-economic-index";
import { secEdgarCollector } from "./lib/intelligence/collectors/sec-edgar";
import { gdeltEventsCollector } from "./lib/intelligence/collectors/gdelt-events";
import { governmentSanctionsCollector } from "./lib/intelligence/collectors/government-sanctions";
import { opensanctionsCollector } from "./lib/intelligence/collectors/opensanctions";
import { gleifLeiCollector } from "./lib/intelligence/collectors/gleif-lei";
import { climateTraceCollector } from "./lib/intelligence/collectors/climate-trace";
import { naturalHazardsCollector } from "./lib/intelligence/collectors/natural-hazards";
import { companiesHouseCollector } from "./lib/intelligence/collectors/companies-house";
import type { IntelligenceCollector } from "./lib/intelligence/collector";
import {
  registerJobHandler,
  startWorker,
  startJobPruner,
  startRenewalScanScheduler,
  startAnalysisCycleScheduler,
  enqueueJob as _enqueueJob,
} from "./lib/jobs/queue";
import {
  ingestCsvHandler,
  ingestMockErpHandler,
  pruneJobsHandler,
  runAnalysisCycleHandler,
  runAnalysisCycleFanoutHandler,
  runCollectorHandler,
  syncErpConnectionHandler,
  runRenewalAlertScanHandler,
} from "./lib/jobs/handlers";
import { registerErpConnector } from "./lib/connectors/erp-connector";
import { coupaConnector } from "./lib/connectors/coupa/adapter";

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
  blsEconomicIndexCollector,
  // Phase 2 (task #78) — high-ROI free public-API collectors.
  secEdgarCollector,
  gdeltEventsCollector,
  governmentSanctionsCollector,
  opensanctionsCollector,
  gleifLeiCollector,
  climateTraceCollector,
  naturalHazardsCollector,
  companiesHouseCollector,
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
registerJobHandler("sync_erp_connection", syncErpConnectionHandler);
registerJobHandler("renewal_alert_scan", runRenewalAlertScanHandler);
registerJobHandler("analysis_cycle_fanout", runAnalysisCycleFanoutHandler);

// Register live ERP connectors. Same pattern as the intelligence
// collectors above — registry is in-memory and adapter keys are
// constrained at the schema level (`erpAdapterKeyValues`) so we can't
// register a connector that no DB row could ever reference.
registerErpConnector(coupaConnector);

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  startWorker(1500);
  startJobPruner();
  startRenewalScanScheduler();
  startAnalysisCycleScheduler();
  logger.info(
    { port },
    "Server listening; job worker + pruner + renewal-scan + analysis-cycle schedulers started",
  );

  void seedCollectorRegistry().then(
    () => logger.info("Collector registry seeded"),
    (err) =>
      logger.error({ err }, "Collector registry seed failed (continuing)"),
  );
});
