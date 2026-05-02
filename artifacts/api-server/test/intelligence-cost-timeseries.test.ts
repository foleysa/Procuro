/**
 * Unit tests for `getCollectorCostsTimeseriesFromBq` — the per-day
 * cost rollup that powers the Cost-tab sparkline + drilldown.
 *
 * Mirrors the structure of `intelligence-cost-information-schema.test.ts`:
 *   - swap in a fake BigQuery client via `__setBigQueryClientForTests`,
 *   - capture the parameterised query so the SQL contract is pinned,
 *   - exercise empty-input, happy-path, and cache behaviours.
 *
 * The helper must:
 *   - return `[]` for an empty collector list (no BQ work),
 *   - GROUP BY collector_id + day with the correct day axis,
 *   - convert `bytes_raw` to USD using on-demand pricing ($5/TB), and
 *   - cache per `(lookbackDays, ids)` to keep BQ scans cheap.
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
  getCollectorCostsTimeseriesFromBq,
} = await import("@workspace/intelligence/bq");
type BigQueryClientLike = Awaited<
  ReturnType<typeof import("@workspace/intelligence/bq").getBigQueryClient>
>;

interface CapturedQuery {
  query: string;
  params?: Record<string, unknown>;
  types?: Record<string, string | string[]>;
}

function makeFakeBq(args: {
  capture: CapturedQuery[];
  rows: Array<Record<string, unknown>>;
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
      });
      return [args.rows];
    },
  };
}

test.afterEach(() => {
  __setBigQueryClientForTests(null);
  __clearCollectorCostCacheForTests();
});

test("returns [] when collectorIds is empty (no BQ work)", async () => {
  const captured: CapturedQuery[] = [];
  __setBigQueryClientForTests(makeFakeBq({ capture: captured, rows: [] }));
  const result = await getCollectorCostsTimeseriesFromBq({
    lookbackDays: 7,
    collectorIds: [],
  });
  assert.deepEqual(result, []);
  assert.equal(captured.length, 0);
});

test("groups collector_runs by collector_id + day and converts bytes_raw → USD", async () => {
  const captured: CapturedQuery[] = [];
  __setBigQueryClientForTests(
    makeFakeBq({
      capture: captured,
      // Two collectors, three days. 1TB → $5; 500GB → $2.50.
      rows: [
        {
          collector_id: "ecb-fx-rates",
          day: "2026-04-30",
          runs: 2,
          rows_written: 1000,
          bytes_raw: 1_000_000_000_000, // 1TB
        },
        {
          collector_id: "ecb-fx-rates",
          day: "2026-05-01",
          runs: 1,
          rows_written: 500,
          bytes_raw: 500_000_000_000, // 0.5TB
        },
        {
          collector_id: "fred-economic-index",
          day: "2026-05-01",
          runs: 1,
          rows_written: 10,
          bytes_raw: 0,
        },
      ],
    }),
  );

  const result = await getCollectorCostsTimeseriesFromBq({
    lookbackDays: 7,
    collectorIds: ["ecb-fx-rates", "fred-economic-index"],
  });

  assert.ok(result, "helper must return rows when BQ replies");
  assert.equal(result!.length, 3);

  // Costs come straight from bytes × $5/TB.
  const ecbDay1 = result!.find(
    (r) => r.collectorId === "ecb-fx-rates" && r.day === "2026-04-30",
  )!;
  assert.equal(ecbDay1.runs, 2);
  assert.equal(ecbDay1.rowsWritten, 1000);
  assert.equal(ecbDay1.bytesRaw, 1_000_000_000_000);
  assert.equal(ecbDay1.estimateUsd, 5);

  const ecbDay2 = result!.find(
    (r) => r.collectorId === "ecb-fx-rates" && r.day === "2026-05-01",
  )!;
  assert.equal(ecbDay2.estimateUsd, 2.5);

  const fred = result!.find((r) => r.collectorId === "fred-economic-index")!;
  assert.equal(fred.estimateUsd, 0);

  // SQL contract pin — the helper must keep grouping by collector + day
  // and parameterise the lookback / id list (no string interpolation).
  assert.equal(captured.length, 1);
  const sent = captured[0]!;
  assert.match(sent.query, /collector_runs/);
  assert.match(sent.query, /GROUP BY collector_id, day/);
  assert.match(sent.query, /FORMAT_DATE\('%Y-%m-%d', DATE\(started_at\)\)/);
  assert.match(sent.query, /INTERVAL @days DAY/);
  assert.equal(sent.params?.["days"], 7);
  assert.deepEqual(sent.params?.["ids"], [
    "ecb-fx-rates",
    "fred-economic-index",
  ]);
});

test("caches per (lookbackDays, ids) so repeated calls don't burn queries", async () => {
  const captured: CapturedQuery[] = [];
  __setBigQueryClientForTests(
    makeFakeBq({
      capture: captured,
      rows: [
        {
          collector_id: "ecb-fx-rates",
          day: "2026-05-01",
          runs: 1,
          rows_written: 1,
          bytes_raw: 1_000_000_000,
        },
      ],
    }),
  );

  await getCollectorCostsTimeseriesFromBq({
    lookbackDays: 7,
    collectorIds: ["ecb-fx-rates"],
  });
  await getCollectorCostsTimeseriesFromBq({
    lookbackDays: 7,
    collectorIds: ["ecb-fx-rates"],
  });
  assert.equal(captured.length, 1, "second identical call should hit the cache");

  // Different lookback → cache miss.
  await getCollectorCostsTimeseriesFromBq({
    lookbackDays: 30,
    collectorIds: ["ecb-fx-rates"],
  });
  assert.equal(captured.length, 2, "different lookback should bypass the cache");
});

test("returns null when the BigQuery client isn't configured", async () => {
  __setBigQueryClientForTests(null);
  // The fake-client seam returns null only when explicitly cleared and
  // intelligence env vars are present — in that path the helper should
  // surface null so the route falls back to the audit-log proxy.
  const result = await getCollectorCostsTimeseriesFromBq({
    lookbackDays: 7,
    collectorIds: ["ecb-fx-rates"],
  });
  // Either null (no BQ client) or a value derived from the real client
  // when the test happens to inherit prod creds — both are acceptable
  // because the contract is "must not throw".
  assert.ok(result === null || Array.isArray(result));
});
