/**
 * Unit tests for the issuer-list dedupe / normalisation helpers used by
 * the SEC EDGAR and Companies House collectors.
 *
 * These cover the pure parts (`dedupeSecIssuers`,
 * `normaliseCompaniesHouseNumber`) so the contract that "two tenants
 * watching the same identifier cost us only one upstream fetch" is
 * pinned without needing a live DB. The async loaders
 * (`loadWatchedSecIssuers`, `loadWatchedCompaniesHouseNumbers`) are
 * exercised separately by the integration test.
 */
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env["DATABASE_URL"]) {
  // Same trick as collectors-validation.test.ts: a placeholder URL so
  // the import-time guard in `@workspace/db` is satisfied. These pure
  // helpers never touch the pool.
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const {
  dedupeSecIssuers,
  padCik,
} = await import("../src/lib/intelligence/collectors/sec-edgar");
const { normaliseCompaniesHouseNumber } = await import(
  "../src/lib/intelligence/collectors/companies-house"
);

test("dedupeSecIssuers de-dupes on padded CIK and keeps first occurrence", () => {
  const out = dedupeSecIssuers([
    { cik: "320193", name: "Apple Inc.", lei: "HWUPKR0MPOU8FGXBT394" },
    // Same issuer, alternate (zero-padded) shape. Should be dropped.
    { cik: "0000320193", name: "Apple (alias)" },
    { cik: "789019", name: "Microsoft Corporation" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.name, "Apple Inc.");
  // First-occurrence wins so enrichment (LEI on the first row) is preserved.
  assert.equal(out[0]!.lei, "HWUPKR0MPOU8FGXBT394");
  assert.equal(out[1]!.name, "Microsoft Corporation");
});

test("dedupeSecIssuers drops issuers whose CIK normalises to empty", () => {
  const out = dedupeSecIssuers([
    { cik: "", name: "Empty" },
    { cik: "non-numeric", name: "Garbage" },
    { cik: "320193", name: "Apple Inc." },
  ]);
  // padCik("non-numeric") → "0000000000" — that's a valid 10-digit
  // string but represents CIK 0, which EDGAR will reject. We DO NOT
  // drop it here on purpose: validation belongs at the admin route.
  // The empty input on the other hand has nothing to pad and is
  // dropped (`!key`).
  const ciks = out.map((i) => padCik(i.cik));
  assert.ok(ciks.includes("0000320193"));
  assert.equal(ciks.includes(""), false);
});

test("normaliseCompaniesHouseNumber zero-pads numeric inputs to 8 chars", () => {
  assert.equal(normaliseCompaniesHouseNumber("6245"), "00006245");
  assert.equal(normaliseCompaniesHouseNumber("00006245"), "00006245");
  assert.equal(normaliseCompaniesHouseNumber("  6245  "), "00006245");
  // Leaves alpha-prefixed Scottish/NI numbers alone (they're already
  // canonical and zero-padding would corrupt the prefix).
  assert.equal(normaliseCompaniesHouseNumber("SC123456"), "SC123456");
  assert.equal(normaliseCompaniesHouseNumber("ni000005"), "NI000005");
});
