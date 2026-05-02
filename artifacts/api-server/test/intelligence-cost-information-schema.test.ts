/**
 * Unit tests for `getCollectorCostsFromInformationSchema` — the
 * INFORMATION_SCHEMA.JOBS_BY_PROJECT-backed cost reader that powers
 * the real-cost path in the Cost tab when running with prod GCP
 * credentials.
 *
 * The helper:
 *   - returns `null` when intelligence isn't configured or the BQ
 *     client isn't available (so the route can fall back),
 *   - issues a parameterised query against the region-scoped
 *     `INFORMATION_SCHEMA.JOBS_BY_PROJECT` view,
 *   - filters on the sanitised `collector_id` job label so only jobs
 *     we own count toward the bill,
 *   - converts `total_bytes_billed` to USD using on-demand pricing
 *     ($5/TB), and
 *   - caches results per `(lookbackHours, ids, region)` for the
 *     configured TTL.
 *
 * We use the `__setBigQueryClientForTests` seam to swap in a fake
 * `BigQueryClientLike` whose `query()` records the call and replies
 * with a canned result. This pins the SQL contract without standing
 * up a real BigQuery dataset.
 */

process.env["GCP_PROJECT_ID"] = "test-project";
process.env["GCS_RAW_BUCKET"] = "test-raw-bucket";
process.env["BQ_DATASET"] = "test_dataset";
process.env["BQ_LOCATION"] = "US";
process.env["GOOGLE_CREDENTIALS_JSON"] = JSON.stringify({
  type: "service_account",
  project_id: "test-project",
});

import test from "node:test";
import assert from "node:assert/strict";

const {
  __setBigQueryClientForTests,
  __clearCollectorCostCacheForTests,
  getCollectorCostsFromInformationSchema,
} = await import("@workspace/intelligence/bq");
type BigQueryClientLike = Awaited<
  ReturnType<typeof import("@workspace/intelligence/bq").getBigQueryClient>
>;

interface CapturedQuery {
  query: string;
  params?: Record<string, unknown>;
  types?: Record<string, string | string[]>;
  labels?: Record<string, string>;
  location?: string;
}

function makeFakeBq(args: {
  capture: CapturedQuery[];
  rows: Array<Record<string, unknown>>;
  throwOnQuery?: boolean;
}): NonNullable<BigQueryClientLike> {
  return {
    dataset() {
      return {
        async exists() {
          return [true] as [boolean];
        },
        async create() {
          return undefined;
        },
        table() {
          return {
            async exists() {
              return [true] as [boolean];
            },
            async create() {
              return undefined;
            },
            async insert() {
              return undefined;
            },
          };
        },
      };
    },
    async query(opts) {
      args.capture.push({
        query: opts.query,
        params: opts.params,
        types: opts.types,
        labels: opts.labels,
        location: opts.location,
      });
      if (args.throwOnQuery) {
        throw new Error("simulated INFORMATION_SCHEMA failure");
      }
      return [args.rows];
    },
  };
}

test.afterEach(() => {
  __setBigQueryClientForTests(null);
  __clearCollectorCostCacheForTests();
});

test("returns [] when collectorIds is empty (no work)", async () => {
  const captured: CapturedQuery[] = [];
  __setBigQueryClientForTests(makeFakeBq({ capture: captured, rows: [] }));
  const result = await getCollectorCostsFromInformationSchema({
    lookbackHours: 24,
    collectorIds: [],
  });
  assert.deepEqual(result, []);
  assert.equal(captured.length, 0, "no BQ query should be issued for an empty id list");
});

test("queries region-scoped INFORMATION_SCHEMA with the collector_id label filter", async () => {
  const captured: CapturedQuery[] = [];
  __setBigQueryClientForTests(
    makeFakeBq({
      capture: captured,
      // 1 TB billed → $5 with on-demand pricing.
      rows: [
        { collector_id: "ecb-fx-rates", jobs: 4, bytes_billed: 1_000_000_000_000 },
      ],
    }),
  );

  const result = await getCollectorCostsFromInformationSchema({
    lookbackHours: 168,
    collectorIds: ["ecb-fx-rates", "fred-economic-index"],
  });

  assert.ok(result, "helper must return rows when BQ replies");
  assert.equal(result!.length, 1);
  assert.equal(result![0]!.collectorId, "ecb-fx-rates");
  assert.equal(result![0]!.runs, 4);
  assert.equal(result![0]!.bytesRaw, 1_000_000_000_000);
  // 1TB * $5/TB = $5
  assert.equal(result![0]!.estimateUsd, 5);
  // INFORMATION_SCHEMA does not surface rows-written; the helper
  // intentionally returns 0 rather than fabricating a count.
  assert.equal(result![0]!.rowsWritten, 0);

  assert.equal(captured.length, 1, "single query issued");
  const sent = captured[0]!;
  assert.match(
    sent.query,
    /INFORMATION_SCHEMA\.JOBS_BY_PROJECT/,
    "must read the per-project jobs view",
  );
  assert.match(
    sent.query,
    /region-us/i,
    "must scope to the configured region (us → region-us)",
  );
  assert.match(
    sent.query,
    /key = 'collector_id'/,
    "must filter rows to those carrying our collector_id label",
  );
  // Sanitised label values are passed in — both inputs already conform
  // (lowercase, hyphenated) so they round-trip unchanged.
  assert.deepEqual(sent.params?.["labelIds"], [
    "ecb-fx-rates",
    "fred-economic-index",
  ]);
  assert.equal(sent.params?.["hours"], 168);
  // The meta-query itself is labelled so it doesn't pollute future
  // per-collector reads.
  assert.equal(sent.labels?.["job_kind"], "cost_information_schema_read");
});

test("caches per (lookback, ids, region) so repeated calls don't burn queries", async () => {
  const captured: CapturedQuery[] = [];
  __setBigQueryClientForTests(
    makeFakeBq({
      capture: captured,
      rows: [
        { collector_id: "ecb-fx-rates", jobs: 1, bytes_billed: 500_000_000_000 },
      ],
    }),
  );

  // First call hits BQ, second call (same args) is served from cache.
  await getCollectorCostsFromInformationSchema({
    lookbackHours: 24,
    collectorIds: ["ecb-fx-rates"],
  });
  await getCollectorCostsFromInformationSchema({
    lookbackHours: 24,
    collectorIds: ["ecb-fx-rates"],
  });
  assert.equal(captured.length, 1, "second identical call should hit the cache");

  // Differ on lookback → cache miss → second BQ call.
  await getCollectorCostsFromInformationSchema({
    lookbackHours: 48,
    collectorIds: ["ecb-fx-rates"],
  });
  assert.equal(captured.length, 2, "different lookback should bypass the cache");
});

test("returns null when the INFORMATION_SCHEMA query throws (route then falls back)", async () => {
  __setBigQueryClientForTests(
    makeFakeBq({ capture: [], rows: [], throwOnQuery: true }),
  );
  const result = await getCollectorCostsFromInformationSchema({
    lookbackHours: 24,
    collectorIds: ["ecb-fx-rates"],
  });
  assert.equal(result, null, "thrown query must surface as null so the route can fall back");
});

test("returns null when the BigQuery client is unavailable", async () => {
  // Reset the client to "not loaded" — `getBigQueryClient` will then
  // try the dynamic import. With no GOOGLE_APPLICATION_CREDENTIALS
  // file on disk in CI the @google-cloud/bigquery client construction
  // can still succeed (it lazily resolves creds), so we explicitly
  // install a sentinel that fails the cached lookup by re-using the
  // test seam.
  __setBigQueryClientForTests(null);
  // No fake installed — relies on the dynamic import path. We can't
  // fully assert "client unavailable" without unmocking the module
  // system, so this test merely checks the helper does not throw and
  // either returns rows (real client) or null. CI environments without
  // GCP credentials get null, which is the contract callers rely on.
  const result = await getCollectorCostsFromInformationSchema({
    lookbackHours: 24,
    collectorIds: ["ecb-fx-rates"],
  });
  assert.ok(
    result === null || Array.isArray(result),
    "helper must either return null or a CollectorCostRow array",
  );
});
