/**
 * Task #52 — Collector Registry: per-collector "new vs duplicates"
 * counts and the stalled-feed warning badge.
 *
 * The backend integration test in
 * `artifacts/api-server/test/collectors-list-run-metrics.test.ts`
 * locks the wire-format down. This file pins the matching UI
 * contract so a refactor of the Registry card cannot silently
 * regress what the operator sees.
 *
 * Three cases pinned here, all rendered through the real
 * `<Collectors />` page (the registry tab is the default tab):
 *
 *   1. A healthy collector with `lastRunAt` and a non-zero
 *      `lastInsertedCount` renders "N new signals · M duplicates
 *      skipped" and does NOT show the stale-feed badge.
 *
 *   2. A collector with `staleEmptyRuns: true` and zero inserts
 *      DOES render the amber "No new data" badge alongside the
 *      counts row.
 *
 *   3. A freshly-registered collector with `lastRunAt: null`
 *      renders neither the counts row nor the stale badge — both
 *      are gated on a real run timestamp so we never imply
 *      "0 new" for a collector that just hasn't run yet.
 *
 * Hooks from `@workspace/api-client-react` and `@/hooks/use-toast`
 * are mocked at the module boundary so the test stays offline and
 * doesn't need a real React-Query backend.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---- mock state --------------------------------------------------------

const { mockState } = vi.hoisted(() => ({
  mockState: {
    collectors: [] as Array<Record<string, unknown>>,
    catalog: { entries: [] as Array<Record<string, unknown>> },
    marketSignals: [] as Array<Record<string, unknown>>,
  },
}));

// Partial mock: the Registry tab pulls in side components
// (FxTrendChart, BlsTrendChart) that use *other* generated query
// helpers (`getListMarketSignalsQueryOptions`, `useQueries`, etc.)
// we don't care about here. `importOriginal` keeps those passing
// through to the real generated client; we only override the hooks
// whose return shape this test actually pins.
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
    useListCollectors: () => wrap(mockState.collectors),
    useListCollectorCatalog: () => wrap(mockState.catalog),
    useListMarketSignals: () => wrap(mockState.marketSignals),
    // Other tabs render lazily (gated on `tab === "..."`) so their
    // hooks are never called in the default Registry view, but stub
    // them anyway to harden the test against future refactors that
    // could lift fetches above the tab gate.
    useListCollectorSourceHealth: () => wrap([]),
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

// Imported after the mocks so the page picks up the stubs.
const { default: Collectors } = await import("../src/pages/collectors");

// ---- helpers -----------------------------------------------------------

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Collectors />
    </QueryClientProvider>,
  );
}

/**
 * The card for a given collector is anchored by `data-testid` so we
 * don't accidentally pick up a sibling collector's badge or count row
 * when running with multiple fixtures in the list.
 */
function rowFor(id: string): HTMLElement {
  return screen.getByTestId(`collector-${id}`);
}

// A minimal CollectorRow that satisfies the page's TypeScript shape
// AND the runtime fields the Registry card actually reads.
function makeCollector(over: Partial<Record<string, unknown>>) {
  return {
    id: "col_default",
    name: "Default Collector",
    posture: "operator_disclosed",
    postureClass: "regulatory",
    disclosureTier: "T1",
    jurisdiction: "US",
    flagEmoji: null,
    status: "enabled",
    description: null,
    sourceUrl: null,
    defaultRateLimitRpm: null,
    defaultScheduleCron: null,
    lastRunAt: null,
    lastSignalCount: null,
    lastInsertedCount: null,
    lastDuplicateCount: null,
    staleEmptyRuns: false,
    ...over,
  };
}

// ---- tests -------------------------------------------------------------

describe("Collector Registry — last-run new vs duplicates", () => {
  afterEach(() => {
    cleanup();
    mockState.collectors = [];
    mockState.catalog = { entries: [] };
    mockState.marketSignals = [];
  });

  test("healthy run shows '<inserted> new signals · <dupes> duplicates skipped' and no stale badge", () => {
    mockState.collectors = [
      makeCollector({
        id: "col_healthy",
        name: "Healthy Collector",
        lastRunAt: "2026-05-01T12:00:00.000Z",
        lastInsertedCount: 5,
        lastDuplicateCount: 2,
        lastSignalCount: 5,
        staleEmptyRuns: false,
      }),
    ];

    renderPage();

    const row = rowFor("col_healthy");
    const counts = within(row).getByTestId("run-counts-col_healthy");
    expect(counts).toHaveTextContent(/5\s*new signals/);
    expect(counts).toHaveTextContent(/2\s*duplicates skipped/);

    // No stale badge for a healthy run.
    expect(
      within(row).queryByTestId("badge-stale-col_healthy"),
    ).not.toBeInTheDocument();
    expect(within(row).queryByText(/no new data/i)).not.toBeInTheDocument();
  });

  test("staleEmptyRuns surfaces the amber 'No new data' badge alongside zero counts", () => {
    mockState.collectors = [
      makeCollector({
        id: "col_stalled",
        name: "Stalled Collector",
        lastRunAt: "2026-05-01T12:00:00.000Z",
        lastInsertedCount: 0,
        lastDuplicateCount: 9,
        lastSignalCount: 0,
        staleEmptyRuns: true,
      }),
    ];

    renderPage();

    const row = rowFor("col_stalled");
    const badge = within(row).getByTestId("badge-stale-col_stalled");
    expect(badge).toHaveTextContent(/no new data/i);

    const counts = within(row).getByTestId("run-counts-col_stalled");
    expect(counts).toHaveTextContent(/0\s*new signals/);
    expect(counts).toHaveTextContent(/9\s*duplicates skipped/);
  });

  test("never-run collector renders neither the counts row nor the stale badge", () => {
    mockState.collectors = [
      makeCollector({
        id: "col_fresh",
        name: "Fresh Collector",
        lastRunAt: null,
        lastInsertedCount: null,
        lastDuplicateCount: null,
        lastSignalCount: null,
        staleEmptyRuns: false,
      }),
    ];

    renderPage();

    const row = rowFor("col_fresh");
    expect(
      within(row).queryByTestId("run-counts-col_fresh"),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByTestId("badge-stale-col_fresh"),
    ).not.toBeInTheDocument();
    // The "Last run:" line still renders, with the formatter's
    // empty-state. We don't assert that exact string here — we only
    // care that the new fields don't pollute the empty-state row.
    expect(within(row).queryByText(/new signals/)).not.toBeInTheDocument();
    expect(
      within(row).queryByText(/duplicates skipped/),
    ).not.toBeInTheDocument();
  });
});
