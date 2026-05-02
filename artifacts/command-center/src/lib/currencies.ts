/**
 * Sensible default ISO-4217 currency list for billing-currency pickers.
 *
 * The set is deliberately small (the most common billing currencies our
 * tenants actually see) so the dropdown doesn't become a thousand-line
 * scroll target. The PATCH / override endpoints both accept any
 * 3-letter ISO code, so callers should still allow an "Other…" escape
 * hatch (a raw text input) for the long tail.
 */
export interface Currency {
  /** 3-letter ISO 4217 code (uppercase). */
  code: string;
  /** Human-readable label rendered in the dropdown. */
  label: string;
}

export const COMMON_CURRENCIES: Currency[] = [
  { code: "USD", label: "USD — US Dollar" },
  { code: "EUR", label: "EUR — Euro" },
  { code: "GBP", label: "GBP — British Pound" },
  { code: "JPY", label: "JPY — Japanese Yen" },
  { code: "CHF", label: "CHF — Swiss Franc" },
  { code: "CAD", label: "CAD — Canadian Dollar" },
  { code: "AUD", label: "AUD — Australian Dollar" },
  { code: "CNY", label: "CNY — Chinese Yuan" },
  { code: "HKD", label: "HKD — Hong Kong Dollar" },
  { code: "SGD", label: "SGD — Singapore Dollar" },
  { code: "INR", label: "INR — Indian Rupee" },
  { code: "KRW", label: "KRW — South Korean Won" },
  { code: "TWD", label: "TWD — Taiwan Dollar" },
  { code: "MXN", label: "MXN — Mexican Peso" },
  { code: "BRL", label: "BRL — Brazilian Real" },
  { code: "ARS", label: "ARS — Argentine Peso" },
  { code: "ZAR", label: "ZAR — South African Rand" },
  { code: "AED", label: "AED — UAE Dirham" },
  { code: "SAR", label: "SAR — Saudi Riyal" },
  { code: "ILS", label: "ILS — Israeli New Shekel" },
  { code: "TRY", label: "TRY — Turkish Lira" },
  { code: "SEK", label: "SEK — Swedish Krona" },
  { code: "NOK", label: "NOK — Norwegian Krone" },
  { code: "DKK", label: "DKK — Danish Krone" },
  { code: "PLN", label: "PLN — Polish Zloty" },
  { code: "CZK", label: "CZK — Czech Koruna" },
  { code: "HUF", label: "HUF — Hungarian Forint" },
  { code: "RON", label: "RON — Romanian Leu" },
  { code: "NZD", label: "NZD — New Zealand Dollar" },
  { code: "THB", label: "THB — Thai Baht" },
  { code: "IDR", label: "IDR — Indonesian Rupiah" },
  { code: "MYR", label: "MYR — Malaysian Ringgit" },
  { code: "PHP", label: "PHP — Philippine Peso" },
  { code: "VND", label: "VND — Vietnamese Dong" },
  { code: "COP", label: "COP — Colombian Peso" },
  { code: "CLP", label: "CLP — Chilean Peso" },
  { code: "EGP", label: "EGP — Egyptian Pound" },
  { code: "NGN", label: "NGN — Nigerian Naira" },
];

const COMMON_CODES: Set<string> = new Set(COMMON_CURRENCIES.map((c) => c.code));

/**
 * True when a code is part of the curated dropdown list. Callers use
 * this to decide whether to render the value as a regular Select
 * option or surface the "Other…" text-input branch.
 */
export function isCommonCurrency(code: string | null | undefined): boolean {
  if (!code) return false;
  return COMMON_CODES.has(code.toUpperCase());
}

/**
 * Loose ISO-4217 shape check — three ASCII letters. Mirrors the
 * server-side validator so the FE can short-circuit with a friendly
 * error before round-tripping a 400.
 */
export function isValidCurrencyShape(code: string): boolean {
  return /^[A-Za-z]{3}$/.test(code.trim());
}
