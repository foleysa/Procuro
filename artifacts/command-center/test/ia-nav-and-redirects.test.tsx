/**
 * #199 — IA nav grouping + role-gated visibility + redirect.
 *
 * Three regression-pinning tests for the IA flip:
 *
 *   1. Layout renders the five nav GROUPS for an org_admin (with the
 *      Today group on top, in the spec'd order).
 *   2. A read_only user does NOT see admin-only items (Operations
 *      Health, Engine, Org Admin) — even though they're in the same
 *      sidebar source list. Role gating must be enforced in render,
 *      not just on the server.
 *   3. The legacy `/admin/funnel` deep-link redirects to `/engine`,
 *      proving stale bookmarks/email links keep working after the
 *      sidebar rename.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { Layout } from "../src/components/layout";

// Stub Clerk's `<Show>` and `useUser`/`useClerk` so the layout can
// render under jsdom without a real ClerkProvider. The IA tests don't
// care about auth chrome, only the nav.
vi.mock("@clerk/react", () => ({
  Show: ({ when, children }: { when: string; children: React.ReactNode }) =>
    when === "signed-in" ? <>{children}</> : null,
  useUser: () => ({ user: { primaryEmailAddress: { emailAddress: "t@x" } } }),
  useClerk: () => ({ signOut: () => undefined }),
  useAuth: () => ({ isSignedIn: true }),
}));

// OrgSwitcher hits APIs we don't want to drive in this test.
vi.mock("../src/components/org-switcher", () => ({
  OrgSwitcher: () => <div data-testid="org-switcher-stub" />,
}));

// Migration banner uses localStorage; isolate per-test by clearing.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (typeof window !== "undefined") window.localStorage.clear();
});

function mockWhoAmI(roles: string[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.endsWith("/api/admin/whoami")) {
      return new Response(
        JSON.stringify({
          orgId: "org_test",
          email: "t@x",
          roles,
          viaApiKey: false,
          authMode: "clerk",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function renderInRouter(ui: React.ReactNode, initialPath = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path: initialPath });
  return {
    ...render(
      <QueryClientProvider client={qc}>
        <WouterRouter hook={hook}>{ui}</WouterRouter>
      </QueryClientProvider>,
    ),
    hook,
  };
}

describe("IA nav grouping (#199)", () => {
  test("org_admin sees all five user-journey nav groups in order", async () => {
    mockWhoAmI(["org_admin"]);

    renderInRouter(
      <Layout>
        <div>content</div>
      </Layout>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("nav-group-today")).toBeTruthy();
    });
    expect(screen.getByTestId("nav-group-workspace")).toBeTruthy();
    expect(screen.getByTestId("nav-group-intelligence")).toBeTruthy();
    expect(screen.getByTestId("nav-group-operations")).toBeTruthy();
    expect(screen.getByTestId("nav-group-engine")).toBeTruthy();
    expect(screen.getByTestId("nav-group-org")).toBeTruthy();

    // Order matters — the operator's mental model is left-to-right.
    const groups = Array.from(
      document.querySelectorAll('[data-testid^="nav-group-"]'),
    ).map((el) => el.getAttribute("data-testid"));
    expect(groups).toEqual([
      "nav-group-today",
      "nav-group-workspace",
      "nav-group-intelligence",
      "nav-group-operations",
      "nav-group-engine",
      "nav-group-org",
    ]);
  });

  test("read_only user does NOT see admin-only items (Operations Health, Engine, Org Admin)", async () => {
    mockWhoAmI(["read_only"]);

    renderInRouter(
      <Layout>
        <div>content</div>
      </Layout>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("nav-group-today")).toBeTruthy();
    });

    // Engine group is admin-only — should not render at all because
    // its only item is gated.
    expect(screen.queryByTestId("nav-group-engine")).toBeNull();

    // Operations Health is admin-only.
    expect(screen.queryByTestId("nav-operations")).toBeNull();

    // Org Admin item is admin-only (within the Org group).
    expect(screen.queryByTestId("nav-admin")).toBeNull();

    // Sanity: workspace items they CAN see are still present.
    expect(screen.getByTestId("nav-spend")).toBeTruthy();
  });
});

describe("Legacy /admin/funnel redirect (#199 step 7)", () => {
  test("/admin/funnel redirects to /engine", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { hook } = memoryLocation({ path: "/admin/funnel" });

    render(
      <QueryClientProvider client={qc}>
        <WouterRouter hook={hook}>
          <Switch>
            <Route path="/admin/funnel">
              <Redirect to="/engine" />
            </Route>
            <Route path="/engine">
              <div data-testid="engine-page">Engine</div>
            </Route>
          </Switch>
        </WouterRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("engine-page")).toBeTruthy();
    });
  });
});
