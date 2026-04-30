/**
 * Government sanctions collector parser tests.
 *
 * Pins the contract that:
 *   - OFAC SDN, EU, UK OFSI CSV, UN XML are each parsed into the same
 *     SanctionsEntry shape
 *   - entryToDraft produces a schema-valid sanctions_match draft
 *   - the source list code in `value` matches SANCTIONS_LIST_CODES
 *   - stable signal keys are unique per (list, entry id)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOfacSdn,
  parseEuSanctions,
  parseUkOfsiCsv,
  parseUnSanctions,
  entryToDraft,
  splitCsvRow,
  SANCTIONS_LIST_CODES,
  governmentSanctionsCollector,
} from "../src/lib/intelligence/collectors/government-sanctions";

const OBSERVED = new Date("2026-04-30T00:00:00Z");

const OFAC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sdnList>
  <sdnEntry>
    <uid>12345</uid>
    <firstName>Ivan</firstName>
    <lastName>Ivanov</lastName>
    <sdnType>Individual</sdnType>
    <programList><program>UKRAINE-EO13662</program></programList>
    <addressList><address><country>RUSSIA</country></address></addressList>
  </sdnEntry>
  <sdnEntry>
    <uid>67890</uid>
    <lastName>OAO Acme</lastName>
    <sdnType>Entity</sdnType>
    <programList><program>SDGT</program></programList>
    <addressList><address><country>SYRIA</country></address></addressList>
  </sdnEntry>
</sdnList>`;

describe("parseOfacSdn", () => {
  it("emits one entry per <sdnEntry> with combined name for individuals", () => {
    const entries = parseOfacSdn(OFAC_XML, OBSERVED);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.name, "Ivan Ivanov");
    assert.equal(entries[0]!.type, "Individual");
    assert.equal(entries[0]!.country, "RUSSIA");
    assert.equal(entries[0]!.program, "UKRAINE-EO13662");
    assert.equal(entries[1]!.name, "OAO Acme");
    assert.equal(entries[1]!.type, "Entity");
    assert.equal(entries[1]!.listCode, SANCTIONS_LIST_CODES.OFAC);
  });
});

const EU_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sanctionsList>
  <sanctionEntity logicalId="11111">
    <subjectType code="enterprise"/>
    <wholeName>Acme Logistics LLC</wholeName>
    <regulation>Council Regulation (EU) 833/2014</regulation>
    <countryDescription>RU</countryDescription>
  </sanctionEntity>
  <sanctionEntity logicalId="22222">
    <subjectType code="person"/>
    <wholeName>Sergei Petrov</wholeName>
    <regulation>Council Regulation (EU) 269/2014</regulation>
    <countryDescription>RU</countryDescription>
  </sanctionEntity>
</sanctionsList>`;

describe("parseEuSanctions", () => {
  it("parses logicalId, subject type, and name", () => {
    const entries = parseEuSanctions(EU_XML, OBSERVED);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.entryId, "11111");
    assert.equal(entries[0]!.type, "Entity");
    assert.equal(entries[0]!.name, "Acme Logistics LLC");
    assert.equal(entries[1]!.type, "Individual");
    assert.equal(entries[0]!.listCode, SANCTIONS_LIST_CODES.EU);
  });
});

const UK_CSV = `Office of Financial Sanctions Implementation
HM Treasury
Generated:,2026-04-30
Group ID,Name 1,Name 2,Name 3,Name 4,Name 5,Name 6,Country (Reg),Group Type,Regime
9001,DOE,JOHN,,,,,GB,Individual,Russia
9002,,,,,,Acme Defense Ltd,RU,Entity,Russia
`;

describe("parseUkOfsiCsv", () => {
  it("skips rows whose Name 6 cell is empty (no usable name)", () => {
    const entries = parseUkOfsiCsv(UK_CSV, OBSERVED);
    // 9001 has empty Name 6 → dropped; only 9002 survives.
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.entryId, "9002");
    assert.equal(entries[0]!.type, "Entity");
    assert.equal(entries[0]!.country, "RU");
    assert.equal(entries[0]!.listCode, SANCTIONS_LIST_CODES.UK);
  });
});

describe("splitCsvRow", () => {
  it("handles quoted cells with embedded commas + escaped quotes", () => {
    const cells = splitCsvRow(`a,"b,c","he said ""hi""",d`);
    assert.deepEqual(cells, ["a", "b,c", 'he said "hi"', "d"]);
  });
});

const UN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CONSOLIDATED_LIST>
  <INDIVIDUALS>
    <INDIVIDUAL>
      <DATAID>QDi.001</DATAID>
      <FIRST_NAME>OSAMA</FIRST_NAME>
      <SECOND_NAME>BIN LADIN</SECOND_NAME>
      <NATIONALITY>SAUDI ARABIA</NATIONALITY>
      <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE>
    </INDIVIDUAL>
  </INDIVIDUALS>
  <ENTITIES>
    <ENTITY>
      <DATAID>QDe.014</DATAID>
      <FIRST_NAME>AL-QAIDA</FIRST_NAME>
      <COUNTRY>AFGHANISTAN</COUNTRY>
      <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE>
    </ENTITY>
  </ENTITIES>
</CONSOLIDATED_LIST>`;

describe("parseUnSanctions", () => {
  it("parses both INDIVIDUAL and ENTITY blocks", () => {
    const entries = parseUnSanctions(UN_XML, OBSERVED);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.entryId, "QDi.001");
    assert.equal(entries[0]!.type, "Individual");
    assert.equal(entries[0]!.country, "SAUDI ARABIA");
    assert.equal(entries[1]!.type, "Entity");
    assert.equal(entries[1]!.listCode, SANCTIONS_LIST_CODES.UN);
  });
});

describe("entryToDraft", () => {
  it("emits a schema-valid sanctions_match draft", () => {
    const entries = parseOfacSdn(OFAC_XML, OBSERVED);
    const drafts = entries.map((e) =>
      entryToDraft(e, "https://www.treasury.gov/ofac/downloads/sdn.xml"),
    );
    for (const d of drafts) {
      assert.equal(d.signalType, "sanctions_match");
      assert.equal(d.value, SANCTIONS_LIST_CODES.OFAC);
      assert.match(d.scopeSku ?? "", /^OFAC:/);
      assert.match(d.entityUid ?? "", /^ent_sanctions_ofac_/);
      const r = governmentSanctionsCollector.signalSchema.safeParse(d);
      assert.ok(r.success, JSON.stringify(r));
    }
  });

  it("stable signal keys are unique per (list, entry)", () => {
    const entries = [
      ...parseOfacSdn(OFAC_XML, OBSERVED),
      ...parseUnSanctions(UN_XML, OBSERVED),
    ];
    const drafts = entries.map((e) =>
      entryToDraft(e, "https://example.com/list"),
    );
    const keys = drafts.map(governmentSanctionsCollector.stableSignalKey);
    assert.equal(new Set(keys).size, keys.length);
  });
});
