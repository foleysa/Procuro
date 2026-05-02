/**
 * Companion regression test for Task #175.
 *
 * Where `suppliers-patch-actor-audit.test.ts` exercises the api-key
 * code path, this file pins the *primary* user-facing requirement: a
 * teammate signed into Clerk lands their own email (or Clerk user id)
 * in `supplier_audit_log.actor_email` — never the static system
 * fallback the Activity tab used to display.
 *
 * We mock `@clerk/express`'s `getAuth` via `node:test`'s `mock.module`
 * so the request flows through the real `tenantMiddleware` Clerk
 * branch without needing a live Clerk instance. The mock returns the
 * same shape clerkMiddleware would have populated (`userId` plus
 * `sessionClaims.email`).
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
delete process.env["ALLOW_DEV_TENANT_HEADER"];

const FAKE_CLERK_USER_ID = "user_t175_clerk_fake";
const FAKE_CLERK_EMAIL = "alice.taylor@example.com";

// Must register before importing `../src/app` so tenantMiddleware picks
// up the mocked module instead of the real Clerk SDK.
mock.module("@clerk/express", {
  namedExports: {
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
    getAuth: () => ({
      userId: FAKE_CLERK_USER_ID,
      sessionClaims: { email: FAKE_CLERK_EMAIL },
    }),
  },
});

const { and, desc, eq } = await import("drizzle-orm");
const {
  db,
  orgsTable,
  userRolesTable,
  suppliersTable,
  supplierAuditLogTable,
} = await import("@workspace/db");
const { default: app } = await import("../src/app");
const { newId } = await import("../src/lib/ids");

const RUN = `t175c-${randomUUID().replace(/-/g, "").slice(0, 10)}`;

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

test("PATCH /suppliers/:id records the Clerk user's email in the audit log", async () => {
  const orgId = `org_${RUN}`;
  const supplierId = `sup_${RUN}`;

  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} org`,
    slug: RUN,
  });
  await db.insert(suppliersTable).values({
    id: supplierId,
    orgId,
    name: `${RUN} supplier`,
    normalizedName: `${RUN} supplier`,
    sourceSystem: "csv",
    sourceExternalId: `${RUN}-sup`,
    billingCurrency: "USD",
  });
  // tenantMiddleware's Clerk branch requires a non-revoked role row
  // mapping (clerkUserId, orgId) before it will scope the request.
  await db.insert(userRolesTable).values({
    id: newId("ur"),
    userId: FAKE_CLERK_USER_ID,
    orgId,
    role: "org_admin",
    email: FAKE_CLERK_EMAIL,
    grantedVia: "manual",
    grantedBy: "task-175-test@procuro.ai",
  });

  try {
    await withServer(async (port) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/suppliers/${supplierId}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-org-id": orgId,
          },
          body: JSON.stringify({ billingCurrency: "EUR", isPreferred: true }),
        },
      );
      assert.equal(res.status, 200, await res.text());

      const rows = await db
        .select()
        .from(supplierAuditLogTable)
        .where(
          and(
            eq(supplierAuditLogTable.orgId, orgId),
            eq(supplierAuditLogTable.supplierId, supplierId),
          ),
        )
        .orderBy(desc(supplierAuditLogTable.createdAt));

      assert.equal(rows.length, 2, "one audit row per changed field");
      for (const row of rows) {
        assert.equal(
          row.actorEmail,
          FAKE_CLERK_EMAIL,
          "Clerk-authenticated PATCH must stamp the signed-in user's email",
        );
        assert.notEqual(
          row.actorEmail,
          "system@procuro.ai",
          "must never collapse to the static system fallback",
        );
      }
    });
  } finally {
    await db
      .delete(supplierAuditLogTable)
      .where(eq(supplierAuditLogTable.supplierId, supplierId));
    await db.delete(suppliersTable).where(eq(suppliersTable.id, supplierId));
    await db.delete(userRolesTable).where(eq(userRolesTable.orgId, orgId));
    await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  }
});
