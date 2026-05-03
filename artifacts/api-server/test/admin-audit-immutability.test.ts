/**
 * UAT v2 D-19 / D-21 — audit log tamper evidence.
 *
 * Verifies that PATCH and DELETE on /api/admin/audit/:id:
 *  - return 403 with the append-only reason body, AND
 *  - each write a new `audit.mutation_attempt_blocked` row so the
 *    probe is observable to an auditor.
 *
 * Also exercises the DB-level trigger installed by
 * `bootstrapAuditLogImmutability`: a direct UPDATE / DELETE against
 * `admin_audit_log` must fail at the database boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
delete process.env["ALLOW_DEV_TENANT_HEADER"];

import {
  db,
  pool,
  orgsTable,
  apiKeysTable,
  adminAuditLogTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import app from "../src/app";
import { generateToken } from "../src/lib/auth";
import { newId } from "../src/lib/ids";
import {
  bootstrapAuditLogImmutability,
  withAuditBypass,
} from "../src/lib/audit-immutability";

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

async function countRowsForOrg(orgId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(adminAuditLogTable)
    .where(eq(adminAuditLogTable.orgId, orgId));
  return Number(row?.c ?? 0);
}

test("PATCH/DELETE /api/admin/audit/:id returns 403 and writes an audit row", async () => {
  await bootstrapAuditLogImmutability();
  const orgId = await pickOrgId();
  const adminToken = await issueAdminKey(
    orgId,
    "audit-immut-test-admin-key",
  );

  // Seed a known audit row to use as the :id target.
  const seedId = newId("aud");
  await db.insert(adminAuditLogTable).values({
    id: seedId,
    orgId,
    actor: "test@procuro.ai",
    action: "tenant.settings_update",
    targetId: "settings",
    targetLabel: "audit-immut-test-seed",
    metadata: { seeded: true },
  });

  try {
    await withServer(async (port) => {
      const before = await countRowsForOrg(orgId);

      // 1) PATCH must 403 + record an attempt.
      const patchRes = await fetch(
        `http://127.0.0.1:${port}/api/admin/audit/${seedId}`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "tampered" }),
        },
      );
      assert.equal(patchRes.status, 403);
      const patchBody = (await patchRes.json()) as {
        error: string;
        reason: string;
        message: string;
      };
      assert.equal(patchBody.reason, "audit_log_append_only");
      assert.match(patchBody.message, /append-only/i);

      const afterPatch = await countRowsForOrg(orgId);
      assert.equal(
        afterPatch - before,
        1,
        "PATCH should have written exactly one new audit row",
      );

      // 2) DELETE must 403 + record an attempt.
      const deleteRes = await fetch(
        `http://127.0.0.1:${port}/api/admin/audit/${seedId}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${adminToken}` },
        },
      );
      assert.equal(deleteRes.status, 403);
      const deleteBody = (await deleteRes.json()) as {
        reason: string;
      };
      assert.equal(deleteBody.reason, "audit_log_append_only");

      const afterDelete = await countRowsForOrg(orgId);
      assert.equal(
        afterDelete - afterPatch,
        1,
        "DELETE should have written exactly one new audit row",
      );

      // 3) Both attempts are recorded with the right action + verb.
      const attempts = await db
        .select()
        .from(adminAuditLogTable)
        .where(
          and(
            eq(adminAuditLogTable.orgId, orgId),
            eq(adminAuditLogTable.action, "audit.mutation_attempt_blocked"),
            eq(adminAuditLogTable.targetId, seedId),
          ),
        );
      assert.equal(attempts.length, 2);
      const verbs = attempts
        .map((r) => (r.metadata as { verb?: string })?.verb)
        .sort();
      assert.deepEqual(verbs, ["DELETE", "PATCH"]);

      // 4) The original target row was NOT mutated or deleted.
      const [stillThere] = await db
        .select()
        .from(adminAuditLogTable)
        .where(eq(adminAuditLogTable.id, seedId));
      assert.ok(stillThere, "seed row must still exist");
      assert.equal(stillThere.action, "tenant.settings_update");
    });

    // 5) Direct DB-level UPDATE / DELETE must be rejected by the trigger.
    await assert.rejects(
      pool.query(
        `UPDATE admin_audit_log SET action = 'tampered' WHERE id = $1`,
        [seedId],
      ),
      /append-only|insufficient_privilege/i,
      "DB-level UPDATE must be blocked by the append-only trigger",
    );
    await assert.rejects(
      pool.query(`DELETE FROM admin_audit_log WHERE id = $1`, [seedId]),
      /append-only|insufficient_privilege/i,
      "DB-level DELETE must be blocked by the append-only trigger",
    );
  } finally {
    // Cleanup uses the dedicated bypass helper so the trigger stays in
    // place for subsequent tests in the same process.
    await withAuditBypass((client) =>
      client.query(
        `DELETE FROM admin_audit_log WHERE id = $1
           OR (org_id = $2 AND action = 'audit.mutation_attempt_blocked'
               AND target_id = $1)`,
        [seedId, orgId],
      ),
    );
    await db
      .delete(apiKeysTable)
      .where(
        and(
          eq(apiKeysTable.orgId, orgId),
          eq(apiKeysTable.label, "audit-immut-test-admin-key"),
        ),
      );
  }
});
