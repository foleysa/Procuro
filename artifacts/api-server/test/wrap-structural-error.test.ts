/**
 * Dedicated unit tests for `wrapStructuralError` in
 * `src/lib/jobs/handlers.ts`. The wrapper recognizes a fixed set of
 * "structurally-permanent" error types — JS built-ins (`TypeError`,
 * `RangeError`, `SyntaxError`), `StructuralIngestError`, the
 * `unrecoverable: true` brand, `UnrecoverableJobError` itself, and a
 * fixed set of Postgres SQLSTATEs — and rewraps them as
 * `UnrecoverableJobError` so the queue worker fails the job on attempt
 * #1 instead of burning the full retry budget.
 *
 * Without a direct unit test, a future refactor could silently drop one
 * of these branches (e.g. forget to add `RangeError`, or change the
 * SQLSTATE list) and the worker would start retrying inputs that can
 * never succeed. These tests pin every branch so any regression fails
 * loudly here before reaching production.
 *
 * #95 — keep the structural-error wrapper unit-tested so future
 * structural error types stay non-retryable by construction.
 *
 * No DB, no HTTP, no I/O — pure function under test.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PERMANENT_PG_SQLSTATES,
  isPermanentStructuralError,
  wrapStructuralError,
} from "../src/lib/jobs/handlers";
import { UnrecoverableJobError } from "../src/lib/jobs/queue";
import { StructuralIngestError } from "../src/lib/structural-ingest-error";

/**
 * Invoke `wrapStructuralError` and capture the thrown value. The
 * function's signature is `(err) => never`, so we always expect a
 * throw; the helper just makes the call sites read like normal
 * assertions instead of nested try/catch blocks.
 */
function callAndCatch(err: unknown): unknown {
  try {
    wrapStructuralError(err);
  } catch (caught) {
    return caught;
  }
  throw new Error("wrapStructuralError did not throw");
}

test("wrapStructuralError: passes UnrecoverableJobError through unchanged", () => {
  const original = new UnrecoverableJobError("already-permanent");
  const caught = callAndCatch(original);
  assert.strictEqual(
    caught,
    original,
    "UnrecoverableJobError must be re-thrown by reference (no double-wrap)",
  );
  // Defensive: ensure we did not nest the error inside itself via cause.
  assert.equal(
    (caught as Error).cause,
    undefined,
    "no cause should be attached when re-throwing the same error",
  );
});

test("wrapStructuralError: wraps StructuralIngestError as UnrecoverableJobError", () => {
  const original = new StructuralIngestError("bad row", {
    field: "supplier.name",
    value: "",
  });
  const caught = callAndCatch(original);
  assert.ok(
    caught instanceof UnrecoverableJobError,
    "must rewrap as UnrecoverableJobError",
  );
  assert.equal((caught as Error).message, "bad row", "message preserved");
  assert.strictEqual(
    (caught as Error).cause,
    original,
    "original error preserved as cause",
  );
});

test("wrapStructuralError: wraps any error carrying the unrecoverable: true brand", () => {
  // Anything tagged with the brand — even a plain Error — must be
  // recognised. This is the escape hatch that lets non-handler modules
  // mark their own errors as permanent without importing the queue.
  const original = Object.assign(new Error("branded permanent failure"), {
    unrecoverable: true,
  });
  const caught = callAndCatch(original);
  assert.ok(caught instanceof UnrecoverableJobError);
  assert.equal((caught as Error).message, "branded permanent failure");
  assert.strictEqual((caught as Error).cause, original);
});

test("wrapStructuralError: wraps TypeError as UnrecoverableJobError", () => {
  const original = new TypeError("Cannot read properties of undefined");
  const caught = callAndCatch(original);
  assert.ok(caught instanceof UnrecoverableJobError);
  assert.equal(
    (caught as Error).message,
    "Cannot read properties of undefined",
  );
  assert.strictEqual((caught as Error).cause, original);
});

test("wrapStructuralError: wraps RangeError as UnrecoverableJobError", () => {
  const original = new RangeError("Invalid array length");
  const caught = callAndCatch(original);
  assert.ok(caught instanceof UnrecoverableJobError);
  assert.equal((caught as Error).message, "Invalid array length");
  assert.strictEqual((caught as Error).cause, original);
});

test("wrapStructuralError: wraps SyntaxError as UnrecoverableJobError", () => {
  const original = new SyntaxError("Unexpected token } in JSON at position 7");
  const caught = callAndCatch(original);
  assert.ok(caught instanceof UnrecoverableJobError);
  assert.equal(
    (caught as Error).message,
    "Unexpected token } in JSON at position 7",
  );
  assert.strictEqual((caught as Error).cause, original);
});

test("wrapStructuralError: wraps every recognised Postgres SQLSTATE", async (t) => {
  // The SQLSTATE list is the contract — every code in the exported set
  // must round-trip through the wrapper as UnrecoverableJobError. If
  // someone removes a code, this loop fails for that code instead of
  // letting bad-input rows silently retry forever in production.
  for (const code of PERMANENT_PG_SQLSTATES) {
    await t.test(`SQLSTATE ${code} is structural`, () => {
      const original = Object.assign(new Error(`pg error ${code}`), {
        code,
      });
      const caught = callAndCatch(original);
      assert.ok(
        caught instanceof UnrecoverableJobError,
        `SQLSTATE ${code} must be wrapped`,
      );
      assert.equal((caught as Error).message, `pg error ${code}`);
      assert.strictEqual((caught as Error).cause, original);
    });
  }

  // Sanity-check the set itself so an accidental mutation of the
  // exported constant would also fail loudly.
  assert.deepEqual(
    [...PERMANENT_PG_SQLSTATES].sort(),
    ["22001", "22007", "22008", "22P02", "23502"],
    "PERMANENT_PG_SQLSTATES must contain exactly the documented codes",
  );
});

test("wrapStructuralError: passes plain Error through unchanged", () => {
  // The classic "transient" shape — a plain Error with no SQLSTATE
  // and no brand. Must propagate as-is so the queue worker's normal
  // exponential-backoff retry policy can still apply.
  const original = new Error("connection blip");
  const caught = callAndCatch(original);
  assert.strictEqual(
    caught,
    original,
    "plain Error must not be wrapped (would burn retry budget)",
  );
  assert.ok(
    !(caught instanceof UnrecoverableJobError),
    "plain Error must NOT become UnrecoverableJobError",
  );
});

test("wrapStructuralError: passes through Errors with non-permanent SQLSTATEs", () => {
  // 08006 = connection_failure — explicitly transient. Must propagate
  // so the worker retries with backoff.
  const original = Object.assign(new Error("connection_failure"), {
    code: "08006",
  });
  const caught = callAndCatch(original);
  assert.strictEqual(caught, original);
  assert.ok(!(caught instanceof UnrecoverableJobError));
});

test("wrapStructuralError: passes through Errors whose `code` is not a string", () => {
  // The wrapper deliberately checks `typeof code === 'string'` so a
  // numeric or object `code` field on an unrelated library's error
  // can't accidentally trip the SQLSTATE branch.
  const original = Object.assign(new Error("not actually pg"), {
    code: 23502, // number, not the string "23502"
  });
  const caught = callAndCatch(original);
  assert.strictEqual(caught, original);
  assert.ok(!(caught instanceof UnrecoverableJobError));
});

test("wrapStructuralError: passes through Errors with unrecoverable: false", () => {
  // The brand check must be strict equality with `true` — a falsy or
  // non-true value must NOT mark the error as permanent.
  const original = Object.assign(new Error("not branded"), {
    unrecoverable: false,
  });
  const caught = callAndCatch(original);
  assert.strictEqual(caught, original);
  assert.ok(!(caught instanceof UnrecoverableJobError));

  const truthyButNotTrue = Object.assign(new Error("truthy brand"), {
    unrecoverable: 1,
  });
  const caught2 = callAndCatch(truthyButNotTrue);
  assert.strictEqual(caught2, truthyButNotTrue);
});

test("wrapStructuralError: passes through non-Error throwables", () => {
  // Some libraries throw non-Error values (strings, plain objects).
  // Without a brand or a SQLSTATE code these are not structural and
  // must propagate untouched.
  const stringThrowable = "boom";
  assert.strictEqual(callAndCatch(stringThrowable), stringThrowable);

  const objectThrowable = { foo: "bar" };
  assert.strictEqual(callAndCatch(objectThrowable), objectThrowable);

  // null / undefined must not crash the type-guard either.
  assert.strictEqual(callAndCatch(null), null);
  assert.strictEqual(callAndCatch(undefined), undefined);
});

test("isPermanentStructuralError: agrees with wrapStructuralError on every branch", () => {
  // Cross-check the predicate's verdict against the wrapper's
  // behaviour. They are separate functions; if one drifts from the
  // other a regression in either path will fail this test.
  const permanent: unknown[] = [
    new UnrecoverableJobError("u"),
    new StructuralIngestError("s"),
    Object.assign(new Error("branded"), { unrecoverable: true }),
    new TypeError("t"),
    new RangeError("r"),
    new SyntaxError("y"),
    Object.assign(new Error("pg"), { code: "23502" }),
    Object.assign(new Error("pg"), { code: "22P02" }),
    Object.assign(new Error("pg"), { code: "22001" }),
    Object.assign(new Error("pg"), { code: "22007" }),
    Object.assign(new Error("pg"), { code: "22008" }),
  ];
  for (const err of permanent) {
    assert.equal(
      isPermanentStructuralError(err),
      true,
      `expected permanent: ${(err as Error)?.name ?? typeof err}`,
    );
  }

  const transient: unknown[] = [
    new Error("plain"),
    Object.assign(new Error("pg-transient"), { code: "08006" }),
    Object.assign(new Error("brand-false"), { unrecoverable: false }),
    Object.assign(new Error("numeric-code"), { code: 23502 }),
    "string throwable",
    { plain: "object" },
    null,
    undefined,
  ];
  for (const err of transient) {
    assert.equal(
      isPermanentStructuralError(err),
      false,
      `expected transient: ${typeof err === "object" && err !== null ? (err as Error).message ?? "obj" : String(err)}`,
    );
  }
});
