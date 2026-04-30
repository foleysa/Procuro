/**
 * Unit tests for the PATCH /contracts/:id body schema.
 *
 * The PATCH endpoint feeds straight into the audit-log writer
 * (every changed field becomes a row in `contract_audit_log`), so the
 * schema is the *only* line of defence against operators sneaking in
 * unbounded notes, malformed dates, or unintended-cleared ownership.
 *
 * These are pure schema tests — no DB, no Express — to keep them fast
 * and to keep the failure mode tightly scoped to the schema itself.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env["DATABASE_URL"] ??= "postgres://placeholder/disabled";

import { patchContractBodySchema } from "../src/routes/contracts";

test("patchContractBodySchema: empty object is valid (no-op patch)", () => {
  const parsed = patchContractBodySchema.parse({});
  assert.deepEqual(parsed, {});
});

test("patchContractBodySchema: trims strings and collapses '' to null", () => {
  const parsed = patchContractBodySchema.parse({
    owner: "  Alice  ",
    internalNotes: "",
    renewalTargetAction: "   ",
  });
  assert.equal(parsed.owner, "Alice");
  assert.equal(parsed.internalNotes, null);
  assert.equal(parsed.renewalTargetAction, null);
});

test("patchContractBodySchema: explicit null clears the field", () => {
  const parsed = patchContractBodySchema.parse({
    owner: null,
    internalNotes: null,
    renewalTargetAction: null,
    renewalTargetDate: null,
  });
  assert.equal(parsed.owner, null);
  assert.equal(parsed.internalNotes, null);
  assert.equal(parsed.renewalTargetAction, null);
  assert.equal(parsed.renewalTargetDate, null);
});

test("patchContractBodySchema: parses ISO datetime with offset to Date", () => {
  const parsed = patchContractBodySchema.parse({
    renewalTargetDate: "2026-09-01T00:00:00Z",
  });
  assert.ok(parsed.renewalTargetDate instanceof Date);
  assert.equal(
    (parsed.renewalTargetDate as Date).toISOString(),
    "2026-09-01T00:00:00.000Z",
  );
});

test("patchContractBodySchema: rejects naive date string", () => {
  assert.throws(() =>
    patchContractBodySchema.parse({ renewalTargetDate: "2026-09-01" }),
  );
});

test("patchContractBodySchema: rejects oversized internal notes", () => {
  assert.throws(() =>
    patchContractBodySchema.parse({ internalNotes: "x".repeat(5001) }),
  );
});

test("patchContractBodySchema: rejects oversized owner", () => {
  assert.throws(() =>
    patchContractBodySchema.parse({ owner: "y".repeat(201) }),
  );
});

test("patchContractBodySchema: strips unknown fields", () => {
  const parsed = patchContractBodySchema.parse({
    owner: "Bob",
    // contract_number must NEVER be patchable from this endpoint —
    // it's append-only history; the schema must drop the unknown key.
    contractNumber: "MAL-001",
    status: "terminated",
  } as Record<string, unknown>);
  assert.equal(parsed.owner, "Bob");
  assert.ok(!("contractNumber" in parsed));
  assert.ok(!("status" in parsed));
});
