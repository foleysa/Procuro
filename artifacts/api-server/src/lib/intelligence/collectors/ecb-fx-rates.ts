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
 */

import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../collector";

const ECB_DAILY_FEED_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
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

interface EcbFeed {
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
 * The ECB publishes once per business day around 16:00 CET (= 15:00 UTC).
 * The feed gives us a date but not a publication clock time, so we anchor
 * `observedAt` to 15:00 UTC of the published date for stable downstream
 * deduplication.
 */
function ecbObservedAt(date: string): Date {
  return new Date(`${date}T15:00:00Z`);
}

async function fetchEcbFeed(): Promise<string> {
  const res = await fetch(ECB_DAILY_FEED_URL, {
    headers: { Accept: "application/xml, text/xml, */*" },
  });
  if (!res.ok) {
    throw new Error(
      `ECB feed fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  return await res.text();
}

export const ecbFxRatesCollector: IntelligenceCollector = {
  id: "ecb-fx-rates",
  name: "ECB FX Reference Rates",
  description:
    "Daily euro foreign-exchange reference rates published by the European Central Bank, plus USD-base cross rates derived from the EUR reference set.",
  posture: "public-api",
  sourceUrl: ECB_REFERENCE_PAGE_URL,
  defaultRateLimitRpm: 30,
  // Hourly Mon-Fri. ECB publishes once per business day around 16:00 CET;
  // hourly polling is cheap (one tiny XML doc) and catches the refresh promptly.
  defaultScheduleCron: "0 * * * 1-5",
  async collect({ since: _since }): Promise<MarketSignalDraft[]> {
    const xml = await fetchEcbFeed();
    const feed = parseEcbDailyFeed(xml);
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
          feed: "ecb-eurofxref-daily",
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
            feed: "ecb-eurofxref-daily",
            publishedDate: feed.date,
          },
        });
      }
    }

    return drafts;
  },
};
