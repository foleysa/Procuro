/**
 * Unit tests for the import-error sanitizer.
 *
 * The sanitizer's job is to convert a thrown `pg`/Drizzle `DatabaseError`
 * into a short, user-safe summary that we can return in an HTTP `error`
 * field without leaking the failing SQL statement, the bound parameter
 * values, or the `detail`/`hint` text (which often quotes the offending
 * row value).
 *
 * Each case below either:
 *   1. Asserts that a known data-leaking substring (SQL keyword, parameter
 *      placeholder, customer value, etc.) is *absent* from the sanitized
 *      message, and/or
 *   2. Asserts that a known-safe identifier (table/column/constraint name)
 *      *is* preserved, since those are how operators triage failed imports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeDbErrorMessage,
  errorLogContext,
} from "../src/lib/sanitize-db-error";

/**
 * Build a minimal stand-in for a `pg` `DatabaseError`. The `pg` driver
 * exports its own subclass, but our sanitizer intentionally duck-types on
 * the SQLSTATE `code` field so Drizzle wrappers (which sometimes rethrow a
 * plain `Error` carrying the same fields) are also handled.
 */
function makePgError(fields: {
  message: string;
  code?: string;
  table?: string;
  column?: string;
  constraint?: string;
  detail?: string;
}): Error {
  const e = new Error(fields.message);
  Object.assign(e, fields);
  return e;
}

test("strips the failing SQL statement and parameter values", () => {
  const err = makePgError({
    message:
      'duplicate key value violates unique constraint "suppliers_org_external_id_uq"\n' +
      'Failing query: insert into "suppliers" ("org_id", "external_id", "name") ' +
      "values ($1, $2, $3) returning *\n" +
      'Params: ["00000000-0000-0000-0000-000000000001", "SUP-001", "Acme Industrial"]',
    code: "23505",
    table: "suppliers",
    constraint: "suppliers_org_external_id_uq",
    detail: "Key (external_id)=(SUP-001) already exists.",
  });

  const msg = sanitizeDbErrorMessage(err);

  for (const banned of [
    "insert into",
    "$1",
    "$2",
    "values",
    "Params",
    "SUP-001",
    "Acme Industrial",
    "00000000-0000-0000-0000-000000000001",
    "Failing query",
    "Key (",
    "already exists",
  ]) {
    assert.ok(
      !msg.includes(banned),
      `sanitized message must not include "${banned}", got: ${msg}`,
    );
  }
  assert.ok(
    msg.toLowerCase().includes("duplicate"),
    `expected unique violation summary, got: ${msg}`,
  );
  assert.ok(
    msg.includes("suppliers"),
    `expected table name to be preserved, got: ${msg}`,
  );
  assert.ok(
    msg.includes("suppliers_org_external_id_uq"),
    `expected constraint name to be preserved, got: ${msg}`,
  );
});

test("foreign key violation surfaces table+column without the offending value", () => {
  const err = makePgError({
    message:
      'insert or update on table "invoices" violates foreign key constraint ' +
      '"invoices_supplier_id_fk"\n' +
      'Failing query: insert into "invoices" ("supplier_id") values ($1)\n' +
      'Params: ["bogus-supplier-id-123"]',
    code: "23503",
    table: "invoices",
    column: "supplier_id",
    constraint: "invoices_supplier_id_fk",
    detail: 'Key (supplier_id)=(bogus-supplier-id-123) is not present in table "suppliers".',
  });

  const msg = sanitizeDbErrorMessage(err);

  assert.ok(!msg.includes("bogus-supplier-id-123"), `leaked param: ${msg}`);
  assert.ok(!msg.includes("$1"), `leaked param placeholder: ${msg}`);
  assert.ok(!msg.toLowerCase().includes("insert"), `leaked SQL keyword: ${msg}`);
  assert.ok(msg.includes("Foreign key"), `expected FK summary, got: ${msg}`);
  assert.ok(
    msg.includes("invoices.supplier_id"),
    `expected table.column reference, got: ${msg}`,
  );
});

test("not-null violation hides the row value but keeps the column", () => {
  const err = makePgError({
    message:
      'null value in column "amount_usd" of relation "invoices" violates not-null constraint\n' +
      'Failing row contains (null, "INV-2025-001", "$987,654.32", ...)',
    code: "23502",
    table: "invoices",
    column: "amount_usd",
  });

  const msg = sanitizeDbErrorMessage(err);

  assert.ok(!msg.includes("INV-2025-001"), `leaked invoice number: ${msg}`);
  assert.ok(!msg.includes("987,654.32"), `leaked invoice amount: ${msg}`);
  assert.ok(!msg.includes("Failing row"), `leaked SQL phrase: ${msg}`);
  assert.ok(
    msg.toLowerCase().includes("required"),
    `expected not-null summary, got: ${msg}`,
  );
  assert.ok(
    msg.includes("invoices.amount_usd"),
    `expected table.column reference, got: ${msg}`,
  );
});

test("unknown SQLSTATE codes still produce a generic, safe message", () => {
  const err = makePgError({
    message:
      "some weird internal error\nFailing query: select * from secret_table where pwd = $1\nParams: [\"hunter2\"]",
    code: "XX999",
    table: "secret_table",
  });

  const msg = sanitizeDbErrorMessage(err);

  assert.ok(!msg.includes("hunter2"), `leaked param: ${msg}`);
  assert.ok(!msg.toLowerCase().includes("select"), `leaked SQL keyword: ${msg}`);
  assert.ok(!msg.includes("$1"), `leaked param placeholder: ${msg}`);
  assert.ok(msg.includes("XX999"), `expected SQLSTATE in fallback: ${msg}`);
});

test("plain Errors with arbitrary text fall back to a generic message", () => {
  const err = new Error(
    "boom: select * from suppliers where external_id = $1 -- params: [\"SUP-001\"]",
  );
  const msg = sanitizeDbErrorMessage(err);

  assert.ok(!msg.includes("SUP-001"), `leaked param value: ${msg}`);
  assert.ok(!msg.includes("$1"), `leaked param placeholder: ${msg}`);
  assert.ok(!msg.toLowerCase().includes("select"), `leaked SQL: ${msg}`);
  assert.equal(msg, "Internal server error during import");
});

test("known-safe error messages from our own code are preserved", () => {
  const samples = [
    "Upload exceeded 1073741824-byte (1 GB) per-request limit",
    "Upload too large: 5000000000 bytes exceeds the 1073741824-byte (1 GB) per-request limit. Split the file into smaller chunks.",
    "multipart/form-data request did not include a `file` part",
    "Invalid or missing 'entity' query parameter. Must be one of: suppliers, items",
    "Synchronous ingest is limited to 5000 total records. Received 6000. Use ?async=true for larger payloads.",
  ];
  for (const s of samples) {
    assert.equal(sanitizeDbErrorMessage(new Error(s)), s);
  }
});

test("rejects suspicious values masquerading as identifiers", () => {
  // A buggy or malicious driver could populate `table`/`column` with
  // arbitrary text. The sanitizer enforces an identifier shape so
  // smuggled SQL or row values can't ride along.
  const err = makePgError({
    message: "boom",
    code: "23505",
    table: "suppliers; drop table users; --",
    column: "name = 'Acme'",
    constraint: "ok_constraint_name",
  });
  const msg = sanitizeDbErrorMessage(err);

  assert.ok(!msg.includes("drop table"), `leaked SQL via table: ${msg}`);
  assert.ok(!msg.includes("users"), `leaked SQL via table: ${msg}`);
  assert.ok(!msg.includes("'Acme'"), `leaked value via column: ${msg}`);
  assert.ok(
    msg.includes("ok_constraint_name"),
    `well-formed constraint should still appear: ${msg}`,
  );
});

test("unwraps a Drizzle-style wrapper that carries the pg fields on `cause`", () => {
  // Drizzle's `DrizzleQueryError` rethrows the underlying `pg.DatabaseError`
  // on `.cause`. The outer wrapper's own message is the noisy
  // `Failed query: ... params: [...]` string and it has no `code` / `table`
  // / `constraint` of its own. Without unwrapping, the sanitizer has
  // nothing to work with and falls all the way through to the static
  // generic fallback — exactly the regression operators were complaining
  // about. Once unwrapped, we should produce the same friendly summary
  // we'd produce if the bare pg.DatabaseError had been thrown directly.
  const inner = makePgError({
    message:
      'duplicate key value violates unique constraint "suppliers_org_external_id_uq"',
    code: "23505",
    table: "suppliers",
    constraint: "suppliers_org_external_id_uq",
    detail: "Key (external_id)=(SUP-001) already exists.",
  });
  const wrapper = new Error(
    'Failed query: insert into "suppliers" ("org_id", "external_id", "name") ' +
      "values ($1, $2, $3) returning *\n" +
      'params: ["00000000-0000-0000-0000-000000000001","SUP-001","Acme Industrial"]',
  );
  // Mirror the shape produced by Drizzle's `DrizzleQueryError`: the SQLSTATE
  // / table / constraint live on `cause`, not on the wrapper itself.
  Object.assign(wrapper, { cause: inner });

  const msg = sanitizeDbErrorMessage(wrapper);

  // Must NOT collapse to the static fallback any more — that was the
  // whole point of the unwrap.
  assert.notEqual(msg, "Internal server error during import");
  // Must NOT echo the wrapper's noisy SQL/params string.
  for (const banned of [
    "insert into",
    "$1",
    "$2",
    "$3",
    "values",
    "params",
    "Failed query",
    "SUP-001",
    "Acme Industrial",
    "00000000-0000-0000-0000-000000000001",
  ]) {
    assert.ok(
      !msg.includes(banned),
      `unwrapped message must not include "${banned}", got: ${msg}`,
    );
  }
  // Must produce the same friendly headline as the unwrapped case.
  assert.ok(
    msg.toLowerCase().includes("duplicate"),
    `expected unique-violation summary from cause, got: ${msg}`,
  );
  assert.ok(
    msg.includes("suppliers"),
    `expected table name preserved from cause, got: ${msg}`,
  );
  assert.ok(
    msg.includes("suppliers_org_external_id_uq"),
    `expected constraint name preserved from cause, got: ${msg}`,
  );
});

test("does not chase a self-referential `cause`", () => {
  // Defensive guard: if a buggy wrapper sets `err.cause = err` we must
  // not infinite-loop. The sanitizer should treat it as a non-DB error
  // and return the generic fallback rather than hanging.
  const err = new Error("boom");
  Object.assign(err, { cause: err });
  const msg = sanitizeDbErrorMessage(err);
  assert.equal(msg, "Internal server error during import");
});

test("errorLogContext captures full message and structured pg fields", () => {
  const err = makePgError({
    message: "duplicate key value violates unique constraint",
    code: "23505",
    table: "suppliers",
    column: "external_id",
    constraint: "suppliers_external_id_uq",
  });

  const ctx = errorLogContext(err);

  assert.equal(ctx["errMessage"], "duplicate key value violates unique constraint");
  assert.equal(ctx["pgCode"], "23505");
  assert.equal(ctx["pgTable"], "suppliers");
  assert.equal(ctx["pgColumn"], "external_id");
  assert.equal(ctx["pgConstraint"], "suppliers_external_id_uq");
  assert.ok(typeof ctx["stack"] === "string");
});
