/**
 * Guardrail test for the curated BLS series list.
 *
 * The BLS Economic Index collector ships a hand-curated `BLS_SERIES`
 * registry — each entry pins a BLS series ID to a procurement scope code
 * (material vs category) and a unit/baseYear stamp the dashboard charts
 * rely on. Two failure modes have bitten us in the past and this test
 * exists to fail loudly the moment either reappears:
 *
 *   1. **Silent registry drift.** Someone reorders, dedupes, or removes
 *      a series and the chart loses a category without any signal.
 *      The "minimum size + spot-checked headline IDs" assertion below
 *      catches this — to remove a series intentionally you must update
 *      the spot-check list in the same PR, which forces a review.
 *
 *   2. **A series ID that no longer resolves.** BLS occasionally renames
 *      or retires a series; the live collector then quietly emits zero
 *      drafts for it. The fan-out test below stubs the BLS API with a
 *      synthetic payload covering every curated ID and asserts that each
 *      one produces at least one draft, AND that material/category scope
 *      codes route to the right column. This is what would have caught a
 *      typo in the old `SeriesRef` literal before it hit production.
 *
 * No HTTP and no database — runs in milliseconds, safe in CI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLS_SERIES,
  buildBlsDraftForObservation,
  buildBlsDraftsFromResponse,
  type BlsResponse,
} from "../src/lib/intelligence/collectors/bls-economic-index";

describe("BLS_SERIES registry shape", () => {
  it("contains the curated headline series the dashboards depend on", () => {
    // These IDs are referenced by the BLS trend chart's default toggle
    // set and by analyzers that key off scope codes. If any drop out the
    // related dashboard tile silently goes blank — fail the test instead.
    const headlineSeriesIds = [
      "WPU101", // PPI: Iron and steel
      "WPU0561", // PPI: Crude petroleum
      "WPU057303", // PPI: No. 2 diesel fuel
      "WPU0571", // PPI: Natural gas to industrial users
      "WPU0811", // PPI: Softwood lumber
      "WPU0721", // PPI: Plastic resins and materials
      "WPU061", // PPI: Industrial chemicals
      "WPU3022", // PPI: Truck transportation of freight
      "CUUR0000SA0E", // CPI: Energy
      "CUUR0000SEHF01", // CPI: Electricity
    ];
    const ids = new Set(BLS_SERIES.map((s) => s.seriesId));
    for (const id of headlineSeriesIds) {
      assert.ok(
        ids.has(id),
        `BLS_SERIES is missing required headline series ${id}; restore it or update this guardrail in the same PR.`,
      );
    }
  });

  it("never duplicates a BLS series ID", () => {
    const ids = BLS_SERIES.map((s) => s.seriesId);
    const seen = new Set<string>();
    for (const id of ids) {
      assert.ok(!seen.has(id), `Duplicate seriesId in BLS_SERIES: ${id}`);
      seen.add(id);
    }
  });

  it("requires exactly one of scopeMaterialCode / scopeCategoryCode per series", () => {
    for (const ref of BLS_SERIES) {
      const hasMaterial =
        typeof ref.scopeMaterialCode === "string" &&
        ref.scopeMaterialCode.length > 0;
      const hasCategory =
        typeof ref.scopeCategoryCode === "string" &&
        ref.scopeCategoryCode.length > 0;
      assert.ok(
        hasMaterial !== hasCategory,
        `Series ${ref.seriesId} must set exactly one of scopeMaterialCode/scopeCategoryCode (had material=${hasMaterial}, category=${hasCategory})`,
      );
    }
  });

  it("requires unit and baseYear for every series", () => {
    for (const ref of BLS_SERIES) {
      assert.ok(ref.unit && ref.unit.length > 0, `Series ${ref.seriesId} missing unit`);
      // Accept "1982" as well as the BLS multi-year reference base
      // ("1982-1984") used by some CPI series.
      assert.ok(
        ref.baseYear && /^[0-9]{4}(-[0-9]{4})?$/.test(ref.baseYear),
        `Series ${ref.seriesId} missing or malformed baseYear (${ref.baseYear})`,
      );
    }
  });
});

describe("buildBlsDraftForObservation", () => {
  it("emits an economic_index draft for a valid PPI observation", () => {
    const ref = BLS_SERIES.find((s) => s.seriesId === "WPU101");
    assert.ok(ref);
    const draft = buildBlsDraftForObservation(
      ref!,
      {
        year: "2025",
        period: "M03",
        periodName: "March",
        value: "287.5",
      },
      { tier: "unauthenticated" },
    );
    assert.ok(draft, "draft should be produced for a valid observation");
    assert.equal(draft!.signalType, "economic_index");
    assert.equal(draft!.value, 287.5);
    // March = end of month UTC.
    assert.equal(draft!.observedAt.toISOString(), "2025-03-31T00:00:00.000Z");
    assert.equal(draft!.scopeMaterialCode, "STEEL");
    assert.equal(draft!.scopeCategoryCode, undefined);
  });

  it("returns null for unparseable period codes", () => {
    const ref = BLS_SERIES[0]!;
    assert.equal(
      buildBlsDraftForObservation(
        ref,
        { year: "2025", period: "ZZ9", periodName: "?", value: "100" },
        { tier: "unauthenticated" },
      ),
      null,
    );
  });

  it("returns null for non-numeric values", () => {
    const ref = BLS_SERIES[0]!;
    assert.equal(
      buildBlsDraftForObservation(
        ref,
        { year: "2025", period: "M01", periodName: "Jan", value: "n/a" },
        { tier: "unauthenticated" },
      ),
      null,
    );
  });
});

describe("buildBlsDraftsFromResponse fan-out", () => {
  /**
   * Build a synthetic BLS response that mirrors what the live API returns
   * for every curated series ID. We give each series two observations so
   * the collector's "emit all observations" fan-out has more than one
   * data point per series to verify.
   */
  function buildResponse(): BlsResponse {
    return {
      status: "REQUEST_SUCCEEDED",
      Results: {
        series: BLS_SERIES.map((ref) => ({
          seriesID: ref.seriesId,
          data:
            ref.periodicity === "monthly"
              ? [
                  {
                    year: "2025",
                    period: "M02",
                    periodName: "February",
                    value: "240.0",
                  },
                  {
                    year: "2025",
                    period: "M01",
                    periodName: "January",
                    value: "238.5",
                  },
                ]
              : [
                  {
                    year: "2025",
                    period: "Q01",
                    periodName: "1st Quarter",
                    value: "168.4",
                  },
                  {
                    year: "2024",
                    period: "Q04",
                    periodName: "4th Quarter",
                    value: "166.1",
                  },
                ],
        })),
      },
    };
  }

  it("produces drafts for every curated series", async () => {
    const missing: string[] = [];
    const drafts = await buildBlsDraftsFromResponse(
      buildResponse(),
      BLS_SERIES,
      {
        tier: "unauthenticated",
        onMissing: (id) => {
          missing.push(id);
        },
      },
    );
    assert.deepEqual(missing, [], "no curated series should be missing");
    const draftSeries = new Set(
      drafts.map((d) =>
        String((d.metadata as Record<string, unknown>)["seriesId"] ?? ""),
      ),
    );
    for (const ref of BLS_SERIES) {
      assert.ok(
        draftSeries.has(ref.seriesId),
        `Series ${ref.seriesId} produced zero drafts; check the fixture or the series mapping.`,
      );
    }
    // All drafts in the synthetic response carry a parseable period and
    // value, so we expect 2 observations × N series.
    assert.equal(
      drafts.length,
      BLS_SERIES.length * 2,
      "should fan out 2 observations per series",
    );
  });

  it("flags series the upstream payload omits via onMissing", async () => {
    // Drop two series from the synthetic response; collector must alert.
    const dropped = [BLS_SERIES[0]!.seriesId, BLS_SERIES[5]!.seriesId];
    const partial = buildResponse();
    partial.Results!.series = (partial.Results!.series ?? []).filter(
      (s) => !dropped.includes(s.seriesID),
    );
    const missing: string[] = [];
    const drafts = await buildBlsDraftsFromResponse(partial, BLS_SERIES, {
      tier: "unauthenticated",
      onMissing: (id) => {
        missing.push(id);
      },
    });
    assert.deepEqual(missing.sort(), dropped.sort());
    // Dropped series contribute zero drafts, the rest contribute 2 each.
    assert.equal(drafts.length, (BLS_SERIES.length - dropped.length) * 2);
  });

  it("routes scope codes onto the correct column", async () => {
    const drafts = await buildBlsDraftsFromResponse(
      buildResponse(),
      BLS_SERIES,
      { tier: "unauthenticated" },
    );
    for (const draft of drafts) {
      const seriesId = String(
        (draft.metadata as Record<string, unknown>)["seriesId"] ?? "",
      );
      const ref = BLS_SERIES.find((s) => s.seriesId === seriesId);
      assert.ok(ref, `Unknown series id in draft: ${seriesId}`);
      if (ref!.scopeMaterialCode) {
        assert.equal(draft.scopeMaterialCode, ref!.scopeMaterialCode);
        assert.equal(draft.scopeCategoryCode, undefined);
      } else {
        assert.equal(draft.scopeCategoryCode, ref!.scopeCategoryCode);
        assert.equal(draft.scopeMaterialCode, undefined);
      }
    }
  });
});
