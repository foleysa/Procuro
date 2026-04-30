/**
 * Closes the gap left by `csv-stream-progress-entities.test.ts`: that test
 * pins the *server* NDJSON contract, but a regression in the client (wrong
 * field name on the event, NDJSON parser bug, missed re-render) would still
 * leave the upload page's progress bar frozen for the user.
 *
 * This test renders the actual `<Ingest />` page, picks a CSV file for the
 * streaming-only `purchaseOrderLines` entity, clicks "Import", and drives a
 * mocked `XMLHttpRequest` through the same NDJSON event sequence the server
 * emits in production:
 *
 *   1. upload-bytes progress events (XHR upload channel)
 *   2. NDJSON `progress` events appended to `responseText`, fired via
 *      `xhr.onprogress` so the page's incremental drainResponseText() runs
 *   3. terminal NDJSON `result` event + `xhr.onload`
 *
 * It asserts the visible progress bar fill, the upload-bytes text and the
 * "X parsed / Y inserted" server-progress line all advance between the
 * first progress event and the final result event — proving the client UI
 * actually re-renders as new events arrive instead of jumping straight to
 * the terminal result.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

import Ingest from "../src/pages/ingest";

// ---- fake XMLHttpRequest -------------------------------------------------

interface FakeUpload {
  onprogress: ((ev: ProgressEvent) => void) | null;
}

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];

  // Public XHR-ish surface used by uploadCsvStream() in pages/ingest.tsx.
  public upload: FakeUpload = { onprogress: null };
  public onprogress: ((ev: ProgressEvent) => void) | null = null;
  public onload: ((ev: ProgressEvent) => void) | null = null;
  public onerror: ((ev: ProgressEvent) => void) | null = null;
  public onabort: ((ev: ProgressEvent) => void) | null = null;

  public responseText = "";
  public status = 0;
  public statusText = "";
  public readyState = 0;

  public method = "";
  public url = "";
  public requestHeaders: Record<string, string> = {};
  public sentBody: unknown = null;

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string, _async?: boolean): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  send(body?: unknown): void {
    this.sentBody = body ?? null;
    this.readyState = 2;
  }

  abort(): void {
    this.onabort?.(new ProgressEvent("abort"));
  }

  // --- test helpers (not part of the real XHR interface) ---

  emitUploadProgress(loaded: number, total: number): void {
    this.upload.onprogress?.(
      new ProgressEvent("progress", {
        lengthComputable: true,
        loaded,
        total,
      }),
    );
  }

  /**
   * Append a chunk to `responseText` and fire `onprogress`. The page's
   * `drainResponseText()` reads up to the latest `\n`, so callers should
   * include the trailing newline themselves.
   */
  appendChunk(chunk: string): void {
    this.responseText += chunk;
    this.onprogress?.(new ProgressEvent("progress"));
  }

  finish(status = 200, statusText = "OK"): void {
    this.status = status;
    this.statusText = statusText;
    this.readyState = 4;
    this.onload?.(new ProgressEvent("load"));
  }
}

// ---- helpers -------------------------------------------------------------

function renderIngest() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Ingest />
    </QueryClientProvider>,
  );
}

function makePoLinesCsv(): File {
  // Headers must match `purchaseOrderLines.required` in pages/ingest.tsx.
  // `parseHeadersOnly` only reads the first row, so a single-row file is
  // enough to clear the page's required-column validation.
  const csv =
    "externalId,poExternalId,sku,qty,unitPriceUsd\n" +
    "POL-1,PO-1,SKU-1,10,12.50\n";
  return new File([csv], "po-lines-test.csv", { type: "text/csv" });
}

// ---- lifecycle -----------------------------------------------------------

let originalXHR: typeof XMLHttpRequest | undefined;

beforeEach(() => {
  FakeXMLHttpRequest.instances = [];
  originalXHR = globalThis.XMLHttpRequest;
  // Cast through unknown — FakeXMLHttpRequest implements only the subset of
  // XHR that pages/ingest.tsx actually consumes.
  globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
  cleanup();
  if (originalXHR) {
    globalThis.XMLHttpRequest = originalXHR;
  }
  vi.restoreAllMocks();
});

// ---- test ----------------------------------------------------------------

describe("Ingest page streaming progress UI", () => {
  test(
    "progress bar and server-progress text advance as NDJSON events arrive",
    async () => {
      const user = userEvent.setup();
      renderIngest();

      // 1. Pick a CSV for the streaming-only purchaseOrderLines entity.
      const fileInput = screen.getByTestId(
        "input-file-purchaseOrderLines",
      ) as HTMLInputElement;
      await user.upload(fileInput, makePoLinesCsv());

      // The "Streaming" badge appears once parseHeadersOnly resolves and
      // the row is marked valid + streaming. Waiting for it ensures the
      // Import button is enabled before we click it.
      await screen.findByTestId("badge-streaming-purchaseOrderLines");

      const importBtn = screen.getByTestId("btn-run-import");
      expect(importBtn).toBeEnabled();
      await user.click(importBtn);

      // 2. The page should have constructed exactly one fake XHR for the
      //    purchaseOrderLines streaming upload.
      await waitFor(() => {
        expect(FakeXMLHttpRequest.instances).toHaveLength(1);
      });
      const xhr = FakeXMLHttpRequest.instances[0]!;
      expect(xhr.method).toBe("POST");
      expect(xhr.url).toContain("entity=po_lines");

      // 3. Progress bar container is now visible with a 0% bar (no upload
      //    progress events yet). Radix Progress reflects the current value
      //    on the indicator's inline transform — translateX(-100%) at 0%
      //    moves to translateX(0%) at 100%.
      const progressContainer = await screen.findByTestId(
        "stream-progress-purchaseOrderLines",
      );
      const getProgressTransformPct = (): number => {
        const indicator = progressContainer.querySelector(
          ".bg-primary",
        ) as HTMLElement | null;
        if (!indicator) return Number.NaN;
        const m = /translateX\(-(\d+(?:\.\d+)?)%\)/.exec(
          indicator.style.transform,
        );
        if (!m) return Number.NaN;
        return 100 - Number(m[1]);
      };
      expect(getProgressTransformPct()).toBe(0);

      // 4. Halfway through the upload: bytes-shipped fills the bar to 50%.
      const totalBytes = 1_000_000;
      await act(async () => {
        xhr.emitUploadProgress(500_000, totalBytes);
      });
      await waitFor(() => {
        expect(getProgressTransformPct()).toBe(50);
      });
      expect(progressContainer.textContent ?? "").toMatch(/50\s*%/);

      // 5. Upload finishes: bar fills to 100% and the upload-bytes text
      //    flips to the "processing on server…" hint (no server progress
      //    received yet).
      await act(async () => {
        xhr.emitUploadProgress(totalBytes, totalBytes);
      });
      await waitFor(() => {
        expect(getProgressTransformPct()).toBe(100);
      });
      expect(progressContainer.textContent ?? "").toMatch(/100\s*%/);
      expect(progressContainer.textContent ?? "").toMatch(/processing on server/i);
      // No server-progress line yet.
      expect(
        screen.queryByTestId("server-progress-purchaseOrderLines"),
      ).toBeNull();

      // 6. First NDJSON `progress` event arrives — the live row counts
      //    line should appear and show "1,000 parsed / 500 inserted".
      await act(async () => {
        xhr.appendChunk(
          JSON.stringify({
            type: "progress",
            rowsParsed: 1_000,
            rowsInserted: 500,
          }) + "\n",
        );
      });
      const serverProgressEl = await screen.findByTestId(
        "server-progress-purchaseOrderLines",
      );
      expect(serverProgressEl.textContent ?? "").toMatch(
        /1,000\s+rows\s+parsed/i,
      );
      expect(serverProgressEl.textContent ?? "").toMatch(/500\s+inserted/i);

      // 7. Second `progress` event — counts must advance, not just reflect
      //    the first event. This is the core regression check: a frozen
      //    progress bar / stale text would fail here.
      await act(async () => {
        xhr.appendChunk(
          JSON.stringify({
            type: "progress",
            rowsParsed: 5_000,
            rowsInserted: 4_500,
          }) + "\n",
        );
      });
      await waitFor(() => {
        const el = screen.getByTestId("server-progress-purchaseOrderLines");
        expect(el.textContent ?? "").toMatch(/5,000\s+rows\s+parsed/i);
        expect(el.textContent ?? "").toMatch(/4,500\s+inserted/i);
      });

      // 8. Third `progress` event split across two reads — the page's
      //    incremental NDJSON parser must hold the partial line until the
      //    closing newline arrives. If it tried to JSON.parse() each chunk
      //    blindly we'd silently drop this event and the UI would stay at
      //    5,000 / 4,500.
      const partial = JSON.stringify({
        type: "progress",
        rowsParsed: 9_000,
        rowsInserted: 8_500,
      });
      const splitAt = Math.floor(partial.length / 2);
      await act(async () => {
        xhr.appendChunk(partial.slice(0, splitAt));
      });
      // Still showing the previous values — no newline yet.
      expect(
        screen.getByTestId("server-progress-purchaseOrderLines").textContent ?? "",
      ).toMatch(/5,000\s+rows\s+parsed/i);
      await act(async () => {
        xhr.appendChunk(partial.slice(splitAt) + "\n");
      });
      await waitFor(() => {
        const el = screen.getByTestId("server-progress-purchaseOrderLines");
        expect(el.textContent ?? "").toMatch(/9,000\s+rows\s+parsed/i);
        expect(el.textContent ?? "").toMatch(/8,500\s+inserted/i);
      });

      // 9. Terminal `result` event arrives, the page resolves the upload
      //    promise, isStreaming flips to false and the success alert
      //    appears with the final aggregate counts.
      await act(async () => {
        xhr.appendChunk(
          JSON.stringify({
            type: "result",
            entity: "po_lines",
            rowsParsed: 10_000,
            rowsInserted: 10_000,
            durationMs: 1_234,
          }) + "\n",
        );
        xhr.finish(200);
      });

      const successAlert = await screen.findByTestId("alert-import-success");
      // The page renders raw `result.recordsProcessed`/`recordsCreated`
      // from the aggregate, which for streaming-only entities is sourced
      // from the terminal `result` event's `rowsParsed` / `rowsInserted`.
      const successText = successAlert.textContent ?? "";
      expect(successText).toMatch(/Processed\s*10000/);
      expect(successText).toMatch(/Created\s*10000/);
      expect(successText).toMatch(/1234ms/);

      // While we're here, ensure the upload finalized cleanly.
      expect(screen.queryByTestId("alert-import-error")).toBeNull();
    },
    15_000,
  );
});
