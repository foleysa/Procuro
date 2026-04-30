/**
 * Tests for the request-validation behaviour of the platform-admin
 * collectors routes (`POST /collectors`, `PATCH /collectors/:id`).
 *
 * Background:
 *   The two routes used to validate `req.body` with `Schema.safeParse`
 *   and write the 400 response themselves. Now that the global error
 *   handler maps any uncaught `ZodError` to `400 { error, details }`
 *   uniformly (see `lib/global-error-handler.ts`), the routes call
 *   `Schema.parse(req.body)` and let the throw bubble up. These tests
 *   pin the externally observable contract — same status code, same
 *   `{ error, details }` shape, with field-level issue paths — so a
 *   future refactor that breaks either side is caught immediately.
 *
 * Why mount the real router:
 *   We import the production `collectors` router (rather than rebuilding
 *   one with the same schemas) so the two pieces under test — the routes
 *   and the global handler — are exactly the ones that ship in the
 *   server. The router transitively imports `@workspace/db`, which only
 *   *creates* a Pool at module load (it does not connect until a query
 *   runs). The malformed-body cases throw inside `parse()` before any DB
 *   access, so a dummy `DATABASE_URL` is sufficient to satisfy the
 *   import-time guard without standing up a real database.
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
  // The `@workspace/db` module throws at import time if DATABASE_URL is
  // unset. Setting a syntactically valid placeholder lets the module
  // load; the malformed-body tests never reach a query so no real
  // connection is attempted.
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const collectorsRouter = (await import("../src/routes/collectors")).default;
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
  // Stand in for the tenant middleware that production mounts above
  // platform-admin routes. Without it `req.actorEmail` is undefined,
  // which is fine for the 400 path because validation throws first.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.actorEmail = "test@procuro.ai";
    next();
  });
  app.use("/api", collectorsRouter);
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

async function patchJson(
  app: Express,
  path: string,
  body: unknown,
): Promise<CapturedResponse> {
  return withServer(app, async (base) => {
    const r = await fetch(`${base}${path}`, {
      method: "PATCH",
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

test("POST /collectors with malformed body returns 400 with field-level issues", async () => {
  // Missing `id`, `name`, `description`, `owner`, `sourceUrl`, and
  // wrong type for `posture` — the body fails on multiple fields so
  // we can assert that the issues array surfaces them all (not just
  // the first failure).
  const res = await postJson(buildApp(), "/api/collectors", {
    posture: "not-a-real-posture",
  });
  assert.equal(res.status, 400, "malformed POST body must yield 400");
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(typeof json.error, "string");
  assert.ok(json.error.length > 0, "error message must be non-empty");
  assert.ok(
    Array.isArray(json.details),
    "details must be the issues array, not a string",
  );
  // The schema requires `id`, `name`, `description`, `owner`, and
  // `sourceUrl`; pin a couple of those so a future schema regression
  // (e.g. silently dropping a required field) is caught.
  const paths = json.details.map((d) => d.path.join("."));
  assert.ok(paths.includes("id"), `expected an issue for "id", got ${paths.join(", ")}`);
  assert.ok(
    paths.includes("posture"),
    `expected an issue for "posture", got ${paths.join(", ")}`,
  );
});

test("PATCH /collectors/:id with malformed body returns 400 with field-level issues", async () => {
  // `status` is constrained to a small enum and `rateLimitRpm` must be
  // a positive integer. Both are wrong here so we exercise the path
  // where multiple fields fail.
  const res = await patchJson(buildApp(), "/api/collectors/some-id", {
    status: "not-a-status",
    rateLimitRpm: -1,
  });
  assert.equal(res.status, 400, "malformed PATCH body must yield 400");
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(typeof json.error, "string");
  assert.ok(json.error.length > 0, "error message must be non-empty");
  assert.ok(Array.isArray(json.details), "details must be the issues array");
  const paths = json.details.map((d) => d.path.join("."));
  assert.ok(
    paths.includes("status"),
    `expected an issue for "status", got ${paths.join(", ")}`,
  );
  assert.ok(
    paths.includes("rateLimitRpm"),
    `expected an issue for "rateLimitRpm", got ${paths.join(", ")}`,
  );
});
