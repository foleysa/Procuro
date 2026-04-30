import { Router, type IRouter, type Request } from "express";
import type { Readable } from "node:stream";
import Busboy from "busboy";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import {
  csvSourceAdapter,
  streamCsvEntity,
  type CsvPayload,
  type CsvEntity,
} from "../lib/adapters/csv-adapter";
import {
  mockErpSourceAdapter,
  type MockErpConfig,
} from "../lib/adapters/mock-erp-adapter";
import { enqueueJob, JobQuotaExceededError } from "../lib/jobs/queue";

const STREAM_CSV_ENTITIES: ReadonlySet<CsvEntity> = new Set([
  "suppliers",
  "categories",
  "items",
  "purchase_orders",
  "po_lines",
  "invoices",
  "payments",
  "shipments",
]);

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

/**
 * Streaming CSV ingest. Pipes the upload directly into `streamCsvEntity` so
 * server memory stays bounded regardless of file size (the parser flushes in
 * fixed-size batches). Express body parsers are configured to skip this path
 * via `SKIP_BODY` in `app.ts`, leaving `req` available as a Node Readable
 * stream.
 *
 * Query: `?entity=<suppliers|categories|...>` (required).
 *
 * Body — two transports are supported:
 *   1. `multipart/form-data` with a single file part named `file` (preferred;
 *      this is what the OpenAPI contract advertises and what the generated
 *      React client + browsers / curl `-F` produce).
 *   2. `text/csv` raw body (kept for simple curl `--data-binary` usage and
 *      back-compat). The first non-multipart request is treated as raw CSV.
 *
 * Limit: hard-capped at 1 GB per upload via Content-Length pre-flight and a
 * streaming byte counter (defense in depth) to prevent disk/DB exhaustion.
 */
const MAX_STREAM_BYTES = 1024 * 1024 * 1024; // 1 GB

function isMultipart(req: Request): boolean {
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  return ct.startsWith("multipart/form-data");
}

/**
 * Wraps a Node Readable so any chunk read past `maxBytes` triggers an error
 * which destroys both the wrapped stream and the original request. Returns
 * the same stream (we attach a listener; we do not rewrap).
 */
function attachByteLimit(
  src: Readable,
  maxBytes: number,
  onExceeded: () => void,
): { destroyed: () => boolean } {
  let bytesRead = 0;
  let killed = false;
  src.on("data", (chunk: Buffer) => {
    bytesRead += chunk.length;
    if (bytesRead > maxBytes && !killed) {
      killed = true;
      onExceeded();
      src.destroy(
        new Error(`Upload exceeded ${maxBytes}-byte (1 GB) per-request limit`),
      );
    }
  });
  return { destroyed: () => killed };
}

router.post("/ingest/csv-stream", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const entity = String(req.query["entity"] ?? "") as CsvEntity;

  if (!STREAM_CSV_ENTITIES.has(entity)) {
    res.status(400).json({
      error: `Invalid or missing 'entity' query parameter. Must be one of: ${Array.from(
        STREAM_CSV_ENTITIES,
      ).join(", ")}`,
    });
    return;
  }

  // Pre-flight Content-Length check (cheap rejection before we start parsing).
  const declaredLen = Number(req.headers["content-length"] ?? "0");
  if (declaredLen > MAX_STREAM_BYTES) {
    res.status(413).json({
      error: `Upload too large: ${declaredLen} bytes exceeds the ${MAX_STREAM_BYTES}-byte (1 GB) per-request limit. Split the file into smaller chunks.`,
    });
    return;
  }

  req.on("aborted", () => {
    req.log.warn({ entity, orgId }, "Streaming CSV upload aborted by client");
  });

  try {
    if (isMultipart(req)) {
      // Pipe the first file field straight into streamCsvEntity. Busboy emits
      // the part as a Readable, so memory stays bounded by the part stream's
      // highWaterMark — we never buffer the whole file.
      const result = await new Promise(
        (resolve: (v: Awaited<ReturnType<typeof streamCsvEntity>>) => void, reject) => {
          let busboy: ReturnType<typeof Busboy>;
          try {
            busboy = Busboy({
              headers: req.headers as Record<string, string>,
              limits: {
                fileSize: MAX_STREAM_BYTES,
                files: 1,
              },
            });
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }

          let handled = false;
          let limitTriggered = false;

          busboy.on("file", (_name, fileStream, _info) => {
            if (handled) {
              fileStream.resume(); // drain ignored extra files
              return;
            }
            handled = true;

            fileStream.on("limit", () => {
              limitTriggered = true;
              req.log.warn(
                { entity, orgId },
                "Multipart CSV upload exceeded byte limit; destroying request",
              );
              fileStream.destroy(
                new Error(
                  `Upload exceeded ${MAX_STREAM_BYTES}-byte (1 GB) per-request limit`,
                ),
              );
              req.unpipe(busboy);
              req.destroy();
            });

            streamCsvEntity({ orgId, entity, input: fileStream }).then(
              (r) => {
                if (limitTriggered) {
                  reject(
                    new Error(
                      `Upload exceeded ${MAX_STREAM_BYTES}-byte (1 GB) per-request limit`,
                    ),
                  );
                } else {
                  resolve(r);
                }
              },
              (err) => reject(err),
            );
          });

          busboy.on("error", (err: unknown) => {
            reject(err instanceof Error ? err : new Error(String(err)));
          });

          busboy.on("close", () => {
            if (!handled) {
              reject(
                new Error(
                  "multipart/form-data request did not include a `file` part",
                ),
              );
            }
          });

          req.pipe(busboy);
        },
      );
      res.json(result);
      return;
    }

    // Raw text/csv path — defense-in-depth byte counter and pipe req directly.
    let exceeded = false;
    attachByteLimit(req, MAX_STREAM_BYTES, () => {
      exceeded = true;
      req.log.warn(
        { entity, orgId },
        "Raw CSV upload exceeded byte limit; destroying request",
      );
    });
    const result = await streamCsvEntity({ orgId, entity, input: req });
    if (exceeded) {
      res.status(413).json({
        error: `Upload exceeded ${MAX_STREAM_BYTES}-byte (1 GB) per-request limit`,
      });
      return;
    }
    res.json(result);
  } catch (err) {
    const msg = (err as Error).message;
    req.log.error(
      { err: msg, entity, orgId },
      "Streaming CSV ingest failed",
    );
    if (!res.headersSent) {
      const status = msg.includes("per-request limit") ? 413 : 400;
      res.status(status).json({
        error: `CSV stream ingest failed: ${msg}`,
      });
    }
  }
});

export default router;
