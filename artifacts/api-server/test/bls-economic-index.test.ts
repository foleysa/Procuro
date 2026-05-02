/**
 * Guardrail test that exercises `blsEconomicIndexCollector.collect`
 * end-to-end with a mocked `fetch`, complementing the registry-shape +
 * pure draft fan-out checks already pinned in
 * `bls-economic-index-series-guardrail.test.ts`.
 *
 * The high-value invariants pinned here:
 *
 *   - Every entry in `BLS_SERIES` sets exactly one of
 *     `scopeCategoryCode` / `scopeMaterialCode`. A new series added
 *     without a scope code would otherwise emit an un-scoped signal that
 *     no analyzer can join against.
 *   - The collector chunks its requests so it never asks the BLS API for
 *     more than `BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED` (25) series
 *     in a single POST. Without chunking, an operator without a
 *     `BLS_API_KEY` would silently get the registry truncated to 25
 *     series upstream.
 *   - A canned BLS response containing one PPI (monthly), one CPI
 *     (monthly) and one ECI (quarterly) series each round-trip into a
 *     well-formed `MarketSignalDraft` with the expected scope column,
 *     unit, and period-end `observedAt`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLS_API_SERIES_PER_REQUEST_AUTHENTICATED,
  BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED,
  BLS_API_URL,
  BLS_SERIES,
  blsEconomicIndexCollector,
  type BlsResponse,
  type BlsSeriesResult,
} from "../src/lib/intelligence/collectors/bls-economic-index";

/**
 * Sample (seriesId, period, value) fixtures for the three series
 * families the collector curates. Picked so each family's expected
 * (scope code, unit, period-end observedAt) shape is distinct enough
 * that a regression in scope routing or `periodEndUtc` would be
 * unambiguous in the assertion failure.
 */
const PPI_SAMPLE = {
  seriesId: "WPU101",
  scopeMaterialCode: "STEEL",
  unit: "index_1982=100",
  obs: { year: "2025", period: "M03", periodName: "March", value: "287.5" },
  expectedObservedAt: "2025-03-31T00:00:00.000Z",
} as const;

const CPI_SAMPLE = {
  seriesId: "CUUR0000SA0E",
  scopeCategoryCode: "ENERGY",
  unit: "index_1982-84=100",
  obs: { year: "2025", period: "M02", periodName: "February", value: "302.4" },
  // February 2025 → last day of Feb (non-leap) = 2025-02-28 UTC.
  expectedObservedAt: "2025-02-28T00:00:00.000Z",
} as const;

const ECI_SAMPLE = {
  seriesId: "CIU1010000000000I",
  scopeCategoryCode: "LABOR_TOTAL_COMP",
  unit: "index_dec2005=100",
  obs: { year: "2025", period: "Q01", periodName: "1st Quarter", value: "168.4" },
  expectedObservedAt: "2025-03-31T00:00:00.000Z",
} as const;

/**
 * Build a canned BLS API response that the mocked `fetch` returns.
 *
 * The collector's draft fan-out walks `BLS_SERIES` and asks for one
 * upstream series per unique `seriesId`, so the response includes one
 * `BlsSeriesResult` per unique id in the registry. Series that match
 * one of our three samples carry the sample observation; everything
 * else gets a single innocuous monthly/quarterly observation so the
 * collector's "missing series" warning path doesn't fire (we'd record
 * those to the audit log via the DB and pollute the test).
 */
function buildCannedResponse(seriesIdsForChunk: readonly string[]): BlsResponse {
  const samples: Record<string, BlsSeriesResult> = {
    [PPI_SAMPLE.seriesId]: {
      seriesID: PPI_SAMPLE.seriesId,
      data: [PPI_SAMPLE.obs],
    },
    [CPI_SAMPLE.seriesId]: {
      seriesID: CPI_SAMPLE.seriesId,
      data: [CPI_SAMPLE.obs],
    },
    [ECI_SAMPLE.seriesId]: {
      seriesID: ECI_SAMPLE.seriesId,
      data: [ECI_SAMPLE.obs],
    },
  };
  const series: BlsSeriesResult[] = [];
  for (const id of seriesIdsForChunk) {
    if (samples[id]) {
      series.push(samples[id]);
      continue;
    }
    // Look up the registry entry's periodicity so the filler obs uses a
    // period code (`M01` vs `Q01`) the collector can parse for that
    // series. Otherwise `buildBlsDraftForObservation` would return null
    // and trigger an audit-log write via `onMissing`.
    const ref = BLS_SERIES.find((s) => s.seriesId === id);
    const period = ref?.periodicity === "quarterly" ? "Q01" : "M01";
    const periodName = period === "Q01" ? "1st Quarter" : "January";
    series.push({
      seriesID: id,
      data: [{ year: "2025", period, periodName, value: "100.0" }],
    });
  }
  return {
    status: "REQUEST_SUCCEEDED",
    Results: { series },
  };
}

/** Capture of the chunked POSTs the collector issues to the BLS API. */
interface CapturedRequest {
  url: string;
  body: { seriesid: string[]; startyear: string; endyear: string; registrationkey?: string };
}

/**
 * Replace `globalThis.fetch` with a stub that returns canned BLS
 * responses. Returns the captured POSTs and a `restore` callback the
 * caller must invoke (e.g. in a `t.after` hook) to put the original
 * `fetch` back so subsequent tests don't see the stub.
 */
function stubBlsFetch(): { captured: CapturedRequest[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const captured: CapturedRequest[] = [];
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
    if (url === BLS_API_URL) {
      const bodyText =
        typeof init?.body === "string" ? init.body : String(init?.body ?? "");
      const parsed = JSON.parse(bodyText) as CapturedRequest["body"];
      captured.push({ url, body: parsed });
      const json = buildCannedResponse(parsed.seriesid);
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

describe("BLS_SERIES scope-routing guardrail", () => {
  it("requires exactly one of scopeCategoryCode / scopeMaterialCode per series", () => {
    // A series added without a scope code would land as an un-scoped
    // signal that no analyzer can join against. Pin it here so a bad
    // PR fails CI rather than silently dropping the signal at runtime.
    for (const ref of BLS_SERIES) {
      const hasMaterial =
        typeof ref.scopeMaterialCode === "string" &&
        ref.scopeMaterialCode.length > 0;
      const hasCategory =
        typeof ref.scopeCategoryCode === "string" &&
        ref.scopeCategoryCode.length > 0;
      assert.ok(
        hasMaterial !== hasCategory,
        `Series ${ref.seriesId} must set exactly one of scopeMaterialCode / scopeCategoryCode (had material=${hasMaterial}, category=${hasCategory})`,
      );
    }
  });
});

describe("blsEconomicIndexCollector.collect chunking guardrail", () => {
  it("never asks BLS for more than the unauthenticated per-request cap (25) of series in a single POST", async () => {
    // Without `BLS_API_KEY`, BLS rejects POSTs that exceed
    // `BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED` (25) and silently
    // drops the overflow series. The collector compensates by chunking,
    // so the assertion here is two-fold:
    //   1) every captured POST stays within the cap, and
    //   2) the union of series IDs across chunks covers every unique
    //      `seriesId` in the registry — i.e. nothing was dropped.
    const prevKey = process.env["BLS_API_KEY"];
    // Force the unauthenticated branch (so the smaller 25-series cap
    // applies) without triggering the no-key audit log write that would
    // otherwise hit Postgres in unit-test context.
    delete process.env["BLS_API_KEY"];

    const { captured, restore } = stubBlsFetch();
    try {
      // The unauthenticated path also tries to record an audit-log
      // warning row when no key is set. Stub the DB insert away so this
      // test stays a pure unit test (no DATABASE_URL required).
      const dbModule = await import("@workspace/db");
      const realInsert = dbModule.db.insert;
      (dbModule.db as { insert: typeof realInsert }).insert = ((
        ..._args: Parameters<typeof realInsert>
      ) => ({
        values: async () => ({ rowCount: 0 }),
      })) as unknown as typeof realInsert;
      try {
        await blsEconomicIndexCollector.collect({ since: null });
      } finally {
        (dbModule.db as { insert: typeof realInsert }).insert = realInsert;
      }
    } finally {
      restore();
      if (prevKey === undefined) delete process.env["BLS_API_KEY"];
      else process.env["BLS_API_KEY"] = prevKey;
    }

    assert.ok(
      captured.length > 0,
      "collector should issue at least one POST to the BLS API",
    );

    // 1) per-chunk cap
    for (const req of captured) {
      assert.ok(
        Array.isArray(req.body.seriesid),
        `request body must include a seriesid array; got ${JSON.stringify(req.body)}`,
      );
      assert.ok(
        req.body.seriesid.length <= BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED,
        `unauth POST asked for ${req.body.seriesid.length} series, exceeding cap ${BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED}`,
      );
      assert.equal(
        req.body.registrationkey,
        undefined,
        "unauthenticated chunk must not include a registrationkey",
      );
    }

    // 2) union covers every unique seriesId in the registry — nothing
    //    silently dropped on the way out.
    const requested = new Set<string>();
    for (const req of captured) {
      for (const id of req.body.seriesid) requested.add(id);
    }
    const expected = new Set(BLS_SERIES.map((s) => s.seriesId));
    for (const id of expected) {
      assert.ok(
        requested.has(id),
        `unique series id ${id} was never POSTed to BLS — chunking dropped it`,
      );
    }

    // Sanity: chunk count matches ceil(uniqueSeriesIds / cap). If the
    // collector's chunking ever degraded to "all in one POST" or
    // "one POST per series", this catches it.
    const expectedChunks = Math.ceil(
      expected.size / BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED,
    );
    assert.equal(
      captured.length,
      expectedChunks,
      `expected ${expectedChunks} chunks for ${expected.size} unique series ids at cap ${BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED}, got ${captured.length}`,
    );
  });

  it("documents the per-tier per-request caps the chunking depends on", () => {
    // Pin both constants so a "harmless cleanup" PR that flips them to
    // arbitrary numbers (or swaps them) is caught immediately rather
    // than after the next BLS deploy starts rejecting oversized POSTs.
    assert.equal(BLS_API_SERIES_PER_REQUEST_UNAUTHENTICATED, 25);
    assert.equal(BLS_API_SERIES_PER_REQUEST_AUTHENTICATED, 50);
  });
});

describe("blsEconomicIndexCollector.collect round-trip", () => {
  it("parses sample PPI, CPI, and ECI observations into well-formed drafts", async () => {
    // Run with a fake API key so the collector takes the authenticated
    // path. That keeps everything fitting into one chunk (50-series cap)
    // and avoids the no-key audit-log write entirely — this test is
    // about the parse, not the chunking guardrail above.
    const prevKey = process.env["BLS_API_KEY"];
    process.env["BLS_API_KEY"] = "test-key";

    const { captured, restore } = stubBlsFetch();
    let drafts;
    try {
      drafts = await blsEconomicIndexCollector.collect({ since: null });
    } finally {
      restore();
      if (prevKey === undefined) delete process.env["BLS_API_KEY"];
      else process.env["BLS_API_KEY"] = prevKey;
    }

    // Authenticated chunk includes the registration key on every POST.
    for (const req of captured) {
      assert.equal(
        req.body.registrationkey,
        "test-key",
        "authenticated POST must thread BLS_API_KEY into registrationkey",
      );
    }

    // ---- PPI sample (monthly, scopeMaterialCode) ------------------
    const ppiDrafts = drafts.filter(
      (d) =>
        (d.metadata as Record<string, unknown>)["seriesId"] ===
        PPI_SAMPLE.seriesId,
    );
    assert.equal(
      ppiDrafts.length,
      1,
      "expected exactly one PPI draft for the sample series",
    );
    const ppi = ppiDrafts[0]!;
    assert.equal(ppi.signalType, "economic_index");
    assert.equal(ppi.value, Number(PPI_SAMPLE.obs.value));
    assert.equal(ppi.unit, PPI_SAMPLE.unit);
    assert.equal(ppi.scopeMaterialCode, PPI_SAMPLE.scopeMaterialCode);
    assert.equal(ppi.scopeCategoryCode, undefined);
    assert.equal(ppi.observedAt.toISOString(), PPI_SAMPLE.expectedObservedAt);

    // ---- CPI sample (monthly, scopeCategoryCode, 1982-84 base) ----
    const cpiDrafts = drafts.filter(
      (d) =>
        (d.metadata as Record<string, unknown>)["seriesId"] ===
        CPI_SAMPLE.seriesId,
    );
    assert.equal(
      cpiDrafts.length,
      1,
      "expected exactly one CPI draft for the sample series",
    );
    const cpi = cpiDrafts[0]!;
    assert.equal(cpi.signalType, "economic_index");
    assert.equal(cpi.value, Number(CPI_SAMPLE.obs.value));
    assert.equal(cpi.unit, CPI_SAMPLE.unit);
    assert.equal(cpi.scopeCategoryCode, CPI_SAMPLE.scopeCategoryCode);
    assert.equal(cpi.scopeMaterialCode, undefined);
    assert.equal(cpi.observedAt.toISOString(), CPI_SAMPLE.expectedObservedAt);

    // ---- ECI sample (quarterly, single observation fans out across
    // multiple registry entries that share the upstream seriesId) ----
    const eciDrafts = drafts.filter(
      (d) =>
        (d.metadata as Record<string, unknown>)["seriesId"] ===
        ECI_SAMPLE.seriesId,
    );
    // CIU1010000000000I appears once in the registry (LABOR_TOTAL_COMP)
    // — the multi-scope fan-out is on a different ECI series. So we
    // expect exactly one draft here.
    assert.equal(
      eciDrafts.length,
      1,
      "expected exactly one ECI draft for the headline LABOR_TOTAL_COMP series",
    );
    const eci = eciDrafts[0]!;
    assert.equal(eci.signalType, "economic_index");
    assert.equal(eci.value, Number(ECI_SAMPLE.obs.value));
    assert.equal(eci.unit, ECI_SAMPLE.unit);
    assert.equal(eci.scopeCategoryCode, ECI_SAMPLE.scopeCategoryCode);
    assert.equal(eci.scopeMaterialCode, undefined);
    // Q01 = end of March UTC.
    assert.equal(eci.observedAt.toISOString(), ECI_SAMPLE.expectedObservedAt);
  });
});
