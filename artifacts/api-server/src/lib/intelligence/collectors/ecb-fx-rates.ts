/**
 * European Central Bank daily euro foreign-exchange reference rates.
 *
 * The ECB publishes its reference rates once per business day, typically
 * around 16:00 CET, as a small public XML document. Schema:
 *
 *   <gesmes:Envelope ...>
 *     <Cube>
 *       <Cube time="YYYY-MM-DD">
 *         <Cube currency="USD" rate="1.0823"/>
 *         ...
 *       </Cube>
 *     </Cube>
 *   </gesmes:Envelope>
 *
 * Each `<Cube currency=X rate=R/>` means "1 EUR = R units of X". This
 * collector emits an `fx_rate` MarketSignal per tracked currency (EUR-base),
 * then derives USD-base cross rates by combining the relevant EUR rates.
 *
 * Posture is `public-api`: the feed is free, requires no API key, and is
 * explicitly intended for public reference use.
 *
 * The same envelope shape is also used for the ECB's historical archive
 * (`eurofxref-hist.xml`), which contains one `<Cube time="...">` block per
 * business day going back to 1999. The historical feed is what the one-shot
 * backfill below uses to seed multi-year FX context.
 */

import { z } from "zod";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../collector";

const ECB_DAILY_FEED_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
/**
 * ECB historical reference-rates archive (XML form). The ZIP variant
 * (`eurofxref-hist.zip`) wraps the same XML, so we fetch the XML directly to
 * avoid pulling in a ZIP dependency for one feed.
 */
const ECB_HISTORICAL_FEED_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml";
const ECB_REFERENCE_PAGE_URL =
  "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html";

/** Currencies we emit as EUR-base pairs (must be present in the ECB feed). */
const TRACKED_EUR_QUOTES = [
  "USD",
  "GBP",
  "JPY",
  "CNY",
  "CHF",
  "CAD",
  "AUD",
  "MXN",
  "INR",
  "BRL",
] as const;

/** Currencies we additionally emit as USD-base derived pairs. */
const DERIVED_USD_QUOTES = [
  "GBP",
  "JPY",
  "CNY",
  "CHF",
  "CAD",
  "MXN",
  "INR",
  "BRL",
] as const;

export interface EcbFeed {
  /** ECB-published date (YYYY-MM-DD) for the rate set. */
  date: string;
  /** rates[currencyCode] = units of currency per 1 EUR */
  rates: Record<string, number>;
}

/**
 * Parse the ECB daily reference-rates XML. The feed is small, stable, and
 * uses no nested namespaces beyond the outer envelope, so a focused regex
 * pass is more than sufficient and avoids pulling in an XML dependency.
 */
export function parseEcbDailyFeed(xml: string): EcbFeed {
  const dateMatch = xml.match(/<Cube\s+time=['"]([0-9-]+)['"]/);
  if (!dateMatch) {
    throw new Error("ECB feed: missing time attribute");
  }
  const date = dateMatch[1]!;

  const rates: Record<string, number> = {};
  const rateRegex =
    /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = rateRegex.exec(xml)) !== null) {
    const code = m[1]!;
    const rate = Number(m[2]);
    if (Number.isFinite(rate) && rate > 0) {
      rates[code] = rate;
    }
  }
  if (Object.keys(rates).length === 0) {
    throw new Error("ECB feed: no rates parsed");
  }
  return { date, rates };
}

/**
 * Parse the ECB historical reference-rates XML. The historical archive
 * uses the same envelope as the daily feed but contains many sibling
 * `<Cube time="...">` blocks (one per business day, ordered newest-first
 * by ECB) — so we walk each day-block and parse its currency rows.
 *
 * Returns one EcbFeed per day. The order is preserved from the document.
 */
export function parseEcbHistoricalFeed(xml: string): EcbFeed[] {
  const dayBlockRegex =
    /<Cube\s+time=['"]([0-9-]+)['"][^>]*>([\s\S]*?)<\/Cube>/g;
  const rateRegex =
    /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/?>/g;
  const out: EcbFeed[] = [];
  let block: RegExpExecArray | null;
  while ((block = dayBlockRegex.exec(xml)) !== null) {
    const date = block[1]!;
    const body = block[2]!;
    const rates: Record<string, number> = {};
    rateRegex.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = rateRegex.exec(body)) !== null) {
      const code = r[1]!;
      const rate = Number(r[2]);
      if (Number.isFinite(rate) && rate > 0) {
        rates[code] = rate;
      }
    }
    if (Object.keys(rates).length > 0) {
      out.push({ date, rates });
    }
  }
  if (out.length === 0) {
    throw new Error("ECB historical feed: no day blocks parsed");
  }
  return out;
}

/**
 * The ECB publishes once per business day around 16:00 CET (= 15:00 UTC).
 * The feed gives us a date but not a publication clock time, so we anchor
 * `observedAt` to 15:00 UTC of the published date for stable downstream
 * deduplication.
 *
 * Exported so the runtime's DB pre-check can resolve the same canonical
 * `observed_at` shape when it asks "is this archive day already in
 * `market_signals`?" — keeping the anchor in one place avoids drift
 * between the writer and the reader.
 */
export function ecbObservedAt(date: string): Date {
  return new Date(`${date}T15:00:00Z`);
}

async function fetchEcbFeed(signal?: AbortSignal): Promise<string> {
  const res = await fetch(ECB_DAILY_FEED_URL, {
    headers: { Accept: "application/xml, text/xml, */*" },
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `ECB feed fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  return await res.text();
}

async function fetchEcbHistoricalFeed(signal?: AbortSignal): Promise<{
  xml: string;
  lastModified: string | null;
  etag: string | null;
}> {
  const res = await fetch(ECB_HISTORICAL_FEED_URL, {
    headers: { Accept: "application/xml, text/xml, */*" },
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `ECB historical feed fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  return {
    xml: await res.text(),
    lastModified: res.headers.get("last-modified"),
    etag: res.headers.get("etag"),
  };
}

/**
 * Cheap HEAD probe of the ECB historical archive. Used by the backfill
 * runtime to short-circuit when neither `Last-Modified` nor `ETag` has
 * advanced since the previous successful run's watermark — avoiding the
 * full XML fetch + ~7000-day fan-out + ~80k row dedupe pass on every call.
 *
 * Returns `null` for either header if the upstream omits it; callers
 * should treat "no headers and no prior watermark" as "must fetch the
 * full body" so we never silently skip a real refresh.
 */
export async function headEcbHistoricalFeed(): Promise<{
  lastModified: string | null;
  etag: string | null;
}> {
  const res = await fetch(ECB_HISTORICAL_FEED_URL, {
    method: "HEAD",
    headers: { Accept: "application/xml, text/xml, */*" },
  });
  if (!res.ok) {
    throw new Error(
      `ECB historical feed HEAD failed: ${res.status} ${res.statusText}`,
    );
  }
  return {
    lastModified: res.headers.get("last-modified"),
    etag: res.headers.get("etag"),
  };
}

/**
 * Build the EUR-base + USD-derived `MarketSignalDraft`s that correspond to
 * one ECB-published day. The shape (signalType, scope_material_code,
 * observed_at, metadata.base/quote/derived) matches what the live
 * `collect()` writes — backfilled rows are indistinguishable from rows
 * the daily collector would have produced on the same date, which is what
 * lets the deduper recognize them.
 *
 * `feedTag` is stamped into `metadata.feed` so we can tell live rows
 * (`ecb-eurofxref-daily`) apart from backfill rows
 * (`ecb-eurofxref-hist`) when auditing.
 */
export function buildEcbDraftsForDay(
  feed: EcbFeed,
  feedTag: "ecb-eurofxref-daily" | "ecb-eurofxref-hist",
): MarketSignalDraft[] {
  const observedAt = ecbObservedAt(feed.date);
  const drafts: MarketSignalDraft[] = [];

  for (const quote of TRACKED_EUR_QUOTES) {
    const rate = feed.rates[quote];
    if (rate === undefined) continue;
    const pair = `EUR/${quote}`;
    drafts.push({
      signalType: "fx_rate",
      scopeMaterialCode: pair,
      value: rate,
      unit: pair,
      currency: quote,
      observedAt,
      sourceUrl: ECB_REFERENCE_PAGE_URL,
      confidence: 0.99,
      metadata: {
        base: "EUR",
        quote,
        feed: feedTag,
        publishedDate: feed.date,
      },
    });
  }

  const usdPerEur = feed.rates["USD"];
  if (usdPerEur !== undefined && usdPerEur > 0) {
    for (const quote of DERIVED_USD_QUOTES) {
      const quotePerEur = feed.rates[quote];
      if (quotePerEur === undefined) continue;
      // ECB gives "X per EUR". USD/quote = (quote per EUR) / (USD per EUR).
      const usdRate = +(quotePerEur / usdPerEur).toFixed(6);
      const pair = `USD/${quote}`;
      drafts.push({
        signalType: "fx_rate",
        scopeMaterialCode: pair,
        value: usdRate,
        unit: pair,
        currency: quote,
        observedAt,
        sourceUrl: ECB_REFERENCE_PAGE_URL,
        confidence: 0.95,
        metadata: {
          base: "USD",
          quote,
          derived: true,
          derivedFrom: ["EUR/USD", `EUR/${quote}`],
          feed: feedTag,
          publishedDate: feed.date,
        },
      });
    }
  }

  return drafts;
}

/** Public id for the ECB FX rates collector. */
export const ECB_FX_RATES_COLLECTOR_ID = "ecb-fx-rates";

/**
 * Build all backfill drafts from a parsed historical feed. Exported for
 * unit testing the day → drafts fan-out without needing a live HTTP call.
 */
export function buildEcbBackfillDrafts(feeds: EcbFeed[]): MarketSignalDraft[] {
  const out: MarketSignalDraft[] = [];
  for (const f of feeds) {
    for (const d of buildEcbDraftsForDay(f, "ecb-eurofxref-hist")) {
      out.push(d);
    }
  }
  return out;
}

/**
 * One-shot historical backfill for the ECB FX collector.
 *
 * Fetches `eurofxref-hist.xml` once, expands it into one MarketSignalDraft
 * per (day × tracked currency × EUR/USD base), and returns them all. The
 * caller (runtime) is responsible for the idempotent insert against
 * `market_signals` — this function is intentionally pure I/O so it can be
 * tested by stubbing `fetch`.
 */
export async function fetchEcbBackfillDrafts(): Promise<MarketSignalDraft[]> {
  const { drafts } = await fetchEcbBackfillDraftsWithMeta();
  return drafts;
}

/**
 * Same as `fetchEcbBackfillDrafts` but also returns the upstream
 * `Last-Modified` and `ETag` headers from the historical archive so the
 * caller can persist them as a watermark and short-circuit subsequent
 * runs with a cheap HEAD when nothing has advanced.
 */
export async function fetchEcbBackfillDraftsWithMeta(): Promise<{
  drafts: MarketSignalDraft[];
  lastModified: string | null;
  etag: string | null;
}> {
  const { xml, lastModified, etag } = await fetchEcbHistoricalFeed();
  const feeds = parseEcbHistoricalFeed(xml);
  return { drafts: buildEcbBackfillDrafts(feeds), lastModified, etag };
}

/**
 * ECB drafts always carry the base/quote currency labels so downstream
 * consumers don't have to re-parse `unit` to learn which side is which.
 */
const ecbMetadataSchema = z
  .object({
    base: z.enum(["EUR", "USD"]),
    quote: z.string().length(3),
    feed: z.string().min(1),
    publishedDate: z.string().min(8),
    derived: z.boolean().optional(),
    derivedFrom: z.array(z.string()).optional(),
  })
  .passthrough();

const ecbSignalSchema = buildSignalDraftSchema(ecbMetadataSchema);

export const ecbFxRatesCollector: IntelligenceCollector<typeof ecbSignalSchema> = {
  id: ECB_FX_RATES_COLLECTOR_ID,
  name: "ECB FX Reference Rates",
  description:
    "Daily euro foreign-exchange reference rates published by the European Central Bank, plus USD-base cross rates derived from the EUR reference set.",
  posture: "public-api",
  sourceUrl: ECB_REFERENCE_PAGE_URL,
  defaultRateLimitRpm: 30,
  // Hourly Mon-Fri. ECB publishes once per business day around 16:00 CET;
  // hourly polling is cheap (one tiny XML doc) and catches the refresh promptly.
  defaultScheduleCron: "0 * * * 1-5",
  postureClass: "public_api",
  // ECB reference rates are universally citable.
  disclosureTier: "T1",
  jurisdiction: "EU",
  retentionDays: 365,
  tenantOptInDefault: true,
  signalSchema: ecbSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(ECB_FX_RATES_COLLECTOR_ID, draft);
  },
  async collect({ since: _since, signal }): Promise<MarketSignalDraft[]> {
    const xml = await fetchEcbFeed(signal);
    const feed = parseEcbDailyFeed(xml);
    return buildEcbDraftsForDay(feed, "ecb-eurofxref-daily");
  },
};
