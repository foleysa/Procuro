/**
 * #68 — Opportunity detail CpiPushbackBlock render contract.
 *
 * The contract_renegotiation_trigger lever persists a `cpiPushback`
 * object on `inputs` (see `artifacts/api-server/src/lib/levers/cpi-pushback.ts`).
 * The Command Center detail page lifts that block out and renders a
 * dedicated card with the CPI move, supplier ask, spread, lookback,
 * verdict, and a one-line summary, plus an inline disclosure-tier
 * citation when the lever attached a source descriptor.
 *
 * Pinning the renderer here keeps the disclosure-tier provenance
 * visible alongside the numbers — a regression that quietly drops the
 * source citation would otherwise only be caught by an integration
 * test against the live BLS data.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { CpiPushbackBlock } from "../src/pages/opportunity-detail";
import {
  LeverId,
  OpportunityStatus,
  type InsightSource,
  type OpportunityDetail,
} from "@workspace/api-client-react";

afterEach(() => {
  cleanup();
});

const T1_BLS_SOURCE: InsightSource = {
  collectorId: "bls-cpi",
  collectorName: "BLS — Consumer Price Index",
  sourceUrl: "https://data.bls.gov/timeseries/CUUR0000SA0E",
  observedAt: "2026-04-30T00:00:00.000Z",
  contract: {
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "US",
    retentionDays: 365,
    tenantOptInDefault: true,
  },
};

function makeOpp(
  cpiPushback: Record<string, unknown> | null,
): OpportunityDetail {
  return {
    id: "opp_cpi_1",
    orgId: "org_1",
    cycleId: "cycle_1",
    leverId: LeverId.contract_renegotiation_trigger,
    tier: 2,
    status: OpportunityStatus.proposed,
    title: "Renegotiate MSA-001 with Acme",
    rationale: "rationale text",
    recommendedAction: "do the thing",
    rawProjectedSavingsUsd: 5000,
    projectedSavingsUsd: 5000,
    confidence: 0.7,
    createdAt: "2026-04-30T00:00:00.000Z",
    sources: [],
    inputs: cpiPushback === null ? {} : { cpiPushback },
  } as OpportunityDetail;
}

describe("<CpiPushbackBlock />", () => {
  test("renders the block with KPIs, verdict, summary, and the BLS citation", () => {
    const opp = makeOpp({
      cpiScopeCode: "ENERGY",
      cpiMovePct: 4,
      supplierAskPct: 30,
      spreadPct: 26,
      verdict: "pushback",
      summary:
        "BLS ENERGY CPI moved +4.0% over the last 365 days; supplier ask of +30.0% runs +26.0% above CPI.",
      lookbackDays: 365,
      source: T1_BLS_SOURCE,
    });

    render(<CpiPushbackBlock opp={opp} policy="standard" />);

    const card = screen.getByTestId("card-cpi-pushback");
    expect(card).toBeTruthy();
    expect(screen.getByTestId("text-cpi-scope-code").textContent).toBe(
      "ENERGY",
    );

    const verdict = screen.getByTestId("text-cpi-verdict");
    expect(verdict.getAttribute("data-verdict")).toBe("pushback");
    expect(verdict.textContent).toMatch(/pushback defensible/i);

    expect(screen.getByTestId("text-cpi-summary").textContent).toMatch(
      /BLS ENERGY CPI moved/i,
    );

    // KPIs (signed percentages + lookback days).
    expect(screen.getByText("+4.0%")).toBeTruthy();
    expect(screen.getByText("+30.0%")).toBeTruthy();
    expect(screen.getByText("+26.0%")).toBeTruthy();
    expect(screen.getByText("365d")).toBeTruthy();

    // Inline disclosure-tier citation rendered for the BLS source.
    // `<InsightCitations>` exposes `insight-citations-card` for its
    // card variant — pin that contract here so the source attribution
    // can never silently disappear under the CPI numbers.
    expect(screen.getByTestId("insight-citations-card")).toBeTruthy();
  });

  test("renders cpi_decline as the strong-pushback verdict", () => {
    const opp = makeOpp({
      cpiScopeCode: "FOOD",
      cpiMovePct: -1.5,
      supplierAskPct: 6,
      spreadPct: 7.5,
      verdict: "cpi_decline",
      summary: "CPI fell while supplier asked for an increase.",
      lookbackDays: 365,
      source: null,
    });

    render(<CpiPushbackBlock opp={opp} policy="standard" />);

    const verdict = screen.getByTestId("text-cpi-verdict");
    expect(verdict.getAttribute("data-verdict")).toBe("cpi_decline");
    expect(verdict.textContent).toMatch(/strong pushback/i);

    // Negative CPI move formatted with leading '-' (no double sign).
    expect(screen.getByText("-1.5%")).toBeTruthy();
  });

  test("renders nothing when inputs.cpiPushback is missing", () => {
    const opp = makeOpp(null);
    const { container } = render(
      <CpiPushbackBlock opp={opp} policy="standard" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("card-cpi-pushback")).toBeNull();
  });

  test("renders nothing when inputs.cpiPushback has the wrong shape", () => {
    // Garbage-in must NOT throw — the type guard should drop it.
    const opp = makeOpp({ cpiScopeCode: "ENERGY" }); // missing fields
    const { container } = render(
      <CpiPushbackBlock opp={opp} policy="standard" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
