/**
 * Locks down `renderSupplierIntelligenceHeadline` — the per-row title /
 * sub-headline rendering used by the `GET /suppliers/:id/intelligence`
 * read path. Regressions here would be invisible to the API integration
 * suite: a row with malformed metadata would silently render an empty
 * headline in the Risk & Filings UI rather than failing loudly.
 *
 * Each Phase-2 supplier-intelligence signal type owns a branch in the
 * renderer; we cover one nominal case per branch plus a few edge cases
 * (unknown numeric codes, empty arrays, missing metadata fields) and
 * the catch-all default that protects against future enum widening.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  renderSupplierIntelligenceHeadline,
  type SupplierIntelligenceRowInput,
} from "../src/lib/supplier-intelligence";

function row(
  overrides: Partial<SupplierIntelligenceRowInput>,
): SupplierIntelligenceRowInput {
  return {
    signalType: "sanctions_match",
    collectorId: "government-sanctions",
    collectorName: "Government Sanctions",
    value: 1,
    unit: "match",
    scopeSupplierName: null,
    scopeCategoryCode: null,
    scopeSku: null,
    scopeLaneKey: null,
    metadata: {},
    ...overrides,
  };
}

test("sanctions_match: maps numeric list code to label and concatenates program/country", () => {
  const r = renderSupplierIntelligenceHeadline(
    row({
      value: 2,
      metadata: { program: "RUSSIA-EO14024", country: "RU" },
    }),
  );
  assert.equal(r.headline, "Sanctions match — EU consolidated");
  assert.equal(r.detail, "RUSSIA-EO14024 · RU");
});

test("sanctions_match: unknown list code falls back to the row unit", () => {
  const r = renderSupplierIntelligenceHeadline(
    row({ value: 99, unit: "match", metadata: {} }),
  );
  assert.equal(r.headline, "Sanctions match — match");
  assert.equal(r.detail, null);
});

test("risk_screening_match: joins datasets and topics from metadata arrays", () => {
  const r = renderSupplierIntelligenceHeadline(
    row({
      signalType: "risk_screening_match",
      collectorId: "opensanctions",
      collectorName: "OpenSanctions",
      metadata: {
        datasets: ["sanctions", "peps"],
        topics: ["sanction"],
      },
    }),
  );
  assert.equal(r.headline, "Risk-screening match (OpenSanctions)");
  assert.equal(r.detail, "sanctions, peps — sanction");
});

test("risk_screening_match: empty arrays fall through to entity name", () => {
  const r = renderSupplierIntelligenceHeadline(
    row({
      signalType: "risk_screening_match",
      collectorId: "opensanctions",
      collectorName: "OpenSanctions",
      metadata: { datasets: [], topics: [], name: "Acme Holdings Ltd" },
    }),
  );
  assert.equal(r.detail, "Acme Holdings Ltd");
});

test("corporate_filing: Companies House uses category-code label", () => {
  const r = renderSupplierIntelligenceHeadline(
    row({
      signalType: "corporate_filing",
      collectorId: "companies-house",
      collectorName: "Companies House",
      value: 1,
      metadata: { description: "Annual accounts (small)" },
    }),
  );
  assert.equal(r.headline, "Companies House filing — Accounts");
  assert.equal(r.detail, "Annual accounts (small)");
});

test("corporate_filing: SEC EDGAR uses formCode and accession number", () => {
  const r = renderSupplierIntelligenceHeadline(
    row({
      signalType: "corporate_filing",
      collectorId: "sec-edgar",
      collectorName: "SEC EDGAR",
      value: 0,
      scopeSku: "10-K",
      metadata: { formCode: "10-K", accessionNumber: "0000320193-25-000001" },
    }),
  );
  assert.equal(r.headline, "SEC filing — 10-K");
  assert.equal(r.detail, "0000320193-25-000001");
});

test("entity_registry: maps GLEIF status code and surfaces LEI", () => {
  const r = renderSupplierIntelligenceHeadline(
    row({
      signalType: "entity_registry",
      collectorId: "gleif-lei",
      collectorName: "GLEIF",
      value: 1,
      scopeSku: "5493001KJTIIGC8Y1R12",
      metadata: {},
    }),
  );
  assert.equal(r.headline, "LEI registry — Issued");
  assert.equal(r.detail, "5493001KJTIIGC8Y1R12");
});

test("facility_emissions: formats tonnes and year", () => {
  const r = renderSupplierIntelligenceHeadline(
    row({
      signalType: "facility_emissions",
      collectorId: "climate-trace",
      collectorName: "ClimateTRACE",
      value: 1234567,
      scopeCategoryCode: "cement",
      metadata: { year: "2024" },
    }),
  );
  assert.equal(r.headline, "Facility emissions — cement");
  assert.equal(r.detail, "1,234,567 t CO2e · 2024");
});

test("natural_hazard: maps source code and surfaces place from metadata", () => {
  const r = renderSupplierIntelligenceHeadline(
    row({
      signalType: "natural_hazard",
      collectorId: "natural-hazards",
      collectorName: "Natural Hazards",
      value: 1,
      metadata: { place: "10km NE of Ridgecrest, CA" },
    }),
  );
  assert.equal(r.headline, "USGS earthquake");
  assert.equal(r.detail, "10km NE of Ridgecrest, CA");
});

test("event_geocoded: surfaces event code and country", () => {
  const r = renderSupplierIntelligenceHeadline(
    row({
      signalType: "event_geocoded",
      collectorId: "gdelt-events",
      collectorName: "GDELT Events",
      value: 0,
      scopeLaneKey: "DE",
      metadata: { eventCode: "0233" },
    }),
  );
  assert.equal(r.headline, "Geocoded event — 0233");
  assert.equal(r.detail, "DE");
});

test("missing metadata never produces an empty headline", () => {
  for (const t of [
    "sanctions_match",
    "risk_screening_match",
    "corporate_filing",
    "entity_registry",
    "facility_emissions",
    "natural_hazard",
    "event_geocoded",
  ] as const) {
    const r = renderSupplierIntelligenceHeadline(row({ signalType: t, metadata: null }));
    assert.ok(
      r.headline.length > 0,
      `headline should be non-empty for ${t}, got "${r.headline}"`,
    );
  }
});
