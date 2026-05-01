/**
 * #199 — Today landing page render contract.
 *
 * Pins the operator-facing behaviour of the Today aggregator UI so a
 * regression on the IA flip can't silently lose the daily-flow framing:
 *
 *   - Renders the four triage cards (alerts, opportunities, approvals,
 *     ops health) by `kind` from the fail-soft feed payload.
 *   - When the feed reports `partial: true`, the partial badge surfaces
 *     and any per-source error text appears next to the affected card
 *     (so the operator sees exactly what's missing, not a blank tile).
 *   - When everything succeeds the badge does NOT render.
 *
 * If you change the feed contract or rename a `kind`, this test will
 * fail loudly — that's the point.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

import Today from "../src/pages/today";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type FeedItem = {
  kind: string;
  source: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  severity: "info" | "warn" | "error";
};

function mockFeed(args: {
  items: FeedItem[];
  partial: boolean;
  errors: Array<{ source: string; error: string }>;
}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(JSON.stringify(args), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router>{ui}</Router>
    </QueryClientProvider>,
  );
}

const NOW = "2026-04-30T00:00:00.000Z";

describe("<Today />", () => {
  test("renders all four triage cards from a healthy feed", async () => {
    mockFeed({
      items: [
        {
          kind: "alerts.summary",
          source: "getAlertsSummary",
          payload: { openTotal: 7, openCriticalOrHigh: 2 },
          occurredAt: NOW,
          severity: "warn",
        },
        {
          kind: "opportunities.proposed",
          source: "listOpportunities",
          payload: { count: 5, top: [] },
          occurredAt: NOW,
          severity: "info",
        },
        {
          kind: "jobs.failed",
          source: "listJobs",
          payload: { count: 0, recent: [] },
          occurredAt: NOW,
          severity: "info",
        },
        {
          kind: "approvals.pending",
          source: "approvalsPending",
          payload: { pending: 3 },
          occurredAt: NOW,
          severity: "info",
        },
      ],
      partial: false,
      errors: [],
    });

    renderWithProviders(<Today />);

    // Wait for query to resolve.
    expect(await screen.findByTestId("today-card-alerts")).toBeTruthy();
    expect(screen.getByTestId("today-card-opportunities")).toBeTruthy();
    expect(screen.getByTestId("today-card-jobs")).toBeTruthy();
    expect(screen.getByTestId("today-card-approvals")).toBeTruthy();

    // No partial badge when everything succeeded.
    expect(screen.queryByTestId("today-partial-badge")).toBeNull();
  });

  test("surfaces partial badge AND per-source error text when a source fails", async () => {
    mockFeed({
      items: [
        {
          kind: "opportunities.proposed",
          source: "listOpportunities",
          payload: { count: 1, top: [] },
          occurredAt: NOW,
          severity: "info",
        },
      ],
      partial: true,
      errors: [
        {
          source: "getAlertsSummary",
          error: "alerts table missing",
        },
      ],
    });

    renderWithProviders(<Today />);

    // Partial badge present.
    expect(await screen.findByTestId("today-partial-badge")).toBeTruthy();

    // Per-source error appears under the affected card. The error
    // routing pins the contract that the UI maps `source` →
    // card via `errFor()` lookup.
    expect(screen.getByTestId("today-card-alerts-error")).toBeTruthy();
    expect(screen.getByTestId("today-card-alerts-error").textContent).toMatch(
      /alerts table missing/,
    );
  });
});
