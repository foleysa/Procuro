/**
 * OpenSanctions JSONL parser tests.
 *
 * Pins the contract that:
 *   - one entity per JSONL line → one risk_screening_match draft
 *   - LEI-bearing entities resolve to a deterministic ent_lei_* uid
 *   - cap is honoured
 *   - schema validation passes
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOpenSanctionsLine,
  parseOpenSanctionsJsonl,
  FTM_SCHEMA_CLASS,
  opensanctionsCollector,
} from "../src/lib/intelligence/collectors/opensanctions";

function entityLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "NK-acme-1",
    schema: "Organization",
    caption: "Acme Trading Group",
    properties: {
      name: ["Acme Trading Group"],
      country: ["ru"],
      topics: ["sanction", "role.pep"],
      leiCode: ["549300ABCDEF1234WXYZ"],
      modifiedAt: ["2026-04-15T00:00:00Z"],
      sourceUrl: ["https://www.opensanctions.org/entities/NK-acme-1/"],
    },
    referents: ["ofac-1234"],
    datasets: ["sanctions", "us_ofac_sdn"],
    ...overrides,
  });
}

describe("parseOpenSanctionsLine", () => {
  it("emits a draft with the expected shape", () => {
    const d = parseOpenSanctionsLine(entityLine());
    assert.ok(d);
    assert.equal(d.signalType, "risk_screening_match");
    assert.equal(d.scopeSupplierName, "Acme Trading Group");
    assert.equal(d.scopeSku, "NK-acme-1");
    assert.equal(d.scopeLaneKey, "ru");
    assert.equal(d.value, FTM_SCHEMA_CLASS["Organization"]);
    // LEI-bearing entities leave entityUid null at parse time so the
    // collector's resolver pass can map them to the canonical
    // Foundation uid (ent_lei_<lower>). The parser is responsible for
    // surfacing the LEI in metadata + scope_sku for the resolver.
    assert.equal(d.entityUid, null);
    const meta = d.metadata as Record<string, unknown>;
    assert.deepEqual(meta["topics"], ["sanction", "role.pep"]);
    assert.equal(meta["lei"], "549300ABCDEF1234WXYZ");
  });

  it("falls back to ent_opensanctions_ id when no LEI", () => {
    const d = parseOpenSanctionsLine(
      entityLine({ properties: { name: ["No LEI"], country: ["us"], topics: [] } }),
    );
    assert.ok(d);
    assert.equal(d.entityUid, "ent_opensanctions_NK-acme-1");
  });

  it("returns null for malformed JSON", () => {
    assert.equal(parseOpenSanctionsLine("{not json"), null);
  });

  it("returns null for entries with no id or no name", () => {
    assert.equal(parseOpenSanctionsLine(JSON.stringify({})), null);
    assert.equal(
      parseOpenSanctionsLine(JSON.stringify({ id: "x", schema: "Person" })),
      null,
    );
  });

  it("schema accepts the parser output", () => {
    const d = parseOpenSanctionsLine(entityLine());
    assert.ok(d);
    const r = opensanctionsCollector.signalSchema.safeParse(d);
    assert.ok(r.success, JSON.stringify(r));
  });
});

describe("parseOpenSanctionsJsonl", () => {
  it("respects the cap and preserves order", () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      entityLine({ id: `e-${i}` }),
    ).join("\n");
    const drafts = parseOpenSanctionsJsonl(lines, 10);
    assert.equal(drafts.length, 10);
    assert.equal(drafts[0]!.scopeSku, "e-0");
    assert.equal(drafts[9]!.scopeSku, "e-9");
  });

  it("stable signal keys are unique per entity", () => {
    const lines = ["e-1", "e-2", "e-3"]
      .map((id) => entityLine({ id }))
      .join("\n");
    const keys = parseOpenSanctionsJsonl(lines).map(
      opensanctionsCollector.stableSignalKey,
    );
    assert.equal(new Set(keys).size, 3);
  });
});
