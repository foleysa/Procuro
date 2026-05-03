/**
 * EPA ECHO parser tests.
 *
 * Pins:
 *   - `caseToDraft` emits `environmental_violation` with the right
 *     statute code, scope keys, and metadata shape.
 *   - `parseEchoCaseResponse` skips rows lacking `case_number` or a
 *     usable date, and respects the QueryRows envelope.
 *   - `epaEchoCollector.signalSchema` accepts every parser draft and
 *     `stableSignalKey` is unique across the mixed-case set.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  caseToDraft,
  parseEchoCaseResponse,
  epaEchoCollector,
  EPA_ECHO_STATUTE_CODES,
  type EchoCase,
  type EchoCaseSearchResponse,
} from "../src/lib/intelligence/collectors/epa-echo";

const SUPPLIER = {
  name: "Acme Manufacturing Inc",
  normalizedName: "acme manufacturing inc",
};

const CWA_CASE: EchoCase = {
  case_number: "CWA-04-2024-1234",
  case_name: "United States v. Acme Manufacturing",
  case_law_section_code: "CWA",
  case_status: "Settled",
  settlement_entry_date: "2024-09-01",
  settlement_date: "2024-08-15",
  facility_name: "Acme Plant 3",
  facility_city: "Houston",
  facility_state: "TX",
  facility_zip: "77002",
  federal_penalty_assessed_amt: "50,000",
  complying_actions: "Pay penalty, install monitoring",
};

const RCRA_CASE: EchoCase = {
  case_number: "RCRA-05-2024-9999",
  case_name: "United States v. Acme Hazardous",
  case_law_section_code: "RCRA",
  settlement_date: "2024-07-20",
  facility_state: "OH",
  federal_penalty_assessed_amt: 12500,
};

describe("caseToDraft", () => {
  it("maps statute → numeric code and stamps metadata", () => {
    const d = caseToDraft(SUPPLIER, CWA_CASE);
    assert.ok(d);
    assert.equal(d!.signalType, "environmental_violation");
    assert.equal(d!.value, EPA_ECHO_STATUTE_CODES["CWA"]);
    assert.equal(d!.scopeSku, "CWA-04-2024-1234");
    assert.equal(d!.scopeLaneKey, "TX");
    assert.equal(d!.scopeSupplierName, SUPPLIER.name);
    assert.equal(d!.observedAt.toISOString(), "2024-09-01T00:00:00.000Z");
    const md = d!.metadata as Record<string, unknown>;
    assert.equal(md["statute"], "CWA");
    assert.equal(md["facilityName"], "Acme Plant 3");
    assert.equal(md["federalPenaltyUsd"], 50000);
    assert.equal(md["supplierNormalizedName"], SUPPLIER.normalizedName);
  });

  it("falls back to settlement_date when entry date is missing", () => {
    const d = caseToDraft(SUPPLIER, RCRA_CASE);
    assert.ok(d);
    assert.equal(d!.value, EPA_ECHO_STATUTE_CODES["RCRA"]);
    assert.equal(d!.observedAt.toISOString(), "2024-07-20T00:00:00.000Z");
    assert.equal(d!.scopeLaneKey, "OH");
  });

  it("returns null for rows lacking case_number or any date", () => {
    assert.equal(caseToDraft(SUPPLIER, { case_law_section_code: "CWA" }), null);
    assert.equal(
      caseToDraft(SUPPLIER, { case_number: "X-1" }),
      null,
      "no date → null",
    );
  });

  it("uses statute code 0 for unknown statutes", () => {
    const d = caseToDraft(SUPPLIER, {
      case_number: "MISC-1",
      case_law_section_code: "UNKNOWN_ACT",
      settlement_date: "2024-01-01",
    });
    assert.equal(d!.value, 0);
  });
});

describe("parseEchoCaseResponse", () => {
  it("emits one draft per usable case and skips bad rows", () => {
    const res: EchoCaseSearchResponse = {
      Results: {
        QueryRows: 3,
        Cases: [
          CWA_CASE,
          RCRA_CASE,
          { case_law_section_code: "CAA" /* no number → skip */ },
        ],
      },
    };
    const drafts = parseEchoCaseResponse(SUPPLIER, res);
    assert.equal(drafts.length, 2);
  });

  it("returns [] when Results.Cases is missing", () => {
    assert.equal(parseEchoCaseResponse(SUPPLIER, {}).length, 0);
  });
});

describe("epaEchoCollector schema + key", () => {
  it("schema accepts every draft", () => {
    const drafts = parseEchoCaseResponse(SUPPLIER, {
      Results: { Cases: [CWA_CASE, RCRA_CASE] },
    });
    for (const d of drafts) {
      const r = epaEchoCollector.signalSchema.safeParse(d);
      assert.ok(r.success, JSON.stringify(r));
    }
  });

  it("stable signal keys are unique across distinct cases", () => {
    const drafts = parseEchoCaseResponse(SUPPLIER, {
      Results: { Cases: [CWA_CASE, RCRA_CASE] },
    });
    const keys = drafts.map(epaEchoCollector.stableSignalKey);
    assert.equal(new Set(keys).size, keys.length);
  });
});
