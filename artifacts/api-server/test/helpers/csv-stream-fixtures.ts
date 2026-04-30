/**
 * Shared fixtures for `/api/ingest/csv-stream` integration tests.
 *
 * Every fixture function namespaces its inserts with a caller-supplied
 * `extIdPrefix` (typically `${TEST_RUN_ID}-`); `deleteFixtureRowsByPrefix`
 * deletes everything matching that prefix in foreign-key-safe order, so
 * concurrent test runs against the same database stay isolated.
 */
import http from "node:http";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  purchaseOrdersTable,
  poLinesTable,
  invoicesTable,
  paymentsTable,
  shipmentsTable,
  itemsTable,
  categoriesTable,
} from "@workspace/db";
import { and, eq, like, or } from "drizzle-orm";
import type { Express } from "express";

export const FIXTURE_SOURCE = "csv";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

export async function startServer(app: Express): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind server");
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

export async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) {
    throw new Error(
      "No org rows found. Seed the database (pnpm --filter @workspace/scripts run seed) before running this test.",
    );
  }
  return row.id;
}

/** node:fs.openAsBlob wrapper so callers stream the file rather than buffer it. */
export async function openAsBlob(
  filePath: string,
  type: string,
): Promise<Blob> {
  const fsmod = await import("node:fs");
  const fn = (
    fsmod as unknown as {
      openAsBlob?: (p: string, opts?: { type?: string }) => Promise<Blob>;
    }
  ).openAsBlob;
  if (typeof fn !== "function") {
    throw new Error(
      "node:fs.openAsBlob is not available; node >= 20 is required.",
    );
  }
  return fn(filePath, { type });
}

/** Seed N suppliers with externalId `${extIdPrefix}sup-${i}`. */
export async function seedSuppliers(
  orgId: string,
  count: number,
  extIdPrefix: string,
): Promise<string[]> {
  const externalIds: string[] = [];
  const rows: (typeof suppliersTable.$inferInsert)[] = [];
  for (let i = 0; i < count; i++) {
    const ext = `${extIdPrefix}sup-${i}`;
    externalIds.push(ext);
    rows.push({
      id: newId("sup"),
      orgId,
      name: `Seeded Test Supplier ${i}`,
      normalizedName: `seeded test supplier ${i}`,
      sourceSystem: FIXTURE_SOURCE,
      sourceExternalId: ext,
    });
  }
  await db.insert(suppliersTable).values(rows);
  return externalIds;
}

/** Map { externalId -> internal id } for suppliers seeded under `${extIdPrefix}sup-`. */
export async function loadSupplierIdMapByPrefix(
  orgId: string,
  extIdPrefix: string,
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
        eq(suppliersTable.sourceSystem, FIXTURE_SOURCE),
        like(suppliersTable.sourceExternalId, `${extIdPrefix}sup-%`),
      ),
    );
  for (const r of rows) if (r.ext) map.set(r.ext, r.id);
  return map;
}

/** Seed N POs linked round-robin to the given supplier ids. */
export async function seedPurchaseOrders(
  orgId: string,
  count: number,
  supplierIds: string[],
  extIdPrefix: string,
): Promise<string[]> {
  if (supplierIds.length === 0) {
    throw new Error("seedPurchaseOrders requires at least one supplier");
  }
  const externalIds: string[] = [];
  const rows: (typeof purchaseOrdersTable.$inferInsert)[] = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const ext = `${extIdPrefix}po-${i}`;
    externalIds.push(ext);
    rows.push({
      id: newId("po"),
      orgId,
      poNumber: `${extIdPrefix}PO-${i}`,
      supplierId: supplierIds[i % supplierIds.length]!,
      orderDate: today,
      sourceSystem: FIXTURE_SOURCE,
      sourceExternalId: ext,
    });
  }
  await db.insert(purchaseOrdersTable).values(rows);
  return externalIds;
}

/** Seed N categories with code `${extIdPrefix}cat-${i}`. */
export async function seedCategories(
  orgId: string,
  count: number,
  extIdPrefix: string,
): Promise<string[]> {
  const codes: string[] = [];
  const rows: (typeof categoriesTable.$inferInsert)[] = [];
  for (let i = 0; i < count; i++) {
    const code = `${extIdPrefix}cat-${i}`;
    codes.push(code);
    rows.push({
      id: newId("cat"),
      orgId,
      code,
      name: `Seeded Test Category ${i}`,
      class: "indirect",
      sourceSystem: FIXTURE_SOURCE,
      sourceExternalId: code,
    });
  }
  await db.insert(categoriesTable).values(rows);
  return codes;
}

/**
 * Seed N invoices linked round-robin to the given supplier ids. Used as
 * parent rows for the `payments` CSV upload tests, since payments reference
 * invoices via `invoiceExternalId` in `flushBatch`.
 *
 * Uses external-id pattern `${extIdPrefix}sinv-${i}` (s = "seeded") so it
 * does NOT collide with `writeInvoicesCsvSync` which produces `inv-${i}`
 * for invoices uploaded via the CSV under test in the same run.
 */
export async function seedInvoices(
  orgId: string,
  count: number,
  supplierIds: string[],
  extIdPrefix: string,
): Promise<string[]> {
  if (supplierIds.length === 0) {
    throw new Error("seedInvoices requires at least one supplier");
  }
  const externalIds: string[] = [];
  const rows: (typeof invoicesTable.$inferInsert)[] = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const ext = `${extIdPrefix}sinv-${i}`;
    externalIds.push(ext);
    rows.push({
      id: newId("inv"),
      orgId,
      invoiceNumber: `${extIdPrefix}SEED-INV-${i}`,
      supplierId: supplierIds[i % supplierIds.length]!,
      invoiceDate: today,
      amountUsd: (100 + (i % 1000)).toFixed(2),
      status: "received",
      dedupKey: `${ext}|seed`,
      sourceSystem: FIXTURE_SOURCE,
      sourceExternalId: ext,
    });
  }
  await db.insert(invoicesTable).values(rows);
  return externalIds;
}

/**
 * Write an `invoices` CSV referencing the seeded supplier external IDs in
 * round-robin order. Stops as soon as `minBytes` or `rowCount` is hit; one
 * of the two must be supplied. Returns the number of rows written.
 */
export function writeInvoicesCsvSync(
  filePath: string,
  opts: {
    supplierExternalIds: string[];
    extIdPrefix: string;
    minBytes?: number;
    rowCount?: number;
  },
): number {
  const { supplierExternalIds, extIdPrefix, minBytes, rowCount } = opts;
  if (supplierExternalIds.length === 0) {
    throw new Error("writeInvoicesCsvSync requires at least one supplier extId");
  }
  if (minBytes === undefined && rowCount === undefined) {
    throw new Error("writeInvoicesCsvSync requires minBytes or rowCount");
  }
  const fd = fs.openSync(filePath, "w");
  try {
    const header =
      "externalId,invoiceNumber,supplierExternalId,invoiceDate,amountUsd,status,dedupKey\n";
    fs.writeSync(fd, header);
    let bytes = header.length;
    let rows = 0;
    const pad = "x".repeat(40);
    while (
      (minBytes === undefined || bytes < minBytes) &&
      (rowCount === undefined || rows < rowCount)
    ) {
      const ext = `${extIdPrefix}inv-${rows}`;
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
 * Write a `po_lines` CSV referencing seeded PO external IDs and category codes
 * in round-robin order, exercising both grouped lookups in `flushBatch`. Stops
 * as soon as `minBytes` or `rowCount` is hit; one of the two must be supplied.
 * Returns the number of rows written.
 */
export function writePoLinesCsvSync(
  filePath: string,
  opts: {
    poExternalIds: string[];
    categoryCodes: string[];
    extIdPrefix: string;
    minBytes?: number;
    rowCount?: number;
  },
): number {
  const { poExternalIds, categoryCodes, extIdPrefix, minBytes, rowCount } =
    opts;
  if (poExternalIds.length === 0) {
    throw new Error("writePoLinesCsvSync requires at least one PO extId");
  }
  if (categoryCodes.length === 0) {
    throw new Error("writePoLinesCsvSync requires at least one category code");
  }
  if (minBytes === undefined && rowCount === undefined) {
    throw new Error("writePoLinesCsvSync requires minBytes or rowCount");
  }
  const fd = fs.openSync(filePath, "w");
  try {
    const header =
      "externalId,poExternalId,lineNumber,sku,description,categoryExternalId,spendClass,qty,uom,unitPriceUsd,orderDate\n";
    fs.writeSync(fd, header);
    let bytes = header.length;
    let rows = 0;
    const descPad = "y".repeat(64);
    while (
      (minBytes === undefined || bytes < minBytes) &&
      (rowCount === undefined || rows < rowCount)
    ) {
      const ext = `${extIdPrefix}pol-${rows}`;
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
 * Write a `categories` CSV with prefix-namespaced codes. The streaming
 * `categories` flushBatch upserts on `(orgId, code)` and does NOT set
 * `sourceSystem` / `sourceExternalId`, so cleanup of these rows is by
 * `code` prefix in `deleteFixtureRowsByPrefix`.
 */
export function writeCategoriesCsvSync(
  filePath: string,
  opts: { extIdPrefix: string; rowCount: number },
): number {
  const { extIdPrefix, rowCount } = opts;
  const fd = fs.openSync(filePath, "w");
  try {
    const header = "code,name,class\n";
    fs.writeSync(fd, header);
    const classes = ["direct", "indirect", "service"] as const;
    let rows = 0;
    while (rows < rowCount) {
      const code = `${extIdPrefix}upcat-${rows}`;
      const name = `Uploaded Test Category ${rows}`;
      const cls = classes[rows % classes.length]!;
      fs.writeSync(fd, `${code},"${name}",${cls}\n`);
      rows++;
    }
    return rows;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write an `items` CSV. Each row gets a unique sku namespaced under
 * `extIdPrefix` so the `(orgId, sku)` unique index never collides with seed
 * data or other concurrent test runs.
 */
export function writeItemsCsvSync(
  filePath: string,
  opts: { extIdPrefix: string; rowCount: number },
): number {
  const { extIdPrefix, rowCount } = opts;
  const fd = fs.openSync(filePath, "w");
  try {
    const header =
      "externalId,sku,description,normalizedKey,mfgPartNumber,uom\n";
    fs.writeSync(fd, header);
    const descPad = "z".repeat(48);
    let rows = 0;
    while (rows < rowCount) {
      const ext = `${extIdPrefix}item-${rows}`;
      const sku = `${extIdPrefix}SKU-${rows}`;
      const desc = `Bulk Test Item ${rows} ${descPad}`;
      const normKey = sku.toUpperCase();
      const mpn = `MPN-${rows}`;
      const uom = "EA";
      fs.writeSync(
        fd,
        `${ext},${sku},"${desc}",${normKey},${mpn},${uom}\n`,
      );
      rows++;
    }
    return rows;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write a `purchase_orders` CSV referencing the seeded supplier external IDs
 * in round-robin order, exercising the grouped supplier lookup in
 * `flushBatch`. Uses external-id pattern `${extIdPrefix}upo-${i}` (u =
 * "uploaded") so it does NOT collide with `seedPurchaseOrders` before
 * produces `po-${i}` for parent POs in the same run. Stops as soon as
 * `minBytes` or `rowCount` is hit; one of the two must be supplied.
 * Returns the number of rows written.
 */
export function writePurchaseOrdersCsvSync(
  filePath: string,
  opts: {
    supplierExternalIds: string[];
    extIdPrefix: string;
    minBytes?: number;
    rowCount?: number;
  },
): number {
  const { supplierExternalIds, extIdPrefix, minBytes, rowCount } = opts;
  if (supplierExternalIds.length === 0) {
    throw new Error(
      "writePurchaseOrdersCsvSync requires at least one supplier extId",
    );
  }
  if (minBytes === undefined && rowCount === undefined) {
    throw new Error(
      "writePurchaseOrdersCsvSync requires minBytes or rowCount",
    );
  }
  const fd = fs.openSync(filePath, "w");
  try {
    const header =
      "externalId,poNumber,supplierExternalId,businessUnit,site,status,orderDate,totalUsd\n";
    fs.writeSync(fd, header);
    let bytes = header.length;
    let rows = 0;
    const buPad = "Z".repeat(32);
    while (
      (minBytes === undefined || bytes < minBytes) &&
      (rowCount === undefined || rows < rowCount)
    ) {
      const ext = `${extIdPrefix}upo-${rows}`;
      const supExt = supplierExternalIds[rows % supplierExternalIds.length]!;
      const poNo = `${extIdPrefix}UPO-${rows}`;
      const bu = `BU-${rows % 10}-${buPad}`;
      const site = `SITE-${rows % 5}`;
      const total = (1000 + (rows % 100000)).toFixed(2);
      const line = `${ext},${poNo},${supExt},"${bu}",${site},open,2025-01-15,${total}\n`;
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
 * Write a `payments` CSV referencing the seeded invoice external IDs in
 * round-robin order, exercising the grouped invoice lookup in `flushBatch`.
 * Stops as soon as `minBytes` or `rowCount` is hit; one of the two must be
 * supplied. Returns the number of rows written.
 */
export function writePaymentsCsvSync(
  filePath: string,
  opts: {
    invoiceExternalIds: string[];
    extIdPrefix: string;
    minBytes?: number;
    rowCount?: number;
  },
): number {
  const { invoiceExternalIds, extIdPrefix, minBytes, rowCount } = opts;
  if (invoiceExternalIds.length === 0) {
    throw new Error(
      "writePaymentsCsvSync requires at least one invoice extId",
    );
  }
  if (minBytes === undefined && rowCount === undefined) {
    throw new Error("writePaymentsCsvSync requires minBytes or rowCount");
  }
  const fd = fs.openSync(filePath, "w");
  try {
    const header =
      "externalId,invoiceExternalId,paidDate,amountUsd,paymentTermsDays\n";
    fs.writeSync(fd, header);
    let bytes = header.length;
    let rows = 0;
    while (
      (minBytes === undefined || bytes < minBytes) &&
      (rowCount === undefined || rows < rowCount)
    ) {
      const ext = `${extIdPrefix}pay-${rows}`;
      const invExt = invoiceExternalIds[rows % invoiceExternalIds.length]!;
      const amt = (50 + (rows % 5000)).toFixed(2);
      const terms = String(15 + (rows % 60));
      const line = `${ext},${invExt},2025-02-15,${amt},${terms}\n`;
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
 * Write a `shipments` CSV referencing seeded PO and supplier external IDs in
 * round-robin order, exercising both grouped lookups in `flushBatch`. Stops
 * as soon as `minBytes` or `rowCount` is hit; one of the two must be
 * supplied. Returns the number of rows written.
 */
export function writeShipmentsCsvSync(
  filePath: string,
  opts: {
    poExternalIds: string[];
    supplierExternalIds: string[];
    extIdPrefix: string;
    minBytes?: number;
    rowCount?: number;
  },
): number {
  const {
    poExternalIds,
    supplierExternalIds,
    extIdPrefix,
    minBytes,
    rowCount,
  } = opts;
  if (poExternalIds.length === 0) {
    throw new Error("writeShipmentsCsvSync requires at least one PO extId");
  }
  if (supplierExternalIds.length === 0) {
    throw new Error(
      "writeShipmentsCsvSync requires at least one supplier extId",
    );
  }
  if (minBytes === undefined && rowCount === undefined) {
    throw new Error("writeShipmentsCsvSync requires minBytes or rowCount");
  }
  const fd = fs.openSync(filePath, "w");
  try {
    const header =
      "externalId,poExternalId,supplierExternalId,carrier,mode,originCountry,destCountry,laneKey,weightKg,freightCostUsd,incoterms,shipDate\n";
    fs.writeSync(fd, header);
    let bytes = header.length;
    let rows = 0;
    const modes = ["ocean", "air", "ltl", "tl", "parcel", "rail"] as const;
    const carriers = ["UPS", "DHL", "FedEx", "Maersk", "Hapag", "DB Schenker"];
    const countries = ["US", "DE", "CN", "MX", "CA", "JP"];
    while (
      (minBytes === undefined || bytes < minBytes) &&
      (rowCount === undefined || rows < rowCount)
    ) {
      const ext = `${extIdPrefix}shp-${rows}`;
      const poExt = poExternalIds[rows % poExternalIds.length]!;
      const supExt = supplierExternalIds[rows % supplierExternalIds.length]!;
      const carrier = carriers[rows % carriers.length]!;
      const mode = modes[rows % modes.length]!;
      const origin = countries[rows % countries.length]!;
      const dest = countries[(rows + 1) % countries.length]!;
      const lane = `${origin}-${dest}-${mode}`;
      const weight = (10 + (rows % 5000)).toFixed(2);
      const cost = (100 + (rows % 10000)).toFixed(2);
      const line = `${ext},${poExt},${supExt},${carrier},${mode},${origin},${dest},${lane},${weight},${cost},FOB,2025-03-15\n`;
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
 * Delete every fixture row under `extIdPrefix`, in foreign-key-safe order.
 *
 * Most child tables follow the `(sourceSystem='csv', sourceExternalId LIKE
 * prefix%)` pattern. Categories are special: the streaming `categories`
 * flushBatch does NOT set `sourceSystem` / `sourceExternalId` on uploaded
 * rows (it upserts on `(orgId, code)`), so cleanup matches by `code` prefix
 * to cover both seeded rows (whose code is also prefixed) and uploaded rows
 * from the streaming `categories` test variant.
 */
export async function deleteFixtureRowsByPrefix(
  extIdPrefix: string,
): Promise<void> {
  // Children first. Payments cascade-delete with invoices, but deleting them
  // explicitly first keeps cleanup robust to leftover rows whose parent
  // invoice was already gone. Shipments do NOT cascade (poId / supplierId
  // are `set null`), so explicit deletion is required.
  await db
    .delete(paymentsTable)
    .where(
      and(
        eq(paymentsTable.sourceSystem, FIXTURE_SOURCE),
        like(paymentsTable.sourceExternalId, `${extIdPrefix}%`),
      ),
    );
  await db
    .delete(shipmentsTable)
    .where(
      and(
        eq(shipmentsTable.sourceSystem, FIXTURE_SOURCE),
        like(shipmentsTable.sourceExternalId, `${extIdPrefix}%`),
      ),
    );
  await db
    .delete(poLinesTable)
    .where(
      and(
        eq(poLinesTable.sourceSystem, FIXTURE_SOURCE),
        like(poLinesTable.sourceExternalId, `${extIdPrefix}%`),
      ),
    );
  await db
    .delete(invoicesTable)
    .where(
      and(
        eq(invoicesTable.sourceSystem, FIXTURE_SOURCE),
        like(invoicesTable.sourceExternalId, `${extIdPrefix}%`),
      ),
    );
  // Items reference categories with set null, so they can be cleaned in any
  // order relative to categories — but they must precede the pool drain.
  await db
    .delete(itemsTable)
    .where(
      and(
        eq(itemsTable.sourceSystem, FIXTURE_SOURCE),
        like(itemsTable.sourceExternalId, `${extIdPrefix}%`),
      ),
    );
  // Parents.
  await db
    .delete(purchaseOrdersTable)
    .where(
      and(
        eq(purchaseOrdersTable.sourceSystem, FIXTURE_SOURCE),
        like(purchaseOrdersTable.sourceExternalId, `${extIdPrefix}%`),
      ),
    );
  await db
    .delete(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, FIXTURE_SOURCE),
        like(suppliersTable.sourceExternalId, `${extIdPrefix}%`),
      ),
    );
  // Categories: cover both seeded rows (sourceSystem='csv' + namespaced
  // sourceExternalId) AND uploaded rows from the streaming `categories`
  // variant (default sourceSystem='seed', no sourceExternalId, but `code`
  // is prefix-namespaced). Matching either column is safe because every
  // category code we generate in tests is namespaced under `extIdPrefix`.
  await db
    .delete(categoriesTable)
    .where(
      or(
        like(categoriesTable.code, `${extIdPrefix}%`),
        and(
          eq(categoriesTable.sourceSystem, FIXTURE_SOURCE),
          like(categoriesTable.sourceExternalId, `${extIdPrefix}%`),
        ),
      ),
    );
}
