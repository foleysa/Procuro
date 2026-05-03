/**
 * Unit + guardrail tests for the USGS Mineral Resources commodity
 * collector (task #245).
 *
 * Pure helpers — no live HTTP calls — covering:
 *
 *   - `parseUsgsYear` accepts numeric and string year cells in the
 *     plausible 1900..2200 range and rejects everything else.
 *   - `parseUsgsValue` strips thousands separators, tolerates revised /
 *     preliminary / estimate suffixes, and filters USGS suppression
 *     markers ("W", "NA", "(D)", "—").
 *   - `findYearColumn` and `findUnitValueColumn` correctly locate the
 *     header columns the parser needs, preferring the nominal-dollar
 *     unit-value column over the constant-dollar fallback.
 *   - `findHeaderRow` skips USGS title / notes rows and returns the
 *     row containing the literal "Year" header cell.
 *   - `buildUsgsDraftForObservation` produces the same `(signalType,
 *     scope, observedAt)` triple regardless of `basis`, so the
 *     runtime's idempotent-insert dedupe correctly skips duplicates
 *     between live and backfill runs.
 *   - The curated `USGS_MINERALS` list contains every critical mineral
 *     called out in task #245 (the guardrail mirroring task #69) and
 *     has unique material codes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  USGS_MINERALS,
  buildUsgsDraftForObservation,
  fetchUsgsMineralBackfillDrafts,
  findHeaderRow,
  findUnitValueColumn,
  findYearColumn,
  parseUsgsValue,
  parseUsgsYear,
  yearToObservedAt,
  type UsgsMineralRef,
} from "../src/lib/intelligence/collectors/usgs-mineral";
import type { MarketSignalDraft } from "../src/lib/intelligence/collector";

const SAMPLE_MINERAL: UsgsMineralRef = {
  materialCode: "LITHIUM",
  label: "Lithium — test",
  xlsxUrl: "https://example.invalid/ds140-lithi.xlsx",
  expectedUnit: "USD/t",
};

describe("parseUsgsYear", () => {
  it("accepts integer years in the plausible range", () => {
    assert.equal(parseUsgsYear(2024), 2024);
    assert.equal(parseUsgsYear(1900), 1900);
  });

  it("parses 4-digit string year prefixes (estimate/revised markers)", () => {
    assert.equal(parseUsgsYear("2023"), 2023);
    assert.equal(parseUsgsYear("1990 e"), 1990);
    assert.equal(parseUsgsYear("2018 r"), 2018);
  });

  it("rejects out-of-range and unparseable cells", () => {
    assert.equal(parseUsgsYear(1850), null);
    assert.equal(parseUsgsYear(2300), null);
    assert.equal(parseUsgsYear("notes"), null);
    assert.equal(parseUsgsYear(null), null);
    assert.equal(parseUsgsYear(undefined), null);
  });
});

describe("parseUsgsValue", () => {
  it("parses plain numbers and stripped strings", () => {
    assert.equal(parseUsgsValue(123.45), 123.45);
    assert.equal(parseUsgsValue("1,234"), 1234);
    assert.equal(parseUsgsValue("1,234.5"), 1234.5);
  });

  it("strips trailing estimate / revised / preliminary suffixes", () => {
    assert.equal(parseUsgsValue("123 e"), 123);
    assert.equal(parseUsgsValue("123 r"), 123);
    assert.equal(parseUsgsValue("123 p"), 123);
  });

  it("returns null for USGS suppression markers", () => {
    assert.equal(parseUsgsValue("W"), null);
    assert.equal(parseUsgsValue("NA"), null);
    assert.equal(parseUsgsValue("(D)"), null);
    assert.equal(parseUsgsValue("—"), null);
  });

  it("returns null for empty and non-numeric inputs", () => {
    assert.equal(parseUsgsValue(""), null);
    assert.equal(parseUsgsValue("   "), null);
    assert.equal(parseUsgsValue(undefined), null);
    assert.equal(parseUsgsValue(null), null);
  });
});

describe("findYearColumn / findUnitValueColumn / findHeaderRow", () => {
  it("locates the Year column by literal header text", () => {
    const header = ["Year", "Production", "Unit value, dollars per ton"];
    assert.equal(findYearColumn(header), 0);
  });

  it("returns -1 when no Year column is present", () => {
    assert.equal(findYearColumn(["Production", "Imports"]), -1);
  });

  it("prefers the nominal-dollar unit-value column over constant-dollar", () => {
    const header = [
      "Year",
      "Production",
      "Unit value, 98 dollars per ton",
      "Unit value, dollars per ton",
    ];
    // The nominal column (idx 3) must win over the constant-dollar
    // column (idx 2) — otherwise downstream trend charts compare
    // current-year prices against deflated historical values.
    assert.equal(findUnitValueColumn(header), 3);
  });

  it("falls back to the constant-dollar column when only it is present", () => {
    const header = ["Year", "Production", "Unit value, 98 dollars per ton"];
    assert.equal(findUnitValueColumn(header), 2);
  });

  it("skips USGS title/notes rows and finds the real header row", () => {
    const rows = [
      ["Lithium statistics"],
      ["Source: USGS, Mineral Commodity Summaries"],
      [],
      ["Year", "Production", "Unit value, dollars per ton"],
      [2024, 1000, 12500],
    ];
    assert.equal(findHeaderRow(rows), 3);
  });

  it("returns -1 when no header row exists in the first 30 rows", () => {
    const rows = Array.from({ length: 5 }, () => ["notes", "more notes"]);
    assert.equal(findHeaderRow(rows), -1);
  });
});

describe("yearToObservedAt", () => {
  it("anchors a year to the last instant of December UTC", () => {
    assert.equal(
      yearToObservedAt(2024).toISOString(),
      "2024-12-31T23:59:59.000Z",
    );
  });
});

describe("buildUsgsDraftForObservation", () => {
  it("emits a commodity_index draft scoped to the mineral's material code", () => {
    const draft = buildUsgsDraftForObservation(
      SAMPLE_MINERAL,
      2024,
      12500,
      "usgs_historical_backfill",
    );
    assert.equal(draft.signalType, "commodity_index");
    assert.equal(draft.scopeMaterialCode, "LITHIUM");
    assert.equal(draft.scopeCategoryCode, undefined);
    assert.equal(draft.value, 12500);
    assert.equal(draft.unit, "USD/t");
    assert.equal(draft.currency, "USD");
    assert.equal(draft.observedAt.toISOString(), "2024-12-31T23:59:59.000Z");
    assert.equal(draft.metadata?.["basis"], "usgs_historical_backfill");
    assert.equal(draft.metadata?.["year"], "2024");
    assert.equal(draft.metadata?.["upstreamXlsxUrl"], SAMPLE_MINERAL.xlsxUrl);
  });

  it("backfill and live drafts share the same dedupe key for the same year", () => {
    // Runtime dedupe keys on (signalType, scopeMaterialCode, ...,
    // observedAt). If `basis` accidentally drifted those fields, the
    // backfill would insert duplicates of rows the live collector
    // wrote earlier the same day. Pin it here.
    const live = buildUsgsDraftForObservation(
      SAMPLE_MINERAL,
      2024,
      12500,
      "usgs_latest_observation",
    );
    const backfill = buildUsgsDraftForObservation(
      SAMPLE_MINERAL,
      2024,
      12500,
      "usgs_historical_backfill",
    );
    assert.equal(live.signalType, backfill.signalType);
    assert.equal(live.scopeMaterialCode, backfill.scopeMaterialCode);
    assert.equal(
      live.observedAt.toISOString(),
      backfill.observedAt.toISOString(),
    );
    assert.notEqual(live.metadata?.["basis"], backfill.metadata?.["basis"]);
  });
});

/**
 * Networked smoke probe — guards against the failure mode that nearly
 * shipped a non-functional collector: USGS rotated its DS-140 download
 * paths from `/atoms/files/ds140-{slug5}.xlsx` to
 * `/s3fs-public/media/files/ds140-{commodity}-{year}.xlsx` and the
 * stale URLs returned 403. A pure-helper test cannot catch a
 * curated-URL regression like that — only a real fetch + parse can.
 *
 * Why it goes through `fetchUsgsMineralBackfillDrafts` instead of just
 * `fetchUsgsWorkbook` + `parseUsgsWorkbook`: task #257 calls out that
 * a workbook layout drift (header row moves, "Unit value" gets
 * relabelled) would silently produce 0-row runs and only surface
 * after the 14-day stale-empty alert. Asserting that the *collector*
 * — fetch + parse + draft build — emits ≥1 `MarketSignalDraft` per
 * mineral catches drift at the same boundary the runtime sees, so
 * any per-mineral regression (URL 403, layout change, value-column
 * disappears) fails this probe loudly with a per-mineral test name.
 *
 * Runs the full backfill once (one HTTP fetch per mineral, shared
 * across all subtests) and then asserts per mineral so a single bad
 * workbook fails its own subtest with a clear materialCode in the
 * test name without aborting the rest of the suite.
 *
 * Opt-in via `USGS_LIVE=1` so day-to-day CI doesn't depend on the
 * USGS S3 origin being reachable; run it from the scheduled
 * `pnpm --filter @workspace/api-server run test:usgs-live` canary
 * slot.
 */
describe("USGS DS-140 live URL probe (USGS_LIVE=1 only)", () => {
  const live = process.env["USGS_LIVE"] === "1";

  let drafts: MarketSignalDraft[] = [];
  let failedMinerals: Array<{ materialCode: string; error: string }> = [];
  let probeError: Error | null = null;
  let probed = false;

  async function ensureProbe(): Promise<void> {
    if (probed) return;
    probed = true;
    try {
      const result = await fetchUsgsMineralBackfillDrafts();
      drafts = result.drafts;
      failedMinerals = result.failedMinerals;
    } catch (err) {
      probeError = err instanceof Error ? err : new Error(String(err));
    }
  }

  for (const mineral of USGS_MINERALS) {
    it(`emits ≥1 draft for ${mineral.materialCode} from ${mineral.xlsxUrl}`, async (t) => {
      if (!live) {
        t.skip("set USGS_LIVE=1 to run the networked probe");
        return;
      }
      await ensureProbe();
      assert.equal(
        probeError,
        null,
        `live probe threw before per-mineral assertions: ${probeError?.message ?? ""}`,
      );

      // Per-mineral fetch failure (HTTP 403, DNS, etc.) — surface the
      // upstream error message so an operator can repair the curated
      // URL without re-running the probe to discover what broke.
      const failure = failedMinerals.find(
        (f) => f.materialCode === mineral.materialCode,
      );
      assert.equal(
        failure,
        undefined,
        `${mineral.materialCode} fetch failed: ${failure?.error ?? ""}. ` +
          `Curated xlsxUrl probably needs to be re-resolved from ${mineral.xlsxUrl}.`,
      );

      // Per-mineral parse / layout drift — fetch succeeded but the
      // workbook produced 0 drafts. This is the silent-data-loss
      // failure mode task #257 exists to catch.
      const mineralDrafts = drafts.filter(
        (d) => d.scopeMaterialCode === mineral.materialCode,
      );
      assert.ok(
        mineralDrafts.length > 0,
        `expected ≥1 MarketSignalDraft for ${mineral.materialCode}; got 0 — ` +
          `likely a DS-140 workbook layout drift (header row moved, "Year"/` +
          `"Unit value" relabelled). Inspect ${mineral.xlsxUrl} and update ` +
          `findHeaderRow / findUnitValueColumn / findYearColumn as needed.`,
      );

      // Sanity check: at least one draft must be from a plausibly
      // recent year — guards against a parser that picks the wrong
      // column index and emits 1900-only rows from a notes column.
      const maxYear = Math.max(
        ...mineralDrafts.map((d) =>
          Number(d.metadata?.["year"] ?? d.observedAt.getUTCFullYear()),
        ),
      );
      assert.ok(
        maxYear >= 2015,
        `${mineral.materialCode} latest draft year ${maxYear} < 2015 — ` +
          `parser is reading the wrong column`,
      );
    });
  }
});

describe("USGS_MINERALS guardrail (task #245 curated list)", () => {
  it("includes every critical mineral called out in the task brief", () => {
    // Mirror of the task #245 brief: lithium, cobalt, nickel, copper,
    // aluminum, rare earth elements, graphite. Pinning the codes here
    // means a future refactor that silently drops one fails CI loudly
    // — same pattern as the task #69 / NASS guardrail.
    const codes = new Set(USGS_MINERALS.map((m) => m.materialCode));
    for (const required of [
      "LITHIUM",
      "COBALT",
      "NICKEL_USGS",
      "COPPER_USGS",
      "ALUMINUM_USGS",
      "RARE_EARTHS",
      "GRAPHITE",
    ]) {
      assert.ok(codes.has(required), `missing curated mineral ${required}`);
    }
  });

  it("has unique material codes", () => {
    const seen = new Set<string>();
    for (const m of USGS_MINERALS) {
      assert.ok(
        !seen.has(m.materialCode),
        `duplicate material code ${m.materialCode}`,
      );
      seen.add(m.materialCode);
    }
  });

  it("every mineral declares a USD-denominated expected unit and a USGS S3 xlsx URL", () => {
    for (const m of USGS_MINERALS) {
      assert.match(
        m.expectedUnit,
        /^USD\//,
        `mineral ${m.materialCode} should be USD-denominated`,
      );
      assert.match(
        m.xlsxUrl,
        /^https:\/\/.+\.xlsx$/,
        `mineral ${m.materialCode} xlsxUrl should be an https .xlsx URL`,
      );
    }
  });
});
