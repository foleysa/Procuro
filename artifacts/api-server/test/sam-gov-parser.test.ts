/**
 * Parser + contract guardrail tests for the SAM.gov collector. We pin
 * two things that must hold for the supplier-intelligence and
 * alert-fanout surfaces to behave correctly:
 *
 *   1. The entity / exclusion JSON envelopes parse into the documented
 *      record shape, including defensive handling of missing fields.
 *   2. SAM exclusions emit a `sanctions_match` draft whose `value` is
 *      the reserved list code 5 — that's what the existing alert
 *      fan-out reads to fire a critical-severity tenant alert.
 */
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const samMod = await import(
  "../src/lib/intelligence/collectors/sam-gov"
);
const {
  parseSamEntities,
  parseSamExclusions,
  SAM_EXCLUSION_LIST_CODE,
  SAM_REGISTRATION_STATUS_CODES,
  samGovCollector,
} = samMod;

const ENTITY_SAMPLE = {
  entityData: [
    {
      entityRegistration: {
        ueiSAM: "ABCD1234EFGH",
        legalBusinessName: "ACME DEFENSE SYSTEMS LLC",
        registrationStatus: "Active",
        registrationDate: "2024-06-01",
        registrationExpirationDate: "2025-06-01",
      },
      coreData: { entityInformation: { countryCode: "USA" } },
    },
    // Missing legalBusinessName — must be dropped.
    { entityRegistration: { ueiSAM: "XXXX0000ZZZZ" } },
  ],
};

const EXCLUSION_SAMPLE = {
  excludedEntity: [
    {
      exclusionName: "BAD ACTOR INC",
      classificationType: "Firm",
      countryCode: "USA",
      ueiSAM: "PPPP9999QQQQ",
      activationDate: "2025-11-04",
      terminationDate: "Indefinite",
      recordId: "rec-12345",
      exclusionDetails: {
        exclusionType: "Reciprocal",
        excludingAgencyCode: "DOD",
        exclusionProgram: "Procurement",
      },
    },
  ],
};

test("parseSamEntities extracts the documented entityRegistration columns", () => {
  const records = parseSamEntities(ENTITY_SAMPLE);
  assert.equal(records.length, 1, "one parseable entity from the sample");
  const r = records[0]!;
  assert.equal(r.legalBusinessName, "ACME DEFENSE SYSTEMS LLC");
  assert.equal(r.ueiSAM, "ABCD1234EFGH");
  assert.equal(r.registrationStatus, "Active");
  assert.equal(r.countryCode, "USA");
  assert.ok(r.registrationDate instanceof Date);
  assert.ok(r.expirationDate instanceof Date);
});

test("parseSamExclusions extracts the documented excludedEntity columns", () => {
  const records = parseSamExclusions(EXCLUSION_SAMPLE);
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.legalBusinessName, "BAD ACTOR INC");
  assert.equal(r.ueiSAM, "PPPP9999QQQQ");
  assert.equal(r.exclusionType, "Reciprocal");
  assert.equal(r.excludingAgencyCode, "DOD");
  assert.equal(r.exclusionProgram, "Procurement");
  assert.equal(r.exclusionId, "rec-12345");
  assert.ok(r.activationDate instanceof Date);
});

test("parseSamEntities and parseSamExclusions tolerate malformed payloads", () => {
  assert.deepEqual(parseSamEntities(null), []);
  assert.deepEqual(parseSamEntities({}), []);
  assert.deepEqual(parseSamEntities({ entityData: "x" }), []);
  assert.deepEqual(parseSamExclusions(null), []);
  assert.deepEqual(parseSamExclusions({}), []);
  assert.deepEqual(parseSamExclusions({ excludedEntity: 42 }), []);
});

test("SAM exclusion list code is reserved at 5 (extends OFAC/EU/UK/UN)", () => {
  // Pin the contract that the supplier-intelligence renderer + alert
  // fanout depend on — list codes 1..4 are OFAC/EU/UK/UN, and 5 must
  // remain SAM.gov so a draft built with this code routes through the
  // critical sanctions_match fan-out path.
  assert.equal(SAM_EXCLUSION_LIST_CODE, 5);
});

test("SAM registration status codes pin the documented mapping", () => {
  assert.deepEqual(SAM_REGISTRATION_STATUS_CODES, {
    Active: 1,
    Expired: 2,
    Inactive: 3,
    Other: 4,
  });
});

test("sam-gov collector contract registers as a public-API US source", () => {
  assert.equal(samGovCollector.id, "sam-gov");
  assert.equal(samGovCollector.posture, "public-api");
  assert.equal(samGovCollector.postureClass, "public_api");
  assert.equal(samGovCollector.disclosureTier, "T1");
  assert.equal(samGovCollector.jurisdiction, "US");
  assert.equal(samGovCollector.tenantOptInDefault, true);
});

test("sam-gov collector returns zero drafts when SAM_GOV_API_KEY is missing", async () => {
  // Graceful degradation contract: missing key is a config gap, not a
  // runtime failure, so the collector must succeed with an empty result
  // rather than throwing.
  const previous = process.env["SAM_GOV_API_KEY"];
  delete process.env["SAM_GOV_API_KEY"];
  try {
    const result = await samGovCollector.collectWithRaw!({
      since: null,
    });
    assert.deepEqual(result.drafts, []);
    assert.deepEqual(result.rawPayloads, []);
  } finally {
    if (previous !== undefined) process.env["SAM_GOV_API_KEY"] = previous;
  }
});
