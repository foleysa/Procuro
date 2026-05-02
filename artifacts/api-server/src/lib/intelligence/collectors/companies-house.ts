/**
 * Companies House (UK) collector — corporate-filing stream for UK
 * registered entities.
 *
 * Pulls per-company filing histories via
 *   https://api.company-information.service.gov.uk/company/{COMPANY_NUMBER}/filing-history
 * for a curated set of company numbers. Companies House requires an
 * API key (free) sent as HTTP basic-auth user with empty password —
 * we read the key from `COMPANIES_HOUSE_API_KEY`.
 *
 * Each filing → one `corporate_filing` MarketSignal:
 *   - scope_supplier_name = company name (looked up once per number)
 *   - scope_sku           = transaction id (per-filing identifier)
 *   - scope_lane_key      = "GB"
 *   - value               = filing-category code (1 = accounts, 2 =
 *     confirmation-statement, 3 = officers, 4 = capital, 5 =
 *     mortgage, 6 = insolvency, 7 = address, 0 = other)
 *
 * Posture: `public_api`, tier `T1`. Companies House data is open and
 * citable.
 *
 * Default schedule: every 12 hours (Companies House publishes daily).
 */

import { z } from "zod";
import { db, watchedIssuersTable, collectorAuditLogTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { newId } from "../../ids";
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

export const COMPANIES_HOUSE_COLLECTOR_ID = "companies-house";

const CH_BASE_URL = "https://api.company-information.service.gov.uk";

/**
 * Seed company numbers — kept short so a fresh install with no tenant
 * curation still emits some `corporate_filing` drafts. Tenants curate
 * their own list via `watched_issuers` / POST /watched-issuers; once
 * any row exists the seed is bypassed (`getActiveCompaniesHouseNumbers`).
 */
export const COMPANIES_HOUSE_DEFAULT_NUMBERS: readonly string[] = [
  "00006245", // BP P.L.C.
  "02099500", // Vodafone Group Plc
  "00041424", // Diageo plc
  "00010892", // Tesco PLC
  "02366963", // Rolls-Royce Holdings plc
  "00102498", // Unilever PLC
  "00345700", // GlaxoSmithKline plc
  "01777777", // National Grid plc
];

/**
 * Companies House numbers are 8 chars zero-padded. Tenants paste
 * "6245" or "00006245"; either should normalise to the canonical
 * 8-char form so we don't end up with two `watched_issuers` rows for
 * the same company.
 */
export function normaliseCompaniesHouseNumber(input: string): string {
  // Allow alpha prefixes like "SC" (Scottish), "NI" (Northern Ireland) —
  // they're significant and not numeric. Pad numeric-only inputs.
  const trimmed = input.trim().toUpperCase();
  if (/^\d+$/.test(trimmed)) return trimmed.padStart(8, "0");
  return trimmed;
}

/**
 * Return distinct, normalised company numbers across every tenant's
 * watch list. Two tenants tracking the same number cost us only one
 * upstream pull.
 */
export async function loadWatchedCompaniesHouseNumbers(): Promise<string[]> {
  const rows = await db
    .select({ identifier: watchedIssuersTable.identifier })
    .from(watchedIssuersTable)
    .where(eq(watchedIssuersTable.source, "companies_house"));
  const seen = new Set<string>();
  for (const r of rows) {
    const n = normaliseCompaniesHouseNumber(r.identifier);
    if (n) seen.add(n);
  }
  return Array.from(seen);
}

/** Where the active number list came from on a given resolution call. */
export type CompaniesHouseNumberSource = "override" | "tenant" | "seed";

export interface ResolvedCompaniesHouseNumbers {
  source: CompaniesHouseNumberSource;
  numbers: string[];
}

function normaliseCompaniesHouseNumberList(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const n = normaliseCompaniesHouseNumber(x);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Resolve the number list the collector should poll on this tick AND
 * report which input it came from.
 *
 * Resolution order:
 *   1. Explicit `override` (admin backfill targeting specific numbers).
 *   2. Tenant-curated rows from `watched_issuers` (source='companies_house').
 *   3. `COMPANIES_HOUSE_DEFAULT_NUMBERS` seed — only when (2) is empty.
 *
 * The `source` label lets the collector log which list it resolved on
 * each tick and emit a one-shot transition warning when a tenant adds
 * its first watched issuer (seed → tenant) or removes the last one
 * (tenant → seed) — see `logResolvedCompaniesHouseNumbers`.
 */
export async function resolveActiveCompaniesHouseNumbers(
  override?: readonly string[],
): Promise<ResolvedCompaniesHouseNumbers> {
  if (override && override.length > 0) {
    return { source: "override", numbers: normaliseCompaniesHouseNumberList(override) };
  }
  const watched = await loadWatchedCompaniesHouseNumbers();
  if (watched.length > 0) return { source: "tenant", numbers: watched };
  return {
    source: "seed",
    numbers: normaliseCompaniesHouseNumberList(COMPANIES_HOUSE_DEFAULT_NUMBERS),
  };
}

/**
 * Back-compat shim: callers that only need the number array still get
 * the same shape. Internal collector code should prefer
 * `resolveActiveCompaniesHouseNumbers` so it can also log / alert on
 * the source.
 */
export async function getActiveCompaniesHouseNumbers(
  override?: readonly string[],
): Promise<string[]> {
  return (await resolveActiveCompaniesHouseNumbers(override)).numbers;
}

/**
 * Module-scoped memory of the last resolved source so we can detect
 * the seed → tenant (and tenant → seed) transition and emit a single
 * warning per process when it happens. Keyed by call-site label so
 * the live collector and the backfill helper don't shout over each
 * other.
 *
 * On the very first call per (callSite) per process we lazily seed
 * this from the most recent `issuer_list_source_changed` audit row
 * (see `seedChNumbersSourceFromAudit`) so a transition that happens
 * across a process restart still fires.
 */
const lastChNumbersSource = new Map<string, CompaniesHouseNumberSource>();
const seededChNumbersCallSites = new Set<string>();
/**
 * Test-only short-circuit. See the matching comment in
 * `sec-edgar.ts` — same rationale: the pure-helper unit test runs
 * with a placeholder/real DB and must stay hermetic.
 */
let chNumbersPersistenceEnabled = true;

/**
 * Lazily seed `lastChNumbersSource` for `callSite` from the most
 * recent durable `issuer_list_source_changed` audit row. Best-effort:
 * if the DB is unreachable we just skip seeding — the in-memory map
 * still catches every transition during this process's lifetime.
 */
async function seedChNumbersSourceFromAudit(callSite: string): Promise<void> {
  if (seededChNumbersCallSites.has(callSite)) return;
  seededChNumbersCallSites.add(callSite);
  if (lastChNumbersSource.has(callSite)) return;
  if (!chNumbersPersistenceEnabled) return;
  try {
    const [latest] = await db
      .select({ metadata: collectorAuditLogTable.metadata })
      .from(collectorAuditLogTable)
      .where(
        and(
          eq(collectorAuditLogTable.collectorId, COMPANIES_HOUSE_COLLECTOR_ID),
          eq(collectorAuditLogTable.event, "issuer_list_source_changed"),
          sql`${collectorAuditLogTable.metadata}->>'callSite' = ${callSite}`,
        ),
      )
      .orderBy(desc(collectorAuditLogTable.createdAt))
      .limit(1);
    if (!latest) return;
    const meta = latest.metadata as Record<string, unknown>;
    const last = meta["listSource"];
    if (
      last === "seed" ||
      last === "tenant" ||
      last === "override"
    ) {
      lastChNumbersSource.set(callSite, last);
    }
  } catch (err) {
    logger.debug(
      { collectorId: COMPANIES_HOUSE_COLLECTOR_ID, callSite, err },
      "Companies House: could not seed number-list source memory from audit log",
    );
  }
}

/**
 * Persist a transition to `collector_audit_log` so the operational-
 * alert synthesizer can fan it out as an
 * `operational_collector_issuer_list_flip` alert. Best-effort: a
 * failed audit write must never break the collector tick.
 */
async function recordChNumbersSourceTransition(args: {
  previousSource: CompaniesHouseNumberSource;
  listSource: CompaniesHouseNumberSource;
  numberCount: number;
  callSite: string;
}): Promise<void> {
  if (!chNumbersPersistenceEnabled) return;
  try {
    await db.insert(collectorAuditLogTable).values({
      id: newId("aud"),
      collectorId: COMPANIES_HOUSE_COLLECTOR_ID,
      event: "issuer_list_source_changed",
      metadata: {
        previousSource: args.previousSource,
        listSource: args.listSource,
        // Carry the count under both `issuerCount` (the synthesizer's
        // generic field name across both collectors) and the
        // collector-native `numberCount` so existing log search
        // queries keep working.
        issuerCount: args.numberCount,
        numberCount: args.numberCount,
        callSite: args.callSite,
      },
    });
  } catch (err) {
    logger.warn(
      { collectorId: COMPANIES_HOUSE_COLLECTOR_ID, callSite: args.callSite, err },
      "Companies House: failed to persist number-list transition to audit log",
    );
  }
}

/**
 * Emit a one-line INFO per tick describing which list resolved and
 * how many numbers we will poll, plus a one-shot WARN + durable
 * audit-log row whenever the source transitions (seed → tenant,
 * tenant → seed). The audit row drives
 * `synthesizeOperationalAlerts` →
 * `operational_collector_issuer_list_flip`, which routes through the
 * same delivery channels as collector-failure pages.
 */
export async function logResolvedCompaniesHouseNumbers(
  resolved: ResolvedCompaniesHouseNumbers,
  callSite: "collect" | "backfill",
): Promise<void> {
  logger.info(
    {
      collectorId: COMPANIES_HOUSE_COLLECTOR_ID,
      listSource: resolved.source,
      numberCount: resolved.numbers.length,
      callSite,
    },
    `Companies House: polling ${resolved.numbers.length} company number(s) (source=${resolved.source})`,
  );
  await seedChNumbersSourceFromAudit(callSite);
  const previous = lastChNumbersSource.get(callSite);
  if (previous && previous !== resolved.source) {
    logger.warn(
      {
        collectorId: COMPANIES_HOUSE_COLLECTOR_ID,
        previousSource: previous,
        listSource: resolved.source,
        numberCount: resolved.numbers.length,
        callSite,
      },
      `Companies House: number-list source transitioned ${previous} → ${resolved.source}`,
    );
    await recordChNumbersSourceTransition({
      previousSource: previous,
      listSource: resolved.source,
      numberCount: resolved.numbers.length,
      callSite,
    });
  }
  lastChNumbersSource.set(callSite, resolved.source);
}

/** Test-only: reset the transition memory between cases. */
export function _resetCompaniesHouseSourceMemoryForTests(): void {
  lastChNumbersSource.clear();
  seededChNumbersCallSites.clear();
}

/**
 * Test-only: disable the best-effort `collector_audit_log`
 * write/seed so pure-helper unit tests stay hermetic.
 */
export function _disableCompaniesHousePersistenceForTests(): void {
  chNumbersPersistenceEnabled = false;
}

export const FILING_CATEGORY_CODES: Record<string, number> = {
  accounts: 1,
  "confirmation-statement": 2,
  "annual-return": 2,
  officers: 3,
  capital: 4,
  mortgage: 5,
  "gazette-insolvency": 6,
  insolvency: 6,
  "address": 7,
  "registered-office-address": 7,
  incorporation: 8,
  "change-of-name": 9,
  resolution: 10,
};

export interface ChCompanyProfile {
  company_number?: string;
  company_name?: string;
  jurisdiction?: string;
  company_status?: string;
  type?: string;
}

export interface ChFilingItem {
  transaction_id?: string;
  category?: string;
  description?: string;
  type?: string;
  date?: string;
  action_date?: string;
  links?: { self?: string; document_metadata?: string };
}

export interface ChFilingHistory {
  total_count?: number;
  items?: ChFilingItem[];
}

/** Build the Authorization header for Companies House (basic auth, key as user). */
function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

/**
 * Convert one filing history item + its parent company info into a
 * MarketSignalDraft.
 */
export function filingToDraft(
  company: ChCompanyProfile,
  filing: ChFilingItem,
): MarketSignalDraft | null {
  const txId = filing.transaction_id;
  const date = filing.date ?? filing.action_date;
  if (!txId || !date) return null;
  const observedAt = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(observedAt.getTime())) return null;
  const category = filing.category ?? "other";
  const value = FILING_CATEGORY_CODES[category] ?? 0;
  const companyName = company.company_name ?? company.company_number ?? "Unknown";
  const sourceUrl = filing.links?.self
    ? `https://find-and-update.company-information.service.gov.uk${filing.links.self}`
    : `https://find-and-update.company-information.service.gov.uk/company/${company.company_number}`;
  return {
    signalType: "corporate_filing",
    scopeSupplierName: companyName,
    scopeSku: txId,
    scopeLaneKey: company.jurisdiction ?? "gb",
    value,
    unit: "filing_category_code",
    currency: "GBP",
    observedAt,
    sourceUrl,
    confidence: 0.99,
    // entityUid is populated by the collector's resolver pass.
    metadata: {
      companyNumber: company.company_number ?? null,
      companyName,
      companyStatus: company.company_status ?? null,
      companyType: company.type ?? null,
      transactionId: txId,
      category,
      description: filing.description ?? null,
      type: filing.type ?? null,
      jurisdiction: company.jurisdiction ?? null,
    },
  };
}

export function parseFilingHistory(
  company: ChCompanyProfile,
  history: ChFilingHistory,
): MarketSignalDraft[] {
  const drafts: MarketSignalDraft[] = [];
  for (const item of history.items ?? []) {
    const d = filingToDraft(company, item);
    if (d) drafts.push(d);
  }
  return drafts;
}

const chMetadataSchema = z
  .object({
    companyNumber: z.string().nullable(),
    companyName: z.string().min(1),
    companyStatus: z.string().nullable(),
    companyType: z.string().nullable(),
    transactionId: z.string().min(1),
    category: z.string().min(1),
    description: z.string().nullable(),
    type: z.string().nullable(),
    jurisdiction: z.string().nullable(),
  })
  .passthrough();

const chSignalSchema = buildSignalDraftSchema(chMetadataSchema);

async function fetchChJson<T>(
  path: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ url: string; body: string; parsed: T }> {
  const url = `${CH_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(apiKey),
      Accept: "application/json",
    },
    signal,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Companies House HTTP ${res.status} ${path}: ${body.slice(0, 200)}`);
  }
  return { url, body, parsed: JSON.parse(body) as T };
}

async function pullCompany(
  number: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{
  drafts: MarketSignalDraft[];
  rawPayloads: RawPayload[];
}> {
  const profile = await fetchChJson<ChCompanyProfile>(
    `/company/${number}`,
    apiKey,
    signal,
  );
  const history = await fetchChJson<ChFilingHistory>(
    `/company/${number}/filing-history?items_per_page=100`,
    apiKey,
    signal,
  );
  const drafts = parseFilingHistory(profile.parsed, history.parsed);
  const rawPayloads: RawPayload[] = [
    {
      name: `company-${number}`,
      contentType: "application/json",
      body: profile.body,
      sourceUrl: profile.url,
      metadata: { companyNumber: number, kind: "profile" },
    },
    {
      name: `filing-history-${number}`,
      contentType: "application/json",
      body: history.body,
      sourceUrl: history.url,
      metadata: { companyNumber: number, kind: "filing-history" },
    },
  ];
  return { drafts, rawPayloads };
}

async function attachChEntityUids(
  drafts: MarketSignalDraft[],
): Promise<MarketSignalDraft[]> {
  const inputs = drafts.map((d) => {
    const md = (d.metadata ?? {}) as {
      companyNumber?: string | null;
      jurisdiction?: string | null;
    };
    return {
      collectorId: COMPANIES_HOUSE_COLLECTOR_ID,
      name: d.scopeSupplierName ?? "",
      country: "GB",
      ...(md.companyNumber
        ? { identifiers: { companies_house: md.companyNumber } }
        : {}),
    };
  });
  const uids = await resolveDraftEntities(inputs);
  return drafts.map((d, i) => (uids[i] ? { ...d, entityUid: uids[i]! } : d));
}

export const companiesHouseCollector: IntelligenceCollector<typeof chSignalSchema> = {
  id: COMPANIES_HOUSE_COLLECTOR_ID,
  name: "UK Companies House Filings",
  description:
    "Polls the Companies House REST API for the recent filing history of a curated set of UK company numbers and emits one corporate_filing MarketSignal per filing (transaction id in scope_sku, filing-category code in value).",
  posture: "public-api",
  sourceUrl: "https://developer.company-information.service.gov.uk/",
  defaultRateLimitRpm: 60,
  // Companies House registers most filings overnight UK time. Daily at
  // 06:00 UTC catches the previous day's transactions without spending
  // the rate budget on intra-day no-op polls.
  defaultScheduleCron: "0 6 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "GB",
  retentionDays: 1095,
  tenantOptInDefault: true,
  signalSchema: chSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(COMPANIES_HOUSE_COLLECTOR_ID, draft);
  },
  async collect({ signal } = { since: null }): Promise<MarketSignalDraft[]> {
    return (await this.collectWithRaw!({ since: null, signal })).drafts;
  },
  async collectWithRaw({ signal } = { since: null }): Promise<CollectWithRawResult> {
    const apiKey = process.env["COMPANIES_HOUSE_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "COMPANIES_HOUSE_API_KEY is not set. Get a free key at https://developer.company-information.service.gov.uk/.",
      );
    }
    const drafts: MarketSignalDraft[] = [];
    const rawPayloads: RawPayload[] = [];
    const failures: string[] = [];
    const resolved = await resolveActiveCompaniesHouseNumbers();
    await logResolvedCompaniesHouseNumbers(resolved, "collect");
    const numbers = resolved.numbers;
    if (numbers.length === 0) {
      throw new Error(
        "companies-house: no company numbers configured. Add tenant rows via POST /watched-issuers or restore COMPANIES_HOUSE_DEFAULT_NUMBERS.",
      );
    }
    for (const number of numbers) {
      try {
        const r = await pullCompany(number, apiKey, signal);
        for (const x of r.drafts) drafts.push(x);
        for (const p of r.rawPayloads) rawPayloads.push(p);
      } catch (err) {
        failures.push(`${number}: ${err instanceof Error ? err.message : String(err)}`);
        logger.warn(
          { collectorId: COMPANIES_HOUSE_COLLECTOR_ID, number, err },
          "Companies House pull failed",
        );
      }
    }
    if (drafts.length === 0 && failures.length === numbers.length) {
      throw new Error(
        `companies-house: all ${numbers.length} companies failed. Sample: ${failures.slice(0, 2).join("; ")}`,
      );
    }
    const enriched = await attachChEntityUids(drafts);
    return { drafts: enriched, rawPayloads };
  },
};

/** Backfill — caller supplies an arbitrary set of company numbers. */
export async function fetchCompaniesHouseBackfillDrafts(opts?: {
  numbers?: readonly string[];
}): Promise<{
  drafts: MarketSignalDraft[];
  failed: Array<{ number: string; error: string }>;
}> {
  const apiKey = process.env["COMPANIES_HOUSE_API_KEY"];
  if (!apiKey) throw new Error("COMPANIES_HOUSE_API_KEY is not set");
  // Same resolution rule as the live collector: explicit override beats
  // tenant rows, which beat the seed list.
  const resolved = await resolveActiveCompaniesHouseNumbers(opts?.numbers);
  await logResolvedCompaniesHouseNumbers(resolved, "backfill");
  const numbers = resolved.numbers;
  const drafts: MarketSignalDraft[] = [];
  const failed: Array<{ number: string; error: string }> = [];
  for (const number of numbers) {
    try {
      const r = await pullCompany(number, apiKey);
      for (const x of r.drafts) drafts.push(x);
    } catch (err) {
      failed.push({ number, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const enriched = await attachChEntityUids(drafts);
  return { drafts: enriched, failed };
}
