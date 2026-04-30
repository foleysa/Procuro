import app from "./app";
import { logger } from "./lib/logger";
import { registerCollector } from "./lib/intelligence/runtime";
import { publishedCommodityIndexCollector } from "./lib/intelligence/collectors/published-commodity-index";
import { ecbFxRatesCollector } from "./lib/intelligence/collectors/ecb-fx-rates";
import { fredEconomicIndexCollector } from "./lib/intelligence/collectors/fred-economic-index";
import {
  registerJobHandler,
  startWorker,
  enqueueJob as _enqueueJob,
} from "./lib/jobs/queue";
import { runAnalysisCycle } from "./lib/ooda/cycle";
import { csvSourceAdapter, type CsvPayload } from "./lib/adapters/csv-adapter";
import {
  mockErpSourceAdapter,
  type MockErpConfig,
} from "./lib/adapters/mock-erp-adapter";
import { runCollector } from "./lib/intelligence/runtime";

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

// Register intelligence collectors
registerCollector(publishedCommodityIndexCollector);
registerCollector(ecbFxRatesCollector);
registerCollector(fredEconomicIndexCollector);

// Register job handlers
registerJobHandler("run_analysis_cycle", async (job) => {
  const orgId = job.orgId!;
  const result = await runAnalysisCycle({
    orgId,
    triggeredBy: (job.payload?.triggeredBy as string) ?? "job-runner",
  });
  return result as unknown as Record<string, unknown>;
});

registerJobHandler("ingest_csv", async (job) => {
  const orgId = job.orgId!;
  const result = await csvSourceAdapter.fullSync({
    orgId,
    config: (job.payload?.csv as CsvPayload) ?? {},
  });
  return result as unknown as Record<string, unknown>;
});

registerJobHandler("ingest_mock_erp", async (job) => {
  const orgId = job.orgId!;
  const result = await mockErpSourceAdapter.fullSync({
    orgId,
    config: (job.payload?.erp as MockErpConfig) ?? { feed: [] },
  });
  return result as unknown as Record<string, unknown>;
});

registerJobHandler("run_collector", async (job) => {
  const collectorId = (job.payload?.collectorId as string) ?? "";
  const result = await runCollector(collectorId);
  return result as unknown as Record<string, unknown>;
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  startWorker(1500);
  logger.info({ port }, "Server listening; job worker started");
});
