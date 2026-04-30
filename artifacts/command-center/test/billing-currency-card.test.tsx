/**
 * #55 — Supplier 360 BillingCurrencyCard render + override flow.
 *
 * Pins the contract that:
 *
 *   1. Auto-detected rows surface the ISO chip, the confidence badge,
 *      and the human-readable source label that maps onto the persisted
 *      `billing_currency_source` column.
 *   2. A null currency renders the empty-state copy (no chip, no badge)
 *      so we never silently render `undefined` to the user.
 *   3. The override form posts to the React Query mutation with the
 *      uppercased ISO code and surfaces a validation error for malformed
 *      input WITHOUT calling the network.
 *
 * The mutation hook is replaced with a vi-mocked stub that records the
 * request — this keeps the test fully offline. The intelligence
 * invalidation key is also asserted so a future refactor of the React
 * Query key shape can't silently break the cache invalidation.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BillingCurrencyConfidence,
  BillingCurrencySource,
  type SupplierIntelligenceResponse,
} from "@workspace/api-client-react";

// ---- mutation hook mock --------------------------------------------------
//
// `useOverrideSupplierBillingCurrency` is the orval-generated React Query
// mutation. We replace it with a stub that exposes `mutate` so tests can
// assert what would have been sent over the wire and inspect the
// invalidation hook wired up via `mutation.onSuccess`.

const mutateSpy = vi.fn();
let lastMutationOptions: {
  mutation?: {
    onSuccess?: (data: unknown) => void;
    onError?: (err: unknown) => void;
  };
} | null = null;
let mutationPending = false;

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    useOverrideSupplierBillingCurrency: (
      opts:
        | {
            mutation?: {
              onSuccess?: (data: unknown) => void;
              onError?: (err: unknown) => void;
            };
          }
        | undefined,
    ) => {
      lastMutationOptions = opts ?? null;
      return {
        mutate: mutateSpy,
        isPending: mutationPending,
      };
    },
  };
});

// Imported after the mock so the page picks up the stub.
const { BillingCurrencyCard } = await import(
  "../src/pages/supplier-detail"
);
const { getGetSupplierIntelligenceQueryKey } = await import(
  "@workspace/api-client-react"
);

// ---- helpers -------------------------------------------------------------

function makeData(
  overrides: Partial<SupplierIntelligenceResponse> = {},
): SupplierIntelligenceResponse {
  return {
    supplierId: "sup_test_1",
    supplierName: "Acme GmbH",
    countryCode: "DE",
    billingCurrency: "EUR",
    billingCurrencySource: BillingCurrencySource.country,
    billingCurrencyConfidence: BillingCurrencyConfidence.high,
    resolvedEntityUid: null,
    totalCount: 0,
    items: [],
    ...overrides,
  };
}

function renderCard(data: SupplierIntelligenceResponse) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <BillingCurrencyCard data={data} />
      </QueryClientProvider>,
    ),
  };
}

// ---- lifecycle -----------------------------------------------------------

beforeEach(() => {
  mutateSpy.mockReset();
  lastMutationOptions = null;
  mutationPending = false;
});

afterEach(() => {
  cleanup();
});

// ---- tests --------------------------------------------------------------

describe("<BillingCurrencyCard />", () => {
  test("renders ISO chip, confidence badge, and source label for an auto-detected row", () => {
    renderCard(makeData());

    expect(screen.getByTestId("text-billing-currency").textContent).toBe(
      "EUR",
    );
    const badge = screen.getByTestId("badge-billing-confidence");
    expect(badge.textContent).toMatch(/high confidence/i);
    expect(badge.getAttribute("data-confidence")).toBe("high");

    const source = screen.getByTestId("text-billing-source");
    expect(source.getAttribute("data-source")).toBe("country");
    expect(source.textContent).toMatch(/auto-detected from country/i);
  });

  test("uses the manual_override label when a human set the currency", () => {
    renderCard(
      makeData({
        billingCurrencySource: BillingCurrencySource.manual_override,
      }),
    );
    const source = screen.getByTestId("text-billing-source");
    expect(source.getAttribute("data-source")).toBe("manual_override");
    expect(source.textContent).toMatch(/manually overridden/i);
  });

  test("renders empty-state copy and no chip when no currency is set", () => {
    renderCard(
      makeData({
        billingCurrency: null,
        billingCurrencySource: null,
        billingCurrencyConfidence: null,
      }),
    );
    expect(screen.queryByTestId("text-billing-currency")).toBeNull();
    expect(screen.queryByTestId("badge-billing-confidence")).toBeNull();
    expect(screen.queryByTestId("text-billing-source")).toBeNull();
    expect(
      screen.getByTestId("text-billing-currency-empty").textContent,
    ).toMatch(/defaults to org base currency/i);
  });

  test("submitting a valid ISO override calls the mutation with the supplier id and uppercased code", async () => {
    const user = userEvent.setup();
    const data = makeData();
    renderCard(data);

    const input = screen.getByTestId(
      "input-billing-currency-override",
    ) as HTMLInputElement;
    await user.type(input, "jpy");
    await user.click(
      screen.getByTestId("button-billing-currency-override"),
    );

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    expect(mutateSpy).toHaveBeenCalledWith({
      id: data.supplierId,
      data: { billingCurrency: "JPY" },
    });
  });

  test("blocks submission and surfaces an inline error for malformed input", async () => {
    const user = userEvent.setup();
    renderCard(makeData());

    const input = screen.getByTestId(
      "input-billing-currency-override",
    ) as HTMLInputElement;
    await user.type(input, "EU"); // too short
    await user.click(
      screen.getByTestId("button-billing-currency-override"),
    );

    expect(mutateSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("text-billing-error").textContent).toMatch(
      /3-letter iso/i,
    );
  });

  test("onSuccess invalidates the supplier-intelligence query for THIS supplier", async () => {
    const user = userEvent.setup();
    const data = makeData({ supplierId: "sup_target_42" });
    const { qc } = renderCard(data);

    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const input = screen.getByTestId(
      "input-billing-currency-override",
    ) as HTMLInputElement;
    await user.type(input, "GBP");
    await user.click(
      screen.getByTestId("button-billing-currency-override"),
    );

    // Simulate the server response — orval calls the supplied
    // `mutation.onSuccess` with the new row body.
    expect(lastMutationOptions?.mutation?.onSuccess).toBeTypeOf("function");
    lastMutationOptions?.mutation?.onSuccess?.({
      id: data.supplierId,
      billingCurrency: "GBP",
      billingCurrencySource: "manual_override",
      billingCurrencyConfidence: "high",
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: getGetSupplierIntelligenceQueryKey(data.supplierId),
      });
    });

    // Draft input cleared after a successful save.
    expect(
      (
        screen.getByTestId(
          "input-billing-currency-override",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });
});
