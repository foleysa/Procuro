import { db } from "@workspace/db";
import {
  suppliersTable,
  itemsTable,
  categoriesTable,
  contractsTable,
  contractItemsTable,
  purchaseOrdersTable,
  poLinesTable,
  invoicesTable,
  paymentsTable,
  shipmentsTable,
} from "@workspace/db";
import { sql, and, eq, inArray } from "drizzle-orm";
import { parse, type Parser } from "csv-parse";
import type { Readable } from "node:stream";
import { newId } from "../ids";
import { logger } from "../logger";
import { CANCELLED_ERROR_MESSAGE } from "../jobs/queue";
import { StructuralIngestError } from "../structural-ingest-error";
import { resolveBillingCurrency } from "../suppliers/billing-currency-resolver";
import { backfillSupplierBillingCurrency } from "../suppliers/backfill-billing-currency";
import type {
  IsCancelledFn,
  SourceAdapter,
  SyncResult,
} from "./source-adapter";
import {
  writeIngestPayload,
  type IngestPayload,
} from "./ingest-writer";

/**
 * CSV ingestion. Two entry points:
 *
 * 1. `csvSourceAdapter.fullSync({ orgId, config })` — accepts a structured
 *    JSON payload (`CsvPayload`) for the legacy demo path. All inserts are
 *    bulk-batched in 1000-row chunks for F500-scale data sets.
 *
 * 2. `streamCsvEntity({ orgId, entity, input })` — true streaming ingestion
 *    of a single entity's CSV file. The Node Readable is piped through
 *    `csv-parse`, rows are accumulated into BATCH_SIZE-row batches, and each
 *    batch is bulk-upserted via `INSERT ... ON CONFLICT DO UPDATE`. Memory
 *    stays bounded at ~`BATCH_SIZE` rows regardless of file size.
 */

// ---------- shared ----------

const SOURCE = "csv";
const BATCH_SIZE = 1000;

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Auto-detect a supplier's billing currency on ingest when the upstream
 * feed didn't supply one. Returns the explicit input untouched if it's
 * present (a non-empty 3-letter string after upper-casing); otherwise
 * runs the deterministic resolver against the country code.
 *
 * We only auto-set on **high** confidence (single-currency country) so
 * dollarized / ambiguous countries fall back to the org base currency
 * downstream — those rows are flagged via a logger warning so an
 * operator can review them on the supplier 360 page once it lands.
 *
 * Resolution order at ingest:
 *   1. Operator-provided value wins (high, source=`provided`).
 *   2. Else if the row carries an `invoiceSample` (free-form invoice
 *      text — line description, "Total: £1,234.56", an invoice
 *      number with embedded ISO code, etc.) the resolver's
 *      invoice-pattern path fires (ISO → high; symbol → medium).
 *   3. Else if `countryCode` maps to a single-currency country,
 *      auto-apply that (high, source=`country`).
 *   4. Else: leave null. Low-confidence hits (multi-currency or
 *      dollarized economies) are NOT auto-applied here — they're
 *      picked up later by
 *      `artifacts/api-server/src/lib/suppliers/backfill-billing-currency.ts`
 *      which scans PO line descriptions per supplier, or via the
 *      `manual_override` Supplier 360 endpoint.
 */
export interface IngestBillingCurrencyDecision {
  billingCurrency: string | null;
  billingCurrencySource:
    | "provided"
    | "country"
    | "invoice_iso"
    | "invoice_symbol"
    | null;
  billingCurrencyConfidence: "high" | "medium" | "low" | null;
}

function autoDetectBillingCurrency(
  explicit: string | null | undefined,
  countryCode: string | null | undefined,
  invoiceSample: string | null | undefined,
  supplierExternalId: string,
): IngestBillingCurrencyDecision {
  const trimmed = explicit?.trim();
  if (trimmed && trimmed.length >= 3) {
    return {
      billingCurrency: trimmed.toUpperCase(),
      billingCurrencySource: "provided",
      billingCurrencyConfidence: "high",
    };
  }
  const samples =
    invoiceSample && invoiceSample.trim() ? [invoiceSample] : [];
  const resolved = resolveBillingCurrency({
    countryCode,
    invoiceSamples: samples,
  });
  if (!resolved) {
    return {
      billingCurrency: null,
      billingCurrencySource: null,
      billingCurrencyConfidence: null,
    };
  }
  if (resolved.confidence === "high" || resolved.confidence === "medium") {
    const source =
      resolved.source === "country"
        ? "country"
        : resolved.source === "invoice_iso"
          ? "invoice_iso"
          : "invoice_symbol";
    return {
      billingCurrency: resolved.currency,
      billingCurrencySource: source,
      billingCurrencyConfidence: resolved.confidence,
    };
  }
  // Low confidence (e.g. dollarized country, no invoice sample) — log and
  // leave it for the post-PO backfill or a manual override.
  logger.info(
    {
      supplierExternalId,
      countryCode,
      resolved,
    },
    "supplier billing currency auto-detect skipped (low confidence)",
  );
  return {
    billingCurrency: null,
    billingCurrencySource: null,
    billingCurrencyConfidence: null,
  };
}

/**
 * Parse the suppliers `tags` CSV column. Mirrors the helper in the Data
 * Ingest page (`artifacts/command-center/src/pages/ingest.tsx`) so the
 * streaming path accepts the same `|`/`;`/`,` delimited format the
 * downloadable template documents.
 */
export function parseTagsCell(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(/[|;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

async function bulkInsert<T>(
  rows: T[],
  insertChunk: (chunk: T[]) => Promise<unknown>,
  chunkSize = BATCH_SIZE,
  isCancelled?: IsCancelledFn,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    // Check between batches so an operator pressing Cancel on the
    // System / Jobs page short-circuits long ingests within seconds
    // instead of waiting for the entire feed to drain.
    if (isCancelled && (await isCancelled())) {
      throw new Error(CANCELLED_ERROR_MESSAGE);
    }
    await insertChunk(rows.slice(i, i + chunkSize));
  }
}

// ---------- structured JSON payload (legacy demo path) ----------

/**
 * Back-compat alias. The structured CSV payload shape is identical to
 * the shared `IngestPayload` consumed by the live ERP connectors —
 * keep the name exported so existing callers (`ingestCsvHandler`, the
 * test suite, `routes/ingest.ts`) don't churn.
 *
 * For the canonical field documentation see
 * `artifacts/api-server/src/lib/adapters/ingest-writer.ts`.
 */
export type CsvPayload = IngestPayload;

export const csvSourceAdapter: SourceAdapter<CsvPayload> = {
  key: "csv",
  label: "CSV Bulk Upload",

  async fullSync({ orgId, config, onProgress, isCancelled }): Promise<SyncResult> {
    // Structured-payload writes are shared with the live ERP connector
    // path. Both produce the same procurement record shape, so the
    // upsert/dedup logic lives once in `ingest-writer.ts` and we just
    // tag the sourceSystem so a subsequent Coupa sync of the same
    // tenant doesn't collide with rows loaded from this CSV path.
    //
    // Supplier billing-currency auto-detect (Task #124 / #55) is
    // applied inside `writeIngestPayload` so both CSV bulk uploads
    // and live Coupa syncs get the same `country → currency`
    // inference (and the same logger trail for low-confidence rows).
    const result = await writeIngestPayload({
      orgId,
      sourceSystem: SOURCE,
      payload: config,
      batchSize: BATCH_SIZE,
      onProgress,
      isCancelled,
    });
    // Post-PO backfill: now that PO line descriptions exist, run the
    // invoice-pattern path of the resolver against any supplier whose
    // billing currency is still null (or only had a low-confidence
    // dollarized country hint). See
    // `artifacts/api-server/src/lib/suppliers/backfill-billing-currency.ts`.
    try {
      await backfillSupplierBillingCurrency(orgId);
    } catch (err) {
      logger.warn(
        { err, orgId },
        "supplier billing-currency backfill failed (non-fatal)",
      );
    }
    return result;
  },

  async incrementalSync(args) {
    return this.fullSync(args);
  },
};

// ---------- streaming CSV (per-entity, file-of-any-size) ----------

export type CsvEntity =
  | "suppliers"
  | "categories"
  | "items"
  | "purchase_orders"
  | "po_lines"
  | "invoices"
  | "payments"
  | "shipments";

export interface StreamCsvResult {
  entity: CsvEntity;
  rowsParsed: number;
  rowsInserted: number;
  durationMs: number;
}

export interface StreamCsvProgress {
  rowsParsed: number;
  rowsInserted: number;
  /**
   * Running count of bytes read off the upload stream so far. The route
   * forwards this to the client so the UI can render a server-side
   * progress bar (`bytesProcessed / totalFileSize`) and derive an ETA from
   * the rows/sec rate. Always present for streams that emit `Buffer`
   * chunks (multipart file parts, raw `text/csv` request bodies); zero for
   * exotic transports that don't.
   */
  bytesProcessed: number;
}

/**
 * Thrown by `streamCsvEntity` when the caller-supplied `AbortSignal` fires
 * mid-ingest (typically because the HTTP client cancelled the upload via
 * `xhr.abort()` and the route propagated the abort through to the adapter).
 *
 * Distinguishable from generic parse/DB errors so the `/ingest/csv-stream`
 * route can avoid logging cancellations as failures, and so callers can
 * tell a deliberate cancel apart from an unexpected crash.
 */
export class CsvIngestAbortedError extends Error {
  constructor(
    message = "CSV ingest cancelled by client",
    public readonly rowsParsed = 0,
    public readonly rowsInserted = 0,
  ) {
    super(message);
    this.name = "CsvIngestAbortedError";
  }
}

interface StreamCsvArgs {
  orgId: string;
  entity: CsvEntity;
  input: Readable;
  /** Override default batch size (default 1000). */
  batchSize?: number;
  /**
   * Called after every batch flush with the running totals. Used by the
   * `/ingest/csv-stream` route to forward incremental progress to the
   * client as NDJSON events while the server is still processing the file.
   * Throwing or rejecting from this callback is caught and logged but does
   * not abort the ingest (progress reporting is best-effort).
   */
  onProgress?: (progress: StreamCsvProgress) => void | Promise<void>;
  /**
   * Optional AbortSignal. When fired, the parser stream is destroyed, no
   * further batches are flushed to the database, and the function rejects
   * with `CsvIngestAbortedError` (carrying the parsed/inserted totals at
   * the moment of cancellation). Wired up by the `/ingest/csv-stream`
   * route so a client-side `xhr.abort()` actually short-circuits inserts
   * instead of letting the server keep writing to a dead socket.
   */
  signal?: AbortSignal;
}

/**
 * Stream-parse a single-entity CSV file and bulk-upsert in fixed-size
 * batches. Backpressure is honored via Parser stream events; memory stays
 * bounded at `batchSize` rows regardless of file size.
 */
export async function streamCsvEntity(
  args: StreamCsvArgs,
): Promise<StreamCsvResult> {
  const start = Date.now();
  const batchSize = args.batchSize ?? BATCH_SIZE;
  let rowsParsed = 0;
  let rowsInserted = 0;
  let bytesProcessed = 0;
  let buffer: Record<string, string>[] = [];

  const parser: Parser = args.input.pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
    }),
  );

  // Wire the optional AbortSignal: when fired, destroy both the parser and
  // the upstream input so the `for await` loop bails out and no further
  // batches are queued.
  const onAbort = (): void => {
    parser.destroy(new CsvIngestAbortedError());
    args.input.destroy();
  };
  if (args.signal) {
    if (args.signal.aborted) {
      // Cancelled before we even started; bail out before touching the DB.
      throw new CsvIngestAbortedError(
        "CSV ingest cancelled by client",
        rowsParsed,
        rowsInserted,
      );
    }
    args.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Count bytes off the source stream so the route can forward an
  // ETA-friendly `bytesProcessed` to the client. Attached *after* `.pipe()`
  // so pipe owns the consumer/backpressure relationship; this extra
  // listener is observation-only — Node delivers every `data` event to
  // every listener, so the byte counter sees the same chunks the parser
  // does without altering flow control.
  args.input.on("data", (chunk: Buffer | string) => {
    bytesProcessed += typeof chunk === "string"
      ? Buffer.byteLength(chunk)
      : chunk.length;
  });

  const reportProgress = async (): Promise<void> => {
    if (!args.onProgress) return;
    try {
      await args.onProgress({ rowsParsed, rowsInserted, bytesProcessed });
    } catch (err) {
      logger.warn(
        { entity: args.entity, err: (err as Error).message },
        "streamCsvEntity onProgress callback threw; ignoring",
      );
    }
  };

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const chunk = buffer;
    buffer = [];
    // Per-batch latency log (#73). Emitted as a structured event so an
    // operator (or the System page CSV throughput card) can chart
    // p50 / p95 latency over time without scraping free-form log
    // messages. We log at info on every batch — flushBatch already
    // batches inserts so the volume is bounded by `batchSize`.
    const batchStart = Date.now();
    const inserted = await flushBatch(args.orgId, args.entity, chunk);
    const batchDurationMs = Date.now() - batchStart;
    const rowsPerSecond =
      batchDurationMs > 0
        ? Math.round((chunk.length / batchDurationMs) * 1000)
        : null;
    logger.info(
      {
        event: "csv_batch_latency_ms",
        orgId: args.orgId,
        entity: args.entity,
        rows: chunk.length,
        inserted,
        durationMs: batchDurationMs,
        rowsPerSecond,
      },
      "csv_batch_latency_ms",
    );
    rowsInserted += inserted;
    await reportProgress();
  };

  try {
    for await (const row of parser) {
      // Cancellation check between rows. The `parser.destroy(...)` above
      // will also surface the abort as a thrown error from the iterator on
      // the next tick, but checking inline keeps the abort fast even if
      // the parser has buffered rows ahead of us.
      if (args.signal?.aborted) {
        throw new CsvIngestAbortedError(
          "CSV ingest cancelled by client",
          rowsParsed,
          rowsInserted,
        );
      }
      buffer.push(row as Record<string, string>);
      rowsParsed++;
      if (buffer.length >= batchSize) {
        // Pause backpressure: pause underlying stream while we flush.
        args.input.pause();
        // Re-check before the (potentially expensive) DB insert so an
        // abort that fires while we're queueing doesn't waste a write.
        if (args.signal?.aborted) {
          throw new CsvIngestAbortedError(
            "CSV ingest cancelled by client",
            rowsParsed,
            rowsInserted,
          );
        }
        await flush();
        args.input.resume();
      }
    }
    if (args.signal?.aborted) {
      throw new CsvIngestAbortedError(
        "CSV ingest cancelled by client",
        rowsParsed,
        rowsInserted,
      );
    }
    await flush();
  } catch (err) {
    if (err instanceof CsvIngestAbortedError) {
      // Promote the live counters into the thrown error so route logs and
      // tests can see how far we got before bailing.
      const aborted = new CsvIngestAbortedError(
        err.message,
        rowsParsed,
        rowsInserted,
      );
      logger.info(
        {
          entity: args.entity,
          rowsParsed,
          rowsInserted,
        },
        "CSV stream cancelled by client; halting further inserts",
      );
      throw aborted;
    }
    // The parser surfacing our injected `CsvIngestAbortedError` via the
    // `parser.destroy(err)` path can also arrive wrapped, so detect by
    // signal state as a fallback.
    if (args.signal?.aborted) {
      logger.info(
        {
          entity: args.entity,
          rowsParsed,
          rowsInserted,
        },
        "CSV stream cancelled by client; halting further inserts",
      );
      throw new CsvIngestAbortedError(
        "CSV ingest cancelled by client",
        rowsParsed,
        rowsInserted,
      );
    }
    logger.error(
      { entity: args.entity, rowsParsed, err: (err as Error).message },
      "CSV stream parse failed",
    );
    throw err;
  } finally {
    if (args.signal) {
      args.signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    entity: args.entity,
    rowsParsed,
    rowsInserted,
    durationMs: Date.now() - start,
  };
}

// Per-entity row mapping + bulk upsert.
async function flushBatch(
  orgId: string,
  entity: CsvEntity,
  rows: Record<string, string>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  switch (entity) {
    case "suppliers": {
      const v = rows.map((r) => {
        const decision = autoDetectBillingCurrency(
          r["billingCurrency"],
          r["countryCode"],
          r["invoiceSample"],
          r["externalId"] ?? "",
        );
        return {
          id: newId("sup"),
          orgId,
          name: r["name"]!,
          normalizedName: normalizeName(r["name"]!),
          countryCode: r["countryCode"] ?? null,
          billingCurrency: decision.billingCurrency,
          billingCurrencySource: decision.billingCurrencySource,
          billingCurrencyConfidence: decision.billingCurrencyConfidence,
          paymentTermsDays: r["paymentTermsDays"] ?? null,
          isStrategic: r["isStrategic"] === "true",
          isPreferred: r["isPreferred"] === "true",
          tags: parseTagsCell(r["tags"]),
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        };
      });
      const out = await db
        .insert(suppliersTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            suppliersTable.orgId,
            suppliersTable.sourceSystem,
            suppliersTable.sourceExternalId,
          ],
          set: {
            name: sql`excluded.name`,
            normalizedName: sql`excluded.normalized_name`,
            countryCode: sql`excluded.country_code`,
            // See the legacy path's note on coalesce — preserves
            // `manual_override` rows when the upload omits the column.
            billingCurrency: sql`coalesce(excluded.billing_currency, ${suppliersTable.billingCurrency})`,
            billingCurrencySource: sql`coalesce(excluded.billing_currency_source, ${suppliersTable.billingCurrencySource})`,
            billingCurrencyConfidence: sql`coalesce(excluded.billing_currency_confidence, ${suppliersTable.billingCurrencyConfidence})`,
            isStrategic: sql`excluded.is_strategic`,
            isPreferred: sql`excluded.is_preferred`,
            tags: sql`excluded.tags`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: suppliersTable.id });
      return out.length;
    }
    case "categories": {
      const v = rows.map((r) => ({
        id: newId("cat"),
        orgId,
        code: r["code"]!,
        name: r["name"]!,
        class: (r["class"] as "direct" | "indirect" | "service") ?? "indirect",
      }));
      const out = await db
        .insert(categoriesTable)
        .values(v)
        .onConflictDoUpdate({
          target: [categoriesTable.orgId, categoriesTable.code],
          set: {
            name: sql`excluded.name`,
            class: sql`excluded.class`,
          },
        })
        .returning({ id: categoriesTable.id });
      return out.length;
    }
    case "items": {
      const v = rows.map((r) => ({
        id: newId("itm"),
        orgId,
        sku: r["sku"]!,
        description: r["description"] ?? r["sku"]!,
        normalizedKey: r["normalizedKey"] ?? r["sku"]!.toUpperCase(),
        mfgPartNumber: r["mfgPartNumber"] ?? null,
        uom: r["uom"] ?? null,
        sourceSystem: SOURCE,
        sourceExternalId: r["externalId"]!,
      }));
      const out = await db
        .insert(itemsTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            itemsTable.orgId,
            itemsTable.sourceSystem,
            itemsTable.sourceExternalId,
          ],
          set: {
            description: sql`excluded.description`,
            normalizedKey: sql`excluded.normalized_key`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: itemsTable.id });
      return out.length;
    }
    case "invoices": {
      // Support both the streaming-native shape (`supplierId`/`poId` = real DB
      // ids) AND the page CSV shape (`supplierExternalId`/`poExternalId` =
      // source ids that need to be looked up). The page validator enforces the
      // external-id columns, so most real uploads go through the lookup path.
      const supExtIds = Array.from(
        new Set(
          rows
            .map((r) => r["supplierExternalId"])
            .filter((x): x is string => Boolean(x)),
        ),
      );
      const poExtIds = Array.from(
        new Set(
          rows
            .map((r) => r["poExternalId"])
            .filter((x): x is string => Boolean(x)),
        ),
      );
      const supLookup = new Map<string, string>();
      const poLookup = new Map<string, string>();
      if (supExtIds.length > 0) {
        const supRows = await db
          .select({
            id: suppliersTable.id,
            ext: suppliersTable.sourceExternalId,
          })
          .from(suppliersTable)
          .where(
            and(
              eq(suppliersTable.orgId, orgId),
              eq(suppliersTable.sourceSystem, SOURCE),
              inArray(suppliersTable.sourceExternalId, supExtIds),
            ),
          );
        for (const r of supRows) if (r.ext) supLookup.set(r.ext, r.id);
      }
      if (poExtIds.length > 0) {
        const poRows = await db
          .select({
            id: purchaseOrdersTable.id,
            ext: purchaseOrdersTable.sourceExternalId,
          })
          .from(purchaseOrdersTable)
          .where(
            and(
              eq(purchaseOrdersTable.orgId, orgId),
              eq(purchaseOrdersTable.sourceSystem, SOURCE),
              inArray(purchaseOrdersTable.sourceExternalId, poExtIds),
            ),
          );
        for (const r of poRows) if (r.ext) poLookup.set(r.ext, r.id);
      }
      const v = rows
        .map((r) => {
          const supplierId =
            r["supplierId"] ||
            (r["supplierExternalId"]
              ? supLookup.get(r["supplierExternalId"])
              : undefined);
          const poId =
            r["poId"] ||
            (r["poExternalId"] ? poLookup.get(r["poExternalId"]) : undefined);
          return { r, supplierId, poId };
        })
        .filter(
          (x) =>
            x.supplierId && x.r["amountUsd"] && x.r["invoiceDate"] && x.r["externalId"],
        )
        .map(({ r, supplierId, poId }) => ({
          id: newId("inv"),
          orgId,
          invoiceNumber: r["invoiceNumber"]!,
          supplierId: supplierId!,
          poId: poId ?? null,
          invoiceDate: new Date(r["invoiceDate"]!),
          amountUsd: Number(r["amountUsd"]!).toFixed(2),
          status:
            (r["status"] as
              | "received"
              | "approved"
              | "paid"
              | "disputed"
              | "void") ?? "received",
          dedupKey:
            r["dedupKey"] ??
            `${supplierId}|${Number(r["amountUsd"]!).toFixed(2)}|${r["invoiceDate"]!.slice(0, 10)}`,
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(invoicesTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            invoicesTable.orgId,
            invoicesTable.sourceSystem,
            invoicesTable.sourceExternalId,
          ],
          set: { sourceSyncedAt: sql`now()` },
        })
        .returning({ id: invoicesTable.id });
      return out.length;
    }
    case "purchase_orders": {
      // Resolve supplier external IDs in this batch via single grouped lookup.
      const supExtIds = Array.from(
        new Set(
          rows.map((r) => r["supplierExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const supLookup = new Map<string, string>();
      if (supExtIds.length > 0) {
        const supRows = await db
          .select({
            id: suppliersTable.id,
            ext: suppliersTable.sourceExternalId,
          })
          .from(suppliersTable)
          .where(
            and(
              eq(suppliersTable.orgId, orgId),
              eq(suppliersTable.sourceSystem, SOURCE),
              inArray(suppliersTable.sourceExternalId, supExtIds),
            ),
          );
        for (const r of supRows) if (r.ext) supLookup.set(r.ext, r.id);
      }
      const v = rows
        .filter(
          (r) =>
            r["externalId"] && supLookup.has(r["supplierExternalId"] ?? ""),
        )
        .map((r) => ({
          id: newId("po"),
          orgId,
          poNumber: r["poNumber"]!,
          supplierId: supLookup.get(r["supplierExternalId"]!)!,
          businessUnit: r["businessUnit"] ?? "Unknown",
          site: r["site"] ?? "Unknown",
          status:
            (r["status"] as
              | "open"
              | "closed"
              | "cancelled"
              | "received") ?? "open",
          orderDate: new Date(r["orderDate"]!),
          totalUsd: Number(r["totalUsd"] ?? "0").toFixed(2),
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(purchaseOrdersTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            purchaseOrdersTable.orgId,
            purchaseOrdersTable.sourceSystem,
            purchaseOrdersTable.sourceExternalId,
          ],
          set: {
            totalUsd: sql`excluded.total_usd`,
            status: sql`excluded.status`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: purchaseOrdersTable.id });
      return out.length;
    }
    case "po_lines": {
      // Resolve PO + category external IDs in two grouped lookups.
      const poExtIds = Array.from(
        new Set(
          rows.map((r) => r["poExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const catCodes = Array.from(
        new Set(
          rows
            .map((r) => r["categoryExternalId"] ?? r["categoryCode"])
            .filter(Boolean) as string[],
        ),
      );
      const poLookup = new Map<string, string>();
      const catLookup = new Map<string, string>();
      if (poExtIds.length > 0) {
        const poRows = await db
          .select({
            id: purchaseOrdersTable.id,
            ext: purchaseOrdersTable.sourceExternalId,
          })
          .from(purchaseOrdersTable)
          .where(
            and(
              eq(purchaseOrdersTable.orgId, orgId),
              eq(purchaseOrdersTable.sourceSystem, SOURCE),
              inArray(purchaseOrdersTable.sourceExternalId, poExtIds),
            ),
          );
        for (const r of poRows) if (r.ext) poLookup.set(r.ext, r.id);
      }
      if (catCodes.length > 0) {
        // Categories key off `code` (a UNIQUE business key per org); the
        // streamed feed can supply either column name.
        const catRows = await db
          .select({ id: categoriesTable.id, code: categoriesTable.code })
          .from(categoriesTable)
          .where(
            and(
              eq(categoriesTable.orgId, orgId),
              inArray(categoriesTable.code, catCodes),
            ),
          );
        for (const r of catRows) if (r.code) catLookup.set(r.code, r.id);
      }
      const v = rows
        .filter(
          (r) => r["externalId"] && poLookup.has(r["poExternalId"] ?? ""),
        )
        .map((r) => {
          const qty = Number(r["qty"] ?? "0");
          const unitPrice = Number(r["unitPriceUsd"] ?? "0");
          const catKey = r["categoryExternalId"] ?? r["categoryCode"] ?? "";
          return {
            id: newId("pol"),
            orgId,
            poId: poLookup.get(r["poExternalId"]!)!,
            lineNumber: parseInt(r["lineNumber"] ?? "1", 10) || 1,
            sku: r["sku"]!,
            description: r["description"] ?? r["sku"]!,
            categoryId: catKey ? catLookup.get(catKey) ?? null : null,
            spendClass:
              (r["spendClass"] as "direct" | "indirect" | "service") ??
              "indirect",
            qty: qty.toFixed(4),
            uom: r["uom"] ?? null,
            unitPriceUsd: unitPrice.toFixed(4),
            extendedUsd: (qty * unitPrice).toFixed(2),
            orderDate: new Date(r["orderDate"] ?? new Date().toISOString()),
            sourceSystem: SOURCE,
            sourceExternalId: r["externalId"]!,
          };
        });
      if (v.length === 0) return 0;
      const out = await db
        .insert(poLinesTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            poLinesTable.orgId,
            poLinesTable.sourceSystem,
            poLinesTable.sourceExternalId,
          ],
          set: {
            qty: sql`excluded.qty`,
            unitPriceUsd: sql`excluded.unit_price_usd`,
            extendedUsd: sql`excluded.extended_usd`,
            description: sql`excluded.description`,
            spendClass: sql`excluded.spend_class`,
            uom: sql`excluded.uom`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: poLinesTable.id });
      return out.length;
    }
    case "payments": {
      // Resolve invoice external IDs.
      const invExtIds = Array.from(
        new Set(
          rows.map((r) => r["invoiceExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const invLookup = new Map<string, string>();
      if (invExtIds.length > 0) {
        const invRows = await db
          .select({
            id: invoicesTable.id,
            ext: invoicesTable.sourceExternalId,
          })
          .from(invoicesTable)
          .where(
            and(
              eq(invoicesTable.orgId, orgId),
              eq(invoicesTable.sourceSystem, SOURCE),
              inArray(invoicesTable.sourceExternalId, invExtIds),
            ),
          );
        for (const r of invRows) if (r.ext) invLookup.set(r.ext, r.id);
      }
      const v = rows
        .filter(
          (r) =>
            r["externalId"] && invLookup.has(r["invoiceExternalId"] ?? ""),
        )
        .map((r) => ({
          id: newId("pay"),
          orgId,
          invoiceId: invLookup.get(r["invoiceExternalId"]!)!,
          paidDate: new Date(r["paidDate"]!),
          amountUsd: Number(r["amountUsd"] ?? "0").toFixed(2),
          paymentTermsDays: r["paymentTermsDays"]
            ? parseInt(r["paymentTermsDays"], 10)
            : null,
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(paymentsTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            paymentsTable.orgId,
            paymentsTable.sourceSystem,
            paymentsTable.sourceExternalId,
          ],
          set: {
            amountUsd: sql`excluded.amount_usd`,
            paidDate: sql`excluded.paid_date`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: paymentsTable.id });
      return out.length;
    }
    case "shipments": {
      // Optional PO + supplier external ID lookups.
      const poExtIds = Array.from(
        new Set(
          rows.map((r) => r["poExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const supExtIds = Array.from(
        new Set(
          rows.map((r) => r["supplierExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const poLookup = new Map<string, string>();
      const supLookup = new Map<string, string>();
      if (poExtIds.length > 0) {
        const poRows = await db
          .select({
            id: purchaseOrdersTable.id,
            ext: purchaseOrdersTable.sourceExternalId,
          })
          .from(purchaseOrdersTable)
          .where(
            and(
              eq(purchaseOrdersTable.orgId, orgId),
              eq(purchaseOrdersTable.sourceSystem, SOURCE),
              inArray(purchaseOrdersTable.sourceExternalId, poExtIds),
            ),
          );
        for (const r of poRows) if (r.ext) poLookup.set(r.ext, r.id);
      }
      if (supExtIds.length > 0) {
        const supRows = await db
          .select({
            id: suppliersTable.id,
            ext: suppliersTable.sourceExternalId,
          })
          .from(suppliersTable)
          .where(
            and(
              eq(suppliersTable.orgId, orgId),
              eq(suppliersTable.sourceSystem, SOURCE),
              inArray(suppliersTable.sourceExternalId, supExtIds),
            ),
          );
        for (const r of supRows) if (r.ext) supLookup.set(r.ext, r.id);
      }
      const v = rows
        .filter((r) => r["externalId"])
        .map((r) => ({
          id: newId("shp"),
          orgId,
          poId: r["poExternalId"]
            ? poLookup.get(r["poExternalId"]) ?? null
            : null,
          supplierId: r["supplierExternalId"]
            ? supLookup.get(r["supplierExternalId"]) ?? null
            : null,
          carrier: r["carrier"]!,
          mode:
            (r["mode"] as "ocean" | "air" | "ltl" | "tl" | "parcel" | "rail") ??
            "tl",
          originCountry: r["originCountry"] ?? null,
          destCountry: r["destCountry"] ?? null,
          laneKey: r["laneKey"] ?? "UNKNOWN",
          weightKg: r["weightKg"]
            ? Number(r["weightKg"]).toFixed(2)
            : null,
          freightCostUsd: Number(r["freightCostUsd"] ?? "0").toFixed(2),
          incoterms: r["incoterms"] ?? null,
          shipDate: new Date(r["shipDate"] ?? new Date().toISOString()),
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(shipmentsTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            shipmentsTable.orgId,
            shipmentsTable.sourceSystem,
            shipmentsTable.sourceExternalId,
          ],
          set: {
            carrier: sql`excluded.carrier`,
            freightCostUsd: sql`excluded.freight_cost_usd`,
            shipDate: sql`excluded.ship_date`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: shipmentsTable.id });
      return out.length;
    }
    default: {
      const _exhaustive: never = entity;
      // Permanent input error: an unknown entity name will never become
      // valid by retrying. Throw `StructuralIngestError` so any caller
      // running this through the job queue fails immediately on
      // attempt #1 (via the worker's `wrapStructuralError`) instead of
      // burning the full retry budget on a typo. Routes that surface
      // the message to the client also see this as a structural error
      // (no SQL, no PII; the offending entity name is the value).
      throw new StructuralIngestError(
        `streamCsvEntity: unknown entity '${_exhaustive}'`,
        { field: "entity", value: String(_exhaustive) },
      );
    }
  }
}
