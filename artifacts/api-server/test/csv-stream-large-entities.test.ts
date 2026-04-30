/**
 * Integration test for `POST /api/ingest/csv-stream` covering the higher-risk
 * non-`suppliers` entities — `invoices`, `po_lines`, `purchase_orders`,
 * `payments`, and `shipments` — with a >10 MB CSV each.
 *
 * Why this exists
 * ---------------
 * `csv-stream-large.test.ts` only exercises `suppliers`, which has the
 * simplest per-batch logic (no foreign-key lookups). The streaming endpoint
 * also accepts seven other entities. The highest-volume entity in real
 * customer data — `po_lines` — has the most complex per-batch logic: it
 * runs grouped lookups against `purchase_orders` AND `categories` for every
 * batch before the upsert. `invoices`, `purchase_orders`, `payments`, and
 * `shipments` each run one or two grouped foreign-key lookups per batch
 * before their upsert. A regression in any of those lookup paths would
 * silently drop customer data and the suppliers-only test would not catch
 * it.
 *
 * What this verifies (per entity)
 * -------------------------------
 * 1. Generates a >10 MB single-entity CSV directly to disk (never buffered
 *    as a single string in JS).
 * 2. Boots the real Express app in-process and binds to an ephemeral port,
 *    then POSTs the file as `multipart/form-data` so the server hits the
 *    same code path the browser/cURL clients use.
 * 3. Confirms the streaming endpoint reports `rowsParsed === rowsInserted`
 *    and that count matches the number of rows in the generated file.
 * 4. Confirms the rows actually landed in the real Postgres database
 *    (DATABASE_URL — no mocks) by counting rows filtered to a unique
 *    `source_external_id` prefix that this test owns.
 * 5. Cleans up every row inserted by this run (parents and children) in
 *    foreign-key-safe order.
 *
 * What this test deliberately does NOT cover
 * ------------------------------------------
 * - Memory-regression assertion (already covered by `csv-stream-large.test.ts`
 *   for the streaming code path itself; entity-specific batch handlers do
 *   not change that property).
 *
 * Prereqs
 * -------
 * - `DATABASE_URL` is set and the schema has been pushed (see `lib/db`).
 * - At least one row exists in `orgs` (the test will use the first one).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Opt into the dev-only `x-org-id` header path before importing the app
// (the auth middleware reads NODE_ENV at module import time).
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import {
  db,
  invoicesTable,
  paymentsTable,
  poLinesTable,
  purchaseOrdersTable,
  shipmentsTable,
  pool,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import app from "../src/app";
import { parseTerminalNdjsonEvent } from "./helpers/ndjson";
import {
  FIXTURE_SOURCE,
  deleteFixtureRowsByPrefix,
  loadSupplierIdMapByPrefix,
  openAsBlob,
  pickOrgId,
  seedCategories,
  seedInvoices,
  seedPurchaseOrders,
  seedSuppliers,
  startServer,
  writeInvoicesCsvSync,
  writePaymentsCsvSync,
  writePoLinesCsvSync,
  writePurchaseOrdersCsvSync,
  writeShipmentsCsvSync,
} from "./helpers/csv-stream-fixtures";

const TEST_RUN_ID = `csvstreamentities-${Date.now()}-${process.pid}`;
const EXTERNAL_ID_PREFIX = `${TEST_RUN_ID}-`;
const TARGET_BYTES = 10 * 1024 * 1024; // 10 MB minimum

// Number of parent rows pre-seeded for child-CSV lookups. Small enough that
// the per-batch `IN (...)` lookup fits in a single grouped query, large
// enough that the lookup map is exercised (i.e. not a single hit).
const PARENT_SUPPLIERS = 50;
const PARENT_POS = 50;
const PARENT_CATEGORIES = 5;
// Dedicated parent invoices for the `payments` variant. Kept small (matches
// the supplier/PO parent counts) so each batch's grouped FK lookup against
// `invoices` is exercised — i.e. the lookup map has multiple hits per batch
// rather than a single hit which would fail to catch a misplaced filter.
const PARENT_INVOICES = 50;

/** Upload a CSV via the multipart streaming endpoint. */
async function uploadCsv(args: {
  baseUrl: string;
  orgId: string;
  entity: string;
  filePath: string;
  formFilename: string;
}): Promise<{ status: number; rawBody: string }> {
  const fileBlob = await openAsBlob(args.filePath, "text/csv");
  const form = new FormData();
  form.append("file", fileBlob, args.formFilename);
  const url = `${args.baseUrl}/api/ingest/csv-stream?entity=${args.entity}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-org-id": args.orgId },
    body: form,
  });
  const rawBody = await res.text();
  return { status: res.status, rawBody };
}

test("streaming CSV ingest of >10 MB files lands every row for invoices and po_lines", async (t) => {
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
    // Drain pg pool so node:test exits cleanly. Idempotent-safe: pg's
    // Pool.end() rejects if called twice, so swallow.
    await pool.end().catch(() => {});
  });

  // Shared setup once.
  server = await startServer(app);
  const orgId = await pickOrgId();

  // Defensive cleanup of any leftover rows from a prior aborted run with the
  // same prefix (the prefix is timestamped + pid-suffixed so this is
  // normally a no-op).
  await deleteFixtureRowsByPrefix(EXTERNAL_ID_PREFIX);

  /**
   * One row per CSV-streaming entity covered by this test. Each variant:
   * - prepares the parent rows the per-batch lookups depend on (`prepare`),
   * - writes a >10 MB single-entity CSV (`writeCsv`), and
   * - identifies the table + child external-id prefix used to verify and
   *   count the inserted rows (`childTable`, `childExtIdPrefix`).
   *
   * Adding a new entity (e.g. `payments`, `shipments`) is a single new
   * entry in this table — no copy/paste of the upload + assertion plumbing.
   */
  type Variant = {
    entity:
      | "invoices"
      | "po_lines"
      | "purchase_orders"
      | "payments"
      | "shipments";
    /** Set up parent records and return whatever the writer needs. */
    prepare: () => Promise<{ writeArgs: unknown }>;
    /** Generate the >10 MB CSV row-by-row to disk; return row count. */
    writeCsv: (filePath: string, args: unknown) => number;
    /** Drizzle table the inserted rows land in. */
    childTable:
      | typeof invoicesTable
      | typeof poLinesTable
      | typeof purchaseOrdersTable
      | typeof paymentsTable
      | typeof shipmentsTable;
    /** External-id prefix used by `writeCsv`; scopes the row-count query. */
    childExtIdPrefix: string;
  };

  const variants: Variant[] = [
    {
      entity: "invoices",
      childTable: invoicesTable,
      childExtIdPrefix: `${EXTERNAL_ID_PREFIX}inv-`,
      prepare: async () => {
        const supplierExternalIds = await seedSuppliers(
          orgId,
          PARENT_SUPPLIERS,
          EXTERNAL_ID_PREFIX,
        );
        return { writeArgs: { supplierExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { supplierExternalIds } = args as {
          supplierExternalIds: string[];
        };
        return writeInvoicesCsvSync(filePath, {
          supplierExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          minBytes: TARGET_BYTES,
        });
      },
    },
    {
      entity: "po_lines",
      childTable: poLinesTable,
      childExtIdPrefix: `${EXTERNAL_ID_PREFIX}pol-`,
      prepare: async () => {
        // Reuse supplier seeds from earlier variants if present; otherwise
        // create them now. Either way we need the internal supplier ids to
        // build POs.
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
        assert.ok(
          supplierIds.length > 0,
          "expected at least one seeded supplier for PO seeding",
        );
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
          minBytes: TARGET_BYTES,
        });
      },
    },
    {
      entity: "purchase_orders",
      childTable: purchaseOrdersTable,
      // `writePurchaseOrdersCsvSync` uses `upo-` so uploaded POs do NOT
      // collide with the `po-` parents seeded for the po_lines variant.
      childExtIdPrefix: `${EXTERNAL_ID_PREFIX}upo-`,
      prepare: async () => {
        // Reuse seeded suppliers from earlier variants when present; otherwise
        // create them now. The CSV references suppliers by external ID so we
        // only need the strings, not internal ids.
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
        const supplierExternalIds = Array.from(supplierIdMap.keys());
        assert.ok(
          supplierExternalIds.length > 0,
          "expected at least one seeded supplier extId for PO upload",
        );
        return { writeArgs: { supplierExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { supplierExternalIds } = args as {
          supplierExternalIds: string[];
        };
        return writePurchaseOrdersCsvSync(filePath, {
          supplierExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          minBytes: TARGET_BYTES,
        });
      },
    },
    {
      entity: "payments",
      childTable: paymentsTable,
      childExtIdPrefix: `${EXTERNAL_ID_PREFIX}pay-`,
      prepare: async () => {
        // Payments need parent invoices. We can't reuse invoices uploaded by
        // the earlier `invoices` variant because their batch-load cost grows
        // with the upload size; seed a small dedicated set instead so each
        // payment batch resolves through the same FK lookup map shape.
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
        assert.ok(
          supplierIds.length > 0,
          "expected at least one seeded supplier for invoice seeding",
        );
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
          minBytes: TARGET_BYTES,
        });
      },
    },
    {
      entity: "shipments",
      childTable: shipmentsTable,
      childExtIdPrefix: `${EXTERNAL_ID_PREFIX}shp-`,
      prepare: async () => {
        // Reuse suppliers and POs seeded by earlier variants; seed any that
        // are missing so this variant can run independently.
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
        const supplierExternalIds = Array.from(supplierIdMap.keys());
        // Need PO external IDs for the shipments CSV. The po_lines variant
        // seeds them under the same prefix; query the table directly so this
        // variant works regardless of variant ordering.
        const poRows = await db
          .select({ ext: purchaseOrdersTable.sourceExternalId })
          .from(purchaseOrdersTable)
          .where(
            and(
              eq(purchaseOrdersTable.orgId, orgId),
              eq(purchaseOrdersTable.sourceSystem, FIXTURE_SOURCE),
              like(
                purchaseOrdersTable.sourceExternalId,
                `${EXTERNAL_ID_PREFIX}po-%`,
              ),
            ),
          );
        let poExternalIds = poRows
          .map((r) => r.ext)
          .filter((x): x is string => Boolean(x));
        if (poExternalIds.length === 0) {
          const supplierIds = Array.from(supplierIdMap.values());
          poExternalIds = await seedPurchaseOrders(
            orgId,
            PARENT_POS,
            supplierIds,
            EXTERNAL_ID_PREFIX,
          );
        }
        assert.ok(
          poExternalIds.length > 0,
          "expected at least one seeded PO extId for shipments upload",
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
          minBytes: TARGET_BYTES,
        });
      },
    },
  ];

  for (const variant of variants) {
    await t.test(`entity: ${variant.entity}`, async () => {
      const tmpFile = path.join(
        os.tmpdir(),
        `csv-stream-large-${variant.entity}-${process.pid}-${Date.now()}.csv`,
      );
      tmpFiles.push(tmpFile);

      const { writeArgs } = await variant.prepare();
      const expectedRows = variant.writeCsv(tmpFile, writeArgs);

      const stat = fs.statSync(tmpFile);
      assert.ok(
        stat.size >= TARGET_BYTES,
        `Generated ${variant.entity} CSV should be >= ${TARGET_BYTES} bytes, got ${stat.size}`,
      );
      console.log(
        `[${variant.entity}] generated CSV: ${(stat.size / 1024 / 1024).toFixed(2)} MB, ${expectedRows} rows`,
      );

      const { status, rawBody } = await uploadCsv({
        baseUrl: server!.baseUrl,
        orgId,
        entity: variant.entity,
        filePath: tmpFile,
        formFilename: `${variant.entity}.csv`,
      });
      assert.equal(status, 200, `unexpected status ${status}: ${rawBody}`);

      const event = parseTerminalNdjsonEvent(rawBody);
      assert.equal(
        event.type,
        "result",
        `expected terminal event 'result', got ${event.type}: ${rawBody.slice(0, 200)}`,
      );
      if (event.type !== "result") return; // type narrow
      assert.equal(event.entity, variant.entity);
      assert.equal(
        event.rowsParsed,
        expectedRows,
        `parser saw ${event.rowsParsed} rows, expected ${expectedRows}`,
      );
      assert.equal(
        event.rowsInserted,
        expectedRows,
        `db reported ${event.rowsInserted} inserted rows, expected ${expectedRows}`,
      );

      // Real DB shows the same count (filtered to this run only).
      await sleep(50);
      const dbRows = await db
        .select({ id: variant.childTable.id })
        .from(variant.childTable)
        .where(
          and(
            eq(variant.childTable.sourceSystem, FIXTURE_SOURCE),
            like(
              variant.childTable.sourceExternalId,
              `${variant.childExtIdPrefix}%`,
            ),
          ),
        );
      assert.equal(
        dbRows.length,
        expectedRows,
        `${variant.entity} DB row count mismatch: got ${dbRows.length}, expected ${expectedRows}`,
      );
    });
  }
});
