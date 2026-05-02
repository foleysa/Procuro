/**
 * #63 — Opportunity detail MarketSignalBlock render contract.
 *
 * The spot_vs_contract Tier-2 lever persists a structured
 * `inputs.marketSignal` object capturing the FRED PPI series id,
 * label, observed value, observation date, source URL and the
 * collector that produced it (see
 * `artifacts/api-server/src/lib/levers/tier2.ts`). The Command
 * Center detail page lifts that JSON out and renders a "Public PPI
 * benchmark" panel so a buyer can defend the renegotiation in a
 * meeting without opening raw JSON.
 *
 * Pinning the renderer here protects two things:
 *  - the input shape contract between the lever and the UI, and
 *  - the graceful fallback when `inputs.marketSignal` is missing or
 *    shaped differently (e.g. a non-PPI lever's opportunity).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { MarketSignalBlock } from "../src/pages/opportunity-detail";
import {
  LeverId,
  OpportunityStatus,
  type InsightSource,
  type OpportunityDetail,
} from "@workspace/api-client-react";

afterEach(() => {
  cleanup();
});

const T1_FRED_SOURCE: InsightSource = {
  collectorId: "fred-ppi",
  collectorName: "FRED — Producer Price Index",
  sourceUrl: "https://fred.stlouisfed.org/series/PCU484121484121",
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
  inputs: Record<string, unknown> | null,
  sources: InsightSource[] = [],
): OpportunityDetail {
  return {
    id: "opp_ppi_1",
    orgId: "org_1",
    cycleId: "cycle_1",
    leverId: LeverId.spot_vs_contract,
    tier: 2,
    status: OpportunityStatus.proposed,
    title: "Renegotiate FRT-001 (Trucking) using public PPI as spot benchmark",
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

describe("<MarketSignalBlock />", () => {
  test("renders scope, value, observation date, series label and 'view on FRED' link", () => {
    const opp = makeOpp(
      {
        contractId: "ctr_1",
        actual12moUsd: 250_000,
        marketSignal: {
          id: "ms_1",
          collectorId: "fred-ppi",
          scopeCategoryCode: "FREIGHT_TRUCKING_TL",
          value: 142.37,
          unit: "Index 1982=100",
          observedAt: "2026-04-15T00:00:00.000Z",
          sourceUrl: "https://fred.stlouisfed.org/series/PCU484121484121",
          fredSeries: [
            {
              seriesId: "PCU484121484121",
              label: "PPI: General Freight Trucking, Long-Distance Truckload",
            },
          ],
        },
      },
      [T1_FRED_SOURCE],
    );

    render(<MarketSignalBlock opp={opp} policy="standard" />);

    expect(screen.getByTestId("card-market-signal")).toBeTruthy();
    expect(screen.getByTestId("text-market-signal-scope").textContent).toBe(
      "FREIGHT_TRUCKING_TL",
    );

    // Index value KPI is the unrounded numeric formatted to 2 decimals.
    expect(screen.getByText("142.37")).toBeTruthy();
    // Observation date is the date portion of the ISO timestamp.
    expect(screen.getByText("2026-04-15")).toBeTruthy();
    expect(screen.getByText("Index 1982=100")).toBeTruthy();

    // Series row shows the label + series id of the primary series.
    expect(
      screen.getByTestId("text-market-signal-series").textContent,
    ).toMatch(
      /PPI: General Freight Trucking, Long-Distance Truckload \(PCU484121484121\)/,
    );

    // "View on FRED" external link with the per-signal source URL.
    const link = screen.getByTestId("link-market-signal-source");
    expect(link.tagName.toLowerCase()).toBe("a");
    expect(link.getAttribute("href")).toBe(
      "https://fred.stlouisfed.org/series/PCU484121484121",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);

    // Inline disclosure-tier citation rendered for the matching FRED source.
    expect(screen.getByTestId("insight-citations-card")).toBeTruthy();
  });

  test("falls back to scopeCategoryCode when no fredSeries are provided and omits the link when sourceUrl is missing", () => {
    const opp = makeOpp({
      marketSignal: {
        scopeCategoryCode: "RAIL_FREIGHT",
        value: 198.4,
        observedAt: "2026-03-01T00:00:00.000Z",
      },
    });

    render(<MarketSignalBlock opp={opp} policy="standard" />);

    // No fredSeries → series row falls back to the canonical scope code.
    expect(
      screen.getByTestId("text-market-signal-series").textContent,
    ).toBe("RAIL_FREIGHT");
    // No additional series chips list either.
    expect(screen.queryByTestId("list-market-signal-series")).toBeNull();
    // No source URL → no external link.
    expect(screen.queryByTestId("link-market-signal-source")).toBeNull();
    // Missing unit collapses to em-dash.
    expect(screen.getByText("—")).toBeTruthy();
  });

  test("renders additional series as secondary chips when fredSeries has more than one entry", () => {
    const opp = makeOpp({
      marketSignal: {
        scopeCategoryCode: "FREIGHT_TRUCKING_TL",
        value: 100,
        observedAt: "2026-04-01T00:00:00.000Z",
        sourceUrl: "https://fred.stlouisfed.org/series/A",
        fredSeries: [
          { seriesId: "AAA", label: "Series A" },
          { seriesId: "BBB", label: "Series B" },
          { seriesId: "CCC", label: "Series C" },
        ],
      },
    });

    render(<MarketSignalBlock opp={opp} policy="standard" />);

    expect(
      screen.getByTestId("text-market-signal-series").textContent,
    ).toMatch(/Series A \(AAA\)/);
    const extras = screen.getByTestId("list-market-signal-series");
    expect(extras.textContent).toMatch(/Series B \(BBB\)/);
    expect(extras.textContent).toMatch(/Series C \(CCC\)/);
  });

  test("renders nothing when inputs is empty", () => {
    const opp = makeOpp(null);
    const { container } = render(
      <MarketSignalBlock opp={opp} policy="standard" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("renders nothing when inputs.marketSignal is missing required fields", () => {
    // Garbage-in must NOT throw — the type guard should drop it.
    const opp = makeOpp({
      marketSignal: { scopeCategoryCode: "FOO" /* missing value, observedAt */ },
    });
    const { container } = render(
      <MarketSignalBlock opp={opp} policy="standard" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
