/**
 * End-to-end fetch test for the USDA NASS agricultural commodity
 * collector (task #255).
 *
 * Task #244 already pins every pure helper (parseNassMonthEnd,
 * parseNassValue, normalizeNassUnit, buildNassDraftForObservation,
 * selectLatestMonthly) at the unit level. What those tests can't catch
 * is a refactor that changes the URL shape we send to NASS, drops the
 * "no records found" 400 special-case, or alters how `collect()` fans
 * a real upstream payload into drafts. This suite mocks
 * `globalThis.fetch`, replays a captured response per curated
 * commodity, and asserts the resulting draft stream snapshot.
 *
 * Three high-value invariants:
 *
 *   1. **URL contract.** Every per-series request carries `key`,
 *      `format=JSON`, `year__GE`, and every `series.query` filter.
 *      A regression here would either burn a quota with the wrong key
 *      param name or pull the wrong NASS slice (e.g. "ALL CLASSES"
 *      collapsing into national rolled-up totals).
 *
 *   2. **`collect()` end-to-end.** Given a real (canned) NASS payload
 *      with three monthly observations + one MARKETING YEAR roll-up,
 *      the live collector emits exactly one draft per curated series,
 *      anchored at the most-recent month, with the expected
 *      (materialCode, unit, observedAt) shape. Any drift in scope
 *      routing, unit normalisation, or month-end resolution surfaces
 *      here as a snapshot mismatch.
 *
 *   3. **400 "no records found" path.** A series NASS temporarily
 *      stops publishing must yield zero drafts and zero failures (so
 *      the run isn't marked broken). The cotton fixture pins this by
 *      returning HTTP 400 with NASS's literal "No records found"
 *      body — both `collect()` and `fetchUsdaNassBackfillDrafts` must
 *      treat it as an empty result.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  NASS_SERIES,
  fetchUsdaNassBackfillDrafts,
  usdaNassEconomicIndexCollector,
} from "../src/lib/intelligence/collectors/usda-nass-economic-index";
import {
  NO_RECORDS_BODY,
  USDA_NASS_FIXTURE_RESPONSES,
} from "./fixtures/usda-nass-responses";

const TEST_API_KEY = "test-nass-key";
const TEST_YEAR_GE = 2020;

interface CapturedRequest {
  url: string;
  params: Record<string, string>;
}

let capturedRequests: CapturedRequest[] = [];
let realFetch: typeof globalThis.fetch;

function installNassFetchStub(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (!url.includes("quickstats.nass.usda.gov/api/api_GET/")) {
      return realFetch(input, init);
    }

    const u = new URL(url);
    const params: Record<string, string> = {};
    for (const [k, v] of u.searchParams.entries()) params[k] = v;
    capturedRequests.push({ url, params });

    const commodity = u.searchParams.get("commodity_desc") ?? "";
    const isStateRequest =
      u.searchParams.get("agg_level_desc") === "STATE" ||
      u.searchParams.has("state_alpha");
    const fixture = isStateRequest
      ? undefined
      : USDA_NASS_FIXTURE_RESPONSES[commodity];

    // State-level series share the same `commodity_desc` as the
    // national series but the fixtures only seed the national curve.
    // Returning empty data here keeps the per-(materialCode) draft
    // counts in lockstep with the national fixture.
    // Unknown commodity → empty 200 so non-curated series can't pollute
    // the assertions if NASS_SERIES grows later.
    if (!fixture) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (fixture.data === null) {
      // NASS's actual no-records response: 400 + a body containing the
      // literal "no records found" phrase. The collector must treat
      // this as an empty result, not a transport failure.
      return new Response(NO_RECORDS_BODY, {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ data: fixture.data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

before(() => {
  installNassFetchStub();
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  capturedRequests = [];
});

describe("usdaNassEconomicIndexCollector URL contract", () => {
  it("sends key, format=JSON, year__GE, and every series.query filter for each series", async () => {
    const prev = process.env["USDA_NASS_API_KEY"];
    process.env["USDA_NASS_API_KEY"] = TEST_API_KEY;
    try {
      await usdaNassEconomicIndexCollector.collect({ since: null });
    } finally {
      if (prev === undefined) delete process.env["USDA_NASS_API_KEY"];
      else process.env["USDA_NASS_API_KEY"] = prev;
    }

    assert.equal(
      capturedRequests.length,
      NASS_SERIES.length,
      "live collector should fire exactly one request per curated series",
    );

    // Pin the parameter shape on the corn request — it carries the
    // richest filter set (commodity + class + statisticcat + unit +
    // agg_level + freq) so a drop of any of those would show up here.
    const cornSeries = NASS_SERIES.find((s) => s.materialCode === "CORN");
    assert.ok(cornSeries, "CORN series must exist in the curated registry");
    const cornReq = capturedRequests.find(
      (r) =>
        r.params["commodity_desc"] === "CORN" &&
        r.params["class_desc"] === "GRAIN",
    );
    assert.ok(cornReq, "expected a request for the curated CORN series");
    assert.equal(cornReq.params["key"], TEST_API_KEY);
    assert.equal(cornReq.params["format"], "JSON");
    assert.ok(
      Number(cornReq.params["year__GE"]) >= 2000,
      "year__GE should be an explicit recent year, never absent",
    );
    for (const [k, v] of Object.entries(cornSeries.query)) {
      assert.equal(
        cornReq.params[k],
        v,
        `corn request must carry series.query[${k}]=${v}`,
      );
    }
  });
});

describe("usdaNassEconomicIndexCollector.collect() end-to-end with fixture", () => {
  it("emits the latest-monthly draft per curated series with expected shape", async () => {
    const prev = process.env["USDA_NASS_API_KEY"];
    process.env["USDA_NASS_API_KEY"] = TEST_API_KEY;
    let drafts;
    try {
      drafts = await usdaNassEconomicIndexCollector.collect({ since: null });
    } finally {
      if (prev === undefined) delete process.env["USDA_NASS_API_KEY"];
      else process.env["USDA_NASS_API_KEY"] = prev;
    }

    // Snapshot keyed by materialCode → (value, unit, observedAt iso,
    // basis). Cotton is intentionally absent (no-records 400 path).
    // Numbers picked to match the latest monthly entry per fixture and
    // pin: thousands-separator parsing (MILK = 1234.5), unit
    // normalisation ("$ / BU" → "USD/bu"), and month-end resolution
    // ("MAR" → 2025-03-31T23:59:59Z).
    const expected: Record<
      string,
      { value: number; unit: string; observedAt: string }
    > = {
      CORN: { value: 4.55, unit: "USD/bu", observedAt: "2025-03-31T23:59:59.000Z" },
      WHEAT: { value: 5.85, unit: "USD/bu", observedAt: "2025-03-31T23:59:59.000Z" },
      SOYBEANS: { value: 10.25, unit: "USD/bu", observedAt: "2025-03-31T23:59:59.000Z" },
      MILK: { value: 1234.5, unit: "USD/cwt", observedAt: "2025-03-31T23:59:59.000Z" },
      CHEESE: { value: 1.85, unit: "USD/lb", observedAt: "2025-03-31T23:59:59.000Z" },
      BUTTER: { value: 2.4, unit: "USD/lb", observedAt: "2025-03-31T23:59:59.000Z" },
      BEEF_CATTLE: { value: 198.5, unit: "USD/cwt", observedAt: "2025-03-31T23:59:59.000Z" },
      HOGS: { value: 67.2, unit: "USD/cwt", observedAt: "2025-03-31T23:59:59.000Z" },
      BROILERS: { value: 0.65, unit: "USD/lb", observedAt: "2025-03-31T23:59:59.000Z" },
    };

    const byCode = new Map<string, (typeof drafts)[number]>();
    for (const d of drafts) {
      assert.ok(
        d.scopeMaterialCode,
        "every NASS draft must be scoped to a material code",
      );
      assert.equal(
        byCode.has(d.scopeMaterialCode!),
        false,
        `live collect() must emit at most one draft per series, saw 2 for ${d.scopeMaterialCode}`,
      );
      byCode.set(d.scopeMaterialCode!, d);
    }

    for (const [code, exp] of Object.entries(expected)) {
      const draft = byCode.get(code);
      assert.ok(draft, `expected a latest-monthly draft for ${code}`);
      assert.equal(draft.signalType, "commodity_index");
      assert.equal(draft.currency, "USD");
      assert.equal(draft.value, exp.value, `${code} value`);
      assert.equal(draft.unit, exp.unit, `${code} unit`);
      assert.equal(
        draft.observedAt.toISOString(),
        exp.observedAt,
        `${code} observedAt`,
      );
      assert.equal(
        draft.metadata?.["basis"],
        "nass_latest_observation",
        `${code} basis tag`,
      );
    }

    // The cotton fixture is the no-records 400 path — must NOT appear
    // in the live draft stream.
    assert.equal(
      byCode.has("COTTON"),
      false,
      "cotton (no-records 400) must yield no live draft",
    );
  });
});

describe("fetchUsdaNassBackfillDrafts() end-to-end with fixture", () => {
  it("emits one draft per (series × monthly observation) and skips suppressed values", async () => {
    const { drafts, failedSeries } = await fetchUsdaNassBackfillDrafts({
      apiKey: TEST_API_KEY,
      yearGe: TEST_YEAR_GE,
    });

    assert.deepEqual(
      failedSeries,
      [],
      "no-records 400s must not be reported as failed series",
    );

    // year__GE was passed explicitly — every captured request should
    // carry that exact value.
    for (const req of capturedRequests) {
      assert.equal(
        req.params["year__GE"],
        String(TEST_YEAR_GE),
        "backfill must thread the caller's yearGe into every request",
      );
    }

    // Group drafts by material code. Pin the per-series count, which
    // mirrors the fixture's monthly-row count (suppressed "(D)" and
    // MARKETING YEAR rows must be filtered out by the backfill).
    const counts = new Map<string, number>();
    for (const d of drafts) {
      const code = d.scopeMaterialCode ?? "<unscoped>";
      counts.set(code, (counts.get(code) ?? 0) + 1);
      assert.equal(
        d.metadata?.["basis"],
        "nass_historical_backfill",
        `${code} backfill draft should carry the backfill basis tag`,
      );
    }

    assert.equal(counts.get("CORN"), 3, "corn fixture has 3 monthly rows");
    assert.equal(counts.get("WHEAT"), 2, "wheat fixture has 2 monthly rows");
    assert.equal(counts.get("SOYBEANS"), 1);
    assert.equal(
      counts.get("MILK"),
      2,
      "milk fixture has 3 rows but the (D) suppression marker drops one",
    );
    assert.equal(counts.get("CHEESE"), 1);
    assert.equal(counts.get("BUTTER"), 1);
    assert.equal(counts.get("BEEF_CATTLE"), 1);
    assert.equal(counts.get("HOGS"), 1);
    assert.equal(counts.get("BROILERS"), 1);
    assert.equal(
      counts.get("COTTON") ?? 0,
      0,
      "cotton no-records 400 must produce zero drafts and zero failures",
    );

    // Spot-check the corn JAN observation round-trips with thousands-
    // separator-free numbers and the canonical USD/bu unit.
    const cornJan = drafts.find(
      (d) =>
        d.scopeMaterialCode === "CORN" &&
        d.metadata?.["referencePeriod"] === "JAN",
    );
    assert.ok(cornJan, "expected a corn JAN backfill draft");
    assert.equal(cornJan.value, 4.2);
    assert.equal(cornJan.unit, "USD/bu");
    assert.equal(cornJan.observedAt.toISOString(), "2025-01-31T23:59:59.000Z");
  });
});

describe("NASS 400 'no records found' path", () => {
  it("treats 400 + 'no records' body as an empty result, not a transport failure", async () => {
    // Drive the path in isolation by calling the backfill with only
    // the cotton fixture in play — the broader assertions above
    // already cover the mixed case.
    const { drafts, failedSeries } = await fetchUsdaNassBackfillDrafts({
      apiKey: TEST_API_KEY,
      yearGe: TEST_YEAR_GE,
    });
    const cottonDrafts = drafts.filter(
      (d) => d.scopeMaterialCode === "COTTON",
    );
    const cottonFailed = failedSeries.filter(
      (f) => f.materialCode === "COTTON",
    );
    assert.equal(cottonDrafts.length, 0, "cotton should yield zero drafts");
    assert.equal(
      cottonFailed.length,
      0,
      "cotton no-records 400 must NOT be reported as a failed series",
    );
  });

  it("a real 400 (not no-records) still surfaces as a per-series failure", async () => {
    // Swap the cotton fixture for a hard 400 with an unrelated body to
    // pin that the special-case is narrow ("no records" only) and that
    // a genuine bad-request still bubbles up to failedSeries so the
    // runtime can log it instead of silently dropping data.
    const realFetchInner = globalThis.fetch;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes("quickstats.nass.usda.gov/api/api_GET/")) {
        const u = new URL(url);
        if (u.searchParams.get("commodity_desc") === "COTTON") {
          return new Response('{"error":["bad parameter"]}', {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return realFetchInner(input, init);
    }) as typeof fetch;

    try {
      const { failedSeries } = await fetchUsdaNassBackfillDrafts({
        apiKey: TEST_API_KEY,
        yearGe: TEST_YEAR_GE,
      });
      const cottonFailed = failedSeries.find(
        (f) => f.materialCode === "COTTON",
      );
      assert.ok(
        cottonFailed,
        "a non-'no records' 400 must surface as a failed series",
      );
      assert.match(
        cottonFailed.error,
        /HTTP 400/,
        "failure message should carry the upstream status",
      );
    } finally {
      globalThis.fetch = realFetchInner;
    }
  });
});
