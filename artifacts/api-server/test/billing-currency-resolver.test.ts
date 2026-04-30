/**
 * Pin the deterministic supplier billing-currency resolver.
 *
 * The resolver is run on supplier ingest when no explicit billing
 * currency is provided, so a regression here silently mis-tags every
 * subsequent supplier. Tests cover:
 *
 *   - Single-currency country → high-confidence country hit.
 *   - Eurozone country → high-confidence EUR hit.
 *   - Dollarized / de-facto country → low-confidence hit.
 *   - Unknown country, no invoice samples → null (do not auto-set).
 *   - Invoice with explicit ISO 4217 code → high confidence, beats
 *     low-confidence country hint.
 *   - Invoice with currency symbol → medium confidence.
 *   - Multi-character symbol ("R$") matches before bare "$".
 *   - Country + invoice tie: country wins.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BILLING_CURRENCY_CONFIDENCE_SCORES,
  resolveBillingCurrency,
} from "../src/lib/suppliers/billing-currency-resolver";

describe("resolveBillingCurrency — country path", () => {
  it("returns the single in-use currency for an unambiguous country", () => {
    const r = resolveBillingCurrency({ countryCode: "DE" });
    assert.ok(r);
    assert.equal(r.currency, "EUR");
    assert.equal(r.source, "country");
    assert.equal(r.confidence, "high");
    assert.equal(r.confidenceScore, BILLING_CURRENCY_CONFIDENCE_SCORES.high);
  });

  it("normalizes country code casing/whitespace", () => {
    const r = resolveBillingCurrency({ countryCode: " jp " });
    assert.ok(r);
    assert.equal(r.currency, "JPY");
    assert.equal(r.confidence, "high");
  });

  it("maps eurozone members to EUR with high confidence", () => {
    for (const cc of ["FR", "IT", "ES", "NL", "IE", "PT"]) {
      const r = resolveBillingCurrency({ countryCode: cc });
      assert.ok(r, `expected hit for ${cc}`);
      assert.equal(r.currency, "EUR", `${cc} → EUR`);
      assert.equal(r.confidence, "high");
    }
  });

  it("returns USD with LOW confidence for dollarized economies", () => {
    const r = resolveBillingCurrency({ countryCode: "EC" });
    assert.ok(r);
    assert.equal(r.currency, "USD");
    assert.equal(r.source, "country_dollarized");
    assert.equal(r.confidence, "low");
    assert.equal(r.confidenceScore, BILLING_CURRENCY_CONFIDENCE_SCORES.low);
  });

  it("returns null for an unknown country with no invoices", () => {
    assert.equal(resolveBillingCurrency({ countryCode: "ZZ" }), null);
  });

  it("returns null when no signal at all is supplied", () => {
    assert.equal(resolveBillingCurrency({}), null);
    assert.equal(resolveBillingCurrency({ invoiceSamples: [] }), null);
    assert.equal(
      resolveBillingCurrency({ countryCode: null, invoiceSamples: [] }),
      null,
    );
  });
});

describe("resolveBillingCurrency — invoice ISO path", () => {
  it("matches a 3-letter ISO code with high confidence", () => {
    const r = resolveBillingCurrency({
      invoiceSamples: ["Total due: GBP 1,234.56 (net 30)"],
    });
    assert.ok(r);
    assert.equal(r.currency, "GBP");
    assert.equal(r.source, "invoice_iso");
    assert.equal(r.confidence, "high");
  });

  it("ignores 3-letter tokens that aren't real ISO codes", () => {
    const r = resolveBillingCurrency({
      invoiceSamples: ["Order ABC123 — total 99.00"],
    });
    assert.equal(r, null);
  });

  it("ISO match overrides a low-confidence country hint", () => {
    // EC is dollarized (low). If the invoice says EUR (high), EUR wins.
    const r = resolveBillingCurrency({
      countryCode: "EC",
      invoiceSamples: ["Invoice EUR 500.00"],
    });
    assert.ok(r);
    assert.equal(r.currency, "EUR");
    assert.equal(r.source, "invoice_iso");
  });
});

describe("resolveBillingCurrency — invoice symbol path", () => {
  it("matches a unique symbol with medium confidence", () => {
    const r = resolveBillingCurrency({
      invoiceSamples: ["Total: €1,234.56"],
    });
    assert.ok(r);
    assert.equal(r.currency, "EUR");
    assert.equal(r.source, "invoice_symbol");
    assert.equal(r.confidence, "medium");
    assert.equal(r.confidenceScore, BILLING_CURRENCY_CONFIDENCE_SCORES.medium);
  });

  it("prefers a multi-char symbol (R$) over the bare $ scan", () => {
    const r = resolveBillingCurrency({
      invoiceSamples: ["Fatura: R$ 5.000,00 - vencimento 30 dias"],
    });
    assert.ok(r);
    assert.equal(r.currency, "BRL");
    assert.equal(r.source, "invoice_symbol");
  });

  it("falls back to USD on a bare $ (medium confidence)", () => {
    const r = resolveBillingCurrency({
      invoiceSamples: ["Total: $99.00"],
    });
    assert.ok(r);
    assert.equal(r.currency, "USD");
    assert.equal(r.source, "invoice_symbol");
  });
});

describe("resolveBillingCurrency — combined paths", () => {
  it("on a tie (both high) the country wins", () => {
    // GB → GBP (high) and invoice ISO GBP (high) — both 0.95. Country wins.
    const r = resolveBillingCurrency({
      countryCode: "GB",
      invoiceSamples: ["Bill: GBP 50"],
    });
    assert.ok(r);
    assert.equal(r.currency, "GBP");
    assert.equal(r.source, "country");
  });

  it("invoice symbol does NOT override a high-confidence country", () => {
    // DE → EUR (high) beats invoice "$" → USD (medium).
    const r = resolveBillingCurrency({
      countryCode: "DE",
      invoiceSamples: ["Total: $1,234"],
    });
    assert.ok(r);
    assert.equal(r.currency, "EUR");
    assert.equal(r.source, "country");
  });
});
