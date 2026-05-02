/**
 * E2E-equivalent UI coverage for the Fusion Center.
 *
 * The /fusion page has full server-side test coverage for tenant
 * isolation and disclosure-policy filtering, but until now no UI
 * test exercised the actual page. A regression in tab routing,
 * deep-link handling (?tab=…&cycleId=…), citation rendering or
 * cross-page navigation would only surface when a user noticed it.
 *
 * This file pins three things end-to-end:
 *
 *   1. `<Fusion />` renders the default Signal Browser pane on bare
 *      `/fusion`, and clicking each of the five tab triggers swaps
 *      the visible pane to an exclusive set of pane-specific
 *      content (no console errors during the switches).
 *
 *   2. Deep-linking via `?tab=events&cycleId=cyc_…` (the link
 *      emitted by the OODA cycle-detail card) opens the Event
 *      Stream pane pre-filtered to that cycle, with the cycle
 *      banner visible.
 *
 *   3. The two cross-link sources called out in the task — the
 *      dashboard's System Pulse "Intelligence Fusion" rows and
 *      the OODA cycle-detail card's two fusion links — actually
 *      render anchors that resolve to /fusion (and to the
 *      cycle-filtered war-room URL).
 *
 * Hooks from `@workspace/api-client-react` are mocked at the
 * module boundary so the tests don't need a live API; the mocks
 * default to the empty-state shapes the server returns when a
 * tenant has no signals/events/coverage gaps yet, which exercises
 * the empty-state code paths every pane has.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// ---- mock state ---------------------------------------------------------

// `vi.hoisted` lifts this above the `vi.mock` factory so the mock can
// reach in for its return values. Tests reset it in `beforeEach`.
const { mockState } = vi.hoisted(() => {
  const empty = {
    me: undefined as unknown,
    suppliers: undefined as unknown,
    supplier: undefined as unknown,
    supplierIntelligence: undefined as unknown,
    alerts: undefined as unknown,
    alertsSummary: undefined as unknown,
    alertEvents: undefined as unknown,
    alertDeliveries: undefined as unknown,
    signals: undefined as unknown,
    entity360: undefined as unknown,
    entity360Loading: false,
    entity360Error: undefined as unknown,
    heatmap: undefined as unknown,
    events: undefined as unknown,
    coverage: undefined as unknown,
    cycles: undefined as unknown,
    cycle: undefined as unknown,
    spend: undefined as unknown,
    billing: undefined as unknown,
    opportunities: undefined as unknown,
    jobs: undefined as unknown,
    collectors: undefined as unknown,
    marketSignals: undefined as unknown,
    learnedPriors: undefined as unknown,
  };
  return { mockState: empty };
});

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  // Each generated `useXxx` hook returns a React-Query-shaped
  // `{ data, isLoading, isFetching, error }` object. The page code
  // destructures these, so as long as the shape is consistent it
  // doesn't matter that we ignore the hook arguments.
  const wrap = <T,>(data: T) => ({
    data,
    isLoading: false,
    isFetching: false,
    error: undefined,
  });
  // Pull through the real module so generated value exports
  // (status enums, schemas, etc.) used by sibling pages still
  // resolve. We override only the hooks the test needs to control.
  const actual = await importOriginal<
    typeof import("@workspace/api-client-react")
  >();

  return {
    ...actual,
    // Shared
    useGetMe: () => wrap(mockState.me),
    useListSuppliers: () => wrap(mockState.suppliers),

    // Supplier detail
    useGetSupplier: () => wrap(mockState.supplier),
    useGetSupplierIntelligence: () => wrap(mockState.supplierIntelligence),
    usePatchSupplier: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    }),
    useOverrideSupplierBillingCurrency: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    }),
    getGetSupplierQueryKey: () => ["supplier"],
    getGetSupplierIntelligenceQueryKey: () => ["supplierIntelligence"],
    getListSuppliersQueryKey: () => ["suppliers"],

    // Alerts page
    useListAlerts: () => wrap(mockState.alerts),
    useGetAlertsSummary: () => wrap(mockState.alertsSummary),
    useTransitionAlert: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    }),
    useListAlertEvents: () => wrap(mockState.alertEvents),
    useListAlertDeliveries: () => wrap(mockState.alertDeliveries),
    getListAlertsQueryKey: () => ["alerts"],
    getGetAlertsSummaryQueryKey: () => ["alertsSummary"],
    getGetAlertQueryKey: () => ["alert"],
    getListAlertEventsQueryKey: () => ["alertEvents"],
    getListAlertDeliveriesQueryKey: () => ["alertDeliveries"],

    // Fusion
    useListIntelligenceSignals: () => wrap(mockState.signals),
    useGetIntelligenceEntity360: () => ({
      data: mockState.entity360,
      isLoading: mockState.entity360Loading,
      isFetching: false,
      error: mockState.entity360Error,
    }),
    useGetIntelligenceRiskHeatmap: () => wrap(mockState.heatmap),
    useListIntelligenceEvents: () => wrap(mockState.events),
    useGetIntelligenceCoverageGaps: () => wrap(mockState.coverage),

    // Dashboard
    useGetSpendOverview: () => wrap(mockState.spend),
    useGetBillingSummary: () => wrap(mockState.billing),
    useListOpportunities: () => wrap(mockState.opportunities),
    useListCycles: () => wrap(mockState.cycles),
    useListJobs: () => wrap(mockState.jobs),
    useListCollectors: () => wrap(mockState.collectors),
    useListMarketSignals: () => wrap(mockState.marketSignals),

    // OODA
    useListLearnedPriors: () => wrap(mockState.learnedPriors),
    useGetCycle: () => wrap(mockState.cycle),
    useRunNextCycle: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    }),

    // Generated query-key helpers — only used by callers to wire up
    // refetchInterval/queryKey, never inspected. Stub returns are fine.
    getListIntelligenceSignalsQueryKey: () => ["signals"],
    getGetIntelligenceEntity360QueryKey: () => ["entity360"],
    getGetIntelligenceRiskHeatmapQueryKey: () => ["heatmap"],
    getListIntelligenceEventsQueryKey: () => ["events"],
    getGetIntelligenceCoverageGapsQueryKey: () => ["coverage"],
    getGetSpendOverviewQueryKey: () => ["spend"],
    getGetBillingSummaryQueryKey: () => ["billing"],
    getListOpportunitiesQueryKey: () => ["opportunities"],
    getListCyclesQueryKey: () => ["cycles"],
    getListJobsQueryKey: () => ["jobs"],
    getListCollectorsQueryKey: () => ["collectors"],
    getListMarketSignalsQueryKey: () => ["marketSignals"],
    getGetCycleQueryKey: () => ["cycle"],
  };
});

// Modules are imported AFTER `vi.mock` so the mocked module wins.
const { default: Fusion } = await import("../src/pages/fusion");
const { default: Dashboard } = await import("../src/pages/dashboard");
const { default: SupplierDetailPage } = await import(
  "../src/pages/supplier-detail"
);
const { default: AlertsPage } = await import("../src/pages/alerts");

// ---- fixtures -----------------------------------------------------------

const ME = {
  org: {
    id: "org_test",
    slug: "test-org",
    name: "Test Org",
    disclosurePolicy: "standard" as const,
    contractRenewalAlertDays: 90,
    createdAt: "2025-01-01T00:00:00.000Z",
    successFeePct: 0.1,
  },
  actorEmail: "agent@test.local",
};

const T1_SOURCE = {
  collectorId: "fred",
  collectorName: "FRED — US Federal Reserve Economic Data",
  sourceUrl: "https://fred.stlouisfed.org/series/PPIACO",
  observedAt: "2026-04-29T00:00:00.000Z",
  contract: {
    postureClass: "public_api" as const,
    disclosureTier: "T1" as const,
    jurisdiction: "US",
    retentionDays: 365,
    tenantOptInDefault: true,
  },
};

function emptyHeatmap() {
  return {
    dimensions: [],
    countries: [],
    cells: [],
    sites: [],
    generatedAt: "2026-04-29T00:00:00.000Z",
    policy: "standard" as const,
  };
}

function emptySignals() {
  return {
    items: [],
    totalCount: 0,
    droppedByPolicy: 0,
    policy: "standard" as const,
  };
}

function emptyEvents() {
  return {
    items: [],
    droppedByPolicy: 0,
    policy: "standard" as const,
    generatedAt: "2026-04-29T00:00:00.000Z",
  };
}

function emptyCoverage() {
  return {
    items: [],
    lookbackDays: 90,
    generatedAt: "2026-04-29T00:00:00.000Z",
  };
}

function emptySpend() {
  return {
    totalSpendUsd: 0,
    concentration: { activeSupplierCount: 0 },
  };
}

// Minimal SupplierDetail shape — every field the page reads must be
// present, but lists/maps are intentionally empty so the test stays
// scoped to the cross-link assertion (no nested rendering surprises).
function makeSupplierDetail(id: string, name: string) {
  return {
    id,
    name,
    countryCode: "US",
    billingCurrency: "USD",
    billingCurrencySource: null,
    billingCurrencyConfidence: null,
    paymentTermsDays: null,
    isStrategic: false,
    isPreferred: false,
    tags: [] as string[],
    internalNotes: null,
    spend: {
      totalSpendUsd: 0,
      poCount: 0,
      monthly: [],
      topCategories: [],
    },
    services: {
      activeSowCount: 0,
      openMilestoneCount: 0,
      rateCardCount: 0,
      totalServicesSpendUsd: 0,
      timeAndMaterialsSpendUsd: 0,
      fixedPriceSpendUsd: 0,
      upcomingMilestoneDueDate: null,
      avgBlendedRateUsd: null,
      offCardSpendShare: 0,
      changeOrderRatio: 0,
      hasServicesActivity: false,
      utilizationSignalCount: 0,
    },
    contracts: [],
    opportunities: [],
    fxSignals: [],
    auditLog: [],
  };
}

function emptyAlertsList() {
  return { items: [] };
}

function emptyAlertsSummary() {
  return {
    byState: {},
    bySeverity: {},
    openCriticalOrHigh: 0,
  };
}

// ---- helpers ------------------------------------------------------------

function renderWithRouter(
  ui: React.ReactElement,
  { initialPath = "/" }: { initialPath?: string } = {},
) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const memory = memoryLocation({ path: initialPath, record: true });
  return {
    memory,
    ...render(
      <QueryClientProvider client={qc}>
        <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
          {ui}
        </WouterRouter>
      </QueryClientProvider>,
    ),
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Reset mock state to the "empty tenant" shape every test starts with.
  Object.assign(mockState, {
    me: ME,
    suppliers: { items: [] },
    signals: emptySignals(),
    entity360: undefined,
    entity360Loading: false,
    entity360Error: undefined,
    heatmap: emptyHeatmap(),
    events: emptyEvents(),
    coverage: emptyCoverage(),
    cycles: [],
    cycle: undefined,
    supplier: makeSupplierDetail("sup_test", "Test Supplier"),
    supplierIntelligence: undefined,
    alerts: emptyAlertsList(),
    alertsSummary: emptyAlertsSummary(),
    alertEvents: { items: [] },
    alertDeliveries: { items: [] },
    spend: emptySpend(),
    billing: {
      successFeePct: 0.1,
      totalRealizedUsd: 0,
      totalProjectedUsd: 0,
      successFeeUsd: 0,
      byLever: [],
    },
    opportunities: { items: [] },
    jobs: [],
    collectors: [],
    marketSignals: [],
    learnedPriors: [],
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function expectNoConsoleErrors() {
  // Snapshot any unexpected error/warn output so the failure message
  // names *what* leaked, not just that the count was non-zero.
  const errs = consoleErrorSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? ""));
  const warns = consoleWarnSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? ""));
  expect(errs, "console.error during render").toEqual([]);
  expect(warns, "console.warn during render").toEqual([]);
}

// ---- 1. Tab routing across all five panes ------------------------------

describe("<Fusion /> tab routing", () => {
  test("default URL renders the Signal Browser pane and the page header", () => {
    renderWithRouter(<Fusion />);

    expect(screen.getByTestId("text-page-title")).toHaveTextContent(
      /Intelligence Fusion Center/i,
    );
    expect(screen.getByTestId("badge-policy")).toHaveTextContent(
      /standard/i,
    );

    // Signal Browser is the default — Filters card + the empty-state
    // "No signals match these filters." line are both visible.
    expect(screen.getByTestId("signal-type-select")).toBeInTheDocument();
    expect(
      screen.getByText(/No signals match these filters\./i),
    ).toBeInTheDocument();

    expectNoConsoleErrors();
  });

  test("clicking each of the five tabs swaps to the matching pane and shows its empty state", async () => {
    const user = userEvent.setup();
    renderWithRouter(<Fusion />);

    // Entity 360 — empty selector message until a supplier is picked.
    await user.click(screen.getByTestId("tab-entity"));
    expect(screen.getByTestId("entity-kind-select")).toBeInTheDocument();
    expect(
      screen.getByText(/Pick a supplier or enter a code to view its 360\./i),
    ).toBeInTheDocument();

    // Risk Heatmap — empty-state copy when no countries are scored.
    await user.click(screen.getByTestId("tab-heatmap"));
    expect(
      screen.getByText(
        /No country-scoped risk signals in the lookback window\./i,
      ),
    ).toBeInTheDocument();

    // Event Stream — empty-state copy when no events in the window.
    await user.click(screen.getByTestId("tab-events"));
    expect(
      screen.getByText(
        /No geopolitical \/ disruption events in the last 72 hours\./i,
      ),
    ).toBeInTheDocument();

    // Coverage Gaps — KPI cards always render; empty list copy when none.
    await user.click(screen.getByTestId("tab-coverage"));
    expect(
      screen.getByText(
        /Every spend bucket has at least one signal — no coverage gaps\./i,
      ),
    ).toBeInTheDocument();

    // Back to Signals to round-trip the tab state.
    await user.click(screen.getByTestId("tab-signals"));
    expect(
      screen.getByText(/No signals match these filters\./i),
    ).toBeInTheDocument();

    expectNoConsoleErrors();
  });

  test("renders signal rows when the API returns data, including the citation chip", () => {
    mockState.signals = {
      items: [
        {
          id: "sig_1",
          signalType: "commodity_price",
          value: 1234.5,
          unit: "USD/MT",
          confidence: 0.8,
          observedAt: "2026-04-28T10:00:00.000Z",
          tier: "T1" as const,
          scope: { kind: "category" as const, label: "Steel", categoryCode: "STEEL" },
          metadata: null,
          source: T1_SOURCE,
        },
      ],
      totalCount: 1,
      droppedByPolicy: 0,
      policy: "standard" as const,
    };

    renderWithRouter(<Fusion />);

    const row = screen.getByTestId("signal-row-sig_1");
    expect(within(row).getByText("commodity_price")).toBeInTheDocument();
    // Scope button points at the category code per `entityRefForScope`.
    expect(within(row).getByTestId("signal-scope-sig_1")).toHaveTextContent(
      /Steel/,
    );
    // Citation chip rendered through `<InsightCitations variant="compact" />`.
    expect(screen.getByTestId("insight-citations-compact")).toBeInTheDocument();

    expectNoConsoleErrors();
  });
});

// ---- 2. Deep-linking from sibling pages --------------------------------

describe("<Fusion /> deep-link via search params", () => {
  test("?tab=heatmap opens directly on the Risk Heatmap pane", () => {
    renderWithRouter(<Fusion />, { initialPath: "/?tab=heatmap" });

    // Heatmap pane is mounted (its empty-state copy is visible) and
    // the Signal Browser filters card is NOT.
    expect(
      screen.getByText(
        /No country-scoped risk signals in the lookback window\./i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("signal-type-select")).toBeNull();

    expectNoConsoleErrors();
  });

  test("?tab=events&cycleId=cyc_test forces the Event Stream pane and shows the cycle banner", () => {
    renderWithRouter(<Fusion />, {
      initialPath: "/?tab=events&cycleId=cyc_test",
    });

    // Cycle banner is the smoking gun — only the events pane renders it,
    // and only when a cycleId is in the URL.
    const banner = screen.getByTestId("card-cycle-banner");
    expect(banner).toHaveTextContent(/Filtered to OODA cycle/i);
    expect(banner).toHaveTextContent("cyc_test");

    // The "Clear cycle filter" link points back to the same pane
    // without the cycleId — the inverse navigation a user would take.
    const clearLink = screen.getByTestId("link-clear-cycle");
    expect(clearLink).toHaveAttribute("href", "/fusion?tab=events");

    // Empty state is the cycle-window copy, not the 72h fallback —
    // proves the events query received the cycleId.
    expect(
      screen.getByText(
        /No geopolitical \/ disruption events in the cycle window\./i,
      ),
    ).toBeInTheDocument();

    expectNoConsoleErrors();
  });
});

// ---- 3. Cross-links from Dashboard + OODA point at /fusion --------------

describe("cross-links to the Fusion Center", () => {
  test("dashboard System Pulse exposes Intelligence-Fusion rows that link to /fusion", () => {
    renderWithRouter(<Dashboard />);

    // The dashboard has TWO PulseRows wired to /fusion: the
    // "Market signals (24h)" tile and the dedicated "Intelligence
    // Fusion" tile. Both must resolve to the same /fusion path.
    const links = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/fusion");
    expect(
      links.length,
      "expected at least 2 anchors with href=/fusion in the dashboard System Pulse",
    ).toBeGreaterThanOrEqual(2);

    // The dedicated "Intelligence Fusion" row should be present by
    // its label so a future copy change can't silently delete it.
    expect(screen.getByText(/Intelligence Fusion/i)).toBeInTheDocument();

    expectNoConsoleErrors();
  });

  // Task #174: every other surface that emits a /fusion[?...] anchor
  // also has to be pinned. A regression in any of these URLs would
  // otherwise ship silently — the dashboard test above only catches
  // the System Pulse rows.
  test("supplier-detail header renders an Entity 360 link to /fusion?tab=entity&entity=supplier:<id>", () => {
    renderWithRouter(<SupplierDetailPage />);

    const link = screen.getByTestId("link-open-entity-360");
    expect(link).toHaveAttribute(
      "href",
      "/fusion?tab=entity&entity=supplier:sup_test",
    );

    expectNoConsoleErrors();
  });

  test("alerts page banner exposes an 'Open in War Room' link to /fusion?tab=events&eventId=<sig_…>", () => {
    // The marketSignalId banner only renders when the URL filter is
    // present; that's the codepath the cross-link from /fusion lives
    // behind, so we deep-link straight in.
    renderWithRouter(<AlertsPage />, {
      initialPath: "/?filter=marketSignalId:sig_evt123",
    });

    const link = screen.getByTestId("link-open-event-in-war-room");
    expect(link).toHaveAttribute(
      "href",
      "/fusion?tab=events&eventId=sig_evt123",
    );

    expectNoConsoleErrors();
  });
});

// ---- 4. Fusion correctly consumes the deep-links the rest of the app ---
//
// Each cross-link checked above promises a specific behaviour on the
// other side. If supplier-detail renders /fusion?tab=entity&entity=…
// but the Fusion Center silently ignores the `entity=` param, the
// click looks like it works but lands the operator on an empty
// Entity 360 picker — exactly the silent regression #174 is meant
// to prevent. Pin the consumption side too.

describe("<Fusion /> consumes deep-links from sibling pages", () => {
  test("?tab=entity&entity=supplier:sup_test pre-fills the entity selector and skips the empty state", () => {
    mockState.suppliers = {
      items: [
        { id: "sup_test", name: "Test Supplier", isStrategic: false, isPreferred: false },
      ],
    };

    renderWithRouter(<Fusion />, {
      initialPath: "/?tab=entity&entity=supplier:sup_test",
    });

    // Entity pane is mounted (its kind selector is visible).
    expect(screen.getByTestId("entity-kind-select")).toBeInTheDocument();

    // The "pick a supplier" empty state must NOT appear — the deep
    // link should have already populated the selector and enabled
    // the entity-360 query.
    expect(
      screen.queryByText(
        /Pick a supplier or enter a code to view its 360\./i,
      ),
    ).toBeNull();

    // The supplier select shows the chosen supplier's name (proves
    // `supplierId` state was synced from the URL, not stuck at "").
    expect(
      within(screen.getByTestId("entity-supplier-select")).getByText(
        "Test Supplier",
      ),
    ).toBeInTheDocument();

    expectNoConsoleErrors();
  });

  test("?tab=events&eventId=sig_evt123 pivots to the war room and shows the event-focus banner", () => {
    renderWithRouter(<Fusion />, {
      initialPath: "/?tab=events&eventId=sig_evt123",
    });

    const banner = screen.getByTestId("card-event-focus-banner");
    expect(banner).toHaveTextContent(/Highlighting stream event/i);
    expect(banner).toHaveTextContent("sig_evt123");

    // The "Clear focus" link drops just the eventId and stays on
    // the events tab — the inverse navigation a user would take.
    expect(screen.getByTestId("link-clear-event-focus")).toHaveAttribute(
      "href",
      "/fusion?tab=events",
    );

    expectNoConsoleErrors();
  });
});
