/**
 * SEC EDGAR collector — supplier financial-health filings.
 *
 * Pulls the recent filings index for a curated set of issuer CIKs from
 * EDGAR's free `submissions` JSON endpoint
 * (`https://data.sec.gov/submissions/CIK{CIK10}.json`). Each filing is
 * emitted as a `corporate_filing` MarketSignal scoped by supplier name
 * with the form type, accession number, filed-at timestamp, and a link
 * to the full filing index.
 *
 * Why these forms:
 *   - 10-K / 10-Q: annual / quarterly financial position
 *   - 8-K:        material event (mgmt departures, M&A, default, etc.)
 *   - DEF 14A:    proxy statement (exec comp, board changes)
 *   - NT 10-K / NT 10-Q: late-filing notifications — strong stress signal
 *
 * Posture: `public_api`, tier `T1`. EDGAR is fully attributable; lever
 * explanations cite the exact filing URL.
 *
 * Politeness: SEC requires a descriptive `User-Agent` (`<app> <contact>`)
 * and rate-limits at 10 req/sec. We default to 60 rpm and pass a User-Agent
 * derived from `SEC_EDGAR_USER_AGENT` (or a sensible fallback).
 *
 * The `value` field on each draft is the numeric form code class
 * (1=10-K, 2=10-Q, 3=8-K, 4=DEF 14A, 5=NT-*) so analyzers can group
 * by signal_type and bucket. Form code → numeric mapping is part of
 * the contract and is asserted by the parser test.
 */

import { z } from "zod";
import { db, watchedIssuersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";
import type {
  CollectWithRawResult,
  IntelligenceCollector,
  MarketSignalDraft,
  RawPayload,
} from "../collector";
import { logger } from "../../logger";
import { resolveDraftEntities } from "./_entity-resolver";

export const SEC_EDGAR_COLLECTOR_ID = "sec-edgar";

/**
 * Issuer reference for the SEC EDGAR poll list.
 *
 * Each entry has a CIK (zero-padded to 10 chars at request time), the
 * issuer name we use as `scope_supplier_name`, and the LEI when
 * available so the entity resolver returns a deterministic uid.
 */
export interface SecIssuerRef {
  cik: string;
  name: string;
  /** Optional LEI for deterministic identifier-based resolution. */
  lei?: string;
  /** Optional ticker for human-readable cross-reference. */
  ticker?: string;
}

/**
 * Seed issuers — kept small and obvious so the collector still produces
 * useful out-of-the-box drafts on a fresh install where no tenant has
 * curated their `watched_issuers` list yet. Once tenants add their own
 * supplier CIKs (via POST /watched-issuers), the active poll list is
 * the union of every tenant's watch list (de-duped on CIK) and the
 * seed array is no longer used.
 *
 * Exported for the per-collector parser test, which constructs an
 * `SecIssuerRef` directly.
 */
export const SEC_EDGAR_DEFAULT_ISSUERS: readonly SecIssuerRef[] = [
  { cik: "0000320193", name: "Apple Inc.", lei: "HWUPKR0MPOU8FGXBT394", ticker: "AAPL" },
  { cik: "0000789019", name: "Microsoft Corporation", lei: "INR2EJN1ERAN0W5ZP974", ticker: "MSFT" },
  { cik: "0001018724", name: "Amazon.com Inc.", lei: "ZXTILKJKG63JELOEG630", ticker: "AMZN" },
  { cik: "0001045810", name: "NVIDIA Corporation", lei: "549300JT1RTHHHQAH961", ticker: "NVDA" },
  { cik: "0000018230", name: "Caterpillar Inc.", lei: "UV9ZMTQQQSBPRG627F65", ticker: "CAT" },
  { cik: "0000093751", name: "Stanley Black & Decker Inc.", ticker: "SWK" },
  { cik: "0000040533", name: "General Mills Inc.", ticker: "GIS" },
  { cik: "0000732717", name: "AT&T Inc.", ticker: "T" },
];

/**
 * De-dupe a list of issuer refs on padded CIK. The FIRST occurrence
 * wins so callers can stack a "preferred" source (e.g. tenant rows
 * carrying LEI / ticker enrichment) before the fallback seed.
 */
export function dedupeSecIssuers(
  issuers: readonly SecIssuerRef[],
): SecIssuerRef[] {
  const seen = new Set<string>();
  const out: SecIssuerRef[] = [];
  for (const i of issuers) {
    const key = padCik(i.cik);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

/**
 * Load every tenant's watched SEC issuers and de-dupe on CIK. Two
 * tenants watching the same CIK still cost us only one upstream
 * fetch — the resulting `corporate_filing` signals are platform-wide
 * (org_id = NULL), so every opted-in tenant sees them.
 *
 * Returns an empty array (not the seed) so callers can decide
 * whether to fall back. We keep the seed-fallback decision in one
 * place (`getActiveSecIssuers`).
 */
export async function loadWatchedSecIssuers(): Promise<SecIssuerRef[]> {
  const rows = await db
    .select({
      identifier: watchedIssuersTable.identifier,
      name: watchedIssuersTable.name,
      lei: watchedIssuersTable.lei,
      ticker: watchedIssuersTable.ticker,
    })
    .from(watchedIssuersTable)
    .where(eq(watchedIssuersTable.source, "sec_edgar"));
  const refs: SecIssuerRef[] = rows.map((r) => ({
    cik: r.identifier,
    name: r.name,
    ...(r.lei ? { lei: r.lei } : {}),
    ...(r.ticker ? { ticker: r.ticker } : {}),
  }));
  return dedupeSecIssuers(refs);
}

/**
 * Resolve the issuer list the collector should poll on this tick.
 *
 * Resolution order:
 *   1. Explicit `override` (e.g. an admin backfill targeting a
 *      specific issuer). Used as-is, deduped.
 *   2. Tenant-curated rows from `watched_issuers` (source='sec_edgar').
 *   3. Seed list (`SEC_EDGAR_DEFAULT_ISSUERS`) — only when (2) is
 *      empty. This keeps a fresh install from being silent.
 */
export async function getActiveSecIssuers(
  override?: readonly SecIssuerRef[],
): Promise<SecIssuerRef[]> {
  if (override && override.length > 0) return dedupeSecIssuers(override);
  const watched = await loadWatchedSecIssuers();
  if (watched.length > 0) return watched;
  return dedupeSecIssuers(SEC_EDGAR_DEFAULT_ISSUERS);
}

/**
 * Tracked filing forms with their numeric code (used as the signal
 * `value`). Anything outside this list is dropped by the parser so the
 * stream stays focused on procurement-relevant filings.
 */
export const TRACKED_FORM_CODES: Record<string, number> = {
  "10-K": 1,
  "10-Q": 2,
  "8-K": 3,
  "DEF 14A": 4,
  "NT 10-K": 5,
  "NT 10-Q": 5,
};

/** EDGAR submissions JSON shape we depend on. */
export interface EdgarSubmissionsResponse {
  cik: string;
  name: string;
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      accessionNumber?: string[];
      primaryDocument?: string[];
      reportDate?: string[];
      items?: string[];
    };
  };
}

/**
 * Build the SEC `User-Agent` header. SEC requires `Sample Company Name
 * AdminContact@<sampledomain>.com` style identification — so we read
 * `SEC_EDGAR_USER_AGENT` first and fall back to a sane platform default.
 */
export function buildEdgarUserAgent(): string {
  const explicit = process.env["SEC_EDGAR_USER_AGENT"];
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return "Procuro Procurement Platform compliance@procuro.ai";
}

/** EDGAR wants the CIK zero-padded to 10 digits in the submissions URL. */
export function padCik(cik: string): string {
  return cik.replace(/\D/g, "").padStart(10, "0");
}

function submissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`;
}

function filingIndexUrl(cik: string, accession: string): string {
  // SEC filing index URLs use the un-padded CIK and the accession
  // number with dashes stripped.
  const cleanCik = String(parseInt(cik, 10));
  const accessionClean = accession.replace(/-/g, "");
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cleanCik}&type=&dateb=&owner=include&count=40&action=getcompany#${accessionClean}`;
}

/**
 * Parse one EDGAR submissions response into MarketSignalDrafts. Pure
 * function so the collector and the per-collector test can share it.
 *
 * Drops filings whose form is not in TRACKED_FORM_CODES and entries
 * with an unparseable filing date.
 */
export function parseEdgarSubmissions(
  issuer: SecIssuerRef,
  payload: EdgarSubmissionsResponse,
): MarketSignalDraft[] {
  const recent = payload.filings?.recent;
  if (!recent) return [];
  const forms = recent.form ?? [];
  const dates = recent.filingDate ?? [];
  const accessions = recent.accessionNumber ?? [];
  const docs = recent.primaryDocument ?? [];
  const items = recent.items ?? [];

  const drafts: MarketSignalDraft[] = [];
  const n = Math.min(forms.length, dates.length, accessions.length);
  for (let i = 0; i < n; i++) {
    const form = forms[i]!;
    const value = TRACKED_FORM_CODES[form];
    if (typeof value !== "number") continue;
    const date = dates[i]!;
    const accession = accessions[i]!;
    const filedAt = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(filedAt.getTime())) continue;
    const primaryDocument = docs[i] ?? null;
    const itemCodes = items[i] ?? null;
    drafts.push({
      signalType: "corporate_filing",
      scopeSupplierName: issuer.name,
      // Two filings can land on the same calendar day for the same
      // issuer (e.g. an 8-K and an NT-10-K on the same morning). The
      // accession number is the stable per-filing identifier, so we
      // park it in `scope_sku` to keep the natural-key unique index
      // from collapsing them.
      scopeSku: accession,
      value,
      unit: "form_code",
      currency: "USD",
      observedAt: filedAt,
      sourceUrl: filingIndexUrl(issuer.cik, accession),
      confidence: 0.99,
      // entityUid is populated by the collector's resolver pass — the
      // parser stays pure so it can be unit-tested without a database.
      metadata: {
        cik: padCik(issuer.cik),
        accessionNumber: accession,
        form,
        primaryDocument,
        items: itemCodes,
        ticker: issuer.ticker ?? null,
        lei: issuer.lei ?? null,
      },
    });
  }
  return drafts;
}

/**
 * Fetch raw bytes + parsed JSON in a single pass so the caller can
 * surface both the parsed shape (for drafts) and the original payload
 * (for GCS landing via collectWithRaw).
 */
async function fetchSubmissions(
  cik: string,
  userAgent: string,
): Promise<{
  url: string;
  body: string;
  parsed: EdgarSubmissionsResponse;
}> {
  const url = submissionsUrl(cik);
  const res = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "application/json",
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `SEC EDGAR ${cik} HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return {
    url,
    body,
    parsed: JSON.parse(body) as EdgarSubmissionsResponse,
  };
}

/**
 * Run the resolver across a collected batch of EDGAR drafts. Each
 * draft already carries `metadata.cik` / `metadata.lei` / `metadata.ticker`
 * from the parser, so we can build the identifier set without a second
 * lookup.
 */
async function attachEntityUids(
  drafts: MarketSignalDraft[],
): Promise<MarketSignalDraft[]> {
  const inputs = drafts.map((d) => {
    const md = (d.metadata ?? {}) as {
      cik?: string;
      lei?: string | null;
      ticker?: string | null;
    };
    const identifiers: Record<string, string> = {};
    if (md.lei) identifiers.lei = md.lei;
    if (md.cik) identifiers.cik = md.cik;
    if (md.ticker) identifiers.ticker = md.ticker;
    return {
      collectorId: SEC_EDGAR_COLLECTOR_ID,
      name: d.scopeSupplierName ?? "",
      country: "US",
      ...(Object.keys(identifiers).length > 0 ? { identifiers } : {}),
    };
  });
  const uids = await resolveDraftEntities(inputs);
  return drafts.map((d, i) => {
    const uid = uids[i];
    return uid ? { ...d, entityUid: uid } : d;
  });
}

const edgarMetadataSchema = z
  .object({
    cik: z.string().length(10),
    accessionNumber: z.string().min(1),
    form: z.string().min(1),
    primaryDocument: z.string().nullable().optional(),
    items: z.string().nullable().optional(),
    ticker: z.string().nullable().optional(),
    lei: z.string().nullable().optional(),
  })
  .passthrough();

const edgarSignalSchema = buildSignalDraftSchema(edgarMetadataSchema);

export const secEdgarCollector: IntelligenceCollector<typeof edgarSignalSchema> = {
  id: SEC_EDGAR_COLLECTOR_ID,
  name: "SEC EDGAR Corporate Filings",
  description:
    "Polls the SEC EDGAR submissions JSON endpoint for recent 10-K, 10-Q, 8-K, DEF 14A, and NT-* filings on a curated issuer set, and emits one corporate_filing MarketSignal per filing scoped by supplier name with form type, accession, and filing index URL.",
  posture: "public-api",
  sourceUrl: "https://www.sec.gov/edgar/searchedgar/companysearch",
  defaultRateLimitRpm: 60,
  defaultScheduleCron: "0 13-21 * * 1-5", // hourly during US market hours
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "US",
  retentionDays: 365,
  tenantOptInDefault: true,
  signalSchema: edgarSignalSchema,
  stableSignalKey(draft) {
    // A given (supplier, accession) is unique across runs; observedAt
    // is the filed-at date and is part of the natural key already.
    return defaultStableSignalKey(SEC_EDGAR_COLLECTOR_ID, draft);
  },
  async collect(): Promise<MarketSignalDraft[]> {
    return (await this.collectWithRaw!({ since: null })).drafts;
  },
  async collectWithRaw(): Promise<CollectWithRawResult> {
    const userAgent = buildEdgarUserAgent();
    const drafts: MarketSignalDraft[] = [];
    const rawPayloads: RawPayload[] = [];
    const failures: string[] = [];
    const issuers = await getActiveSecIssuers();
    for (const issuer of issuers) {
      try {
        const r = await fetchSubmissions(issuer.cik, userAgent);
        rawPayloads.push({
          name: `cik-${padCik(issuer.cik)}`,
          contentType: "application/json",
          body: r.body,
          sourceUrl: r.url,
          metadata: { cik: padCik(issuer.cik), issuer: issuer.name },
        });
        for (const d of parseEdgarSubmissions(issuer, r.parsed)) {
          drafts.push(d);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${issuer.cik}: ${message}`);
        logger.warn(
          { collectorId: SEC_EDGAR_COLLECTOR_ID, cik: issuer.cik, err },
          "EDGAR submissions fetch failed",
        );
      }
    }
    // Same partial-outage rule as FRED: if every issuer failed, the
    // run is genuinely broken — surface it. Empty issuer lists are
    // also a hard fail so misconfigured tenants don't silently
    // skip the run.
    if (issuers.length === 0) {
      throw new Error(
        "SEC EDGAR collector: no issuers configured. Add tenant rows via POST /watched-issuers or restore SEC_EDGAR_DEFAULT_ISSUERS.",
      );
    }
    if (drafts.length === 0 && failures.length === issuers.length) {
      throw new Error(
        `SEC EDGAR collector: all ${issuers.length} issuers failed. Sample: ${failures.slice(0, 3).join("; ")}`,
      );
    }
    const enriched = await attachEntityUids(drafts);
    return { drafts: enriched, rawPayloads };
  },
};

/**
 * Backfill a single issuer (used by the admin backfill route): pulls
 * their full recent-filings window (EDGAR keeps ~1000 filings on the
 * recent-submissions JSON; older filings live in the per-year
 * "filings" array but those require a second request and are out of
 * scope for v0).
 */
export async function fetchEdgarBackfillDrafts(opts?: {
  issuers?: readonly SecIssuerRef[];
}): Promise<{
  drafts: MarketSignalDraft[];
  failedIssuers: Array<{ cik: string; error: string }>;
}> {
  const userAgent = buildEdgarUserAgent();
  // Same resolution as the live collector: explicit override > tenant
  // rows > seed list. Lets `runSecEdgarBackfill({ issuers: [...] })`
  // target a single CIK while a no-arg backfill still sweeps whatever
  // tenants have curated.
  const issuers = await getActiveSecIssuers(opts?.issuers);
  const drafts: MarketSignalDraft[] = [];
  const failedIssuers: Array<{ cik: string; error: string }> = [];
  for (const issuer of issuers) {
    try {
      const r = await fetchSubmissions(issuer.cik, userAgent);
      for (const d of parseEdgarSubmissions(issuer, r.parsed)) drafts.push(d);
    } catch (err) {
      failedIssuers.push({
        cik: issuer.cik,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const enriched = await attachEntityUids(drafts);
  return { drafts: enriched, failedIssuers };
}
