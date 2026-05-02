// Suppliers list page (#139): confidence chip, low-confidence highlight
// + sort, low-confidence quick filter, and inline override popover.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  BillingCurrencyConfidence,
  BillingCurrencySource,
  type Supplier,
  type SupplierListResponse,
} from "@workspace/api-client-react";

const mutateSpy = vi.fn();
let lastMutationOptions: {
  mutation?: {
    onSuccess?: (data: unknown) => void;
    onError?: (err: unknown) => void;
  };
} | null = null;
let mutationPending = false;

let lastListParams: Record<string, unknown> | undefined;
let listResponse: SupplierListResponse = { items: [], nextCursor: null };

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/api-client-react")
  >("@workspace/api-client-react");
  return {
    ...actual,
    useListSuppliers: (params?: Record<string, unknown>) => {
      lastListParams = params;
      return {
        data: listResponse,
        isLoading: false,
        isFetching: false,
        error: null,
      };
    },
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
      return { mutate: mutateSpy, isPending: mutationPending };
    },
  };
});

const { default: Suppliers } = await import("../src/pages/suppliers");
const { getListSuppliersQueryKey, getGetSupplierQueryKey } = await import(
  "@workspace/api-client-react"
);

function makeSupplier(overrides: Partial<Supplier> = {}): Supplier {
  return {
    id: "sup_default",
    name: "Default Co",
    countryCode: "US",
    billingCurrency: "USD",
    billingCurrencySource: BillingCurrencySource.country,
    billingCurrencyConfidence: BillingCurrencyConfidence.high,
    paymentTermsDays: "30",
    isStrategic: false,
    isPreferred: false,
    tags: [],
    internalNotes: null,
    ...overrides,
  };
}

function renderPage(initialPath = "/suppliers") {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const { hook } = memoryLocation({ path: initialPath });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <Router hook={hook}>
          <Suppliers />
        </Router>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  mutateSpy.mockReset();
  lastMutationOptions = null;
  mutationPending = false;
  lastListParams = undefined;
  listResponse = { items: [], nextCursor: null };
});

afterEach(() => {
  cleanup();
});

describe("Suppliers list — billing-currency confidence", () => {
  test("renders a confidence chip and source label per row", () => {
    listResponse = {
      items: [
        makeSupplier({
          id: "sup_high_eur",
          name: "Berlin GmbH",
          billingCurrency: "EUR",
          billingCurrencySource: BillingCurrencySource.country,
          billingCurrencyConfidence: BillingCurrencyConfidence.high,
        }),
        makeSupplier({
          id: "sup_low_usd",
          name: "Quito SAS",
          billingCurrency: "USD",
          billingCurrencySource: BillingCurrencySource.country_dollarized,
          billingCurrencyConfidence: BillingCurrencyConfidence.low,
        }),
      ],
      nextCursor: null,
    };
    renderPage();

    const high = screen.getByTestId("badge-confidence-sup_high_eur");
    expect(high.getAttribute("data-confidence")).toBe("high");
    expect(high.textContent).toMatch(/high/i);
    expect(
      screen.getByTestId("text-source-sup_high_eur").getAttribute("data-source"),
    ).toBe("country");
    expect(
      screen.getByTestId("text-source-sup_high_eur").textContent,
    ).toMatch(/auto-detected from country/i);

    const low = screen.getByTestId("badge-confidence-sup_low_usd");
    expect(low.getAttribute("data-confidence")).toBe("low");
    expect(low.textContent).toMatch(/low/i);
  });

  test("low-confidence rows are visually highlighted", () => {
    listResponse = {
      items: [
        makeSupplier({
          id: "sup_low",
          billingCurrencyConfidence: BillingCurrencyConfidence.low,
        }),
        makeSupplier({
          id: "sup_high",
          billingCurrencyConfidence: BillingCurrencyConfidence.high,
        }),
      ],
      nextCursor: null,
    };
    renderPage();

    const lowRow = screen.getByTestId("row-supplier-sup_low");
    expect(lowRow.getAttribute("data-confidence")).toBe("low");
    expect(lowRow.className).toMatch(/amber/);

    const highRow = screen.getByTestId("row-supplier-sup_high");
    expect(highRow.getAttribute("data-confidence")).toBe("high");
    expect(highRow.className).not.toMatch(/amber/);
  });

  test("clicking the Confidence header sorts low-first, then high-first, then off", async () => {
    const user = userEvent.setup();
    listResponse = {
      items: [
        makeSupplier({
          id: "sup_high",
          name: "AAA High",
          billingCurrencyConfidence: BillingCurrencyConfidence.high,
        }),
        makeSupplier({
          id: "sup_low",
          name: "BBB Low",
          billingCurrencyConfidence: BillingCurrencyConfidence.low,
        }),
        makeSupplier({
          id: "sup_medium",
          name: "CCC Medium",
          billingCurrencyConfidence: BillingCurrencyConfidence.medium,
        }),
      ],
      nextCursor: null,
    };
    renderPage();

    const orderOfIds = () =>
      Array.from(
        screen
          .getByTestId("table-suppliers")
          .querySelectorAll("tbody tr[data-testid^='row-supplier-']"),
      ).map((tr) => tr.getAttribute("data-testid"));

    // Initial render: server order (high, low, medium).
    expect(orderOfIds()).toEqual([
      "row-supplier-sup_high",
      "row-supplier-sup_low",
      "row-supplier-sup_medium",
    ]);

    const sortBtn = screen.getByTestId("btn-sort-confidence");

    // 1st click → low-first (the triage default).
    await user.click(sortBtn);
    expect(orderOfIds()).toEqual([
      "row-supplier-sup_low",
      "row-supplier-sup_medium",
      "row-supplier-sup_high",
    ]);

    // 2nd click → high-first.
    await user.click(sortBtn);
    expect(orderOfIds()).toEqual([
      "row-supplier-sup_high",
      "row-supplier-sup_medium",
      "row-supplier-sup_low",
    ]);

    // 3rd click → back to server order.
    await user.click(sortBtn);
    expect(orderOfIds()).toEqual([
      "row-supplier-sup_high",
      "row-supplier-sup_low",
      "row-supplier-sup_medium",
    ]);
  });

  test("low-confidence quick filter wires `?confidence=low` through to the list query", async () => {
    const user = userEvent.setup();
    listResponse = {
      items: [
        makeSupplier({
          id: "sup_low",
          billingCurrencyConfidence: BillingCurrencyConfidence.low,
        }),
      ],
      nextCursor: null,
    };
    renderPage();

    expect(lastListParams?.["confidence"]).toBeUndefined();

    await user.click(screen.getByTestId("btn-toggle-low-confidence"));

    await waitFor(() => {
      expect(lastListParams?.["confidence"]).toBe("low");
    });
    expect(screen.getByTestId("confidence-banner-low")).toBeTruthy();
  });

  test("inline override posts the uppercased ISO code via the mutation", async () => {
    const user = userEvent.setup();
    listResponse = {
      items: [
        makeSupplier({
          id: "sup_low_target",
          billingCurrency: "USD",
          billingCurrencySource: BillingCurrencySource.country_dollarized,
          billingCurrencyConfidence: BillingCurrencyConfidence.low,
        }),
      ],
      nextCursor: null,
    };
    renderPage();

    await user.click(screen.getByTestId("btn-override-sup_low_target"));

    const popoverForm = await screen.findByTestId(
      "form-override-sup_low_target",
    );
    const input = within(popoverForm).getByTestId(
      "input-override-sup_low_target",
    ) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "gbp");

    await user.click(
      within(popoverForm).getByTestId("btn-override-save-sup_low_target"),
    );

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    expect(mutateSpy).toHaveBeenCalledWith({
      id: "sup_low_target",
      data: { billingCurrency: "GBP" },
    });
  });

  test("inline override blocks invalid shapes and surfaces an error inline", async () => {
    const user = userEvent.setup();
    listResponse = {
      items: [
        makeSupplier({
          id: "sup_low_bad",
          billingCurrencyConfidence: BillingCurrencyConfidence.low,
        }),
      ],
      nextCursor: null,
    };
    renderPage();

    await user.click(screen.getByTestId("btn-override-sup_low_bad"));
    const popoverForm = await screen.findByTestId("form-override-sup_low_bad");
    const input = within(popoverForm).getByTestId(
      "input-override-sup_low_bad",
    ) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "EU"); // too short
    await user.click(
      within(popoverForm).getByTestId("btn-override-save-sup_low_bad"),
    );

    expect(mutateSpy).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("text-override-error-sup_low_bad").textContent,
    ).toMatch(/3-letter iso/i);
  });

  test("override onSuccess invalidates the list and supplier-detail caches", async () => {
    const user = userEvent.setup();
    listResponse = {
      items: [
        makeSupplier({
          id: "sup_target_42",
          billingCurrencyConfidence: BillingCurrencyConfidence.low,
        }),
      ],
      nextCursor: null,
    };
    const { qc } = renderPage();

    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    await user.click(screen.getByTestId("btn-override-sup_target_42"));
    const popoverForm = await screen.findByTestId(
      "form-override-sup_target_42",
    );
    const input = within(popoverForm).getByTestId(
      "input-override-sup_target_42",
    ) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "JPY");

    await user.click(
      within(popoverForm).getByTestId("btn-override-save-sup_target_42"),
    );

    expect(lastMutationOptions?.mutation?.onSuccess).toBeTypeOf("function");
    lastMutationOptions?.mutation?.onSuccess?.({
      id: "sup_target_42",
      billingCurrency: "JPY",
      billingCurrencySource: "manual_override",
      billingCurrencyConfidence: "high",
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: getListSuppliersQueryKey(),
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: getGetSupplierQueryKey("sup_target_42"),
    });
  });
});
