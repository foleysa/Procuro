/**
 * E2E-equivalent UI coverage for the six-step onboarding wizard
 * and the dashboard's auto-redirect to it on a fresh tenant.
 *
 * The wizard at `/onboarding` and the dashboard's auto-redirect
 * were previously verified by hand and by API smoke tests only.
 * This file pins three end-to-end behaviours through real React
 * renders + click-throughs (with the generated API hooks mocked
 * at the module boundary, the way the rest of this suite does it):
 *
 *   1. Walking the full happy path from `welcome` through to
 *      `run_first_cycle`, including the org-admin-only "Install
 *      sample data" action on step 2 and the "Run cycle now" button
 *      on step 6. The patched onboarding state is threaded back
 *      through `useGetOnboardingState` so the wizard chrome (step
 *      pill, "Done" badge, progress %) updates as the user advances.
 *
 *   2. The dashboard's `useEffect` auto-redirect to `/onboarding`
 *      when readiness reports `hasIngestedData=false` AND the
 *      actor's wizard state has not been completed or dismissed.
 *      The same effect must NOT fire on subsequent loads where the
 *      wizard has been dismissed (or completed) — the dashboard
 *      then renders in place at `/`.
 *
 *   3. The persistent <DataReadinessCard /> renders the per-lever
 *      gap list while any blocker is open, but swaps to the green
 *      "Every lever has the data it needs" state once every lever
 *      reaches 100. This is the wizard's "are we done?" signal.
 *
 * To keep the test fast and deterministic we emulate the server
 * round-trip locally: each mocked mutation applies the patch to the
 * shared `mockState`, then notifies a `useSyncExternalStore`
 * subscription so the next render of every dependent hook picks up
 * the change — exactly what `qc.invalidateQueries` would do against
 * the real API client.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import * as React from "react";

// ---- shared mock state -------------------------------------------------

type Lever = {
  leverId: string;
  label: string;
  tier: number;
  score: number;
  blockers: Array<{
    id: string;
    field: string;
    message: string;
    missingPct: number;
    missingCount: number;
    totalCount: number;
    fixUrl: string;
    hard: boolean;
  }>;
};

type OnboardingState = {
  currentStep:
    | "welcome"
    | "bring_data"
    | "map_categories"
    | "invite_team"
    | "configure_settings"
    | "run_first_cycle"
    | "completed";
  completedSteps: Array<{ step: string; completedAt: string }>;
  startedAt: string;
  updatedAt: string;
  dismissedAt?: string | null;
  completedAt?: string | null;
  dismissed: boolean;
  completed: boolean;
};

type Readiness = {
  overallScore: number;
  hasIngestedData: boolean;
  sampleDataInstalled: boolean;
  levers: Lever[];
};

type CycleStatus = "running" | "completed" | "failed";
type Cycle = {
  id: string;
  orgId: string;
  generation: number;
  status: CycleStatus;
  triggeredBy?: string;
  opportunitiesCreated: number;
  totalProjectedUsd: number;
  startedAt: string;
  completedAt?: string | null;
};

const {
  mockState,
  hookHelpers,
  calls,
  STABLE_EMPTY_ARRAY,
  STABLE_OPP_PAGE,
  STABLE_SPEND,
  STABLE_BILLING,
  STABLE_ALERTS_SUMMARY,
  STABLE_DEAD_LETTER,
} = vi.hoisted(() => {
  const state = {
    onboarding: undefined as OnboardingState | undefined,
    readiness: undefined as Readiness | undefined,
    cycles: [] as Cycle[],
    me: undefined as unknown,
  };
  const stableEmptyArray = Object.freeze([]) as readonly never[];
  const stableOppPage = Object.freeze({ items: [] as unknown[] });
  const stableSpend = Object.freeze({
    totalSpendUsd: 0,
    concentration: Object.freeze({ activeSupplierCount: 0 }),
  });
  const stableBilling = Object.freeze({
    successFeePct: 0.1,
    totalRealizedUsd: 0,
    totalProjectedUsd: 0,
    successFeeUsd: 0,
    byLever: stableEmptyArray,
  });
  const stableAlerts = Object.freeze({
    byState: Object.freeze({ open: 0 }),
    bySeverity: Object.freeze({}),
    openCriticalOrHigh: 0,
  });
  const stableDeadLetter = Object.freeze({ jobs: stableEmptyArray });

  // External-store plumbing so React renders pick up mutations to the
  // shared mockState immediately — same effect as a successful
  // queryClient.invalidateQueries against the real hooks.
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const notify = () => {
    for (const fn of Array.from(listeners)) fn();
  };

  const callRecord = {
    patch: [] as unknown[],
    install: 0,
    remove: 0,
    runCycle: 0,
  };

  return {
    mockState: state,
    hookHelpers: { subscribe, notify },
    calls: callRecord,
    STABLE_EMPTY_ARRAY: stableEmptyArray,
    STABLE_OPP_PAGE: stableOppPage,
    STABLE_SPEND: stableSpend,
    STABLE_BILLING: stableBilling,
    STABLE_ALERTS_SUMMARY: stableAlerts,
    STABLE_DEAD_LETTER: stableDeadLetter,
  };
});

// ---- mock the generated API client -------------------------------------

vi.mock("@workspace/api-client-react", () => {
  // Helper: every generated useXxx hook returns a React-Query-shaped
  // object. We use useSyncExternalStore so a notify() inside a
  // mutation forces dependent components to re-render.
  function useStored<T>(read: () => T) {
    return React.useSyncExternalStore(
      hookHelpers.subscribe,
      read,
      read,
    );
  }
  function wrap<T>(read: () => T) {
    const data = useStored(read);
    return { data, isLoading: false, isFetching: false, error: undefined };
  }

  return {
    // ----- Onboarding -----
    useGetOnboardingState: () => wrap(() => mockState.onboarding),
    usePatchOnboardingState: (opts?: {
      mutation?: { onSuccess?: (resp: unknown) => void };
    }) => ({
      // The wizard calls `mutate(vars)` for advance/jump and
      // `mutate(vars, { onSuccess })` for `dismiss()` and the final
      // "Finish setup" step — both per-call hooks need to fire alongside
      // the constructor-time onSuccess.
      mutate: (
        vars: { data: Record<string, unknown> },
        callOpts?: { onSuccess?: (resp: unknown) => void },
      ) => {
        calls.patch.push(vars.data);
        const cur = mockState.onboarding;
        if (!cur) return;
        const next: OnboardingState = { ...cur };
        const d = vars.data;
        if (typeof d.currentStep === "string") {
          next.currentStep = d.currentStep as OnboardingState["currentStep"];
        }
        if (typeof d.completedStep === "string") {
          if (!next.completedSteps.find((c) => c.step === d.completedStep)) {
            next.completedSteps = [
              ...next.completedSteps,
              {
                step: d.completedStep as string,
                completedAt: new Date().toISOString(),
              },
            ];
          }
        }
        if (d.dismissed === true) {
          next.dismissed = true;
          next.dismissedAt = new Date().toISOString();
        }
        if (d.completed === true) {
          next.completed = true;
          next.completedAt = new Date().toISOString();
        }
        next.updatedAt = new Date().toISOString();
        mockState.onboarding = next;
        hookHelpers.notify();
        opts?.mutation?.onSuccess?.(next);
        callOpts?.onSuccess?.(next);
      },
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    }),

    // ----- Readiness -----
    useGetReadiness: () => wrap(() => mockState.readiness),

    // ----- Today feed (#269: composed into unified Dashboard) -----
    useGetTodayFeed: () => wrap(() => undefined),

    // ----- Dead-letter jobs (NeedsAttention card) -----
    // The wrapped reader must return a stable reference, otherwise
    // useSyncExternalStore re-fires on every commit and triggers
    // "Maximum update depth exceeded".
    useListDeadLetterJobs: () => wrap(() => STABLE_DEAD_LETTER),
    getListDeadLetterJobsQueryKey: () => ["deadLetterJobs"],
    useRetryJob: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    }),
    useDiscardJob: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    }),

    // ----- Sample data -----
    useInstallSampleData: (opts?: {
      mutation?: { onSuccess?: (resp: unknown) => void };
    }) => ({
      mutate: () => {
        calls.install += 1;
        // Server effect: mark sample data installed and lift every lever
        // to 100% — the same outcome the curated dataset produces in prod.
        if (mockState.readiness) {
          mockState.readiness = {
            ...mockState.readiness,
            hasIngestedData: true,
            sampleDataInstalled: true,
            overallScore: 100,
            levers: mockState.readiness.levers.map((l) => ({
              ...l,
              score: 100,
              blockers: [],
            })),
          };
        }
        hookHelpers.notify();
        const resp = {
          installed: true,
          removed: false,
          counts: {
            purchaseOrders: 1234,
            invoices: 5678,
            suppliers: 42,
          },
        };
        opts?.mutation?.onSuccess?.(resp);
      },
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    }),
    useRemoveSampleData: (opts?: {
      mutation?: { onSuccess?: (resp: unknown) => void };
    }) => ({
      mutate: () => {
        calls.remove += 1;
        if (mockState.readiness) {
          mockState.readiness = {
            ...mockState.readiness,
            sampleDataInstalled: false,
          };
        }
        hookHelpers.notify();
        opts?.mutation?.onSuccess?.({ installed: false, removed: true });
      },
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    }),

    // ----- Cycles -----
    useRunNextCycle: (opts?: {
      mutation?: { onSuccess?: (resp: unknown) => void };
    }) => ({
      mutate: () => {
        calls.runCycle += 1;
        const cycle: Cycle = {
          id: `cyc_${calls.runCycle}`,
          orgId: "org_test",
          generation: (mockState.cycles[0]?.generation ?? 0) + 1,
          status: "completed",
          opportunitiesCreated: 7,
          totalProjectedUsd: 250_000,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
        mockState.cycles = [cycle, ...mockState.cycles];
        hookHelpers.notify();
        opts?.mutation?.onSuccess?.({
          generation: cycle.generation,
          opportunitiesCreated: cycle.opportunitiesCreated,
          totalProjectedUsd: cycle.totalProjectedUsd,
        });
      },
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    }),
    useListCycles: () => wrap(() => mockState.cycles),

    // ----- Dashboard noise: just enough to render -----
    // Each `read` closure must return a STABLE reference for the same
    // underlying state — `useSyncExternalStore` re-renders whenever the
    // snapshot ref changes, so returning a fresh `[]` / `{}` every call
    // would trigger an infinite render loop in the dashboard's effects.
    useGetMe: () => wrap(() => mockState.me),
    useGetSpendOverview: () => wrap(() => STABLE_SPEND),
    useGetBillingSummary: () => wrap(() => STABLE_BILLING),
    useListOpportunities: () => wrap(() => STABLE_OPP_PAGE),
    useListJobs: () => wrap(() => STABLE_EMPTY_ARRAY),
    useListCollectors: () => wrap(() => STABLE_EMPTY_ARRAY),
    useListMarketSignals: () => wrap(() => STABLE_EMPTY_ARRAY),
    useGetAlertsSummary: () => wrap(() => STABLE_ALERTS_SUMMARY),

    // ----- Generated query-key helpers (stub) -----
    getGetOnboardingStateQueryKey: () => ["onboarding"],
    getGetReadinessQueryKey: () => ["readiness"],
    getListCyclesQueryKey: () => ["cycles"],
    getGetSpendOverviewQueryKey: () => ["spend"],
    getGetBillingSummaryQueryKey: () => ["billing"],
    getListOpportunitiesQueryKey: () => ["opps"],
    getListJobsQueryKey: () => ["jobs"],
    getListCollectorsQueryKey: () => ["collectors"],
    getListMarketSignalsQueryKey: () => ["marketSignals"],
    getGetAlertsSummaryQueryKey: () => ["alerts"],
  };
});

// useMyRole hits /api/admin/whoami via fetch; mock it to grant org_admin
// so the wizard exposes the "Install sample data" action.
vi.mock("@/lib/use-my-role", () => ({
  useMyRole: () => ({
    data: {
      orgId: "org_test",
      email: "agent@test.local",
      roles: ["org_admin"],
      viaApiKey: false,
      authMode: "session",
    },
    isLoading: false,
    isOrgAdmin: true,
    isPlatformAdmin: false,
  }),
}));

// Imported AFTER vi.mock so the mocked module wins.
const { default: OnboardingPage } = await import("../src/pages/onboarding");
const { default: Dashboard } = await import("../src/pages/dashboard");
const { DataReadinessCard } = await import(
  "../src/components/data-readiness-card"
);

// ---- fixtures ----------------------------------------------------------

const NOW_ISO = "2026-04-30T00:00:00.000Z";

function freshOnboarding(): OnboardingState {
  return {
    currentStep: "welcome",
    completedSteps: [],
    startedAt: NOW_ISO,
    updatedAt: NOW_ISO,
    dismissed: false,
    completed: false,
    dismissedAt: null,
    completedAt: null,
  };
}

function freshReadiness(): Readiness {
  return {
    overallScore: 0,
    hasIngestedData: false,
    sampleDataInstalled: false,
    levers: [
      {
        leverId: "tail_spend_rationalization",
        label: "Tail-spend rationalization",
        tier: 1,
        score: 20,
        blockers: [
          {
            id: "po_lines.category",
            field: "po_lines.category_id",
            message: "PO lines need a category to bucket tail spend.",
            missingPct: 80,
            missingCount: 800,
            totalCount: 1000,
            fixUrl: "/spend",
            hard: true,
          },
        ],
      },
      {
        leverId: "supplier_consolidation",
        label: "Supplier consolidation",
        tier: 1,
        score: 30,
        blockers: [
          {
            id: "suppliers.category",
            field: "suppliers.category_id",
            message: "Suppliers need a category to roll up consolidation.",
            missingPct: 70,
            missingCount: 30,
            totalCount: 42,
            fixUrl: "/spend",
            hard: false,
          },
        ],
      },
      {
        leverId: "spot_vs_contract",
        label: "Spot vs contract",
        tier: 2,
        score: 0,
        blockers: [
          {
            id: "categories.code",
            field: "categories.code",
            message:
              "Category codes must match canonical PPI/CPI scope codes.",
            missingPct: 100,
            missingCount: 12,
            totalCount: 12,
            fixUrl: "/spend",
            hard: true,
          },
        ],
      },
      {
        leverId: "material_index_arbitrage",
        label: "Material index arbitrage",
        tier: 2,
        score: 0,
        blockers: [],
      },
    ],
  };
}

const ME = {
  org: {
    id: "org_test",
    slug: "test-org",
    name: "Test Org",
    disclosurePolicy: "standard" as const,
    contractRenewalAlertDays: 90,
    createdAt: "2026-01-01T00:00:00.000Z",
    successFeePct: 0.1,
  },
  actorEmail: "agent@test.local",
  user: {
    id: "user_1",
    email: "agent@test.local",
    name: "Agent",
  },
};

// ---- helpers -----------------------------------------------------------

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
    qc,
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
  mockState.onboarding = freshOnboarding();
  mockState.readiness = freshReadiness();
  mockState.cycles = [];
  mockState.me = ME;
  calls.patch = [];
  calls.install = 0;
  calls.remove = 0;
  calls.runCycle = 0;
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function expectNoConsoleNoise() {
  const errs = consoleErrorSpy.mock.calls.map((c: unknown[]) =>
    String(c[0] ?? ""),
  );
  const warns = consoleWarnSpy.mock.calls.map((c: unknown[]) =>
    String(c[0] ?? ""),
  );
  expect(errs, "console.error during render").toEqual([]);
  expect(warns, "console.warn during render").toEqual([]);
}

// ---- 1. Wizard happy path through all six steps -----------------------

describe("<OnboardingPage /> happy path", () => {
  test("renders all six steps in the pill rail with the welcome body first", () => {
    renderWithRouter(<OnboardingPage />);

    // Page chrome.
    expect(screen.getByTestId("onboarding-page")).toBeInTheDocument();
    expect(screen.getByText(/Get Atlas Procure ready/i)).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 6/i)).toBeInTheDocument();

    // Every step has a navigable pill.
    for (const key of [
      "welcome",
      "bring_data",
      "map_categories",
      "invite_team",
      "configure_settings",
      "run_first_cycle",
    ]) {
      expect(screen.getByTestId(`step-pill-${key}`)).toBeInTheDocument();
    }

    // Welcome body is the active step body.
    expect(screen.getByTestId("step-welcome")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("step-welcome")).getByText(
        /Atlas Procure turns your spend, contract and supplier data/i,
      ),
    ).toBeInTheDocument();

    expectNoConsoleNoise();
  });

  test("walks the full happy path: install sample data, advance through every step, finish setup", async () => {
    const user = userEvent.setup();
    renderWithRouter(<OnboardingPage />);

    // --- Step 1: welcome → mark done & continue ---
    await user.click(screen.getByTestId("step-advance"));
    expect(calls.patch).toContainEqual({ completedStep: "welcome" });
    expect(calls.patch).toContainEqual({ currentStep: "bring_data" });
    expect(screen.getByTestId("step-bring_data")).toBeInTheDocument();
    expect(screen.getByText(/Step 2 of 6/i)).toBeInTheDocument();

    // --- Step 2: bring data → install sample dataset ---
    const installBtn = screen.getByTestId("install-sample-data-btn");
    expect(installBtn).toBeEnabled();
    await user.click(installBtn);
    expect(calls.install).toBe(1);
    // After install the readiness summary lever list is rendered with
    // every lever now at 100%.
    const summary = await screen.findByTestId("bring-data-readiness");
    const items = within(summary).getAllByText(/100%/);
    expect(items.length).toBeGreaterThanOrEqual(4);
    // The action button has flipped from Install → Remove now that the
    // mutation marked sampleDataInstalled=true and notified subscribers.
    expect(screen.getByTestId("remove-sample-data-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("install-sample-data-btn")).toBeNull();

    // Advance off step 2.
    await user.click(screen.getByTestId("step-advance"));
    expect(calls.patch).toContainEqual({ completedStep: "bring_data" });
    expect(screen.getByTestId("step-map_categories")).toBeInTheDocument();
    expect(screen.getByText(/Step 3 of 6/i)).toBeInTheDocument();
    // Now that every lever is at 100, the PPI/CPI confirmation banner
    // flipped to its "confirmed" state on the map-categories step.
    expect(screen.getByTestId("ppi-cpi-status")).toHaveTextContent(
      /PPI\/CPI confirmed/i,
    );

    // --- Step 3 → 4 ---
    await user.click(screen.getByTestId("step-advance"));
    expect(calls.patch).toContainEqual({ completedStep: "map_categories" });
    expect(screen.getByTestId("step-invite_team")).toBeInTheDocument();
    expect(screen.getByText(/Step 4 of 6/i)).toBeInTheDocument();

    // --- Step 4 → 5 ---
    await user.click(screen.getByTestId("step-advance"));
    expect(calls.patch).toContainEqual({ completedStep: "invite_team" });
    expect(screen.getByTestId("step-configure_settings")).toBeInTheDocument();
    expect(screen.getByText(/Step 5 of 6/i)).toBeInTheDocument();

    // --- Step 5 → 6 ---
    await user.click(screen.getByTestId("step-advance"));
    expect(calls.patch).toContainEqual({
      completedStep: "configure_settings",
    });
    expect(screen.getByTestId("step-run_first_cycle")).toBeInTheDocument();
    expect(screen.getByText(/Step 6 of 6/i)).toBeInTheDocument();

    // --- Step 6: kick off the cycle, then finish setup ---
    const runBtn = screen.getByTestId("run-first-cycle-btn");
    expect(runBtn).toBeEnabled();
    await user.click(runBtn);
    expect(calls.runCycle).toBe(1);
    // The cycle-progress card surfaces the "completed" status the mock
    // returned synchronously.
    const cycleCard = await screen.findByTestId("cycle-progress");
    expect(cycleCard).toHaveTextContent(/Cycle #1/);
    expect(cycleCard).toHaveTextContent(/completed/i);
    // The "See your opportunities" CTA is the dashboard hand-off.
    expect(
      screen.getByTestId("cycle-go-to-dashboard"),
    ).toBeInTheDocument();

    // Finish setup → patches { completed: true } and renders the badge.
    await user.click(screen.getByTestId("step-advance"));
    expect(calls.patch).toContainEqual({ completedStep: "run_first_cycle" });
    expect(calls.patch).toContainEqual({ completed: true });
    expect(mockState.onboarding?.completed).toBe(true);
    expect(screen.getByText(/Setup complete/i)).toBeInTheDocument();

    expectNoConsoleNoise();
  });

  test("removing sample data on step 2 reverts the readiness card to the install state", async () => {
    const user = userEvent.setup();
    renderWithRouter(<OnboardingPage />);

    // Advance off the welcome step so we land on Bring data.
    await user.click(screen.getByTestId("step-advance"));
    expect(screen.getByTestId("step-bring_data")).toBeInTheDocument();

    // Install sample data first — this is the precondition for the
    // "Remove sample data" action being visible at all.
    await user.click(screen.getByTestId("install-sample-data-btn"));
    expect(calls.install).toBe(1);
    expect(mockState.readiness?.sampleDataInstalled).toBe(true);
    expect(screen.queryByTestId("install-sample-data-btn")).toBeNull();
    const removeBtn = await screen.findByTestId("remove-sample-data-btn");
    expect(removeBtn).toBeEnabled();

    // Now exercise the inverse mutation: useRemoveSampleData.
    await user.click(removeBtn);
    expect(calls.remove).toBe(1);
    expect(mockState.readiness?.sampleDataInstalled).toBe(false);

    // The action card should swap back to the install affordance and
    // hide the remove one — same UI as a tenant that never installed
    // the dataset in the first place.
    await waitFor(() => {
      expect(screen.getByTestId("install-sample-data-btn")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("remove-sample-data-btn")).toBeNull();

    expectNoConsoleNoise();
  });

  test("Back button rewinds the active step body without losing completed-step badges", async () => {
    const user = userEvent.setup();
    renderWithRouter(<OnboardingPage />);

    // Walk forward two steps: welcome → bring_data → map_categories.
    await user.click(screen.getByTestId("step-advance"));
    expect(screen.getByTestId("step-bring_data")).toBeInTheDocument();
    await user.click(screen.getByTestId("step-advance"));
    expect(screen.getByTestId("step-map_categories")).toBeInTheDocument();
    expect(screen.getByText(/Step 3 of 6/i)).toBeInTheDocument();

    // Sanity: both prior steps are tracked as completed in state.
    expect(
      mockState.onboarding?.completedSteps.map((c) => c.step),
    ).toEqual(expect.arrayContaining(["welcome", "bring_data"]));

    // Click "Back" — the active step body should rewind to bring_data,
    // and the patch stream should record the jump so the persisted
    // currentStep matches what the user is looking at.
    await user.click(screen.getByRole("button", { name: /Back/i }));
    expect(screen.getByTestId("step-bring_data")).toBeInTheDocument();
    expect(screen.queryByTestId("step-map_categories")).toBeNull();
    expect(screen.getByText(/Step 2 of 6/i)).toBeInTheDocument();
    expect(calls.patch).toContainEqual({ currentStep: "bring_data" });

    // The previously-completed welcome pill must keep its emerald
    // "done" styling — going backwards is a navigation aid, not a
    // reset of progress. The active bring_data pill flips to the
    // primary highlight, and the "Done" badge shows in the step
    // header because bring_data is in completedSteps.
    const welcomePill = screen.getByTestId("step-pill-welcome");
    expect(welcomePill.className).toMatch(/emerald/);
    const bringDataPill = screen.getByTestId("step-pill-bring_data");
    expect(bringDataPill.className).toMatch(/border-primary/);
    expect(
      within(screen.getByTestId("step-bring_data")).getByText(/^Done$/),
    ).toBeInTheDocument();

    // Now jump directly via the step pill back to welcome — same
    // contract: body rewinds, completed pills keep their styling.
    await user.click(screen.getByTestId("step-pill-welcome"));
    expect(screen.getByTestId("step-welcome")).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 6/i)).toBeInTheDocument();
    expect(calls.patch).toContainEqual({ currentStep: "welcome" });
    // bring_data was completed before the jump and must stay green.
    expect(
      screen.getByTestId("step-pill-bring_data").className,
    ).toMatch(/emerald/);
    // Completed steps survived the round-trip.
    expect(
      mockState.onboarding?.completedSteps.map((c) => c.step),
    ).toEqual(expect.arrayContaining(["welcome", "bring_data"]));

    expectNoConsoleNoise();
  });

  test("'Skip for now' patches dismissed=true and navigates back to /", async () => {
    const user = userEvent.setup();
    const { memory } = renderWithRouter(<OnboardingPage />, {
      initialPath: "/onboarding",
    });

    await user.click(screen.getByRole("button", { name: /Skip for now/i }));

    expect(calls.patch).toContainEqual({ dismissed: true });
    expect(mockState.onboarding?.dismissed).toBe(true);
    // The dismiss handler navigates back to the dashboard root.
    await waitFor(() => {
      expect(memory.history[memory.history.length - 1]).toBe("/");
    });

    expectNoConsoleNoise();
  });
});

// ---- 2. Dashboard auto-redirect & dismissed/completed memory ----------

describe("<Dashboard /> onboarding auto-redirect", () => {
  test("redirects to /onboarding on a fresh tenant with no ingested data", async () => {
    // Fresh tenant defaults: hasIngestedData=false, dismissed=false,
    // completed=false. The useEffect should setLocation('/onboarding')
    // on the first render after the queries resolve.
    const { memory } = renderWithRouter(<Dashboard />, { initialPath: "/" });

    await waitFor(() => {
      expect(memory.history[memory.history.length - 1]).toBe("/onboarding");
    });

    expectNoConsoleNoise();
  });

  test("does NOT redirect when the wizard has been dismissed", async () => {
    mockState.onboarding = {
      ...freshOnboarding(),
      dismissed: true,
      dismissedAt: NOW_ISO,
    };

    const { memory } = renderWithRouter(<Dashboard />, { initialPath: "/" });

    // Allow effects + any pending microtasks to flush, then assert the
    // dashboard stayed put.
    await act(async () => {
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(memory.history[memory.history.length - 1]).toBe("/");
    expect(memory.history).not.toContain("/onboarding");

    expectNoConsoleNoise();
  });

  test("does NOT redirect when the wizard is already marked completed", async () => {
    mockState.onboarding = {
      ...freshOnboarding(),
      completed: true,
      completedAt: NOW_ISO,
    };

    const { memory } = renderWithRouter(<Dashboard />, { initialPath: "/" });

    await act(async () => {
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(memory.history[memory.history.length - 1]).toBe("/");
    expect(memory.history).not.toContain("/onboarding");

    expectNoConsoleNoise();
  });

  test("does NOT redirect once the tenant has ingested data, even on a fresh wizard", async () => {
    mockState.readiness = {
      ...freshReadiness(),
      hasIngestedData: true,
    };

    const { memory } = renderWithRouter(<Dashboard />, { initialPath: "/" });

    await act(async () => {
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(memory.history[memory.history.length - 1]).toBe("/");
    expect(memory.history).not.toContain("/onboarding");

    expectNoConsoleNoise();
  });
});

// ---- 3. <DataReadinessCard /> all-good state ---------------------------

describe("<DataReadinessCard />", () => {
  test("shows the per-lever blocker list when any lever is below 100", () => {
    // Once data has been ingested, the card switches from the
    // "Open setup wizard" CTA to the per-lever gap list.
    mockState.readiness = {
      ...freshReadiness(),
      hasIngestedData: true,
      overallScore: 35,
    };
    renderWithRouter(<DataReadinessCard basePath="" />);

    // Persistent card mounts, score badge reflects overallScore.
    expect(screen.getByTestId("data-readiness-card")).toBeInTheDocument();
    expect(screen.getByTestId("readiness-lever-list")).toBeInTheDocument();
    // The all-good banner is NOT rendered while any lever is < 100.
    expect(
      screen.queryByText(/Every lever has the data it needs/i),
    ).toBeNull();

    expectNoConsoleNoise();
  });

  test("swaps to the all-good state once every lever reaches 100", () => {
    mockState.readiness = {
      overallScore: 100,
      hasIngestedData: true,
      sampleDataInstalled: true,
      levers: [
        {
          leverId: "tail_spend_rationalization",
          label: "Tail-spend rationalization",
          tier: 1,
          score: 100,
          blockers: [],
        },
        {
          leverId: "supplier_consolidation",
          label: "Supplier consolidation",
          tier: 1,
          score: 100,
          blockers: [],
        },
        {
          leverId: "spot_vs_contract",
          label: "Spot vs contract",
          tier: 2,
          score: 100,
          blockers: [],
        },
      ],
    };

    renderWithRouter(<DataReadinessCard basePath="" />);

    expect(screen.getByTestId("data-readiness-card")).toBeInTheDocument();
    expect(
      screen.getByText(/Every lever has the data it needs/i),
    ).toBeInTheDocument();
    // The per-lever gap list is gone — that was the wizard's "are we
    // done?" signal and is the visible payoff for completing setup.
    expect(screen.queryByTestId("readiness-lever-list")).toBeNull();

    expectNoConsoleNoise();
  });
});
