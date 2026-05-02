/**
 * #165 — Watched-companies "Suggested matches" UI contract.
 *
 * The settings page consumes `GET /watched-issuers/suggestions` and
 * renders one row per ranked candidate with:
 *   - a confidence badge bucketed into Exact (>=0.95) / Strong (>=0.75)
 *     / Needs review (else)
 *   - a "Why?" tooltip trigger that surfaces the engine's `matchReason`
 *     plus a `via` attribution
 *   - a Confirm button that POSTs to `/watched-issuers` with the
 *     suggestion's `supplierUid` so the new row carries the supplier link
 *
 * Pin those contract bits here so a refactor of the engine's
 * confidence tiers, the badge copy, or the confirm payload can't
 * silently regress the audit story for admins.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  WatchedIssuer,
  WatchedIssuerSuggestionListResponse,
} from "@workspace/api-client-react";
import { TooltipProvider } from "@/components/ui/tooltip";

// ---- React Query hook mocks ----------------------------------------------

const addMutateSpy = vi.fn();
let addPending = false;
let lastAddOptions: {
  mutation?: {
    onSuccess?: (row: WatchedIssuer) => void;
    onError?: (err: Error) => void;
    onSettled?: () => void;
  };
} | null = null;

let suggestionsResponse: WatchedIssuerSuggestionListResponse = {
  items: [],
  suppliersConsidered: 0,
  suppliersSkippedAlreadyWatched: 0,
};

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    // Watch list table — empty in these tests; we're focused on the
    // suggestions surface.
    useListWatchedIssuers: () => ({
      data: { items: [] },
      isLoading: false,
      error: null,
    }),
    useListWatchedIssuerSuggestions: () => ({
      data: suggestionsResponse,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
    useRemoveWatchedIssuer: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useListSuppliers: () => ({
      data: { items: [] },
      isLoading: false,
    }),
    useAddWatchedIssuer: (opts: typeof lastAddOptions) => {
      lastAddOptions = opts ?? null;
      return {
        mutate: addMutateSpy,
        isPending: addPending,
      };
    },
  };
});

// Toast hook — render to a no-op so the component tree mounts cleanly.
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const { default: WatchedCompanies } = await import(
  "../src/pages/watched-companies"
);

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  addMutateSpy.mockReset();
  addPending = false;
  lastAddOptions = null;
  suggestionsResponse = {
    items: [],
    suppliersConsidered: 0,
    suppliersSkippedAlreadyWatched: 0,
  };
});

afterEach(() => {
  cleanup();
});

describe("Watched companies — suggestions surface", () => {
  test("renders confidence badges per tier and groups rows by supplier", () => {
    suggestionsResponse = {
      suppliersConsidered: 3,
      suppliersSkippedAlreadyWatched: 1,
      items: [
        {
          key: "sup_apple:sec_edgar:0000320193",
          supplierUid: "sup_apple",
          supplierName: "Apple Inc.",
          source: "sec_edgar",
          identifier: "0000320193",
          name: "Apple Inc.",
          ticker: "AAPL",
          lei: "HWUPKR0MPOU8FGXBT394",
          confidence: 0.95,
          confidenceTier: "exact",
          matchReason: "exact name match in SEC ticker index",
          via: "sec",
        },
        {
          key: "sup_msft:sec_edgar:0000789019",
          supplierUid: "sup_msft",
          supplierName: "Microsoft Corporation",
          source: "sec_edgar",
          identifier: "0000789019",
          name: "Microsoft Corp",
          ticker: "MSFT",
          lei: null,
          confidence: 0.75,
          confidenceTier: "strong",
          matchReason: "strong name overlap with SEC ticker index",
          via: "sec",
        },
        {
          key: "sup_acme:companies_house:00010892",
          supplierUid: "sup_acme",
          supplierName: "Acme Holdings",
          source: "companies_house",
          identifier: "00010892",
          name: "Acme Holdings Ltd",
          ticker: null,
          lei: null,
          confidence: 0.55,
          confidenceTier: "review",
          matchReason: "name overlap in Companies House",
          via: "companies_house",
        },
      ],
    };

    const Wrapper = makeWrapper();
    render(<WatchedCompanies />, { wrapper: Wrapper });

    // Each supplier becomes its own group header.
    expect(
      screen.getByTestId("suggestion-group-sup_apple"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("suggestion-group-sup_msft"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("suggestion-group-sup_acme"),
    ).toBeInTheDocument();

    // Confidence tier mapping is the audit anchor — pin it explicitly.
    const exactBadge = screen.getByTestId(
      "badge-confidence-sup_apple:sec_edgar:0000320193",
    );
    expect(exactBadge).toHaveAttribute("data-tier", "Exact");
    expect(exactBadge).toHaveTextContent("Exact");

    const strongBadge = screen.getByTestId(
      "badge-confidence-sup_msft:sec_edgar:0000789019",
    );
    expect(strongBadge).toHaveAttribute("data-tier", "Strong");
    expect(strongBadge).toHaveTextContent("Strong");

    const weakBadge = screen.getByTestId(
      "badge-confidence-sup_acme:companies_house:00010892",
    );
    expect(weakBadge).toHaveAttribute("data-tier", "Needs review");
    expect(weakBadge).toHaveTextContent("Needs review");

    // The "Why?" trigger is rendered per row so the tooltip can
    // surface the engine's matchReason on demand.
    expect(
      screen.getByTestId("button-why-sup_apple:sec_edgar:0000320193"),
    ).toBeInTheDocument();

    // Skipped-suppliers count flows into the footer summary so admins
    // know we already curated some of their list.
    expect(
      screen.getByTestId("suggestions-footer-summary"),
    ).toHaveTextContent(/1 supplier skipped/i);
  });

  test("Confirm button POSTs the suggestion with supplierUid + identifier", async () => {
    suggestionsResponse = {
      suppliersConsidered: 1,
      suppliersSkippedAlreadyWatched: 0,
      items: [
        {
          key: "sup_apple:sec_edgar:0000320193",
          supplierUid: "sup_apple",
          supplierName: "Apple Inc.",
          source: "sec_edgar",
          identifier: "0000320193",
          name: "Apple Inc.",
          ticker: "AAPL",
          lei: "HWUPKR0MPOU8FGXBT394",
          confidence: 0.95,
          confidenceTier: "exact",
          matchReason: "exact name match in SEC ticker index",
          via: "sec",
        },
      ],
    };

    const Wrapper = makeWrapper();
    render(<WatchedCompanies />, { wrapper: Wrapper });

    const user = userEvent.setup();
    await user.click(
      screen.getByTestId("button-confirm-sup_apple:sec_edgar:0000320193"),
    );

    expect(addMutateSpy).toHaveBeenCalledTimes(1);
    const arg = addMutateSpy.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data).toEqual({
      source: "sec_edgar",
      identifier: "0000320193",
      name: "Apple Inc.",
      supplierUid: "sup_apple",
      ticker: "AAPL",
      lei: "HWUPKR0MPOU8FGXBT394",
    });
  });

  test("empty suggestion list surfaces a friendly empty state with the considered count", () => {
    suggestionsResponse = {
      items: [],
      suppliersConsidered: 7,
      suppliersSkippedAlreadyWatched: 2,
    };

    const Wrapper = makeWrapper();
    render(<WatchedCompanies />, { wrapper: Wrapper });

    const empty = screen.getByTestId("empty-suggestions");
    expect(empty).toHaveTextContent(/checked 7 suppliers/i);
    expect(empty).toHaveTextContent(/2 already curated/i);
  });

  test("tooltip exposes the engine's matchReason and `via` attribution on hover", async () => {
    suggestionsResponse = {
      suppliersConsidered: 1,
      suppliersSkippedAlreadyWatched: 0,
      items: [
        {
          key: "sup_acme:companies_house:00010892",
          supplierUid: "sup_acme",
          supplierName: "Acme Holdings",
          source: "companies_house",
          identifier: "00010892",
          name: "Acme Holdings Ltd",
          ticker: null,
          lei: null,
          confidence: 0.75,
          confidenceTier: "strong",
          matchReason: "strong name overlap in Companies House",
          via: "companies_house",
        },
      ],
    };

    const Wrapper = makeWrapper();
    render(<WatchedCompanies />, { wrapper: Wrapper });

    const user = userEvent.setup();
    await user.hover(
      screen.getByTestId("button-why-sup_acme:companies_house:00010892"),
    );

    // Tooltip is portalled, so use findAll for the deferred render.
    await waitFor(() => {
      const tip = screen
        .queryAllByTestId(
          "tooltip-why-sup_acme:companies_house:00010892",
        )[0];
      expect(tip).toBeTruthy();
      expect(tip).toHaveTextContent(/strong name overlap in Companies House/);
      expect(tip).toHaveTextContent(/Companies House search/);
    });
  });
});
