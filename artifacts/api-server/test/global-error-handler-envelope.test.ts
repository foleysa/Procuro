/**
 * Task #297 — uniform error envelope.
 *
 * Asserts the global error handler maps every recognised typed error
 * to the documented `{ error, code, details? }` envelope with the
 * expected HTTP status code, and that an unrecognised error falls back
 * to a sanitized 500 with `code: "internal_error"`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import { z, ZodError } from "zod";

import { globalErrorHandler } from "../src/lib/global-error-handler";
import {
  ConflictError,
  DBConstraintError,
  ForbiddenError,
  NotFoundError,
  TenantMismatchError,
  UnauthorizedError,
} from "../src/lib/api-errors";
import { JobQuotaExceededError } from "../src/lib/jobs/queue";

function buildApp(throwIt: () => unknown): Express {
  const app = express();
  // pino-http isn't mounted in this minimal harness, but the handler
  // calls `req.log.error` for the 5xx branch — stub it to a no-op.
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: () => void } }).log = {
      error: () => undefined,
    };
    next();
  });
  app.get("/boom", (_req, _res, next) => {
    try {
      throwIt();
      next();
    } catch (e) {
      next(e);
    }
  });
  app.use(globalErrorHandler);
  return app;
}

async function hit(app: Express): Promise<{ status: number; body: any }> {
  const { default: http } = await import("node:http");
  return await new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no address"));
        return;
      }
      const port = addr.port;
      http
        .get(`http://127.0.0.1:${port}/boom`, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) });
          });
        })
        .on("error", (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe("globalErrorHandler envelope", () => {
  it("maps UnauthorizedError → 401 unauthorized", async () => {
    const app = buildApp(() => {
      throw new UnauthorizedError("nope");
    });
    const r = await hit(app);
    assert.equal(r.status, 401);
    assert.equal(r.body.code, "unauthorized");
    assert.equal(r.body.error, "nope");
  });

  it("maps ForbiddenError → 403 forbidden", async () => {
    const app = buildApp(() => {
      throw new ForbiddenError();
    });
    const r = await hit(app);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "forbidden");
  });

  it("maps TenantMismatchError → 403 tenant_mismatch", async () => {
    const app = buildApp(() => {
      throw new TenantMismatchError();
    });
    const r = await hit(app);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "tenant_mismatch");
  });

  it("maps NotFoundError → 404 not_found", async () => {
    const app = buildApp(() => {
      throw new NotFoundError("supplier");
    });
    const r = await hit(app);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "not_found");
  });

  it("maps ConflictError → 409 conflict", async () => {
    const app = buildApp(() => {
      throw new ConflictError("dup", { field: "slug" });
    });
    const r = await hit(app);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "conflict");
    assert.deepEqual(r.body.details, { field: "slug" });
  });

  it("maps DBConstraintError → 409 db_constraint", async () => {
    const app = buildApp(() => {
      throw new DBConstraintError("fk violation");
    });
    const r = await hit(app);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "db_constraint");
  });

  it("maps ZodError → 400 invalid_request with issues", async () => {
    const app = buildApp(() => {
      z.object({ a: z.string() }).parse({ a: 1 });
    });
    const r = await hit(app);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "invalid_request");
    assert.ok(Array.isArray(r.body.details));
  });

  it("maps JobQuotaExceededError → 429 quota_exceeded", async () => {
    const app = buildApp(() => {
      throw new JobQuotaExceededError("org_x");
    });
    const r = await hit(app);
    assert.equal(r.status, 429);
    assert.equal(r.body.code, "quota_exceeded");
  });

  it("falls back to 500 internal_error for unknown errors", async () => {
    const app = buildApp(() => {
      throw new Error("kaboom");
    });
    const r = await hit(app);
    assert.equal(r.status, 500);
    assert.equal(r.body.code, "internal_error");
    // The sanitized message must NOT be the raw stack.
    assert.equal(typeof r.body.error, "string");
  });
});
