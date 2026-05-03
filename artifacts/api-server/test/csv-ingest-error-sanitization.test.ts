/**
 * Task #279 — CSV / mock-ERP / streaming-CSV ingest dedupe contract.
 *
 * Three pre-existing trigger paths previously crashed the ingest with
 * Postgres SQLSTATE 21000 ("ON CONFLICT DO UPDATE command cannot
 * affect row a second time") because the operator's payload contained
 * two rows that targeted the same `(orgId, sourceSystem,
 * sourceExternalId)` upsert key inside ONE statement:
 *
 *   1. POST `/api/ingest/csv`            — two suppliers with the same `externalId`.
 *   2. POST `/api/ingest/mock-erp`       — a `purchase_order` with two
 *                                          lines sharing `lineNumber`
 *                                          (the source external id is
 *                                          `${rec.externalId}#${l.lineNumber}`).
 *   3. POST `/api/ingest/csv-stream`     — two CSV rows in the same flush
 *                                          batch sharing the conflict-target
 *                                          natural key.
 *
 * The fix dedupes the inbound batch with `last write wins` semantics
 * BEFORE the upsert is sent to Postgres. This file pins the new
 * contract: every endpoint above must succeed (HTTP 200, no `error`
 * NDJSON event), persist exactly ONE row per natural key, and the
 * persisted row carries the values from the LAST input row for that
 * key (matching the observable result of Postgres applying separate
 * `INSERT ... ON CONFLICT DO UPDATE` statements in payload order).
 *
 * Prereqs
 * -------
 * - `DATABASE_URL` is set and the schema has been pushed (see `lib/db`).
 * - At least one row exists in `orgs` (the test will use the first one).
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

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
  pool,
} from "@workspace/db";
import { and, eq, like, or } from "drizzle-orm";
import app from "../src/app";

const TEST_RUN_ID = `task279-dedupe-${Date.now()}-${process.pid}`;
const CSV_PREFIX = `${TEST_RUN_ID}-csv-`;
const ERP_PREFIX = `${TEST_RUN_ID}-erp-`;
const STREAM_PREFIX = `${TEST_RUN_ID}-stream-`;

const SENTINEL_SUPPLIER_NAME = `Acme Sentinel ${TEST_RUN_ID}`;
const SENTINEL_PO_NUMBER = `PO-${TEST_RUN_ID}`;

let server: http.Server;
let baseUrl: string;
let orgId: string;

before(async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) {
    throw new Error(
      "No org rows found. Seed the database (pnpm --filter @workspace/scripts run seed) before running this test.",
    );
  }
  orgId = row.id;

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind test server");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;

  await cleanupTestRows();
});

after(async () => {
  try {
    await cleanupTestRows();
  } catch (err) {
    console.error("[cleanup] failed:", err);
  }
  if (server) await new Promise<void>((res) => server.close(() => res()));
  await pool.end().catch(() => {});
});

async function cleanupTestRows(): Promise<void> {
  await db
    .delete(poLinesTable)
    .where(
      or(
        like(poLinesTable.sourceExternalId, `${ERP_PREFIX}%`),
        like(poLinesTable.sourceExternalId, `${CSV_PREFIX}%`),
      ),
    );
  await db
    .delete(purchaseOrdersTable)
    .where(
      or(
        like(purchaseOrdersTable.sourceExternalId, `${ERP_PREFIX}%`),
        like(purchaseOrdersTable.sourceExternalId, `${CSV_PREFIX}%`),
      ),
    );
  await db
    .delete(suppliersTable)
    .where(
      and(
        or(
          eq(suppliersTable.sourceSystem, "csv"),
          eq(suppliersTable.sourceSystem, "mock_erp"),
        ),
        or(
          like(suppliersTable.sourceExternalId, `${CSV_PREFIX}%`),
          like(suppliersTable.sourceExternalId, `${ERP_PREFIX}%`),
          like(suppliersTable.sourceExternalId, `${STREAM_PREFIX}%`),
        ),
      ),
    );
}

test("POST /api/ingest/csv dedupes duplicate supplier rows (last write wins)", async () => {
  const dupExternalId = `${CSV_PREFIX}sup-A`;
  const payload = {
    suppliers: [
      {
        externalId: dupExternalId,
        name: SENTINEL_SUPPLIER_NAME,
        countryCode: "US",
      },
      {
        externalId: dupExternalId,
        name: `${SENTINEL_SUPPLIER_NAME} (dup)`,
        countryCode: "DE",
      },
    ],
  };

  const res = await fetch(`${baseUrl}/api/ingest/csv`, {
    method: "POST",
    headers: {
      "x-org-id": orgId,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  assert.equal(
    res.status,
    200,
    `expected /api/ingest/csv to succeed with in-batch dup (last write wins), got ${res.status}: ${await res.text()}`,
  );

  // Exactly one supplier row exists for this externalId, carrying the
  // LAST input row's values (the dup with countryCode=DE).
  const rows = await db
    .select({
      name: suppliersTable.name,
      countryCode: suppliersTable.countryCode,
    })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.orgId, orgId),
        eq(suppliersTable.sourceSystem, "csv"),
        eq(suppliersTable.sourceExternalId, dupExternalId),
      ),
    );
  assert.equal(
    rows.length,
    1,
    `expected exactly one supplier row after dedupe, got ${rows.length}`,
  );
  assert.equal(rows[0]!.name, `${SENTINEL_SUPPLIER_NAME} (dup)`);
  assert.equal(rows[0]!.countryCode, "DE");
});

test("POST /api/ingest/mock-erp dedupes duplicate PO lineNumbers (last write wins)", async () => {
  const supplierExt = `${ERP_PREFIX}sup-1`;
  const poExt = `${ERP_PREFIX}po-1`;
  const updatedAt = new Date().toISOString();

  const feed = [
    {
      type: "supplier",
      externalId: supplierExt,
      updatedAt,
      payload: {
        name: SENTINEL_SUPPLIER_NAME,
        countryCode: "US",
      },
    },
    {
      type: "purchase_order",
      externalId: poExt,
      updatedAt,
      payload: {
        poNumber: SENTINEL_PO_NUMBER,
        supplierExternalId: supplierExt,
        orderDate: updatedAt,
        // Two lines with the same `lineNumber` — must collapse to one
        // poLines row carrying the LAST line's sku / qty / price.
        lines: [
          {
            lineNumber: 1,
            sku: `${ERP_PREFIX}sku-A`,
            description: "Sentinel item A",
            spendClass: "indirect",
            qty: 1,
            unitPriceUsd: 10,
          },
          {
            lineNumber: 1,
            sku: `${ERP_PREFIX}sku-B`,
            description: "Sentinel item B",
            spendClass: "indirect",
            qty: 2,
            unitPriceUsd: 20,
          },
        ],
      },
    },
  ];

  const res = await fetch(`${baseUrl}/api/ingest/mock-erp`, {
    method: "POST",
    headers: {
      "x-org-id": orgId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ feed }),
  });

  assert.equal(
    res.status,
    200,
    `expected /api/ingest/mock-erp to succeed with in-batch dup (last write wins), got ${res.status}: ${await res.text()}`,
  );

  const lineExt = `${poExt}#1`;
  const rows = await db
    .select({
      sku: poLinesTable.sku,
      description: poLinesTable.description,
      qty: poLinesTable.qty,
      unitPriceUsd: poLinesTable.unitPriceUsd,
    })
    .from(poLinesTable)
    .where(
      and(
        eq(poLinesTable.orgId, orgId),
        eq(poLinesTable.sourceSystem, "mock_erp"),
        eq(poLinesTable.sourceExternalId, lineExt),
      ),
    );
  assert.equal(
    rows.length,
    1,
    `expected exactly one po_lines row after dedupe, got ${rows.length}`,
  );
  assert.equal(rows[0]!.sku, `${ERP_PREFIX}sku-B`);
  assert.equal(rows[0]!.description, "Sentinel item B");
  // Numeric columns stringify with the column scale (qty:4, price:4).
  assert.equal(Number(rows[0]!.qty), 2);
  assert.equal(Number(rows[0]!.unitPriceUsd), 20);
});

test("POST /api/ingest/csv-stream dedupes in-batch duplicate suppliers (last write wins)", async () => {
  const dupExternalId = `${STREAM_PREFIX}sup-A`;
  const csvBody =
    "externalId,name,countryCode\n" +
    `${dupExternalId},"${SENTINEL_SUPPLIER_NAME}",US\n` +
    `${dupExternalId},"${SENTINEL_SUPPLIER_NAME} (dup)",DE\n`;

  const res = await fetch(
    `${baseUrl}/api/ingest/csv-stream?entity=suppliers`,
    {
      method: "POST",
      headers: {
        "x-org-id": orgId,
        "content-type": "text/csv",
      },
      body: csvBody,
    },
  );

  assert.equal(
    res.status,
    200,
    `expected /api/ingest/csv-stream to return 200, got ${res.status}`,
  );
  const body = await res.text();

  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const events = lines.map((l, i) => {
    try {
      return JSON.parse(l) as {
        type?: string;
        error?: string;
        rowsParsed?: number;
        rowsInserted?: number;
      };
    } catch (err) {
      throw new Error(
        `/api/ingest/csv-stream NDJSON line #${i + 1} did not parse: ` +
          `${(err as Error).message}; line: ${l}`,
      );
    }
  });
  const errorEvent = events.find((e) => e.type === "error");
  assert.equal(
    errorEvent,
    undefined,
    `/api/ingest/csv-stream emitted an unexpected error event: ${JSON.stringify(errorEvent)}`,
  );
  // The route emits a terminal `done` (or similar success) event with
  // counts. We don't pin the exact event name, but the body must
  // describe a successful run.
  const failingEvents = events.filter(
    (e) => e.type === "error" || (e.error && e.error.length > 0),
  );
  assert.equal(
    failingEvents.length,
    0,
    `/api/ingest/csv-stream emitted ${failingEvents.length} failure events: ${JSON.stringify(failingEvents)}`,
  );

  const rows = await db
    .select({
      name: suppliersTable.name,
      countryCode: suppliersTable.countryCode,
    })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.orgId, orgId),
        eq(suppliersTable.sourceSystem, "csv"),
        eq(suppliersTable.sourceExternalId, dupExternalId),
      ),
    );
  assert.equal(
    rows.length,
    1,
    `expected exactly one supplier row after streaming dedupe, got ${rows.length}`,
  );
  assert.equal(rows[0]!.name, `${SENTINEL_SUPPLIER_NAME} (dup)`);
  assert.equal(rows[0]!.countryCode, "DE");
});
