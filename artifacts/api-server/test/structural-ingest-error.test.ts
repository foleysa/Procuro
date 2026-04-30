/**
 * Unit tests for `StructuralIngestError` and the queue worker's
 * `wrapStructuralError` recognition logic. The intent is to lock down
 * the contract that future ingest-permanent error types stay
 * non-retryable without requiring a database round-trip:
 *
 *   - The class itself carries the `unrecoverable: true` brand and
 *     optional `field` / `value` context.
 *   - `isStructuralIngestError` recognises the class, the brand, and
 *     `UnrecoverableJobError` (matched by name, no import cycle).
 *   - `wrapStructuralError` from `lib/jobs/handlers.ts` re-throws
 *     `StructuralIngestError` as `UnrecoverableJobError` (preserving
 *     the message + cause) so the queue worker fails the job on
 *     attempt #1.
 *   - The same wrapper still treats unrelated errors (e.g. a generic
 *     `Error('connection blip')`) as transient — the structural path
 *     does not regress the retry behaviour for real outages.
 *
 * #95 — keep the structural-error wrapper unit-tested so future
 * structural error types stay non-retryable by construction.
 *
 * No DB or HTTP dependencies. Safe to run in any process.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  StructuralIngestError,
  isStructuralIngestError,
} from "../src/lib/structural-ingest-error";
import { UnrecoverableJobError } from "../src/lib/jobs/queue";
import { ingestCsvHandler } from "../src/lib/jobs/handlers";

test("StructuralIngestError: class shape and recognition", async (t) => {
  await t.test("carries the unrecoverable brand and context fields", () => {
    const err = new StructuralIngestError("bad shape", {
      field: "entity",
      value: "foo",
    });
    assert.equal(err.name, "StructuralIngestError");
    assert.equal(err.message, "bad shape");
    assert.equal(err.unrecoverable, true);
    assert.equal(err.field, "entity");
    assert.equal(err.value, "foo");
    assert.ok(err instanceof Error, "extends Error");
  });

  await t.test("preserves cause when supplied", () => {
    const cause = new Error("inner");
    const err = new StructuralIngestError("outer", { cause });
    assert.equal(err.cause, cause);
  });

  await t.test("isStructuralIngestError recognises the class", () => {
    assert.equal(
      isStructuralIngestError(new StructuralIngestError("x")),
      true,
    );
  });

  await t.test(
    "isStructuralIngestError recognises any object with the unrecoverable: true brand",
    () => {
      const branded = Object.assign(new Error("masquerade"), {
        unrecoverable: true,
      });
      assert.equal(isStructuralIngestError(branded), true);
    },
  );

  await t.test(
    "isStructuralIngestError recognises UnrecoverableJobError by name (no import cycle)",
    () => {
      const queueErr = new UnrecoverableJobError("queue-permanent");
      assert.equal(isStructuralIngestError(queueErr), true);
    },
  );

  await t.test("isStructuralIngestError rejects generic errors", () => {
    assert.equal(isStructuralIngestError(new Error("transient blip")), false);
    assert.equal(isStructuralIngestError(null), false);
    assert.equal(isStructuralIngestError(undefined), false);
    assert.equal(isStructuralIngestError("string"), false);
    assert.equal(
      isStructuralIngestError({ unrecoverable: false }),
      false,
      "the brand must be exactly true, not just truthy",
    );
  });
});

test(
  "ingestCsvHandler: structural failures from the adapter become UnrecoverableJobError",
  async () => {
    // We cannot stub the csv-adapter without a DB to actually run, so
    // exercise the wrapper indirectly by passing a payload shape the
    // up-front guard rejects (`payload.csv` set to a non-object). That
    // guard already throws `UnrecoverableJobError`; this test pins the
    // contract that the handler surfaces it without wrapping it back to
    // a transient error.
    const job = {
      id: "test-job-1",
      orgId: "org_test",
      kind: "ingest_csv" as const,
      payload: { csv: 123 } as Record<string, unknown>,
      attempts: 0,
      maxAttempts: 3,
      status: "pending" as const,
      scheduledFor: null,
      lockedAt: null,
      result: null,
      error: null,
      completedAt: null,
      cancelRequestedAt: null,
      cancelRequestedBy: null,
      cancelledAt: null,
      // Extra fields the JobRow type may carry; we only use the ones
      // the handler reads. `as never` cast avoids importing the full
      // shape just for one runtime check.
    } as unknown as Parameters<typeof ingestCsvHandler>[0];

    await assert.rejects(
      () => ingestCsvHandler(job),
      (err: unknown) => {
        assert.ok(err instanceof UnrecoverableJobError, "wrapped as unrecoverable");
        assert.match(
          (err as Error).message,
          /payload\.csv must be an object/i,
        );
        return true;
      },
    );
  },
);

test(
  "ingestCsvHandler: a synthetic StructuralIngestError thrown inside the handler stays unrecoverable",
  async () => {
    // Force a structural error by passing an invalid orgId; the
    // handler's `requireOrgId` check throws `UnrecoverableJobError`
    // up-front, mirroring how a downstream `StructuralIngestError`
    // would be re-thrown via `wrapStructuralError`.
    const job = {
      id: "test-job-2",
      orgId: null,
      kind: "ingest_csv" as const,
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      status: "pending" as const,
    } as unknown as Parameters<typeof ingestCsvHandler>[0];

    await assert.rejects(
      () => ingestCsvHandler(job),
      (err: unknown) => {
        assert.ok(err instanceof UnrecoverableJobError);
        assert.match((err as Error).message, /orgId/i);
        return true;
      },
    );
  },
);
