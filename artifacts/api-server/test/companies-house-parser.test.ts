/**
 * Companies House parser tests.
 *
 * Pins the contract that:
 *   - filings → corporate_filing drafts with category code in `value`
 *   - transaction_id is the per-row scope_sku
 *   - GB lane / GBP currency / ent_companies_house_<num> uid
 *   - schema validates and stable keys are unique per filing
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseFilingHistory,
  filingToDraft,
  FILING_CATEGORY_CODES,
  companiesHouseCollector,
  type ChCompanyProfile,
  type ChFilingHistory,
} from "../src/lib/intelligence/collectors/companies-house";

const COMPANY: ChCompanyProfile = {
  company_number: "00006245",
  company_name: "BP P.L.C.",
  jurisdiction: "england-wales",
  company_status: "active",
  type: "plc",
};

const HISTORY: ChFilingHistory = {
  total_count: 4,
  items: [
    {
      transaction_id: "MzM5OTk5OTk5OWFkaXF6a2N4",
      category: "accounts",
      description: "accounts-with-accounts-type-full",
      type: "AA",
      date: "2026-04-01",
      links: { self: "/company/00006245/filing-history/MzM5OTk5OTk5OWFkaXF6a2N4" },
    },
    {
      transaction_id: "MzM5OTk5OTk5OWFkaXF6a2N5",
      category: "confirmation-statement",
      description: "confirmation-statement-with-updates",
      type: "CS01",
      date: "2026-03-15",
    },
    {
      transaction_id: "MzM5OTk5OTk5OWFkaXF6a2N6",
      category: "officers",
      description: "termination-director-company-with-name",
      type: "TM01",
      date: "2026-02-20",
    },
    {
      // No transaction id → dropped
      category: "accounts",
      description: "x",
      date: "2026-01-01",
    },
  ],
};

describe("filingToDraft", () => {
  it("maps category to value via FILING_CATEGORY_CODES", () => {
    const drafts = parseFilingHistory(COMPANY, HISTORY);
    assert.equal(drafts.length, 3);
    assert.equal(drafts[0]!.value, FILING_CATEGORY_CODES["accounts"]);
    assert.equal(drafts[1]!.value, FILING_CATEGORY_CODES["confirmation-statement"]);
    assert.equal(drafts[2]!.value, FILING_CATEGORY_CODES["officers"]);
  });

  it("emits scope_sku = transaction_id and surfaces companyNumber for the resolver", () => {
    // Parser is pure — entityUid is populated by the collector's
    // resolver pass via the Foundation entity-resolver. The parser is
    // responsible for surfacing companyNumber in metadata.
    const drafts = parseFilingHistory(COMPANY, HISTORY);
    assert.equal(drafts[0]!.scopeSku, "MzM5OTk5OTk5OWFkaXF6a2N4");
    assert.equal(drafts[0]!.entityUid, undefined);
    assert.equal(
      (drafts[0]!.metadata as Record<string, unknown>)["companyNumber"],
      "00006245",
    );
    assert.equal(drafts[0]!.scopeSupplierName, "BP P.L.C.");
    assert.equal(drafts[0]!.currency, "GBP");
    assert.equal(drafts[0]!.scopeLaneKey, "england-wales");
  });

  it("drops rows without a transaction id or date", () => {
    assert.equal(
      filingToDraft(COMPANY, { category: "accounts", date: "2026-01-01" }),
      null,
    );
    assert.equal(
      filingToDraft(COMPANY, { transaction_id: "x", category: "accounts" }),
      null,
    );
  });

  it("falls back to other (0) for unknown filing categories", () => {
    const d = filingToDraft(COMPANY, {
      transaction_id: "x",
      category: "wibble",
      date: "2026-01-01",
    });
    assert.ok(d);
    assert.equal(d.value, 0);
  });

  it("constructs sourceUrl from links.self when present", () => {
    const drafts = parseFilingHistory(COMPANY, HISTORY);
    assert.equal(
      drafts[0]!.sourceUrl,
      "https://find-and-update.company-information.service.gov.uk/company/00006245/filing-history/MzM5OTk5OTk5OWFkaXF6a2N4",
    );
    // No links.self → company-level fallback URL.
    assert.equal(
      drafts[1]!.sourceUrl,
      "https://find-and-update.company-information.service.gov.uk/company/00006245",
    );
  });
});

describe("parseFilingHistory", () => {
  it("schema validates every produced draft", () => {
    const drafts = parseFilingHistory(COMPANY, HISTORY);
    for (const d of drafts) {
      const r = companiesHouseCollector.signalSchema.safeParse(d);
      assert.ok(r.success, JSON.stringify(r));
    }
  });

  it("stable signal keys are unique per filing and idempotent across re-parses", () => {
    const a = parseFilingHistory(COMPANY, HISTORY).map(
      companiesHouseCollector.stableSignalKey,
    );
    const b = parseFilingHistory(COMPANY, HISTORY).map(
      companiesHouseCollector.stableSignalKey,
    );
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length);
  });
});
