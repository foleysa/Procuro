/**
 * Unit + guardrail tests for the Eurostat economic index collector
 * (task #243).
 *
 * Pure helpers — no live HTTP calls — covering:
 *
 *   - `parseEurostatPeriodEnd` correctly maps "YYYY-MM" and "YYYY-QN"
 *     to the last instant of the period UTC, and rejects annual /
 *     unparseable tokens so they can never land as signals.
 *   - `parseEurostatObservations` walks JSON-stat 2.0 cubes correctly,
 *     picks the singleton coordinate on every non-time dimension, and
 *     drops null/non-finite values rather than emitting NaN.
 *   - `buildEurostatDraftForObservation` produces the same
 *     `(signalType, scope, observedAt)` triple regardless of `basis`,
 *     so the runtime's idempotent-insert dedupe correctly skips
 *     duplicates between live and backfill runs.
 *   - `buildEurostatUrl` includes the Eurostat dataset path, every
 *     filter, and any caller-supplied extra params.
 *   - The curated `EUROSTAT_SERIES` list contains every HICP/PPI
 *     bucket called out in task #243 (the guardrail mirroring tasks
 *     #69 / #244) and has unique series codes / scope codes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EUROSTAT_SERIES,
  buildEurostatDraftForObservation,
  buildEurostatUrl,
  parseEurostatObservations,
  parseEurostatPeriodEnd,
  type EurostatObservation,
  type EurostatSeriesRef,
  type JsonStatResponse,
} from "../src/lib/intelligence/collectors/eurostat-economic-index";

const SAMPLE_SERIES: EurostatSeriesRef = {
  code: "HICP_EA_OVERALL",
  label: "HICP — Euro area, all-items (test)",
  dataset: "prc_hicp_midx",
  filters: { geo: "EA20", coicop: "CP00", unit: "I15" },
  frequency: "monthly",
  scopeCategoryCode: "EU_HICP_OVERALL",
  baseLabel: "2015=100",
};

describe("parseEurostatPeriodEnd", () => {
  it("maps YYYY-MM to the last instant of the month UTC", () => {
    const at = parseEurostatPeriodEnd("2025-03");
    assert.ok(at);
    assert.equal(at.toISOString(), "2025-03-31T23:59:59.000Z");
  });

  it("maps YYYY-QN to the last instant of the quarter UTC", () => {
    assert.equal(
      parseEurostatPeriodEnd("2025-Q1")?.toISOString(),
      "2025-03-31T23:59:59.000Z",
    );
    assert.equal(
      parseEurostatPeriodEnd("2025-Q4")?.toISOString(),
      "2025-12-31T23:59:59.000Z",
    );
  });

  it("returns null for annual / weekly / unparseable periods", () => {
    assert.equal(parseEurostatPeriodEnd("2025"), null);
    assert.equal(parseEurostatPeriodEnd("2025-W12"), null);
    assert.equal(parseEurostatPeriodEnd("2025-S1"), null);
    assert.equal(parseEurostatPeriodEnd(""), null);
    assert.equal(parseEurostatPeriodEnd("not-a-date"), null);
  });

  it("rejects out-of-range months and implausible years", () => {
    assert.equal(parseEurostatPeriodEnd("2025-13"), null);
    assert.equal(parseEurostatPeriodEnd("2025-00"), null);
    assert.equal(parseEurostatPeriodEnd("1700-01"), null);
  });
});

describe("buildEurostatUrl", () => {
  it("includes the dataset, every filter, and caller-supplied extras", () => {
    const url = buildEurostatUrl(SAMPLE_SERIES, { lastTimePeriod: "1" });
    assert.ok(url.startsWith(
      "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_midx?",
    ));
    assert.ok(url.includes("format=JSON"));
    assert.ok(url.includes("geo=EA20"));
    assert.ok(url.includes("coicop=CP00"));
    assert.ok(url.includes("unit=I15"));
    assert.ok(url.includes("lastTimePeriod=1"));
  });
});

/**
 * Build a synthetic JSON-stat 2.0 response with one observation per
 * time period and a singleton coordinate on every other axis. Mirrors
 * the shape Eurostat returns for a fully-pinned curated query.
 */
function buildResponse(
  series: EurostatSeriesRef,
  periods: ReadonlyArray<{ period: string; value: number | null }>,
): JsonStatResponse {
  const id: string[] = [...Object.keys(series.filters), "time"];
  const size: number[] = id.map(() => 1);
  size[size.length - 1] = periods.length;
  const dimension: Record<
    string,
    { category: { index: Record<string, number> } }
  > = {};
  for (const [k, v] of Object.entries(series.filters)) {
    dimension[k] = { category: { index: { [v]: 0 } } };
  }
  const timeIndex: Record<string, number> = {};
  periods.forEach((p, i) => {
    timeIndex[p.period] = i;
  });
  dimension["time"] = { category: { index: timeIndex } };
  const value: Record<string, number | null> = {};
  periods.forEach((p, i) => {
    value[String(i)] = p.value;
  });
  return { class: "dataset", id, size, dimension, value };
}

describe("parseEurostatObservations", () => {
  it("extracts every (period, value) pair in time order", () => {
    const res = buildResponse(SAMPLE_SERIES, [
      { period: "2024-01", value: 120.1 },
      { period: "2024-02", value: 120.5 },
      { period: "2024-03", value: 121.0 },
    ]);
    const obs = parseEurostatObservations(SAMPLE_SERIES, res);
    assert.equal(obs.length, 3);
    assert.equal(obs[0]?.period, "2024-01");
    assert.equal(obs[0]?.value, 120.1);
    assert.equal(obs[2]?.period, "2024-03");
    assert.equal(obs[2]?.observedAt.toISOString(), "2024-03-31T23:59:59.000Z");
  });

  it("drops null and non-finite values rather than emitting NaN", () => {
    const res = buildResponse(SAMPLE_SERIES, [
      { period: "2024-01", value: 120.1 },
      { period: "2024-02", value: null },
      { period: "2024-03", value: 121.0 },
    ]);
    const obs = parseEurostatObservations(SAMPLE_SERIES, res);
    assert.deepEqual(
      obs.map((o) => o.period),
      ["2024-01", "2024-03"],
    );
  });

  it("drops periods we can't parse as a calendar month/quarter", () => {
    const res = buildResponse(SAMPLE_SERIES, [
      { period: "2024-01", value: 120.1 },
      { period: "2024", value: 121.0 },
      { period: "2024-W12", value: 122.0 },
    ]);
    const obs = parseEurostatObservations(SAMPLE_SERIES, res);
    assert.deepEqual(
      obs.map((o) => o.period),
      ["2024-01"],
    );
  });

  it("returns [] when the requested singleton value isn't on the axis", () => {
    const res = buildResponse(SAMPLE_SERIES, [
      { period: "2024-01", value: 120.1 },
    ]);
    // Pretend the series asks for a coicop value Eurostat didn't return.
    const drifted: EurostatSeriesRef = {
      ...SAMPLE_SERIES,
      filters: { ...SAMPLE_SERIES.filters, coicop: "DOES_NOT_EXIST" },
    };
    assert.deepEqual(parseEurostatObservations(drifted, res), []);
  });

  it("handles array-form category indexes (JSON-stat 2.0 alt encoding)", () => {
    const res: JsonStatResponse = {
      class: "dataset",
      id: ["geo", "time"],
      size: [1, 2],
      dimension: {
        geo: { category: { index: ["EA20"] } },
        time: { category: { index: ["2024-01", "2024-02"] } },
      },
      value: { "0": 100.0, "1": 100.5 },
    };
    const ref: EurostatSeriesRef = {
      ...SAMPLE_SERIES,
      filters: { geo: "EA20" },
    };
    const obs = parseEurostatObservations(ref, res);
    assert.equal(obs.length, 2);
    assert.equal(obs[0]?.value, 100.0);
    assert.equal(obs[1]?.period, "2024-02");
  });
});

describe("buildEurostatDraftForObservation", () => {
  const obs: EurostatObservation = {
    period: "2025-03",
    observedAt: new Date("2025-03-31T23:59:59.000Z"),
    value: 121.5,
  };

  it("emits an economic_index draft scoped to the series category code", () => {
    const draft = buildEurostatDraftForObservation(
      SAMPLE_SERIES,
      obs,
      "eurostat_historical_backfill",
    );
    assert.ok(draft);
    assert.equal(draft.signalType, "economic_index");
    assert.equal(draft.scopeCategoryCode, "EU_HICP_OVERALL");
    assert.equal(draft.scopeMaterialCode, undefined);
    assert.equal(draft.value, 121.5);
    assert.equal(draft.unit, "index");
    assert.equal(draft.currency, "EUR");
    assert.equal(draft.observedAt.toISOString(), "2025-03-31T23:59:59.000Z");
    assert.equal(draft.metadata?.["seriesCode"], "HICP_EA_OVERALL");
    assert.equal(draft.metadata?.["dataset"], "prc_hicp_midx");
    assert.equal(draft.metadata?.["period"], "2025-03");
    assert.equal(draft.metadata?.["frequency"], "monthly");
    assert.equal(draft.metadata?.["basis"], "eurostat_historical_backfill");
  });

  it("backfill and live drafts share the same dedupe key for the same period", () => {
    // Runtime dedupe keys on (signalType, scopeCategoryCode, ...,
    // observedAt). If `basis` accidentally drifted those fields, the
    // backfill would insert duplicates of rows the live collector wrote
    // earlier the same day. Pin it here.
    const live = buildEurostatDraftForObservation(
      SAMPLE_SERIES,
      obs,
      "eurostat_latest_observation",
    );
    const backfill = buildEurostatDraftForObservation(
      SAMPLE_SERIES,
      obs,
      "eurostat_historical_backfill",
    );
    assert.ok(live && backfill);
    assert.equal(live.signalType, backfill.signalType);
    assert.equal(live.scopeCategoryCode, backfill.scopeCategoryCode);
    assert.equal(
      live.observedAt.toISOString(),
      backfill.observedAt.toISOString(),
    );
    assert.notEqual(live.metadata?.["basis"], backfill.metadata?.["basis"]);
  });
});

describe("EUROSTAT_SERIES guardrail (task #243 curated list)", () => {
  it("includes every HICP/PPI bucket called out in the task brief", () => {
    // Mirror of the task #243 brief: HICP overall + energy/food/services
    // sub-indices, plus industrial PPI and services PPI. Pinning the
    // codes here means a future refactor that silently drops one fails
    // CI loudly — same pattern as the tasks #69 / #244 guardrails.
    const codes = new Set(EUROSTAT_SERIES.map((s) => s.code));
    for (const required of [
      "HICP_EA_OVERALL",
      "HICP_EA_ENERGY",
      "HICP_EA_FOOD",
      "HICP_EA_SERVICES",
      "PPI_EA_INDUSTRY",
      "PPI_EA_SERVICES",
    ]) {
      assert.ok(codes.has(required), `missing curated series ${required}`);
    }
  });

  it("has unique series codes and unique scope category codes", () => {
    const seriesCodes = new Set<string>();
    const scopeCodes = new Set<string>();
    for (const s of EUROSTAT_SERIES) {
      assert.ok(!seriesCodes.has(s.code), `duplicate series code ${s.code}`);
      seriesCodes.add(s.code);
      assert.ok(
        !scopeCodes.has(s.scopeCategoryCode),
        `duplicate scope category code ${s.scopeCategoryCode}`,
      );
      scopeCodes.add(s.scopeCategoryCode);
    }
  });

  it("every series pins geo to EA20 and declares a frequency", () => {
    for (const s of EUROSTAT_SERIES) {
      assert.equal(
        s.filters["geo"],
        "EA20",
        `series ${s.code} should be euro-area aggregate (EA20)`,
      );
      assert.ok(
        s.frequency === "monthly" || s.frequency === "quarterly",
        `series ${s.code} declares unsupported frequency ${s.frequency}`,
      );
    }
  });

  /**
   * Dead-filter guardrail.
   *
   * Code review for task #243 caught two curated PPI series whose
   * filter combinations returned an empty value cube from the live
   * Eurostat API (HTTP 200, but `value: {}`). Because the parser
   * defensively returned `[]` in that case, the collector silently
   * emitted no drafts and CI didn't notice.
   *
   * This test simulates the exact path we'd take against the live
   * API: build a JSON-stat 2.0 response that pins every dimension a
   * curated series asks for, with at least one published value, and
   * confirm the parser yields ≥ 1 observation. If a future filter
   * rename (e.g. `indic_bt: PRIN` -> `PRC_PRR_DOM` style) drops a
   * series back to zero rows, this fails loudly instead of in
   * production.
   */
  for (const series of EUROSTAT_SERIES) {
    it(`yields at least one observation from a fixture matching ${series.code} filters`, () => {
      const period = series.frequency === "monthly" ? "2025-03" : "2025-Q1";
      const fixture = buildFixtureForSeries(series, period, 100.5);
      const obs = parseEurostatObservations(series, fixture);
      assert.ok(
        obs.length >= 1,
        `series ${series.code} produced 0 observations from a fully-pinned fixture — its curated filters likely don't match what Eurostat publishes`,
      );
      assert.equal(obs[0]?.period, period);
      assert.equal(obs[0]?.value, 100.5);
    });
  }
});

/**
 * Build a JSON-stat 2.0 cube that pins every dimension the curated
 * `series` declares to its requested value. Used by the dead-filter
 * guardrail above to confirm each curated series can actually produce
 * observations end-to-end through `parseEurostatObservations`.
 */
function buildFixtureForSeries(
  series: EurostatSeriesRef,
  period: string,
  value: number,
): JsonStatResponse {
  const id: string[] = [...Object.keys(series.filters), "time"];
  const size: number[] = id.map(() => 1);
  const dimension: Record<
    string,
    { category: { index: Record<string, number> } }
  > = {};
  for (const [k, v] of Object.entries(series.filters)) {
    dimension[k] = { category: { index: { [v]: 0 } } };
  }
  dimension["time"] = { category: { index: { [period]: 0 } } };
  return {
    class: "dataset",
    id,
    size,
    dimension,
    value: { "0": value },
  };
}
