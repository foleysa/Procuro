/**
 * Pins the streaming-progress contract for every non-`suppliers` CSV entity
 * accepted by `POST /api/ingest/csv-stream`:
 *   - `invoices`, `po_lines`        — grouped FK lookups before the upsert
 *   - `purchase_orders`, `payments` — single grouped FK lookup per batch
 *   - `shipments`                   — dual optional FK lookups per batch
 *   - `categories`, `items`         — no FK lookup (fast batch path)
 *
 * Mirrors the shape of `csv-stream-progress.test.ts` (which covers
 * `suppliers`) so a regression that silently drops `onProgress` on any one
 * entity branch — fast OR slow — is caught instead of leaving the upload
 * UI's progress bar dark for that entity until a customer notices.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { pool } from "@workspace/db";
import app from "../src/app";
import {
  deleteFixtureRowsByPrefix,
  loadSupplierIdMapByPrefix,
  openAsBlob,
  pickOrgId,
  seedCategories,
  seedInvoices,
  seedPurchaseOrders,
  seedSuppliers,
  startServer,
  writeCategoriesCsvSync,
  writeInvoicesCsvSync,
  writeItemsCsvSync,
  writePaymentsCsvSync,
  writePoLinesCsvSync,
  writePurchaseOrdersCsvSync,
  writeShipmentsCsvSync,
} from "./helpers/csv-stream-fixtures";

const TEST_RUN_ID = `csvstreamprogressentities-${Date.now()}-${process.pid}`;
const EXTERNAL_ID_PREFIX = `${TEST_RUN_ID}-`;

const PARENT_SUPPLIERS = 50;
const PARENT_POS = 50;
const PARENT_CATEGORIES = 5;
const PARENT_INVOICES = 50;

// 10k rows == 10 BATCH_SIZE flushes; with FK lookups on each batch this
// comfortably exceeds the route's 250 ms PROGRESS_EMIT_INTERVAL_MS throttle
// while staying well under the 10 MB workload of csv-stream-large-entities.
// Even for the fastest variants (no FK lookup) the 10 per-batch round-trips
// still take well above the MIN_PROGRESS_TO_RESULT_GAP_MS gap below.
const ROW_COUNT = 10_000;
const MIN_PROGRESS_TO_RESULT_GAP_MS = 50;

type StreamEntity =
  | "invoices"
  | "po_lines"
  | "categories"
  | "items"
  | "purchase_orders"
  | "payments"
  | "shipments";

type ProgressEvent = {
  type: "progress";
  rowsParsed: number;
  rowsInserted: number;
};
type ResultEvent = {
  type: "result";
  entity: string;
  rowsParsed: number;
  rowsInserted: number;
  durationMs: number;
};
type ErrorEvent = { type: "error"; error: string };
type StreamEvent = ProgressEvent | ResultEvent | ErrorEvent;

/**
 * POST `csvFile` to the streaming endpoint and read the NDJSON response
 * incrementally so the arrival times of individual lines (not just the final
 * body) are observable — required to catch a regression that buffers all
 * lines into a single final flush.
 */
async function uploadAndCollectProgressStream(args: {
  baseUrl: string;
  orgId: string;
  entity: StreamEntity;
  csvFile: string;
  formFilename: string;
}): Promise<{
  events: StreamEvent[];
  firstProgressLineMs: number | null;
  firstResultLineMs: number | null;
}> {
  const fileBlob = await openAsBlob(args.csvFile, "text/csv");
  const form = new FormData();
  form.append("file", fileBlob, args.formFilename);

  const url = `${args.baseUrl}/api/ingest/csv-stream?entity=${args.entity}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-org-id": args.orgId },
    body: form,
  });

  assert.equal(
    res.status,
    200,
    `[${args.entity}] unexpected status ${res.status}`,
  );
  assert.ok(
    res.body,
    `[${args.entity}] response did not include a streamable body`,
  );

  const events: StreamEvent[] = [];
  let firstProgressLineMs: number | null = null;
  let firstResultLineMs: number | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let lineCounter = 0;

  const consumeLine = (line: string, lineNo: number): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch (err) {
      throw new Error(
        `[${args.entity}] Failed to parse NDJSON line #${lineNo}: ${(err as Error).message}\n` +
          `Line content: ${trimmed}`,
      );
    }
    const arrivedAt = Date.now();
    if (event.type === "progress" && firstProgressLineMs === null) {
      firstProgressLineMs = arrivedAt;
    }
    if (event.type === "result" && firstResultLineMs === null) {
      firstResultLineMs = arrivedAt;
    }
    events.push(event);
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        lineCounter++;
        consumeLine(line, lineCounter);
      }
    }
    if (done) break;
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    lineCounter++;
    consumeLine(pending, lineCounter);
  }

  return { events, firstProgressLineMs, firstResultLineMs };
}

function assertProgressContract(args: {
  entity: StreamEntity;
  rowCount: number;
  events: StreamEvent[];
  firstProgressLineMs: number | null;
  firstResultLineMs: number | null;
}): void {
  const { entity, rowCount, events, firstProgressLineMs, firstResultLineMs } =
    args;

  const errorEvent = events.find((e): e is ErrorEvent => e.type === "error");
  assert.ok(
    !errorEvent,
    `[${entity}] streaming endpoint emitted error event: ${errorEvent?.error ?? ""}`,
  );

  const progressEvents = events.filter(
    (e): e is ProgressEvent => e.type === "progress",
  );

  assert.ok(
    progressEvents.length >= 1,
    `[${entity}] expected at least one { type: "progress" } event from ` +
      `/api/ingest/csv-stream for a ${rowCount}-row upload, but got 0. ` +
      `Total events received: ${events.length} ` +
      `(${events.map((e) => e.type).join(", ")}). ` +
      `This usually means progress emission is broken on the ${entity} ` +
      `batch path (e.g. onProgress dropped from the slow-batch FK lookup ` +
      `branch, throttle gate inverted, or response buffered until end).`,
  );

  const resultIdx = events.findIndex((e) => e.type === "result");
  assert.ok(
    resultIdx >= 0,
    `[${entity}] streaming endpoint did not emit a 'result' event. ` +
      `Got ${events.length} events: ${events.map((e) => e.type).join(", ")}`,
  );
  for (let i = resultIdx + 1; i < events.length; i++) {
    assert.notEqual(
      events[i]?.type,
      "progress",
      `[${entity}] progress event must not appear after the terminal ` +
        `'result' event (found at index ${i})`,
    );
  }

  assert.ok(
    firstProgressLineMs !== null,
    `[${entity}] did not observe a progress line on the response stream`,
  );
  assert.ok(
    firstResultLineMs !== null,
    `[${entity}] did not observe a result line on the response stream`,
  );
  const progressToResultGapMs =
    (firstResultLineMs as number) - (firstProgressLineMs as number);
  assert.ok(
    progressToResultGapMs >= MIN_PROGRESS_TO_RESULT_GAP_MS,
    `[${entity}] expected the first progress event to arrive at least ` +
      `${MIN_PROGRESS_TO_RESULT_GAP_MS} ms before the result event ` +
      `(proves the response is actually streaming, not buffered until end), ` +
      `but the gap was only ${progressToResultGapMs} ms.`,
  );

  let prevParsed = 0;
  let prevInserted = 0;
  for (const [i, ev] of progressEvents.entries()) {
    assert.ok(
      ev.rowsParsed >= prevParsed,
      `[${entity}] progress event #${i} rowsParsed went backward: ${prevParsed} -> ${ev.rowsParsed}`,
    );
    assert.ok(
      ev.rowsInserted >= prevInserted,
      `[${entity}] progress event #${i} rowsInserted went backward: ${prevInserted} -> ${ev.rowsInserted}`,
    );
    assert.ok(
      ev.rowsParsed <= rowCount,
      `[${entity}] progress event #${i} rowsParsed=${ev.rowsParsed} exceeds file row count ${rowCount}`,
    );
    prevParsed = ev.rowsParsed;
    prevInserted = ev.rowsInserted;
  }

  const result = events[resultIdx] as ResultEvent;
  assert.equal(
    result.rowsParsed,
    rowCount,
    `[${entity}] terminal result.rowsParsed=${result.rowsParsed} but ${rowCount} rows were written to the CSV`,
  );
  assert.equal(
    result.rowsInserted,
    rowCount,
    `[${entity}] terminal result.rowsInserted=${result.rowsInserted} but ${rowCount} rows were written to the CSV`,
  );

  console.log(
    `[${entity}] received ${progressEvents.length} progress event(s); ` +
      `final parsed=${prevParsed}, inserted=${prevInserted}; ` +
      `first-progress→result gap=${progressToResultGapMs} ms`,
  );
}

test("streaming CSV ingest emits progress events for every non-suppliers entity", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const tmpFiles: string[] = [];
  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  t.after(async () => {
    try {
      await deleteFixtureRowsByPrefix(EXTERNAL_ID_PREFIX);
    } catch (err) {
      console.error("[cleanup] failed to delete test rows:", err);
    }
    if (server) await server.close();
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    await pool.end().catch(() => {});
  });

  server = await startServer(app);
  const orgId = await pickOrgId();

  // Defensive cleanup of any stragglers from a prior aborted run with the
  // same prefix (timestamped + pid-suffixed so this is normally a no-op).
  await deleteFixtureRowsByPrefix(EXTERNAL_ID_PREFIX);

  type Variant = {
    entity: StreamEntity;
    prepare: () => Promise<{ writeArgs: unknown }>;
    writeCsv: (filePath: string, args: unknown) => number;
  };

  // Lazy supplier seeding — multiple variants need supplier parents and
  // there's no reason to pay the seed cost more than once per test run.
  const ensureSeededSuppliers = async (): Promise<{
    supplierExternalIds: string[];
    supplierIds: string[];
  }> => {
    let supplierIdMap = await loadSupplierIdMapByPrefix(
      orgId,
      EXTERNAL_ID_PREFIX,
    );
    if (supplierIdMap.size === 0) {
      await seedSuppliers(orgId, PARENT_SUPPLIERS, EXTERNAL_ID_PREFIX);
      supplierIdMap = await loadSupplierIdMapByPrefix(
        orgId,
        EXTERNAL_ID_PREFIX,
      );
    }
    const supplierIds = Array.from(supplierIdMap.values());
    const supplierExternalIds = Array.from(supplierIdMap.keys());
    assert.ok(
      supplierIds.length > 0,
      "expected at least one seeded supplier",
    );
    return { supplierExternalIds, supplierIds };
  };

  const variants: Variant[] = [
    {
      entity: "invoices",
      prepare: async () => {
        const { supplierExternalIds } = await ensureSeededSuppliers();
        return { writeArgs: { supplierExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { supplierExternalIds } = args as {
          supplierExternalIds: string[];
        };
        return writeInvoicesCsvSync(filePath, {
          supplierExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: ROW_COUNT,
        });
      },
    },
    {
      entity: "po_lines",
      prepare: async () => {
        const { supplierIds } = await ensureSeededSuppliers();
        const poExternalIds = await seedPurchaseOrders(
          orgId,
          PARENT_POS,
          supplierIds,
          EXTERNAL_ID_PREFIX,
        );
        const categoryCodes = await seedCategories(
          orgId,
          PARENT_CATEGORIES,
          EXTERNAL_ID_PREFIX,
        );
        return { writeArgs: { poExternalIds, categoryCodes } };
      },
      writeCsv: (filePath, args) => {
        const { poExternalIds, categoryCodes } = args as {
          poExternalIds: string[];
          categoryCodes: string[];
        };
        return writePoLinesCsvSync(filePath, {
          poExternalIds,
          categoryCodes,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: ROW_COUNT,
        });
      },
    },
    {
      entity: "categories",
      // No FK lookup; flushBatch upserts on (orgId, code).
      prepare: async () => ({ writeArgs: {} }),
      writeCsv: (filePath) =>
        writeCategoriesCsvSync(filePath, {
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: ROW_COUNT,
        }),
    },
    {
      entity: "items",
      // No FK lookup; flushBatch upserts on (orgId, source_system,
      // source_external_id) with a (orgId, sku) unique side-constraint.
      prepare: async () => ({ writeArgs: {} }),
      writeCsv: (filePath) =>
        writeItemsCsvSync(filePath, {
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: ROW_COUNT,
        }),
    },
    {
      entity: "purchase_orders",
      prepare: async () => {
        const { supplierExternalIds } = await ensureSeededSuppliers();
        return { writeArgs: { supplierExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { supplierExternalIds } = args as {
          supplierExternalIds: string[];
        };
        return writePurchaseOrdersCsvSync(filePath, {
          supplierExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: ROW_COUNT,
        });
      },
    },
    {
      entity: "payments",
      prepare: async () => {
        const { supplierIds } = await ensureSeededSuppliers();
        const invoiceExternalIds = await seedInvoices(
          orgId,
          PARENT_INVOICES,
          supplierIds,
          EXTERNAL_ID_PREFIX,
        );
        return { writeArgs: { invoiceExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { invoiceExternalIds } = args as {
          invoiceExternalIds: string[];
        };
        return writePaymentsCsvSync(filePath, {
          invoiceExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: ROW_COUNT,
        });
      },
    },
    {
      entity: "shipments",
      prepare: async () => {
        const { supplierExternalIds, supplierIds } =
          await ensureSeededSuppliers();
        // Seed POs under a shipments-scoped sub-prefix so we don't collide
        // with any POs the po_lines variant may have already seeded under
        // the parent prefix. Both still get cleaned up by the parent prefix
        // sweep in `deleteFixtureRowsByPrefix`.
        const poExternalIds = await seedPurchaseOrders(
          orgId,
          PARENT_POS,
          supplierIds,
          `${EXTERNAL_ID_PREFIX}shp-`,
        );
        return { writeArgs: { poExternalIds, supplierExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { poExternalIds, supplierExternalIds } = args as {
          poExternalIds: string[];
          supplierExternalIds: string[];
        };
        return writeShipmentsCsvSync(filePath, {
          poExternalIds,
          supplierExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: ROW_COUNT,
        });
      },
    },
  ];

  for (const variant of variants) {
    await t.test(`entity: ${variant.entity}`, async () => {
      const tmpFile = path.join(
        os.tmpdir(),
        `csv-stream-progress-${variant.entity}-${process.pid}-${Date.now()}.csv`,
      );
      tmpFiles.push(tmpFile);

      const { writeArgs } = await variant.prepare();
      const writtenRows = variant.writeCsv(tmpFile, writeArgs);
      assert.equal(
        writtenRows,
        ROW_COUNT,
        `[${variant.entity}] expected to write ${ROW_COUNT} rows, wrote ${writtenRows}`,
      );

      const stat = fs.statSync(tmpFile);
      console.log(
        `[${variant.entity}] generated CSV: ${(stat.size / 1024 / 1024).toFixed(2)} MB, ${writtenRows} rows`,
      );

      const { events, firstProgressLineMs, firstResultLineMs } =
        await uploadAndCollectProgressStream({
          baseUrl: server!.baseUrl,
          orgId,
          entity: variant.entity,
          csvFile: tmpFile,
          formFilename: `${variant.entity}.csv`,
        });

      assertProgressContract({
        entity: variant.entity,
        rowCount: writtenRows,
        events,
        firstProgressLineMs,
        firstResultLineMs,
      });
    });
  }
});
