/**
 * Parser tests for the USAspending.gov collector. We pin the field
 * extraction so a future schema-drift on USAspending's documented
 * spending_by_award response (rename / drop a column) is caught
 * immediately rather than producing silently empty drafts.
 */
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const { parseUsaspendingResponse } = await import(
  "../src/lib/intelligence/collectors/usaspending"
);

const SAMPLE = {
  results: [
    {
      "Award ID": "FA8730-22-C-0001",
      "Recipient Name": "ACME DEFENSE SYSTEMS LLC",
      "Award Amount": 1_250_000,
      "Awarding Agency": "Department of Defense",
      "Award Type": "BPA Call",
      "Action Date": "2026-01-15",
      "Last Modified Date": "2026-02-01",
      "Recipient Location State Code": "VA",
      recipient_id: "ABCD1234EFGH",
      generated_internal_id: "CONT_AWD_FA8730_22_C_0001",
    },
    // Row missing required fields — must be dropped silently.
    { "Recipient Name": null, generated_internal_id: null },
    // Numeric obligation as a string (USAspending sometimes does this).
    {
      "Award ID": "N0001923D0099",
      "Recipient Name": "BETA INDUSTRIES CORP",
      "Award Amount": "750000",
      "Awarding Agency": "Department of the Navy",
      "Award Type": "IDV",
      "Action Date": "2026-03-02",
      "Last Modified Date": "2026-03-03",
      "Recipient Location State Code": "TX",
      recipient_id: "ZZ99XX88YY77",
      generated_internal_id: "CONT_IDV_N0001923D0099",
    },
  ],
};

test("parseUsaspendingResponse extracts the documented columns", () => {
  const awards = parseUsaspendingResponse(SAMPLE);
  assert.equal(awards.length, 2, "two parseable rows from the sample");
  const a = awards[0]!;
  assert.equal(a.recipientName, "ACME DEFENSE SYSTEMS LLC");
  assert.equal(a.recipientUei, "ABCD1234EFGH");
  assert.equal(a.recipientStateCode, "VA");
  assert.equal(a.generatedInternalId, "CONT_AWD_FA8730_22_C_0001");
  assert.equal(a.piid, "FA8730-22-C-0001");
  assert.equal(a.awardingAgency, "Department of Defense");
  assert.equal(a.awardType, "BPA Call");
  assert.equal(a.obligationAmountUsd, 1_250_000);
  assert.equal(a.actionDate.toISOString().slice(0, 10), "2026-01-15");
});

test("parseUsaspendingResponse coerces stringified numeric obligation amounts", () => {
  const awards = parseUsaspendingResponse(SAMPLE);
  const beta = awards.find((x) => x.piid === "N0001923D0099");
  assert.ok(beta, "BETA row must parse");
  assert.equal(beta!.obligationAmountUsd, 750_000);
});

test("parseUsaspendingResponse handles malformed payloads without throwing", () => {
  assert.deepEqual(parseUsaspendingResponse(null), []);
  assert.deepEqual(parseUsaspendingResponse({}), []);
  assert.deepEqual(parseUsaspendingResponse({ results: "not-an-array" }), []);
  assert.deepEqual(parseUsaspendingResponse({ results: [null, 42, "x"] }), []);
});
