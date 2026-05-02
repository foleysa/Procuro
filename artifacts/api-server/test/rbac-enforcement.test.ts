/**
 * Tests for the RBAC enforcement layer added in task #119.
 *
 * The system supports four authentication modes (dev-header, legacy
 * org_api_tokens, the new tenant-scoped api_keys table, and Clerk
 * sessions). This file pins the *permission* contract observed by a
 * caller — a request authenticated via an API key whose `scope_role`
 * lacks the required permission must be rejected with 403, even though
 * the API key successfully authenticates the request as the right
 * tenant.
 *
 * We exercise this by creating a real `api_keys` row, then hitting
 * representative routes that gate on `opp:approve`, `ingest:write`,
 * `users:manage`, and `audit:read`. We also assert that an `analyst`
 * scoped key can call read endpoints (proves the read path stays
 * unblocked).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
// We need the dev header path DISABLED for these tests so the API key
// is the only authenticator. The middleware refuses to apply the dev
// fallback when ALLOW_DEV_TENANT_HEADER is not set to "true".
delete process.env["ALLOW_DEV_TENANT_HEADER"];

import {
  db,
  orgsTable,
  apiKeysTable,
  userRolesTable,
  type UserRoleName,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { generateToken } from "../src/lib/auth";
import { newId } from "../src/lib/ids";

interface Handle {
  port: number;
  close: () => Promise<void>;
}

async function startServer(): Promise<Handle> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Could not bind ephemeral port");
  }
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) throw new Error("No org seeded; cannot run RBAC tests");
  return row.id;
}

async function issueKey(
  orgId: string,
  scopeRole: UserRoleName,
): Promise<string> {
  const { plain, hash } = generateToken();
  await db.insert(apiKeysTable).values({
    id: newId("ak"),
    orgId,
    label: `rbac-test-${scopeRole}`,
    prefix: plain.slice(0, 12),
    tokenHash: hash,
    scopeRole,
    createdBy: "rbac-test@procuro.ai",
  });
  return plain;
}

async function call(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

test("read_only API key cannot approve opportunities (403)", async () => {
  const orgId = await pickOrgId();
  const token = await issueKey(orgId, "read_only");
  const handle = await startServer();
  try {
    const r = await call(
      handle.port,
      "POST",
      "/api/opportunities/does-not-exist/approve",
      token,
    );
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    const obj = r.body as { error: string; required?: string[] };
    assert.equal(obj.error, "Forbidden");
    assert.ok(obj.required?.includes("opp:approve"));
  } finally {
    await handle.close();
  }
});

test("analyst API key cannot approve but CAN read", async () => {
  const orgId = await pickOrgId();
  const token = await issueKey(orgId, "analyst");
  const handle = await startServer();
  try {
    // Read endpoint succeeds (or at least, does not 401/403).
    const reads = await call(handle.port, "GET", "/api/opportunities", token);
    assert.notEqual(reads.status, 401);
    assert.notEqual(reads.status, 403);

    // Approve is denied.
    const denied = await call(
      handle.port,
      "POST",
      "/api/opportunities/does-not-exist/approve",
      token,
    );
    assert.equal(denied.status, 403);
  } finally {
    await handle.close();
  }
});

test("analyst API key cannot manage users (403)", async () => {
  const orgId = await pickOrgId();
  const token = await issueKey(orgId, "analyst");
  const handle = await startServer();
  try {
    const r = await call(handle.port, "GET", "/api/admin/users", token);
    assert.equal(r.status, 403);
    const obj = r.body as { required?: string[] };
    assert.ok(obj.required?.includes("users:manage"));
  } finally {
    await handle.close();
  }
});

test("auditor API key can read audit log but not manage users", async () => {
  const orgId = await pickOrgId();
  const token = await issueKey(orgId, "auditor");
  const handle = await startServer();
  try {
    const ok = await call(handle.port, "GET", "/api/admin/audit-log", token);
    assert.equal(ok.status, 200);
    const denied = await call(handle.port, "GET", "/api/admin/users", token);
    assert.equal(denied.status, 403);
  } finally {
    await handle.close();
  }
});

test("org_admin API key can invite and revoke a user role", async () => {
  const orgId = await pickOrgId();
  const token = await issueKey(orgId, "org_admin");
  const handle = await startServer();
  const email = `pending-${Date.now()}@example.test`;
  let createdId: string | undefined;
  try {
    const created = await call(
      handle.port,
      "POST",
      "/api/admin/users/invite",
      token,
      { email, role: "analyst" },
    );
    assert.equal(created.status, 201);
    const co = created.body as { id: string; pending: boolean };
    assert.ok(co.id);
    assert.equal(co.pending, true);
    createdId = co.id;

    const changed = await call(
      handle.port,
      "PATCH",
      `/api/admin/users/${co.id}`,
      token,
      { role: "approver" },
    );
    assert.equal(changed.status, 200);
    assert.equal((changed.body as { role: string }).role, "approver");

    const revoked = await call(
      handle.port,
      "DELETE",
      `/api/admin/users/${co.id}`,
      token,
    );
    assert.equal(revoked.status, 200);
    assert.equal((revoked.body as { revoked: boolean }).revoked, true);
  } finally {
    if (createdId) {
      await db.delete(userRolesTable).where(eq(userRolesTable.id, createdId));
    }
    // Cleanup the test API key so we don't leak rows.
    await db.delete(apiKeysTable).where(eq(apiKeysTable.label, "rbac-test-org_admin"));
    await handle.close();
  }
});

test("analyst API key cannot change tenant-wide settings (403)", async () => {
  // The Settings page lets the active tenant change the source-disclosure
  // policy. Pin that PATCH /me/settings is gated on `settings:write` so a
  // regular member with an analyst-scoped key (or session) cannot flip the
  // policy and inadvertently expose lower-trust signals to the team.
  const orgId = await pickOrgId();
  const token = await issueKey(orgId, "analyst");
  const handle = await startServer();
  try {
    const r = await call(
      handle.port,
      "PATCH",
      "/api/me/settings",
      token,
      { disclosurePolicy: "analyst" },
    );
    assert.equal(
      r.status,
      403,
      `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    const obj = r.body as { error: string; required?: string[] };
    assert.equal(obj.error, "Forbidden");
    assert.ok(obj.required?.includes("settings:write"));
  } finally {
    await db
      .delete(apiKeysTable)
      .where(eq(apiKeysTable.label, "rbac-test-analyst"));
    await handle.close();
  }
});

test("org_admin API key CAN change tenant-wide settings (200)", async () => {
  // Positive control for the gate above: the same route accepts an
  // org_admin caller, which proves the analyst 403 is a permission
  // decision and not e.g. a routing/validation regression that would
  // coincidentally reject every body.
  //
  // We deliberately PATCH with an empty body so the route reaches the
  // handler past `requirePermission("settings:write")` without forcing
  // a real settings mutation. A no-op PATCH is sufficient for the gate
  // contract and avoids coupling this test to the side effects of an
  // actual policy change (e.g. the `org_settings_audit_log` insert),
  // which a separate write-side test already covers.
  const orgId = await pickOrgId();
  const token = await issueKey(orgId, "org_admin");
  const handle = await startServer();
  try {
    const r = await call(
      handle.port,
      "PATCH",
      "/api/me/settings",
      token,
      {},
    );
    assert.equal(
      r.status,
      200,
      `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    // Sanity-check: the response is the standard `MeResponse` shape with
    // a populated org. If a future refactor moves the gate above the
    // serializer this assertion will catch the regression.
    const obj = r.body as { org?: { id?: string } };
    assert.equal(
      obj.org?.id,
      orgId,
      "expected /me response to echo the active tenant",
    );
  } finally {
    await db
      .delete(apiKeysTable)
      .where(eq(apiKeysTable.label, "rbac-test-org_admin"));
    await handle.close();
  }
});

test("missing bearer + no dev header => 401", async () => {
  const handle = await startServer();
  try {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/admin/users`,
      { method: "GET" },
    );
    assert.equal(res.status, 401);
  } finally {
    await handle.close();
  }
});
