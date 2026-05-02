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
      delete (window.navigator as { clipboard?: unknown }).clipboard;
    }
    if (originalExecCommand) {
      (
        document as Document & {
          execCommand: (commandId: string) => boolean;
        }
      ).execCommand = originalExecCommand;
    } else {
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

  test("prepends a file/entity/timestamp header when copyContext is provided", async () => {
    const user = userEvent.setup();
    installClipboardMock();
    // Pick an explicit moment (UTC) so the formatted "When:" line is
    // deterministic regardless of the test machine's timezone.
    const when = new Date(Date.UTC(2026, 3, 30, 17, 42));
    render(
      <>
        <TruncatedError
          message={LONG_ERROR}
          copyContext={{
            fileName: "q3-suppliers.csv",
            entity: "suppliers",
            timestamp: when,
          }}
        />
        <Toaster />
      </>,
    );

    await user.click(screen.getByTestId("button-copy-error"));

    expect(writeText).toHaveBeenCalledTimes(1);
    const expected =
      "# Failed upload\n" +
      "# File: q3-suppliers.csv\n" +
      "# Entity: suppliers\n" +
      "# When: 2026-04-30 17:42 UTC\n" +
      "\n" +
      LONG_ERROR;
    expect(writeText).toHaveBeenCalledWith(expected);

    // The on-screen rendering must NOT have changed — only the
    // clipboard payload gets the header. The visible summary is the
    // first line of the original error.
    expect(screen.getByTestId("text-error-summary")).toHaveTextContent(
      LONG_ERROR.split("\n")[0]!,
    );
    expect(
      screen.queryByText(/# Failed upload/),
    ).not.toBeInTheDocument();
  });

  test("omits the header when copyContext has no usable fields", async () => {
    const user = userEvent.setup();
    installClipboardMock();
    render(
      <>
        {/* All three fields are undefined — the component must not
            invent a header out of thin air. */}
        <TruncatedError message={LONG_ERROR} copyContext={{}} />
        <Toaster />
      </>,
    );

    await user.click(screen.getByTestId("button-copy-error"));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(LONG_ERROR);
  });

  test("includes only the populated copyContext fields", async () => {
    const user = userEvent.setup();
    installClipboardMock();
    // Only file name is known (e.g. a generic uploader that doesn't
    // know which entity the file maps to). The header must skip the
    // missing fields rather than emit empty `# Entity:` / `# When:`
    // lines.
    render(
      <>
        <TruncatedError
          message={LONG_ERROR}
          copyContext={{ fileName: "bulk.csv" }}
        />
        <Toaster />
      </>,
    );

    await user.click(screen.getByTestId("button-copy-error"));

    expect(writeText).toHaveBeenCalledTimes(1);
    const expected = "# Failed upload\n# File: bulk.csv\n\n" + LONG_ERROR;
    expect(writeText).toHaveBeenCalledWith(expected);
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
