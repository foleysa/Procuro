/**
 * Regression test for Task #182: when a streaming CSV upload trips a
 * Postgres SQLSTATE 23505 unique-violation against an *existing* DB
 * row mid-batch, the NDJSON `error` event must carry both:
 *
 *   - `rowNumber`  — 1-based CSV data row index (header excluded)
 *   - `conflictKey` — column → value pairs parsed from PG `detail`
 *
 * The human-readable `error` string must additionally call out the row
 * and the offending key inline so the operator can find the bad row
 * in their editor without parsing the structured payload.
 *
 * Trigger
 * -------
 * The `items` table enforces TWO unique indexes:
 *   - `items_source_uq(orgId, sourceSystem, sourceExternalId)` — the
 *     streaming upsert's `ON CONFLICT` target.
 *   - `items_org_sku_uq(orgId, sku)` — NOT in the conflict target.
 *
 * We pre-seed an item with `(sku=SKU-X, externalId=E-1)`. The CSV
 * uploads a row with `sku=SKU-X` but a fresh `externalId=E-2` — the
 * insert falls through the `(sourceSystem, sourceExternalId)`
 * conflict target (no match → INSERT proceeds) and then trips
 * `items_org_sku_uq` → SQLSTATE 23505. Without Task #182 this
 * collapsed to the sanitized headline `Database error 23505 on table
 * "items", constraint "items_org_sku_uq"` with no pointer back into
 * the upload.
 *
 * Prereqs
 * -------
 * - `DATABASE_URL` is set and the schema has been pushed (see
 *   `lib/db`).
 * - At least one row exists in `orgs` (the test will use the first
 *   one). This mirrors `csv-ingest-error-sanitization.test.ts`.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { db, orgsTable, itemsTable, pool } from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import app from "../src/app";

const TEST_RUN_ID = `task182-${Date.now()}-${process.pid}`;
const SKU_PREFIX = `${TEST_RUN_ID}-SKU-`;
const EXT_PREFIX = `${TEST_RUN_ID}-E-`;

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
      "No org rows found. Seed the database (pnpm --filter @workspace/scripts run seed) first.",
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
  // Delete by SKU prefix to catch both the pre-seeded row and any
  // partially-inserted CSV rows from a flaky run.
  await db
    .delete(itemsTable)
    .where(
      and(
        eq(itemsTable.orgId, orgId),
        like(itemsTable.sku, `${SKU_PREFIX}%`),
      ),
    );
  await db
    .delete(itemsTable)
    .where(
      and(
        eq(itemsTable.orgId, orgId),
        like(itemsTable.sourceExternalId, `${EXT_PREFIX}%`),
      ),
    );
}

test("POST /api/ingest/csv-stream surfaces rowNumber + conflictKey on a 23505 collision with an existing row", async () => {
  const collidingSku = `${SKU_PREFIX}A`;
  const seededExternalId = `${EXT_PREFIX}seed`;
  const newExternalId = `${EXT_PREFIX}upload`;

  // Pre-seed an existing item that owns the SKU. Uploading a CSV row
  // with the same SKU but a different externalId will trip
  // `items_org_sku_uq` (23505) — the upsert's conflict target is
  // `(orgId, sourceSystem, sourceExternalId)` so the new externalId
  // misses the target and the INSERT runs into the second unique
  // index on `(orgId, sku)`.
  await db.insert(itemsTable).values({
    id: `itm_${TEST_RUN_ID}_seed`,
    orgId,
    sku: collidingSku,
    description: "Pre-seeded item",
    normalizedKey: collidingSku.toUpperCase(),
    sourceSystem: "csv",
    sourceExternalId: seededExternalId,
  });

  // CSV: header on line 1, the bad row is the FIRST data row →
  // rowNumber=1, line=2.
  const csvBody =
    "externalId,sku,description\n" +
    `${newExternalId},${collidingSku},Uploaded item\n`;

  const res = await fetch(
    `${baseUrl}/api/ingest/csv-stream?entity=items`,
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
    `expected /api/ingest/csv-stream to return 200 (errors are reported in-band), got ${res.status}`,
  );
  const body = await res.text();

  // Parse NDJSON and find the terminal `error` event.
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const events = lines.map((l, i) => {
    try {
      return JSON.parse(l) as {
        type?: string;
        error?: string;
        rowNumber?: number | null;
        conflictKey?: Record<string, string>;
        constraint?: string | null;
      };
    } catch (err) {
      throw new Error(
        `NDJSON line #${i + 1} did not parse: ${(err as Error).message}; line: ${l}`,
      );
    }
  });
  const errorEvent = events.find((e) => e.type === "error");
  assert.ok(
    errorEvent,
    `expected an { type: "error" } NDJSON event. ` +
      `Events: ${events.map((e) => e.type).join(", ")}`,
  );

  // The streaming route must NOT fall back to the sanitized
  // "Database error 23505" headline that operators saw before
  // Task #182 — they need a row pointer + the colliding key.
  assert.ok(
    typeof errorEvent.error === "string" &&
      !errorEvent.error.includes("Database error 23505"),
    `error event regressed to the sanitized DB-error fallback ` +
      `instead of surfacing the structured collision payload. ` +
      `Got: ${errorEvent.error}`,
  );

  // Row pointer: 1-based, header excluded. The single data row in
  // the CSV is row 1, line 2.
  assert.equal(
    errorEvent.rowNumber,
    1,
    `error event has wrong rowNumber: ${JSON.stringify(errorEvent)}`,
  );

  // Conflict key: structured map keyed by camelCase column name. PG
  // reports `(org_id, source_system, source_external_id)` for
  // `items_org_sku_uq`? No — that index is on `(org_id, sku)`. The
  // adapter snake→camels both columns to `orgId` and `sku`.
  assert.ok(
    errorEvent.conflictKey && typeof errorEvent.conflictKey === "object",
    `error event missing conflictKey object: ${JSON.stringify(errorEvent)}`,
  );
  assert.equal(
    errorEvent.conflictKey!["sku"],
    collidingSku,
    `expected conflictKey.sku to echo the colliding SKU back to the uploader. ` +
      `Got: ${JSON.stringify(errorEvent.conflictKey)}`,
  );
  assert.equal(
    errorEvent.conflictKey!["orgId"],
    orgId,
    `expected conflictKey.orgId to be the tenant's orgId. ` +
      `Got: ${JSON.stringify(errorEvent.conflictKey)}`,
  );

  // The constraint name is a stable identifier — surface it so
  // operators / on-call can grep logs.
  assert.equal(
    errorEvent.constraint,
    "items_org_sku_uq",
    `expected error event to name the violated constraint. ` +
      `Got: ${JSON.stringify(errorEvent)}`,
  );

  // Human-readable message must inline the row pointer + the offending
  // key=value pair so the operator can act without parsing the
  // structured payload.
  assert.ok(
    errorEvent.error!.includes("Row 1"),
    `expected error message to include "Row 1". Got: ${errorEvent.error}`,
  );
  assert.ok(
    errorEvent.error!.includes("line 2"),
    `expected error message to include "line 2" (header is line 1). Got: ${errorEvent.error}`,
  );
  assert.ok(
    errorEvent.error!.includes(`sku=${collidingSku}`),
    `expected error message to inline the colliding sku=${collidingSku}. ` +
      `Got: ${errorEvent.error}`,
  );
  assert.ok(
    errorEvent.error!.startsWith("CSV stream ingest failed:"),
    `expected the documented streaming-route prefix. Got: ${errorEvent.error}`,
  );
});
