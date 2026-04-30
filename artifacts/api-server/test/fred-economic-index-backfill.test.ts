/**
 * Unit tests for the FRED economic index historical backfill helpers.
 *
 * These tests exercise the pure draft-building / observation-parsing
 * functions so the (live + backfill) draft fan-out can be validated
 * without a live HTTP call. The high-value invariants pinned here:
 *
 *   - The shared `buildFredDraftForObservation` produces the same
 *     `(signalType, scope, observedAt)` triple regardless of whether it
 *     was called by the live collector or the backfill, so the runtime's
 *     idempotent-insert dedupe correctly skips duplicates on re-run.
 *   - FRED's "." missing-value marker, blank rows, and unparseable dates
 *     all yield `null` (filtered out) instead of polluting the signal
 *     stream with NaN values.
 *   - `material` and `category` scope kinds map to the correct column
 *     (`scopeMaterialCode` vs `scopeCategoryCode`), so a FRED freight
 *     series doesn't accidentally land in the materials lane.
 *   - `fetchFredBackfillDrafts` throws a clear, actionable error when
 *     `FRED_API_KEY` is missing — mirroring the live collector's
 *     behavior so the audit log records the same root cause.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FRED_SERIES,
  buildFredDraftForObservation,
  fetchFredBackfillDrafts,
  type FredSeriesRef,
} from "../src/lib/intelligence/collectors/fred-economic-index";

const MATERIAL_SERIES: FredSeriesRef = {
  seriesId: "WPU101",
  label: "PPI: Iron and steel",
  scope: { kind: "material", code: "IRON_STEEL" },
  unit: "index",
};

const CATEGORY_SERIES: FredSeriesRef = {
  seriesId: "PCU484121484121",
  label: "PPI: General freight trucking, long-distance, truckload",
  scope: { kind: "category", code: "FREIGHT_TRUCKING_TL" },
  unit: "index",
};

describe("buildFredDraftForObservation", () => {
  it("emits an economic_index draft for a material-scoped series", () => {
    const draft = buildFredDraftForObservation(
      MATERIAL_SERIES,
      { date: "2024-01-15", value: "287.5" },
      "fred_historical_backfill",
    );
    assert.ok(draft, "draft should be produced for a valid observation");
    assert.equal(draft.signalType, "economic_index");
    assert.equal(draft.value, 287.5);
    assert.equal(draft.unit, "index");
    assert.equal(draft.currency, "USD");
    assert.equal(draft.scopeMaterialCode, "IRON_STEEL");
    assert.equal(draft.scopeCategoryCode, undefined);
    assert.equal(draft.observedAt.toISOString(), "2024-01-15T00:00:00.000Z");
    assert.equal(draft.metadata?.["seriesId"], "WPU101");
    assert.equal(draft.metadata?.["basis"], "fred_historical_backfill");
  });

  it("routes category-scoped series to scopeCategoryCode", () => {
    const draft = buildFredDraftForObservation(
      CATEGORY_SERIES,
      { date: "2024-02-15", value: "188.2" },
      "fred_historical_backfill",
    );
    assert.ok(draft);
    assert.equal(draft.scopeCategoryCode, "FREIGHT_TRUCKING_TL");
    assert.equal(draft.scopeMaterialCode, undefined);
  });

  it("returns null for FRED's '.' missing-value marker", () => {
    const draft = buildFredDraftForObservation(
      MATERIAL_SERIES,
      { date: "2024-01-15", value: "." },
      "fred_historical_backfill",
    );
    assert.equal(draft, null);
  });

  it("returns null for empty-string values", () => {
    const draft = buildFredDraftForObservation(
      MATERIAL_SERIES,
      { date: "2024-01-15", value: "" },
      "fred_historical_backfill",
    );
    assert.equal(draft, null);
  });

  it("returns null for non-numeric values rather than emitting NaN", () => {
    const draft = buildFredDraftForObservation(
      MATERIAL_SERIES,
      { date: "2024-01-15", value: "n/a" },
      "fred_historical_backfill",
    );
    assert.equal(draft, null);
  });

  it("returns null for an unparseable date instead of an Invalid Date", () => {
    const draft = buildFredDraftForObservation(
      MATERIAL_SERIES,
      { date: "not-a-date", value: "287.5" },
      "fred_historical_backfill",
    );
    assert.equal(draft, null);
  });

  it("backfill and live drafts share the same dedupe key for the same date", () => {
    // The runtime keys on (signalType, scopeMaterialCode, scopeCategoryCode,
    // ..., observedAt). If the basis tag accidentally drifted those, the
    // backfill would insert duplicates of rows the live collector wrote
    // earlier the same day. Pin that explicitly here.
    const live = buildFredDraftForObservation(
      MATERIAL_SERIES,
      { date: "2024-01-15", value: "287.5" },
      "fred_latest_observation",
    );
    const backfill = buildFredDraftForObservation(
      MATERIAL_SERIES,
      { date: "2024-01-15", value: "287.5" },
      "fred_historical_backfill",
    );
    assert.ok(live && backfill);
    assert.equal(live.signalType, backfill.signalType);
    assert.equal(live.scopeMaterialCode, backfill.scopeMaterialCode);
    assert.equal(live.scopeCategoryCode, backfill.scopeCategoryCode);
    assert.equal(
      live.observedAt.toISOString(),
      backfill.observedAt.toISOString(),
    );
    // The basis tag is the only meaningful difference in metadata.
    assert.notEqual(live.metadata?.["basis"], backfill.metadata?.["basis"]);
  });
});

describe("FRED_SERIES registry", () => {
  it("contains both material and category-scoped series", () => {
    const kinds = new Set(FRED_SERIES.map((s) => s.scope.kind));
    assert.ok(kinds.has("material"), "expected material-scoped series");
    assert.ok(kinds.has("category"), "expected category-scoped series");
  });

  it("has unique series ids and unique scope codes", () => {
    const seriesIds = new Set<string>();
    const scopeCodes = new Set<string>();
    for (const s of FRED_SERIES) {
      assert.ok(
        !seriesIds.has(s.seriesId),
        `duplicate seriesId ${s.seriesId}`,
      );
      seriesIds.add(s.seriesId);
      assert.ok(
        !scopeCodes.has(s.scope.code),
        `duplicate scope code ${s.scope.code}`,
      );
      scopeCodes.add(s.scope.code);
    }
  });
});

describe("fetchFredBackfillDrafts", () => {
  it("throws a clear error when FRED_API_KEY is missing", async () => {
    const prev = process.env["FRED_API_KEY"];
    delete process.env["FRED_API_KEY"];
    try {
      await assert.rejects(
        () => fetchFredBackfillDrafts(),
        /FRED_API_KEY/,
      );
    } finally {
      if (prev !== undefined) process.env["FRED_API_KEY"] = prev;
    }
  });
});
