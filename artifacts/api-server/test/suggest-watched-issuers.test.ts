/**
 * Watched-issuers suggestion engine tests.
 *
 * Pins the contract that:
 *   1. Pure scoring helpers tier exact > strong-overlap > weak-overlap
 *      and reject anything below the weak threshold.
 *   2. The per-supplier engine joins SEC ticker data + GLEIF + (optional)
 *      Companies House into a ranked list and dedupes per source.
 *   3. The route layer:
 *      a. only returns suggestions for the active tenant's suppliers
 *         (no cross-tenant leak);
 *      b. skips suppliers already linked from `watched_issuers`;
 *      c. drops suggestions whose `(source, identifier)` is already
 *         on the tenant's watch list;
 *      d. accepts a `?supplierId=` filter for the per-supplier UI;
 *      e. carries `supplierUid` through every returned suggestion so
 *         the one-click confirm posts the FK back correctly.
 *
 * Network is stubbed end-to-end via the `setSuggestLookupsForTests`
 * seam — the test never touches sec.gov / api.gleif.org.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import {
  db,
  orgsTable,
  suppliersTable,
  watchedIssuersTable,
  pool,
} from "@workspace/db";
import { and, eq, like, inArray } from "drizzle-orm";
import app from "../src/app";
import {
  scoreNameMatch,
  rankSuggestions,
  suggestForSupplier,
  suggestForTenant,
  fetchSecCikByLei,
  _resetSecLeiCacheForTests,
  CONFIDENCE_EXACT,
  CONFIDENCE_STRONG,
  CONFIDENCE_WEAK,
  type ReferenceLookups,
  type WatchedIssuerSuggestion,
} from "../src/lib/intelligence/suggest-watched-issuers";
import {
  setSuggestLookupsForTests,
  resetSuggestLookupsForTests,
} from "../src/routes/watched-issuers";

// LEIs used by the LEI→CIK cross-reference tests. Pinned at module
// scope so the stub and the assertions can't drift apart.
const APPLE_LEI = "HWUPKR0MPOU8FGXBT394";
const APPLE_CIK = "0000320193";
// A US-jurisdiction LEI that has a CIK in EDGAR but whose legal name
// does NOT appear in SEC's ticker index (the "ADR / parent holdco"
// case the cross-reference is designed to recover).
const HOLDCO_LEI = "HOLDCO000000000000XX";
const HOLDCO_CIK = "0000999999";

const RUN_ID = `task130-${Date.now()}-${process.pid}`;

// ---------------------------------------------------------------------------
// Pure scoring helpers
// ---------------------------------------------------------------------------

test("scoreNameMatch tiers exact > strong > weak > below-threshold", () => {
  // Exact (after normalising legal suffixes):
  assert.equal(scoreNameMatch("Apple Inc.", "Apple Inc."), CONFIDENCE_EXACT);
  assert.equal(scoreNameMatch("Apple, Inc", "Apple Inc."), CONFIDENCE_EXACT);

  // Strong (≥2 shared significant tokens that survive normalisation):
  assert.equal(
    scoreNameMatch(
      "International Business Machines",
      "International Business Sciences",
    ),
    CONFIDENCE_STRONG,
  );

  // Strong (single shared token, but it's the only one on the
  // single-token side — distinctive single-token brand).
  assert.equal(
    scoreNameMatch("Tesla", "Tesla Motors"),
    CONFIDENCE_STRONG,
  );

  // Weak (one shared token among many on at least one side):
  assert.equal(
    scoreNameMatch(
      "International Paper Holdings",
      "Paper Mate Industries",
    ),
    CONFIDENCE_WEAK,
  );

  // Below threshold (no shared significant tokens):
  assert.equal(scoreNameMatch("Apple Inc.", "Tesco PLC"), 0);
});

test("rankSuggestions caps per-source and per-supplier", () => {
  const make = (
    id: string,
    source: "sec_edgar" | "companies_house",
    identifier: string,
    confidence: number,
  ): WatchedIssuerSuggestion => ({
    key: `${id}:${source}:${identifier}`,
    supplierUid: id,
    supplierName: "Acme",
    source,
    identifier,
    name: identifier,
    confidence,
    matchReason: "test",
    via: source === "sec_edgar" ? "sec" : "companies_house",
  });

  const ranked = rankSuggestions(
    [
      make("sup1", "sec_edgar", "0000000001", 0.95),
      make("sup1", "sec_edgar", "0000000002", 0.75),
      make("sup1", "sec_edgar", "0000000003", 0.55),
      make("sup1", "sec_edgar", "0000000004", 0.55),
      make("sup1", "companies_house", "00000001", 0.95),
    ],
    { perSourceLimit: 2, perSupplierLimit: 4 },
  );
  // perSource=2 → only top-2 SEC rows survive;
  // total 3 (2 sec + 1 ch); ordered by confidence desc.
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0]!.confidence, 0.95);
});

// ---------------------------------------------------------------------------
// fetchSecCikByLei — parses EDGAR atom feed, handles miss cases, caches
// ---------------------------------------------------------------------------

/**
 * Build the minimal EDGAR atom-feed shape the parser depends on: an
 * <entry> wrapping a link whose href contains `CIK=<digits>`. Real
 * EDGAR responses also have title/updated/etc., but the parser only
 * cares about <entry> presence and the first CIK= token.
 */
function fakeEdgarAtomWithCik(cik: string): string {
  return [
    '<?xml version="1.0" encoding="ISO-8859-1" ?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "  <title>EDGAR Filing Search Results</title>",
    "  <entry>",
    `    <link rel="alternate" type="text/html" href="/cgi-bin/browse-edgar?action=getcompany&amp;CIK=${cik}&amp;type=&amp;dateb=&amp;owner=include&amp;count=10"/>`,
    "  </entry>",
    "</feed>",
  ].join("\n");
}

/** EDGAR's "no match" page: a feed with zero <entry> elements. */
function fakeEdgarAtomNoEntries(): string {
  return [
    '<?xml version="1.0" encoding="ISO-8859-1" ?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "  <title>EDGAR Filing Search Results</title>",
    "</feed>",
  ].join("\n");
}

/**
 * Wrap the global `fetch` for one test, asserting the URL contains the
 * expected LEI and returning a canned response. Returns a counter so
 * the test can assert how many times fetch was actually invoked
 * (cache hit vs miss).
 */
function withFetchStub<T>(
  responder: (url: string) => { status: number; body: string },
  fn: (callCount: () => number) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls++;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const r = responder(url);
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
  return fn(() => calls).finally(() => {
    globalThis.fetch = original;
  });
}

test("fetchSecCikByLei parses CIK from EDGAR atom feed and pads to 10 digits", async () => {
  _resetSecLeiCacheForTests();
  await withFetchStub(
    (url) => {
      // Sanity: the request must include the LEI in the query string.
      assert.match(url, /LEI=HWUPKR0MPOU8FGXBT394/);
      // EDGAR returns the unpadded CIK in the link href; the parser
      // is responsible for padCik().
      return { status: 200, body: fakeEdgarAtomWithCik("320193") };
    },
    async () => {
      const cik = await fetchSecCikByLei("HWUPKR0MPOU8FGXBT394");
      assert.equal(cik, "0000320193");
    },
  );
});

test("fetchSecCikByLei normalises lowercase LEI input (cache key + URL upper-case)", async () => {
  _resetSecLeiCacheForTests();
  await withFetchStub(
    (url) => {
      assert.match(url, /LEI=HWUPKR0MPOU8FGXBT394/);
      return { status: 200, body: fakeEdgarAtomWithCik("0000320193") };
    },
    async () => {
      const cik = await fetchSecCikByLei("hwupkr0mpou8fgxbt394");
      assert.equal(cik, "0000320193");
    },
  );
});

test("fetchSecCikByLei returns null for HTTP 404 (LEI unknown to EDGAR)", async () => {
  _resetSecLeiCacheForTests();
  await withFetchStub(
    () => ({ status: 404, body: "Not Found" }),
    async () => {
      const cik = await fetchSecCikByLei("UNKNOWN0000000000000");
      assert.equal(cik, null);
    },
  );
});

test("fetchSecCikByLei returns null when the feed has zero <entry> elements", async () => {
  _resetSecLeiCacheForTests();
  await withFetchStub(
    () => ({ status: 200, body: fakeEdgarAtomNoEntries() }),
    async () => {
      const cik = await fetchSecCikByLei("EMPTY00000000000000X");
      assert.equal(cik, null);
    },
  );
});

test("fetchSecCikByLei throws on non-404 upstream errors so the engine can log them", async () => {
  _resetSecLeiCacheForTests();
  await withFetchStub(
    () => ({ status: 503, body: "Service Unavailable" }),
    async () => {
      await assert.rejects(
        fetchSecCikByLei("ANYLEI00000000000000"),
        /HTTP 503/,
      );
    },
  );
});

test("fetchSecCikByLei caches positive AND negative results per LEI", async () => {
  _resetSecLeiCacheForTests();
  // Positive: hit + cache hit.
  await withFetchStub(
    () => ({ status: 200, body: fakeEdgarAtomWithCik("789019") }),
    async (callCount) => {
      const a = await fetchSecCikByLei("INR2EJN1ERAN0W5ZP974");
      const b = await fetchSecCikByLei("INR2EJN1ERAN0W5ZP974");
      assert.equal(a, "0000789019");
      assert.equal(b, "0000789019");
      assert.equal(
        callCount(),
        1,
        "second lookup must be served from cache, not re-fetched",
      );
    },
  );
  // Negative: a 404 result should also be cached so we don't keep
  // hammering EDGAR for an LEI we already know it doesn't have.
  await withFetchStub(
    () => ({ status: 404, body: "Not Found" }),
    async (callCount) => {
      const a = await fetchSecCikByLei("MISSING000000000000X");
      const b = await fetchSecCikByLei("MISSING000000000000X");
      assert.equal(a, null);
      assert.equal(b, null);
      assert.equal(
        callCount(),
        1,
        "negative lookup must also be cached to spare EDGAR's rate budget",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Per-supplier orchestration with stubbed lookups
// ---------------------------------------------------------------------------

const STUB_LOOKUPS: ReferenceLookups = {
  async secTickerIndex() {
    return [
      { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
      { cik_str: 789019, ticker: "MSFT", title: "Microsoft Corporation" },
      { cik_str: 1018724, ticker: "AMZN", title: "Amazon.com Inc." },
    ];
  },
  async gleifByName(name) {
    if (/apple/i.test(name)) {
      return [
        {
          lei: APPLE_LEI,
          legalName: "Apple Inc.",
          jurisdiction: "US-CA",
          legalAddressCountry: "US",
          headquartersCountry: "US",
        },
      ];
    }
    if (/holdco/i.test(name)) {
      // GLEIF returns a US-jurisdiction parent holdco match whose
      // legal name does NOT appear in the SEC ticker index — exactly
      // the case the LEI→CIK cross-reference is meant to recover.
      return [
        {
          lei: HOLDCO_LEI,
          legalName: "Holdco Industries Inc.",
          jurisdiction: "US-DE",
          legalAddressCountry: "US",
          headquartersCountry: "US",
        },
      ];
    }
    if (/bp/i.test(name) || /tesco/i.test(name)) {
      // GLEIF for UK entities: returned but the engine should NOT
      // emit them as sec_edgar suggestions (UK supplier → CH path).
      return [
        {
          lei: "213800LBQA1Y9L22JB70",
          legalName: name,
          jurisdiction: "GB",
          legalAddressCountry: "GB",
          headquartersCountry: "GB",
        },
      ];
    }
    return [];
  },
  async companiesHouseSearch(name, apiKey) {
    if (!apiKey) return null;
    if (/tesco/i.test(name)) {
      return [
        {
          companyNumber: "00010892",
          title: "Tesco PLC",
          companyStatus: "active",
        },
      ];
    }
    if (/dissolved/i.test(name)) {
      return [
        {
          companyNumber: "12345678",
          title: name,
          companyStatus: "dissolved",
        },
      ];
    }
    return [];
  },
  async secCikByLei(lei) {
    if (lei === APPLE_LEI) return APPLE_CIK;
    if (lei === HOLDCO_LEI) return HOLDCO_CIK;
    return null;
  },
};

test("suggestForSupplier — US supplier → SEC suggestion with LEI merged from GLEIF", async () => {
  const out = await suggestForSupplier(
    { id: "sup_apple", name: "Apple Inc.", countryCode: "US" },
    { lookups: STUB_LOOKUPS },
  );
  // Expect at least one SEC suggestion with the CIK and the LEI from GLEIF merged in.
  const sec = out.find(
    (s) => s.source === "sec_edgar" && s.identifier === APPLE_CIK,
  );
  assert.ok(sec, `expected SEC suggestion for Apple, got ${JSON.stringify(out)}`);
  assert.equal(sec!.confidence, CONFIDENCE_EXACT);
  assert.equal(sec!.lei, APPLE_LEI);
  assert.equal(sec!.ticker, "AAPL");
  assert.equal(sec!.supplierUid, "sup_apple");
  // Apple is in the SEC ticker index, so even though the LEI cross-
  // reference would resolve to the same CIK, the engine must emit
  // exactly ONE Apple row — the ticker hit with the LEI merged in.
  const allApple = out.filter(
    (s) => s.source === "sec_edgar" && s.identifier === APPLE_CIK,
  );
  assert.equal(
    allApple.length,
    1,
    `expected exactly one Apple SEC row after LEI cross-reference, got ${JSON.stringify(allApple)}`,
  );
});

test("suggestForSupplier — GLEIF-only US match resolved to SEC CIK via LEI cross-reference", async () => {
  // The "Holdco Industries" name is NOT in SEC's ticker index, so
  // pre-cross-reference there'd be zero confirmable suggestions.
  // GLEIF returns an LEI for the US-jurisdiction parent, which the
  // LEI→CIK lookup converts into a confirmable sec_edgar row.
  const out = await suggestForSupplier(
    { id: "sup_holdco", name: "Holdco Industries", countryCode: "US" },
    { lookups: STUB_LOOKUPS },
  );
  const sec = out.find(
    (s) => s.source === "sec_edgar" && s.identifier === HOLDCO_CIK,
  );
  assert.ok(
    sec,
    `expected GLEIF→LEI→CIK suggestion for Holdco, got ${JSON.stringify(out)}`,
  );
  assert.equal(sec!.lei, HOLDCO_LEI);
  assert.equal(sec!.via, "gleif");
  assert.equal(sec!.name, "Holdco Industries Inc.");
  assert.equal(sec!.supplierUid, "sup_holdco");
  // Score is carried over from the GLEIF name match, not invented.
  assert.ok(sec!.confidence >= CONFIDENCE_WEAK);
  // Reason cites the LEI cross-reference so an operator can tell at
  // a glance that this row didn't come from the ticker index.
  assert.match(sec!.matchReason, /SEC LEI cross-reference/);
});

test("suggestForSupplier — LEI without an EDGAR registrant produces no SEC suggestion", async () => {
  // Stub returns a non-US, non-UK GLEIF hit whose LEI isn't in EDGAR.
  // The engine must NOT fabricate a CIK — the row is simply dropped.
  const lookups: ReferenceLookups = {
    ...STUB_LOOKUPS,
    async gleifByName(name) {
      if (/orphan/i.test(name)) {
        return [
          {
            lei: "ORPHAN0000000000000X",
            legalName: "Orphan Holdings AG",
            jurisdiction: "DE",
            legalAddressCountry: "DE",
            headquartersCountry: "DE",
          },
        ];
      }
      return [];
    },
    async secCikByLei() {
      // EDGAR knows nothing about this LEI.
      return null;
    },
  };
  const out = await suggestForSupplier(
    // No country code on the supplier so the GLEIF row passes the
    // "US-or-supplier-US" filter and reaches the LEI lookup stage.
    { id: "sup_orphan", name: "Orphan Holdings", countryCode: null },
    { lookups },
  );
  assert.equal(
    out.length,
    0,
    `unmatched LEI must not synthesize a SEC suggestion, got ${JSON.stringify(out)}`,
  );
});

test("suggestForSupplier — LEI cross-reference failure is non-fatal (caught per-LEI)", async () => {
  // One GLEIF hit, but the SEC LEI lookup blows up.  The supplier
  // should still get the other suggestions back (here: none, but the
  // call must not throw).
  const lookups: ReferenceLookups = {
    ...STUB_LOOKUPS,
    async secCikByLei() {
      throw new Error("SEC LEI lookup HTTP 503");
    },
  };
  const out = await suggestForSupplier(
    { id: "sup_holdco_err", name: "Holdco Industries", countryCode: "US" },
    { lookups },
  );
  assert.equal(
    out.length,
    0,
    `transient LEI lookup failure must not produce a half-formed suggestion, got ${JSON.stringify(out)}`,
  );
});

test("suggestForSupplier — UK supplier with API key → Companies House suggestion", async () => {
  const out = await suggestForSupplier(
    { id: "sup_tesco", name: "Tesco", countryCode: "GB" },
    { lookups: STUB_LOOKUPS, companiesHouseApiKey: "test-key" },
  );
  const ch = out.find((s) => s.source === "companies_house");
  assert.ok(ch, `expected CH suggestion, got ${JSON.stringify(out)}`);
  assert.equal(ch!.identifier, "00010892");
  // No SEC suggestion for a UK-only entity even though GLEIF returned one
  // (engine drops GLEIF rows whose jurisdiction is GB so we don't push
  // a US-side suggestion for a UK-only legal entity).
  assert.equal(out.find((s) => s.source === "sec_edgar"), undefined);
});

test("suggestForSupplier — UK supplier without API key → no CH lookup runs (returns []) ", async () => {
  const out = await suggestForSupplier(
    { id: "sup_bp", name: "BP", countryCode: "GB" },
    { lookups: STUB_LOOKUPS },
  );
  // No SEC (UK supplier), no CH (no API key).
  assert.equal(out.length, 0);
});

test("suggestForSupplier — supplier with no matches → empty list", async () => {
  const out = await suggestForSupplier(
    { id: "sup_unknown", name: "Some Random Tiny Supplier", countryCode: "US" },
    { lookups: STUB_LOOKUPS },
  );
  assert.equal(out.length, 0);
});

test("suggestForTenant dedupes the same (source, identifier) across suppliers and orders deterministically", async () => {
  // Two distinct suppliers both name-match Apple Inc. — the engine
  // must return only ONE suggestion for that CIK (highest confidence
  // wins, ties broken by supplierUid asc) so that the second supplier's
  // confirm doesn't 409 on the unique (orgId, source, identifier).
  const result = await suggestForTenant({
    suppliers: [
      // Lower-confidence (token overlap) listed first to prove ordering
      // and dedupe doesn't depend on input order.
      { id: "sup_b", name: "Apple Foods Co", countryCode: "US" },
      { id: "sup_a", name: "Apple Inc.", countryCode: "US" },
    ],
    alreadyWatched: { bySupplierUid: new Set(), bySourceIdentifier: new Set() },
    lookups: STUB_LOOKUPS,
  });
  const appleRows = result.suggestions.filter(
    (s) => s.source === "sec_edgar" && s.identifier === "0000320193",
  );
  assert.equal(
    appleRows.length,
    1,
    `expected one Apple suggestion after cross-supplier dedupe, got ${JSON.stringify(appleRows)}`,
  );
  // Highest confidence wins; sup_a's exact match (0.95) beats sup_b.
  assert.equal(appleRows[0]!.supplierUid, "sup_a");
  assert.equal(appleRows[0]!.confidence, CONFIDENCE_EXACT);

  // Output is sorted: confidence desc, then supplierUid asc.
  for (let i = 1; i < result.suggestions.length; i++) {
    const prev = result.suggestions[i - 1]!;
    const cur = result.suggestions[i]!;
    assert.ok(
      prev.confidence >= cur.confidence,
      `suggestions must be sorted by confidence desc; got ${prev.confidence} before ${cur.confidence}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Route integration — uses the dev-only x-org-id header path.
// ---------------------------------------------------------------------------

interface CapturedResponse {
  status: number;
  body: string;
}
async function withServer<T>(
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("expected an AddressInfo for the test server");
    }
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
async function getJson(
  baseUrl: string,
  path: string,
  orgId: string,
): Promise<CapturedResponse> {
  const r = await fetch(`${baseUrl}${path}`, { headers: { "x-org-id": orgId } });
  return { status: r.status, body: await r.text() };
}

let orgA: string;
let orgB: string;
const createdOrgIds: string[] = [];
const createdSupplierIds: string[] = [];

before(async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  const orgs = await db
    .select({ id: orgsTable.id })
    .from(orgsTable)
    .orderBy(orgsTable.createdAt)
    .limit(2);
  if (orgs.length === 0) {
    throw new Error("No org rows exist. Seed the database before running this test.");
  }
  orgA = orgs[0]!.id;
  if (orgs.length >= 2) {
    orgB = orgs[1]!.id;
  } else {
    orgB = `org_${RUN_ID}-b`;
    await db.insert(orgsTable).values({
      id: orgB,
      name: `Suggest Test Org ${RUN_ID}`,
      slug: `suggest-test-${RUN_ID}`,
    });
    createdOrgIds.push(orgB);
  }

  // Seed suppliers we control. Run-id-prefixed source_external_id so
  // teardown can sweep just our rows.
  const seed = [
    {
      id: `sup_${RUN_ID}-apple`,
      orgId: orgA,
      name: `Apple Inc. ${RUN_ID}`,
      normalizedName: "apple",
      countryCode: "US",
      sourceSystem: "task130-test",
      sourceExternalId: `${RUN_ID}-apple`,
    },
    {
      id: `sup_${RUN_ID}-msft`,
      orgId: orgA,
      name: `Microsoft Corporation ${RUN_ID}`,
      normalizedName: "microsoft",
      countryCode: "US",
      sourceSystem: "task130-test",
      sourceExternalId: `${RUN_ID}-msft`,
    },
    {
      id: `sup_${RUN_ID}-tesco`,
      orgId: orgA,
      name: `Tesco ${RUN_ID}`,
      normalizedName: "tesco",
      countryCode: "GB",
      sourceSystem: "task130-test",
      sourceExternalId: `${RUN_ID}-tesco`,
    },
    // Tenant B has its own Apple — must never appear in tenant A's
    // suggestions even though both names are identical.
    {
      id: `sup_${RUN_ID}-apple-b`,
      orgId: orgB,
      name: `Apple Inc. ${RUN_ID}`,
      normalizedName: "apple",
      countryCode: "US",
      sourceSystem: "task130-test",
      sourceExternalId: `${RUN_ID}-apple-b`,
    },
  ];
  await db.insert(suppliersTable).values(seed);
  for (const s of seed) createdSupplierIds.push(s.id);

  setSuggestLookupsForTests(STUB_LOOKUPS);
});

after(async () => {
  resetSuggestLookupsForTests();
  await db
    .delete(watchedIssuersTable)
    .where(like(watchedIssuersTable.notes, `%${RUN_ID}%`));
  if (createdSupplierIds.length > 0) {
    await db
      .delete(suppliersTable)
      .where(inArray(suppliersTable.id, createdSupplierIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(orgsTable).where(inArray(orgsTable.id, createdOrgIds));
  }
  await pool.end().catch(() => {});
});

test("GET /watched-issuers/suggestions returns suggestions only for the active tenant", async () => {
  await withServer(async (base) => {
    // Scope the request to OUR seeded supplier ids — orgA in a long-lived
    // dev DB likely has thousands of suppliers from other tests/seed
    // data, and the route's `limit` (default 50) would otherwise pick
    // a different alphabetical slice. We're testing the SUGGESTION
    // engine + tenant scoping, not pagination.
    const ours = [
      `sup_${RUN_ID}-apple`,
      `sup_${RUN_ID}-msft`,
      `sup_${RUN_ID}-tesco`,
      // Include tenant B's Apple in the request — the route MUST drop
      // it because it doesn't belong to tenant A.
      `sup_${RUN_ID}-apple-b`,
    ];
    const qs = ours.map((id) => `supplierId=${encodeURIComponent(id)}`).join("&");
    const aRes = await getJson(
      base,
      `/api/watched-issuers/suggestions?${qs}`,
      orgA,
    );
    assert.equal(aRes.status, 200, aRes.body);
    const a = JSON.parse(aRes.body) as {
      items: WatchedIssuerSuggestion[];
      suppliersConsidered: number;
    };
    const supplierUids = new Set(a.items.map((s) => s.supplierUid));
    assert.ok(
      supplierUids.has(`sup_${RUN_ID}-apple`),
      `expected Apple suggestion, got items=${JSON.stringify(a.items)}`,
    );
    assert.ok(supplierUids.has(`sup_${RUN_ID}-msft`));
    assert.ok(
      !supplierUids.has(`sup_${RUN_ID}-apple-b`),
      "tenant A must NOT see tenant B's supplier-id in its suggestions",
    );
    // Every suggestion is well-formed and carries a supplierUid the
    // existing POST /watched-issuers can FK on.
    for (const s of a.items) {
      assert.ok(s.supplierUid.startsWith(`sup_${RUN_ID}-`), s.supplierUid);
      assert.ok(s.identifier.length > 0, "identifier must be confirmable");
      assert.ok(s.confidence >= CONFIDENCE_WEAK);
    }
  });
});

test("GET /watched-issuers/suggestions ?supplierId= narrows to one supplier", async () => {
  await withServer(async (base) => {
    const r = await getJson(
      base,
      `/api/watched-issuers/suggestions?supplierId=sup_${RUN_ID}-apple`,
      orgA,
    );
    assert.equal(r.status, 200, r.body);
    const body = JSON.parse(r.body) as { items: WatchedIssuerSuggestion[] };
    assert.ok(body.items.length > 0);
    for (const s of body.items) {
      assert.equal(s.supplierUid, `sup_${RUN_ID}-apple`);
    }
  });
});

test("GET /watched-issuers/suggestions skips suppliers already on the watch list", async () => {
  // Pre-link Apple via watched_issuers (with supplierUid back to our
  // seeded supplier); the engine should drop Apple from the list.
  await db.insert(watchedIssuersTable).values({
    id: `wi_${RUN_ID}-apple-pre`,
    orgId: orgA,
    source: "sec_edgar",
    identifier: "0000320193",
    name: `Apple Inc. ${RUN_ID}`,
    supplierUid: `sup_${RUN_ID}-apple`,
    notes: `created by ${RUN_ID}`,
  });

  await withServer(async (base) => {
    // Same scope-by-supplierId rationale as the first integration test.
    const ours = [`sup_${RUN_ID}-apple`, `sup_${RUN_ID}-msft`];
    const qs = ours.map((id) => `supplierId=${encodeURIComponent(id)}`).join("&");
    const r = await getJson(
      base,
      `/api/watched-issuers/suggestions?${qs}`,
      orgA,
    );
    assert.equal(r.status, 200, r.body);
    const body = JSON.parse(r.body) as {
      items: WatchedIssuerSuggestion[];
      suppliersConsidered: number;
      suppliersSkippedAlreadyWatched: number;
    };
    const supplierUids = new Set(body.items.map((s) => s.supplierUid));
    assert.ok(
      !supplierUids.has(`sup_${RUN_ID}-apple`),
      "Apple should be skipped now that it's already on the watch list",
    );
    assert.equal(
      body.suppliersSkippedAlreadyWatched,
      1,
      "skip count must reflect the pre-linked Apple supplier",
    );
    // Microsoft is still un-linked — should still appear.
    assert.ok(supplierUids.has(`sup_${RUN_ID}-msft`));
  });

  // Cleanup the pre-link so subsequent tests start from a known state.
  await db
    .delete(watchedIssuersTable)
    .where(
      and(
        eq(watchedIssuersTable.orgId, orgA),
        eq(watchedIssuersTable.identifier, "0000320193"),
      ),
    );
});

test("GET /watched-issuers/suggestions drops suggestions whose (source, identifier) is already watched without supplierUid linkage", async () => {
  // Watch the Microsoft CIK at the org level WITHOUT a supplierUid —
  // the supplier is still un-linked, but suggesting that exact
  // (source, identifier) again would just produce a 409 on confirm.
  // The engine should suppress that specific suggestion while still
  // surfacing other ones for the same supplier.
  await db.insert(watchedIssuersTable).values({
    id: `wi_${RUN_ID}-msft-pre`,
    orgId: orgA,
    source: "sec_edgar",
    identifier: "0000789019",
    name: `Microsoft Corporation ${RUN_ID}`,
    notes: `created by ${RUN_ID}`,
  });

  await withServer(async (base) => {
    const r = await getJson(
      base,
      `/api/watched-issuers/suggestions?supplierId=sup_${RUN_ID}-msft`,
      orgA,
    );
    assert.equal(r.status, 200, r.body);
    const body = JSON.parse(r.body) as { items: WatchedIssuerSuggestion[] };
    const msftSuggestions = body.items.filter(
      (s) => s.identifier === "0000789019" && s.source === "sec_edgar",
    );
    assert.equal(
      msftSuggestions.length,
      0,
      "Microsoft CIK must NOT be suggested when the tenant already watches it",
    );
  });

  await db
    .delete(watchedIssuersTable)
    .where(
      and(
        eq(watchedIssuersTable.orgId, orgA),
        eq(watchedIssuersTable.identifier, "0000789019"),
      ),
    );
});
