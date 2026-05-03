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

// Default the role mock to non-admin; individual tests can override.
vi.mock("@/lib/use-my-role", () => ({
  useMyRole: () => ({ isOrgAdmin: false, role: "member" }),
}));

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
    expect(screen.getByTestId("today-card-jobs")).toBeTruthy();
    expect(screen.getByTestId("today-card-approvals")).toBeTruthy();
    // #269 follow-up: "Proposed opportunities" card removed; it
    // counted the same status='proposed' pool as the Pending
    // approvals card. The server still emits
    // `opportunities.proposed`; the client just no longer renders
    // a card for it.
    expect(screen.queryByTestId("today-card-opportunities")).toBeNull();

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

  // ───────────────────────────────────────────────────────────────
  // #209 contract tests.
  // ───────────────────────────────────────────────────────────────

  test("scrubs raw SQL / file paths / stack frames out of error rendering (#209 step 1)", async () => {
    // The error string here is the EXACT shape we observed in the
    // production logs that motivated #209: "Failed query: select ..."
    // followed by `params: ...`, file paths, and stack frames. None of
    // it should reach the DOM.
    const dirty =
      'Failed query: select "id", "org_id", "state" from "alerts" where "alerts"."org_id" = $1 group by "alerts"."state" params: ["org_2zT"] at QueryClient.query (/home/runner/workspace/artifacts/api-server/src/db.ts:42:11)';
    mockFeed({
      items: [
        {
          kind: "opportunities.proposed",
          source: "listOpportunities",
          payload: { count: 0 },
          occurredAt: NOW,
          severity: "info",
        },
      ],
      partial: true,
      errors: [{ source: "getAlertsSummary", error: dirty }],
    });

    renderWithProviders(<Today />);

    const ribbon = await screen.findByTestId("today-card-alerts-error");
    const txt = ribbon.textContent ?? "";
    // Forbidden substrings: every leak marker the scrubber denylists.
    expect(txt).not.toMatch(/select/i);
    expect(txt).not.toMatch(/from/i);
    expect(txt).not.toMatch(/group by/i);
    expect(txt).not.toMatch(/\$\d+/);
    expect(txt).not.toMatch(/params\s*:/i);
    expect(txt).not.toMatch(/\.ts:/);
    expect(txt).not.toMatch(/\bat\s+\w+\s*\(/);
    // And the "What happened?" disclosure must NOT be present for a
    // non-admin viewer — the mock role above is `member`.
    expect(screen.queryByTestId("today-card-alerts-error-disclosure")).toBeNull();
  });

  test('admin sees a "What happened?" disclosure with the original unscrubbed error (#209 step 1)', async () => {
    // Override the role mock to admin for this test only.
    vi.doMock("@/lib/use-my-role", () => ({
      useMyRole: () => ({ isOrgAdmin: true, role: "org_admin" }),
    }));
    vi.resetModules();
    const TodayAdmin = (await import("../src/pages/today")).default;

    const dirty =
      'Failed query: select "id" from "alerts" params: ["x"] at f (/a/b.ts:1:1)';
    mockFeed({
      items: [
        {
          kind: "opportunities.proposed",
          source: "listOpportunities",
          payload: { count: 0 },
          occurredAt: NOW,
          severity: "info",
        },
      ],
      partial: true,
      errors: [{ source: "getAlertsSummary", error: dirty }],
    });

    renderWithProviders(<TodayAdmin />);

    const disclosure = await screen.findByTestId(
      "today-card-alerts-error-disclosure",
    );
    expect(disclosure).toBeTruthy();
    // The disclosure body retains the original unscrubbed string —
    // the whole point of role-gating is that admins can still
    // diagnose. `<details>` keeps its content in the DOM regardless
    // of open state, so the assertion is reliable.
    const body = screen.getByTestId(
      "today-card-alerts-error-disclosure-body",
    );
    expect(body.textContent).toBe(dirty);

    // Restore the default mock for subsequent tests.
    vi.doMock("@/lib/use-my-role", () => ({
      useMyRole: () => ({ isOrgAdmin: false, role: "member" }),
    }));
    vi.resetModules();
  });

  test("renders enriched context line for alerts when topAlert is present (RT-92 capability gate)", async () => {
    mockFeed({
      items: [
        {
          kind: "alerts.summary",
          source: "getAlertsSummary",
          payload: {
            openTotal: 7,
            openCriticalOrHigh: 2,
            topAlert: {
              id: "a1",
              title: "Stripe webhook lag spiked",
              severity: "critical",
              ageMs: 3600_000, // 1 hour
            },
          },
          occurredAt: NOW,
          severity: "warn",
        },
        {
          kind: "opportunities.proposed",
          source: "listOpportunities",
          payload: { count: 0 },
          occurredAt: NOW,
          severity: "info",
        },
      ],
      partial: false,
      errors: [],
    });

    renderWithProviders(<Today />);

    const ctx = await screen.findByTestId("today-card-alerts-context");
    // Context line must include both totals and the topAlert title.
    expect(ctx.textContent).toMatch(/7 open total/);
    expect(ctx.textContent).toMatch(/Stripe webhook lag spiked/);
    expect(ctx.textContent).toMatch(/1h ago/);
  });

  test("falls back to number-only when payload lacks #209 enrichment (RT-100 capability gate)", async () => {
    // No topAlert / topOpportunity / etc. — the page MUST keep
    // working: render the number, omit the enriched line gracefully.
    mockFeed({
      items: [
        {
          kind: "alerts.summary",
          source: "getAlertsSummary",
          payload: { openTotal: 4, openCriticalOrHigh: 1 },
          occurredAt: NOW,
          severity: "info",
        },
      ],
      partial: false,
      errors: [],
    });

    renderWithProviders(<Today />);

    const ctx = await screen.findByTestId("today-card-alerts-context");
    expect(ctx.textContent).toMatch(/4 open total/);
    // No topAlert mention, no "ago" string.
    expect(ctx.textContent).not.toMatch(/top:/);
    expect(ctx.textContent).not.toMatch(/ago/);
  });

  test("approvals card shows needsActionToday as headline + total as muted secondary (RT-83)", async () => {
    mockFeed({
      items: [
        {
          kind: "approvals.pending",
          source: "approvalsPending",
          payload: {
            pending: 4080,
            needsActionToday: 12,
            oldestAgeMs: 30 * 24 * 60 * 60 * 1000,
          },
          occurredAt: NOW,
          severity: "info",
        },
      ],
      partial: false,
      errors: [],
    });

    renderWithProviders(<Today />);

    const card = await screen.findByTestId("today-card-approvals");
    // Headline number is the actionable one.
    expect(card.querySelector(".text-3xl")?.textContent).toBe("12");
    // Context line carries the structural total.
    const ctx = screen.getByTestId("today-card-approvals-context");
    expect(ctx.textContent).toMatch(/4,080 total pending/);
    expect(ctx.textContent).toMatch(/oldest 30d/);
  });

  test("error and empty states are mutually exclusive on the same card", async () => {
    // Sources that error must NOT also render their pre-#209 empty
    // state ("No alerts data."). Otherwise the operator sees a card
    // that's screaming both "broken" and "nothing here" simultaneously,
    // which was one of the original #209 complaints.
    mockFeed({
      items: [
        {
          kind: "opportunities.proposed",
          source: "listOpportunities",
          payload: { count: 1 },
          occurredAt: NOW,
          severity: "info",
        },
      ],
      partial: true,
      errors: [
        { source: "getAlertsSummary", error: "boom" },
        { source: "listJobs", error: "boom" },
        { source: "approvalsPending", error: "boom" },
      ],
    });

    renderWithProviders(<Today />);

    await screen.findByTestId("today-card-alerts");
    expect(screen.queryByText(/No alerts data\./)).toBeNull();
    expect(screen.queryByText(/No job data\./)).toBeNull();
    expect(screen.queryByText(/No approvals data\./)).toBeNull();
  });

  test("alerts deep-link uses ?filter=state:open only — destination is single-select (#209 review)", async () => {
    // The alerts card counts open critical OR high. Naively we'd
    // emit `filter=severity:critical&filter=severity:high` per the
    // documented OR convention, BUT the alerts destination's
    // severity filter is a single-`<Select>` today and would
    // silently collapse to one of those values, mis-representing
    // the slice. Until the alerts page grows a multi-select
    // severity (a #204 follow-up), the deep-link is intentionally
    // single-key.
    mockFeed({
      items: [
        {
          kind: "alerts.summary",
          source: "getAlertsSummary",
          payload: { openTotal: 7, openCriticalOrHigh: 2 },
          occurredAt: NOW,
          severity: "warn",
        },
      ],
      partial: false,
      errors: [],
    });

    renderWithProviders(<Today />);

    const card = await screen.findByTestId("today-card-alerts");
    const link = card.querySelector("a");
    expect(link).toBeTruthy();
    const href = link!.getAttribute("href") ?? "";
    // `:` is a sub-delim per RFC 3986 and is allowed unencoded in
    // query values; we keep them readable in the deep-link.
    expect(href).toBe("/alerts?filter=state:open");
  });

  test("approvals split gate treats null as absent (#209 review)", async () => {
    // RT-92/RT-100: capability-gating must reject `null` as well as
    // `undefined`. JSON serialization of an explicit-null field is a
    // real wire shape that any older server might emit. Without this
    // fix the headline number would render as `null` literally.
    mockFeed({
      items: [
        {
          kind: "approvals.pending",
          source: "approvalsPending",
          payload: { pending: 12, needsActionToday: null },
          occurredAt: NOW,
          severity: "info",
        },
      ],
      partial: false,
      errors: [],
    });

    renderWithProviders(<Today />);

    const card = await screen.findByTestId("today-card-approvals");
    // Headline must fall back to `pending` (12), and the secondary
    // line must NOT render (no split available).
    expect(card.querySelector(".text-3xl")?.textContent).toBe("12");
    expect(
      screen.queryByTestId("today-card-approvals-context"),
    ).toBeNull();
  });
});
