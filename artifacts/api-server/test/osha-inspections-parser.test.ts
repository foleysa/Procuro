/**
 * OSHA Inspections parser tests.
 *
 * Pins:
 *   - `inspectionToDraft` emits `workplace_safety_incident` with the
 *     right scope code, lane key, and violation metadata.
 *   - `parseOshaResponse` skips rows lacking `activity_nr` or a usable
 *     date.
 *   - `oshaInspectionsCollector.signalSchema` accepts every parser
 *     draft and `stableSignalKey` is unique across the mixed set.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inspectionToDraft,
  parseOshaResponse,
  oshaInspectionsCollector,
  OSHA_INSPECTION_SCOPE_CODES,
  type OshaInspection,
  type OshaSearchResponse,
} from "../src/lib/intelligence/collectors/osha-inspections";

const SUPPLIER = {
  name: "Acme Manufacturing Inc",
  normalizedName: "acme manufacturing inc",
};

const PARTIAL: OshaInspection = {
  activity_nr: "1234567.015",
  estab_name: "ACME MANUFACTURING INC",
  site_address: "123 Main St",
  site_city: "Houston",
  site_state: "TX",
  site_zip: "77002",
  open_date: "2024-08-15",
  close_case_date: "2024-09-01",
  naics_code: "332710",
  scope_label: "Partial",
  total_violations: "5",
  total_penalty: "35,000",
  violations: [
    {
      citation_id: "01001A",
      standard: "1910.147(c)(4)",
      gravity: 8,
      initial_penalty: 14502,
      current_penalty: 7251,
      citation_type: "Serious",
    },
  ],
};

const ACCIDENT: OshaInspection = {
  activity_nr: "9999999.001",
  estab_name: "ACME LOGISTICS",
  site_state: "OH",
  open_date: "2024-06-01",
  scope_label: "Accident",
  total_violations: 2,
  total_penalty: 9000,
};

describe("inspectionToDraft", () => {
  it("maps scope label → numeric code and stamps violation metadata", () => {
    const d = inspectionToDraft(SUPPLIER, PARTIAL);
    assert.ok(d);
    assert.equal(d!.signalType, "workplace_safety_incident");
    assert.equal(d!.value, OSHA_INSPECTION_SCOPE_CODES["Partial"]);
    assert.equal(d!.scopeSku, "1234567.015");
    assert.equal(d!.scopeLaneKey, "TX");
    assert.equal(d!.observedAt.toISOString(), "2024-08-15T00:00:00.000Z");
    const md = d!.metadata as Record<string, unknown>;
    assert.equal(md["totalViolations"], 5);
    assert.equal(md["totalPenaltyUsd"], 35000);
    assert.equal(md["scopeLabel"], "Partial");
    const vios = md["violations"] as Array<Record<string, unknown>>;
    assert.equal(vios.length, 1);
    assert.equal(vios[0]!["citationId"], "01001A");
    assert.equal(vios[0]!["initialPenaltyUsd"], 14502);
    assert.equal(vios[0]!["gravity"], 8);
  });

  it("falls back to close_case_date when open_date missing, and uses scope=0 for unknown labels", () => {
    const d = inspectionToDraft(SUPPLIER, {
      activity_nr: "555.001",
      close_case_date: "2024-03-15",
      scope_label: "UnknownScope",
    });
    assert.ok(d);
    assert.equal(d!.value, 0);
    assert.equal(d!.observedAt.toISOString(), "2024-03-15T00:00:00.000Z");
    assert.equal(d!.scopeLaneKey, "US");
  });

  it("returns null for rows lacking activity_nr or any date", () => {
    assert.equal(inspectionToDraft(SUPPLIER, { scope_label: "Partial" }), null);
    assert.equal(inspectionToDraft(SUPPLIER, { activity_nr: "X" }), null);
  });
});

describe("parseOshaResponse", () => {
  it("emits one draft per usable inspection and skips bad rows", () => {
    const res: OshaSearchResponse = {
      inspections: [
        PARTIAL,
        ACCIDENT,
        { scope_label: "Partial" /* no activity_nr → skip */ },
      ],
    };
    const drafts = parseOshaResponse(SUPPLIER, res);
    assert.equal(drafts.length, 2);
    assert.equal(drafts[1]!.value, OSHA_INSPECTION_SCOPE_CODES["Accident"]);
  });

  it("returns [] when inspections is missing", () => {
    assert.equal(parseOshaResponse(SUPPLIER, {}).length, 0);
  });
});

describe("oshaInspectionsCollector schema + key", () => {
  it("schema accepts every draft", () => {
    const drafts = parseOshaResponse(SUPPLIER, {
      inspections: [PARTIAL, ACCIDENT],
    });
    for (const d of drafts) {
      const r = oshaInspectionsCollector.signalSchema.safeParse(d);
      assert.ok(r.success, JSON.stringify(r));
    }
  });

  it("stable signal keys are unique across distinct inspections", () => {
    const drafts = parseOshaResponse(SUPPLIER, {
      inspections: [PARTIAL, ACCIDENT],
    });
    const keys = drafts.map(oshaInspectionsCollector.stableSignalKey);
    assert.equal(new Set(keys).size, keys.length);
  });
});
