/**
 * Verifies the "Copy" affordance on <TruncatedError /> used inside the
 * destructive alert on /ingest. Operators that hit a long import error
 * need to be able to share the *full* error text — not just the visible
 * summary — with engineering or support in one click.
 *
 * The component is rendered with a multi-line error so it enters the
 * expandable mode (where the "Show details" toggle and the new "Copy"
 * button live). The test then:
 *
 *   1. Stubs `navigator.clipboard.writeText` so we can capture what gets
 *      put on the clipboard.
 *   2. Clicks the "Copy" button.
 *   3. Asserts the *entire* original error string was written to the
 *      clipboard (not the truncated single-line summary), and that the
 *      button label flips to "Copied" as a visible confirmation.
 *
 * It also covers the failure path: when clipboard access is blocked, the
 * label must NOT switch to "Copied" and the user must see a destructive
 * toast so they know to copy manually.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TruncatedError } from "../src/components/truncated-error";
import { Toaster } from "../src/components/ui/toaster";

const LONG_ERROR = [
  "Failed to import row 12: invalid currency code 'EU' in column 'billingCurrency'.",
  "  at parseCurrency (parser.ts:42)",
  "  at importRow (importer.ts:118)",
  "  at processBatch (importer.ts:201)",
  "Hint: use ISO-4217 codes such as EUR, USD, GBP.",
].join("\n");

describe("TruncatedError copy button", () => {
  let writeText: ReturnType<typeof vi.fn>;
  let originalClipboard: PropertyDescriptor | undefined;
  let originalExecCommand: ((commandId: string) => boolean) | undefined;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    originalClipboard = Object.getOwnPropertyDescriptor(
      window.navigator,
      "clipboard",
    );
    originalExecCommand = (
      document as Document & { execCommand?: (commandId: string) => boolean }
    ).execCommand;
    // jsdom doesn't implement execCommand; install a default no-op so we can
    // spy on / override it in individual tests.
    (
      document as Document & { execCommand: (commandId: string) => boolean }
    ).execCommand = () => true;
  });

  afterEach(() => {
    cleanup();
    if (originalClipboard) {
      Object.defineProperty(window.navigator, "clipboard", originalClipboard);
    } else {
      // @ts-expect-error - allow deletion in test cleanup
      delete (window.navigator as { clipboard?: unknown }).clipboard;
    }
    if (originalExecCommand) {
      (
        document as Document & {
          execCommand: (commandId: string) => boolean;
        }
      ).execCommand = originalExecCommand;
    } else {
      // @ts-expect-error - allow deletion in test cleanup
      delete (document as { execCommand?: unknown }).execCommand;
    }
    vi.restoreAllMocks();
  });

  function installClipboardMock() {
    // Must run AFTER userEvent.setup(), which installs its own clipboard
    // implementation that would otherwise shadow our spy.
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  }

  test("copies the full error text and flips the label to 'Copied'", async () => {
    const user = userEvent.setup();
    installClipboardMock();
    render(
      <>
        <TruncatedError message={LONG_ERROR} />
        <Toaster />
      </>,
    );

    // We are in expandable mode (the message has newlines), so both the
    // toggle and the new copy button must be present without expanding.
    expect(
      screen.getByTestId("button-toggle-error-details"),
    ).toBeInTheDocument();
    const copyButton = screen.getByTestId("button-copy-error");
    expect(copyButton).toHaveTextContent(/copy/i);

    await user.click(copyButton);

    // The full multi-line error — not the collapsed summary — must be on
    // the clipboard.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(LONG_ERROR);

    // Visible confirmation: label switches to "Copied".
    await waitFor(() =>
      expect(screen.getByTestId("button-copy-error")).toHaveTextContent(
        /copied/i,
      ),
    );
  });

  test("shows a failure toast and does not flip to 'Copied' when clipboard is blocked", async () => {
    writeText.mockRejectedValueOnce(new Error("permission denied"));
    // Also block the legacy execCommand fallback so we exercise the
    // failure branch.
    const execCommand = vi
      .spyOn(document, "execCommand")
      .mockReturnValue(false);

    const user = userEvent.setup();
    installClipboardMock();
    render(
      <>
        <TruncatedError message={LONG_ERROR} />
        <Toaster />
      </>,
    );

    await user.click(screen.getByTestId("button-copy-error"));

    await waitFor(() =>
      expect(screen.getByText(/couldn't copy/i)).toBeInTheDocument(),
    );
    expect(screen.getByTestId("button-copy-error")).toHaveTextContent(/copy/i);
    expect(screen.getByTestId("button-copy-error")).not.toHaveTextContent(
      /copied/i,
    );

    execCommand.mockRestore();
  });
});
