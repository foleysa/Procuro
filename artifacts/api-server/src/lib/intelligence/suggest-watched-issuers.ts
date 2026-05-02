/**
 * Watched-issuers suggestion engine.
 *
 * Joins each tenant's `suppliers` against SEC EDGAR (cached
 * `company_tickers.json` index), GLEIF name search, and Companies
 * House search (when the API key is present and the supplier looks
 * UK). Returns ranked suggestions; never writes — the caller
 * confirms via the existing POST /watched-issuers endpoint with the
 * `supplierUid` link.
 *
 * Confidence tiers:
 *   - 0.95 — exact normalised name match (post legal-suffix strip).
 *   - 0.75 — strong token overlap (≥2 shared significant tokens, OR
 *            single shared token where it's the only token on one side).
 *   - 0.55 — weak token overlap (single shared common token).
 *
 * Anything below 0.55 is dropped. Per-source upstream failures are
 * caught and logged so one bad lookup doesn't poison the batch.
 */

import { normaliseName } from "@workspace/intelligence";
import { logger } from "../logger";
import { padCik } from "./collectors/sec-edgar";
import { normaliseCompaniesHouseNumber } from "./collectors/companies-house";
import type { WatchedIssuerSource } from "@workspace/db";

// Exported so callers (and tests) can pin the thresholds the UI relies on.
export const CONFIDENCE_EXACT = 0.95;
export const CONFIDENCE_STRONG = 0.75;
export const CONFIDENCE_WEAK = 0.55;
export const MIN_CONFIDENCE = CONFIDENCE_WEAK;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SuggesterSupplierInput {
  /** Supplier id (matches `suppliers.id` and the `watched_issuers.supplier_uid` FK). */
  id: string;
  /** Display name as the tenant has it. */
  name: string;
  /** Optional ISO-3166-alpha-2 country (`countryCode` on suppliers). */
  countryCode?: string | null;
}

export interface WatchedIssuerSuggestion {
  /** Stable client key — `<supplierId>:<source>:<identifier>`. */
  key: string;
  supplierUid: string;
  supplierName: string;
  source: WatchedIssuerSource;
  /** Source-native identifier ready to POST to /watched-issuers
   *  (SEC = 10-digit padded CIK; Companies House = 8-char number). */
  identifier: string;
  /** Issuer/company display name from the reference source. */
  name: string;
  /** Optional LEI (lets the entity resolver short-circuit). */
  lei?: string;
  /** Optional ticker (SEC-side cross-reference). */
  ticker?: string;
  /** 0..1, see confidence tiers above. */
  confidence: number;
  /** Short human reason ("exact name match on EDGAR ticker index"). */
  matchReason: string;
  /** Reference-source attribution (`gleif`, `sec`, `companies_house`). */
  via: "gleif" | "sec" | "companies_house";
}

/** Reference-data lookup contract. Production wires these to live HTTP;
 *  tests stub them with canned responses. */
export interface ReferenceLookups {
  secTickerIndex(): Promise<readonly SecTickerRecord[]>;
  gleifByName(name: string, country?: string | null): Promise<GleifNameMatch[]>;
  /** Returns `null` when the source is unavailable (no API key). */
  companiesHouseSearch(
    name: string,
    apiKey: string | undefined,
  ): Promise<CompaniesHouseSearchHit[] | null>;
  /**
   * Resolve an LEI to a SEC CIK via EDGAR's LEI browse endpoint.
   * Returns a 10-digit padded CIK string, or `null` when EDGAR has no
   * registrant for that LEI. Used to surface GLEIF-only matches (parent
   * holdcos / ADR issuers whose legal name doesn't match SEC's ticker
   * index) as confirmable sec_edgar suggestions.
   */
  secCikByLei(lei: string): Promise<string | null>;
}

export interface SecTickerRecord {
  /** Numeric CIK (e.g. `320193`). The SEC payload is unpadded. */
  cik_str: number;
  ticker: string;
  /** Issuer title as SEC has it (e.g. "Apple Inc."). */
  title: string;
}

export interface GleifNameMatch {
  lei: string;
  legalName: string;
  /** ISO-3166 country / sub-country (e.g. "US-CA", "GB"). */
  jurisdiction: string | null;
  legalAddressCountry: string | null;
  headquartersCountry: string | null;
}

export interface CompaniesHouseSearchHit {
  /** Already-normalised 8-char company number (or e.g. "SC123456"). */
  companyNumber: string;
  title: string;
  companyStatus: string | null;
}

// Tokens below length 3 ("of", "co", "us") are almost always noise that
// produce false overlaps, so we drop them here.
function tokenize(name: string): string[] {
  return normaliseName(name)
    .split(" ")
    .filter((t) => t.length >= 3);
}

/** Score a candidate name against a query. Tiers map to the exported
 *  CONFIDENCE_* constants so the UI can pin sort order. */
export function scoreNameMatch(query: string, candidate: string): number {
  const qNorm = normaliseName(query);
  const cNorm = normaliseName(candidate);
  if (qNorm.length === 0 || cNorm.length === 0) return 0;
  if (qNorm === cNorm) return CONFIDENCE_EXACT;

  const qTokens = new Set(tokenize(query));
  const cTokens = new Set(tokenize(candidate));
  if (qTokens.size === 0 || cTokens.size === 0) return 0;

  let shared = 0;
  for (const t of qTokens) if (cTokens.has(t)) shared++;
  if (shared === 0) return 0;

  const minSize = Math.min(qTokens.size, cTokens.size);
  if (shared >= 2 || (shared === 1 && minSize === 1)) {
    return CONFIDENCE_STRONG;
  }
  return CONFIDENCE_WEAK;
}

/** Reduce candidates to the top-N per supplier+source. Caps protect the
 *  response size for tenants with hundreds of suppliers. */
export function rankSuggestions(
  candidates: WatchedIssuerSuggestion[],
  opts: { perSourceLimit?: number; perSupplierLimit?: number } = {},
): WatchedIssuerSuggestion[] {
  const perSource = opts.perSourceLimit ?? 2;
  const perSupplier = opts.perSupplierLimit ?? 4;
  const sorted = [...candidates].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.name.localeCompare(b.name);
  });

  const perSupplierSourceCount = new Map<string, number>();
  const perSupplierCount = new Map<string, number>();
  const out: WatchedIssuerSuggestion[] = [];
  for (const s of sorted) {
    const sup = s.supplierUid;
    const sourceKey = `${sup}::${s.source}`;
    if ((perSupplierCount.get(sup) ?? 0) >= perSupplier) continue;
    if ((perSupplierSourceCount.get(sourceKey) ?? 0) >= perSource) continue;
    out.push(s);
    perSupplierSourceCount.set(
      sourceKey,
      (perSupplierSourceCount.get(sourceKey) ?? 0) + 1,
    );
    perSupplierCount.set(sup, (perSupplierCount.get(sup) ?? 0) + 1);
  }
  return out;
}

/** Decides whether to hit Companies House for this supplier. */
export function looksUk(countryCode: string | null | undefined): boolean {
  if (!countryCode) return false;
  const c = countryCode.trim().toUpperCase();
  return c === "GB" || c === "UK" || c === "GBR";
}

/** Includes `null` because many supplier rows have no countryCode set
 *  and we still want SEC matches considered for them. */
export function looksUs(countryCode: string | null | undefined): boolean {
  if (!countryCode) return true;
  const c = countryCode.trim().toUpperCase();
  return c === "US" || c === "USA";
}

// ---------------------------------------------------------------------------
// Per-source suggestion builders
// ---------------------------------------------------------------------------

function suggestFromSec(
  supplier: SuggesterSupplierInput,
  index: readonly SecTickerRecord[],
): WatchedIssuerSuggestion[] {
  if (!looksUs(supplier.countryCode)) return [];
  const out: WatchedIssuerSuggestion[] = [];
  for (const row of index) {
    const score = scoreNameMatch(supplier.name, row.title);
    if (score < MIN_CONFIDENCE) continue;
    const cik = padCik(String(row.cik_str));
    if (!cik || cik === "0000000000") continue;
    out.push({
      key: `${supplier.id}:sec_edgar:${cik}`,
      supplierUid: supplier.id,
      supplierName: supplier.name,
      source: "sec_edgar",
      identifier: cik,
      name: row.title,
      ticker: row.ticker,
      confidence: score,
      matchReason:
        score >= CONFIDENCE_EXACT
          ? "exact name match in SEC ticker index"
          : score >= CONFIDENCE_STRONG
            ? "strong name overlap with SEC ticker index"
            : "weak name overlap with SEC ticker index",
      via: "sec",
    });
  }
  return out;
}

// GLEIF doesn't carry CIK or Companies House numbers, so v0 keeps
// these suggestions only as LEI carriers — `mergeLeiIntoSecSuggestions`
// then attaches the LEI to a matching SEC row, and `dropUnactionable`
// removes any leftover identifier-less rows before the response.
function suggestFromGleif(
  supplier: SuggesterSupplierInput,
  matches: GleifNameMatch[],
): WatchedIssuerSuggestion[] {
  const out: WatchedIssuerSuggestion[] = [];
  for (const m of matches) {
    const score = scoreNameMatch(supplier.name, m.legalName);
    if (score < MIN_CONFIDENCE) continue;
    const country =
      m.headquartersCountry ?? m.legalAddressCountry ?? m.jurisdiction ?? null;
    // UK GLEIF rows are handled via the Companies House path; non-US
    // non-UK entries are out of scope for v0.
    if (looksUk(country)) continue;
    if (!looksUs(country) && !looksUs(supplier.countryCode)) continue;
    out.push({
      key: `${supplier.id}:sec_edgar:lei:${m.lei}`,
      supplierUid: supplier.id,
      supplierName: supplier.name,
      source: "sec_edgar",
      identifier: "",
      name: m.legalName,
      lei: m.lei,
      confidence: score,
      matchReason:
        score >= CONFIDENCE_EXACT
          ? "exact name match in GLEIF (LEI confirmed)"
          : "name overlap in GLEIF (LEI confirmed)",
      via: "gleif",
    });
  }
  return out;
}

function suggestFromCompaniesHouse(
  supplier: SuggesterSupplierInput,
  hits: CompaniesHouseSearchHit[] | null,
): WatchedIssuerSuggestion[] {
  if (!hits) return [];
  const out: WatchedIssuerSuggestion[] = [];
  for (const h of hits) {
    // Skip dissolved / liquidated companies for v0 to keep the list focused.
    if (h.companyStatus && h.companyStatus !== "active") continue;
    const score = scoreNameMatch(supplier.name, h.title);
    if (score < MIN_CONFIDENCE) continue;
    const number = normaliseCompaniesHouseNumber(h.companyNumber);
    if (!number) continue;
    out.push({
      key: `${supplier.id}:companies_house:${number}`,
      supplierUid: supplier.id,
      supplierName: supplier.name,
      source: "companies_house",
      identifier: number,
      name: h.title,
      confidence: score,
      matchReason:
        score >= CONFIDENCE_EXACT
          ? "exact name match in Companies House"
          : "name overlap in Companies House",
      via: "companies_house",
    });
  }
  return out;
}

/** When GLEIF gave us an LEI and the SEC index produced a name-matched
 *  CIK suggestion for the same supplier, attach the LEI so the eventual
 *  `watched_issuers` row carries it (the entity resolver short-circuits
 *  on LEI). */
function mergeLeiIntoSecSuggestions(
  rows: WatchedIssuerSuggestion[],
): WatchedIssuerSuggestion[] {
  const leiByNorm = new Map<string, string>();
  for (const r of rows) {
    if (r.via === "gleif" && r.lei) {
      leiByNorm.set(`${r.supplierUid}:${normaliseName(r.name)}`, r.lei);
    }
  }
  return rows.map((r) => {
    if (r.via !== "sec" || r.lei) return r;
    const lei = leiByNorm.get(`${r.supplierUid}:${normaliseName(r.name)}`);
    return lei ? { ...r, lei } : r;
  });
}

/** Drop GLEIF LEI-only stubs (no identifier) — they served their purpose
 *  in mergeLeiIntoSecSuggestions but can't be confirmed on their own. */
function dropUnactionable(
  rows: WatchedIssuerSuggestion[],
): WatchedIssuerSuggestion[] {
  return rows.filter((r) => r.identifier.length > 0);
}

/**
 * Second-chance enrichment for GLEIF stubs that didn't pair up with a
 * SEC ticker hit (the common case for parent holdcos and ADR issuers
 * whose legal name doesn't match SEC's ticker index).  For each
 * remaining identifier-less GLEIF suggestion, hit SEC's LEI→CIK browse
 * endpoint; if EDGAR has a registrant for that LEI, materialise the
 * suggestion into a confirmable sec_edgar row carrying both the CIK
 * and the LEI.
 *
 * Per-supplier de-duping prevents emitting a second SEC row when the
 * ticker index already produced one for the same CIK (and we just
 * attached the LEI in `mergeLeiIntoSecSuggestions`).
 *
 * Failures are caught per-LEI so one upstream blip can't poison the
 * whole batch — the stub is simply dropped by `dropUnactionable`.
 */
async function resolveGleifLeisToCiks(
  rows: WatchedIssuerSuggestion[],
  lookup: (lei: string) => Promise<string | null>,
): Promise<WatchedIssuerSuggestion[]> {
  const stubs = rows.filter(
    (r) => r.via === "gleif" && r.identifier === "" && !!r.lei,
  );
  if (stubs.length === 0) return rows;

  // Track CIKs already covered per supplier so we don't shadow a
  // ticker-index hit with a duplicate row from the LEI cross-reference.
  const ciksPerSupplier = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.source === "sec_edgar" && r.identifier.length > 0) {
      let set = ciksPerSupplier.get(r.supplierUid);
      if (!set) {
        set = new Set();
        ciksPerSupplier.set(r.supplierUid, set);
      }
      set.add(r.identifier);
    }
  }

  // One lookup per unique LEI — multiple suppliers can match the same
  // GLEIF row (e.g. tenant has both "Apple" and "Apple Sales Intl").
  const uniqueLeis = Array.from(new Set(stubs.map((s) => s.lei!)));
  const leiToCik = new Map<string, string | null>();
  for (const lei of uniqueLeis) {
    try {
      leiToCik.set(lei, await lookup(lei));
    } catch (err) {
      logger.warn(
        { lei, err: (err as Error).message },
        "watched-issuer suggestions: SEC LEI→CIK lookup failed",
      );
      leiToCik.set(lei, null);
    }
  }

  const additions: WatchedIssuerSuggestion[] = [];
  for (const stub of stubs) {
    const cik = leiToCik.get(stub.lei!);
    if (!cik) continue;
    let set = ciksPerSupplier.get(stub.supplierUid);
    if (!set) {
      set = new Set();
      ciksPerSupplier.set(stub.supplierUid, set);
    }
    if (set.has(cik)) continue;
    set.add(cik);
    additions.push({
      key: `${stub.supplierUid}:sec_edgar:${cik}`,
      supplierUid: stub.supplierUid,
      supplierName: stub.supplierName,
      source: "sec_edgar",
      identifier: cik,
      name: stub.name,
      lei: stub.lei,
      confidence: stub.confidence,
      matchReason:
        stub.confidence >= CONFIDENCE_EXACT
          ? "exact name match in GLEIF; CIK resolved via SEC LEI cross-reference"
          : "name overlap in GLEIF; CIK resolved via SEC LEI cross-reference",
      via: "gleif",
    });
  }

  return [...rows, ...additions];
}

// ---------------------------------------------------------------------------
// Top-level: per-supplier orchestration
// ---------------------------------------------------------------------------

export interface SuggestForSupplierOpts {
  lookups: ReferenceLookups;
  /** Companies House key, passed through to the lookup. May be undefined. */
  companiesHouseApiKey?: string;
}

export async function suggestForSupplier(
  supplier: SuggesterSupplierInput,
  opts: SuggestForSupplierOpts,
): Promise<WatchedIssuerSuggestion[]> {
  const candidates: WatchedIssuerSuggestion[] = [];

  if (looksUs(supplier.countryCode)) {
    try {
      const index = await opts.lookups.secTickerIndex();
      candidates.push(...suggestFromSec(supplier, index));
    } catch (err) {
      logger.warn(
        { supplierId: supplier.id, err: (err as Error).message },
        "watched-issuer suggestions: SEC ticker index lookup failed",
      );
    }
  }

  try {
    const matches = await opts.lookups.gleifByName(
      supplier.name,
      supplier.countryCode ?? null,
    );
    candidates.push(...suggestFromGleif(supplier, matches));
  } catch (err) {
    logger.warn(
      { supplierId: supplier.id, err: (err as Error).message },
      "watched-issuer suggestions: GLEIF lookup failed",
    );
  }

  if (looksUk(supplier.countryCode)) {
    try {
      const hits = await opts.lookups.companiesHouseSearch(
        supplier.name,
        opts.companiesHouseApiKey,
      );
      candidates.push(...suggestFromCompaniesHouse(supplier, hits));
    } catch (err) {
      logger.warn(
        { supplierId: supplier.id, err: (err as Error).message },
        "watched-issuer suggestions: Companies House lookup failed",
      );
    }
  }

  const merged = mergeLeiIntoSecSuggestions(candidates);
  const enriched = await resolveGleifLeisToCiks(
    merged,
    opts.lookups.secCikByLei,
  );
  const actionable = dropUnactionable(enriched);
  return rankSuggestions(actionable);
}

// Default reference-data implementations (live HTTP).

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const GLEIF_BASE = "https://api.gleif.org/api/v1/lei-records";
const CH_SEARCH_BASE =
  "https://api.company-information.service.gov.uk/search/companies";

// SEC publishes company_tickers.json daily; cache for 24 h to keep
// suggestion costs at one network call per process boot, not per request.
let secTickerCache: { fetchedAt: number; rows: SecTickerRecord[] } | null = null;
const SEC_TICKER_TTL_MS = 24 * 60 * 60 * 1000;

function buildSecUserAgent(): string {
  const explicit = process.env["SEC_EDGAR_USER_AGENT"];
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return "Procuro Procurement Platform compliance@procuro.ai";
}

export async function fetchSecTickerIndex(): Promise<SecTickerRecord[]> {
  const now = Date.now();
  if (secTickerCache && now - secTickerCache.fetchedAt < SEC_TICKER_TTL_MS) {
    return secTickerCache.rows;
  }
  const res = await fetch(SEC_TICKERS_URL, {
    headers: {
      "User-Agent": buildSecUserAgent(),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`SEC company_tickers HTTP ${res.status}`);
  }
  // SEC payload: `{"0":{cik_str,ticker,title},"1":{...},...}`.
  const body = (await res.json()) as Record<string, SecTickerRecord>;
  const rows: SecTickerRecord[] = Object.values(body).filter(
    (r): r is SecTickerRecord =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as SecTickerRecord).cik_str === "number" &&
      typeof (r as SecTickerRecord).ticker === "string" &&
      typeof (r as SecTickerRecord).title === "string",
  );
  secTickerCache = { fetchedAt: now, rows };
  return rows;
}

/** Test seam — clear the SEC index cache. */
export function _resetSecTickerCacheForTests(): void {
  secTickerCache = null;
}

export async function fetchGleifByName(
  name: string,
  country?: string | null,
): Promise<GleifNameMatch[]> {
  const params = new URLSearchParams();
  params.set("filter[entity.legalName]", name);
  if (country && country.trim().length > 0) {
    params.set("filter[entity.legalAddress.country]", country.trim().toUpperCase());
  }
  params.set("page[size]", "10");
  const url = `${GLEIF_BASE}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.api+json" },
  });
  if (!res.ok) {
    throw new Error(`GLEIF search HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    data?: Array<{
      id: string;
      attributes?: {
        lei?: string;
        entity?: {
          legalName?: { name?: string };
          jurisdiction?: string;
          legalAddress?: { country?: string };
          headquartersAddress?: { country?: string };
        };
      };
    }>;
  };
  const out: GleifNameMatch[] = [];
  for (const r of body.data ?? []) {
    const lei = r.attributes?.lei ?? r.id;
    const legalName = r.attributes?.entity?.legalName?.name;
    if (!lei || !legalName) continue;
    out.push({
      lei,
      legalName,
      jurisdiction: r.attributes?.entity?.jurisdiction ?? null,
      legalAddressCountry: r.attributes?.entity?.legalAddress?.country ?? null,
      headquartersCountry:
        r.attributes?.entity?.headquartersAddress?.country ?? null,
    });
  }
  return out;
}

export async function fetchCompaniesHouseSearch(
  name: string,
  apiKey: string | undefined,
): Promise<CompaniesHouseSearchHit[] | null> {
  if (!apiKey) return null;
  const params = new URLSearchParams();
  params.set("q", name);
  params.set("items_per_page", "10");
  const url = `${CH_SEARCH_BASE}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Companies House search HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    items?: Array<{
      company_number?: string;
      title?: string;
      company_status?: string;
    }>;
  };
  const out: CompaniesHouseSearchHit[] = [];
  for (const r of body.items ?? []) {
    if (!r.company_number || !r.title) continue;
    out.push({
      companyNumber: r.company_number,
      title: r.title,
      companyStatus: r.company_status ?? null,
    });
  }
  return out;
}

/**
 * SEC LEI→CIK lookup. EDGAR's `browse-edgar` endpoint accepts an `LEI`
 * filter and returns an Atom feed whose entry URLs embed the matched
 * registrant's CIK.  We pull the first `CIK=<digits>` we see — when LEI
 * matches an EDGAR registrant the feed has exactly one entry, and the
 * filter URL itself does NOT contain a CIK so the regex can't be
 * confused by it.
 *
 * Cached forever per process: LEI→CIK is a stable mapping (an LEI
 * either points at a SEC registrant or it doesn't), so the first
 * suggestion request that touches a given LEI pays the network cost
 * and every subsequent supplier with the same parent holdco is free.
 *
 * Returns `null` when EDGAR has no registrant for that LEI (HTTP 404
 * or feed with zero entries).
 */
const leiToCikCache = new Map<string, string | null>();

export async function fetchSecCikByLei(lei: string): Promise<string | null> {
  const clean = lei.trim().toUpperCase();
  if (!clean) return null;
  if (leiToCikCache.has(clean)) return leiToCikCache.get(clean) ?? null;

  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&LEI=${encodeURIComponent(
    clean,
  )}&owner=include&count=10&output=atom`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": buildSecUserAgent(),
      Accept: "application/atom+xml,application/xml,text/xml,*/*",
    },
  });
  if (res.status === 404) {
    leiToCikCache.set(clean, null);
    return null;
  }
  if (!res.ok) {
    throw new Error(`SEC LEI lookup HTTP ${res.status}`);
  }
  const body = await res.text();
  // EDGAR sometimes returns the search page (200) with no <entry> when
  // the LEI is unknown — guard explicitly so we don't fall through to
  // a CIK-bearing link in unrelated chrome.
  if (!/<entry\b/i.test(body)) {
    leiToCikCache.set(clean, null);
    return null;
  }
  const match = body.match(/CIK=(\d{1,10})/);
  if (!match) {
    leiToCikCache.set(clean, null);
    return null;
  }
  const cik = padCik(match[1]!);
  if (cik === "0000000000") {
    leiToCikCache.set(clean, null);
    return null;
  }
  leiToCikCache.set(clean, cik);
  return cik;
}

/** Test seam — clear the LEI→CIK cache so cases can pin behaviour. */
export function _resetSecLeiCacheForTests(): void {
  leiToCikCache.clear();
}

/** Default lookups used by the route — wraps the four live functions. */
export const defaultReferenceLookups: ReferenceLookups = {
  secTickerIndex: fetchSecTickerIndex,
  gleifByName: fetchGleifByName,
  companiesHouseSearch: fetchCompaniesHouseSearch,
  secCikByLei: fetchSecCikByLei,
};

// Tenant-wide orchestration.

export interface SuggestForTenantOpts {
  /** Suppliers belonging to the tenant. Caller is responsible for scoping. */
  suppliers: readonly SuggesterSupplierInput[];
  /** Used to drop suggestions the user already has on their watch list. */
  alreadyWatched: {
    bySupplierUid: ReadonlySet<string>;
    bySourceIdentifier: ReadonlySet<string>; // e.g. "sec_edgar:0000320193"
  };
  lookups?: ReferenceLookups;
  companiesHouseApiKey?: string;
  /** Per-supplier fan-out cap. SEC index is cached, so the marginal
   *  cost per supplier is GLEIF (+ optional CH). */
  concurrency?: number;
}

export interface SuggestForTenantResult {
  suggestions: WatchedIssuerSuggestion[];
  suppliersConsidered: number;
  suppliersSkippedAlreadyWatched: number;
}

export async function suggestForTenant(
  opts: SuggestForTenantOpts,
): Promise<SuggestForTenantResult> {
  const lookups = opts.lookups ?? defaultReferenceLookups;
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));

  // Skip suppliers already linked from watched_issuers — the tenant
  // curated them, so re-suggesting would just be noise.
  const candidates = opts.suppliers.filter(
    (s) => !opts.alreadyWatched.bySupplierUid.has(s.id),
  );
  const skipped = opts.suppliers.length - candidates.length;

  const all: WatchedIssuerSuggestion[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const supplier = candidates[i]!;
      const perSupplier = await suggestForSupplier(supplier, {
        lookups,
        ...(opts.companiesHouseApiKey
          ? { companiesHouseApiKey: opts.companiesHouseApiKey }
          : {}),
      });
      // Drop (source, identifier) duplicates of existing watch rows so
      // the UI never shows a confirm that would 409.
      for (const s of perSupplier) {
        const k = `${s.source}:${s.identifier}`;
        if (opts.alreadyWatched.bySourceIdentifier.has(k)) continue;
        all.push(s);
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, candidates.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Cross-supplier dedupe: `watched_issuers` is unique on
  // `(orgId, source, identifier)`, so if two suppliers both match
  // e.g. CIK 0000320193, only the first confirm will succeed and the
  // second would 409. Keep the highest-confidence suggestion (ties
  // broken by supplierUid for determinism) and drop the rest.
  const bestByIdent = new Map<string, WatchedIssuerSuggestion>();
  for (const s of all) {
    const k = `${s.source}:${s.identifier}`;
    const existing = bestByIdent.get(k);
    if (
      !existing ||
      s.confidence > existing.confidence ||
      (s.confidence === existing.confidence &&
        s.supplierUid < existing.supplierUid)
    ) {
      bestByIdent.set(k, s);
    }
  }

  // Stable, deterministic ordering: confidence desc, then supplierUid,
  // source, identifier. Keeps UI ordering reproducible across reqs.
  const deduped = Array.from(bestByIdent.values()).sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.supplierUid !== b.supplierUid)
      return a.supplierUid.localeCompare(b.supplierUid);
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.identifier.localeCompare(b.identifier);
  });

  return {
    suggestions: deduped,
    suppliersConsidered: candidates.length,
    suppliersSkippedAlreadyWatched: skipped,
  };
}
