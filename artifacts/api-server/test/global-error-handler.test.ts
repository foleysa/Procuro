/**
 * Tests for the global Express error-handling middleware registered in
 * `app.ts`. The middleware exists so that errors thrown from any non-CSV
 * route (suppliers, opportunities, jobs, market signals, ...) are
 * sanitized the same way the CSV import path already is — Express's
 * default handler will otherwise render the failing SQL statement and
 * bound parameter values into the response body in development mode.
 *
 * Strategy: spin up a real `http.createServer(app)` per case bound to an
 * ephemeral port and drive it with `fetch`. That exercises the actual
 * Express request/response objects (and Express 5's async-rejection
 * auto-forward) end-to-end, with no shimmed `any` types.
 *
 * We assert that:
 *
 *   1. Synchronous and async route throws both reach the handler.
 *   2. The sanitized response never includes the raw SQL, bound params,
 *      `detail` text, or the stack trace.
 *   3. The HTTP status is 500 with a JSON `{ error }` body.
 *   4. The headers-already-sent path of the middleware delegates to
 *      `next(err)` instead of overwriting the in-flight body — checked
 *      by invoking the middleware as a plain function with a minimal
 *      typed stand-in (no `any`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express, {
  Router,
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { globalErrorHandler } from "../src/lib/global-error-handler";
import { JobQuotaExceededError } from "../src/lib/jobs/queue";

/**
 * Tests import the real `globalErrorHandler` from `src/lib/` (rather
 * than re-implementing it) so the production middleware and the
 * middleware under test cannot drift apart. The handler does not touch
 * the database — it inspects the thrown value and writes a JSON
 * response — so booting it in tests is hermetic.
 *
 * Routes that need a `req.log` (the 500 branch logs via Pino) attach a
 * tiny no-op logger in `buildApp` below; the 4xx branches deliberately
 * skip logging so the test suite doesn't depend on a real logger for
 * the validation-error cases.
 */

interface PgLeakError extends Error {
  code?: string;
  table?: string;
  column?: string;
  constraint?: string;
  detail?: string;
}

function makePgError(): PgLeakError {
  const e: PgLeakError = new Error(
    'duplicate key value violates unique constraint "suppliers_org_external_id_uq"\n' +
      'Failing query: insert into "suppliers" ("org_id", "external_id", "name") ' +
      "values ($1, $2, $3) returning *\n" +
      'Params: ["00000000-0000-0000-0000-000000000001", "SUP-001", "Acme Industrial"]',
  );
  e.code = "23505";
  e.table = "suppliers";
  e.constraint = "suppliers_org_external_id_uq";
  e.detail = "Key (org_id, external_id)=(...0001, SUP-001) already exists.";
  return e;
}

function buildApp(register: (r: Router) => void): Express {
  const app = express();
  app.use(express.json());
  // The 500 branch of the real handler calls `req.log.error(...)`. In
  // production that field is attached by `pino-http`; here we attach a
  // no-op logger so the handler runs without standing up a full logger
  // (and without pino spamming stdout during the test run).
  app.use((req, _res, next) => {
    // The handler only ever calls `req.log.error(...)`, but the real
    // pino-http logger surface has many more members than that. Cast
    // through `unknown` so the no-op stub satisfies the assignment
    // without us having to mock every pino field.
    (req as unknown as { log: { error: (...args: unknown[]) => void } }).log =
      {
        error: () => undefined,
      };
    next();
  });
  const router = Router();
  register(router);
  app.use("/api", router);
  app.use(globalErrorHandler);
  return app;
}

interface CapturedResponse {
  status: number;
  body: string;
}

/**
 * Boot the app on an ephemeral port, issue a real HTTP request via
 * `fetch`, capture the response, and tear the server down. Using a
 * real socket exercises the actual Express middleware chain and
 * Express 5's async-error auto-forward semantics.
 */
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

async function getJson(
  app: Express,
  path: string,
): Promise<CapturedResponse> {
  return withServer(app, async (base) => {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, body: await r.text() };
  });
}

const SQL_LEAK_FRAGMENTS = [
  "insert into",
  "Failing query",
  "Params:",
  "$1",
  "$2",
  "$3",
  "Acme Industrial",
  "SUP-001",
  "00000000-0000-0000-0000-000000000001",
  "Key (org_id",
  "already exists",
];

function assertNoSqlLeak(body: string): void {
  for (const frag of SQL_LEAK_FRAGMENTS) {
    assert.ok(
      !body.includes(frag),
      `response body must not contain "${frag}". Got: ${body}`,
    );
  }
}

test("synchronous route throw is sanitized to 500 JSON", async () => {
  const app = buildApp((r) => {
    r.get("/suppliers", () => {
      throw makePgError();
    });
  });
  const res = await getJson(app, "/api/suppliers");
  assert.equal(res.status, 500);
  const json = JSON.parse(res.body) as { error: string };
  assert.equal(typeof json.error, "string");
  assertNoSqlLeak(res.body);
  // The sanitizer should still surface the safe identifier-level summary
  // so operators can triage without inspecting logs.
  assert.match(json.error, /unique constraint/i);
  assert.ok(json.error.includes("suppliers"));
});

test("async route rejection is sanitized to 500 JSON (Express 5 auto-forward)", async () => {
  const app = buildApp((r) => {
    r.get("/opportunities", async () => {
      throw makePgError();
    });
  });
  const res = await getJson(app, "/api/opportunities");
  assert.equal(res.status, 500);
  const json = JSON.parse(res.body) as { error: string };
  assert.equal(typeof json.error, "string");
  assertNoSqlLeak(res.body);
});

test("ZodError from request validation maps to 400 with issues, not 500", async () => {
  // The previous global handler treated every uncaught throw as a 500,
  // which made request-validation failures (a client problem) look like
  // server crashes — bloating error dashboards and giving clients a
  // misleading status code. Routes that throw a ZodError from a
  // generated request schema must now surface as 400.
  const PostBodySchema = z.object({
    name: z.string().min(1),
    count: z.number().int().min(1),
  });
  const app = buildApp((r) => {
    r.post("/widgets", (req) => {
      // Throw, do not return a response — verifies the handler picks up
      // ZodError that bubbles up via Express 5's async-error auto-forward.
      PostBodySchema.parse(req.body);
    });
  });
  const res = await withServer(app, async (base) => {
    const r = await fetch(`${base}/api/widgets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", count: -1 }),
    });
    return { status: r.status, body: await r.text() };
  });
  assert.equal(res.status, 400, "ZodError must be reported as 400, not 500");
  const json = JSON.parse(res.body) as {
    error: string;
    details: Array<{ path: Array<string | number>; message: string }>;
  };
  assert.equal(typeof json.error, "string");
  assert.ok(Array.isArray(json.details), "details must be the issues array");
  assert.ok(
    json.details.some((d) => d.path.includes("name")),
    "details must reference the failing field",
  );
  // The full unsanitized SQL leak fragments must of course not appear
  // even on the 400 path — the response body is built from the issues
  // array only.
  assertNoSqlLeak(res.body);
});

test("JobQuotaExceededError maps to its declared statusCode (429)", async () => {
  // The ingest routes used to special-case this error in a per-route
  // try/catch. The global handler now owns the mapping so routes can
  // simply throw — verifies clients still get 429 (not 500) and the
  // human-readable message survives.
  const orgId = "00000000-0000-0000-0000-000000000042";
  const app = buildApp((r) => {
    r.post("/ingest/csv", () => {
      throw new JobQuotaExceededError(orgId);
    });
  });
  const res = await withServer(app, async (base) => {
    const r = await fetch(`${base}/api/ingest/csv`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: r.status, body: await r.text() };
  });
  assert.equal(res.status, 429, "JobQuotaExceededError must use its statusCode");
  const json = JSON.parse(res.body) as { error: string };
  assert.match(json.error, /quota exceeded/i);
  assert.ok(json.error.includes(orgId));
});

test("non-DB Error collapses to a generic message (no message leakage)", async () => {
  const app = buildApp((r) => {
    r.get("/jobs", () => {
      throw new Error(
        "boom: select * from internal_secret_table where token='hunter2'",
      );
    });
  });
  const res = await getJson(app, "/api/jobs");
  assert.equal(res.status, 500);
  const json = JSON.parse(res.body) as { error: string };
  assert.ok(!res.body.includes("hunter2"));
  assert.ok(!res.body.includes("internal_secret_table"));
  assert.equal(typeof json.error, "string");
  assert.ok(json.error.length > 0);
});

/**
 * Minimal typed stand-ins for the `headers-already-sent` branch. We
 * cannot use a real socket here because the assertion is specifically
 * about what the middleware does *not* call — going through the real
 * Express + finalhandler pipeline would close the socket and obscure
 * the assertion. Defining narrow interfaces (instead of `any`) keeps
 * the test type-safe.
 */
interface MockReq {
  log: { error: (...args: unknown[]) => void };
  path: string;
}
interface MockRes {
  headersSent: boolean;
  statusCalls: number;
  jsonCalls: number;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function makeMockRes(): MockRes {
  const res: MockRes = {
    headersSent: true,
    statusCalls: 0,
    jsonCalls: 0,
    status(_code: number) {
      res.statusCalls += 1;
      return res;
    },
    json(_body: unknown) {
      res.jsonCalls += 1;
      return res;
    },
  };
  return res;
}

test("error after response started delegates to next() without overwriting body", () => {
  // Once headers are flushed (e.g. a streaming handler called res.write),
  // it is impossible to send a fresh status + JSON body. The middleware
  // must therefore delegate to `next(err)` so Express's default handler
  // closes the connection — instead of attempting `res.status(500).json(...)`
  // and producing a corrupt response. We exercise the middleware in
  // isolation here to keep the assertion sharp.
  const req: MockReq = { log: { error: () => {} }, path: "/stream" };
  const res = makeMockRes();
  let nextCalledWith: unknown = "not-called";
  const next: NextFunction = (e?: unknown) => {
    nextCalledWith = e;
  };
  // The Express types want concrete Request/Response here; the middleware
  // only touches `headersSent`, `status`, `json`, `log`, and `path`, so a
  // typed cast through `unknown` is sound and keeps the call site honest.
  globalErrorHandler(
    makePgError(),
    req as unknown as Request,
    res as unknown as Response,
    next,
  );
  assert.equal(res.statusCalls, 0, "must not call res.status() once headers are sent");
  assert.equal(res.jsonCalls, 0, "must not call res.json() once headers are sent");
  assert.ok(
    nextCalledWith instanceof Error,
    "must forward the error to Express's default handler",
  );
});
