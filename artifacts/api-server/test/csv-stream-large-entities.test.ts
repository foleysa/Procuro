/**
 * Integration test for `POST /api/ingest/csv-stream` covering the higher-risk
 * non-`suppliers` entities — `invoices` and `po_lines` — with a >10 MB CSV
 * each.
 *
 * Why this exists
 * ---------------
 * `csv-stream-large.test.ts` only exercises `suppliers`, which has the
 * simplest per-batch logic (no foreign-key lookups). The streaming endpoint
 * also accepts seven other entities, and the highest-volume one in real
 * customer data — `po_lines` — has the most complex per-batch logic: it
 * runs grouped lookups against `purchase_orders` AND `categories` for every
 * batch before the upsert. `invoices` is the next most complex (one or two
 * grouped lookups per batch). A regression in either path would silently
 * drop customer data and the suppliers-only test would not catch it.
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
import http from "node:http";
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
  orgsTable,
  suppliersTable,
  purchaseOrdersTable,
  poLinesTable,
  invoicesTable,
  categoriesTable,
  pool,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import app from "../src/app";

const TEST_RUN_ID = `csvstreamentities-${Date.now()}-${process.pid}`;
const EXTERNAL_ID_PREFIX = `${TEST_RUN_ID}-`;
const TARGET_BYTES = 10 * 1024 * 1024; // 10 MB minimum
const SOURCE = "csv";

// Number of parent rows pre-seeded for child-CSV lookups. Small enough that
// the per-batch `IN (...)` lookup fits in a single grouped query, large
// enough that the lookup map is exercised (i.e. not a single hit).
const PARENT_SUPPLIERS = 50;
const PARENT_POS = 50;
const PARENT_CATEGORIES = 5;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

/** Boot the express app on an ephemeral port; returns base URL + close fn. */
async function startServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to bind server");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/** Pick the first org id; the streaming endpoint requires a valid tenant. */
async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) {
    throw new Error(
      "No org rows found. Seed the database (pnpm --filter @workspace/scripts run seed) before running this test.",
    );
  }
  return row.id;
}

/**
 * Node 20+ ships `openAsBlob` on `node:fs`. Wrap it so the test reads the
 * file lazily via an underlying file descriptor instead of buffering its
 * entire contents into memory before the upload starts.
 */
async function openAsBlob(filePath: string, type: string): Promise<Blob> {
  const fsmod = await import("node:fs");
  const fn = (fsmod as unknown as {
    openAsBlob?: (p: string, opts?: { type?: string }) => Promise<Blob>;
  }).openAsBlob;
  if (typeof fn !== "function") {
    throw new Error(
      "node:fs.openAsBlob is not available; node >= 20 is required.",
    );
  }
  return fn(filePath, { type });
}

/**
 * The streaming endpoint replies with `application/x-ndjson`: zero or more
 * `{type:"progress",...}` lines followed by a single terminal event
 * (`{type:"result",...}` on success, `{type:"error",...}` on failure). Parse
 * the whole body and return the terminal event so subtests can assert on
 * row counts.
 */
function parseTerminalNdjsonEvent(rawBody: string):
  | { type: "result"; entity: string; rowsParsed: number; rowsInserted: number; durationMs: number }
  | { type: "error"; error: string } {
  const lines = rawBody.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Empty NDJSON response body`);
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = JSON.parse(lines[i]!) as { type?: string };
    if (parsed.type === "result" || parsed.type === "error") {
      return parsed as ReturnType<typeof parseTerminalNdjsonEvent>;
    }
  }
  throw new Error(
    `No terminal NDJSON event (result/error) found in response: ${rawBody.slice(0, 200)}`,
  );
}

/**
 * Seed N supplier rows so child entities (invoices, po_lines, purchase
 * orders, payments, shipments) have something to look up. Returns the
 * generated externalIds in insertion order.
 */
async function seedSuppliers(orgId: string, count: number): Promise<string[]> {
  const externalIds: string[] = [];
  const rows: (typeof suppliersTable.$inferInsert)[] = [];
  for (let i = 0; i < count; i++) {
    const ext = `${EXTERNAL_ID_PREFIX}sup-${i}`;
    externalIds.push(ext);
    rows.push({
      id: newId("sup"),
      orgId,
      name: `Seeded Test Supplier ${i}`,
      normalizedName: `seeded test supplier ${i}`,
      sourceSystem: SOURCE,
      sourceExternalId: ext,
    });
  }
  await db.insert(suppliersTable).values(rows);
  return externalIds;
}

/**
 * Map { externalId -> internal id } for every supplier seeded by THIS test
 * run. Scoped via the unique `EXTERNAL_ID_PREFIX` so concurrent runs on the
 * same DB do not interfere.
 */
async function loadThisRunsSupplierIdMap(
  orgId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const rows = await db
    .select({
      id: suppliersTable.id,
      ext: suppliersTable.sourceExternalId,
    })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.orgId, orgId),
        eq(suppliersTable.sourceSystem, SOURCE),
        like(suppliersTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}sup-%`),
      ),
    );
  for (const r of rows) if (r.ext) map.set(r.ext, r.id);
  return map;
}

/** Seed N PO rows linked round-robin to the seeded suppliers. */
async function seedPurchaseOrders(
  orgId: string,
  count: number,
  supplierIds: string[],
): Promise<string[]> {
  if (supplierIds.length === 0) {
    throw new Error("seedPurchaseOrders requires at least one supplier");
  }
  const externalIds: string[] = [];
  const rows: (typeof purchaseOrdersTable.$inferInsert)[] = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const ext = `${EXTERNAL_ID_PREFIX}po-${i}`;
    externalIds.push(ext);
    rows.push({
      id: newId("po"),
      orgId,
      poNumber: `${EXTERNAL_ID_PREFIX}PO-${i}`,
      supplierId: supplierIds[i % supplierIds.length]!,
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: ext,
    });
  }
  await db.insert(purchaseOrdersTable).values(rows);
  return externalIds;
}

/** Seed N category rows whose `code` matches `${prefix}cat-${i}`. */
async function seedCategories(
  orgId: string,
  count: number,
): Promise<string[]> {
  const codes: string[] = [];
  const rows: (typeof categoriesTable.$inferInsert)[] = [];
  for (let i = 0; i < count; i++) {
    const code = `${EXTERNAL_ID_PREFIX}cat-${i}`;
    codes.push(code);
    rows.push({
      id: newId("cat"),
      orgId,
      code,
      name: `Seeded Test Category ${i}`,
      class: "indirect",
      sourceSystem: SOURCE,
      sourceExternalId: code,
    });
  }
  await db.insert(categoriesTable).values(rows);
  return codes;
}

/**
 * Generate an `invoices` CSV row-by-row to disk. Each row references one of
 * the seeded supplier external IDs in round-robin order so the per-batch
 * lookup against `suppliers` resolves successfully.
 */
function writeInvoicesCsvSync(
  filePath: string,
  minBytes: number,
  supplierExternalIds: string[],
): number {
  if (supplierExternalIds.length === 0) {
    throw new Error("writeInvoicesCsvSync requires at least one supplier extId");
  }
  const fd = fs.openSync(filePath, "w");
  try {
    const header =
      "externalId,invoiceNumber,supplierExternalId,invoiceDate,amountUsd,status,dedupKey\n";
    fs.writeSync(fd, header);
    let bytes = header.length;
    let rows = 0;
    const pad = "x".repeat(40); // pad dedupKey to grow row size realistically
    while (bytes < minBytes) {
      const ext = `${EXTERNAL_ID_PREFIX}inv-${rows}`;
      const supExt = supplierExternalIds[rows % supplierExternalIds.length]!;
      const invNo = `INV-${rows}`;
      const date = "2025-01-15";
      const amt = (100 + (rows % 10000)).toFixed(2);
      const dedup = `${ext}|${supExt}|${pad}`;
      const line = `${ext},${invNo},${supExt},${date},${amt},received,${dedup}\n`;
      fs.writeSync(fd, line);
      bytes += line.length;
      rows++;
    }
    return rows;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Generate a `po_lines` CSV row-by-row to disk. Each row references one of
 * the seeded PO external IDs and one of the seeded category codes in
 * round-robin order — this exercises BOTH grouped lookups (POs and
 * categories) in `flushBatch`.
 */
function writePoLinesCsvSync(
  filePath: string,
  minBytes: number,
  poExternalIds: string[],
  categoryCodes: string[],
): number {
  if (poExternalIds.length === 0) {
    throw new Error("writePoLinesCsvSync requires at least one PO extId");
  }
  if (categoryCodes.length === 0) {
    throw new Error("writePoLinesCsvSync requires at least one category code");
  }
  const fd = fs.openSync(filePath, "w");
  try {
    const header =
      "externalId,poExternalId,lineNumber,sku,description,categoryExternalId,spendClass,qty,uom,unitPriceUsd,orderDate\n";
    fs.writeSync(fd, header);
    let bytes = header.length;
    let rows = 0;
    const descPad = "y".repeat(64);
    while (bytes < minBytes) {
      const ext = `${EXTERNAL_ID_PREFIX}pol-${rows}`;
      const poExt = poExternalIds[rows % poExternalIds.length]!;
      const cat = categoryCodes[rows % categoryCodes.length]!;
      const sku = `SKU-${rows}`;
      const desc = `Bulk Test PO Line ${rows} ${descPad}`;
      const line = `${ext},${poExt},${(rows % 1000) + 1},${sku},"${desc}",${cat},indirect,${(1 + (rows % 50)).toFixed(2)},EA,${(5 + (rows % 100)).toFixed(2)},2025-01-15\n`;
      fs.writeSync(fd, line);
      bytes += line.length;
      rows++;
    }
    return rows;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Delete everything this test run inserted, in foreign-key-safe order.
 * Children first (po_lines, invoices), then POs, then suppliers + categories.
 * Each delete is scoped to the unique `EXTERNAL_ID_PREFIX` so no other
 * concurrent runs are affected.
 */
async function deleteAllTestRows(): Promise<void> {
  // Children first.
  await db
    .delete(poLinesTable)
    .where(
      and(
        eq(poLinesTable.sourceSystem, SOURCE),
        like(poLinesTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}%`),
      ),
    );
  await db
    .delete(invoicesTable)
    .where(
      and(
        eq(invoicesTable.sourceSystem, SOURCE),
        like(invoicesTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}%`),
      ),
    );
  // Parents: POs (FK restrict on suppliers), then suppliers + categories.
  await db
    .delete(purchaseOrdersTable)
    .where(
      and(
        eq(purchaseOrdersTable.sourceSystem, SOURCE),
        like(purchaseOrdersTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}%`),
      ),
    );
  await db
    .delete(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, SOURCE),
        like(suppliersTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}%`),
      ),
    );
  await db
    .delete(categoriesTable)
    .where(
      and(
        eq(categoriesTable.sourceSystem, SOURCE),
        like(categoriesTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}%`),
      ),
    );
}

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
      await deleteAllTestRows();
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
  server = await startServer();
  const orgId = await pickOrgId();

  // Defensive cleanup of any leftover rows from a prior aborted run with the
  // same prefix (the prefix is timestamped + pid-suffixed so this is
  // normally a no-op).
  await deleteAllTestRows();

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
    entity: "invoices" | "po_lines";
    /** Set up parent records and return whatever the writer needs. */
    prepare: () => Promise<{ writeArgs: unknown }>;
    /** Generate the >10 MB CSV row-by-row to disk; return row count. */
    writeCsv: (filePath: string, args: unknown) => number;
    /** Drizzle table the inserted rows land in. */
    childTable: typeof invoicesTable | typeof poLinesTable;
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
        );
        return { writeArgs: { supplierExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { supplierExternalIds } = args as {
          supplierExternalIds: string[];
        };
        return writeInvoicesCsvSync(filePath, TARGET_BYTES, supplierExternalIds);
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
        let supplierIdMap = await loadThisRunsSupplierIdMap(orgId);
        if (supplierIdMap.size === 0) {
          await seedSuppliers(orgId, PARENT_SUPPLIERS);
          supplierIdMap = await loadThisRunsSupplierIdMap(orgId);
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
        );
        const categoryCodes = await seedCategories(orgId, PARENT_CATEGORIES);
        return { writeArgs: { poExternalIds, categoryCodes } };
      },
      writeCsv: (filePath, args) => {
        const { poExternalIds, categoryCodes } = args as {
          poExternalIds: string[];
          categoryCodes: string[];
        };
        return writePoLinesCsvSync(
          filePath,
          TARGET_BYTES,
          poExternalIds,
          categoryCodes,
        );
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
            eq(variant.childTable.sourceSystem, SOURCE),
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
