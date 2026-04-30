/**
 * Integration test for entityUid threading through the collector runtime.
 *
 * `MarketSignalDraft.entityUid` is the canonical entity pointer that the
 * intelligence foundation uses to join signals about the same supplier
 * across collectors (BLS price index for steel, GLEIF row for the steel
 * mill, OpenSanctions hit on its parent, ...). Per-collector parser
 * tests already cover that drafts emit the right uid; this test pins
 * down the *runtime* contract that the value lands intact in:
 *
 *   - Postgres: `market_signals.metadata.entityUid` (mirror slot for
 *     existing Postgres-only join paths)
 *   - BigQuery: the first-class `entity_uid_nullable` column on the
 *     `market_signals` MERGE payload
 *
 * The test fails loudly if a future refactor renames or drops either
 * landing site (e.g. someone removes the metadata mirror, or stops
 * passing `entityUidNullable` into `mergeMarketSignals`). Negative case:
 * a draft *without* `entityUid` must NOT inject the key into Postgres
 * metadata and must produce `entity_uid_nullable: null` in the BQ
 * payload, so the absence path is also locked in.
 *
 * Strategy: rather than running against a real BigQuery dataset, the
 * test installs a fake BigQuery client via the
 * `__setBigQueryClientForTests` seam on `@workspace/intelligence/bq`.
 * The fake records every `query()` and `dataset(...).table(...).insert()`
 * call so we can assert on the exact payload the runtime emits. The
 * GCS landing path is similarly stubbed to keep the run hermetic.
 *
 * Prereqs (same as the other api-server integration tests):
 *   - `DATABASE_URL` is set and the schema has been pushed
 *     (`pnpm --filter @workspace/db run push`).
 */

// The intelligence config reads env vars lazily, so setting them before
// any module that touches `resolveIntelligenceConfig()` runs is enough.
// This MUST come before the runtime/intelligence imports below.
process.env["GCP_PROJECT_ID"] = "test-project";
process.env["GCS_RAW_BUCKET"] = "test-raw-bucket";
process.env["BQ_DATASET"] = "test_dataset";
// `resolveIntelligenceConfig` requires either GOOGLE_APPLICATION_CREDENTIALS
// or GOOGLE_CREDENTIALS_JSON to consider GCP "configured". Inline JSON is
// the cheaper option here — no file to materialise.
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
  type BigQueryClientLike,
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

const TEST_COLLECTOR_ID = `test-entityuid-${Date.now()}-${process.pid}`;

interface CapturedQuery {
  query: string;
  params?: Record<string, unknown>;
}

interface CapturedInsert {
  table: string;
  rows: unknown;
}

interface BqCapture {
  queries: CapturedQuery[];
  inserts: CapturedInsert[];
}

/**
 * Build a fake `BigQueryClientLike` whose `query()` and
 * `dataset(...).table(...).insert(...)` calls accumulate into a captured
 * list the test can later assert on. `exists()` returns true so the
 * runtime never attempts a `create()`. The fake intentionally returns
 * empty result rows from `query()` because `mergeMarketSignals` doesn't
 * read the response — it only relies on the side effect of the MERGE.
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
        table(tableId: string) {
          return {
            async exists() {
              return [true] as [boolean];
            },
            async create() {
              return undefined;
            },
            async insert(rows: unknown) {
              capture.inserts.push({ table: tableId, rows });
              return undefined;
            },
          };
        },
      };
    },
    async query(opts) {
      capture.queries.push({ query: opts.query, params: opts.params });
      return [[]];
    },
  };
}

/**
 * Minimal in-memory GCS fake — `landRawPayload` only needs `file().save()`
 * to resolve so the runtime records a non-null pointer. We don't assert
 * on the GCS side here, but the stub keeps the test hermetic (no real
 * network calls, no spurious warning logs in the suite output).
 */
function makeFakeStorage() {
  return {
    bucket(_name: string) {
      return {
        file(_path: string) {
          return {
            async save() {
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
    name: "Test EntityUid Collector",
    description: "Throw-away collector for entityUid runtime test.",
    posture: "public-api",
    sourceUrl: "https://example.test/entityuid",
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

test("runCollector lands draft.entityUid in Postgres metadata and the BigQuery MERGE payload", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const ENTITY_UID = "eu_test_acme_corp_v1";
  const observedAtWith = new Date("2026-03-01T00:00:00Z");
  const observedAtWithout = new Date("2026-03-02T00:00:00Z");

  // Two drafts: one carries a resolved entityUid (the supplier we
  // already matched against), the other intentionally omits it (a
  // signal we couldn't resolve to a canonical entity). Both must round-
  // trip correctly: the resolved draft populates the column / metadata
  // slot, the unresolved one leaves both untouched.
  const draftsRef: { current: MarketSignalDraft[] } = {
    current: [
      {
        signalType: "commodity_index",
        scopeSupplierName: "Acme Corp",
        value: 123.45,
        unit: "USD/tonne",
        currency: "USD",
        observedAt: observedAtWith,
        sourceUrl: "https://example.test/with-uid",
        confidence: 0.9,
        metadata: { note: "with-entity-uid" },
        entityUid: ENTITY_UID,
      },
      {
        signalType: "commodity_index",
        scopeSupplierName: "Unknown Supplier",
        value: 50.5,
        unit: "USD/tonne",
        currency: "USD",
        observedAt: observedAtWithout,
        sourceUrl: "https://example.test/no-uid",
        confidence: 0.5,
        metadata: { note: "no-entity-uid" },
        // Deliberately omit entityUid.
      },
    ],
  };

  const bqCapture: BqCapture = { queries: [], inserts: [] };
  __setBigQueryClientForTests(makeFakeBigQuery(bqCapture));
  __setStorageClientForTests(makeFakeStorage());

  registerCollector(makeCollector(draftsRef));
  await upsertCollectorRegistration({
    id: TEST_COLLECTOR_ID,
    name: "Test EntityUid Collector",
    description: "Throw-away collector for entityUid runtime test.",
    posture: "public-api",
    owner: "tests",
    sourceUrl: "https://example.test/entityuid",
    rateLimitRpm: 60,
    scheduleCron: null,
    notes: null,
    actor: "tests",
  });
  await approveCollector(TEST_COLLECTOR_ID, "tests");

  t.after(async () => {
    try {
      await deleteTestData();
      // Same belt-and-braces cleanup as the dedup test: mark the row
      // rejected so it doesn't pollute the operator UI even if the
      // delete somehow failed.
      await disableCollector(TEST_COLLECTOR_ID, "tests", "rejected");
    } catch (err) {
      console.error("[cleanup] entityUid test cleanup failed:", err);
    }
    __setBigQueryClientForTests(null);
    __setStorageClientForTests(null);
    await pool.end().catch(() => {});
  });

  await deleteTestData();

  const result = await runCollector(TEST_COLLECTOR_ID);
  assert.equal(result.signalsCollected, 2, "both drafts inserted in Postgres");

  // ---------------------------------------------------------------
  // Postgres assertions
  // ---------------------------------------------------------------
  const pgRows = await db
    .select()
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, TEST_COLLECTOR_ID));
  assert.equal(pgRows.length, 2);

  const pgWith = pgRows.find(
    (r) => r.observedAt.getTime() === observedAtWith.getTime(),
  );
  const pgWithout = pgRows.find(
    (r) => r.observedAt.getTime() === observedAtWithout.getTime(),
  );
  assert.ok(pgWith, "PG row for the entityUid-bearing draft exists");
  assert.ok(pgWithout, "PG row for the no-entityUid draft exists");

  const withMd = pgWith!.metadata as Record<string, unknown>;
  assert.equal(
    withMd["entityUid"],
    ENTITY_UID,
    "Postgres metadata.entityUid mirrors the draft's entityUid",
  );
  assert.equal(
    withMd["note"],
    "with-entity-uid",
    "draft-supplied metadata is preserved alongside the entityUid mirror",
  );

  const withoutMd = pgWithout!.metadata as Record<string, unknown>;
  assert.equal(
    "entityUid" in withoutMd,
    false,
    "drafts without entityUid must NOT inject the key into PG metadata",
  );
  assert.equal(
    withoutMd["note"],
    "no-entity-uid",
    "original metadata for the unresolved draft is preserved verbatim",
  );

  // ---------------------------------------------------------------
  // BigQuery assertions
  // ---------------------------------------------------------------
  // The runtime issues two parameterised statements per merge:
  //   1) UPDATE ... SET system_to = ... WHERE value != ...   (the
  //      bitemporal "close" pass for stale rows)
  //   2) INSERT INTO ... market_signals ... SELECT ... FROM UNNEST(@rows)
  //
  // Both statements receive the *same* `@rows` payload — the parsed
  // BqMarketSignalRow batch — so we just inspect the first statement
  // that carries it. Asserting on the rows array (rather than on the
  // raw SQL text) keeps the test resilient to harmless query-text
  // tweaks but tight on the field contract.
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

  const bqWith = rowsPayload.find(
    (r) => r["observed_at"] === observedAtWith.toISOString(),
  );
  const bqWithout = rowsPayload.find(
    (r) => r["observed_at"] === observedAtWithout.toISOString(),
  );
  assert.ok(bqWith, "BQ payload contains the entityUid-bearing row");
  assert.ok(bqWithout, "BQ payload contains the no-entityUid row");

  // The contract this test exists to lock in:
  assert.equal(
    bqWith!["entity_uid_nullable"],
    ENTITY_UID,
    "BQ payload propagates draft.entityUid into entity_uid_nullable",
  );
  assert.equal(
    bqWithout!["entity_uid_nullable"],
    null,
    "BQ payload sends null entity_uid_nullable when the draft omits entityUid",
  );

  // Sanity-check sibling fields so we'd notice if the BQ row shape
  // drifted in a way that "looked right" for entityUid but broke other
  // semantically-important columns.
  assert.equal(bqWith!["scope_supplier_name"], "Acme Corp");
  assert.equal(bqWith!["collector_id"], TEST_COLLECTOR_ID);
  assert.equal(bqWith!["signal_type"], "commodity_index");
  assert.equal(typeof bqWith!["stable_signal_key"], "string");
});
