import { Router, type IRouter } from "express";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { csvSourceAdapter, type CsvPayload } from "../lib/adapters/csv-adapter";
import {
  mockErpSourceAdapter,
  type MockErpConfig,
} from "../lib/adapters/mock-erp-adapter";
import { enqueueJob, JobQuotaExceededError } from "../lib/jobs/queue";

const router: IRouter = Router();

/** Maximum number of top-level records accepted in a single synchronous ingest request. */
const MAX_SYNC_INGEST_ITEMS = 5_000;

function isAsync(req: { query: Record<string, unknown> }): boolean {
  return req.query["async"] === "true" || req.query["async"] === "1";
}

function countCsvItems(csv: CsvPayload): number {
  let total = 0;
  for (const key of Object.keys(csv) as Array<keyof CsvPayload>) {
    const val = csv[key];
    if (Array.isArray(val)) total += val.length;
  }
  // Include nested children that each generate their own DB rows.
  for (const contract of csv.contracts ?? []) {
    total += contract.items?.length ?? 0;
  }
  for (const po of csv.purchaseOrders ?? []) {
    total += po.lines?.length ?? 0;
  }
  return total;
}

router.post("/ingest/csv", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const csv = (req.body ?? {}) as CsvPayload;

  if (!isAsync(req)) {
    const itemCount = countCsvItems(csv);
    if (itemCount > MAX_SYNC_INGEST_ITEMS) {
      res.status(413).json({
        error: `Synchronous ingest is limited to ${MAX_SYNC_INGEST_ITEMS} total records. Received ${itemCount}. Use ?async=true for larger payloads.`,
      });
      return;
    }
  }

  try {
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
  } catch (err) {
    if (err instanceof JobQuotaExceededError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post("/ingest/mock-erp", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const body = (req.body ?? {}) as { feed?: unknown[]; cursor?: string };
  if (!Array.isArray(body.feed)) {
    res.status(400).json({ error: "Body must include `feed` array." });
    return;
  }

  if (!isAsync(req)) {
    // Count total DB operations: each feed record plus any nested PO lines.
    let erpItemCount = body.feed.length;
    for (const rec of body.feed) {
      const r = rec as { type?: string; payload?: { lines?: unknown[] } };
      if (r.type === "purchase_order" && Array.isArray(r.payload?.lines)) {
        erpItemCount += r.payload.lines.length;
      }
    }
    if (erpItemCount > MAX_SYNC_INGEST_ITEMS) {
      res.status(413).json({
        error: `Synchronous ingest is limited to ${MAX_SYNC_INGEST_ITEMS} total records (including nested PO lines). Received ${erpItemCount}. Use ?async=true for larger payloads.`,
      });
      return;
    }
  }

  const config: MockErpConfig = { feed: body.feed as MockErpConfig["feed"] };

  try {
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
  } catch (err) {
    if (err instanceof JobQuotaExceededError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
