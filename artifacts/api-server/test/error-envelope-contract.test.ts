/**
 * Contract tests asserting every typed API error produces the uniform
 * `{ error: string, code: string, details?: unknown }` envelope.
 *
 * These tests exercise the global error handler's mapping of typed errors
 * (ApiError subclasses, ZodError) to the canonical envelope shape. Each
 * route group gets at least one assertion confirming:
 *   1. The HTTP status code matches the error class.
 *   2. The JSON body has `error` (string) and `code` (string).
 *   3. `details`, when present, is not undefined.
 *   4. No extra keys leak (e.g. raw `message`, `stack`, SQL).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { db, orgsTable } from "@workspace/db";
import app from "../src/app";

async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) throw new Error("No org seeded — run `pnpm --filter @workspace/db run sync` first");
  return row.id;
}

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Could not bind ephemeral port");
  }
  try {
    return await fn(addr.port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

interface ErrorEnvelope {
  error: string;
  code: string;
  details?: unknown;
}

function assertEnvelope(body: unknown, expectedStatus: number, expectedCode: string): ErrorEnvelope {
  assert.ok(body !== null && typeof body === "object", "body should be an object");
  const obj = body as Record<string, unknown>;
  assert.equal(typeof obj["error"], "string", "envelope.error must be a string");
  assert.equal(typeof obj["code"], "string", "envelope.code must be a string");
  assert.equal(obj["code"], expectedCode, `envelope.code should be '${expectedCode}'`);
  const allowedKeys = new Set(["error", "code", "details"]);
  for (const key of Object.keys(obj)) {
    assert.ok(allowedKeys.has(key), `unexpected key '${key}' in error envelope`);
  }
  return obj as unknown as ErrorEnvelope;
}

async function apiCall(
  port: number,
  method: string,
  path: string,
  orgId: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "x-tenant-id": orgId,
    "content-type": "application/json",
  };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

test("error envelope contract — collectors patch 404", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "PATCH", "/api/collectors/nonexistent-id-xyz", orgId, { enabled: false });
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — opportunities 404", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "GET", "/api/opportunities/nonexistent-id-xyz", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — contracts 404", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "GET", "/api/contracts/nonexistent-id-xyz", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — suppliers 404", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "GET", "/api/suppliers/nonexistent-id-xyz", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — jobs 404 on cancel", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "POST", "/api/jobs/nonexistent-id-xyz/cancel", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — integrations connection 404", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "GET", "/api/integrations/connections/nonexistent-id-xyz", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — alerts invalid body → 400 with details", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "POST", "/api/alerts", orgId, {});
    assert.equal(status, 400);
    const envelope = assertEnvelope(body, 400, "invalid_request");
    assert.ok(envelope.details !== undefined, "400 from ZodError should include details");
  });
});

test("error envelope contract — methods-and-tools invalid body → 400", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "POST", "/api/methods-and-tools", orgId, {});
    assert.equal(status, 400);
    assertEnvelope(body, 400, "invalid_request");
  });
});

test("error envelope contract — methods-and-tools delete 404", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "DELETE", "/api/methods-and-tools/nonexistent-xyz", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — cycles 404", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "GET", "/api/cycles/nonexistent-id-xyz", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — defense-packs 404", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "GET", "/api/defense-packs/nonexistent-id-xyz", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — defense-packs invalid body → 400", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "POST", "/api/defense-packs", orgId, {});
    assert.equal(status, 400);
    assertEnvelope(body, 400, "invalid_request");
  });
});

test("error envelope contract — us-suppliers 404 on delete", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "DELETE", "/api/us-suppliers/nonexistent-id-xyz", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — admin-api-keys rotate 404", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "POST", "/api/admin/api-keys/nonexistent-id-xyz/rotate", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — admin-users patch invalid body → 400", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "PATCH", "/api/admin/users/nonexistent-id-xyz", orgId, {});
    assert.equal(status, 400);
    const envelope = assertEnvelope(body, 400, "invalid_request");
    assert.ok(envelope.details !== undefined, "ZodError should include details");
  });
});

test("error envelope contract — ingest/csv-stream missing entity → 400", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "POST", "/api/ingest/csv-stream", orgId);
    assert.equal(status, 400);
    assertEnvelope(body, 400, "invalid_request");
  });
});

test("error envelope contract — intelligence invalid entity kind → 400", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "GET", "/api/intelligence/entity/bogus_kind/some-id", orgId);
    assert.equal(status, 400);
    assertEnvelope(body, 400, "invalid_request");
  });
});

test("error envelope contract — routing resolve invalid body → 400", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "POST", "/api/admin/routing/queue/some-id/resolve", orgId, {});
    assert.equal(status, 400);
    assertEnvelope(body, 400, "invalid_request");
  });
});

test("error envelope contract — funnel snapshot 404", async () => {
  const orgId = await pickOrgId();
  await withServer(async (port) => {
    const { status, body } = await apiCall(port, "GET", "/api/admin/funnel/snapshots/nonexistent-id-xyz", orgId);
    assert.equal(status, 404);
    assertEnvelope(body, 404, "not_found");
  });
});

test("error envelope contract — unauthenticated request → 401 unauthorized", async () => {
  const prev = process.env["ALLOW_DEV_TENANT_HEADER"];
  delete process.env["ALLOW_DEV_TENANT_HEADER"];
  try {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/suppliers`, {
        headers: { "content-type": "application/json" },
      });
      const json = await res.json().catch(() => null);
      assert.equal(res.status, 401);
      assertEnvelope(json, 401, "unauthorized");
    });
  } finally {
    if (prev !== undefined) process.env["ALLOW_DEV_TENANT_HEADER"] = prev;
  }
});

test("error envelope contract — tenant mismatch → 403 tenant_mismatch", async () => {
  const orgId = await pickOrgId();
  const prev = process.env["ALLOW_DEV_TENANT_HEADER"];
  delete process.env["ALLOW_DEV_TENANT_HEADER"];
  try {
    await withServer(async (port) => {
      const { generateToken } = await import("../src/lib/auth");
      const { newId } = await import("../src/lib/ids");
      const { db, apiKeysTable } = await import("@workspace/db");
      const { plain, hash } = generateToken();
      await db.insert(apiKeysTable).values({
        id: newId("ak"),
        orgId,
        label: "tenant-mismatch-test",
        prefix: plain.slice(0, 12),
        tokenHash: hash,
        scopeRole: "analyst",
        createdBy: "test@procuro.ai",
      });
      const res = await fetch(`http://127.0.0.1:${port}/api/suppliers`, {
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${plain}`,
          "x-org-id": "org_definitely_not_real",
        },
      });
      const json = await res.json().catch(() => null);
      assert.equal(res.status, 403);
      assertEnvelope(json, 403, "tenant_mismatch");
    });
  } finally {
    if (prev !== undefined) process.env["ALLOW_DEV_TENANT_HEADER"] = prev;
  }
});
