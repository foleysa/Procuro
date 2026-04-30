/**
 * Pure-unit tests for the readiness scoring math.
 *
 * The score formula is the contract the dashboard card and the wizard
 * both render against — pin the corner cases here so a future refactor
 * (e.g. swapping in a weighted average) is caught explicitly.
 */
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const { scoreFromBlockers, getReadinessRules, leverTier } = await import(
  "../src/lib/readiness/rules"
);

test("scoreFromBlockers returns 100 when there are no blockers", () => {
  assert.equal(scoreFromBlockers([]), 100);
});

test("scoreFromBlockers returns 0 if any blocker is hard, regardless of pct", () => {
  assert.equal(
    scoreFromBlockers([
      {
        id: "x",
        field: "x",
        message: "x",
        missingPct: 5,
        missingCount: 1,
        totalCount: 20,
        fixUrl: "/x",
        hard: true,
      },
    ]),
    0,
  );
});

test("scoreFromBlockers averages soft blocker pct and clamps to [0, 100]", () => {
  const score = scoreFromBlockers([
    {
      id: "a",
      field: "a",
      message: "a",
      missingPct: 25,
      missingCount: 25,
      totalCount: 100,
      fixUrl: "/",
      hard: false,
    },
    {
      id: "b",
      field: "b",
      message: "b",
      missingPct: 75,
      missingCount: 75,
      totalCount: 100,
      fixUrl: "/",
      hard: false,
    },
  ]);
  assert.equal(score, 50);

  // A pathological 110% (shouldn't happen in practice, but defend
  // against it) clamps the score to 0 rather than going negative.
  const clamped = scoreFromBlockers([
    {
      id: "z",
      field: "z",
      message: "z",
      missingPct: 110,
      missingCount: 110,
      totalCount: 100,
      fixUrl: "/",
      hard: false,
    },
  ]);
  assert.equal(clamped >= 0, true);
  assert.equal(clamped <= 100, true);
});

test("getReadinessRules covers the 12 levers we promised in task #122", () => {
  const ids = getReadinessRules().map((r) => r.leverId);
  const required = [
    "sku_price_benchmark",
    "maverick_spend",
    "contract_leakage",
    "duplicate_payment",
    "missed_volume_threshold",
    "payment_term_extension",
    "tail_spend_rationalization",
    "supplier_consolidation",
    "contract_renegotiation_trigger",
    "spot_vs_contract",
    "supplier_fx_exposure",
    "material_index_arbitrage",
  ] as const;
  for (const id of required) {
    assert.ok(ids.includes(id), `missing readiness rule for ${id}`);
  }
});

test("leverTier resolves a known tier-1 and tier-4 lever", () => {
  assert.equal(leverTier("sku_price_benchmark"), 1);
  assert.equal(leverTier("supplier_fx_exposure"), 4);
});
