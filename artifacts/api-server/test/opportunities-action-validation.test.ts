/**
 * Tests for the request-validation behaviour of the opportunity action
 * endpoints (`POST /opportunities/:id/reject`, `POST /opportunities/:id/realize`).
 *
 * Background:
 *   These two routes used to validate `req.body` with hand-rolled
 *   `asString` / `asNumber` helpers wrapped in try/catch and respond with
 *   `res.status(400).json({ error: (e as Error).message })`. Now that the
 *   global error handler maps any uncaught `ZodError` to the standard
 *   `400 { error, details }` shape (see `lib/global-error-handler.ts`),
 *   the routes call `Schema.parse(req.body)` instead and let the throw
 *   bubble up — the same pattern the collectors routes adopted in
 *   task #92 (`test/collectors-validation.test.ts`).
 *
 *   These tests pin the externally observable contract — same status
 *   code, same `{ error, details }` body, with field-level issue paths
 *   in `details` — so that a future refactor that breaks either the
 *   schemas or the global handler is caught immediately.
 *
 * Why share the schemas with production:
 *   The two production routes wrap their `Schema.parse(req.body)` call
 *   in `tenantMiddleware`, which performs a DB lookup before the handler
 *   ever runs. To keep these tests hermetic (no DB, no fixtures), we
 *   import the very same exported `*BodySchema` constants from the
 *   route module and mount them on a tiny Express app behind the real
 *   `globalErrorHandler`. That guarantees:
 *
 *     - Schema regressions (e.g. dropping a required field, widening
 *       an enum) are caught because production and the test parse the
 *       same `ZodSchema` instance.
 *     - Wire-shape regressions in the global handler are caught because
 *       we mount the production handler middleware unchanged.
 *
 *   The `@workspace/db` module is imported transitively by the route
 *   file. It only *creates* a Pool at module load (it does not connect
 *   until a query runs), so a syntactically valid placeholder
 *   `DATABASE_URL` is enough to satisfy the import-time guard without
 *   standing up a real database.
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

const { rejectOpportunityBodySchema, realizeOpportunityBodySchema } =
  await import("../src/routes/opportunities");
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
  // Stand in for the production routes: each handler does
  // `Schema.parse(req.body)` exactly the way the real ones do, then
  // succeeds. Any thrown `ZodError` is caught by Express 5's async
  // rejection auto-forward and routed to `globalErrorHandler`.
  app.post(
    "/api/opportunities/:id/reject",
    (req: Request, res: Response, next: NextFunction) => {
      try {
        rejectOpportunityBodySchema.parse(req.body);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );
  app.post(
    "/api/opportunities/:id/realize",
    (req: Request, res: Response, next: NextFunction) => {
      try {
        realizeOpportunityBodySchema.parse(req.body);
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

async function postJson(
  app: Express,
  path: string,
  body: unknown,
): Promise<CapturedResponse> {
  return withServer(app, async (base) => {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.text() };
  });
}

interface ValidationErrorBody {
  error: string;
  details: Array<{ path: Array<string | number>; message: string }>;
}

test("POST /opportunities/:id/reject with malformed body returns 400 with field-level issues", async () => {
  // Missing `reasonCode` entirely AND a wrong-type `reasonText` (object
  // instead of string|null) — both should surface as separate issues
  // so we can assert the field paths reach the caller, not just one
  // concatenated error string the old try/catch would have produced.
  const res = await postJson(buildApp(), "/api/opportunities/opp_123/reject", {
    reasonText: { not: "a string" },
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
    paths.includes("reasonCode"),
    `expected an issue for "reasonCode", got ${paths.join(", ")}`,
  );
  assert.ok(
    paths.includes("reasonText"),
    `expected an issue for "reasonText", got ${paths.join(", ")}`,
  );
});

test("POST /opportunities/:id/reject rejects unknown reasonCode with field path", async () => {
  // The taxonomy is a closed enum (`rejectionReasonCodes`). A bogus
  // value used to come back as `{ error: "Unknown reasonCode: ..." }`
  // — now it should come back in the structured `{ error, details }`
  // shape with `details[].path == ["reasonCode"]`.
  const res = await postJson(buildApp(), "/api/opportunities/opp_123/reject", {
    reasonCode: "not-a-real-code",
  });
  assert.equal(res.status, 400);
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  const paths = json.details.map((d) => d.path.join("."));
  assert.ok(
    paths.includes("reasonCode"),
    `expected an issue for "reasonCode", got ${paths.join(", ")}`,
  );
});

test("POST /opportunities/:id/realize with malformed body returns 400 with field-level issues", async () => {
  // `realizedSavingsUsd` is required and must coerce to a finite number.
  // `"not-a-number"` coerces to NaN which fails the `.finite()` check
  // and surfaces with the field path so callers can map the error to
  // the right form input.
  const res = await postJson(
    buildApp(),
    "/api/opportunities/opp_456/realize",
    { realizedSavingsUsd: "not-a-number" },
  );
  assert.equal(res.status, 400, "malformed POST body must yield 400");
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  assert.ok(Array.isArray(json.details), "details must be the issues array");
  const paths = json.details.map((d) => d.path.join("."));
  assert.ok(
    paths.includes("realizedSavingsUsd"),
    `expected an issue for "realizedSavingsUsd", got ${paths.join(", ")}`,
  );
});

test("POST /opportunities/:id/realize rejects empty-string realizedSavingsUsd (no silent coercion to 0)", async () => {
  // Regression guard: a naive `z.coerce.number()` would turn `""` into
  // `0` and silently record a $0 realized-savings value on this
  // state-changing endpoint. The old hand-rolled `asNumber` validator
  // explicitly guarded against this with a `v.length > 0` check, and
  // the Zod schema must preserve that behaviour — empty string MUST
  // surface as a 400 with a field path on `realizedSavingsUsd`.
  const res = await postJson(
    buildApp(),
    "/api/opportunities/opp_456/realize",
    { realizedSavingsUsd: "" },
  );
  assert.equal(res.status, 400, "empty-string realizedSavingsUsd must yield 400");
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  const paths = json.details.map((d) => d.path.join("."));
  assert.ok(
    paths.includes("realizedSavingsUsd"),
    `expected an issue for "realizedSavingsUsd", got ${paths.join(", ")}`,
  );
});

test("POST /opportunities/:id/realize requires realizedSavingsUsd", async () => {
  // Missing field — proves the schema treats it as required, which is
  // the historical behaviour `asNumber` enforced by throwing.
  const res = await postJson(
    buildApp(),
    "/api/opportunities/opp_456/realize",
    {},
  );
  assert.equal(res.status, 400);
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(json.error, "Invalid request");
  const paths = json.details.map((d) => d.path.join("."));
  assert.ok(
    paths.includes("realizedSavingsUsd"),
    `expected an issue for "realizedSavingsUsd", got ${paths.join(", ")}`,
  );
});

test("valid bodies parse successfully (sanity check on success path)", async () => {
  // Confirm we did not over-tighten the schema. A well-formed reject
  // body (with a valid taxonomy code and an optional note) and a
  // well-formed realize body (with a numeric string, exercising the
  // historical string-to-number coercion) both reach the success branch.
  const rejectRes = await postJson(
    buildApp(),
    "/api/opportunities/opp_123/reject",
    { reasonCode: "data_quality_issue", reasonText: "duplicate row" },
  );
  assert.equal(rejectRes.status, 200, rejectRes.body);

  const realizeRes = await postJson(
    buildApp(),
    "/api/opportunities/opp_456/realize",
    { realizedSavingsUsd: "1234.56" },
  );
  assert.equal(realizeRes.status, 200, realizeRes.body);
});
