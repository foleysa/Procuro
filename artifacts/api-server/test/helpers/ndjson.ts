/**
 * Helpers for parsing the streaming CSV ingest endpoint's NDJSON response
 * body. The endpoint replies with `application/x-ndjson`: zero or more
 * `{type:"progress",...}` lines followed by a single terminal event
 * (`{type:"result",...}` on success, `{type:"error",...}` on failure).
 *
 * Tests historically called `JSON.parse(rawBody)` directly, which works
 * only when no progress events are emitted (i.e. when the upload finishes
 * before the server flushes its first progress line). On slower databases
 * — including the test database in this repo — at least one progress
 * event is emitted reliably, and `JSON.parse` then throws "Unexpected
 * non-whitespace character after JSON". Using this helper keeps the
 * suite green deterministically regardless of upload duration.
 */

export type TerminalNdjsonEvent =
  | {
      type: "result";
      entity: string;
      rowsParsed: number;
      rowsInserted: number;
      durationMs: number;
    }
  | { type: "error"; error: string };

/**
 * Parse the whole NDJSON body and return the terminal event
 * (`result` or `error`). Throws if no terminal event is present.
 */
export function parseTerminalNdjsonEvent(rawBody: string): TerminalNdjsonEvent {
  const lines = rawBody.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Empty NDJSON response body`);
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = JSON.parse(lines[i]!) as { type?: string };
    if (parsed.type === "result" || parsed.type === "error") {
      return parsed as TerminalNdjsonEvent;
    }
  }
  throw new Error(
    `No terminal NDJSON event (result/error) found in response: ${rawBody.slice(0, 200)}`,
  );
}
