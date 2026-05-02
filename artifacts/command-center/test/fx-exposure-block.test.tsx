/**
 * #54 — Opportunity detail FxExposureBlock render contract.
 *
 * The supplier_fx_exposure lever persists a structured `inputs`
 * object capturing the FX pair, % move, normalized cost change,
 * supplier identity, base/billing currencies, 12-month spend, and
 * affected contract numbers (see
 * `artifacts/api-server/src/lib/levers/fx-exposure.ts`). The
 * Command Center detail page lifts that JSON out and renders a
 * "Why this fired" panel so a buyer can scan the underlying
 * numbers without clicking back to raw data.
 *
 * Pinning the renderer here protects two things:
 *  - the input shape contract between server and client, and
 *  - the graceful fallback when `inputs` is empty or shaped
 *    differently (e.g. a non-FX lever's opportunity).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { FxExposureBlock } from "../src/pages/opportunity-detail";
import {
  LeverId,
  OpportunityStatus,
  type InsightSource,
  type OpportunityDetail,
} from "@workspace/api-client-react";

afterEach(() => {
  cleanup();
});

const T1_ECB_SOURCE: InsightSource = {
  collectorId: "ecb-fx",
  collectorName: "ECB — Daily reference rates",
  sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref",
  observedAt: "2026-04-30T00:00:00.000Z",
  contract: {
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "EU",
    retentionDays: 365,
    tenantOptInDefault: true,
  },
};

function makeOpp(
  inputs: Record<string, unknown> | null,
  sources: InsightSource[] = [],
): OpportunityDetail {
  return {
    id: "opp_fx_1",
    orgId: "org_1",
    cycleId: "cycle_1",
    leverId: LeverId.supplier_fx_exposure,
    tier: 4,
    status: OpportunityStatus.proposed,
    title: "FX exposure: Acme GmbH (EUR) — +3.21% in USD cost vs EUR/USD",
    rationale: "rationale text",
    recommendedAction: "do the thing",
    rawProjectedSavingsUsd: 5000,
    projectedSavingsUsd: 5000,
    confidence: 0.7,
    createdAt: "2026-04-30T00:00:00.000Z",
    sources,
    inputs: inputs === null ? {} : inputs,
  } as OpportunityDetail;
}

function renderBlock(opp: OpportunityDetail) {
  // Wouter's <Link> requires a Router context for the supplier
  // cross-link; memoryLocation isolates the test from the JSDOM URL.
  const { hook } = memoryLocation({ path: "/opportunities/opp_fx_1" });
  return render(
    <Router hook={hook}>
      <FxExposureBlock opp={opp} policy="standard" />
    </Router>,
  );
}

describe("<FxExposureBlock />", () => {
  test("renders pair, signed cost change, lookback, spend, supplier link, currencies, and contracts for an adverse move", () => {
    const opp = makeOpp(
      {
        supplierId: "sup_acme",
        supplierName: "Acme GmbH",
        baseCurrency: "USD",
        billingCurrency: "EUR",
        fxPair: "EUR/USD",
        fxOrientation: "billing/base",
        earliestValue: 1.05,
        latestValue: 1.0837,
        earliestObservedAt: "2026-04-01T00:00:00.000Z",
        latestObservedAt: "2026-04-30T00:00:00.000Z",
        observationCount: 22,
        movePct: 3.21,
        costChangePct: 3.21,
        absCostChangePct: 3.21,
        adverse: true,
        lookbackDays: 30,
        thresholdPct: 3,
        spend12moUsd: 1_250_000,
        contractNumbers: ["MSA-001", "SOW-014"],
      },
      [T1_ECB_SOURCE],
    );

    renderBlock(opp);

    const card = screen.getByTestId("card-fx-exposure");
    expect(card).toBeTruthy();
    expect(screen.getByTestId("text-fx-pair").textContent).toBe("EUR/USD");

    // KPIs: signed pair move + signed cost change both render +3.21%
    // (pair move and normalized cost change happen to be equal here).
    expect(screen.getAllByText("+3.21%").length).toBe(2);
    expect(screen.getByText("30d")).toBeTruthy();
    // formatUsd(..., {compact: true}) renders "$1.3M" for 1.25M.
    expect(screen.getByText(/\$1\.3M/)).toBeTruthy();

    // Direction line spells out adverse + base/billing relationship.
    const direction = screen.getByTestId("text-fx-direction");
    expect(direction.getAttribute("data-adverse")).toBe("true");
    expect(direction.textContent).toMatch(/Adverse move/i);
    expect(direction.textContent).toMatch(/EUR unit now costs 3\.21% more in USD/i);

    // Currencies summary line.
    expect(screen.getByTestId("text-fx-currencies").textContent).toBe(
      "Bills in EUR · reports in USD",
    );

    // Supplier rendered as a link to /suppliers/:id when supplierId is present.
    const supplierLink = screen.getByTestId("link-fx-supplier");
    expect(supplierLink.tagName.toLowerCase()).toBe("a");
    expect(supplierLink.getAttribute("href")).toBe("/suppliers/sup_acme");
    expect(supplierLink.textContent).toBe("Acme GmbH");

    // Contract chips.
    const contracts = screen.getByTestId("list-fx-contracts");
    expect(contracts.textContent).toMatch(/MSA-001/);
    expect(contracts.textContent).toMatch(/SOW-014/);

    // Inline disclosure-tier citation rendered for the ECB source.
    expect(screen.getByTestId("insight-citations-card")).toBeTruthy();
  });

  test("renders favorable tone and the empty-contracts fallback", () => {
    const opp = makeOpp({
      supplierName: "Yamato KK",
      baseCurrency: "USD",
      billingCurrency: "JPY",
      fxPair: "JPY/USD",
      fxOrientation: "billing/base",
      earliestValue: 0.0067,
      latestValue: 0.00663,
      earliestObservedAt: "2026-04-01T00:00:00.000Z",
      latestObservedAt: "2026-04-30T00:00:00.000Z",
      observationCount: 22,
      movePct: -1.05,
      costChangePct: -1.05,
      absCostChangePct: 1.05,
      adverse: false,
      lookbackDays: 30,
      thresholdPct: 1,
      spend12moUsd: 250_000,
      contractNumbers: [],
    });

    renderBlock(opp);

    const direction = screen.getByTestId("text-fx-direction");
    expect(direction.getAttribute("data-adverse")).toBe("false");
    expect(direction.textContent).toMatch(/Favorable move/i);
    expect(direction.textContent).toMatch(/JPY unit now costs 1\.05% less in USD/i);

    // No contracts → empty-state copy, no list.
    expect(screen.getByTestId("text-fx-contracts-empty")).toBeTruthy();
    expect(screen.queryByTestId("list-fx-contracts")).toBeNull();

    // Supplier without supplierId renders as plain text, not a link.
    expect(screen.queryByTestId("link-fx-supplier")).toBeNull();
    expect(screen.getByTestId("text-fx-supplier").textContent).toBe("Yamato KK");
  });

  test("renders nothing when inputs is empty", () => {
    const opp = makeOpp(null);
    const { container } = renderBlock(opp);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("card-fx-exposure")).toBeNull();
  });

  test("renders nothing when inputs has a different shape", () => {
    // Garbage-in must NOT throw — the type guard should drop it.
    const opp = makeOpp({ cpiPushback: { foo: "bar" } });
    const { container } = renderBlock(opp);
    expect(container).toBeEmptyDOMElement();
  });
});
