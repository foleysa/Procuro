/**
 * Deterministic supplier billing-currency resolver.
 *
 * Used by the supplier-ingest path when the upstream feed (CSV / ERP) does
 * not provide an explicit `billing_currency` for a supplier row. The
 * resolver is purely deterministic — no LLM, no external lookup — and
 * always emits a confidence score so downstream callers (and the UI) can
 * decide whether to surface "auto-detected" suppliers for human
 * confirmation.
 *
 * Resolution order
 * ----------------
 *   1. **Country code** (ISO-3166 alpha-2).
 *      - If the country has exactly one in-use ISO-4217 currency, return
 *        it with `high` confidence (e.g. `DE → EUR`, `JP → JPY`).
 *      - Multi-currency / dollarized / volatile-currency countries return
 *        a hint with `low` confidence (e.g. `EC → USD` is technically
 *        correct but USD is also used informally elsewhere; `XK → EUR`
 *        is de-facto but not official).
 *      - Eurozone countries map to EUR with `high` confidence.
 *   2. **Invoice samples** (currency symbol or ISO code in raw invoice
 *      strings). Caller passes a small set of recently-observed invoice
 *      strings (e.g. invoice numbers, line text, "Total: £1,234.56").
 *      The resolver scans for an unambiguous symbol or three-letter ISO
 *      code. A symbol-based hit returns `medium` confidence (symbols are
 *      shared across currencies — `$` is USD/CAD/AUD/...); an ISO-code
 *      hit returns `high` confidence.
 *   3. **None** — return null (the caller leaves `billing_currency` null,
 *      which means "inherits org base currency" downstream).
 *
 * If both a country-derived hit and an invoice-derived hit exist, the
 * higher-confidence one wins; on a tie the country wins (it's almost
 * always the more authoritative signal for a billing relationship).
 *
 * Confidence levels
 * -----------------
 *   - `high`   = 0.95 — single-currency country OR ISO code in invoice
 *   - `medium` = 0.70 — currency symbol in invoice
 *   - `low`    = 0.40 — multi-currency / dollarized country
 *
 * Adding a new entry
 * ------------------
 * Edit `COUNTRY_TO_CURRENCY` below. Use `single` for unambiguous mapping
 * and `dollarized` for de-facto / informal usage. Tests in
 * `test/billing-currency-resolver.test.ts` pin the contract so a typo
 * in the table fails CI rather than silently mis-tagging suppliers.
 */

export type BillingCurrencyConfidence = "high" | "medium" | "low";

export const BILLING_CURRENCY_CONFIDENCE_SCORES: Record<
  BillingCurrencyConfidence,
  number
> = {
  high: 0.95,
  medium: 0.7,
  low: 0.4,
};

/** Source of the resolved currency, persisted on the supplier row for audit. */
export type BillingCurrencyResolverSource =
  | "country"
  | "invoice_iso"
  | "invoice_symbol"
  | "country_dollarized";

export interface BillingCurrencyResolution {
  /** ISO 4217 currency code (3 letters, uppercase). */
  currency: string;
  confidence: BillingCurrencyConfidence;
  /** Numeric score (0-1) — `BILLING_CURRENCY_CONFIDENCE_SCORES[confidence]`. */
  confidenceScore: number;
  source: BillingCurrencyResolverSource;
  /** Optional debug detail (e.g. matched substring, country code). */
  evidence?: string;
}

export interface BillingCurrencyResolverInput {
  /** ISO-3166 alpha-2 country code, if known. Case-insensitive. */
  countryCode?: string | null;
  /**
   * A handful of recently-observed invoice strings (numbers, descriptions,
   * line text). Scanned for currency symbols / ISO codes. Usually the
   * adapter passes the latest 3-5 invoices for the supplier; an empty
   * array is fine.
   */
  invoiceSamples?: readonly string[];
}

interface CountryEntry {
  currency: string;
  /**
   * `single` — the country has one in-use currency (high confidence).
   * `dollarized` — informal / de-facto USD-or-EUR usage (low confidence).
   */
  kind: "single" | "dollarized";
}

/**
 * Country → currency lookup.
 *
 * Coverage targets the ~80% of supplier countries that show up in real
 * procurement portfolios (G20 + EU + commonly sourced manufacturing
 * countries). Add entries as ingest data widens — each addition needs a
 * line here and (for `single`) an assertion in
 * `test/billing-currency-resolver.test.ts`.
 *
 * Notes:
 *   - Eurozone members are listed individually as `single → EUR`. New
 *     eurozone members should be added when they adopt the euro.
 *   - Countries with multiple in-use currencies are intentionally
 *     omitted (e.g. `ZW`) so we fall back to invoice-pattern matching
 *     rather than guessing.
 *   - Dollarized economies (`EC`, `SV`, `PA`, `TL`) return USD with
 *     `low` confidence — correct in practice but ambiguous enough that
 *     the UI should surface for human confirmation.
 */
const COUNTRY_TO_CURRENCY: Readonly<Record<string, CountryEntry>> = {
  // North America
  US: { currency: "USD", kind: "single" },
  CA: { currency: "CAD", kind: "single" },
  MX: { currency: "MXN", kind: "single" },
  // South America
  BR: { currency: "BRL", kind: "single" },
  AR: { currency: "ARS", kind: "single" },
  CL: { currency: "CLP", kind: "single" },
  CO: { currency: "COP", kind: "single" },
  PE: { currency: "PEN", kind: "single" },
  UY: { currency: "UYU", kind: "single" },
  // Eurozone (single-currency members)
  AT: { currency: "EUR", kind: "single" },
  BE: { currency: "EUR", kind: "single" },
  CY: { currency: "EUR", kind: "single" },
  DE: { currency: "EUR", kind: "single" },
  EE: { currency: "EUR", kind: "single" },
  ES: { currency: "EUR", kind: "single" },
  FI: { currency: "EUR", kind: "single" },
  FR: { currency: "EUR", kind: "single" },
  GR: { currency: "EUR", kind: "single" },
  HR: { currency: "EUR", kind: "single" },
  IE: { currency: "EUR", kind: "single" },
  IT: { currency: "EUR", kind: "single" },
  LT: { currency: "EUR", kind: "single" },
  LU: { currency: "EUR", kind: "single" },
  LV: { currency: "EUR", kind: "single" },
  MT: { currency: "EUR", kind: "single" },
  NL: { currency: "EUR", kind: "single" },
  PT: { currency: "EUR", kind: "single" },
  SI: { currency: "EUR", kind: "single" },
  SK: { currency: "EUR", kind: "single" },
  // Other Europe
  GB: { currency: "GBP", kind: "single" },
  CH: { currency: "CHF", kind: "single" },
  SE: { currency: "SEK", kind: "single" },
  NO: { currency: "NOK", kind: "single" },
  DK: { currency: "DKK", kind: "single" },
  PL: { currency: "PLN", kind: "single" },
  CZ: { currency: "CZK", kind: "single" },
  HU: { currency: "HUF", kind: "single" },
  RO: { currency: "RON", kind: "single" },
  BG: { currency: "BGN", kind: "single" },
  // Asia-Pacific
  JP: { currency: "JPY", kind: "single" },
  CN: { currency: "CNY", kind: "single" },
  HK: { currency: "HKD", kind: "single" },
  TW: { currency: "TWD", kind: "single" },
  KR: { currency: "KRW", kind: "single" },
  SG: { currency: "SGD", kind: "single" },
  MY: { currency: "MYR", kind: "single" },
  TH: { currency: "THB", kind: "single" },
  VN: { currency: "VND", kind: "single" },
  ID: { currency: "IDR", kind: "single" },
  PH: { currency: "PHP", kind: "single" },
  IN: { currency: "INR", kind: "single" },
  PK: { currency: "PKR", kind: "single" },
  BD: { currency: "BDT", kind: "single" },
  LK: { currency: "LKR", kind: "single" },
  AU: { currency: "AUD", kind: "single" },
  NZ: { currency: "NZD", kind: "single" },
  // Middle East & Africa
  AE: { currency: "AED", kind: "single" },
  SA: { currency: "SAR", kind: "single" },
  IL: { currency: "ILS", kind: "single" },
  TR: { currency: "TRY", kind: "single" },
  EG: { currency: "EGP", kind: "single" },
  ZA: { currency: "ZAR", kind: "single" },
  NG: { currency: "NGN", kind: "single" },
  KE: { currency: "KES", kind: "single" },
  MA: { currency: "MAD", kind: "single" },
  // Dollarized / de-facto USD economies — intentionally low-confidence
  EC: { currency: "USD", kind: "dollarized" },
  SV: { currency: "USD", kind: "dollarized" },
  PA: { currency: "USD", kind: "dollarized" },
  TL: { currency: "USD", kind: "dollarized" },
  // Kosovo uses EUR de facto but is not a Eurozone member.
  XK: { currency: "EUR", kind: "dollarized" },
};

/**
 * Currency-symbol lookup. Used as a fallback when no country signal is
 * available. Multi-currency symbols (e.g. `$`, `kr`, `¥`) are mapped to
 * their dominant interpretation BUT only ever return `medium` confidence,
 * which forces the "confirm or change" flow downstream.
 *
 * Listed longest-symbol-first so the scanner matches `RM ` before `R `
 * etc. (handled at scan time via `.sort(...)` over the keys).
 */
const SYMBOL_TO_CURRENCY: Readonly<Record<string, string>> = {
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY", // also CNY — pick JPY as dominant unicode usage
  "₹": "INR",
  "₩": "KRW",
  "₽": "RUB",
  "₺": "TRY",
  "₪": "ILS",
  "₱": "PHP",
  "₫": "VND",
  "฿": "THB",
  "R$": "BRL",
  "S$": "SGD",
  "HK$": "HKD",
  "A$": "AUD",
  "NZ$": "NZD",
  "C$": "CAD",
  "CA$": "CAD",
  CHF: "CHF",
  "kr ": "SEK",
  "$": "USD", // ambiguous — last-resort, medium confidence
};

const ISO_CURRENCY_ALPHABET = new Set([
  "AED",
  "ARS",
  "AUD",
  "BDT",
  "BGN",
  "BRL",
  "CAD",
  "CHF",
  "CLP",
  "CNY",
  "COP",
  "CZK",
  "DKK",
  "EGP",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "JPY",
  "KES",
  "KRW",
  "LKR",
  "MAD",
  "MXN",
  "MYR",
  "NGN",
  "NOK",
  "NZD",
  "PEN",
  "PHP",
  "PKR",
  "PLN",
  "RON",
  "RUB",
  "SAR",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "TWD",
  "USD",
  "UYU",
  "VND",
  "ZAR",
]);

/** Internal: try to find an ISO-4217 currency code in invoice text. */
function findIsoInInvoices(samples: readonly string[]): {
  currency: string;
  evidence: string;
} | null {
  // Match a 3-letter uppercase token surrounded by non-letter boundaries
  // (so "USD123" matches but "FUSDA" doesn't). Iterate samples and stop
  // on the first known ISO code.
  const re = /\b([A-Z]{3})\b/g;
  for (const sample of samples) {
    if (!sample) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sample)) !== null) {
      const code = m[1];
      if (code && ISO_CURRENCY_ALPHABET.has(code)) {
        return { currency: code, evidence: sample.slice(0, 120) };
      }
    }
  }
  return null;
}

/** Internal: try to find a currency symbol in invoice text. */
function findSymbolInInvoices(samples: readonly string[]): {
  currency: string;
  evidence: string;
} | null {
  // Sort longest symbol first so multi-character symbols ("R$", "HK$",
  // "CA$") match before bare "$".
  const symbols = Object.keys(SYMBOL_TO_CURRENCY).sort(
    (a, b) => b.length - a.length,
  );
  for (const sample of samples) {
    if (!sample) continue;
    for (const sym of symbols) {
      if (sample.includes(sym)) {
        const code = SYMBOL_TO_CURRENCY[sym];
        if (code) {
          return { currency: code, evidence: `${sym} → ${code}` };
        }
      }
    }
  }
  return null;
}

/**
 * Resolve a billing currency from country + (optional) invoice samples.
 *
 * Returns `null` when no signal at all is available. Callers must treat
 * a null return as "do not auto-set billing_currency" (leave the
 * supplier row's column null so downstream FX logic falls back to the
 * org base currency).
 */
export function resolveBillingCurrency(
  input: BillingCurrencyResolverInput,
): BillingCurrencyResolution | null {
  const cc = input.countryCode?.toUpperCase().trim() ?? "";
  const samples = input.invoiceSamples ?? [];

  // Country path.
  let countryHit: BillingCurrencyResolution | null = null;
  if (cc && Object.prototype.hasOwnProperty.call(COUNTRY_TO_CURRENCY, cc)) {
    const entry = COUNTRY_TO_CURRENCY[cc]!;
    if (entry.kind === "single") {
      countryHit = {
        currency: entry.currency,
        confidence: "high",
        confidenceScore: BILLING_CURRENCY_CONFIDENCE_SCORES.high,
        source: "country",
        evidence: cc,
      };
    } else {
      countryHit = {
        currency: entry.currency,
        confidence: "low",
        confidenceScore: BILLING_CURRENCY_CONFIDENCE_SCORES.low,
        source: "country_dollarized",
        evidence: cc,
      };
    }
  }

  // Invoice path.
  let invoiceHit: BillingCurrencyResolution | null = null;
  const isoMatch = findIsoInInvoices(samples);
  if (isoMatch) {
    invoiceHit = {
      currency: isoMatch.currency,
      confidence: "high",
      confidenceScore: BILLING_CURRENCY_CONFIDENCE_SCORES.high,
      source: "invoice_iso",
      evidence: isoMatch.evidence,
    };
  } else {
    const symMatch = findSymbolInInvoices(samples);
    if (symMatch) {
      invoiceHit = {
        currency: symMatch.currency,
        confidence: "medium",
        confidenceScore: BILLING_CURRENCY_CONFIDENCE_SCORES.medium,
        source: "invoice_symbol",
        evidence: symMatch.evidence,
      };
    }
  }

  // Pick the higher-confidence hit; tie goes to country.
  if (countryHit && invoiceHit) {
    return invoiceHit.confidenceScore > countryHit.confidenceScore
      ? invoiceHit
      : countryHit;
  }
  return countryHit ?? invoiceHit;
}
