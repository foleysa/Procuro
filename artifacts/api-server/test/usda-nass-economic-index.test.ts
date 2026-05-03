/**
 * Unit + guardrail tests for the USDA NASS agricultural commodity
 * collector (task #244).
 *
 * Pure helpers — no live HTTP calls — covering:
 *
 *   - `parseNassMonthEnd` correctly maps `(year, "JAN".."DEC")` to the
 *     last instant of that month UTC, and rejects non-monthly periods
 *     ("MARKETING YEAR", "ANNUAL") so they can never land as signals.
 *   - `parseNassValue` filters NASS suppression markers ("(D)", "(NA)",
 *     "(Z)") and tolerates thousands separators.
 *   - `normalizeNassUnit` projects "$ / BU" → "USD/bu" etc., and falls
 *     back to the series's expected unit on drift.
 *   - `buildNassDraftForObservation` produces the same `(signalType,
 *     scope, observedAt)` triple regardless of `basis`, so the runtime's
 *     idempotent-insert dedupe correctly skips duplicates between live
 *     and backfill runs.
 *   - `selectLatestMonthly` picks the most recent calendar month and
 *     never lets a "MARKETING YEAR" row outrank a real month.
 *   - `fetchUsdaNassBackfillDrafts` throws a clear, actionable error
 *     when `USDA_NASS_API_KEY` is missing — mirroring the live
 *     collector's behaviour so the audit log records the same root
 *     cause.
 *   - The curated `NASS_SERIES` list contains every commodity called
 *     out in task #244 (the guardrail mirroring task #69) and has
 *     unique material codes.
 *
 * Isolation: this suite reads/restores `process.env.USDA_NASS_API_KEY`
 * inside a single test and never touches global module state otherwise.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NASS_NATIONAL_SERIES,
  NASS_SERIES,
  NASS_STATE_PAIRS,
  NASS_STATE_SERIES,
  buildNassDraftForObservation,
  fetchUsdaNassBackfillDrafts,
  normalizeNassUnit,
  parseNassMonthEnd,
  parseNassValue,
  selectLatestMonthly,
  type NassSeriesRef,
} from "../src/lib/intelligence/collectors/usda-nass-economic-index";

const SAMPLE_SERIES: NassSeriesRef = {
  materialCode: "CORN",
  label: "Corn — test",
  expectedUnit: "USD/bu",
  query: { commodity_desc: "CORN" },
};

describe("parseNassMonthEnd", () => {
  it("maps (year, MONTH) to the last instant of that month UTC", () => {
    const at = parseNassMonthEnd("2025", "MAR");
    assert.ok(at);
    assert.equal(at.toISOString(), "2025-03-31T23:59:59.000Z");
  });

  it("returns null for non-monthly reference periods", () => {
    assert.equal(parseNassMonthEnd("2025", "MARKETING YEAR"), null);
    assert.equal(parseNassMonthEnd("2025", "ANNUAL"), null);
    assert.equal(parseNassMonthEnd("2025", "JAN THRU MAR"), null);
  });

  it("rejects implausible years and missing inputs", () => {
    assert.equal(parseNassMonthEnd(undefined, "JAN"), null);
    assert.equal(parseNassMonthEnd("2025", undefined), null);
    assert.equal(parseNassMonthEnd("not-a-year", "JAN"), null);
    assert.equal(parseNassMonthEnd("1700", "JAN"), null);
  });
});

describe("parseNassValue", () => {
  it("parses plain numbers and strips thousands separators", () => {
    assert.equal(parseNassValue("4.25"), 4.25);
    assert.equal(parseNassValue("1,234.5"), 1234.5);
  });

  it("returns null for NASS suppression markers", () => {
    assert.equal(parseNassValue("(D)"), null);
    assert.equal(parseNassValue("(NA)"), null);
    assert.equal(parseNassValue("(Z)"), null);
  });

  it("returns null for empty / non-numeric inputs", () => {
    assert.equal(parseNassValue(""), null);
    assert.equal(parseNassValue("   "), null);
    assert.equal(parseNassValue("n/a"), null);
    assert.equal(parseNassValue(undefined), null);
  });
});

describe("normalizeNassUnit", () => {
  it("projects '$ / BU' style strings into USD/<unit>", () => {
    assert.equal(normalizeNassUnit("$ / BU"), "USD/bu");
    assert.equal(normalizeNassUnit("$ / CWT"), "USD/cwt");
    assert.equal(normalizeNassUnit("$/LB"), "USD/lb");
  });

  it("returns null for unrecognised unit strings", () => {
    assert.equal(normalizeNassUnit("INDEX"), null);
    assert.equal(normalizeNassUnit(""), null);
    assert.equal(normalizeNassUnit(undefined), null);
  });
});

describe("buildNassDraftForObservation", () => {
  it("emits a commodity_index draft scoped to the series material code", () => {
    const draft = buildNassDraftForObservation(
      SAMPLE_SERIES,
      {
        short_desc: "CORN, GRAIN - PRICE RECEIVED, MEASURED IN $ / BU",
        commodity_desc: "CORN",
        year: "2025",
        reference_period_desc: "MAR",
        value: "4.25",
        unit_desc: "$ / BU",
      },
      "nass_historical_backfill",
    );
    assert.ok(draft);
    assert.equal(draft.signalType, "commodity_index");
    assert.equal(draft.scopeMaterialCode, "CORN");
    assert.equal(draft.scopeCategoryCode, undefined);
    assert.equal(draft.value, 4.25);
    assert.equal(draft.unit, "USD/bu");
    assert.equal(draft.currency, "USD");
    assert.equal(draft.observedAt.toISOString(), "2025-03-31T23:59:59.000Z");
    assert.equal(draft.metadata?.["basis"], "nass_historical_backfill");
    assert.equal(draft.metadata?.["year"], "2025");
    assert.equal(draft.metadata?.["referencePeriod"], "MAR");
  });

  it("returns null for suppressed values and non-monthly periods", () => {
    const suppressed = buildNassDraftForObservation(
      SAMPLE_SERIES,
      { year: "2025", reference_period_desc: "MAR", value: "(D)" },
      "nass_latest_observation",
    );
    assert.equal(suppressed, null);
    const annual = buildNassDraftForObservation(
      SAMPLE_SERIES,
      { year: "2025", reference_period_desc: "MARKETING YEAR", value: "4.25" },
      "nass_latest_observation",
    );
    assert.equal(annual, null);
  });

  it("falls back to the series's expected unit when NASS unit drifts", () => {
    const draft = buildNassDraftForObservation(
      SAMPLE_SERIES,
      {
        year: "2025",
        reference_period_desc: "MAR",
        value: "4.25",
        unit_desc: "INDEX",
      },
      "nass_latest_observation",
    );
    assert.ok(draft);
    assert.equal(draft.unit, "USD/bu");
  });

  it("backfill and live drafts share the same dedupe key for the same month", () => {
    // Runtime dedupe keys on (signalType, scopeMaterialCode, ...,
    // observedAt). If `basis` accidentally drifted those fields, the
    // backfill would insert duplicates of rows the live collector wrote
    // earlier the same day. Pin it here.
    const live = buildNassDraftForObservation(
      SAMPLE_SERIES,
      { year: "2025", reference_period_desc: "MAR", value: "4.25" },
      "nass_latest_observation",
    );
    const backfill = buildNassDraftForObservation(
      SAMPLE_SERIES,
      { year: "2025", reference_period_desc: "MAR", value: "4.25" },
      "nass_historical_backfill",
    );
    assert.ok(live && backfill);
    assert.equal(live.signalType, backfill.signalType);
    assert.equal(live.scopeMaterialCode, backfill.scopeMaterialCode);
    assert.equal(
      live.observedAt.toISOString(),
      backfill.observedAt.toISOString(),
    );
    assert.notEqual(live.metadata?.["basis"], backfill.metadata?.["basis"]);
  });
});

describe("selectLatestMonthly", () => {
  it("picks the most-recent calendar month and skips non-monthly rows", () => {
    const picked = selectLatestMonthly([
      { year: "2025", reference_period_desc: "JAN", value: "4.10" },
      { year: "2025", reference_period_desc: "MAR", value: "4.25" },
      { year: "2025", reference_period_desc: "FEB", value: "4.15" },
      // A "MARKETING YEAR" row would be the latest in load order but
      // must not outrank a real month.
      { year: "2025", reference_period_desc: "MARKETING YEAR", value: "4.50" },
    ]);
    assert.ok(picked);
    assert.equal(picked.reference_period_desc, "MAR");
  });

  it("returns null when no monthly rows are present", () => {
    assert.equal(
      selectLatestMonthly([
        { year: "2025", reference_period_desc: "ANNUAL", value: "4.50" },
      ]),
      null,
    );
    assert.equal(selectLatestMonthly([]), null);
  });
});

describe("NASS_SERIES guardrail (task #244 curated list)", () => {
  it("includes every commodity called out in the task brief", () => {
    // Mirror of the task #244 brief: corn, wheat, soybeans, dairy
    // (milk + cheese + butter), beef, pork, poultry, cotton. Pinning
    // the codes here means a future refactor that silently drops one
    // fails CI loudly — same pattern as the task #69 guardrail.
    const codes = new Set(NASS_NATIONAL_SERIES.map((s) => s.materialCode));
    for (const required of [
      "CORN",
      "WHEAT",
      "SOYBEANS",
      "MILK",
      "CHEESE",
      "BUTTER",
      "BEEF_CATTLE",
      "HOGS",
      "BROILERS",
      "COTTON",
    ]) {
      assert.ok(codes.has(required), `missing curated commodity ${required}`);
    }
  });

  it("national series have unique material codes", () => {
    const seen = new Set<string>();
    for (const s of NASS_NATIONAL_SERIES) {
      assert.ok(
        !seen.has(s.materialCode),
        `duplicate material code ${s.materialCode}`,
      );
      seen.add(s.materialCode);
    }
  });

  it("every series declares a USD-denominated expected unit", () => {
    for (const s of NASS_SERIES) {
      assert.match(
        s.expectedUnit,
        /^USD\//,
        `series ${s.materialCode} should be USD-denominated`,
      );
    }
  });

  it("national series leave regionCode unset (so scope_region_code stays NULL)", () => {
    for (const s of NASS_NATIONAL_SERIES) {
      assert.equal(
        s.regionCode,
        undefined,
        `national series ${s.materialCode} should not declare a regionCode`,
      );
      assert.equal(s.query["agg_level_desc"], "NATIONAL");
      assert.equal(s.query["state_alpha"], undefined);
    }
  });
});

describe("NASS_STATE_PAIRS / NASS_STATE_SERIES guardrail (task #254)", () => {
  it("every pair points at a known national series materialCode", () => {
    const known = new Set(NASS_NATIONAL_SERIES.map((s) => s.materialCode));
    for (const pair of NASS_STATE_PAIRS) {
      assert.ok(
        known.has(pair.materialCode),
        `state pair ${pair.materialCode}/${pair.stateAlpha} references unknown national series`,
      );
      assert.match(
        pair.stateAlpha,
        /^[A-Z]{2}$/,
        `stateAlpha must be a 2-letter USPS code, got ${pair.stateAlpha}`,
      );
    }
  });

  it("includes the regional examples from the task brief", () => {
    const has = (m: string, s: string): boolean =>
      NASS_STATE_PAIRS.some(
        (p) => p.materialCode === m && p.stateAlpha === s,
      );
    assert.ok(has("MILK", "CA"), "task brief calls out California dairy");
    assert.ok(has("BEEF_CATTLE", "TX"), "task brief calls out Texas beef");
    assert.ok(has("CORN", "IA"), "task brief calls out Iowa corn");
  });

  it("derived state series carry a US-XX regionCode and STATE agg_level", () => {
    for (const s of NASS_STATE_SERIES) {
      assert.match(
        s.regionCode ?? "",
        /^US-[A-Z]{2}$/,
        `state series ${s.materialCode} regionCode must look like US-XX`,
      );
      assert.equal(s.query["agg_level_desc"], "STATE");
      assert.match(s.query["state_alpha"] ?? "", /^[A-Z]{2}$/);
    }
  });

  it("(materialCode, regionCode) is unique across the full series list", () => {
    // Material code alone is no longer unique once state slices land,
    // but the (material, region) pair must be, otherwise two queries
    // would race for the same natural-key row.
    const seen = new Set<string>();
    for (const s of NASS_SERIES) {
      const key = `${s.materialCode}|${s.regionCode ?? "NATIONAL"}`;
      assert.ok(!seen.has(key), `duplicate series for key ${key}`);
      seen.add(key);
    }
  });

  it("NASS_SERIES is the concatenation of national + state series", () => {
    assert.equal(
      NASS_SERIES.length,
      NASS_NATIONAL_SERIES.length + NASS_STATE_SERIES.length,
    );
  });
});

describe("buildNassDraftForObservation (state-scoped, task #254)", () => {
  it("threads regionCode onto scopeRegionCode for state-level series", () => {
    const stateSeries: NassSeriesRef = {
      materialCode: "MILK",
      label: "Milk — California test",
      expectedUnit: "USD/cwt",
      regionCode: "US-CA",
      query: {
        commodity_desc: "MILK",
        agg_level_desc: "STATE",
        state_alpha: "CA",
      },
    };
    const draft = buildNassDraftForObservation(
      stateSeries,
      { year: "2025", reference_period_desc: "MAR", value: "22.40" },
      "nass_latest_observation",
    );
    assert.ok(draft);
    assert.equal(draft.scopeRegionCode, "US-CA");
    assert.equal(draft.scopeMaterialCode, "MILK");
    assert.equal(draft.metadata?.["regionCode"], "US-CA");
    assert.equal(draft.metadata?.["stateAlpha"], "CA");
    assert.equal(draft.metadata?.["aggLevel"], "STATE");
  });

  it("national + state drafts for the same commodity/month dedupe to distinct rows", () => {
    const stateSeries: NassSeriesRef = {
      materialCode: "CORN",
      label: "Corn — Iowa test",
      expectedUnit: "USD/bu",
      regionCode: "US-IA",
      query: {
        commodity_desc: "CORN",
        agg_level_desc: "STATE",
        state_alpha: "IA",
      },
    };
    const national = buildNassDraftForObservation(
      SAMPLE_SERIES,
      { year: "2025", reference_period_desc: "MAR", value: "4.25" },
      "nass_latest_observation",
    );
    const state = buildNassDraftForObservation(
      stateSeries,
      { year: "2025", reference_period_desc: "MAR", value: "4.40" },
      "nass_latest_observation",
    );
    assert.ok(national && state);
    // Same material + observed month, but the region scope diverges
    // so the runtime's natural-key dedupe keeps both rows.
    assert.equal(national.scopeMaterialCode, state.scopeMaterialCode);
    assert.equal(
      national.observedAt.toISOString(),
      state.observedAt.toISOString(),
    );
    assert.equal(national.scopeRegionCode, undefined);
    assert.equal(state.scopeRegionCode, "US-IA");
  });
});

describe("fetchUsdaNassBackfillDrafts", () => {
  it("throws a clear error when USDA_NASS_API_KEY is missing", async () => {
    const prev = process.env["USDA_NASS_API_KEY"];
    delete process.env["USDA_NASS_API_KEY"];
    try {
      await assert.rejects(
        () => fetchUsdaNassBackfillDrafts(),
        /USDA_NASS_API_KEY/,
      );
    } finally {
      if (prev !== undefined) process.env["USDA_NASS_API_KEY"] = prev;
    }
  });
});
