/**
 * End-to-end guardrail that the three import endpoints —
 *
 *   1. `POST /api/ingest/csv`         (synchronous JSON payload)
 *   2. `POST /api/ingest/mock-erp`    (synchronous mock-ERP feed)
 *   3. `POST /api/ingest/csv-stream`  (streaming multipart/raw CSV upload)
 *
 * — never echo a raw Postgres / Drizzle error back to the client.
 *
 * Why this exists
 * ---------------
 * `sanitize-db-error.test.ts` covers the helper in isolation: given a
 * fabricated `DatabaseError`, the message is scrubbed. It does NOT prove
 * that the helper is *wired* into the catch blocks of the three ingest
 * routes. A future change that, say, replaces
 *   `res.status(500).json({ error: sanitizeDbErrorMessage(err) })`
 * with an `err.message` shortcut, or switches the streaming branch to
 * write the raw error onto the NDJSON `error` event, would silently
 * restore the regression that the helper was introduced to fix — and the
 * unit tests would still pass because the helper itself is unchanged.
 *
 * What this verifies
 * ------------------
 * For each of the three endpoints, this test triggers a *real* Postgres
 * error against a *real* database (a duplicate-key cardinality violation
 * inside an `ON CONFLICT DO UPDATE` bulk upsert — SQLSTATE 21000) and
 * then asserts:
 *
 *   - The HTTP / NDJSON response body never contains:
 *       - SQL keywords:    `insert into`, `select`, `update`, `values (`
 *       - Param markers:   `$1`, `$2`, `$3`
 *       - PG framing:      `failing query`, `params`, `detail:`,
 *                          `key (`, `already exists`
 *       - Customer values: the supplier name, supplier external id,
 *                          purchase-order number, etc. that the test
 *                          interpolated into the failing payload.
 *
 *   - The response body DOES contain a sanitized, human-friendly summary
 *     (a known leading word like `Database error`, `Duplicate`, or the
 *     wrapping prefix `CSV stream ingest failed:` for the streaming
 *     route).
 *
 * Trigger choice
 * --------------
 * Sending two rows that share the conflict-target columns inside a
 * single `INSERT ... ON CONFLICT DO UPDATE` statement is the simplest
 * way to drive a real database error through the route's catch block
 * without mocking anything. Postgres rejects this with SQLSTATE 21000
 * ("ON CONFLICT DO UPDATE command cannot affect row a second time").
 * The route's `sanitizeDbErrorMessage` call must turn that message into
 * a safe summary; if a regression bypasses the sanitizer, the raw
 * Drizzle error string — which interpolates the supplier external id
 * and other parameter values — would land in the response body and
 * trigger the assertions below.
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

const TEST_RUN_ID = `task72-sanitize-${Date.now()}-${process.pid}`;
const CSV_PREFIX = `${TEST_RUN_ID}-csv-`;
const ERP_PREFIX = `${TEST_RUN_ID}-erp-`;
const STREAM_PREFIX = `${TEST_RUN_ID}-stream-`;

/**
 * Sentinel "customer" values interpolated into the failing payloads.
 * These are deliberately distinctive so that a regression that leaks the
 * raw Drizzle error (which embeds bound parameter values) is caught by
 * the substring check below — the unique strings would appear verbatim
 * in the response body. Pick strings that would never appear in a
 * sanitized summary built from SQLSTATE + identifier names alone.
 */
const SENTINEL_SUPPLIER_NAME = `Acme Sentinel ${TEST_RUN_ID}`;
const SENTINEL_PO_NUMBER = `PO-${TEST_RUN_ID}`;

/**
 * Substrings that must NEVER appear (case-insensitive) in any error
 * response from any of the three ingest endpoints. Split into two
 * groups for clearer assertion messages.
 */
const BANNED_SQL_FRAGMENTS = [
  "insert into",
  "select ",
  "update ",
  "values (",
  "$1",
  "$2",
  "$3",
  "failing query",
  "params:",
  "detail:",
  "key (",
  "already exists",
  "violates unique constraint",
];

/**
 * "Customer field values" the test interpolates into the failing
 * payloads. If any of these appear in the response body, the route is
 * leaking bound parameter values straight from the Postgres error.
 *
 * Sentinel external-id prefixes are included so a leak of any specific
 * `${PREFIX}sup-A` / `${PREFIX}line-1` style string is caught by a
 * single check; we don't need to enumerate every variant.
 */
function bannedCustomerValues(): string[] {
  return [
    SENTINEL_SUPPLIER_NAME,
    SENTINEL_PO_NUMBER,
    CSV_PREFIX,
    ERP_PREFIX,
    STREAM_PREFIX,
  ];
}

function assertNoLeakage(label: string, body: string): void {
  const lower = body.toLowerCase();
  for (const frag of BANNED_SQL_FRAGMENTS) {
    assert.ok(
      !lower.includes(frag),
      `[${label}] response body must not include SQL fragment "${frag}". ` +
        `Got: ${body}`,
    );
  }
  for (const val of bannedCustomerValues()) {
    assert.ok(
      !body.includes(val),
      `[${label}] response body must not include customer value "${val}". ` +
        `Got: ${body}`,
    );
  }
}

/**
 * The sanitizer produces messages that begin with a friendly headline
 * (one of `PG_ERROR_CODES` lookups), `Database error <SQLSTATE>` for
 * codes outside the known map (21000 is in this bucket), or the static
 * fallback `Internal server error during import` for non-DB errors. Any
 * of these is acceptable — we just need to confirm SOME sanitized
 * summary is present, not the raw stack/SQL.
 */
function assertSanitizedSummaryPresent(label: string, body: string): void {
  const lower = body.toLowerCase();
  const ok =
    lower.includes("database error") ||
    lower.includes("duplicate") ||
    lower.includes("integrity constraint") ||
    lower.includes("internal server error during import") ||
    lower.includes("csv stream ingest failed:");
  assert.ok(
    ok,
    `[${label}] response body did not contain any recognizable sanitized ` +
      `summary. Got: ${body}`,
  );
}

let server: http.Server;
let baseUrl: string;
let orgId: string;

before(async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  // Pick a real org from the seeded DB.
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

  // Defensive cleanup of any stragglers from a previous identically
  // prefixed run (the prefix is timestamped + pid-scoped so this is
  // normally a no-op).
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
  // po_lines first (FK to purchase_orders), then purchase_orders, then
  // suppliers (other tables FK to suppliers via restrict).
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
  // Suppliers go through both `csv` and `mock_erp` source systems
  // depending on the route. Match by external-id prefix to catch both.
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

test("POST /api/ingest/csv hides SQL when the database rejects the upsert", async () => {
  // Two suppliers sharing the same `externalId` land in the same chunk
  // of `bulkInsert(...).onConflictDoUpdate({ target: [orgId,
  // sourceSystem, sourceExternalId] })`. Postgres rejects the statement
  // with SQLSTATE 21000 ("ON CONFLICT DO UPDATE command cannot affect
  // row a second time") — a real DB error that travels through the
  // route's catch block to `sanitizeDbErrorMessage`.
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
    500,
    `expected /api/ingest/csv to return 500 on a real DB error, got ${res.status}`,
  );
  const body = await res.text();
  assertNoLeakage("/api/ingest/csv", body);

  let json: { error?: string };
  try {
    json = JSON.parse(body) as { error?: string };
  } catch {
    assert.fail(`/api/ingest/csv response was not valid JSON: ${body}`);
  }
  assert.ok(
    typeof json.error === "string" && json.error.length > 0,
    `/api/ingest/csv response missing 'error' field: ${body}`,
  );
  assertSanitizedSummaryPresent("/api/ingest/csv", json.error ?? "");
});

test("POST /api/ingest/mock-erp hides SQL when the database rejects the upsert", async () => {
  // The mock-ERP adapter inserts a `purchase_order`'s `lines` in a
  // single `INSERT ... ON CONFLICT DO UPDATE` keyed on
  // `(orgId, sourceSystem, sourceExternalId)`, where line external ids
  // are built as `${rec.externalId}#${l.lineNumber}`. Two lines with
  // the same `lineNumber` therefore collide on the conflict target
  // inside one statement → SQLSTATE 21000.
  //
  // We first emit a `supplier` record so the PO's `supplierExternalId`
  // resolves; otherwise the adapter no-ops the PO and never reaches the
  // failing line insert.
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
        // Two lines with the same `lineNumber` → identical
        // sourceExternalId on both rows → 21000.
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
    500,
    `expected /api/ingest/mock-erp to return 500 on a real DB error, got ${res.status}`,
  );
  const body = await res.text();
  assertNoLeakage("/api/ingest/mock-erp", body);

  let json: { error?: string };
  try {
    json = JSON.parse(body) as { error?: string };
  } catch {
    assert.fail(`/api/ingest/mock-erp response was not valid JSON: ${body}`);
  }
  assert.ok(
    typeof json.error === "string" && json.error.length > 0,
    `/api/ingest/mock-erp response missing 'error' field: ${body}`,
  );
  assertSanitizedSummaryPresent("/api/ingest/mock-erp", json.error ?? "");
});

test("POST /api/ingest/csv-stream hides SQL when the database rejects the upsert", async () => {
  // The streaming adapter accumulates supplier rows into batches of
  // BATCH_SIZE (1000) and flushes each batch with one
  // `INSERT ... ON CONFLICT DO UPDATE` keyed on
  // `(orgId, sourceSystem, sourceExternalId)`. Two CSV rows sharing the
  // same `externalId` land in the same batch and trigger SQLSTATE 21000
  // (cardinality violation) — same trigger as the JSON path, but
  // exercised through the streaming code path's separate catch block,
  // which writes a `{ type: "error" }` NDJSON line on a 200 response.
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

  // Streaming endpoint returns 200 once headers are flushed; failures
  // are reported as `{ type: "error" }` NDJSON lines in the body. Pin
  // both — a regression that turns the streaming error into an HTTP
  // 5xx is still worth catching, but the body check is what proves the
  // sanitizer is wired in.
  assert.equal(
    res.status,
    200,
    `expected /api/ingest/csv-stream to return 200 (errors are reported in-band), got ${res.status}`,
  );
  const body = await res.text();
  assertNoLeakage("/api/ingest/csv-stream", body);

  // Parse NDJSON and find the terminal `error` event.
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const events = lines.map((l, i) => {
    try {
      return JSON.parse(l) as { type?: string; error?: string };
    } catch (err) {
      throw new Error(
        `/api/ingest/csv-stream NDJSON line #${i + 1} did not parse: ` +
          `${(err as Error).message}; line: ${l}`,
      );
    }
  });
  const errorEvent = events.find((e) => e.type === "error");
  assert.ok(
    errorEvent,
    `/api/ingest/csv-stream did not emit an { type: "error" } NDJSON event. ` +
      `Events: ${events.map((e) => e.type).join(", ")}`,
  );
  assert.ok(
    typeof errorEvent.error === "string" && errorEvent.error.length > 0,
    `/api/ingest/csv-stream error event has no 'error' string: ${JSON.stringify(errorEvent)}`,
  );
  // The streaming route prefixes the sanitized message with
  // "CSV stream ingest failed:" — keep the prefix in the assertion so
  // a regression that drops it (or replaces it with a raw error
  // message) is caught.
  assert.ok(
    errorEvent.error.startsWith("CSV stream ingest failed:"),
    `/api/ingest/csv-stream error event is missing the documented prefix. ` +
      `Got: ${errorEvent.error}`,
  );
  assertSanitizedSummaryPresent(
    "/api/ingest/csv-stream",
    errorEvent.error,
  );
});
