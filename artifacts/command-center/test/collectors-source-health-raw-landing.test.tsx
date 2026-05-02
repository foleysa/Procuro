/**
 * Task #133 — UI contract for the Source Health "Raw landing failed"
 * badge.
 *
 * The runtime test
 * (`artifacts/api-server/test/intelligence-raw-landing-failure-signal.test.ts`)
 * pins the durable signals (audit row, fetch_succeeded metadata, BQ
 * flag). The route returns those as `rawLandingFailures` +
 * `lastRawLandingFailedAt` on each `CollectorSourceHealthEntry`.
 * This test pins the matching UI: the Source Health tab must render
 * a loud red chip whenever a collector's `rawLandingFailures > 0`,
 * and must NOT render that chip when the count is zero — so a clean
 * collector doesn't get falsely badged as broken.
 *
 * Mirrors `collectors-registry-counts.test.tsx`'s mock-the-hooks
 * pattern so the test stays offline.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockState } = vi.hoisted(() => ({
  mockState: {
    sourceHealth: {
      lookbackHours: 168,
      entries: [] as Array<Record<string, unknown>>,
    },
    catalog: {
      entries: [] as Array<Record<string, unknown>>,
    },
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  const wrap = <T,>(data: T) => ({
    data,
    isLoading: false,
    isFetching: false,
    error: undefined,
  });
  const stubMutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: undefined,
  });
  return {
    ...actual,
    useListCollectors: () => wrap([]),
    useListCollectorCatalog: () => wrap(mockState.catalog),
    useListMarketSignals: () => wrap([]),
    useListCollectorSourceHealth: () => wrap(mockState.sourceHealth),
    useGetCollectorLineage: () => wrap(undefined),
    useGetCollectorCoverage: () => wrap(undefined),
    useGetCollectorCost: () => wrap(undefined),
    useListCollectorRunsAndErrors: () => wrap({ rows: [] }),
    usePatchCollectorPosture: stubMutation,
    useBroadcastCollectorPosture: stubMutation,
    usePreviewBroadcastCollectorPosture: () => wrap(undefined),
    useRunCollector: stubMutation,
    useBackfillEcbFxRates: stubMutation,
    useBackfillFredEconomicIndex: stubMutation,
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

const { default: Collectors } = await import("../src/pages/collectors");

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Collectors />
    </QueryClientProvider>,
  );
}

async function openSourceHealthTab() {
  const user = userEvent.setup();
  // The Source Health trigger is rendered from the page's Tabs list.
  await user.click(
    screen.getByRole("tab", { name: /source health/i }),
  );
}

describe("Source Health tab — raw landing failure badge (#133)", () => {
  afterEach(() => {
    cleanup();
    mockState.sourceHealth = { lookbackHours: 168, entries: [] };
    mockState.catalog = { entries: [] };
  });

  test("renders the red 'Raw landing failed' chip with a count when rawLandingFailures > 0", async () => {
    mockState.catalog = {
      entries: [
        { id: "collector-broken", name: "Broken Source", disclosureTier: "T1" },
      ],
    };
    mockState.sourceHealth = {
      lookbackHours: 168,
      entries: [
        {
          collectorId: "collector-broken",
          name: "Broken Source",
          status: "enabled",
          runs: 5,
          failures: 0,
          fetchErrors: 0,
          schemaDriftEvents: 0,
          lastRunAt: "2026-04-30T12:00:00.000Z",
          lastFailureAt: null,
          lastSchemaDriftAt: null,
          lastNonEmptyRunAt: "2026-04-30T12:00:00.000Z",
          staleEmptyRuns: false,
          rawLandingFailures: 3,
          lastRawLandingFailedAt: "2026-04-30T11:55:00.000Z",
          recentDrifts: [],
          healthScore: 80,
        },
      ],
    };

    renderPage();
    await openSourceHealthTab();

    const badge = screen.getByTestId("health-raw-landing-failed-collector-broken");
    expect(badge).toBeTruthy();
    // The chip must show the count so operators can tell "one blip"
    // from "sustained outage" at a glance.
    expect(badge.textContent).toContain("3");
    // Loud, not muted: the chip renders in the red palette so a
    // failed-landing collector visibly stands apart from the
    // yellow staleEmpty chip.
    expect(badge.className).toMatch(/red/);
  });

  test("does NOT render the chip when rawLandingFailures is zero — clean runs stay clean", async () => {
    mockState.catalog = {
      entries: [
        { id: "collector-ok", name: "Healthy Source", disclosureTier: "T1" },
      ],
    };
    mockState.sourceHealth = {
      lookbackHours: 168,
      entries: [
        {
          collectorId: "collector-ok",
          name: "Healthy Source",
          status: "enabled",
          runs: 10,
          failures: 0,
          fetchErrors: 0,
          schemaDriftEvents: 0,
          lastRunAt: "2026-04-30T12:00:00.000Z",
          lastFailureAt: null,
          lastSchemaDriftAt: null,
          lastNonEmptyRunAt: "2026-04-30T12:00:00.000Z",
          staleEmptyRuns: false,
          rawLandingFailures: 0,
          lastRawLandingFailedAt: null,
          recentDrifts: [],
          healthScore: 100,
        },
      ],
    };

    renderPage();
    await openSourceHealthTab();

    expect(
      screen.queryByTestId("health-raw-landing-failed-collector-ok"),
    ).toBeNull();
  });
});
