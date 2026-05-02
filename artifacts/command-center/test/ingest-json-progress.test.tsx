/**
 * Companion to `ingest-stream-progress.test.tsx`. That test pins the UI
 * for the streaming-only `purchaseOrderLines` flow (NDJSON over XHR);
 * this test pins the *other* upload path used by every entity that fits
 * under the 5 MB threshold — `useIngestCsvBatch`, an orval-generated
 * React Query mutation that ships the parsed rows as JSON.
 *
 * Without this coverage a regression in:
 *
 *   * the "Importing N rows…" button label,
 *   * the per-entity payload aggregation into a single mutation call,
 *   * the success alert wiring (Processed / Created / Updated / Duration),
 *   * the destructive error alert routing for a failed mutation
 *
 * would slip past CI even though it would visibly break the Data Ingest
 * page for every JSON-path entity (categories, suppliers, items,
 * contracts, purchase orders, invoices, payments, shipments).
 *
 * The mutation hook is replaced with a deferred-promise stub so the test
 * can drive both the success and failure branches deterministically
 * without hitting the network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

// ---- mutation hook mock --------------------------------------------------
//
// The page calls `ingestM.mutateAsync({ data: jsonPayload })` and feeds the
// resolved/rejected value into either the success alert aggregation or the
// destructive `apiError` path. We replace `useIngestCsvBatch` with a real
// `useMutation` whose mutationFn forwards into a per-test spy: this keeps
// the `isPending` semantics that the page relies on (button label flip,
// `disabled`) while letting the test own when (and how) the mutation
// settles via a deferred promise.

const mutateAsyncSpy = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  const { useMutation } = await import("@tanstack/react-query");
  return {
    ...actual,
    useIngestCsvBatch: () =>
      useMutation({
        mutationFn: (vars: { data: unknown }) => mutateAsyncSpy(vars),
      }),
  };
});

// `useToast` is the only side-channel the page uses to surface the
// "Import complete" / "Import failed" pop-ups. Replace the hook with a
// spy so we can assert the page actually fires the toast (and with the
// right variant on failure) — a regression that swallowed the toast
// would not show up in the alert assertions because the alert is a
// separate render path.
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
  toast: toastSpy,
}));

// Imported AFTER vi.mock so the mocked hook wins.
const { default: Ingest } = await import("../src/pages/ingest");

// ---- helpers -------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The page attaches its `.catch` synchronously inside `onRun()`, but
  // swallowing the rejection here keeps Vitest from logging an
  // "unhandled promise rejection" warning during the brief window
  // before the page wires up its handler.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function makeSuppliersCsv(): File {
  // Headers are the suppliers entity's `required` + a few `optional`
  // columns from `pages/ingest.tsx`. A single-row file is enough to
  // clear validation and produce a non-empty `toPayload(...)` array.
  const csv =
    "externalId,name,countryCode,paymentTermsDays,isStrategic,isPreferred,tags\n" +
    "SUP-1,Acme Industrial,US,30,true,true,electronics\n";
  return new File([csv], "suppliers.csv", { type: "text/csv" });
}

function makeInvoicesCsv(): File {
  const csv =
    "externalId,invoiceNumber,supplierExternalId,invoiceDate,amountUsd,dedupKey\n" +
    "INV-1,IV-2025-1,SUP-1,2025-03-15,1650.00,SUP-1|IV-2025-1|1650.00\n";
  return new File([csv], "invoices.csv", { type: "text/csv" });
}

function renderIngest() {
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
        <Ingest />
      </QueryClientProvider>,
    ),
  };
}

// ---- lifecycle -----------------------------------------------------------

beforeEach(() => {
  mutateAsyncSpy.mockReset();
  toastSpy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---- tests --------------------------------------------------------------

describe("Ingest page JSON-path upload UI", () => {
  test(
    "aggregates two JSON-path entities into one mutation and renders the success alert with the right counts",
    async () => {
      const user = userEvent.setup();
      const deferred = makeDeferred<unknown>();
      mutateAsyncSpy.mockImplementation(() => deferred.promise);

      const { qc } = renderIngest();
      // Spy on the QueryClient before clicking Import so we can verify
      // the page invalidates every cache entry on success — without that
      // call, downstream pages would keep showing pre-import data until
      // the user manually navigated away.
      const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

      // 1. Pick CSVs for two JSON-path entities. Both fall well under
      //    the 5 MB streaming threshold and use `useIngestCsvBatch`.
      const suppliersInput = screen.getByTestId(
        "input-file-suppliers",
      ) as HTMLInputElement;
      await user.upload(suppliersInput, makeSuppliersCsv());
      // The rows badge appears once Papa.parse resolves and the row is
      // marked valid (no `missingRequired`). Waiting for it ensures the
      // Import button is enabled before we click it.
      await screen.findByTestId("badge-rows-suppliers");

      const invoicesInput = screen.getByTestId(
        "input-file-invoices",
      ) as HTMLInputElement;
      await user.upload(invoicesInput, makeInvoicesCsv());
      await screen.findByTestId("badge-rows-invoices");

      // 2. Click Run Import. The mutation is in-flight (deferred has not
      //    resolved yet), so the button must flip to its "Importing N
      //    rows…" pending label and become disabled.
      const importBtn = screen.getByTestId("btn-run-import");
      expect(importBtn).toBeEnabled();
      await user.click(importBtn);

      await waitFor(() => {
        expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
      });

      // The page merges every JSON-path entity into a single mutation
      // call so the server runs them in one transactional pass. We
      // assert both entities are present and carry exactly the rows we
      // uploaded — a regression that dropped one entity from the
      // aggregation would silently lose data on every multi-file
      // upload.
      const callArg = mutateAsyncSpy.mock.calls[0]?.[0] as {
        data: { suppliers?: unknown[]; invoices?: unknown[] };
      };
      expect(callArg).toBeDefined();
      expect(Array.isArray(callArg.data.suppliers)).toBe(true);
      expect(callArg.data.suppliers).toHaveLength(1);
      expect(Array.isArray(callArg.data.invoices)).toBe(true);
      expect(callArg.data.invoices).toHaveLength(1);

      // Pending button label reflects the live aggregated row count
      // across both JSON-path entities (1 supplier + 1 invoice = 2).
      await waitFor(() => {
        expect(importBtn.textContent ?? "").toMatch(
          /Importing\s+2\s+rows/i,
        );
      });
      expect(importBtn).toBeDisabled();

      // No alerts have appeared yet — the mutation is still in-flight.
      expect(screen.queryByTestId("alert-import-success")).toBeNull();
      expect(screen.queryByTestId("alert-import-error")).toBeNull();

      // 3. Resolve the mutation. The page reads `recordsProcessed`,
      //    `recordsCreated`, `recordsUpdated`, and `durationMs` straight
      //    onto the success alert via the <Stat /> children.
      await act(async () => {
        deferred.resolve({
          recordsProcessed: 2,
          recordsCreated: 2,
          recordsUpdated: 0,
          recordsDeleted: 0,
          durationMs: 87,
        });
      });

      const successAlert = await screen.findByTestId("alert-import-success");
      const successText = successAlert.textContent ?? "";
      expect(successText).toMatch(/Processed\s*2/);
      expect(successText).toMatch(/Created\s*2/);
      expect(successText).toMatch(/Updated\s*0/);
      expect(successText).toMatch(/87ms/);

      // The destructive alert must NOT appear on a successful run —
      // a regression that shared error/success state would trip here.
      expect(screen.queryByTestId("alert-import-error")).toBeNull();

      // 4. Side-effects: the success path must fire the "Import complete"
      //    toast (non-destructive) and invalidate the React Query cache so
      //    every downstream page re-fetches against the freshly ingested
      //    data instead of serving stale results.
      await waitFor(() => {
        expect(toastSpy).toHaveBeenCalled();
      });
      const successToastCall = toastSpy.mock.calls.find(([arg]) => {
        const a = arg as { title?: string };
        return typeof a?.title === "string" && /import complete/i.test(a.title);
      });
      expect(successToastCall).toBeDefined();
      const successToastArg = successToastCall?.[0] as {
        title?: string;
        description?: string;
        variant?: string;
      };
      // The success toast omits `variant` (defaults to non-destructive).
      expect(successToastArg.variant).toBeUndefined();
      expect(successToastArg.description ?? "").toMatch(
        /2\s+records\s+imported/i,
      );

      expect(invalidateSpy).toHaveBeenCalled();

      // After settling, the Import button should be re-enabled and back
      // to its idle label.
      await waitFor(() => {
        expect(screen.getByTestId("btn-run-import")).toBeEnabled();
      });
    },
    15_000,
  );

  test(
    "a failed mutation surfaces the server error in the destructive alert",
    async () => {
      const user = userEvent.setup();
      const deferred = makeDeferred<unknown>();
      mutateAsyncSpy.mockImplementation(() => deferred.promise);

      renderIngest();

      const suppliersInput = screen.getByTestId(
        "input-file-suppliers",
      ) as HTMLInputElement;
      await user.upload(suppliersInput, makeSuppliersCsv());
      await screen.findByTestId("badge-rows-suppliers");

      await user.click(screen.getByTestId("btn-run-import"));

      await waitFor(() => {
        expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
      });

      // Reject — `onRun()`'s catch block stringifies the error and sets
      // it as `apiError`, which renders the destructive alert with the
      // message inside <TruncatedError />.
      await act(async () => {
        deferred.reject(
          new Error("supplier external id duplicates row 4"),
        );
      });

      const errorAlert = await screen.findByTestId("alert-import-error");
      expect(errorAlert.textContent ?? "").toMatch(
        /supplier external id duplicates row 4/i,
      );

      // The success alert must NOT appear when the mutation rejects.
      expect(screen.queryByTestId("alert-import-success")).toBeNull();

      // Side-effect: the failure path fires a destructive toast carrying
      // the first line of the error so an operator who scrolled past the
      // top-of-page alert still gets a visible signal that the import
      // bailed.
      await waitFor(() => {
        const failureCall = toastSpy.mock.calls.find(([arg]) => {
          const a = arg as { variant?: string };
          return a?.variant === "destructive";
        });
        expect(failureCall).toBeDefined();
        const failureArg = failureCall?.[0] as {
          title?: string;
          description?: string;
        };
        expect(failureArg.title ?? "").toMatch(/import failed/i);
        expect(failureArg.description ?? "").toMatch(
          /supplier external id duplicates row 4/i,
        );
      });
    },
    15_000,
  );
});
