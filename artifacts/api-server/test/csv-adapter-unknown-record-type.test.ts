/**
 * Task #93 — partial-success outcome for CSV ingest jobs that contain
 * an unknown top-level record type.
 *
 * Background
 * ----------
 * Before this change, `writeIngestPayload` (called by `csvSourceAdapter`
 * and the production `ingest_csv` job handler) silently dropped any
 * top-level key that wasn't a known entity (suppliers, categories,
 * items, contracts, …), and the streaming-CSV `flushBatch` default
 * branch threw `StructuralIngestError` on an unknown entity name —
 * which the worker promotes to `UnrecoverableJobError` and fails the
 * job with no rows ingested. Both paths forced the operator to clean
 * the upload before any data could land.
 *
 * Contract this test pins
 * -----------------------
 *   1. A CSV/JSON payload that mixes a valid entity (suppliers) with
 *      an unknown record kind (e.g. `frobnicators`) returns a
 *      successful `SyncResult`.
 *   2. The known-entity rows are inserted into the database
 *      (recordsCreated >= 1, supplier row present).
 *   3. Each unknown-key row produces an `IngestWarning` in the result
 *      with `code: "unknown_record_type"`, a `field` locator, and
 *      (when present on the row) the row's `externalId`.
 *   4. `recordsSkipped` matches the number of unknown-key entries.
 *   5. The handler-level result returned by `ingestCsvHandler`
 *      (i.e. what lands in `jobs.result_json` and is rendered on the
 *      System page job detail panel) carries the same warnings/skipped
 *      fields verbatim.
 *
 * Trigger
 * -------
 * The structured-payload path. We invoke `ingestCsvHandler` directly
 * with a synthetic `JobRow` so the test exercises the same code path
 * as a real `ingest_csv` job without round-tripping through the queue.
 *
 * Prereq: `DATABASE_URL` is set and the schema has been pushed
 * (`pnpm --filter @workspace/db run push`). At least one row in `orgs`.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import {
  db,
  orgsTable,
  suppliersTable,
  pool,
  type JobRow,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";

import { ingestCsvHandler } from "../src/lib/jobs/handlers";
import type { IngestWarning } from "../src/lib/adapters/source-adapter";

const TEST_RUN_ID = `task93-${Date.now()}-${process.pid}`;
const SUPPLIER_EXT_PREFIX = `${TEST_RUN_ID}-sup-`;

let orgId: string;

before(async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) {
    throw new Error(
      "No org rows found. Seed the database before running this test.",
    );
  }
  orgId = row.id;
  await cleanup();
});

after(async () => {
  try {
    await cleanup();
  } catch (err) {
    console.error("[cleanup] failed:", err);
  }
  await pool.end().catch(() => {});
});

async function cleanup(): Promise<void> {
  await db
    .delete(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, "csv"),
        like(suppliersTable.sourceExternalId, `${SUPPLIER_EXT_PREFIX}%`),
      ),
    );
}

/**
 * Build the minimal `JobRow` shape the handler reads. The handler only
 * touches `id`, `orgId`, and `payload`, so the rest are filler that
 * matches the column types — no row is actually written to the `jobs`
 * table for this test.
 */
function buildJobRow(payload: Record<string, unknown>): JobRow {
  return {
    id: `job_test_${TEST_RUN_ID}`,
    orgId,
    kind: "ingest_csv",
    payload,
    status: "running",
    attempts: 1,
    maxAttempts: 1,
    error: null,
    result: null,
    runAt: new Date(),
    scheduledFor: null,
    startedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    cancelRequested: false,
    progress: null,
  } as unknown as JobRow;
}

test("ingest_csv with unknown top-level record types returns a partial-success result", async () => {
  const supplierExt = `${SUPPLIER_EXT_PREFIX}A`;
  const supplierName = `Acme #93 ${TEST_RUN_ID}`;

  // Payload mixes a valid `suppliers` entry (which must land in the
  // DB) with two unknown record kinds: `frobnicators` (an array, two
  // entries — should produce two warnings) and `widgets` (a non-array
  // value — should produce one warning, one skipped row).
  const payload = {
    csv: {
      suppliers: [
        {
          externalId: supplierExt,
          name: supplierName,
          countryCode: "US",
        },
      ],
      // Unknown record types — the writer must not throw, must skip,
      // and must report each row as an IngestWarning.
      frobnicators: [
        { externalId: "frob-1", widgetCount: 7 },
        { externalId: "frob-2", widgetCount: 11 },
      ],
      widgets: { externalId: "widget-1", weight: 42 },
    },
  };

  const job = buildJobRow(payload);

  // Invoke the production handler directly. Returns the raw
  // `Record<string, unknown>` shape that the queue persists into
  // `jobs.result_json`.
  const result = (await ingestCsvHandler(job)) as Record<string, unknown>;

  // 1. Suppliers landed in the DB.
  const [supRow] = await db
    .select({
      name: suppliersTable.name,
      ext: suppliersTable.sourceExternalId,
    })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.orgId, orgId),
        eq(suppliersTable.sourceSystem, "csv"),
        eq(suppliersTable.sourceExternalId, supplierExt),
      ),
    );
  assert.ok(
    supRow,
    `expected supplier with externalId=${supplierExt} to be inserted ` +
      `despite the payload containing unknown record types`,
  );
  assert.equal(supRow!.name, supplierName);

  // 2. recordsCreated covers the supplier; recordsSkipped covers the
  //    three unknown-key rows (2 from frobnicators + 1 from widgets).
  assert.ok(
    typeof result["recordsCreated"] === "number" &&
      (result["recordsCreated"] as number) >= 1,
    `recordsCreated should be >= 1 (supplier), got ${JSON.stringify(result["recordsCreated"])}`,
  );
  assert.equal(
    result["recordsSkipped"],
    3,
    `recordsSkipped should equal the 3 unknown-key entries; got ${JSON.stringify(result["recordsSkipped"])}`,
  );

  // 3. Warnings array carries one entry per skipped row.
  const warnings = result["warnings"];
  assert.ok(
    Array.isArray(warnings),
    `result.warnings should be an array; got ${JSON.stringify(warnings)}`,
  );
  const warningArr = warnings as IngestWarning[];
  assert.equal(
    warningArr.length,
    3,
    `expected 3 warnings (2 frobnicators + 1 widget), got ${warningArr.length}: ${JSON.stringify(warningArr)}`,
  );
  for (const w of warningArr) {
    assert.equal(
      w.code,
      "unknown_record_type",
      `warning.code should be 'unknown_record_type'; got ${w.code}`,
    );
    assert.ok(
      typeof w.reason === "string" && w.reason.length > 0,
      `warning.reason should be a non-empty string; got ${JSON.stringify(w.reason)}`,
    );
  }

  // The two array entries should carry indexed field locators and
  // their externalIds.
  const frobWarnings = warningArr
    .filter((w) => (w.field ?? "").startsWith("frobnicators"))
    .sort((a, b) => (a.field ?? "").localeCompare(b.field ?? ""));
  assert.equal(frobWarnings.length, 2);
  assert.equal(frobWarnings[0]!.field, "frobnicators[0]");
  assert.equal(frobWarnings[0]!.externalId, "frob-1");
  assert.equal(frobWarnings[1]!.field, "frobnicators[1]");
  assert.equal(frobWarnings[1]!.externalId, "frob-2");

  // The non-array unknown key collapses to one warning at the key
  // level (no `[i]` index) and has no `externalId` since the value
  // wasn't an array of rows.
  const widgetWarning = warningArr.find((w) => w.field === "widgets");
  assert.ok(widgetWarning, "expected one warning for the unknown 'widgets' key");
});
