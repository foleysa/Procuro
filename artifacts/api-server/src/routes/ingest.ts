import { Router, type IRouter, type Request } from "express";
import type { Readable } from "node:stream";
import Busboy from "busboy";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import {
  csvSourceAdapter,
  streamCsvEntity,
  CsvIngestAbortedError,
  type CsvPayload,
  type CsvEntity,
  type StreamCsvProgress,
} from "../lib/adapters/csv-adapter";
import {
  mockErpSourceAdapter,
  type MockErpConfig,
} from "../lib/adapters/mock-erp-adapter";
import { enqueueJob } from "../lib/jobs/queue";
import {
  sanitizeDbErrorMessage,
  errorLogContext,
} from "../lib/sanitize-db-error";

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

router.post("/ingest/csv", tenantMiddleware, requirePermission("ingest:write"), async (req, res) => {
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

router.post("/ingest/mock-erp", tenantMiddleware, requirePermission("ingest:write"), async (req, res) => {
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

/**
 * Minimum interval between NDJSON `progress` events emitted to the client.
 * The streaming adapter calls `onProgress` after every batch flush (default
 * 1000 rows). For multi-million-row files this would produce thousands of
 * progress events; throttling keeps the response stream cheap to render
 * while still feeling live (~4 updates/sec). The final per-batch totals are
 * always present in the trailing `result` event regardless of throttling.
 */
const PROGRESS_EMIT_INTERVAL_MS = 250;

/**
 * Expected p95 streaming-ingest throughput per entity, on the dev DB +
 * a typical CI runner. Numbers are the wall-clock gap between the first
 * `progress` event (after the 1st batch flush at 1000 rows) and the
 * terminal `result` event for a fixture-driven 10k-row upload — i.e. the
 * cost of ~9 remaining `flushBatch` round-trips. The corresponding
 * normalized throughput is shown alongside.
 *
 * | entity          | flushBatch shape           | p95 gap (10k rows) | rows/sec |
 * |-----------------|----------------------------|--------------------|----------|
 * | categories      | no FK; single upsert       |  ~700–1000 ms      | ~9–12k   |
 * | items           | no FK; single upsert       |  ~700–1100 ms      | ~8–12k   |
 * | suppliers (20k) | no FK; single upsert       |  ~1500 ms (19k r.) | ~12k     |
 * | purchase_orders | 1× grouped FK lookup       |  ~900–1400 ms      | ~6–10k   |
 * | payments        | 1× grouped FK lookup       |  ~900–1400 ms      | ~6–10k   |
 * | shipments       | 2× optional grouped FK     | ~1100–1700 ms      | ~5–8k    |
 * | invoices        | 2× grouped FK + filter     | ~1200–1900 ms      | ~5–8k    |
 * | po_lines        | 2× grouped FK + filter     | ~1200–1900 ms      | ~5–8k    |
 *
 * These are the baselines the `csv-stream-progress*.test.ts` tests
 * enforce a soft ceiling against (currently 4–8 s, i.e. roughly 3–5×
 * the p95 to absorb CI noise without flaking). A 5–10× regression in
 * any of these numbers — the kind that turns a 30-second customer
 * upload into a 5-minute one — should fail those tests in CI before it
 * reaches a customer.
 *
 * If a legitimate change shifts these numbers (new index, schema
 * change, batch-size tweak), update both this table and the ceiling
 * map in `csv-stream-progress-entities.test.ts` (and the suppliers
 * ceiling in `csv-stream-progress.test.ts`) together.
 */

/**
 * Run the multipart busboy path and resolve with the streamCsvEntity result.
 * Extracted out of the route handler so the response-streaming wrapper can
 * treat the multipart and raw paths uniformly.
 */
function runMultipartIngest(args: {
  req: Request;
  orgId: string;
  entity: CsvEntity;
  onProgress: StreamCsvArgsOnProgress;
  signal: AbortSignal;
}): Promise<Awaited<ReturnType<typeof streamCsvEntity>>> {
  const { req, orgId, entity, onProgress, signal } = args;
  return new Promise((resolve, reject) => {
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

      streamCsvEntity({
        orgId,
        entity,
        input: fileStream,
        onProgress,
        signal,
      }).then(
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
  });
}

type StreamCsvArgsOnProgress = (p: StreamCsvProgress) => void;

router.post("/ingest/csv-stream", tenantMiddleware, requirePermission("ingest:write"), async (req, res) => {
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

  // Tie the lifecycle of the streaming ingest to the HTTP request: when the
  // browser calls `xhr.abort()` Express fires `req.on("aborted")` and we
  // trip this controller, which is forwarded into `streamCsvEntity` so it
  // stops flushing batches to the database mid-file.
  const abortController = new AbortController();
  req.on("aborted", () => {
    req.log.warn(
      { entity, orgId },
      "Streaming CSV upload aborted by client; cancelling ingest",
    );
    abortController.abort();
  });
  // `close` fires for both normal end and unexpected client disconnects;
  // the latter doesn't always emit `aborted` (e.g. underlying socket reset),
  // so trip the controller here too if the response never fully wrote out.
  res.on("close", () => {
    if (!res.writableEnded && !abortController.signal.aborted) {
      req.log.warn(
        { entity, orgId },
        "Streaming CSV response closed before completion; cancelling ingest",
      );
      abortController.abort();
    }
  });

  // -- Begin NDJSON streaming response. ------------------------------------
  // Pre-flight checks above already failed fast with conventional 4xx JSON
  // responses. Once we start writing the body we cannot change the status
  // code, so any error during streaming is reported as a `{ type: "error" }`
  // NDJSON line on a 200 response — the client treats event-level errors
  // distinctly from HTTP-level errors.
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  // Disable proxy buffering so progress events reach the browser promptly.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let lastEmit = 0;
  const writeEvent = (event: Record<string, unknown>): void => {
    if (res.writableEnded) return;
    res.write(`${JSON.stringify(event)}\n`);
  };

  const onProgress: StreamCsvArgsOnProgress = ({
    rowsParsed,
    rowsInserted,
    bytesProcessed,
  }) => {
    const now = Date.now();
    if (now - lastEmit < PROGRESS_EMIT_INTERVAL_MS) return;
    lastEmit = now;
    writeEvent({
      type: "progress",
      rowsParsed,
      rowsInserted,
      bytesProcessed,
    });
  };

  try {
    let result: Awaited<ReturnType<typeof streamCsvEntity>>;
    if (isMultipart(req)) {
      result = await runMultipartIngest({
        req,
        orgId,
        entity,
        onProgress,
        signal: abortController.signal,
      });
    } else {
      // Raw text/csv path — defense-in-depth byte counter and pipe req directly.
      let exceeded = false;
      attachByteLimit(req, MAX_STREAM_BYTES, () => {
        exceeded = true;
        req.log.warn(
          { entity, orgId },
          "Raw CSV upload exceeded byte limit; destroying request",
        );
      });
      result = await streamCsvEntity({
        orgId,
        entity,
        input: req,
        onProgress,
        signal: abortController.signal,
      });
      if (exceeded) {
        throw new Error(
          `Upload exceeded ${MAX_STREAM_BYTES}-byte (1 GB) per-request limit`,
        );
      }
    }
    writeEvent({ type: "result", ...result });
  } catch (err) {
    if (err instanceof CsvIngestAbortedError) {
      // Client cancelled the upload. The response socket is almost certainly
      // already torn down (the abort was triggered by the request itself
      // ending), so this `writeEvent` will usually be a no-op via the
      // `res.writableEnded` guard. Logging at info-level keeps cancellations
      // out of error dashboards.
      req.log.info(
        {
          entity,
          orgId,
          rowsParsed: err.rowsParsed,
          rowsInserted: err.rowsInserted,
        },
        "Streaming CSV ingest cancelled by client",
      );
      writeEvent({
        type: "cancelled",
        entity,
        rowsParsed: err.rowsParsed,
        rowsInserted: err.rowsInserted,
      });
    } else {
      req.log.error(
        { err, ...errorLogContext(err), entity, orgId },
        "Streaming CSV ingest failed",
      );
      writeEvent({
        type: "error",
        error: `CSV stream ingest failed: ${sanitizeDbErrorMessage(err)}`,
      });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

export default router;
