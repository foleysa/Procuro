/**
 * Regression test for the War Room auto-refresh behavior on the Fusion
 * Center events tab.
 *
 * The pane is supposed to:
 *   1. Poll `/api/intelligence/events` periodically (no manual refresh).
 *   2. Decorate any event ids that arrive *after* the initial render
 *      with a "NEW" badge that is visible to operators.
 *   3. Let the operator pause the live view so the list freezes on
 *      whatever events are currently visible (so they can read a
 *      specific incident without it scrolling away). Polling
 *      continues in the background while paused, and a "X new events
 *      queued — resume" affordance surfaces in the header so the user
 *      knows there's fresh data waiting behind the freeze.
 *
 * We mock `fetch` so every call to `/api/intelligence/events` returns
 * a controllable payload, then drive the React Query cache by
 * advancing fake timers past the poll interval. We also stub `useGetMe`
 * so `usePolicy()` doesn't hit the network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/api-client-react")
  >("@workspace/api-client-react");
  return {
    ...actual,
    useGetMe: () => ({
      data: {
        user: { id: "u_test", email: "t@t" },
        org: { id: "o_test", name: "Test", disclosurePolicy: "standard" },
      },
      isLoading: false,
      error: null,
    }),
    useListSuppliers: () => ({ data: { items: [] }, isLoading: false }),
  };
});

import Fusion from "../src/pages/fusion";

interface EventRow {
  id: string;
  signalType: string;
  observedAt: string;
  title: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  severity: number | null;
  actor: string | null;
  eventCode: string | null;
  tier: "T1" | "T2" | "T3" | "T4";
  source: {
    collectorId: string;
    collectorName: string;
    sourceUrl: string;
    observedAt: string;
    contract: {
      postureClass: "public_api" | "tos_restricted" | "gray_hat";
      disclosureTier: "T1" | "T2" | "T3" | "T4";
      jurisdiction: string;
      retentionDays: number;
      tenantOptInDefault: boolean;
    };
  };
  impactPath: null;
}

function ev(id: string, title: string): EventRow {
  return {
    id,
    signalType: "event_geocoded",
    observedAt: new Date().toISOString(),
    title,
    country: "US",
    lat: null,
    lng: null,
    severity: 5,
    actor: null,
    eventCode: null,
    tier: "T2",
    source: {
      collectorId: "col_1",
      collectorName: "Test Collector",
      sourceUrl: "https://example.test/source",
      observedAt: new Date().toISOString(),
      contract: {
        postureClass: "public_api",
        disclosureTier: "T2",
        jurisdiction: "GLOBAL",
        retentionDays: 30,
        tenantOptInDefault: true,
      },
    },
    impactPath: null,
  };
}

let eventQueue: EventRow[] = [];
const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : (input as URL).toString();
  if (url.includes("/api/intelligence/events")) {
    return new Response(
      JSON.stringify({
        items: eventQueue,
        droppedByPolicy: 0,
        droppedBySeverity: 0,
        policy: "standard",
        windowHours: 72,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  // Anything else (e.g. /api/me if not mocked) — return an empty 200.
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  eventQueue = [ev("e1", "Initial event A"), ev("e2", "Initial event B")];
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderEventsTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const { hook } = memoryLocation({ path: "/fusion?tab=events", record: true });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <Fusion />
      </Router>
    </QueryClientProvider>,
  );
}

describe("War Room auto-refresh", () => {
  test("polls for new events and surfaces a NEW badge on arrivals", async () => {
    renderEventsTab();

    await waitFor(() =>
      expect(screen.getByTestId("event-row-e1")).toBeInTheDocument(),
    );
    // Initial-load events are not NEW — they're just history.
    expect(screen.getByTestId("event-row-e1")).toHaveAttribute(
      "data-new",
      "false",
    );
    expect(screen.queryByTestId("event-row-new-e1")).toBeNull();

    // A new event arrives on the next poll.
    eventQueue = [ev("e3", "Breaking incident"), ...eventQueue];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });

    await waitFor(() =>
      expect(screen.getByTestId("event-row-e3")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("event-row-e3")).toHaveAttribute(
      "data-new",
      "true",
    );
    expect(screen.getByTestId("event-row-new-e3")).toBeInTheDocument();
    // Pre-existing rows must not retroactively grow a NEW badge.
    expect(screen.getByTestId("event-row-e1")).toHaveAttribute(
      "data-new",
      "false",
    );
  });

  test("pause toggle freezes the visible list while still tracking queued arrivals", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEventsTab();

    await waitFor(() =>
      expect(screen.getByTestId("event-row-e1")).toBeInTheDocument(),
    );

    // Operator clicks Pause.
    await user.click(screen.getByTestId("war-room-pause-toggle"));
    expect(screen.getByTestId("war-room-pause-state")).toHaveTextContent(
      /paused/i,
    );

    // While paused, the backend continues to surface new events, but
    // the visible list must not change so the analyst can read the
    // event they're focused on.
    eventQueue = [ev("e9", "Latest while paused"), ...eventQueue];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(screen.queryByTestId("event-row-e9")).toBeNull();
    expect(screen.getByTestId("event-row-e1")).toBeInTheDocument();

    // The pane surfaces a "queued events" affordance so the operator
    // knows fresh data is waiting behind the freeze.
    await waitFor(() =>
      expect(screen.getByTestId("war-room-queued-button")).toHaveTextContent(
        /1 new event/i,
      ),
    );

    // Resume by clicking the queued-events affordance — list catches
    // up immediately and the new event renders with the NEW badge.
    await user.click(screen.getByTestId("war-room-queued-button"));
    await waitFor(() =>
      expect(screen.getByTestId("event-row-e9")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("event-row-e9")).toHaveAttribute(
      "data-new",
      "true",
    );
    expect(screen.getByTestId("war-room-pause-state")).toHaveTextContent(
      /live/i,
    );
  });
});
