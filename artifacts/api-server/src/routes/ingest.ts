import { Router, type IRouter } from "express";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { csvSourceAdapter, type CsvPayload } from "../lib/adapters/csv-adapter";
import {
  mockErpSourceAdapter,
  type MockErpConfig,
} from "../lib/adapters/mock-erp-adapter";
import { enqueueJob } from "../lib/jobs/queue";

const router: IRouter = Router();

function isAsync(req: { query: Record<string, unknown> }): boolean {
  return req.query["async"] === "true" || req.query["async"] === "1";
}

router.post("/ingest/csv", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const csv = (req.body ?? {}) as CsvPayload;
  if (isAsync(req)) {
    const job = await enqueueJob({
      kind: "ingest_csv",
      orgId,
      payload: { csv },
    });
    res.status(202).json({ jobId: job.id, status: job.status });
    return;
  }
  const result = await csvSourceAdapter.fullSync({ orgId, config: csv });
  res.json(result);
});

router.post("/ingest/mock-erp", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const body = (req.body ?? {}) as { feed?: unknown[]; cursor?: string };
  if (!Array.isArray(body.feed)) {
    res.status(400).json({ error: "Body must include `feed` array." });
    return;
  }
  const config: MockErpConfig = { feed: body.feed as MockErpConfig["feed"] };

  if (isAsync(req)) {
    const job = await enqueueJob({
      kind: "ingest_mock_erp",
      orgId,
      payload: { erp: config, cursor: body.cursor ?? null },
    });
    res.status(202).json({ jobId: job.id, status: job.status });
    return;
  }

  const result = body.cursor
    ? await mockErpSourceAdapter.incrementalSync({
        orgId,
        config,
        cursor: body.cursor,
      })
    : await mockErpSourceAdapter.fullSync({ orgId, config });
  res.json(result);
});

export default router;
