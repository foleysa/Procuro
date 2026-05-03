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
  statementsOfWorkTable,
  rateCardsTable,
  rateCardLinesTable,
  timeEntriesTable,
} from "@workspace/db";
import { sql, and, eq, inArray } from "drizzle-orm";
import { parse, type Parser } from "csv-parse";
import type { Readable } from "node:stream";
import type { Logger } from "pino";
import { newId } from "../ids";
import { logger } from "../logger";
import { CANCELLED_ERROR_MESSAGE } from "../jobs/queue";
import { resolveBillingCurrency } from "../suppliers/billing-currency-resolver";
import { backfillSupplierBillingCurrency } from "../suppliers/backfill-billing-currency";
import type {
  IngestWarning,
  IsCancelledFn,
  SourceAdapter,
  SyncResult,
} from "./source-adapter";
import {
  writeIngestPayload,
  type IngestPayload,
} from "./ingest-writer";
import { parsePgUniqueViolation } from "../sanitize-db-error";

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
  | "shipments"
  // Task #214 — services taxonomy entities. Each streams the table's
  // own rows; nested children (sow milestones, change orders) are
  // currently only available via the structured JSON `IngestPayload`
  // path because they don't have a 1:1 streamable shape.
  | "statements_of_work"
  | "rate_cards"
  | "rate_card_lines"
  | "time_entries";

export interface StreamCsvResult {
  entity: CsvEntity;
  rowsParsed: number;
  rowsInserted: number;
  /**
   * Rows the adapter intentionally dropped (e.g. an unknown entity
   * name reaching `flushBatch` despite the route's upfront validation).
   * Mirrors `SyncResult.recordsSkipped` for the streaming path so the
   * job-result viewer / NDJSON consumers see the same shape regardless
   * of whether the upload went through the JSON `IngestPayload` path
   * or the streaming-CSV path. Optional — omitted when zero.
   */
  rowsSkipped?: number;
  /**
   * Per-batch warnings, mirroring `SyncResult.warnings` for symmetry
   * with the JSON ingest path. Optional — omitted when empty.
   */
  warnings?: IngestWarning[];
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

/**
 * Thrown by `flushBatch` when an `INSERT ... ON CONFLICT DO UPDATE`
 * upsert is rejected by Postgres with SQLSTATE 23505 because a
 * uploaded row collides with an *existing* DB row on a unique
 * constraint that is **not** the upsert's conflict target. Common
 * trigger: the `items` table upserts on `(orgId, sourceSystem,
 * sourceExternalId)` but also enforces `(orgId, sku)` — uploading a
 * row with a fresh `externalId` but a `sku` that already lives in the
 * tenant's catalog falls through the conflict target and trips the
 * second unique index.
 *
 * Without this class the request fell through to
 * `sanitizeDbErrorMessage`, which (correctly) refuses to echo the PG
 * `detail` text verbatim because it can contain caller-supplied data
 * — leaving the operator with `Database error 23505 on table "items",
 * constraint "items_org_sku_uq"` and no pointer back into their CSV.
 *
 * `flushBatch` parses the structured `(columns)=(values)` out of the
 * `detail` line via `parsePgUniqueViolation`, locates the offending
 * `BufferedRow` by matching the parsed values against the row's CSV
 * cells, and rethrows this class with a 1-based `rowNumber`/`line`
 * pair plus a structured `conflictKey` map. The route's NDJSON error
 * event then carries those fields so the UI can point the operator
 * at the exact upload row to fix (Task #182).
 *
 * The conflict key is only echoed back to the org that uploaded the
 * file, so it is safe to include the tenant's own values verbatim
 * — safe to echo back because the response only flows to the org that
 * uploaded the file.
 *
 * Branded `unrecoverable: true` so the job worker fails the job on
 * attempt #1 instead of burning the retry budget on user input that
 * cannot succeed without a CSV edit.
 */
export class CsvExistingDuplicateError extends Error {
  readonly unrecoverable = true as const;
  readonly entity: CsvEntity;
  /**
   * 1-based index of the offending data row (header excluded). `null`
   * when the parsed conflict values couldn't be matched against any
   * buffered row — e.g. the colliding columns are derived (`id`,
   * `normalizedName`) rather than copied straight from the CSV. The
   * route still emits the conflict key in that case so the operator
   * sees what collided, just without a row pointer.
   */
  readonly rowNumber: number | null;
  /** 1-based source CSV line for `rowNumber` (header is line 1). */
  readonly line: number | null;
  /**
   * Column → value pairs parsed from the PG `detail`. Keys are
   * camelCase (snake → camel converted) so they line up with the
   * `pg`/Drizzle column names the rest of the API uses; values are
   * the raw bytes Postgres reported.
   */
  readonly conflictKey: Record<string, string>;
  /** Name of the violated unique constraint, when PG reports it. */
  readonly constraint: string | null;

  constructor(args: {
    entity: CsvEntity;
    rowNumber: number | null;
    line: number | null;
    conflictKey: Record<string, string>;
    constraint: string | null;
  }) {
    const pairs = Object.entries(args.conflictKey)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const where =
      args.rowNumber !== null && args.line !== null
        ? `Row ${args.rowNumber} (line ${args.line}) `
        : "A row in this upload ";
    super(
      `${where}collides with an existing ${args.entity} record on ${pairs}. ` +
        `Update or remove the row and try again.`,
    );
    this.name = "CsvExistingDuplicateError";
    this.entity = args.entity;
    this.rowNumber = args.rowNumber;
    this.line = args.line;
    this.conflictKey = args.conflictKey;
    this.constraint = args.constraint;
  }
}

/**
 * `source_external_id` → `sourceExternalId`. Lossless against any
 * snake_case identifier that doesn't start with an underscore (which
 * PG column names never do).
 */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Locate the buffered row that produced a 23505 collision by matching
 * the parsed PG values against the row's CSV cells. Most natural-key
 * columns (`source_external_id`, `sku`, `code`) come straight from
 * the upload, so value-membership against the row's cells finds the
 * offender even when the DB column name doesn't equal any CSV header.
 *
 * Scoring is per-value rather than all-or-nothing because composite
 * unique indexes routinely include columns that are NOT part of the
 * CSV (`org_id` is server-injected, `normalized_name` is derived,
 * etc.). We pick the row with the highest match count, requiring at
 * least one value to match, and break ties by row order so the
 * earliest offending row wins. Returns `null` only when no row in
 * the buffer carries any of the parsed values — in which case
 * callers still emit the conflict key without a row pointer so the
 * operator at least sees what collided.
 */
function findRowMatchingPgValues(
  buffered: BufferedRow[],
  values: string[],
): BufferedRow | null {
  let best: { row: BufferedRow; score: number } | null = null;
  for (const b of buffered) {
    const cells = Object.values(b.row);
    let score = 0;
    for (const v of values) {
      if (v.length > 0 && cells.includes(v)) score++;
    }
    if (score > 0 && (best === null || score > best.score)) {
      best = { row: b, score };
    }
  }
  return best?.row ?? null;
}

/**
 * Per-entity description of the natural-key columns that map to the
 * `INSERT ... ON CONFLICT DO UPDATE` conflict target on the bulk upserts
 * in `flushBatch`. `compute` returns `null` when the row doesn't carry
 * the required column(s) — those rows can't collide with anything yet
 * (they'll be filtered out further down by the entity-specific mappers
 * before the DB insert), so we skip them in the duplicate pre-check.
 *
 * `label` is what the operator-facing error message uses, so keep it
 * stable / contract-y rather than tying it to internal column names.
 */
interface ConflictKeySpec {
  label: string;
  compute(row: Record<string, string>): string | null;
}

const CONFLICT_KEY_SPECS: Record<CsvEntity, ConflictKeySpec> = {
  suppliers: {
    label: "externalId",
    compute: (r) => r["externalId"] || null,
  },
  categories: {
    // categories upserts on (orgId, code) — `sourceExternalId` isn't part
    // of the conflict target, so this is the only column that matters.
    label: "code",
    compute: (r) => r["code"] || null,
  },
  items: {
    label: "externalId",
    compute: (r) => r["externalId"] || null,
  },
  invoices: {
    label: "externalId",
    compute: (r) => r["externalId"] || null,
  },
  purchase_orders: {
    label: "externalId",
    compute: (r) => r["externalId"] || null,
  },
  po_lines: {
    label: "externalId",
    compute: (r) => r["externalId"] || null,
  },
  payments: {
    label: "externalId",
    compute: (r) => r["externalId"] || null,
  },
  shipments: {
    label: "externalId",
    compute: (r) => r["externalId"] || null,
  },
  statements_of_work: {
    label: "externalId",
    compute: (r) => r["externalId"] || null,
  },
  rate_cards: {
    label: "externalId",
    compute: (r) => r["externalId"] || null,
  },
  rate_card_lines: {
    // rate_card_lines upserts on (rateCardId, role, seniority); the
    // rateCardId is resolved from `rateCardExternalId` so two rows that
    // share the (external id, role, seniority) tuple end up on the same
    // resolved rate-card id and trigger SQLSTATE 21000.
    label: "rateCardExternalId+role+seniority",
    compute: (r) => {
      const rc = r["rateCardExternalId"];
      const role = r["role"];
      if (!rc || !role) return null;
      // `seniority` is nullable; coalesce to a sentinel so two rows
      // with NULL seniority still collide on the composite key.
      return `${rc}|${role}|${r["seniority"] ?? ""}`;
    },
  },
  time_entries: {
    label: "externalId",
    compute: (r) => r["externalId"] || null,
  },
};

/**
 * One row in the streaming buffer. Carries the parsed CSV record plus
 * the metadata `flushBatch` needs to point the operator at the right
 * line in their file when an in-batch duplicate is detected.
 */
interface BufferedRow {
  row: Record<string, string>;
  rowIndex: number;
  line: number;
}

/**
 * Dedupe the buffered batch by its entity-specific conflict-target key
 * with last-write-wins semantics (Task #279). Returns a new array
 * containing at most one row per conflict-target value; for any key
 * that appeared more than once the LATEST occurrence (the row closest
 * to end of the upload) is kept and the earlier rows are dropped, then
 * a single `info` log line records the collapse so an operator can
 * audit which CSV lines were superseded.
 *
 * Rationale: previously this function threw an error and aborted the
 * entire upload — extremely punishing for multi-million-row feeds where
 * the tail of the file might re-state a header row already present in
 * the same batch. Postgres' own `INSERT ... ON CONFLICT DO UPDATE`
 * across separate statements has the same last-write-wins effect on
 * the DB row; the pre-check just makes the in-batch case match.
 *
 * Order is preserved: the deduped array keeps the rows in the same
 * relative order they appeared in the upload (the "winning" row for
 * each key takes that key's last position).
 *
 * Runs in O(n) over a single batch (≤ `BATCH_SIZE` = 1000 rows by
 * default).
 */
function dedupeBatch(
  entity: CsvEntity,
  buffered: BufferedRow[],
): BufferedRow[] {
  const spec = CONFLICT_KEY_SPECS[entity];
  // Map<key, indexInBuffered of the LAST row carrying that key>.
  const latestIndexByKey = new Map<string, number>();
  // Track all duplicate-line groups for a single audit log line.
  const collapsed: Array<{
    key: string;
    keptLine: number;
    droppedLines: number[];
  }> = [];
  const previousIndexByKey = new Map<string, number>();

  for (let i = 0; i < buffered.length; i++) {
    const key = spec.compute(buffered[i]!.row);
    if (key === null) continue;
    const prev = latestIndexByKey.get(key);
    if (prev !== undefined) {
      previousIndexByKey.set(key, prev);
    }
    latestIndexByKey.set(key, i);
  }

  if (latestIndexByKey.size === 0 || previousIndexByKey.size === 0) {
    return buffered;
  }

  // Build dedupe set: drop indexes that are NOT the latest for their key.
  const indexesToDrop = new Set<number>();
  // Group all earlier-than-latest rows by key for the audit log.
  const droppedByKey = new Map<string, number[]>();
  for (let i = 0; i < buffered.length; i++) {
    const key = spec.compute(buffered[i]!.row);
    if (key === null) continue;
    const latest = latestIndexByKey.get(key)!;
    if (i !== latest) {
      indexesToDrop.add(i);
      let list = droppedByKey.get(key);
      if (!list) {
        list = [];
        droppedByKey.set(key, list);
      }
      list.push(buffered[i]!.line);
    }
  }
  for (const [key, droppedLines] of droppedByKey) {
    const latest = latestIndexByKey.get(key)!;
    collapsed.push({
      key,
      keptLine: buffered[latest]!.line,
      droppedLines,
    });
  }

  if (collapsed.length > 0) {
    logger.info(
      {
        entity,
        conflictKey: spec.label,
        collapsedKeyCount: collapsed.length,
        droppedRowCount: indexesToDrop.size,
        // Cap the per-key sample so an extremely repetitive feed doesn't
        // blow up the log line size; the totals above are exact.
        sample: collapsed.slice(0, 10),
      },
      "csv ingest: collapsed in-batch duplicate rows (last write wins)",
    );
  }

  return buffered.filter((_, i) => !indexesToDrop.has(i));
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
  /**
   * Optional pino logger to use for per-batch latency events (#73). The
   * `/ingest/csv-stream` route passes `req.log` so each batch flush log
   * inherits the per-request id (`reqId`) emitted by `pino-http`, which
   * lets an operator grep production logs by upload — e.g.
   * `reqId=abc123 event=csv_batch_flush` — instead of guessing which
   * batches belong to which customer's file.
   *
   * If omitted (e.g. async job worker, fixture-driven tests), batch logs
   * fall back to the singleton `logger` so the lines still land in the
   * structured log stream — they just won't carry a request id.
   */
  log?: Logger;
}

/**
 * Per-batch flush latency above this threshold is escalated from `debug`
 * to `info` so it shows up in production logs by default (#73).
 *
 * Sized to be ~5–10× the per-batch p50 across the entity types
 * documented in `routes/ingest.ts` (per-batch p50 sits in the
 * 80–200 ms range, with p95 closer to 200 ms; a single batch crossing
 * 1 s usually means a cold pool, contended index, or a bad query plan
 * from skewed data — exactly the kind of event we want surfaced).
 *
 * Volume rationale: at LOG_LEVEL=info (the production default) only
 * slow batches log; healthy multi-million-row uploads stay quiet.
 * Operators can flip LOG_LEVEL=debug to get every batch when
 * investigating a regression.
 */
const SLOW_BATCH_LOG_THRESHOLD_MS = 1000;

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
  // Per-batch latency lines (#73) inherit the per-request id when the
  // route passes `req.log`; falls back to the singleton logger for
  // job-runner / test callers that don't have a request scope.
  const log: Logger = args.log ?? logger;
  let rowsParsed = 0;
  let rowsInserted = 0;
  let bytesProcessed = 0;
  let batchIndex = 0;
  let buffer: BufferedRow[] = [];

  const parser: Parser = args.input.pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      // Wrap each yielded record in `{ record, info }` so we can attach
      // the source CSV line number to every buffered row. `flushBatch`'s
      // duplicate pre-check uses `info.lines` to tell the operator
      // exactly which lines collided when an in-batch
      // conflict-target-key duplicate is detected (Task #89).
      info: true,
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
    // messages. To keep multi-million-row uploads from flooding the
    // log stream, we emit at `debug` for healthy batches and only
    // escalate to `info` when a single batch crosses
    // `SLOW_BATCH_LOG_THRESHOLD_MS` — that's the case operators
    // actually want paged on (cold pool, contended index, bad plan).
    const batchStart = Date.now();
    const inserted = await flushBatch(args.orgId, args.entity, chunk);
    const batchDurationMs = Date.now() - batchStart;
    batchIndex++;
    rowsInserted += inserted;
    const rowsPerSecond =
      batchDurationMs > 0
        ? Math.round((chunk.length / batchDurationMs) * 1000)
        : null;
    const isSlow = batchDurationMs >= SLOW_BATCH_LOG_THRESHOLD_MS;
    const logFields = {
      event: "csv_batch_flush",
      orgId: args.orgId,
      entity: args.entity,
      batchIndex,
      rows: chunk.length,
      inserted,
      durationMs: batchDurationMs,
      rowsPerSecond,
      // Running totals so a single line is enough to reconstruct where
      // in the upload a slow batch happened, without correlating
      // against earlier debug lines that may have been filtered out
      // by the production log level.
      rowsParsed,
      rowsInserted,
      bytesProcessed,
      slowBatch: isSlow,
      slowBatchThresholdMs: SLOW_BATCH_LOG_THRESHOLD_MS,
    };
    if (isSlow) {
      log.info(logFields, "csv_batch_flush slow");
    } else {
      log.debug(logFields, "csv_batch_flush");
    }
    await reportProgress();
  };

  try {
    for await (const item of parser) {
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
      // With `info: true` set above, csv-parse yields `{ record, info }`
      // instead of the bare record. `info.lines` is the 1-based source
      // line number of the record (honours quoted multi-line cells), and
      // we maintain our own 1-based data-row index alongside it for the
      // duplicate pre-check error payload.
      const { record, info } = item as {
        record: Record<string, string>;
        info: { lines: number };
      };
      rowsParsed++;
      buffer.push({ row: record, rowIndex: rowsParsed, line: info.lines });
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
  buffered: BufferedRow[],
): Promise<number> {
  if (buffered.length === 0) return 0;
  // Dedupe the batch by its entity-specific conflict-target key BEFORE
  // sending the chunk to Postgres (Task #279, supersedes Task #89's
  // throw-on-duplicate behavior). Two rows in the same batch sharing
  // the natural key would otherwise hit `INSERT ... ON CONFLICT DO
  // UPDATE` and Postgres rejects the statement with SQLSTATE 21000
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  // Policy is documented `last write wins`: the latest row in the
  // upload supersedes earlier rows with the same key, matching the
  // observable behavior of separate `INSERT ... ON CONFLICT` statements
  // applied in upload order. Collapsed rows are logged at `info` so an
  // operator can audit which CSV lines were superseded.
  buffered = dedupeBatch(entity, buffered);
  // The rest of this function is shape-preserving against the original
  // `Record<string, string>[]` parameter, so unwrap the buffered metadata
  // once and let the per-entity branches keep operating on plain rows.
  const rows: Record<string, string>[] = buffered.map((b) => b.row);
  try {
    return await flushBatchInner(orgId, entity, rows);
  } catch (err) {
    // Translate a Postgres 23505 unique-violation thrown by any of the
    // per-entity upserts into a structured `CsvExistingDuplicateError`
    // so the route can attach `rowNumber` + `conflictKey` to the NDJSON
    // error event (Task #182). For non-23505 errors the original is
    // rethrown unchanged so the route's existing sanitizer/logger path
    // still runs.
    const parsed = parsePgUniqueViolation(err);
    if (!parsed) throw err;
    const conflictKey: Record<string, string> = {};
    parsed.columns.forEach((col, i) => {
      conflictKey[snakeToCamel(col)] = parsed.values[i] ?? "";
    });
    const matched = findRowMatchingPgValues(buffered, parsed.values);
    throw new CsvExistingDuplicateError({
      entity,
      rowNumber: matched?.rowIndex ?? null,
      line: matched?.line ?? null,
      conflictKey,
      constraint: parsed.constraint,
    });
  }
}

async function flushBatchInner(
  orgId: string,
  entity: CsvEntity,
  rows: Record<string, string>[],
): Promise<number> {
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
    case "statements_of_work": {
      // Resolve parent contract + supplier external IDs.
      const ctExtIds = Array.from(
        new Set(
          rows
            .map((r) => r["contractExternalId"]!)
            .filter(Boolean) as string[],
        ),
      );
      const supExtIds = Array.from(
        new Set(
          rows.map((r) => r["supplierExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const ctLookup = new Map<string, string>();
      const supLookup = new Map<string, string>();
      if (ctExtIds.length > 0) {
        const ctRows = await db
          .select({
            id: contractsTable.id,
            ext: contractsTable.sourceExternalId,
          })
          .from(contractsTable)
          .where(
            and(
              eq(contractsTable.orgId, orgId),
              eq(contractsTable.sourceSystem, SOURCE),
              inArray(contractsTable.sourceExternalId, ctExtIds),
            ),
          );
        for (const r of ctRows) if (r.ext) ctLookup.set(r.ext, r.id);
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
        .filter(
          (r) =>
            r["externalId"] &&
            ctLookup.has(r["contractExternalId"] ?? "") &&
            supLookup.has(r["supplierExternalId"] ?? ""),
        )
        .map((r) => ({
          id: newId("sow"),
          orgId,
          contractId: ctLookup.get(r["contractExternalId"]!)!,
          supplierId: supLookup.get(r["supplierExternalId"]!)!,
          sowNumber: r["sowNumber"] ?? r["externalId"]!,
          title: r["title"] ?? r["sowNumber"] ?? r["externalId"]!,
          status:
            (r["status"] as
              | "draft"
              | "active"
              | "completed"
              | "cancelled") ?? "active",
          startDate: new Date(r["startDate"]!),
          endDate: new Date(r["endDate"]!),
          totalValueUsd: r["totalValueUsd"]
            ? Number(r["totalValueUsd"]).toFixed(2)
            : null,
          billingCurrency: r["billingCurrency"] ?? null,
          acceptanceCriteria: r["acceptanceCriteria"] ?? null,
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(statementsOfWorkTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            statementsOfWorkTable.orgId,
            statementsOfWorkTable.sourceSystem,
            statementsOfWorkTable.sourceExternalId,
          ],
          set: {
            title: sql`excluded.title`,
            status: sql`excluded.status`,
            startDate: sql`excluded.start_date`,
            endDate: sql`excluded.end_date`,
            totalValueUsd: sql`excluded.total_value_usd`,
            billingCurrency: sql`excluded.billing_currency`,
            acceptanceCriteria: sql`excluded.acceptance_criteria`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: statementsOfWorkTable.id });
      return out.length;
    }
    case "rate_cards": {
      const ctExtIds = Array.from(
        new Set(
          rows
            .map((r) => r["contractExternalId"]!)
            .filter(Boolean) as string[],
        ),
      );
      const sowExtIds = Array.from(
        new Set(
          rows.map((r) => r["sowExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const supExtIds = Array.from(
        new Set(
          rows.map((r) => r["supplierExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const ctLookup = new Map<string, string>();
      const sowLookup = new Map<string, string>();
      const supLookup = new Map<string, string>();
      if (ctExtIds.length > 0) {
        const ctRows = await db
          .select({
            id: contractsTable.id,
            ext: contractsTable.sourceExternalId,
          })
          .from(contractsTable)
          .where(
            and(
              eq(contractsTable.orgId, orgId),
              eq(contractsTable.sourceSystem, SOURCE),
              inArray(contractsTable.sourceExternalId, ctExtIds),
            ),
          );
        for (const r of ctRows) if (r.ext) ctLookup.set(r.ext, r.id);
      }
      if (sowExtIds.length > 0) {
        const sowRows = await db
          .select({
            id: statementsOfWorkTable.id,
            ext: statementsOfWorkTable.sourceExternalId,
          })
          .from(statementsOfWorkTable)
          .where(
            and(
              eq(statementsOfWorkTable.orgId, orgId),
              eq(statementsOfWorkTable.sourceSystem, SOURCE),
              inArray(statementsOfWorkTable.sourceExternalId, sowExtIds),
            ),
          );
        for (const r of sowRows) if (r.ext) sowLookup.set(r.ext, r.id);
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
        .filter(
          (r) =>
            r["externalId"] && supLookup.has(r["supplierExternalId"] ?? ""),
        )
        .map((r) => ({
          id: newId("rc"),
          orgId,
          contractId: r["contractExternalId"]
            ? ctLookup.get(r["contractExternalId"]) ?? null
            : null,
          sowId: r["sowExternalId"]
            ? sowLookup.get(r["sowExternalId"]) ?? null
            : null,
          supplierId: supLookup.get(r["supplierExternalId"]!)!,
          name: r["name"] ?? r["externalId"]!,
          currency: r["currency"] ?? "USD",
          effectiveDate: new Date(r["effectiveDate"]!),
          expiryDate: r["expiryDate"] ? new Date(r["expiryDate"]) : null,
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(rateCardsTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            rateCardsTable.orgId,
            rateCardsTable.sourceSystem,
            rateCardsTable.sourceExternalId,
          ],
          set: {
            name: sql`excluded.name`,
            currency: sql`excluded.currency`,
            effectiveDate: sql`excluded.effective_date`,
            expiryDate: sql`excluded.expiry_date`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: rateCardsTable.id });
      return out.length;
    }
    case "rate_card_lines": {
      // Lookup parent rate cards by external id.
      const rcExtIds = Array.from(
        new Set(
          rows
            .map((r) => r["rateCardExternalId"]!)
            .filter(Boolean) as string[],
        ),
      );
      const rcLookup = new Map<string, string>();
      if (rcExtIds.length > 0) {
        const rcRows = await db
          .select({
            id: rateCardsTable.id,
            ext: rateCardsTable.sourceExternalId,
          })
          .from(rateCardsTable)
          .where(
            and(
              eq(rateCardsTable.orgId, orgId),
              eq(rateCardsTable.sourceSystem, SOURCE),
              inArray(rateCardsTable.sourceExternalId, rcExtIds),
            ),
          );
        for (const r of rcRows) if (r.ext) rcLookup.set(r.ext, r.id);
      }
      const v = rows
        .filter(
          (r) => r["role"] && rcLookup.has(r["rateCardExternalId"] ?? ""),
        )
        .map((r) => ({
          id: newId("rcl"),
          orgId,
          rateCardId: rcLookup.get(r["rateCardExternalId"]!)!,
          role: r["role"]!,
          seniority: r["seniority"] ?? null,
          hourlyRate: r["hourlyRate"]
            ? Number(r["hourlyRate"]).toFixed(4)
            : null,
          dailyRate: r["dailyRate"]
            ? Number(r["dailyRate"]).toFixed(4)
            : null,
          roleCode: r["roleCode"] ?? null,
        }));
      if (v.length === 0) return 0;
      // Upsert on (rate_card_id, role, seniority). Drizzle's
      // `onConflictDoUpdate` `target` accepts the composite index columns.
      const out = await db
        .insert(rateCardLinesTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            rateCardLinesTable.rateCardId,
            rateCardLinesTable.role,
            rateCardLinesTable.seniority,
          ],
          set: {
            hourlyRate: sql`excluded.hourly_rate`,
            dailyRate: sql`excluded.daily_rate`,
            roleCode: sql`excluded.role_code`,
          },
        })
        .returning({ id: rateCardLinesTable.id });
      return out.length;
    }
    case "time_entries": {
      // Resolve supplier (required) + optional contract / SOW / rate-card.
      const supExtIds = Array.from(
        new Set(
          rows.map((r) => r["supplierExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const ctExtIds = Array.from(
        new Set(
          rows
            .map((r) => r["contractExternalId"]!)
            .filter(Boolean) as string[],
        ),
      );
      const sowExtIds = Array.from(
        new Set(
          rows.map((r) => r["sowExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const rcExtIds = Array.from(
        new Set(
          rows
            .map((r) => r["rateCardExternalId"]!)
            .filter(Boolean) as string[],
        ),
      );
      const supLookup = new Map<string, string>();
      const ctLookup = new Map<string, string>();
      const sowLookup = new Map<string, string>();
      const rcLookup = new Map<string, string>();
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
      if (ctExtIds.length > 0) {
        const ctRows = await db
          .select({
            id: contractsTable.id,
            ext: contractsTable.sourceExternalId,
          })
          .from(contractsTable)
          .where(
            and(
              eq(contractsTable.orgId, orgId),
              eq(contractsTable.sourceSystem, SOURCE),
              inArray(contractsTable.sourceExternalId, ctExtIds),
            ),
          );
        for (const r of ctRows) if (r.ext) ctLookup.set(r.ext, r.id);
      }
      if (sowExtIds.length > 0) {
        const sowRows = await db
          .select({
            id: statementsOfWorkTable.id,
            ext: statementsOfWorkTable.sourceExternalId,
          })
          .from(statementsOfWorkTable)
          .where(
            and(
              eq(statementsOfWorkTable.orgId, orgId),
              eq(statementsOfWorkTable.sourceSystem, SOURCE),
              inArray(statementsOfWorkTable.sourceExternalId, sowExtIds),
            ),
          );
        for (const r of sowRows) if (r.ext) sowLookup.set(r.ext, r.id);
      }
      if (rcExtIds.length > 0) {
        const rcRows = await db
          .select({
            id: rateCardsTable.id,
            ext: rateCardsTable.sourceExternalId,
          })
          .from(rateCardsTable)
          .where(
            and(
              eq(rateCardsTable.orgId, orgId),
              eq(rateCardsTable.sourceSystem, SOURCE),
              inArray(rateCardsTable.sourceExternalId, rcExtIds),
            ),
          );
        for (const r of rcRows) if (r.ext) rcLookup.set(r.ext, r.id);
      }
      const v = rows
        .filter(
          (r) =>
            r["externalId"] && supLookup.has(r["supplierExternalId"] ?? ""),
        )
        .map((r) => ({
          id: newId("te"),
          orgId,
          supplierId: supLookup.get(r["supplierExternalId"]!)!,
          contractId: r["contractExternalId"]
            ? ctLookup.get(r["contractExternalId"]) ?? null
            : null,
          sowId: r["sowExternalId"]
            ? sowLookup.get(r["sowExternalId"]) ?? null
            : null,
          rateCardId: r["rateCardExternalId"]
            ? rcLookup.get(r["rateCardExternalId"]) ?? null
            : null,
          rateCardLineId: null,
          resource: r["resource"] ?? "unknown",
          role: r["role"] ?? null,
          seniority: r["seniority"] ?? null,
          workDate: new Date(r["workDate"]!),
          hours: Number(r["hours"] ?? "0").toFixed(2),
          billRateUsd: r["billRateUsd"]
            ? Number(r["billRateUsd"]).toFixed(4)
            : null,
          amountUsd: r["amountUsd"]
            ? Number(r["amountUsd"]).toFixed(2)
            : null,
          description: r["description"] ?? null,
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(timeEntriesTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            timeEntriesTable.orgId,
            timeEntriesTable.sourceSystem,
            timeEntriesTable.sourceExternalId,
          ],
          set: {
            hours: sql`excluded.hours`,
            billRateUsd: sql`excluded.bill_rate_usd`,
            amountUsd: sql`excluded.amount_usd`,
            workDate: sql`excluded.work_date`,
            description: sql`excluded.description`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: timeEntriesTable.id });
      return out.length;
    }
    default: {
      // Task #93: an unknown entity name should not fail the whole job.
      // The route's STREAM_CSV_ENTITIES allowlist normally catches this
      // upstream, so reaching this branch implies either a bypass of
      // that check or a `CsvEntity` member added to the type without a
      // matching `case`. Either way, dropping the batch and logging is
      // strictly safer than throwing a `StructuralIngestError` that
      // permanently fails the job: the operator's other entity uploads
      // (or batches) still land. The `_exhaustive: never` assignment
      // is kept so adding a new `CsvEntity` member without handling it
      // here remains a compile-time error in strict builds — runtime
      // behaviour is the defensive skip described above.
      const _exhaustive: never = entity;
      logger.warn(
        {
          event: "csv_flush_batch_unknown_entity",
          orgId,
          entity: String(_exhaustive),
          rowsSkipped: rows.length,
        },
        "flushBatch: unknown entity — skipping batch",
      );
      return 0;
    }
  }
}
