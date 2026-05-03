/**
 * Integration test for the raw_payload_pointer round trip through the
 * collector runtime.
 *
 * Why this exists: a market_signals BigQuery row only has one link
 * back to the upstream bytes the parser ran on — the
 * `raw_payload_pointer` `gs://...` URL. Replay tooling, parser-fix
 * back-tests, and incident forensics all start from that pointer. If
 * the runtime stops landing the raw payload, stops threading the
 * resulting pointer into the BQ MERGE, or starts emitting a stale /
 * empty pointer, every BQ row from that point on becomes orphaned —
 * and today nothing in the test suite would notice.
 *
 * The sibling entityUid test (`intelligence-runtime-entity-uid.test.ts`)
 * pinned down the entity-uid contract using fake BigQuery + GCS
 * clients via `__setBigQueryClientForTests` /
 * `__setStorageClientForTests`. This test reuses the same seams to
 * pin down the raw-payload-pointer contract:
 *
 *   - the runtime calls GCS `bucket(<configured>).file(<path>).save()`
 *     exactly once for the synthesized parsed-drafts snapshot,
 *   - that path follows the canonical
 *     `<collectorId>/<YYYY>/<MM>/<DD>/<runId>.json` shape,
 *   - the BigQuery MERGE payload's `raw_payload_pointer` equals
 *     `gs://<configured-bucket>/<that exact path>` for every row in
 *     the batch (so all rows from the same run point at the same
 *     blob — a runtime that emitted a stale pointer from a prior
 *     run, or `null`, or only on some rows would fail loudly here).
 *
 * Strategy mirrors the entityUid test: hermetic fakes for both GCS
 * and BigQuery, no real network. Postgres is real (matches the rest
 * of the api-server integration tests).
 *
 * Prereqs:
 *   - `DATABASE_URL` is set and the schema has been pushed
 *     (`pnpm --filter @workspace/db run push`).
 */

// The intelligence config reads env vars lazily, so setting them before
// any module that calls `resolveIntelligenceConfig()` runs is enough.
// MUST come before the runtime/intelligence imports below.
process.env["GCP_PROJECT_ID"] = "test-project";
process.env["GCS_RAW_BUCKET"] = "test-raw-bucket";
process.env["BQ_DATASET"] = "test_dataset";
process.env["GOOGLE_CREDENTIALS_JSON"] = JSON.stringify({
  type: "service_account",
  project_id: "test-project",
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  marketSignalsTable,
  collectorAuditLogTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  __setBigQueryClientForTests,
  __setRecordCollectorRunOverrideForTests,
  type BigQueryClientLike,
  type CollectorRunRecord,
} from "@workspace/intelligence/bq";
import { __setStorageClientForTests } from "@workspace/intelligence/gcs";
import {
  registerCollector,
  runCollector,
  upsertCollectorRegistration,
  approveCollector,
  disableCollector,
} from "../src/lib/intelligence/runtime";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../src/lib/intelligence/collector";
import {
  defaultStableSignalKey,
  looseSignalDraftSchema,
} from "../src/lib/intelligence/contractHelpers";

const TEST_COLLECTOR_ID = `test-rawptr-${Date.now()}-${process.pid}`;
const BUCKET = "test-raw-bucket";

interface CapturedSave {
  bucket: string;
  path: string;
  contentType: string | undefined;
  body: Buffer;
}

interface CapturedQuery {
  query: string;
  params?: Record<string, unknown>;
}

interface BqCapture {
  queries: CapturedQuery[];
}

/**
 * Fake `BigQueryClientLike` that records every parameterised `query()`
 * call. We don't care about the SQL text in this test — only about the
 * `@rows` payload, which is the structured BQ row batch the runtime
 * threads `raw_payload_pointer` into.
 */
function makeFakeBigQuery(capture: BqCapture): BigQueryClientLike {
  return {
    dataset(_id: string) {
      return {
        async exists() {
          return [true] as [boolean];
        },
        async create() {
          return undefined;
        },
        table(_tableId: string) {
          return {
            async exists() {
              return [true] as [boolean];
            },
            async create() {
              return undefined;
            },
            async insert(_rows: unknown) {
              return undefined;
            },
          };
        },
      };
    },
    async query(opts: {
      query: string;
      params?: Record<string, unknown>;
    }) {
      capture.queries.push({ query: opts.query, params: opts.params });
      return [[]];
    },
  };
}

/**
 * Fake GCS client that records every `bucket(...).file(...).save(...)`
 * call. Test asserts on the bucket name, object path, and content
 * type — these together prove the runtime built the canonical
 * `gs://<bucket>/<collector>/<YYYY/MM/DD>/<runId>.<ext>` location
 * that the BQ pointer must match.
 */
function makeFakeStorage(saves: CapturedSave[]) {
  return {
    bucket(bucketName: string) {
      return {
        file(filePath: string) {
          return {
            async save(
              data: Buffer | string,
              opts?: { contentType?: string; resumable?: boolean },
            ) {
              const body =
                typeof data === "string" ? Buffer.from(data) : data;
              saves.push({
                bucket: bucketName,
                path: filePath,
                contentType: opts?.contentType,
                body,
              });
              return undefined;
            },
            async download() {
              return [Buffer.from("")] as [Buffer];
            },
            async getMetadata() {
              return [{}] as [Record<string, unknown>];
            },
          };
        },
        async getFiles() {
          return [[]] as [
            Array<{ name: string; metadata: Record<string, unknown> }>,
          ];
        },
      };
    },
  };
}

function makeCollector(
  draftsRef: { current: MarketSignalDraft[] },
): IntelligenceCollector {
  return {
    id: TEST_COLLECTOR_ID,
    name: "Test RawPayloadPointer Collector",
    description:
      "Throw-away collector for the raw_payload_pointer runtime test.",
    posture: "public-api",
    sourceUrl: "https://example.test/raw-payload-pointer",
    defaultRateLimitRpm: 60,
    defaultScheduleCron: null,
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "US",
    retentionDays: 365,
    tenantOptInDefault: true,
    signalSchema: looseSignalDraftSchema,
    stableSignalKey(d) {
      return defaultStableSignalKey(TEST_COLLECTOR_ID, d);
    },
    async collect() {
      // Fresh copy each call so test mutations don't leak through
      // object identity.
      return draftsRef.current.map((d) => ({ ...d }));
    },
  };
}

async function deleteTestData(): Promise<void> {
  await db
    .delete(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, TEST_COLLECTOR_ID));
  await db
    .delete(collectorAuditLogTable)
    .where(eq(collectorAuditLogTable.collectorId, TEST_COLLECTOR_ID));
}

test("runCollector lands raw payload to GCS and threads its gs:// pointer into the BQ MERGE payload", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Two drafts so we can also assert that the runtime emits the
  // *same* pointer for every row of a single run — they all share
  // one upstream blob, so a divergent / partially-null pointer set
  // would mean the threading logic is broken.
  const draftsRef: { current: MarketSignalDraft[] } = {
    current: [
      {
        signalType: "commodity_index",
        scopeSupplierName: "Acme Corp",
        value: 100.0,
        unit: "USD/tonne",
        currency: "USD",
        observedAt: new Date("2026-04-10T00:00:00Z"),
        sourceUrl: "https://example.test/raw-pointer/a",
        confidence: 0.9,
        metadata: { note: "row-a" },
      },
      {
        signalType: "commodity_index",
        scopeSupplierName: "Beta Industries",
        value: 200.0,
        unit: "USD/tonne",
        currency: "USD",
        observedAt: new Date("2026-04-11T00:00:00Z"),
        sourceUrl: "https://example.test/raw-pointer/b",
        confidence: 0.9,
        metadata: { note: "row-b" },
      },
    ],
  };

  const saves: CapturedSave[] = [];
  const bqCapture: BqCapture = { queries: [] };
  // Capture every `recordCollectorRun` call the runtime makes for this
  // run. The runtime is supposed to thread the *same* gs:// pointer it
  // used in the per-row MERGE into the per-run audit row, so operators
  // investigating a run can jump straight to the upstream bytes from
  // `collector_runs.raw_payload_pointer`. A regression that drops or
  // changes that pointer would silently orphan the audit trail; this
  // test fails loudly if it happens.
  const recordedRuns: CollectorRunRecord[] = [];
  __setBigQueryClientForTests(makeFakeBigQuery(bqCapture));
  __setStorageClientForTests(makeFakeStorage(saves));
  __setRecordCollectorRunOverrideForTests(async (run) => {
    recordedRuns.push(run);
    return true;
  });

  registerCollector(makeCollector(draftsRef));
  await upsertCollectorRegistration({
    id: TEST_COLLECTOR_ID,
    name: "Test RawPayloadPointer Collector",
    description:
      "Throw-away collector for the raw_payload_pointer runtime test.",
    posture: "public-api",
    owner: "tests",
    sourceUrl: "https://example.test/raw-payload-pointer",
    rateLimitRpm: 60,
    scheduleCron: null,
    notes: null,
    actor: "tests",
  });
  await approveCollector(TEST_COLLECTOR_ID, "tests");

  t.after(async () => {
    try {
      await deleteTestData();
      // Belt-and-braces: mark the collector rejected so a stray DB
      // row doesn't pollute the operator UI even if the delete above
      // failed for some reason.
      await disableCollector(TEST_COLLECTOR_ID, "tests", "rejected");
    } catch (err) {
      console.error("[cleanup] raw-payload-pointer test cleanup failed:", err);
    }
    __setBigQueryClientForTests(null);
    __setStorageClientForTests(null);
    __setRecordCollectorRunOverrideForTests(null);
    await pool.end().catch(() => {});
  });

  await deleteTestData();

  const result = await runCollector(TEST_COLLECTOR_ID);
  assert.equal(
    result.signalsCollected,
    2,
    "both drafts inserted in Postgres",
  );

  // ---------------------------------------------------------------
  // GCS landing assertions
  // ---------------------------------------------------------------
  // The collector under test does not implement collectWithRaw, so
  // the runtime synthesizes a single parsed-drafts snapshot per run.
  // Exactly one save call must have occurred, against the configured
  // bucket, with a path matching the canonical
  // `<collector>/<YYYY>/<MM>/<DD>/<runId>.json` shape.
  assert.equal(
    saves.length,
    1,
    "runtime landed exactly one synthesized raw payload to GCS for this run",
  );
  const save = saves[0]!;
  assert.equal(
    save.bucket,
    BUCKET,
    "raw payload landed in the configured GCS bucket",
  );
  assert.ok(
    save.body.length > 0,
    "raw payload body is not empty (runtime serialized parsed drafts)",
  );
  assert.equal(
    save.contentType,
    "application/json",
    "synthesized parsed-drafts snapshot is written as JSON",
  );

  // Path shape: <safeCollectorId>/<YYYY>/<MM>/<DD>/<runId>.json
  // The collector id is already URL-safe, but rawPayloadPath only
  // permits [a-z0-9_-] so we match against that character set
  // explicitly to catch a future regression that lets unsafe
  // characters through (which would change the gs:// URL the
  // BigQuery row points at).
  const pathPattern = new RegExp(
    `^${TEST_COLLECTOR_ID.replace(/[^a-z0-9_-]/gi, "_")}/\\d{4}/\\d{2}/\\d{2}/[A-Za-z0-9_-]+\\.json$`,
  );
  assert.match(
    save.path,
    pathPattern,
    `GCS object path "${save.path}" does not match the canonical <collector>/<YYYY>/<MM>/<DD>/<runId>.json shape`,
  );

  const expectedPointer = `gs://${BUCKET}/${save.path}`;

  // ---------------------------------------------------------------
  // BigQuery assertions — the contract this test exists to lock in.
  // ---------------------------------------------------------------
  // mergeMarketSignals issues two parameterised statements that both
  // carry the same `@rows` payload. We just inspect the first one;
  // it's the structured row batch the runtime built.
  const mergeQueries = bqCapture.queries.filter((q) =>
    Array.isArray(q.params?.["rows"]),
  );
  assert.ok(
    mergeQueries.length >= 1,
    "runtime issued at least one parameterised MERGE-style query against BQ",
  );
  const rowsPayload = mergeQueries[0]!.params!["rows"] as Array<
    Record<string, unknown>
  >;
  assert.equal(
    rowsPayload.length,
    2,
    "BQ payload carries one row per draft passed to the runtime",
  );

  // Every row must carry the exact same gs:// pointer that the
  // runtime just landed, on this run, in the configured bucket.
  // A null, empty, or stale-from-prior-run pointer would fail here.
  for (const row of rowsPayload) {
    assert.equal(
      row["raw_payload_pointer"],
      expectedPointer,
      `BQ row.raw_payload_pointer must equal "${expectedPointer}" (got ${JSON.stringify(row["raw_payload_pointer"])}); this is the only link from a market_signals row back to the upstream bytes`,
    );
    // Sanity guard: catches a future refactor that switches the
    // pointer to an empty string or a placeholder like "TODO".
    assert.equal(
      typeof row["raw_payload_pointer"],
      "string",
      "raw_payload_pointer must be a string",
    );
    assert.ok(
      String(row["raw_payload_pointer"]).startsWith(`gs://${BUCKET}/`),
      "raw_payload_pointer must be a fully-qualified gs:// URL in the configured bucket",
    );
  }

  // Sibling-field sanity: if the row shape drifted in a way that
  // "looked right" for raw_payload_pointer but broke the rest of
  // the contract, this would catch it.
  const bqRowA = rowsPayload.find((r) => r["scope_supplier_name"] === "Acme Corp");
  const bqRowB = rowsPayload.find(
    (r) => r["scope_supplier_name"] === "Beta Industries",
  );
  assert.ok(bqRowA, "BQ payload contains the Acme Corp row");
  assert.ok(bqRowB, "BQ payload contains the Beta Industries row");
  assert.equal(bqRowA!["source_run_id"], bqRowB!["source_run_id"]);
  assert.equal(bqRowA!["collector_id"], TEST_COLLECTOR_ID);

  // ---------------------------------------------------------------
  // collector_runs audit-log assertions — the second half of the
  // raw_payload_pointer contract.
  // ---------------------------------------------------------------
  // Operators investigating "did this run actually land its payload?"
  // query the `collector_runs` table, not the per-row `market_signals`
  // batch. The runtime is supposed to thread the *same* gs:// pointer
  // it stamped on every signal row into `recordCollectorRun(...)`. A
  // refactor that stops passing it (or passes a different / empty
  // value) would silently orphan the audit trail — the per-signal
  // MERGE would still look right, but `collector_runs` would no
  // longer point at the bytes the run actually parsed.
  assert.equal(
    recordedRuns.length,
    1,
    "runtime called recordCollectorRun exactly once for the run",
  );
  const recordedRun = recordedRuns[0]!;
  assert.equal(
    recordedRun.collectorId,
    TEST_COLLECTOR_ID,
    "audit row is attributed to the collector under test",
  );
  assert.equal(
    recordedRun.runId,
    bqRowA!["source_run_id"],
    "audit row's runId matches the source_run_id stamped on every market_signals row — same physical run",
  );
  assert.equal(
    recordedRun.status,
    "succeeded",
    "audit row marks the run as succeeded",
  );
  assert.equal(
    recordedRun.rawPayloadPointer,
    expectedPointer,
    `collector_runs.raw_payload_pointer must equal "${expectedPointer}" (got ${JSON.stringify(recordedRun.rawPayloadPointer)}); this is the per-run audit pointer operators rely on to reach the upstream bytes`,
  );
  // Sibling-field guard: catches a regression that swaps the per-run
  // pointer for an empty string, "TODO", or a placeholder that
  // happens to type-check as `string`.
  assert.equal(
    typeof recordedRun.rawPayloadPointer,
    "string",
    "collector_runs.raw_payload_pointer must be a string, not null/undefined",
  );
  assert.ok(
    String(recordedRun.rawPayloadPointer).startsWith(`gs://${BUCKET}/`),
    "collector_runs.raw_payload_pointer must be a fully-qualified gs:// URL in the configured bucket",
  );
  // The per-row pointer (in the BQ MERGE payload) and the per-run
  // pointer (in the audit row) must be identical references to the
  // same blob. A divergence here means the runtime is computing the
  // pointer twice with different inputs — exactly the silent-orphan
  // scenario this test exists to prevent.
  assert.equal(
    recordedRun.rawPayloadPointer,
    rowsPayload[0]!["raw_payload_pointer"],
    "per-run audit pointer and per-signal MERGE pointer must reference the same blob",
  );
});
