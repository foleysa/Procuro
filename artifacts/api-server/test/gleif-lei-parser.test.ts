/**
 * GLEIF LEI parser tests.
 *
 * Pins the contract that:
 *   - one record → one entity_registry draft
 *   - registration status → numeric value mapping is stable
 *   - LEI → ent_lei_<LEI> uid is deterministic
 *   - schema validates and stable keys are unique
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGleifResponse,
  recordToDraft,
  GLEIF_REGISTRATION_STATUS_CODES,
  gleifLeiCollector,
  type GleifResponse,
} from "../src/lib/intelligence/collectors/gleif-lei";

const RESPONSE: GleifResponse = {
  data: [
    {
      id: "549300ABCDEF1234WXYZ",
      type: "lei-records",
      attributes: {
        lei: "549300ABCDEF1234WXYZ",
        entity: {
          legalName: { name: "Acme Industries Plc" },
          jurisdiction: "GB",
          legalAddress: { country: "GB" },
          headquartersAddress: { country: "GB" },
          status: "ACTIVE",
        },
        registration: {
          status: "ISSUED",
          lastUpdateDate: "2026-04-15T00:00:00Z",
          initialRegistrationDate: "2014-06-01T00:00:00Z",
        },
      },
    },
    {
      id: "5493001ZYXWVUTS9876",
      attributes: {
        lei: "5493001ZYXWVUTS9876",
        entity: {
          legalName: { name: "Beta Holdings GmbH" },
          jurisdiction: "DE",
          headquartersAddress: { country: "DE" },
        },
        registration: {
          status: "LAPSED",
          lastUpdateDate: "2026-02-01T00:00:00Z",
        },
      },
    },
  ],
  meta: { pagination: { currentPage: 1, lastPage: 1, total: 2 } },
};

describe("recordToDraft", () => {
  it("maps registration status to value via GLEIF_REGISTRATION_STATUS_CODES", () => {
    const drafts = parseGleifResponse(RESPONSE);
    assert.equal(drafts.length, 2);
    assert.equal(drafts[0]!.value, GLEIF_REGISTRATION_STATUS_CODES["ISSUED"]);
    assert.equal(drafts[1]!.value, GLEIF_REGISTRATION_STATUS_CODES["LAPSED"]);
  });

  it("surfaces the LEI in metadata so the resolver can build the uid", () => {
    // Parser is pure — entityUid is populated by the collector's
    // resolver pass. The parser is responsible for surfacing the LEI
    // in metadata (and as scope_sku) so the resolver has what it
    // needs to land a deterministic ent_lei_* uid.
    const drafts = parseGleifResponse(RESPONSE);
    assert.equal(drafts[0]!.entityUid, undefined);
    assert.equal(
      (drafts[0]!.metadata as Record<string, unknown>)["lei"],
      "549300ABCDEF1234WXYZ",
    );
    assert.equal(
      (drafts[1]!.metadata as Record<string, unknown>)["lei"],
      "5493001ZYXWVUTS9876",
    );
  });

  it("uses jurisdiction as scope_lane_key, falling back to country", () => {
    const drafts = parseGleifResponse(RESPONSE);
    assert.equal(drafts[0]!.scopeLaneKey, "GB");
    assert.equal(drafts[1]!.scopeLaneKey, "DE");
  });

  it("returns null when LEI or legal name is missing", () => {
    assert.equal(recordToDraft({ id: "x", attributes: {} }), null);
    assert.equal(
      recordToDraft({ id: "x", attributes: { lei: "x", entity: {} } }),
      null,
    );
  });

  it("falls back to OTHER (0) for unknown registration statuses", () => {
    const d = recordToDraft({
      id: "x",
      attributes: {
        lei: "x",
        entity: { legalName: { name: "Z" } },
        registration: { status: "WIBBLE" },
      },
    });
    assert.ok(d);
    assert.equal(d.value, 0);
  });
});

describe("parseGleifResponse", () => {
  it("schema validates every produced draft", () => {
    const drafts = parseGleifResponse(RESPONSE);
    for (const d of drafts) {
      const r = gleifLeiCollector.signalSchema.safeParse(d);
      assert.ok(r.success, JSON.stringify(r));
    }
  });

  it("stable signal keys are unique and idempotent across re-parses", () => {
    const a = parseGleifResponse(RESPONSE).map(gleifLeiCollector.stableSignalKey);
    const b = parseGleifResponse(RESPONSE).map(gleifLeiCollector.stableSignalKey);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length);
  });
});
