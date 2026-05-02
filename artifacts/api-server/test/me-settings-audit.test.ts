/**
 * End-to-end tests for the tenant-settings audit trail.
 *
 * Covers the contract added in task #115:
 *   - `PATCH /me/settings` writes one `org_settings_audit_log` row per
 *     changed key (atomically with the settings UPDATE).
 *   - A no-op PATCH (request body matches stored value) writes nothing.
 *   - `GET /me/settings/audit` returns rows for the active tenant only,
 *     in reverse-chronological order, honoring the `limit` query param.
 *
 * We authenticate via an `org_admin` scoped API key issued directly into
 * `api_keys` so the request flows through `tenantMiddleware` exactly the
 * same way a real client would (no dev-header bypass).
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
  orgSettingsAuditLogTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
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
    createdBy: "audit-test@procuro.ai",
  });
  return plain;
}

/**
 * Snapshot the current `disclosurePolicy` so each test can restore it
 * after it mutates the org-wide setting. Tests share a single seeded
 * org, so leaving a setting flipped would bleed across files.
 */
async function captureDisclosurePolicy(orgId: string): Promise<unknown> {
  const [row] = await db
    .select({ settings: orgsTable.settings })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId));
  const s = (row?.settings ?? {}) as Record<string, unknown>;
  return s["disclosurePolicy"];
}

async function restoreDisclosurePolicy(
  orgId: string,
  prior: unknown,
): Promise<void> {
  const [row] = await db
    .select({ settings: orgsTable.settings })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId));
  const s = { ...((row?.settings ?? {}) as Record<string, unknown>) };
  if (prior === undefined) delete s["disclosurePolicy"];
  else s["disclosurePolicy"] = prior;
  await db.update(orgsTable).set({ settings: s }).where(eq(orgsTable.id, orgId));
}

test("PATCH /me/settings writes one audit row per changed key and none for no-ops", async () => {
  const orgId = await pickOrgId();
  const adminToken = await issueAdminKey(orgId, "audit-key-changes");
  const prior = await captureDisclosurePolicy(orgId);

  try {
    await withServer(async (port) => {
      // Force a known starting value so the diff in the next call has a
      // deterministic "old" side regardless of what the seed stored.
      const seed = await fetch(
        `http://127.0.0.1:${port}/api/me/settings`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ disclosurePolicy: "standard" }),
        },
      );
      assert.equal(seed.status, 200, await seed.text());

      // Snapshot the audit-row count *after* the seed so the assertions
      // below count only rows produced by this test's mutations.
      const baselineRows = await db
        .select({ id: orgSettingsAuditLogTable.id })
        .from(orgSettingsAuditLogTable)
        .where(eq(orgSettingsAuditLogTable.orgId, orgId));
      const baselineCount = baselineRows.length;

      // Real change: standard -> analyst.
      const change = await fetch(
        `http://127.0.0.1:${port}/api/me/settings`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ disclosurePolicy: "analyst" }),
        },
      );
      assert.equal(change.status, 200, await change.text());

      // No-op: analyst -> analyst (already applied above).
      const noop = await fetch(
        `http://127.0.0.1:${port}/api/me/settings`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ disclosurePolicy: "analyst" }),
        },
      );
      assert.equal(noop.status, 200, await noop.text());

      const after = await db
        .select()
        .from(orgSettingsAuditLogTable)
        .where(eq(orgSettingsAuditLogTable.orgId, orgId))
        .orderBy(desc(orgSettingsAuditLogTable.createdAt));
      // Exactly ONE new row from the real change; the no-op must not
      // produce a row.
      assert.equal(
        after.length,
        baselineCount + 1,
        "expected exactly one new audit row for the changed PATCH (no-op must not write)",
      );
      const newest = after[0]!;
      assert.equal(newest.key, "disclosurePolicy");
      assert.equal(newest.oldValue as unknown, "standard");
      assert.equal(newest.newValue as unknown, "analyst");
      assert.ok(newest.actorEmail.length > 0, "actorEmail recorded");
    });
  } finally {
    await restoreDisclosurePolicy(orgId, prior);
  }
});

test("GET /me/settings/audit returns rows for the active org only, newest first, honoring limit", async () => {
  const orgId = await pickOrgId();
  const adminToken = await issueAdminKey(orgId, "audit-key-listing");
  const prior = await captureDisclosurePolicy(orgId);

  // Seed two audit rows for THIS org and one row for a synthetic
  // sibling org. The synthetic row must NOT appear in this org's feed —
  // tenant scoping is the most important property of the endpoint.
  const otherOrgId = `org_audit_test_${Date.now()}`;
  await db.insert(orgsTable).values({
    id: otherOrgId,
    slug: `audit-test-${Date.now()}`,
    name: "Audit Test Sibling",
  });
  const otherRowId = newId("oset_aud");
  await db.insert(orgSettingsAuditLogTable).values({
    id: otherRowId,
    orgId: otherOrgId,
    actorEmail: "intruder@example.com",
    key: "disclosurePolicy",
    oldValue: "standard" as never,
    newValue: "analyst" as never,
  });

  try {
    await withServer(async (port) => {
      // Drive a real PATCH so the row's createdAt advances past any
      // pre-existing audit rows on this org.
      const seed = await fetch(
        `http://127.0.0.1:${port}/api/me/settings`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ disclosurePolicy: "standard" }),
        },
      );
      assert.equal(seed.status, 200, await seed.text());
      const flip = await fetch(
        `http://127.0.0.1:${port}/api/me/settings`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ disclosurePolicy: "analyst" }),
        },
      );
      assert.equal(flip.status, 200, await flip.text());

      // limit=1 must clamp the response to the single newest row.
      const listOne = await fetch(
        `http://127.0.0.1:${port}/api/me/settings/audit?limit=1`,
        {
          headers: { authorization: `Bearer ${adminToken}` },
        },
      );
      assert.equal(listOne.status, 200);
      const oneBody = (await listOne.json()) as Array<{
        id: string;
        key: string;
        actorEmail: string;
        oldValue: unknown;
        newValue: unknown;
        createdAt: string;
      }>;
      assert.equal(oneBody.length, 1);
      assert.equal(oneBody[0]!.newValue, "analyst");

      // Larger pull: must be reverse-chronological and must not include
      // the sibling org's planted row.
      const listMany = await fetch(
        `http://127.0.0.1:${port}/api/me/settings/audit?limit=50`,
        {
          headers: { authorization: `Bearer ${adminToken}` },
        },
      );
      assert.equal(listMany.status, 200);
      const manyBody = (await listMany.json()) as Array<{
        id: string;
        actorEmail: string;
        createdAt: string;
      }>;
      for (let i = 1; i < manyBody.length; i++) {
        const prev = new Date(manyBody[i - 1]!.createdAt).getTime();
        const cur = new Date(manyBody[i]!.createdAt).getTime();
        assert.ok(
          prev >= cur,
          `rows must be reverse-chronological (idx ${i}: ${prev} < ${cur})`,
        );
      }
      assert.ok(
        !manyBody.some((r) => r.id === otherRowId),
        "sibling-org audit row must not leak into this org's feed",
      );
      assert.ok(
        !manyBody.some((r) => r.actorEmail === "intruder@example.com"),
        "no actor from a sibling org may appear in this org's feed",
      );
    });
  } finally {
    await restoreDisclosurePolicy(orgId, prior);
    // Best-effort cleanup of the synthetic sibling org + its audit row.
    await db
      .delete(orgSettingsAuditLogTable)
      .where(
        and(
          eq(orgSettingsAuditLogTable.orgId, otherOrgId),
          eq(orgSettingsAuditLogTable.id, otherRowId),
        ),
      );
    await db.delete(orgsTable).where(eq(orgsTable.id, otherOrgId));
  }
});
