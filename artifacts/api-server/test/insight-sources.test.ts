/**
 * Locks down the contract of the server-side citation helpers used by
 * the opportunity / cycle read paths.
 *
 * The two functions under test sit on the read path and never touch the
 * database, so we exercise them directly with synthetic JSON shaped like
 * what the analyzers persist into `opportunities.inputs`. Regressions
 * here would be invisible to the API integration tests — a malformed
 * historical row would silently 500 the read, or duplicate citations
 * would pile up at the cycle level.
 *
 * Coverage matrix (from task #105):
 *   - `extractSourcesFromInputs` rejects malformed entries (missing
 *     keys, wrong types, unknown enum values, non-parseable timestamps)
 *     while letting the well-formed siblings through.
 *   - `dedupeSources` keeps the most recent observation per
 *     (collectorId, sourceUrl) and is stable across repeated calls.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  extractSourcesFromInputs,
  dedupeSources,
  type InsightSource,
} from "../src/lib/insight-sources";

// ---- fixtures -----------------------------------------------------------

const VALID_CONTRACT = {
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "US",
  retentionDays: 365,
  tenantOptInDefault: true,
} as const;

function validSource(overrides: Partial<InsightSource> = {}): InsightSource {
  return {
    collectorId: "fred",
    collectorName: "FRED — US Federal Reserve Economic Data",
    sourceUrl: "https://fred.stlouisfed.org/series/PPIACO",
    observedAt: "2026-01-15T00:00:00.000Z",
    contract: { ...VALID_CONTRACT },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractSourcesFromInputs
// ---------------------------------------------------------------------------

test("extractSourcesFromInputs returns [] when inputs is null/undefined or has no sources field", () => {
  assert.deepEqual(extractSourcesFromInputs(null), []);
  assert.deepEqual(extractSourcesFromInputs(undefined), []);
  assert.deepEqual(extractSourcesFromInputs({}), []);
  // `sources` present but not an array — must not throw, must not coerce.
  assert.deepEqual(extractSourcesFromInputs({ sources: "not-an-array" }), []);
  assert.deepEqual(extractSourcesFromInputs({ sources: { not: "array" } }), []);
});

test("extractSourcesFromInputs returns the well-formed entries verbatim", () => {
  const a = validSource({ collectorId: "fred", sourceUrl: "https://a.test" });
  const b = validSource({
    collectorId: "ecb",
    collectorName: "ECB FX",
    sourceUrl: "https://b.test",
    observedAt: "2026-02-01T00:00:00.000Z",
    contract: { ...VALID_CONTRACT, disclosureTier: "T2", jurisdiction: "EU" },
  });
  const out = extractSourcesFromInputs({ sources: [a, b] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], a);
  assert.deepEqual(out[1], b);
});

test("extractSourcesFromInputs drops malformed entries but keeps valid siblings", () => {
  const valid = validSource();
  const inputs = {
    sources: [
      // 1) entirely the wrong shape — primitives, arrays, nulls.
      null,
      "not-an-object",
      42,
      [],
      // 2) missing required string fields.
      { ...valid, collectorId: undefined },
      { ...valid, collectorName: undefined },
      { ...valid, sourceUrl: undefined },
      { ...valid, observedAt: undefined },
      // 3) wrong types on required fields.
      { ...valid, collectorId: 123 },
      { ...valid, sourceUrl: { not: "a string" } },
      { ...valid, observedAt: 1737000000000 }, // numeric epoch — schema demands a string
      // 4) unparseable observedAt — would render as "Invalid Date" in the UI.
      { ...valid, observedAt: "totally-not-a-date" },
      // 5) missing or wrong contract.
      { ...valid, contract: undefined },
      { ...valid, contract: null },
      { ...valid, contract: "string-instead-of-object" },
      // 6) unknown enum values inside contract.
      {
        ...valid,
        contract: { ...VALID_CONTRACT, postureClass: "stealth" },
      },
      {
        ...valid,
        contract: { ...VALID_CONTRACT, disclosureTier: "T9" },
      },
      // 7) wrong types inside contract.
      {
        ...valid,
        contract: { ...VALID_CONTRACT, retentionDays: "365" },
      },
      {
        ...valid,
        contract: { ...VALID_CONTRACT, tenantOptInDefault: "yes" },
      },
      {
        ...valid,
        contract: { ...VALID_CONTRACT, jurisdiction: 42 },
      },
      // …finally, one valid sibling at the end so we know good rows still
      // make it through after a long run of bad ones.
      valid,
    ],
  };

  const out = extractSourcesFromInputs(inputs);
  assert.equal(
    out.length,
    1,
    "every malformed entry must be silently dropped",
  );
  assert.deepEqual(out[0], valid);
});

// ---------------------------------------------------------------------------
// dedupeSources
// ---------------------------------------------------------------------------

test("dedupeSources is a no-op when every (collectorId, sourceUrl) pair is unique", () => {
  const a = validSource({ collectorId: "fred", sourceUrl: "https://a.test" });
  const b = validSource({ collectorId: "fred", sourceUrl: "https://b.test" });
  const c = validSource({ collectorId: "ecb", sourceUrl: "https://a.test" });

  const out = dedupeSources([a, b, c]);
  assert.equal(out.length, 3);
  // Output is name-sorted for stable cycle-level rendering — the exact
  // order matters because the citation list is part of the response shape.
  const names = out.map((s) => s.collectorName);
  assert.deepEqual(names, [...names].sort((x, y) => x.localeCompare(y)));
});

test("dedupeSources keeps the most recent observation per (collectorId, sourceUrl)", () => {
  // Three rows pointing at the same upstream series, observed at three
  // different points in time. The folder MUST keep the newest one — the
  // cycle's "FRED PPI" citation should reflect the most recent refresh,
  // not the oldest fixture in the inputs.
  const oldest = validSource({
    collectorId: "fred",
    sourceUrl: "https://fred.stlouisfed.org/series/PPIACO",
    observedAt: "2025-01-01T00:00:00.000Z",
    collectorName: "FRED stale label",
  });
  const middle = validSource({
    collectorId: "fred",
    sourceUrl: "https://fred.stlouisfed.org/series/PPIACO",
    observedAt: "2025-06-01T00:00:00.000Z",
    collectorName: "FRED middle label",
  });
  const newest = validSource({
    collectorId: "fred",
    sourceUrl: "https://fred.stlouisfed.org/series/PPIACO",
    observedAt: "2026-02-01T00:00:00.000Z",
    collectorName: "FRED current label",
  });

  // Try every input order to prove ordering of the source list is
  // irrelevant to the dedupe outcome.
  for (const order of [
    [oldest, middle, newest],
    [newest, middle, oldest],
    [middle, newest, oldest],
    [oldest, newest, middle],
  ]) {
    const out = dedupeSources(order);
    assert.equal(out.length, 1, "same (collectorId, sourceUrl) must collapse to one row");
    assert.equal(out[0]!.observedAt, newest.observedAt);
    assert.equal(out[0]!.collectorName, "FRED current label");
  }
});

test("dedupeSources treats different collectorIds at the same URL as distinct", () => {
  // A re-publishing collector might land at the same URL as the
  // canonical one. They must not collapse — different `collectorId`s
  // can have legitimately different contracts (posture/jurisdiction).
  const sharedUrl = "https://example.test/shared";
  const fred = validSource({ collectorId: "fred", sourceUrl: sharedUrl });
  const mirror = validSource({
    collectorId: "fred-mirror",
    sourceUrl: sharedUrl,
  });

  const out = dedupeSources([fred, mirror]);
  assert.equal(out.length, 2);
});

test("dedupeSources treats different URLs from the same collector as distinct", () => {
  const a = validSource({
    collectorId: "fred",
    sourceUrl: "https://fred.stlouisfed.org/series/PPIACO",
  });
  const b = validSource({
    collectorId: "fred",
    sourceUrl: "https://fred.stlouisfed.org/series/WPU101",
  });
  const out = dedupeSources([a, b]);
  assert.equal(out.length, 2);
});

test("dedupeSources is stable: re-applying the result is a no-op", () => {
  // Idempotency matters because cycle pages re-fold per request — if
  // running dedupe over the result returned a different list, we'd
  // see citation churn between hits even when nothing has changed.
  const inputs: InsightSource[] = [
    validSource({
      collectorId: "fred",
      sourceUrl: "https://a.test",
      observedAt: "2025-01-01T00:00:00.000Z",
    }),
    validSource({
      collectorId: "fred",
      sourceUrl: "https://a.test",
      observedAt: "2026-01-01T00:00:00.000Z",
    }),
    validSource({
      collectorId: "ecb",
      sourceUrl: "https://b.test",
      observedAt: "2026-02-01T00:00:00.000Z",
    }),
  ];
  const first = dedupeSources(inputs);
  const second = dedupeSources(first);
  assert.deepEqual(second, first);
});

test("dedupeSources tolerates an empty input", () => {
  assert.deepEqual(dedupeSources([]), []);
});
