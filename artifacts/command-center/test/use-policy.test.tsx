/**
 * Regression coverage for `usePolicy()` — the single resolver that decides
 * which `TenantPolicy` ("conservative" | "standard" | "analyst") flows
 * into every `<InsightCitations>` on the page.
 *
 * A bug here is silent and high-impact: a tenant on `conservative` could
 * suddenly see T3/T4 attributions, or an `analyst` org could lose
 * provenance trails, with no compile-time signal. We pin the contract
 * by stubbing `useGetMe` (the cached `/me` query) and asserting the
 * resolver's behavior across:
 *   1. Each known policy passes through unchanged.
 *   2. Unknown / missing / null `disclosurePolicy` falls back to
 *      `"standard"` — matching the API server's default for orgs whose
 *      `settings.disclosurePolicy` is missing.
 *   3. Pre-resolution (no `/me` data yet) returns `"standard"` so
 *      consumers never need an `undefined` branch.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const mockState: { data: unknown } = { data: undefined };

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/api-client-react")
  >("@workspace/api-client-react");
  return {
    ...actual,
    useGetMe: () => ({
      data: mockState.data,
      isLoading: false,
      error: null,
    }),
  };
});

// Imported AFTER vi.mock so the mocked module wins.
import { usePolicy } from "../src/lib/use-policy";

function setMe(disclosurePolicy: unknown) {
  mockState.data = {
    user: { id: "u_test", email: "t@t", name: "Tester" },
    org: { id: "o_test", name: "Test Org", disclosurePolicy },
  };
}

beforeEach(() => {
  mockState.data = undefined;
});

describe("usePolicy", () => {
  test("passes through 'conservative' unchanged", () => {
    setMe("conservative");
    const { result } = renderHook(() => usePolicy());
    expect(result.current).toBe("conservative");
  });

  test("passes through 'standard' unchanged", () => {
    setMe("standard");
    const { result } = renderHook(() => usePolicy());
    expect(result.current).toBe("standard");
  });

  test("passes through 'analyst' unchanged", () => {
    setMe("analyst");
    const { result } = renderHook(() => usePolicy());
    expect(result.current).toBe("analyst");
  });

  test("falls back to 'standard' for an unknown policy value", () => {
    // Simulate a server that somehow returns a value outside the
    // documented union (older client, schema drift, etc.). The hook
    // must not propagate the unknown value.
    setMe("permissive");
    const { result } = renderHook(() => usePolicy());
    expect(result.current).toBe("standard");
  });

  test("falls back to 'standard' when disclosurePolicy is missing", () => {
    mockState.data = {
      user: { id: "u_test", email: "t@t", name: "Tester" },
      org: { id: "o_test", name: "Test Org" },
    };
    const { result } = renderHook(() => usePolicy());
    expect(result.current).toBe("standard");
  });

  test("falls back to 'standard' when disclosurePolicy is null", () => {
    setMe(null);
    const { result } = renderHook(() => usePolicy());
    expect(result.current).toBe("standard");
  });

  test("returns 'standard' before /me has resolved", () => {
    // mockState.data is reset to undefined by beforeEach, mirroring the
    // initial React Query state on first render.
    const { result } = renderHook(() => usePolicy());
    expect(result.current).toBe("standard");
  });
});
