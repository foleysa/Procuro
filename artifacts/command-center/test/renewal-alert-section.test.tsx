/**
 * Task #154 — UI coverage for the "Renewal alert lead time" control on
 * the Settings page.
 *
 * The control writes through `usePatchMeSettings` (PATCH /api/me/settings
 * with `contractRenewalAlertDays`) and reads the current value via
 * `useGetMe`. Server-side bounds (1..365) are pinned by the
 * `PatchMeSettingsBody` Zod schema and the `readRenewalAlertDays`
 * helper; this file mirrors those bounds at the UI layer so a refactor
 * cannot silently:
 *
 *   1. Send a value the server would reject (raw 400 instead of a
 *      friendly inline error).
 *   2. Enable the Save button while the input is blank or out of range.
 *   3. Forget to seed the input from the cached `/me` response.
 *
 * The Notifications tab also hosts the channels/subscriptions cards;
 * we mock all of their hooks at empty so the renewal-alert card
 * renders deterministically without their loading states getting in
 * the way.
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
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Radix Select / Tabs use pointer-capture + scrollIntoView under the
// hood; jsdom ships neither, which causes silent failures when the
// suite tries to switch to the Notifications tab via userEvent.
if (!(Element.prototype as unknown as { hasPointerCapture?: unknown })
  .hasPointerCapture) {
  Element.prototype.hasPointerCapture = (() => false) as Element["hasPointerCapture"];
}
if (!(Element.prototype as unknown as { releasePointerCapture?: unknown })
  .releasePointerCapture) {
  Element.prototype.releasePointerCapture =
    (() => undefined) as Element["releasePointerCapture"];
}
if (!(Element.prototype as unknown as { setPointerCapture?: unknown })
  .setPointerCapture) {
  Element.prototype.setPointerCapture =
    (() => undefined) as Element["setPointerCapture"];
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView =
    (() => undefined) as Element["scrollIntoView"];
}

// ---- mock state --------------------------------------------------------

const { mockState, patchSpy } = vi.hoisted(() => {
  return {
    mockState: {
      me: {
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
        user: {
          id: "u_test",
          email: "agent@test.local",
          name: "Agent",
          role: "admin" as const,
        },
      } as unknown,
    },
    patchSpy: vi.fn<(args: { data: unknown }) => unknown>(),
  };
});

vi.mock("@workspace/api-client-react", () => {
  const wrap = <T,>(data: T) => ({
    data,
    isLoading: false,
    isFetching: false,
    error: undefined,
  });
  // Provide a minimal mutation surface — the component only touches
  // `mutate` and `isPending` on the returned object.
  type MutationOpts = {
    onSuccess?: (resp: unknown) => void;
    onError?: (e: Error) => void;
  };
  return {
    // Reads
    useGetMe: () => wrap(mockState.me),
    useListMeSettingsAudit: () => wrap([]),
    useListAlertChannels: () => wrap({ items: [] }),
    useListAlertSubscriptions: () => wrap({ items: [] }),
    useListWatchlists: () => wrap({ items: [] }),

    // The mutation hook the renewal-alert card uses. `mutate` records
    // the call and synthesises a successful PATCH response by merging
    // the new `contractRenewalAlertDays` into the cached `me` org.
    usePatchMeSettings: ({ mutation }: { mutation?: MutationOpts } = {}) => ({
      mutate: (args: { data: { contractRenewalAlertDays?: number } }) => {
        patchSpy(args);
        const me = mockState.me as {
          org: { contractRenewalAlertDays: number };
        };
        const next = {
          ...me,
          org: {
            ...me.org,
            contractRenewalAlertDays:
              args.data.contractRenewalAlertDays ?? me.org.contractRenewalAlertDays,
          },
        };
        mockState.me = next;
        mutation?.onSuccess?.(next);
      },
      isPending: false,
    }),
    // Other mutation hooks the Notifications tab also wires up; the
    // renewal-alert tests don't exercise these but they need to exist
    // so the component renders without throwing.
    useCreateAlertChannel: () => ({ mutate: vi.fn(), isPending: false }),
    usePatchAlertChannel: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteAlertChannel: () => ({ mutate: vi.fn(), isPending: false }),
    useTestAlertChannel: () => ({
      mutate: vi.fn(),
      isPending: false,
      variables: undefined,
    }),
    useCreateAlertSubscription: () => ({ mutate: vi.fn(), isPending: false }),
    usePatchAlertSubscription: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteAlertSubscription: () => ({ mutate: vi.fn(), isPending: false }),

    // Query-key helpers — only used to wire up cache invalidation.
    getGetMeQueryKey: () => ["me"],
    getListMeSettingsAuditQueryKey: () => ["meSettingsAudit"],
    getListAlertChannelsQueryKey: () => ["alertChannels"],
    getListAlertSubscriptionsQueryKey: () => ["alertSubscriptions"],
    getListWatchlistsQueryKey: () => ["watchlists"],
  };
});

const { default: Settings } = await import("../src/pages/settings");

// ---- helpers -----------------------------------------------------------

function renderSettings() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const memory = memoryLocation({ path: "/settings", record: true });
  // Bypass userEvent's pointer-events check so Radix tabs respond
  // reliably under jsdom.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  return {
    user,
    ...render(
      <QueryClientProvider client={qc}>
        <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
          <Settings />
        </WouterRouter>
      </QueryClientProvider>,
    ),
  };
}

async function openNotificationsTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("tab-notifications"));
  // The renewal-alert card sits at the top of the Notifications pane.
  await screen.findByTestId("card-renewal-alert");
}

beforeEach(() => {
  // Reset the cached `me` to the canonical baseline before every test
  // so prior mutations don't leak state across cases.
  mockState.me = {
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
    user: {
      id: "u_test",
      email: "agent@test.local",
      name: "Agent",
      role: "admin" as const,
    },
  };
  patchSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---- tests -------------------------------------------------------------

describe("<Settings /> renewal alert lead time", () => {
  test("seeds the input from the saved org value and disables Save until a change is entered", async () => {
    const { user } = renderSettings();
    await openNotificationsTab(user);

    const input = screen.getByTestId(
      "input-renewal-alert-days",
    ) as HTMLInputElement;
    expect(input.value).toBe("90");

    const saveBtn = screen.getByTestId(
      "button-save-renewal-alert",
    ) as HTMLButtonElement;
    expect(saveBtn).toBeDisabled();
    // No inline error before the user touches the field.
    expect(
      screen.queryByTestId("text-renewal-alert-error"),
    ).not.toBeInTheDocument();
  });

  test("blocks save and shows a friendly error for empty input", async () => {
    const { user } = renderSettings();
    await openNotificationsTab(user);

    const input = screen.getByTestId(
      "input-renewal-alert-days",
    ) as HTMLInputElement;
    await user.clear(input);

    expect(input.value).toBe("");
    const err = await screen.findByTestId("text-renewal-alert-error");
    expect(err.textContent ?? "").toMatch(/1 and 365/);
    expect(
      screen.getByTestId("button-save-renewal-alert"),
    ).toBeDisabled();
    expect(patchSpy).not.toHaveBeenCalled();
  });

  test.each<[label: string, value: string]>([
    ["below the lower bound (0)", "0"],
    ["above the upper bound (500)", "500"],
  ])("blocks save and shows a bounds error for %s", async (_label, value) => {
    const { user } = renderSettings();
    await openNotificationsTab(user);

    const input = screen.getByTestId(
      "input-renewal-alert-days",
    ) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, value);

    const err = await screen.findByTestId("text-renewal-alert-error");
    expect(err.textContent ?? "").toMatch(/1.*365|365.*1/);
    expect(
      screen.getByTestId("button-save-renewal-alert"),
    ).toBeDisabled();
    expect(patchSpy).not.toHaveBeenCalled();
  });

  test("enables Save for a valid changed value and PATCHes /me/settings with the parsed integer", async () => {
    const { user } = renderSettings();
    await openNotificationsTab(user);

    const input = screen.getByTestId(
      "input-renewal-alert-days",
    ) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "45");

    // No inline error for a valid in-range value.
    expect(
      screen.queryByTestId("text-renewal-alert-error"),
    ).not.toBeInTheDocument();

    const saveBtn = screen.getByTestId(
      "button-save-renewal-alert",
    ) as HTMLButtonElement;
    await waitFor(() => expect(saveBtn).not.toBeDisabled());

    await user.click(saveBtn);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledTimes(1);
    });
    expect(patchSpy).toHaveBeenCalledWith({
      data: { contractRenewalAlertDays: 45 },
    });
  });

  test("does not enable Save when the typed value matches the saved value", async () => {
    const { user } = renderSettings();
    await openNotificationsTab(user);

    const input = screen.getByTestId(
      "input-renewal-alert-days",
    ) as HTMLInputElement;
    // Re-type the same saved value (90) — dirty in string terms, but
    // not a meaningful change, so Save must stay disabled.
    await user.clear(input);
    await user.type(input, "90");

    expect(
      screen.queryByTestId("text-renewal-alert-error"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("button-save-renewal-alert"),
    ).toBeDisabled();
    expect(patchSpy).not.toHaveBeenCalled();
  });
});
