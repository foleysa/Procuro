/**
 * Tests for the request-validation behaviour of `PATCH /me/settings`.
 *
 * The route delegates body validation to the generated
 * `PatchMeSettingsBody` Zod schema (so the wire contract published in
 * `lib/api-spec/openapi.yaml` is the single source of truth) and lets
 * any `ZodError` bubble to the global error handler that maps it to
 * `400 { error, details }`. These tests pin that observable contract
 * — any future refactor (e.g. swapping in hand-rolled validation) that
 * breaks the shape will fail here, *before* it can break the FE.
 *
 * The production `me` router mounts `tenantMiddleware` ahead of the
 * handler, which would require a DB to satisfy. Because the unit
 * under test is the *body validation* contract (which is generated
 * from the OpenAPI spec and shared with the production route), we
 * mount the same schema + the same global error handler against an
 * inline route. The test would catch a regression in either piece —
 * the schema (e.g. someone widening the enum to `z.string()`) or the
 * global handler (e.g. dropping the `details` field).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express, { type Express } from "express";

if (!process.env["DATABASE_URL"]) {
  // `@workspace/db` is transitively imported by `globalErrorHandler`'s
  // sibling modules; setting a syntactic placeholder lets the import
  // succeed even though no DB call is made by these tests.
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const { PatchMeSettingsBody } = await import("@workspace/api-zod");
const { globalErrorHandler } = await import("../src/lib/global-error-handler");

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: () => void } }).log = {
      error: () => undefined,
    };
    next();
  });
  // Inline route mirrors the production handler's validation step:
  // a single `PatchMeSettingsBody.parse(req.body)` whose `ZodError`
  // bubbles to the global handler. If you change how the production
  // route validates, change this mount in lockstep.
  app.patch("/api/me/settings", (req, res) => {
    const body = PatchMeSettingsBody.parse(req.body);
    res.json({ ok: true, body });
  });
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

test("PATCH /me/settings rejects an unknown disclosure policy with a 400 + field-level details", async () => {
  // The schema constrains `disclosurePolicy` to the
  // conservative/standard/analyst enum. Sending a near-miss like
  // `"verbose"` exercises the enum branch and proves the global
  // handler surfaces the offending field path.
  const res = await patchJson(buildApp(), "/api/me/settings", {
    disclosurePolicy: "verbose",
  });
  assert.equal(res.status, 400, "malformed body must yield 400");
  const json = JSON.parse(res.body) as ValidationErrorBody;
  assert.equal(typeof json.error, "string");
  assert.ok(json.error.length > 0, "error message must be non-empty");
  assert.ok(
    Array.isArray(json.details),
    "details must be an issues array, not a string",
  );
  const paths = json.details.map((d) => d.path.join("."));
  assert.ok(
    paths.includes("disclosurePolicy"),
    `expected an issue for "disclosurePolicy", got ${paths.join(", ")}`,
  );
});

test("PATCH /me/settings rejects a non-string disclosure policy with a 400", async () => {
  // Wrong type for the same field — pin a second branch so a future
  // refactor to a permissive `z.any()` schema is caught.
  const res = await patchJson(buildApp(), "/api/me/settings", {
    disclosurePolicy: 42,
  });
  assert.equal(res.status, 400);
  const json = JSON.parse(res.body) as ValidationErrorBody;
  const paths = json.details.map((d) => d.path.join("."));
  assert.ok(
    paths.includes("disclosurePolicy"),
    `expected an issue for "disclosurePolicy", got ${paths.join(", ")}`,
  );
});

test("PATCH /me/settings accepts an empty body without throwing a validation error", async () => {
  // Every property in the schema is optional: an empty PATCH must
  // pass validation so callers can no-op without tripping a 400.
  // The inline test handler echoes back the parsed body, which lets
  // us assert the contract directly.
  const res = await patchJson(buildApp(), "/api/me/settings", {});
  assert.equal(
    res.status,
    200,
    `empty body must pass validation; got ${res.status} with body ${res.body}`,
  );
  const json = JSON.parse(res.body) as { ok: true; body: unknown };
  assert.deepEqual(json.body, {});
});

test("PATCH /me/settings accepts a known disclosure policy value", async () => {
  // Round-trip the canonical enum values through the same schema the
  // production route uses, proving the parser preserves the legal
  // value (it isn't, e.g., transformed away by an over-eager refine).
  for (const policy of ["conservative", "standard", "analyst"] as const) {
    const res = await patchJson(buildApp(), "/api/me/settings", {
      disclosurePolicy: policy,
    });
    assert.equal(res.status, 200, `policy "${policy}" must pass validation`);
    const json = JSON.parse(res.body) as {
      ok: true;
      body: { disclosurePolicy: string };
    };
    assert.equal(json.body.disclosurePolicy, policy);
  }
});
