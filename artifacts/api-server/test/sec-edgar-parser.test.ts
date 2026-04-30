/**
 * SEC EDGAR collector parser tests.
 *
 * Pins the contract that:
 *   - only TRACKED_FORM_CODES forms produce drafts
 *   - the form → numeric value mapping is stable
 *   - accession + supplier-name + filed-date land on the natural key
 *     so re-parsing the same payload produces the same stable signal key
 *   - schema validation accepts the parser output
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEdgarSubmissions,
  TRACKED_FORM_CODES,
  secEdgarCollector,
  padCik,
  type SecIssuerRef,
  type EdgarSubmissionsResponse,
} from "../src/lib/intelligence/collectors/sec-edgar";

const ISSUER: SecIssuerRef = {
  cik: "320193",
  name: "Apple Inc.",
  ticker: "AAPL",
  lei: "HWUPKR0MPOU8FGXBT394",
};

const SAMPLE: EdgarSubmissionsResponse = {
  cik: "320193",
  name: "Apple Inc.",
  filings: {
    recent: {
      form: ["10-K", "10-Q", "8-K", "DEF 14A", "NT 10-K", "S-1", "10-K"],
      filingDate: [
        "2026-01-15",
        "2025-10-30",
        "2025-09-12",
        "2025-08-01",
        "2026-02-01",
        "2025-04-01",
        "2026-01-15", // duplicate calendar day, different accession
      ],
      accessionNumber: [
        "0000320193-26-000001",
        "0000320193-25-000044",
        "0000320193-25-000040",
        "0000320193-25-000033",
        "0000320193-26-000007",
        "0000320193-25-000010",
        "0000320193-26-000002",
      ],
      primaryDocument: ["10k.htm", "10q.htm", "8k.htm", "proxy.htm", "nt.htm", "s1.htm", "10ka.htm"],
      reportDate: ["2025-12-31", "2025-09-30", "", "", "2025-12-31", "", "2025-12-31"],
      items: ["", "", "1.01,9.01", "", "", "", ""],
    },
  },
};

describe("parseEdgarSubmissions", () => {
  it("emits one draft per tracked form and skips untracked forms", () => {
    const drafts = parseEdgarSubmissions(ISSUER, SAMPLE);
    // 6 tracked entries (10-K, 10-Q, 8-K, DEF 14A, NT 10-K, second 10-K)
    // — the S-1 row is dropped.
    assert.equal(drafts.length, 6);
    for (const d of drafts) {
      assert.equal(d.signalType, "corporate_filing");
      assert.equal(d.scopeSupplierName, "Apple Inc.");
      assert.equal(d.unit, "form_code");
      // The parser is pure and does not call the resolver — the
      // collector's collectWithRaw pass populates entityUid via
      // Foundation. The parser is responsible for surfacing the
      // identifiers the resolver needs.
      assert.equal(d.entityUid, undefined);
      const md = d.metadata as Record<string, unknown>;
      assert.equal(md["cik"], "0000320193");
      assert.ok(md["accessionNumber"]);
    }
  });

  it("uses the published TRACKED_FORM_CODES mapping", () => {
    const drafts = parseEdgarSubmissions(ISSUER, SAMPLE);
    assert.equal(drafts[0]!.value, TRACKED_FORM_CODES["10-K"]);
    assert.equal(drafts[1]!.value, TRACKED_FORM_CODES["10-Q"]);
    assert.equal(drafts[2]!.value, TRACKED_FORM_CODES["8-K"]);
    assert.equal(drafts[3]!.value, TRACKED_FORM_CODES["DEF 14A"]);
    assert.equal(drafts[4]!.value, TRACKED_FORM_CODES["NT 10-K"]);
  });

  it("disambiguates same-day filings via scope_sku = accession", () => {
    // Two 10-K rows share the 2026-01-15 filing date in the fixture; if
    // we relied on the (supplier, date) pair alone they'd collide.
    const drafts = parseEdgarSubmissions(ISSUER, SAMPLE);
    const sameDay = drafts.filter(
      (d) => d.observedAt.toISOString().slice(0, 10) === "2026-01-15",
    );
    assert.equal(sameDay.length, 2);
    const skus = sameDay.map((d) => d.scopeSku);
    assert.notEqual(skus[0], skus[1]);
  });

  it("schema validates every produced draft", () => {
    const drafts = parseEdgarSubmissions(ISSUER, SAMPLE);
    for (const d of drafts) {
      const result = secEdgarCollector.signalSchema.safeParse(d);
      assert.ok(result.success, JSON.stringify(result));
    }
  });

  it("re-parsing the same payload yields the same stable signal keys (idempotent)", () => {
    const a = parseEdgarSubmissions(ISSUER, SAMPLE).map((d) =>
      secEdgarCollector.stableSignalKey(d),
    );
    const b = parseEdgarSubmissions(ISSUER, SAMPLE).map((d) =>
      secEdgarCollector.stableSignalKey(d),
    );
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length, "stable keys are unique per draft");
  });

  it("drops rows whose filing date can't be parsed", () => {
    const broken: EdgarSubmissionsResponse = {
      cik: "320193",
      name: "Apple Inc.",
      filings: {
        recent: {
          form: ["10-K"],
          filingDate: ["not-a-date"],
          accessionNumber: ["x"],
          primaryDocument: [""],
          reportDate: [""],
          items: [""],
        },
      },
    };
    assert.equal(parseEdgarSubmissions(ISSUER, broken).length, 0);
  });
});

describe("padCik", () => {
  it("zero-pads to 10 digits and strips non-digits", () => {
    assert.equal(padCik("320193"), "0000320193");
    assert.equal(padCik("0000320193"), "0000320193");
    assert.equal(padCik("CIK320193"), "0000320193");
  });
});
