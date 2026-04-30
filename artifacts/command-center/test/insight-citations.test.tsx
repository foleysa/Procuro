/**
 * Catches citation regressions in `<InsightCitations>` before they ship.
 *
 * The component wraps `renderInsight()` from `@workspace/intelligence/tier`,
 * which decides — based on the tenant's disclosure policy and each
 * source's tier — what is safe to surface to the user. A regression here
 * is silent: the wrong tier slips through, a T1 link disappears, or a
 * conservative tenant sees attributions they should not. The typecheck
 * cannot catch any of that, so we lock the rendering contract down here.
 *
 * Coverage matrix (mirrors the "Done looks like" in task #105):
 *   - Hidden when there are no visible sources (conservative + only T3).
 *   - T1 source surfaces a clickable link to the source URL.
 *   - T2 source surfaces a generic posture/jurisdiction label, NOT the
 *     source name, and has no outbound link.
 *   - Analyst policy attaches a provenance trail to every citation
 *     (T4 included), exposed via `data-testid` markers.
 *   - Both `card` and `compact` variants render the same citation set.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { InsightCitations } from "../src/components/insight-citations";
import type { InsightSource } from "@workspace/api-client-react";

afterEach(() => {
  cleanup();
});

// ---- fixture builders ----------------------------------------------------

function makeSource(overrides: Partial<InsightSource> = {}): InsightSource {
  return {
    collectorId: "fred",
    collectorName: "FRED — US Federal Reserve Economic Data",
    sourceUrl: "https://fred.stlouisfed.org/series/PPIACO",
    observedAt: "2026-01-15T00:00:00.000Z",
    contract: {
      postureClass: "public_api",
      disclosureTier: "T1",
      jurisdiction: "US",
      retentionDays: 365,
      tenantOptInDefault: true,
    },
    ...overrides,
  };
}

const T1_SOURCE = makeSource({
  collectorId: "fred",
  collectorName: "FRED — US Federal Reserve Economic Data",
  sourceUrl: "https://fred.stlouisfed.org/series/PPIACO",
  contract: {
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "US",
    retentionDays: 365,
    tenantOptInDefault: true,
  },
});

const T2_SOURCE = makeSource({
  collectorId: "ecb-fx",
  collectorName: "European Central Bank reference rates",
  sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
  contract: {
    postureClass: "public_api",
    disclosureTier: "T2",
    jurisdiction: "EU",
    retentionDays: 365,
    tenantOptInDefault: true,
  },
});

const T3_SOURCE = makeSource({
  collectorId: "permitted-crawl-1",
  collectorName: "Tier-3 commodity index",
  sourceUrl: "https://example.test/t3-index",
  contract: {
    postureClass: "tos_restricted",
    disclosureTier: "T3",
    jurisdiction: "GLOBAL",
    retentionDays: 180,
    tenantOptInDefault: false,
  },
});

const T4_SOURCE = makeSource({
  collectorId: "internal-signal",
  collectorName: "Internal aggregator",
  sourceUrl: "https://internal.test/signal",
  contract: {
    postureClass: "public_api",
    disclosureTier: "T4",
    jurisdiction: "GLOBAL",
    retentionDays: 30,
    tenantOptInDefault: true,
  },
});

// ---- tests --------------------------------------------------------------

describe("<InsightCitations />", () => {
  test("renders nothing when no source is visible under the tenant policy", () => {
    // Conservative policy hides T3/T4 entirely. With *only* a T3 source,
    // `renderInsight()` reports `visible: false` and the component must
    // emit nothing rather than an empty card — otherwise tenants on
    // `conservative` would see a "Backed by 0 source categories" stub
    // when the system has *no* attributable evidence.
    const { container } = render(
      <InsightCitations sources={[T3_SOURCE]} policy="conservative" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("insight-citations-card")).toBeNull();
    expect(screen.queryByTestId("insight-citations-compact")).toBeNull();
  });

  test("renders nothing when the source list is empty", () => {
    // A defensive case: opportunities backed by zero sources shouldn't
    // show an empty citation card even on `analyst`.
    const { container: empty } = render(
      <InsightCitations sources={[]} policy="analyst" />,
    );
    expect(empty).toBeEmptyDOMElement();

    const { container: nullSources } = render(
      <InsightCitations sources={null} policy="standard" />,
    );
    expect(nullSources).toBeEmptyDOMElement();
  });

  test("T1 source surfaces a clickable link to the source URL (card variant)", () => {
    render(
      <InsightCitations sources={[T1_SOURCE]} policy="standard" />,
    );

    const card = screen.getByTestId("insight-citations-card");
    // Header label reflects the *named* tier-1 source count.
    expect(within(card).getByText(/backed by 1 named source/i)).toBeInTheDocument();

    const citation = within(card).getByTestId("insight-citation");
    expect(citation).toHaveAttribute("data-tier", "T1");

    const link = within(citation).getByRole("link", {
      name: /FRED — US Federal Reserve Economic Data/,
    });
    expect(link).toHaveAttribute("href", T1_SOURCE.sourceUrl);
    // Open in a new tab without leaking the opener — security-relevant
    // for outbound source links.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  test("T2 source surfaces a generic posture/jurisdiction label and no outbound link", () => {
    render(
      <InsightCitations sources={[T2_SOURCE]} policy="standard" />,
    );

    const card = screen.getByTestId("insight-citations-card");
    const citation = within(card).getByTestId("insight-citation");
    expect(citation).toHaveAttribute("data-tier", "T2");

    // Critically: must NOT name "European Central Bank" — T2 anonymises.
    expect(card).not.toHaveTextContent(/european central bank/i);
    // Generic category + jurisdiction label is what should be shown.
    expect(within(card).getByText(/public-api source/i)).toBeInTheDocument();
    expect(within(card).getByText(/EU/)).toBeInTheDocument();

    // No outbound link for T2 under standard policy.
    expect(within(citation).queryByRole("link")).toBeNull();
  });

  test("standard policy surfaces T1 + T2 together but omits the T3 entry's source name", () => {
    render(
      <InsightCitations
        sources={[T1_SOURCE, T2_SOURCE, T3_SOURCE]}
        policy="standard"
      />,
    );

    const card = screen.getByTestId("insight-citations-card");
    const citations = within(card).getAllByTestId("insight-citation");
    expect(citations).toHaveLength(3);

    const tiers = citations.map((c) => c.getAttribute("data-tier"));
    expect(tiers).toEqual(expect.arrayContaining(["T1", "T2", "T3"]));

    // T3 must not name the underlying collector under standard policy.
    expect(card).not.toHaveTextContent(/Tier-3 commodity index/);
    // Sanity: T1 attribution still wins the header label, since T1 is the
    // top tier surfaced.
    expect(within(card).getByText(/backed by 1 named source/i)).toBeInTheDocument();
  });

  test("analyst policy attaches a provenance-rich citation for every source, including T4", () => {
    // Analyst is the audit/compliance role — the renderer emits a
    // citation per source regardless of tier, and the component must
    // pass them all through (no client-side filtering).
    render(
      <InsightCitations
        sources={[T1_SOURCE, T2_SOURCE, T3_SOURCE, T4_SOURCE]}
        policy="analyst"
      />,
    );

    const card = screen.getByTestId("insight-citations-card");
    const citations = within(card).getAllByTestId("insight-citation");
    expect(citations).toHaveLength(4);

    const tiers = citations.map((c) => c.getAttribute("data-tier")).sort();
    expect(tiers).toEqual(["T1", "T2", "T3", "T4"]);

    // Every analyst-mode citation is provenance-rich: it surfaces the
    // collector name (so the auditor can trace the signal) and an
    // outbound link to the source URL.
    for (const c of citations) {
      const link = within(c).getByRole("link");
      expect(link).toHaveAttribute("href");
      expect(link.getAttribute("href")).toMatch(/^https:\/\//);
    }
    // The header label reflects the analyst-view count.
    expect(within(card).getByText(/backed by 4 sources \(analyst view\)/i)).toBeInTheDocument();
  });

  test("compact variant renders the same citation set under a different container", () => {
    render(
      <InsightCitations
        sources={[T1_SOURCE, T2_SOURCE]}
        policy="standard"
        variant="compact"
      />,
    );

    // Compact variant uses its own container test id and never the card one.
    const compact = screen.getByTestId("insight-citations-compact");
    expect(screen.queryByTestId("insight-citations-card")).toBeNull();

    // Both citations must still be present, with the same tier markers
    // as the card variant — the layout changes, the contract does not.
    expect(
      within(compact).getByText(/FRED — US Federal Reserve Economic Data/),
    ).toBeInTheDocument();
    expect(
      within(compact).getByRole("link", {
        name: /FRED — US Federal Reserve Economic Data/,
      }),
    ).toHaveAttribute("href", T1_SOURCE.sourceUrl);
    expect(within(compact).getByText(/public-api source/i)).toBeInTheDocument();
    expect(within(compact).getByText(/EU/)).toBeInTheDocument();
  });

  test("compact variant honours the conservative policy and renders nothing for T3-only sources", () => {
    // The compact variant lives in inline footers — a stray empty chip
    // row would be especially obvious, so we re-assert the hidden case
    // here on top of the card-variant version above.
    const { container } = render(
      <InsightCitations
        sources={[T3_SOURCE]}
        policy="conservative"
        variant="compact"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
