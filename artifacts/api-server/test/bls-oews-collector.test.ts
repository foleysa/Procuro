/**
 * BLS OEWS collector unit tests (no HTTP, no DB). Mirrors the
 * FRED/ECB backfill tests: registry shape, draft routing, dedupe-key
 * stability, and multi-datatype/multi-region collision avoidance.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OEWS_SERIES,
  OEWS_OCCUPATIONS,
  OEWS_REGIONS,
  buildOewsDraftForObservation,
  buildOewsDraftsFromResponse,
  buildOewsSeriesId,
  oewsScopeSku,
  type OewsSeriesRef,
} from "../src/lib/intelligence/collectors/bls-oews";
import { CANONICAL_CATEGORY_CODES } from "../src/lib/intelligence/scope-taxonomy";
import { computeStableSignalKey } from "@workspace/intelligence";
import {
  type BlsResponse,
  type BlsObservation,
} from "../src/lib/intelligence/collectors/bls-economic-index";

const SAMPLE_REF: OewsSeriesRef = OEWS_SERIES.find(
  (s) =>
    s.scopeCategoryCode === "PROF_LEGAL" &&
    s.regionCode === "US-NATIONAL" &&
    s.datatype === "04",
)!;

const ANNUAL_OBS: BlsObservation = {
  year: "2024",
  period: "A01",
  periodName: "Annual",
  value: "165250.00",
};

describe("OEWS_SERIES registry shape", () => {
  it("contains at least one entry per requested services tower", () => {
    const requiredTowers: ReadonlyArray<string> = [
      "PROF_LEGAL",
      "PROF_AUDIT_TAX",
      "PROF_CONSULTING_OPS",
      "IT_APP_DEV",
      "IT_INFRA",
      "IT_MANAGED_SERVICES",
      "MKT_AGENCY_CREATIVE",
      "HR_RECRUITING",
      "FAC_SECURITY",
      "FAC_JANITORIAL",
      "ENG_RND",
    ];
    const present = new Set(OEWS_SERIES.map((s) => s.scopeCategoryCode));
    for (const tower of requiredTowers) {
      assert.ok(present.has(tower), `OEWS_SERIES missing tower ${tower}`);
    }
  });

  it("emits the full hourly percentile + annual suite at the national level", () => {
    const lawyerNational = OEWS_SERIES.filter(
      (s) =>
        s.scopeCategoryCode === "PROF_LEGAL" && s.regionCode === "US-NATIONAL",
    );
    const got = new Set(lawyerNational.map((s) => `${s.horizon}:${s.aggregate}`));
    for (const want of [
      "hourly:mean",
      "hourly:p25",
      "hourly:median",
      "hourly:p75",
      "hourly:p90",
      "annual:mean",
    ]) {
      assert.ok(got.has(want), `OEWS national PROF_LEGAL missing ${want}`);
    }
  });

  it("includes at least one non-national region (state or MSA)", () => {
    const nonNational = OEWS_SERIES.filter((s) => s.regionCode !== "US-NATIONAL");
    assert.ok(nonNational.length > 0);
    const types = new Set(
      OEWS_REGIONS.filter((r) => r.regionCode !== "US-NATIONAL").map(
        (r) => r.areaType,
      ),
    );
    assert.ok(types.has("S") || types.has("M"));
  });

  it("pins every entry to a canonical category code", () => {
    const canonical = new Set<string>(
      CANONICAL_CATEGORY_CODES as readonly string[],
    );
    for (const ref of OEWS_SERIES) {
      assert.ok(
        canonical.has(ref.scopeCategoryCode),
        `${ref.seriesId} → non-canonical scope ${ref.scopeCategoryCode}`,
      );
    }
  });

  it("uses well-formed series IDs whose occupation slot matches the SOC code", () => {
    // 25 chars = OE(2) + U(1) + areatype(1) + area(7) + industry(6)
    // + occupation(6) + datatype(2). Slice 17..23 holds the 6-digit
    // occupation code; it must equal SOC with the hyphen stripped.
    for (const ref of OEWS_SERIES) {
      assert.equal(ref.seriesId.length, 25, `bad length: ${ref.seriesId}`);
      assert.ok(
        /^OEU[NSM][0-9]{21}$/.test(ref.seriesId),
        `malformed: ${ref.seriesId}`,
      );
      assert.ok(ref.regionCode.length > 0);
      assert.ok(
        /^[0-9]{2}-[0-9]{4}$/.test(ref.socCode),
        `malformed socCode: ${ref.socCode}`,
      );
      const occInId = ref.seriesId.slice(17, 23);
      const expected = ref.socCode.replace("-", "");
      assert.equal(occInId, expected, `${ref.seriesId} occ ≠ SOC ${ref.socCode}`);
    }
  });

  it("never duplicates a (seriesId, regionCode, scopeCategoryCode, scopeSku) tuple", () => {
    const seen = new Set<string>();
    for (const ref of OEWS_SERIES) {
      const key = [
        ref.seriesId,
        ref.regionCode,
        ref.scopeCategoryCode,
        oewsScopeSku(ref),
      ].join("|");
      assert.ok(!seen.has(key), `duplicate registry tuple: ${key}`);
      seen.add(key);
    }
  });

  it("matches the cardinality of REGIONS × OCCUPATIONS × DATATYPES", () => {
    assert.equal(
      OEWS_SERIES.length,
      OEWS_REGIONS.length * OEWS_OCCUPATIONS.length * 7,
    );
  });

  it("emits the full datatype suite at every region (not just national)", () => {
    const required: ReadonlyArray<string> = [
      "hourly:mean",
      "hourly:p25",
      "hourly:median",
      "hourly:p75",
      "hourly:p90",
      "annual:mean",
      "annual:median",
    ];
    for (const region of OEWS_REGIONS) {
      const slice = OEWS_SERIES.filter(
        (s) =>
          s.scopeCategoryCode === "PROF_LEGAL" &&
          s.regionCode === region.regionCode,
      );
      const got = new Set(slice.map((s) => `${s.horizon}:${s.aggregate}`));
      for (const want of required) {
        assert.ok(
          got.has(want),
          `OEWS region ${region.regionCode} missing ${want} for PROF_LEGAL`,
        );
      }
    }
  });
});

describe("buildOewsSeriesId", () => {
  it("composes the 25-character OEWS series ID from its parts", () => {
    assert.equal(
      buildOewsSeriesId({
        areaType: "N",
        areaCode: "0000000",
        industryCode: "000000",
        occupationCode: "231011",
        datatype: "04",
      }),
      "OEUN000000000000023101104",
    );
  });

  it("rejects malformed area / industry / occupation segments", () => {
    assert.throws(() =>
      buildOewsSeriesId({
        areaType: "N",
        areaCode: "00000",
        industryCode: "000000",
        occupationCode: "231011",
        datatype: "04",
      }),
    );
    assert.throws(() =>
      buildOewsSeriesId({
        areaType: "N",
        areaCode: "0000000",
        industryCode: "00000",
        occupationCode: "231011",
        datatype: "04",
      }),
    );
    assert.throws(() =>
      buildOewsSeriesId({
        areaType: "N",
        areaCode: "0000000",
        industryCode: "000000",
        occupationCode: "23101",
        datatype: "04",
      }),
    );
  });
});

describe("buildOewsDraftForObservation", () => {
  it("emits a wage_benchmark draft for a valid annual observation", () => {
    const draft = buildOewsDraftForObservation(SAMPLE_REF, ANNUAL_OBS, {
      tier: "unauthenticated",
    });
    assert.ok(draft);
    assert.equal(draft.signalType, "wage_benchmark");
    assert.equal(draft.value, 165250);
    assert.equal(draft.unit, "USD/year");
    assert.equal(draft.scopeCategoryCode, "PROF_LEGAL");
    assert.equal(draft.scopeRegionCode, "US-NATIONAL");
    assert.equal(draft.scopeSku, "wage:annual:mean:23-1011");
    // A01 = end of calendar year UTC.
    assert.equal(draft.observedAt.toISOString(), "2024-12-31T00:00:00.000Z");
    const meta = draft.metadata as Record<string, unknown>;
    assert.equal(meta["seriesId"], SAMPLE_REF.seriesId);
    assert.equal(meta["regionCode"], "US-NATIONAL");
    assert.equal(meta["aggregate"], "mean");
    assert.equal(meta["horizon"], "annual");
  });

  it("returns null for unparseable period codes", () => {
    assert.equal(
      buildOewsDraftForObservation(
        SAMPLE_REF,
        { year: "2024", period: "ZZ9", periodName: "?", value: "100" },
        { tier: "unauthenticated" },
      ),
      null,
    );
  });

  it("returns null for non-numeric values rather than emitting NaN", () => {
    assert.equal(
      buildOewsDraftForObservation(
        SAMPLE_REF,
        { year: "2024", period: "A01", periodName: "Annual", value: "n/a" },
        { tier: "unauthenticated" },
      ),
      null,
    );
  });

  it("re-runs against the same observation produce a byte-identical stable signal key", () => {
    // Idempotency contract: same upstream snapshot → same dedupe key.
    // Region, sku, and SOC must each shift the key independently so
    // multi-region / multi-datatype / multi-SOC rows don't collapse.
    const a = buildOewsDraftForObservation(SAMPLE_REF, ANNUAL_OBS, {
      tier: "unauthenticated",
    })!;
    const b = buildOewsDraftForObservation(SAMPLE_REF, ANNUAL_OBS, {
      tier: "unauthenticated",
    })!;
    const keyOf = (
      scopeRegionCode: string | null,
      scopeSku: string | null,
    ): string =>
      computeStableSignalKey({
        collectorId: "bls-oews",
        signalType: a.signalType,
        scopeCategoryCode: a.scopeCategoryCode ?? null,
        scopeSku,
        scopeRegionCode,
        observedAt: a.observedAt,
      });
    const k1 = keyOf(a.scopeRegionCode ?? null, a.scopeSku ?? null);
    const k2 = keyOf(b.scopeRegionCode ?? null, b.scopeSku ?? null);
    assert.equal(k1, k2);
    assert.notEqual(k1, keyOf("US-CA", a.scopeSku ?? null));
    assert.notEqual(
      k1,
      keyOf(a.scopeRegionCode ?? null, "wage:hourly:p75:23-1011"),
    );
    assert.notEqual(
      k1,
      keyOf(a.scopeRegionCode ?? null, "wage:annual:mean:13-1071"),
    );
  });
});

describe("buildOewsDraftsFromResponse fan-out", () => {
  function buildResponse(): BlsResponse {
    return {
      status: "REQUEST_SUCCEEDED",
      Results: {
        series: OEWS_SERIES.map((ref, idx) => ({
          seriesID: ref.seriesId,
          data: [
            {
              year: "2024",
              period: "A01",
              periodName: "Annual",
              value: String(50 + idx),
            },
          ],
        })),
      },
    };
  }

  it("produces a draft for every curated series", async () => {
    const missing: string[] = [];
    const drafts = await buildOewsDraftsFromResponse(
      buildResponse(),
      OEWS_SERIES,
      {
        tier: "unauthenticated",
        onMissing: (id) => {
          missing.push(id);
        },
      },
    );
    assert.deepEqual(missing, []);
    assert.equal(drafts.length, OEWS_SERIES.length);
  });

  it("flags series the upstream payload omits via onMissing", async () => {
    const dropped = [OEWS_SERIES[0]!.seriesId, OEWS_SERIES[2]!.seriesId];
    const partial = buildResponse();
    partial.Results!.series = (partial.Results!.series ?? []).filter(
      (s) => !dropped.includes(s.seriesID),
    );
    const missing: string[] = [];
    const drafts = await buildOewsDraftsFromResponse(partial, OEWS_SERIES, {
      tier: "unauthenticated",
      onMissing: (id) => {
        missing.push(id);
      },
    });
    assert.deepEqual(missing.sort(), dropped.sort());
    assert.equal(drafts.length, OEWS_SERIES.length - dropped.length);
  });

  it("re-running over the same response produces identical dedupe keys per draft", async () => {
    const r1 = await buildOewsDraftsFromResponse(buildResponse(), OEWS_SERIES, {
      tier: "unauthenticated",
    });
    const r2 = await buildOewsDraftsFromResponse(buildResponse(), OEWS_SERIES, {
      tier: "unauthenticated",
    });
    assert.equal(r1.length, r2.length);
    for (let i = 0; i < r1.length; i++) {
      const a = r1[i]!;
      const b = r2[i]!;
      const ka = computeStableSignalKey({
        collectorId: "bls-oews",
        signalType: a.signalType,
        scopeCategoryCode: a.scopeCategoryCode ?? null,
        scopeSku: a.scopeSku ?? null,
        scopeRegionCode: a.scopeRegionCode ?? null,
        observedAt: a.observedAt,
      });
      const kb = computeStableSignalKey({
        collectorId: "bls-oews",
        signalType: b.signalType,
        scopeCategoryCode: b.scopeCategoryCode ?? null,
        scopeSku: b.scopeSku ?? null,
        scopeRegionCode: b.scopeRegionCode ?? null,
        observedAt: b.observedAt,
      });
      assert.equal(ka, kb);
    }
  });

  it("multi-datatype expansion never collides on the natural dedupe key", async () => {
    const drafts = await buildOewsDraftsFromResponse(
      buildResponse(),
      OEWS_SERIES,
      { tier: "unauthenticated" },
    );
    const keys = new Set<string>();
    for (const d of drafts) {
      const k = computeStableSignalKey({
        collectorId: "bls-oews",
        signalType: d.signalType,
        scopeCategoryCode: d.scopeCategoryCode ?? null,
        scopeSku: d.scopeSku ?? null,
        scopeRegionCode: d.scopeRegionCode ?? null,
        observedAt: d.observedAt,
      });
      assert.ok(
        !keys.has(k),
        `Duplicate stable_signal_key across two OEWS drafts: ${k}`,
      );
      keys.add(k);
    }
    assert.equal(keys.size, drafts.length);
  });

  it("routes scope_region_code + scope_sku onto every emitted draft", async () => {
    const drafts = await buildOewsDraftsFromResponse(
      buildResponse(),
      OEWS_SERIES,
      { tier: "unauthenticated" },
    );
    for (const d of drafts) {
      assert.ok(
        d.scopeRegionCode && d.scopeRegionCode.length > 0,
        `OEWS draft is missing scope_region_code: ${JSON.stringify(d)}`,
      );
      assert.ok(
        d.scopeCategoryCode && d.scopeCategoryCode.length > 0,
        `OEWS draft is missing scope_category_code: ${JSON.stringify(d)}`,
      );
      assert.ok(
        typeof d.scopeSku === "string" && d.scopeSku.startsWith("wage:"),
        `OEWS draft is missing scope_sku or has wrong shape: ${JSON.stringify(d)}`,
      );
    }
  });
});
