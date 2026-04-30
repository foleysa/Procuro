/**
 * Unit tests for the Defense Pack citation verifier.
 *
 * These tests exercise verifyClaims + meetsCitationFloor against
 * synthetic snapshots. They are pure (no DB, no LLM) — the verifier
 * deliberately operates on plain values so we can exhaustively cover
 * the rules a memo must obey before reaching a buyer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyClaims,
  meetsCitationFloor,
} from "../src/lib/defense-pack/verify.js";
import type {
  DefensePackEvidenceSnapshotItem,
  DefensePackSection,
} from "@workspace/db";

function snap(
  signalId: string,
  value: number,
  tier: "T1" | "T2" | "T3" | "T4" = "T1",
  unit = "USD/tonne",
): DefensePackEvidenceSnapshotItem {
  return {
    signalId,
    collectorId: "col_test",
    collectorName: "Test Collector",
    signalType: "commodity_index",
    tier,
    scope: { materialCode: "STEEL_HRC" },
    value,
    unit,
    currency: "USD",
    observedAt: "2026-01-15T00:00:00.000Z",
    sourceUrl: "https://example.test/x",
    posture: "public",
  };
}

function section(
  key: DefensePackSection["key"],
  claims: DefensePackSection["claims"],
): DefensePackSection {
  return { key, title: key, narrative: "n/a", claims };
}

test("verify: keeps claims whose cited value matches snapshot", () => {
  const snapshot = [snap("sig_1", 182.4)];
  const sections = [
    section("market_context", [
      { text: "CRU index sits at $182.40/tonne", signalId: "sig_1", valueQuoted: "$182.40 /tonne" },
    ]),
  ];
  const r = verifyClaims(sections, snapshot);
  assert.equal(r.claimsEmitted, 1);
  assert.equal(r.claimsVerified, 1);
  assert.equal(r.sections[0].claims.length, 1);
  assert.equal(r.drops.length, 0);
});

test("verify: drops claims whose signalId is missing from snapshot", () => {
  const snapshot = [snap("sig_1", 100)];
  const sections = [
    section("market_context", [
      { text: "fake", signalId: "sig_does_not_exist", valueQuoted: "100" },
    ]),
  ];
  const r = verifyClaims(sections, snapshot);
  assert.equal(r.claimsVerified, 0);
  assert.equal(r.sections[0].claims.length, 0);
  assert.match(r.drops[0].reason, /not in evidence snapshot/);
});

test("verify: drops claims that cite T3 or T4 signals", () => {
  const snapshot = [snap("sig_t3", 100, "T3"), snap("sig_t4", 100, "T4")];
  const sections = [
    section("cost_drivers", [
      { text: "T3 cite", signalId: "sig_t3", valueQuoted: "100" },
      { text: "T4 cite", signalId: "sig_t4", valueQuoted: "100" },
    ]),
  ];
  const r = verifyClaims(sections, snapshot);
  assert.equal(r.claimsVerified, 0);
  assert.equal(r.drops.length, 2);
  for (const d of r.drops) {
    assert.match(d.reason, /not eligible for citation/);
  }
});

test("verify: drops claims whose quoted value is out of tolerance", () => {
  const snapshot = [snap("sig_1", 100)];
  const sections = [
    section("comparable_benchmarks", [
      // 110 is 10% off — outside default 1% relative tolerance.
      { text: "off", signalId: "sig_1", valueQuoted: "110" },
    ]),
  ];
  const r = verifyClaims(sections, snapshot);
  assert.equal(r.claimsVerified, 0);
  assert.match(r.drops[0].reason, /out of tolerance/);
});

test("verify: accepts rounding within tolerance and tolerates comma formatting", () => {
  const snapshot = [snap("sig_1", 1234.567)];
  const sections = [
    section("market_context", [
      // "$1,234.57" — comma + small rounding, well within 1%.
      { text: "ok", signalId: "sig_1", valueQuoted: "$1,234.57 /tonne" },
    ]),
  ];
  const r = verifyClaims(sections, snapshot);
  assert.equal(r.claimsVerified, 1);
});

test("verify: position and proprietary_signal_context never carry claims", () => {
  const snapshot = [snap("sig_1", 100)];
  const sections = [
    section("position", [
      { text: "claimy", signalId: "sig_1", valueQuoted: "100" },
    ]),
    section("proprietary_signal_context", [
      { text: "claimy", signalId: "sig_1", valueQuoted: "100" },
    ]),
  ];
  const r = verifyClaims(sections, snapshot);
  // These sections are intentionally narrative-only — claims are stripped.
  assert.equal(r.sections[0].claims.length, 0);
  assert.equal(r.sections[1].claims.length, 0);
});

test("meetsCitationFloor: passes when every cited section has >=1 claim", () => {
  const sections = [
    section("position", []),
    section("market_context", [
      { text: "x", signalId: "s", valueQuoted: "1" },
    ]),
    section("cost_drivers", [
      { text: "x", signalId: "s", valueQuoted: "1" },
    ]),
    section("proprietary_signal_context", []),
  ];
  assert.equal(meetsCitationFloor(sections), true);
});

test("meetsCitationFloor: fails when a cited section has zero claims", () => {
  const sections = [
    section("position", []),
    section("market_context", []),
    section("cost_drivers", [
      { text: "x", signalId: "s", valueQuoted: "1" },
    ]),
  ];
  assert.equal(meetsCitationFloor(sections), false);
});
