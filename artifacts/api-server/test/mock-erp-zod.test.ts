/**
 * Field-level Zod validation for `POST /api/ingest/mock-erp` (#99).
 *
 * Why this exists
 * ---------------
 * Before #99 the route's only check was `Array.isArray(body.feed)`. A
 * caller that posted a typo'd field name (`external_id` instead of
 * `externalId`), an empty `externalId`, a non-ISO `updatedAt`, or a
 * non-object `payload` got back 200 OK and a confusing downstream
 * upsert collision because the adapter silently coerced the bad row
 * into a `null`-keyed write. This test pins the new contract:
 *
 *   1. Well-formed bodies still succeed (200 OK; no regression).
 *   2. Each malformed body case returns 400 with a structured
 *      `issues` array whose `path` points at the offending field.
 *
 * The test fires real HTTP requests against the in-process Express
 * `app` (same pattern as `csv-ingest-error-sanitization.test.ts`) so a
 * future change that strips the validator from the handler — e.g.
 * replacing `safeParse` with a `as MockErpBody` cast — is caught
 * end-to-end, not just at the schema boundary.
 *
 * The validator itself is checked indirectly: each malformed case
 * targets one specific Zod rule (enum membership, min length, ISO
 * timestamp, type=object). Adding a new rule to `MockErpRecordSchema`
 * should come with a new sub-test here.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Match the auth/dev wiring used by the other route-level tests; the
// auth middleware reads NODE_ENV at module import time.
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { db, orgsTable, pool } from "@workspace/db";
import app from "../src/app";

let server: http.Server;
let baseUrl: string;
let orgId: string;

before(async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) {
    throw new Error(
      "No org rows found. Seed the database before running this test.",
    );
  }
  orgId = row.id;

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind test server");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) await new Promise<void>((res) => server.close(() => res()));
  await pool.end().catch(() => {});
});

interface ZodIssue {
  path: ReadonlyArray<string | number>;
  message: string;
  code?: string;
}

interface ErrorResponse {
  error: string;
  issues: ZodIssue[];
}

async function postMockErp(body: unknown): Promise<{
  status: number;
  json: unknown;
}> {
  const res = await fetch(`${baseUrl}/api/ingest/mock-erp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-org-id": orgId,
    },
    body: JSON.stringify(body),
  });
  // The 4xx body is always JSON for this route. The 200 body is the
  // adapter's `SyncResult`, also JSON. Either way, parsing is safe.
  const json = await res.json();
  return { status: res.status, json };
}

function assertHasIssueAtPath(
  body: unknown,
  expectedPath: ReadonlyArray<string | number>,
  label: string,
): void {
  const e = body as ErrorResponse;
  assert.ok(Array.isArray(e.issues), `[${label}] issues array present`);
  const found = e.issues.find(
    (it) =>
      it.path.length === expectedPath.length &&
      it.path.every((p, i) => p === expectedPath[i]),
  );
  assert.ok(
    found,
    `[${label}] expected issue at path [${expectedPath.join(", ")}]; ` +
      `got: ${JSON.stringify(e.issues)}`,
  );
}

test("POST /api/ingest/mock-erp Zod validation", async (t) => {
  await t.test("accepts a well-formed empty feed (no regression)", async () => {
    const res = await postMockErp({ feed: [] });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  });

  await t.test(
    "accepts a well-formed single supplier record (no regression)",
    async () => {
      const res = await postMockErp({
        feed: [
          {
            type: "supplier",
            externalId: `mock-zod-test-${Date.now()}`,
            updatedAt: new Date().toISOString(),
            payload: { name: "Smoke-test Supplier" },
          },
        ],
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    },
  );

  await t.test("rejects body where `feed` is missing", async () => {
    const res = await postMockErp({});
    assert.equal(res.status, 400);
    assertHasIssueAtPath(res.json, ["feed"], "missing-feed");
  });

  await t.test("rejects body where `feed` is not an array", async () => {
    const res = await postMockErp({ feed: "not-an-array" });
    assert.equal(res.status, 400);
    assertHasIssueAtPath(res.json, ["feed"], "feed-not-array");
  });

  await t.test(
    "rejects record with type outside the {supplier|purchase_order|invoice} enum",
    async () => {
      const res = await postMockErp({
        feed: [
          {
            type: "contract", // not in the enum
            externalId: "x",
            updatedAt: new Date().toISOString(),
            payload: {},
          },
        ],
      });
      assert.equal(res.status, 400);
      assertHasIssueAtPath(res.json, ["feed", 0, "type"], "bad-enum");
    },
  );

  await t.test("rejects record with empty externalId", async () => {
    const res = await postMockErp({
      feed: [
        {
          type: "supplier",
          externalId: "",
          updatedAt: new Date().toISOString(),
          payload: {},
        },
      ],
    });
    assert.equal(res.status, 400);
    assertHasIssueAtPath(res.json, ["feed", 0, "externalId"], "empty-externalId");
  });

  await t.test("rejects record with non-ISO updatedAt", async () => {
    const res = await postMockErp({
      feed: [
        {
          type: "supplier",
          externalId: "x",
          updatedAt: "yesterday afternoon",
          payload: {},
        },
      ],
    });
    assert.equal(res.status, 400);
    assertHasIssueAtPath(res.json, ["feed", 0, "updatedAt"], "bad-timestamp");
  });

  await t.test("rejects record with payload that is not an object", async () => {
    const res = await postMockErp({
      feed: [
        {
          type: "supplier",
          externalId: "x",
          updatedAt: new Date().toISOString(),
          payload: "not-an-object",
        },
      ],
    });
    assert.equal(res.status, 400);
    assertHasIssueAtPath(res.json, ["feed", 0, "payload"], "bad-payload-type");
  });

  await t.test(
    "pinpoints the bad index when only one record in a batch is malformed",
    async () => {
      // Two valid records sandwiching one with an invalid `type`. The
      // returned issues array should reference index 1 specifically — the
      // operator UX win over the old "Body must include `feed` array".
      const res = await postMockErp({
        feed: [
          {
            type: "supplier",
            externalId: "ok-1",
            updatedAt: new Date().toISOString(),
            payload: {},
          },
          {
            type: "totally-not-valid",
            externalId: "bad",
            updatedAt: new Date().toISOString(),
            payload: {},
          },
          {
            type: "invoice",
            externalId: "ok-2",
            updatedAt: new Date().toISOString(),
            payload: {},
          },
        ],
      });
      assert.equal(res.status, 400);
      assertHasIssueAtPath(res.json, ["feed", 1, "type"], "middle-record-bad");
    },
  );

  await t.test("rejects body with non-ISO cursor", async () => {
    const res = await postMockErp({
      feed: [],
      cursor: "next-tuesday",
    });
    assert.equal(res.status, 400);
    assertHasIssueAtPath(res.json, ["cursor"], "bad-cursor");
  });
});
