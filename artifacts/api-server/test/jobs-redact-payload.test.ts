/**
 * Unit test for the job-payload scrubber that backs the failed-jobs
 * notification surface (#94).
 *
 * The scrubber runs server-side before the redacted payload ever
 * leaves the API, so any regression here would leak credential-shaped
 * fields directly into an admin's browser. We pin:
 *
 *   - Sensitive keys (case-insensitive substring match on the key
 *     name) are replaced with `[REDACTED]` regardless of whether
 *     their value is a string, number, nested object, etc.
 *   - Non-sensitive keys are preserved verbatim, including nested
 *     structure that the job-detail UI wants to render.
 *   - Strings longer than the cap are truncated and the truncation
 *     marker carries the original length so an admin can tell the
 *     payload was abbreviated.
 *   - Pathologically deep payloads bottom out at `[truncated]` rather
 *     than recursing without bound.
 *   - The function ALWAYS returns an object, so the client can render
 *     `Object.entries(...)` without a guard, even for null / array /
 *     scalar inputs.
 *   - The walk does not mutate the caller's payload — the queue keeps
 *     the raw payload in the row, and the scrubber must not corrupt
 *     it on its way out.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { redactJobPayload } from "../src/lib/jobs/redact-payload";

test("redactJobPayload masks credential-shaped keys at every depth", () => {
  const payload = {
    fileName: "q3-suppliers.csv",
    rowIndex: 42,
    apiKey: "sk_live_super_secret",
    config: {
      endpoint: "https://erp.example.com",
      auth: { bearer: "abc123", username: "ops" },
      // password as a numeric value should still get redacted — keys win.
      password: 12345,
    },
    headers: [
      { name: "Authorization", value: "Bearer xyz" },
      { name: "X-Trace-Id", value: "trc_001" },
    ],
  };

  const out = redactJobPayload(payload);

  assert.equal(out["fileName"], "q3-suppliers.csv");
  assert.equal(out["rowIndex"], 42);
  assert.equal(out["apiKey"], "[REDACTED]");

  const config = out["config"] as Record<string, unknown>;
  assert.equal(config["endpoint"], "https://erp.example.com");
  assert.equal(config["password"], "[REDACTED]");
  assert.equal(config["auth"], "[REDACTED]");

  const headers = out["headers"] as Array<Record<string, unknown>>;
  // The KEY "value" is not sensitive — only the key NAME triggers
  // redaction. The Authorization header's value is therefore visible
  // in the redacted payload, which is the intended behaviour: the
  // scrubber is structural, not content-aware. Value-level scanning
  // is a separately-tracked follow-up.
  assert.equal(headers[0]?.["name"], "Authorization");
  assert.equal(headers[0]?.["value"], "Bearer xyz");
  assert.equal(headers[1]?.["name"], "X-Trace-Id");
  assert.equal(headers[1]?.["value"], "trc_001");
});

test("redactJobPayload truncates oversized strings with a length marker", () => {
  const huge = "x".repeat(5_000);
  const out = redactJobPayload({ note: huge });
  const note = out["note"] as string;
  assert.ok(note.startsWith("x".repeat(1_000)));
  assert.ok(note.includes("truncated"));
  assert.ok(note.includes("5000"));
});

test("redactJobPayload bottoms out on pathologically deep payloads", () => {
  type Nested = { next?: Nested };
  const root: Nested = {};
  let cursor: Nested = root;
  for (let i = 0; i < 50; i += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  const out = redactJobPayload(root);
  // Walk down: at MAX_DEPTH (8) we should hit the truncation sentinel
  // somewhere along the chain rather than blowing the stack.
  let node: unknown = out;
  let sawTruncated = false;
  for (let i = 0; i < 50; i += 1) {
    if (node === "[truncated]") {
      sawTruncated = true;
      break;
    }
    if (typeof node !== "object" || node === null) break;
    node = (node as Record<string, unknown>)["next"];
  }
  assert.ok(sawTruncated, "deep payload should be truncated");
});

test("redactJobPayload always returns an object even for non-object input", () => {
  assert.deepEqual(redactJobPayload(null), {});
  assert.deepEqual(redactJobPayload(undefined), {});
  const fromArray = redactJobPayload([1, 2, 3]);
  assert.deepEqual(fromArray, { value: [1, 2, 3] });
  const fromString = redactJobPayload("hello");
  assert.deepEqual(fromString, { value: "hello" });
});

test("redactJobPayload does not mutate its input", () => {
  const payload = {
    apiKey: "secret",
    nested: { token: "tok" },
    keep: "hello",
  };
  const snapshot = JSON.parse(JSON.stringify(payload));
  redactJobPayload(payload);
  assert.deepEqual(payload, snapshot);
});
