/**
 * Guardrail test for the curated BLS_SERIES registry. Pins headline
 * series IDs, dedupe identity, and scope routing so silent registry
 * drift or a renamed BLS series fails CI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLS_ECONOMIC_INDEX_COLLECTOR_ID,
  BLS_SERIES,
  blsScopeSku,
  buildBlsDraftForObservation,
  buildBlsDraftsFromResponse,
  type BlsObservation,
  type BlsResponse,
  type BlsSeriesRef,
} from "../src/lib/intelligence/collectors/bls-economic-index";
import { computeStableSignalKey } from "@workspace/intelligence";

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
      // --- Task #215 services-band PCU additions ---
      "PCU541110541110", // PPI: Offices of lawyers (PROF_LEGAL)
      "PCU541211541211", // PPI: Offices of CPAs (PROF_AUDIT_TAX)
      "PCU541610541610", // PPI: Management consulting (PROF_CONSULTING_STRATEGY)
      "PCU541512541512", // PPI: Computer systems design (IT_APP_DEV)
      "PCU518210518210", // PPI: Data processing & hosting (IT_SAAS)
      "PCU541810541810", // PPI: Advertising agencies (MKT_AGENCY_CREATIVE)
      "PCU541613541613", // PPI: Marketing consulting services (MKT_RESEARCH)
      "PCU561311561311", // PPI: Employment placement agencies (HR_RECRUITING)
      "PCU561320561320", // PPI: Temporary help services (HR_CONTINGENT_LABOR)
      "PCU561110561110", // PPI: Office administrative services (HR_PAYROLL_BENEFITS)
      "PCU561720561720", // PPI: Janitorial services (FAC_JANITORIAL)
      "PCU561612561612", // PPI: Security guards & patrol (FAC_SECURITY)
      "PCU541330541330", // PPI: Engineering services (ENG_DESIGN + ENG_RND fan-out)
    ];
    const ids = new Set(BLS_SERIES.map((s) => s.seriesId));
    for (const id of headlineSeriesIds) {
      assert.ok(
        ids.has(id),
        `BLS_SERIES is missing required headline series ${id}; restore it or update this guardrail in the same PR.`,
      );
    }
  });

  it("never duplicates a (seriesId, scope) pair", () => {
    // We allow multiple registry entries to share an upstream `seriesId`
    // when they fan out a single observation into multiple canonical
    // scope codes (e.g. headline ECI → several Task #214 services
    // categories). What we never want is two entries with the same
    // (seriesId, scope_category_code, scope_material_code) triple — that
    // would silently double-count under the natural-key dedupe.
    const seen = new Set<string>();
    for (const ref of BLS_SERIES) {
      const key = [
        ref.seriesId,
        ref.scopeCategoryCode ?? "",
        ref.scopeMaterialCode ?? "",
      ].join("|");
      assert.ok(
        !seen.has(key),
        `Duplicate (seriesId, scope) pair in BLS_SERIES: ${key}`,
      );
      seen.add(key);
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

describe("bls-economic-index dedupe identity", () => {
  // Build minimal MarketSignalDraft inputs for the natural-key hash.
  function keyFor(ref: BlsSeriesRef, observedAt: Date): string {
    return computeStableSignalKey({
      collectorId: BLS_ECONOMIC_INDEX_COLLECTOR_ID,
      signalType: "economic_index",
      scopeCategoryCode: ref.scopeCategoryCode ?? null,
      scopeMaterialCode: ref.scopeMaterialCode ?? null,
      scopeSku: blsScopeSku(ref),
      observedAt,
    });
  }

  it("PPI and ECI for the same scope on the same observed_at do not collide", () => {
    // Real production case: PPI monthly M03 and ECI quarterly Q01 both
    // resolve to 2025-03-31 and the ECI service-providing fan-out
    // shares scope_category_code with each PPI services series.
    const ppi = BLS_SERIES.find((s) => s.seriesId === "PCU541110541110")!;
    const eci = BLS_SERIES.find(
      (s) => s.seriesId === "CIU2020000000000I" && s.scopeCategoryCode === "PROF_LEGAL",
    );
    assert.ok(ppi);
    assert.ok(eci, "ECI service-providing fan-out should land on PROF_LEGAL");
    const observedAt = new Date("2025-03-31T00:00:00.000Z");
    assert.notEqual(
      keyFor(ppi, observedAt),
      keyFor(eci!, observedAt),
      "PPI and ECI must produce distinct dedupe keys for the same scope+date",
    );
  });

  it("two PCU series mapping to the same scope_category_code do not collide", () => {
    // PCU541512541512 (computer systems design → IT_INFRA) and
    // PCU518210518210 (data processing & hosting → IT_INFRA) ship a
    // monthly M03 observation that lands on 2025-03-31 each.
    const a = BLS_SERIES.find(
      (s) => s.seriesId === "PCU541512541512" && s.scopeCategoryCode === "IT_INFRA",
    );
    const b = BLS_SERIES.find(
      (s) => s.seriesId === "PCU518210518210" && s.scopeCategoryCode === "IT_INFRA",
    );
    assert.ok(a, "PCU541512541512 should fan out to IT_INFRA");
    assert.ok(b, "PCU518210518210 should fan out to IT_INFRA");
    const observedAt = new Date("2025-03-31T00:00:00.000Z");
    assert.notEqual(
      keyFor(a!, observedAt),
      keyFor(b!, observedAt),
      "two PCU series mapping to the same category must produce distinct dedupe keys",
    );
  });

  it("re-running the same series against the same observation produces a stable key", () => {
    // The flip side: idempotency must still hold.
    const ref = BLS_SERIES.find((s) => s.seriesId === "PCU541110541110")!;
    const observedAt = new Date("2025-03-31T00:00:00.000Z");
    assert.equal(keyFor(ref, observedAt), keyFor(ref, observedAt));
  });

  it("every emitted draft carries scope_sku = blsScopeSku(ref)", () => {
    // Pin the live wiring so a future refactor that drops scopeSku
    // from buildBlsDraftForObservation fails CI immediately.
    const ref = BLS_SERIES.find((s) => s.seriesId === "PCU541110541110")!;
    const draft = buildBlsDraftForObservation(
      ref,
      { year: "2025", period: "M03", periodName: "March", value: "100.0" },
      { tier: "unauthenticated" },
    );
    assert.ok(draft);
    assert.equal(draft!.scopeSku, blsScopeSku(ref));
    assert.equal(draft!.scopeSku, "bls_series:PCU541110541110");
  });

  it("legacy-row backfill formula matches blsScopeSku(ref) for every series", () => {
    // Contract: scripts/src/backfill-bls-scope-sku.ts uses the SQL
    //   `'bls_series:' || (metadata->>'seriesId')`
    // to upgrade pre-existing rows whose `scope_sku` was NULL. That
    // formula MUST produce the same value the runtime now stamps on
    // every new draft via blsScopeSku(), otherwise the post-merge
    // backfill leaves rows with a stale scope_sku and the next
    // collector run inserts a duplicate alongside them.
    //
    // This test pins the formula against every entry in BLS_SERIES so
    // any future change to blsScopeSku()'s output prefix or seriesId
    // shape (e.g. encoding) is caught before deploy.
    for (const ref of BLS_SERIES) {
      const sqlBackfilledValue = `bls_series:${ref.seriesId}`;
      assert.equal(
        sqlBackfilledValue,
        blsScopeSku(ref),
        `backfill SQL output must equal blsScopeSku(ref) for series ${ref.seriesId}`,
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
    // The registry now carries entries that share an upstream `seriesId`
    // (ECI fan-out → multiple canonical service categories). The BLS API
    // returns one series per unique upstream id, so the synthetic
    // response must dedupe on `seriesId` to mirror that contract.
    const uniqueSeries = new Map<
      string,
      { seriesID: string; data: BlsObservation[] }
    >();
    for (const ref of BLS_SERIES) {
      if (uniqueSeries.has(ref.seriesId)) continue;
      uniqueSeries.set(ref.seriesId, {
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
      });
    }
    return {
      status: "REQUEST_SUCCEEDED",
      Results: { series: Array.from(uniqueSeries.values()) },
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
    // Drop two unique series from the synthetic response; collector must
    // alert once per registry entry that resolves to a dropped seriesId
    // (so a multi-scope ECI fan-out drop fires N alerts, not 1).
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
    // Every BLS_SERIES entry whose seriesId we dropped should fire once.
    const expectedMissing = BLS_SERIES.filter((r) =>
      dropped.includes(r.seriesId),
    ).map((r) => r.seriesId);
    assert.deepEqual(missing.sort(), expectedMissing.sort());
    // Dropped registry entries contribute zero drafts, the rest contribute 2 each.
    const survivingRefs = BLS_SERIES.filter(
      (r) => !dropped.includes(r.seriesId),
    );
    assert.equal(drafts.length, survivingRefs.length * 2);
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
      // Multiple registry entries can share an upstream `seriesId` (ECI
      // fan-out). The draft fan-out emits one draft per (ref × obs), so
      // match the originating ref on the (seriesId × scope) tuple
      // rather than on seriesId alone.
      const ref = BLS_SERIES.find(
        (s) =>
          s.seriesId === seriesId &&
          (s.scopeMaterialCode ?? null) === (draft.scopeMaterialCode ?? null) &&
          (s.scopeCategoryCode ?? null) === (draft.scopeCategoryCode ?? null),
      );
      assert.ok(
        ref,
        `Unknown (seriesId, scope) pair in draft: ${seriesId} | category=${draft.scopeCategoryCode ?? "-"} | material=${draft.scopeMaterialCode ?? "-"}`,
      );
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
