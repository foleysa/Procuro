/**
 * #54 — FX exposure card surfaces supplier billing currency + direction.
 *
 * The opportunities feed renders one `<OppRow>` per opportunity. For
 * `supplier_fx_exposure` rows the row is expected to:
 *
 *   1. Parse the ISO 4217 billing currency code from the title (the
 *      title format is locked server-side in
 *      `artifacts/api-server/src/lib/levers/fx-exposure.ts`) and
 *      surface it as a prominent chip.
 *   2. Render an "Adverse" badge (cost goes up — `+X.XX%` after the
 *      em-dash) or a "Favorable" badge (cost goes down — `-X.XX%`).
 *   3. Leave non-FX rows untouched (no chip, no direction badge), so
 *      we don't accidentally surface garbage on every other lever.
 *
 * Pinning the parser separately from the render keeps the regression
 * surface honest: if either the title format on the server changes, or
 * the badge wiring on the client changes, exactly one test fails.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import {
  OppRow,
  parseFxBillingCurrency,
  isFxAdverseFromTitle,
} from "../src/pages/opportunities";
import {
  LeverId,
  OpportunityStatus,
  type Opportunity,
} from "@workspace/api-client-react";

afterEach(() => {
  cleanup();
});

function makeOpp(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "opp_test_1",
    orgId: "org_1",
    cycleId: "cycle_1",
    leverId: LeverId.supplier_fx_exposure,
    tier: 1,
    status: OpportunityStatus.proposed,
    title:
      "FX exposure: Acme GmbH (EUR) — +3.21% in USD cost vs EUR/USD",
    rationale: "rationale",
    recommendedAction: "do the thing",
    supplierName: "Acme GmbH",
    rawProjectedSavingsUsd: 12345,
    projectedSavingsUsd: 12345,
    confidence: 0.7,
    createdAt: "2026-01-15T00:00:00.000Z",
    ...overrides,
  };
}

function renderRow(opp: Opportunity) {
  // Wouter's <Link> requires a Router context; memoryLocation keeps the
  // test isolated from the JSDOM URL.
  const { hook } = memoryLocation({ path: "/opportunities" });
  return render(
    <Router hook={hook}>
      <OppRow opp={opp} />
    </Router>,
  );
}

describe("parseFxBillingCurrency", () => {
  test("extracts the first (XXX) group from the canonical title", () => {
    expect(
      parseFxBillingCurrency(
        "FX exposure: Acme GmbH (EUR) — +3.21% in USD cost vs EUR/USD",
      ),
    ).toBe("EUR");
    expect(
      parseFxBillingCurrency(
        "FX exposure: Yamato KK (JPY) — -1.05% in USD cost vs JPY/USD",
      ),
    ).toBe("JPY");
  });

  test("returns null when the title has no currency code", () => {
    expect(parseFxBillingCurrency("Renegotiate MSA-001 with Foo")).toBeNull();
    expect(parseFxBillingCurrency("FX exposure: Acme — broken title")).toBeNull();
  });
});

describe("isFxAdverseFromTitle", () => {
  test("treats a leading + after the em-dash as adverse", () => {
    expect(
      isFxAdverseFromTitle(
        "FX exposure: Acme (EUR) — +3.21% in USD cost vs EUR/USD",
      ),
    ).toBe(true);
  });
  test("treats a leading - after the em-dash as favorable", () => {
    expect(
      isFxAdverseFromTitle(
        "FX exposure: Acme (EUR) — -3.21% in USD cost vs EUR/USD",
      ),
    ).toBe(false);
  });
  test("returns false on malformed titles", () => {
    expect(isFxAdverseFromTitle("Renegotiate MSA-001")).toBe(false);
  });
});

describe("<OppRow> for supplier_fx_exposure", () => {
  test("renders billing currency chip and adverse badge", () => {
    const opp = makeOpp();
    renderRow(opp);

    const currency = screen.getByTestId(`fx-currency-${opp.id}`);
    expect(currency.textContent).toBe("EUR");

    const direction = screen.getByTestId(`fx-direction-${opp.id}`);
    expect(direction.textContent).toBe("Adverse");
    // shadcn maps `destructive` variant → bg-destructive on the badge.
    expect(direction.className).toMatch(/destructive/);

    // Supplier name still rendered alongside the chips (also appears in
    // the title so we expect at least one match).
    expect(screen.getAllByText(/Acme GmbH/).length).toBeGreaterThan(0);
  });

  test("renders favorable badge when the cost change is negative", () => {
    const opp = makeOpp({
      title:
        "FX exposure: Yamato KK (JPY) — -1.05% in USD cost vs JPY/USD",
      supplierName: "Yamato KK",
    });
    renderRow(opp);

    expect(screen.getByTestId(`fx-currency-${opp.id}`).textContent).toBe(
      "JPY",
    );
    const direction = screen.getByTestId(`fx-direction-${opp.id}`);
    expect(direction.textContent).toBe("Favorable");
    expect(direction.className).not.toMatch(/destructive/);
  });

  test("renders no FX chip on non-FX levers", () => {
    const opp = makeOpp({
      leverId: LeverId.contract_renegotiation_trigger,
      title: "Renegotiate MSA-001 with Foo (expiring <90d)",
      supplierName: "Foo Industries",
    });
    renderRow(opp);

    expect(screen.queryByTestId(`fx-currency-${opp.id}`)).toBeNull();
    expect(screen.queryByTestId(`fx-direction-${opp.id}`)).toBeNull();
    expect(screen.getByText(/Foo Industries/)).toBeTruthy();
  });

  test("falls back gracefully when the FX title has no currency code", () => {
    const opp = makeOpp({
      title: "FX exposure: corrupted title with no currency",
    });
    renderRow(opp);
    // Defensive: no chip, no badge, but the row still renders.
    expect(screen.queryByTestId(`fx-currency-${opp.id}`)).toBeNull();
    expect(screen.queryByTestId(`fx-direction-${opp.id}`)).toBeNull();
    // Supplier name fallback still renders.
    expect(screen.getAllByText(/Acme GmbH/).length).toBeGreaterThan(0);
  });
});
