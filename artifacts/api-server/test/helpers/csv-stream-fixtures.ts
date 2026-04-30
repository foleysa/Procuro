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
  categoriesTable,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
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

/** Delete every fixture row under `extIdPrefix`, in foreign-key-safe order. */
export async function deleteFixtureRowsByPrefix(
  extIdPrefix: string,
): Promise<void> {
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
  await db
    .delete(categoriesTable)
    .where(
      and(
        eq(categoriesTable.sourceSystem, FIXTURE_SOURCE),
        like(categoriesTable.sourceExternalId, `${extIdPrefix}%`),
      ),
    );
}
