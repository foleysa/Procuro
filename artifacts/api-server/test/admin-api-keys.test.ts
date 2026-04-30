/**
 * End-to-end tests for `/api/admin/api-keys`.
 *
 * Pins the issue / rotate / revoke behaviour and verifies that the
 * `admin_audit_log` writes the expected `api_key.*` rows. We use an
 * `org_admin` scoped API key to authenticate the calls (proving the
 * permission gate accepts the right principal); the request creates,
 * rotates, and revokes a *separate* key so we can also assert the
 * post-rotation key supersedes the old one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
delete process.env["ALLOW_DEV_TENANT_HEADER"];

import {
  db,
  orgsTable,
  apiKeysTable,
  adminAuditLogTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import app from "../src/app";
import { generateToken } from "../src/lib/auth";
import { newId } from "../src/lib/ids";

async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) throw new Error("No org seeded");
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

async function issueAdminKey(orgId: string, label: string): Promise<string> {
  const { plain, hash } = generateToken();
  await db.insert(apiKeysTable).values({
    id: newId("ak"),
    orgId,
    label,
    prefix: plain.slice(0, 12),
    tokenHash: hash,
    scopeRole: "org_admin",
    createdBy: "test@procuro.ai",
  });
  return plain;
}

test("issue / rotate / revoke an API key emits audit log rows", async () => {
  const orgId = await pickOrgId();
  const adminToken = await issueAdminKey(orgId, "admin-key-test-runner");

  await withServer(async (port) => {
    // 1) Issue a new analyst-scoped key.
    const create = await fetch(
      `http://127.0.0.1:${port}/api/admin/api-keys`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          label: "test-issued-key",
          scopeRole: "analyst",
        }),
      },
    );
    assert.equal(create.status, 201);
    const created = (await create.json()) as {
      id: string;
      secret: string;
      prefix: string;
      scopeRole: string;
    };
    assert.ok(created.secret.startsWith("proc_"));
    assert.equal(created.scopeRole, "analyst");
    assert.equal(created.prefix.length, 12);

    // 2) Use the brand-new key on a read endpoint to prove it works.
    const usingNewKey = await fetch(
      `http://127.0.0.1:${port}/api/opportunities`,
      { headers: { authorization: `Bearer ${created.secret}` } },
    );
    assert.notEqual(usingNewKey.status, 401);

    // 3) Rotate it; the old plaintext should immediately stop working
    //    and the new one should authenticate.
    const rotate = await fetch(
      `http://127.0.0.1:${port}/api/admin/api-keys/${created.id}/rotate`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
      },
    );
    assert.equal(rotate.status, 201);
    const rotated = (await rotate.json()) as {
      id: string;
      secret: string;
      rotatedFromId: string;
    };
    assert.notEqual(rotated.secret, created.secret);
    assert.equal(rotated.rotatedFromId, created.id);

    const oldKeyAfterRotate = await fetch(
      `http://127.0.0.1:${port}/api/opportunities`,
      { headers: { authorization: `Bearer ${created.secret}` } },
    );
    assert.equal(oldKeyAfterRotate.status, 401);

    const newKeyAfterRotate = await fetch(
      `http://127.0.0.1:${port}/api/opportunities`,
      { headers: { authorization: `Bearer ${rotated.secret}` } },
    );
    assert.notEqual(newKeyAfterRotate.status, 401);

    // 4) Revoke the new one and prove it stops working.
    const revoke = await fetch(
      `http://127.0.0.1:${port}/api/admin/api-keys/${rotated.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } },
    );
    assert.equal(revoke.status, 200);
    const afterRevoke = await fetch(
      `http://127.0.0.1:${port}/api/opportunities`,
      { headers: { authorization: `Bearer ${rotated.secret}` } },
    );
    assert.equal(afterRevoke.status, 401);

    // 5) Audit log captured all three actions.
    const auditRows = await db
      .select()
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, orgId),
          eq(adminAuditLogTable.targetLabel, "test-issued-key"),
        ),
      );
    const actions = auditRows.map((r) => r.action).sort();
    assert.deepEqual(
      actions,
      ["api_key.create", "api_key.revoke", "api_key.rotate"],
    );
  });

  // Cleanup
  await db
    .delete(apiKeysTable)
    .where(
      and(
        eq(apiKeysTable.orgId, orgId),
        eq(apiKeysTable.label, "admin-key-test-runner"),
      ),
    );
  await db
    .delete(apiKeysTable)
    .where(
      and(eq(apiKeysTable.orgId, orgId), eq(apiKeysTable.label, "test-issued-key")),
    );
  await db
    .delete(adminAuditLogTable)
    .where(
      and(
        eq(adminAuditLogTable.orgId, orgId),
        eq(adminAuditLogTable.targetLabel, "test-issued-key"),
      ),
    );
});
