/**
 * Pins the streaming-progress contract for every non-`suppliers` CSV entity
 * accepted by `POST /api/ingest/csv-stream`:
 *   - `invoices`, `po_lines`        — grouped FK lookups before the upsert
 *   - `purchase_orders`, `payments` — single grouped FK lookup per batch
 *   - `shipments`                   — dual optional FK lookups per batch
 *   - `categories`, `items`         — no FK lookup (fast batch path)
 *   - `statements_of_work`          — dual required FK lookups per batch
 *                                     (contract + supplier)
 *   - `rate_cards`                  — required supplier + dual optional
 *                                     (contract / SOW) FK lookups per batch
 *   - `rate_card_lines`             — single required rate-card FK lookup
 *                                     per batch (no `source_external_id`)
 *   - `time_entries`                — required supplier + triple optional
 *                                     (contract / SOW / rate-card) FK
 *                                     lookups per batch
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

import {
  db,
  pool,
  purchaseOrdersTable,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import app from "../src/app";
import {
  FIXTURE_SOURCE,
  deleteFixtureRowsByPrefix,
  loadSupplierIdMapByPrefix,
  openAsBlob,
  pickOrgId,
  seedCategories,
  seedContracts,
  seedInvoices,
  seedPurchaseOrders,
  seedRateCards,
  seedStatementsOfWork,
  seedSuppliers,
  startServer,
  writeCategoriesCsvSync,
  writeInvoicesCsvSync,
  writeItemsCsvSync,
  writePaymentsCsvSync,
  writePoLinesCsvSync,
  writePurchaseOrdersCsvSync,
  writeRateCardLinesCsvSync,
  writeRateCardsCsvSync,
  writeShipmentsCsvSync,
  writeStatementsOfWorkCsvSync,
  writeTimeEntriesCsvSync,
} from "./helpers/csv-stream-fixtures";

const TEST_RUN_ID = `csvstreamprogressentities-${Date.now()}-${process.pid}`;
const EXTERNAL_ID_PREFIX = `${TEST_RUN_ID}-`;

const PARENT_SUPPLIERS = 50;
const PARENT_POS = 50;
const PARENT_CATEGORIES = 5;
const PARENT_INVOICES = 50;
// Services-taxonomy parent counts. Sized identically to the rest so each
// batch's grouped FK lookup map has multiple hits — see the comment on
// PARENT_INVOICES above.
const PARENT_CONTRACTS = 50;
const PARENT_SOWS = 50;
const PARENT_RATE_CARDS = 50;

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
  | "shipments"
  | "statements_of_work"
  | "rate_cards"
  | "rate_card_lines"
  | "time_entries";

/**
 * Soft per-entity upper bound on the `first-progress → result` gap for a
 * 10k-row upload. This is the wall-clock time between the first batch
 * flush (after BATCH_SIZE=1000 rows) and the terminal `result` event, i.e.
 * roughly the cost of the remaining ~9 batch flushes. It's a proxy for
 * server-side per-batch throughput on each entity's `flushBatch` branch.
 *
 * Why per-entity: the branches have very different shapes —
 *   - `categories`, `items`           : no FK lookup, single upsert/batch
 *   - `suppliers`, `purchase_orders`,
 *     `payments`                      : 0–1 grouped FK lookup per batch
 *   - `shipments`                     : dual optional FK lookups per batch
 *   - `invoices`, `po_lines`          : grouped FK lookups before upsert
 *
 * Why these numbers: observed gaps on local + CI hardware sit in the
 * 700–1900 ms range (see test logs and the p95 table documented in
 * `routes/ingest.ts`). Ceilings are sized at roughly 3–5× the observed
 * p95 so transient CI noise (cold DB, contended runner, GC pause) does
 * not flake, while a 5–10× throughput regression — the kind of slowdown
 * that turns a 30-second upload into a 5-minute one — does fail loudly
 * here instead of in a customer's browser.
 *
 * Treat these as a regression alarm, not a SLO. If a legitimate change
 * (schema, FK index, batch size) shifts the observed gap, update both
 * this map and the p95 table in `routes/ingest.ts` together.
 */
const MAX_PROGRESS_TO_RESULT_GAP_MS_PER_ENTITY: Record<StreamEntity, number> = {
  categories: 4_000,
  items: 4_000,
  purchase_orders: 5_000,
  payments: 5_000,
  shipments: 6_000,
  invoices: 8_000,
  po_lines: 8_000,
  // Services-taxonomy entities. `rate_card_lines` has no FK lookup besides
  // the required parent rate_card → comparable to single-FK paths above.
  // The other three batch-load 2–4 grouped FK lookups; size their ceilings
  // alongside the comparably-shaped invoice/po_lines branch.
  rate_card_lines: 5_000,
  statements_of_work: 6_000,
  rate_cards: 6_000,
  time_entries: 8_000,
};

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

  // Soft upper bound — catches a 5–10× throughput regression on this
  // entity's `flushBatch` branch before customers do. See the comment on
  // MAX_PROGRESS_TO_RESULT_GAP_MS_PER_ENTITY for sizing rationale.
  const maxGapMs = MAX_PROGRESS_TO_RESULT_GAP_MS_PER_ENTITY[entity];
  assert.ok(
    progressToResultGapMs <= maxGapMs,
    `[${entity}] first-progress→result gap of ${progressToResultGapMs} ms ` +
      `exceeded the soft ceiling of ${maxGapMs} ms for a ${rowCount}-row ` +
      `upload (~9 post-first-batch flushes). This usually means the ` +
      `flushBatch branch for '${entity}' regressed: e.g. a missing index on ` +
      `the FK lookup, a per-row round-trip introduced inside the batch, or ` +
      `BATCH_SIZE shrunk. Compare against the p95 table in ` +
      `artifacts/api-server/src/routes/ingest.ts and update both numbers ` +
      `together if this is a legitimate baseline shift.`,
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

  // Lightweight throughput metric the team can grep CI logs for over time
  // to spot trend drift well before it crosses the hard ceiling above.
  // Estimates rows/sec on the post-first-batch portion (~rowCount-BATCH_SIZE
  // rows over progressToResultGapMs).
  const POST_FIRST_BATCH_ROWS = Math.max(rowCount - 1000, 1);
  const rowsPerSec = Math.round(
    (POST_FIRST_BATCH_ROWS * 1000) / Math.max(progressToResultGapMs, 1),
  );
  console.log(
    `[${entity}] received ${progressEvents.length} progress event(s); ` +
      `final parsed=${prevParsed}, inserted=${prevInserted}; ` +
      `first-progress→result gap=${progressToResultGapMs} ms ` +
      `(ceiling ${maxGapMs} ms, ~${rowsPerSec} rows/sec post-first-batch)`,
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
    {
      entity: "statements_of_work",
      prepare: async () => {
        const { supplierExternalIds, supplierIds } =
          await ensureSeededSuppliers();
        const { externalIds: contractExternalIds } = await seedContracts(
          orgId,
          PARENT_CONTRACTS,
          supplierIds,
          EXTERNAL_ID_PREFIX,
        );
        return {
          writeArgs: { contractExternalIds, supplierExternalIds },
        };
      },
      writeCsv: (filePath, args) => {
        const { contractExternalIds, supplierExternalIds } = args as {
          contractExternalIds: string[];
          supplierExternalIds: string[];
        };
        return writeStatementsOfWorkCsvSync(filePath, {
          contractExternalIds,
          supplierExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: ROW_COUNT,
        });
      },
    },
    {
      entity: "rate_cards",
      prepare: async () => {
        const { supplierExternalIds, supplierIds } =
          await ensureSeededSuppliers();
        const { externalIds: contractExternalIds, internalIds: contractIds } =
          await seedContracts(
            orgId,
            PARENT_CONTRACTS,
            supplierIds,
            // Sub-prefix so we don't collide with the contracts that the
            // statements_of_work variant may have already seeded.
            `${EXTERNAL_ID_PREFIX}rc-`,
          );
        const { externalIds: sowExternalIds } = await seedStatementsOfWork(
          orgId,
          PARENT_SOWS,
          contractIds,
          supplierIds,
          `${EXTERNAL_ID_PREFIX}rc-`,
        );
        return {
          writeArgs: {
            supplierExternalIds,
            contractExternalIds,
            sowExternalIds,
          },
        };
      },
      writeCsv: (filePath, args) => {
        const { supplierExternalIds, contractExternalIds, sowExternalIds } =
          args as {
            supplierExternalIds: string[];
            contractExternalIds: string[];
            sowExternalIds: string[];
          };
        return writeRateCardsCsvSync(filePath, {
          supplierExternalIds,
          contractExternalIds,
          sowExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: ROW_COUNT,
        });
      },
    },
    {
      entity: "rate_card_lines",
      prepare: async () => {
        // Rate-card lines only need parent rate-cards. Seed under a
        // sub-prefix so we don't collide with any rate-cards the
        // `rate_cards` upload variant just inserted under the parent
        // prefix.
        const { supplierIds } = await ensureSeededSuppliers();
        const { externalIds: rateCardExternalIds } = await seedRateCards(
          orgId,
          PARENT_RATE_CARDS,
          supplierIds,
          `${EXTERNAL_ID_PREFIX}rcl-`,
        );
        return { writeArgs: { rateCardExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { rateCardExternalIds } = args as {
          rateCardExternalIds: string[];
        };
        return writeRateCardLinesCsvSync(filePath, {
          rateCardExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: ROW_COUNT,
        });
      },
    },
    {
      entity: "time_entries",
      prepare: async () => {
        // Exercise all four FK lookups in one batch
        // (`supplier` required, plus optional `contract` / `sow` /
        // `rate_card`).
        const { supplierExternalIds, supplierIds } =
          await ensureSeededSuppliers();
        const { externalIds: contractExternalIds, internalIds: contractIds } =
          await seedContracts(
            orgId,
            PARENT_CONTRACTS,
            supplierIds,
            `${EXTERNAL_ID_PREFIX}te-`,
          );
        const { externalIds: sowExternalIds, internalIds: sowIds } =
          await seedStatementsOfWork(
            orgId,
            PARENT_SOWS,
            contractIds,
            supplierIds,
            `${EXTERNAL_ID_PREFIX}te-`,
          );
        const { externalIds: rateCardExternalIds } = await seedRateCards(
          orgId,
          PARENT_RATE_CARDS,
          supplierIds,
          `${EXTERNAL_ID_PREFIX}te-`,
          { contractIds, sowIds },
        );
        return {
          writeArgs: {
            supplierExternalIds,
            contractExternalIds,
            sowExternalIds,
            rateCardExternalIds,
          },
        };
      },
      writeCsv: (filePath, args) => {
        const {
          supplierExternalIds,
          contractExternalIds,
          sowExternalIds,
          rateCardExternalIds,
        } = args as {
          supplierExternalIds: string[];
          contractExternalIds: string[];
          sowExternalIds: string[];
          rateCardExternalIds: string[];
        };
        return writeTimeEntriesCsvSync(filePath, {
          supplierExternalIds,
          contractExternalIds,
          sowExternalIds,
          rateCardExternalIds,
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
