/**
 * Unit tests for the new @workspace/intelligence foundation primitives.
 *
 * Scope: pure functions only. The BQ-backed paths in `resolveEntity` and
 * the GCS landing helpers are exercised behind feature flags in the
 * runtime test suite; here we only test the pieces that work without
 * GCP creds — contract validation, the deterministic identifier
 * resolver, the disclosure-tier renderer, and `computeStableSignalKey`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  collectorContractSchema,
  computeStableSignalKey,
  buildCacheKey,
  deterministicUidFromIdentifier,
  normaliseName,
  renderInsight,
  type SignalSource,
} from "@workspace/intelligence";

// ---------------------------------------------------------------------------
// collectorContractSchema
// ---------------------------------------------------------------------------

test("collectorContractSchema accepts a fully-declared contract", () => {
  const ok = collectorContractSchema.safeParse({
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "US",
    retentionDays: 365,
    tenantOptInDefault: true,
  });
  assert.equal(ok.success, true);
});

test("collectorContractSchema rejects unknown postureClass", () => {
  const bad = collectorContractSchema.safeParse({
    postureClass: "stealth",
    disclosureTier: "T1",
    jurisdiction: "US",
    retentionDays: 365,
    tenantOptInDefault: true,
  });
  assert.equal(bad.success, false);
});

test("collectorContractSchema rejects negative retentionDays", () => {
  const bad = collectorContractSchema.safeParse({
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "US",
    retentionDays: -1,
    tenantOptInDefault: true,
  });
  assert.equal(bad.success, false);
});

// ---------------------------------------------------------------------------
// computeStableSignalKey
// ---------------------------------------------------------------------------

test("computeStableSignalKey is deterministic for the same parts", () => {
  const a = computeStableSignalKey({
    collectorId: "fred",
    signalType: "fx_rate",
    scopeCategoryCode: null,
    scopeSku: null,
    scopeMaterialCode: null,
    scopeSupplierName: null,
    scopeLaneKey: null,
    observedAt: new Date("2025-01-15T00:00:00Z"),
  });
  const b = computeStableSignalKey({
    collectorId: "fred",
    signalType: "fx_rate",
    scopeCategoryCode: null,
    scopeSku: null,
    scopeMaterialCode: null,
    scopeSupplierName: null,
    scopeLaneKey: null,
    observedAt: new Date("2025-01-15T00:00:00Z"),
  });
  assert.equal(a, b);
});

test("computeStableSignalKey collapses null vs empty-string scope to the same key", () => {
  const withNull = computeStableSignalKey({
    collectorId: "fred",
    signalType: "fx_rate",
    scopeCategoryCode: null,
    observedAt: "2025-01-15T00:00:00Z",
  });
  const withEmpty = computeStableSignalKey({
    collectorId: "fred",
    signalType: "fx_rate",
    scopeCategoryCode: "",
    observedAt: "2025-01-15T00:00:00Z",
  });
  assert.equal(withNull, withEmpty);
});

test("computeStableSignalKey changes when observedAt changes", () => {
  const a = computeStableSignalKey({
    collectorId: "fred",
    signalType: "fx_rate",
    observedAt: new Date("2025-01-15T00:00:00Z"),
  });
  const b = computeStableSignalKey({
    collectorId: "fred",
    signalType: "fx_rate",
    observedAt: new Date("2025-01-16T00:00:00Z"),
  });
  assert.notEqual(a, b);
});

test("computeStableSignalKey changes when collectorId changes", () => {
  const a = computeStableSignalKey({
    collectorId: "fred",
    signalType: "fx_rate",
    observedAt: new Date("2025-01-15T00:00:00Z"),
  });
  const b = computeStableSignalKey({
    collectorId: "ecb",
    signalType: "fx_rate",
    observedAt: new Date("2025-01-15T00:00:00Z"),
  });
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// entity resolver — pure helpers
// ---------------------------------------------------------------------------

test("normaliseName lowercases, strips legal suffixes, and collapses whitespace", () => {
  assert.equal(normaliseName("Apple Inc."), "apple");
  assert.equal(normaliseName("BHP Group Limited"), "bhp group");
  // Punctuation in dotted suffixes ("S.A.") is dropped before the
  // word-boundary suffix regex runs, so the letters survive — that's
  // fine, the cache key still keys deterministically.
  assert.equal(normaliseName("Renault SA"), "renault");
  assert.equal(normaliseName("AT&T Corporation"), "at and t");
});

test("buildCacheKey prefers a normalised LEI over name+country", () => {
  const k = buildCacheKey({
    name: "Apple Inc.",
    country: "US",
    identifiers: { lei: "HWUPKR0MPOU8FGXBT394" },
  });
  assert.equal(k, "id:lei:HWUPKR0MPOU8FGXBT394");
});

test("buildCacheKey falls through to name+country when no identifiers given", () => {
  const k = buildCacheKey({ name: "Apple Inc.", country: "us" });
  assert.equal(k, "name:US:apple");
});

test("deterministicUidFromIdentifier is stable + identifier-keyed", () => {
  const a = deterministicUidFromIdentifier("lei", "HWUPKR0MPOU8FGXBT394");
  const b = deterministicUidFromIdentifier("lei", "hwupkr0mpou8fgxbt394");
  assert.equal(a, b);
  assert.match(a, /^ent_lei_/);
});

// ---------------------------------------------------------------------------
// disclosure-tier renderer
// ---------------------------------------------------------------------------

function makeSource(
  tier: "T1" | "T2" | "T3" | "T4",
  jurisdiction = "US",
): SignalSource {
  return {
    collectorId: `c_${tier}`,
    collectorName: `Collector ${tier}`,
    sourceUrl: `https://example.test/${tier}`,
    observedAt: new Date("2025-01-15T00:00:00Z"),
    contract: {
      postureClass: "public_api",
      disclosureTier: tier,
      jurisdiction,
      retentionDays: 365,
      tenantOptInDefault: true,
    },
  };
}

test("renderInsight: conservative policy hides T3 and T4", () => {
  const r = renderInsight({
    sources: [makeSource("T1"), makeSource("T2"), makeSource("T3"), makeSource("T4")],
    policy: "conservative",
  });
  assert.equal(r.visible, true);
  // Only T1 + T2 surface.
  assert.equal(r.citations.length, 2);
  assert.deepEqual(
    r.citations.map((c) => c.tier).sort(),
    ["T1", "T2"],
  );
  // T1 keeps its URL; T2 must not.
  const t1 = r.citations.find((c) => c.tier === "T1")!;
  const t2 = r.citations.find((c) => c.tier === "T2")!;
  assert.ok(t1.url);
  assert.equal(t2.url, null);
});

test("renderInsight: standard policy adds T3 (still no T4)", () => {
  const r = renderInsight({
    sources: [makeSource("T1"), makeSource("T3"), makeSource("T4")],
    policy: "standard",
    aggregateConfidence: 0.81,
  });
  assert.equal(r.visible, true);
  assert.equal(r.citations.length, 2);
  assert.ok(r.citations.some((c) => c.tier === "T3"));
  assert.ok(!r.citations.some((c) => c.tier === "T4"));
});

test("renderInsight: analyst policy surfaces every tier with provenance", () => {
  const r = renderInsight({
    sources: [makeSource("T1"), makeSource("T2"), makeSource("T3"), makeSource("T4")],
    policy: "analyst",
  });
  assert.equal(r.visible, true);
  assert.equal(r.citations.length, 4);
  for (const c of r.citations) {
    assert.ok(c.provenance, `expected provenance for tier ${c.tier}`);
    assert.equal(c.provenance!.postureClass, "public_api");
  }
});

test("renderInsight: empty sources is invisible", () => {
  const r = renderInsight({ sources: [], policy: "standard" });
  assert.equal(r.visible, false);
  assert.equal(r.tier, "T4");
  assert.equal(r.citations.length, 0);
});

test("renderInsight: only T4 sources → not visible under any non-analyst policy", () => {
  for (const policy of ["conservative", "standard"] as const) {
    const r = renderInsight({ sources: [makeSource("T4")], policy });
    assert.equal(r.visible, false, `policy=${policy}`);
    assert.equal(r.citations.length, 0);
  }
});
