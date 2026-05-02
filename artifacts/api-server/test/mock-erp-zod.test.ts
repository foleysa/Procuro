/**
 * Field-level Zod validation for `POST /api/ingest/mock-erp` (#99).
 *
 * Background
 * ----------
 * Before #99 the route's only check was `Array.isArray(body.feed)`. A
 * caller that posted a typo'd field name (`external_id` instead of
 * `externalId`), an empty `externalId`, a non-ISO `updatedAt`, or a
 * non-object `payload` got back 200 OK and a confusing downstream
 * upsert collision because the adapter silently coerced the bad row
 * into a `null`-keyed write.
 *
 * The route now does `mockErpIngestBodySchema.parse(req.body)` and
 * lets the thrown `ZodError` bubble up to `globalErrorHandler`, which
 * maps it to the standard `400 { error: "Invalid request", details:
 * [...] }` shape — the same wire contract the collectors routes (#92)
 * and the opportunity action endpoints (#98) ship.
 *
 * Why share the schema with production
 * ------------------------------------
 * The production route wraps the parse call in `tenantMiddleware`,
 * which performs a DB lookup before the handler ever runs. To keep
 * these tests hermetic (no DB, no fixtures), we import the very same
 * exported `mockErpIngestBodySchema` constant from the route module
 * and mount it on a tiny Express app behind the real
 * `globalErrorHandler`. That guarantees:
 *
 *   - Schema regressions (e.g. dropping a field, widening an enum)
 *     are caught because production and the test parse the same
 *     `ZodSchema` instance.
 *   - Wire-shape regressions in the global handler are caught because
 *     we mount the production handler middleware unchanged.
 *
 * Mirrors `test/opportunities-action-validation.test.ts`. Adding a
 * new rule to the schema should come with a new sub-test here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";

if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const { mockErpIngestBodySchema } = await import("../src/routes/ingest");
const { globalErrorHandler } = await import("../src/lib/global-error-handler");

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // The 500 branch of the real handler calls `req.log.error(...)`. The
  // 400 branch (which is what these tests exercise) deliberately does
  // not log, but pino-http would normally attach `req.log` in
  // production — wire up a no-op so the contract matches.
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: () => void } }).log = {
      error: () => undefined,
    };
    next();
  });
  // Stand in for the production route: `Schema.parse(req.body)`
  // exactly the way the real handler does, then succeed. Any thrown
  // `ZodError` is caught by Express 5's async rejection auto-forward
  // and routed to `globalErrorHandler`.
  app.post(
    "/api/ingest/mock-erp",
    (req: Request, res: Response, next: NextFunction) => {
      try {
        mockErpIngestBodySchema.parse(req.body ?? {});
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );
  app.use(globalErrorHandler);
  return app;
}

interface CapturedResponse {
  status: number;
  body: string;
}

async function withServer<T>(
  app: Express,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("expected an AddressInfo for the test server");
    }
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

async function postMockErp(
  app: Express,
  body: unknown,
): Promise<CapturedResponse> {
  return withServer(app, async (base) => {
    const r = await fetch(`${base}/api/ingest/mock-erp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.text() };
  });
}

interface ValidationErrorBody {
  error: string;
  details: Array<{ path: Array<string | number>; message: string; code?: string }>;
}

function assertHasIssueAtPath(
  json: ValidationErrorBody,
  expectedPath: ReadonlyArray<string | number>,
  label: string,
): void {
  assert.ok(Array.isArray(json.details), `[${label}] details array present`);
  const found = json.details.find(
    (it) =>
      it.path.length === expectedPath.length &&
      it.path.every((p, i) => p === expectedPath[i]),
  );
  assert.ok(
    found,
    `[${label}] expected issue at path [${expectedPath.join(", ")}]; ` +
      `got: ${JSON.stringify(json.details)}`,
  );
}

test("POST /ingest/mock-erp with malformed body returns 400 with field-level details", async () => {
  // Missing `feed` entirely AND a wrong-type `cursor` (object instead
  // of string) — both should surface as separate issues so we can
  // assert the field paths reach the caller, not just one
  // concatenated error string the old hand-rolled validator produced.
  const res = await postMockErp(buildApp(), {
    cursor: { not: "a string" },
  });
  assert.equal(res.status, 400, "malformed POST body must yield 400");
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  assert.ok(
    Array.isArray(json.details),
    "details must be the issues array, not a string",
  );
  const paths = json.details.map((d) => d.path.join("."));
  assert.ok(
    paths.includes("feed"),
    `expected an issue for "feed", got ${paths.join(", ")}`,
  );
  assert.ok(
    paths.includes("cursor"),
    `expected an issue for "cursor", got ${paths.join(", ")}`,
  );
});

test("POST /ingest/mock-erp rejects body where `feed` is not an array", async () => {
  const res = await postMockErp(buildApp(), { feed: "not-an-array" });
  assert.equal(res.status, 400);
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  assertHasIssueAtPath(json, ["feed"], "feed-not-array");
});

test("POST /ingest/mock-erp rejects record with type outside the {supplier|purchase_order|invoice} enum", async () => {
  const res = await postMockErp(buildApp(), {
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
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  assertHasIssueAtPath(json, ["feed", 0, "type"], "bad-enum");
});

test("POST /ingest/mock-erp rejects record with empty externalId", async () => {
  const res = await postMockErp(buildApp(), {
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
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  assertHasIssueAtPath(json, ["feed", 0, "externalId"], "empty-externalId");
});

test("POST /ingest/mock-erp rejects record with non-ISO updatedAt", async () => {
  const res = await postMockErp(buildApp(), {
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
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  assertHasIssueAtPath(json, ["feed", 0, "updatedAt"], "bad-timestamp");
});

test("POST /ingest/mock-erp rejects record with payload that is not an object", async () => {
  const res = await postMockErp(buildApp(), {
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
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  assertHasIssueAtPath(json, ["feed", 0, "payload"], "bad-payload-type");
});

test("POST /ingest/mock-erp pinpoints the bad index when only one record in a batch is malformed", async () => {
  // Two valid records sandwiching one with an invalid `type`. The
  // returned details array should reference index 1 specifically — the
  // operator UX win over the old "Body must include `feed` array".
  const res = await postMockErp(buildApp(), {
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
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  assertHasIssueAtPath(json, ["feed", 1, "type"], "middle-record-bad");
});

test("POST /ingest/mock-erp rejects body with non-ISO cursor", async () => {
  const res = await postMockErp(buildApp(), {
    feed: [],
    cursor: "next-tuesday",
  });
  assert.equal(res.status, 400);
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  assertHasIssueAtPath(json, ["cursor"], "bad-cursor");
});

test("POST /ingest/mock-erp accepts a well-formed body (sanity check on success path)", async () => {
  // Confirm we did not over-tighten the schema. A well-formed feed
  // (with a valid type, ISO timestamp, and object payload) and an
  // optional ISO cursor both reach the success branch.
  const res = await postMockErp(buildApp(), {
    feed: [
      {
        type: "supplier",
        externalId: "mock-zod-test-ok",
        updatedAt: new Date().toISOString(),
        payload: { name: "Smoke-test Supplier" },
      },
    ],
    cursor: new Date().toISOString(),
  });
  assert.equal(res.status, 200, res.body);
});

test("POST /ingest/mock-erp accepts an empty feed (no regression)", async () => {
  const res = await postMockErp(buildApp(), { feed: [] });
  assert.equal(res.status, 200, res.body);
});
