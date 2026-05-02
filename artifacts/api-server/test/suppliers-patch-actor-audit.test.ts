/**
 * Regression test for Task #175.
 *
 * Pins that PATCH /suppliers/:id records the *authenticated* actor on
 * each `supplier_audit_log` row — never the previously-hardcoded
 * "system@procuro.ai" fallback. The Activity tab on Supplier 360
 * surfaces these rows verbatim, so a system-attribution would make it
 * impossible to tell which teammate flipped billing currency / tags /
 * etc.
 *
 * We exercise the route via an `org_admin` API key (same pattern as
 * `me-settings-audit.test.ts`) so the request flows through
 * `tenantMiddleware` exactly as a real client would. The api-key path
 * sets `req.actorEmail = "apikey:<label>@procuro.ai"`, which proves the
 * route now threads the resolved identity rather than collapsing to a
 * static system email.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
delete process.env["ALLOW_DEV_TENANT_HEADER"];

import { and, desc, eq } from "drizzle-orm";
import {
  db,
  orgsTable,
  apiKeysTable,
  suppliersTable,
  supplierAuditLogTable,
} from "@workspace/db";
import app from "../src/app";
import { generateToken } from "../src/lib/auth";
import { newId } from "../src/lib/ids";

const RUN = `t175-${randomUUID().replace(/-/g, "").slice(0, 10)}`;

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

test("PATCH /suppliers/:id records the resolved actor identity, not 'system@procuro.ai'", async () => {
  const orgId = `org_${RUN}`;
  const supplierId = `sup_${RUN}`;
  const keyLabel = `actor-audit-${RUN}`;

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

  const { plain, hash } = generateToken();
  await db.insert(apiKeysTable).values({
    id: newId("ak"),
    orgId,
    label: keyLabel,
    prefix: plain.slice(0, 12),
    tokenHash: hash,
    scopeRole: "org_admin",
    createdBy: "task-175-test@procuro.ai",
  });

  try {
    await withServer(async (port) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/suppliers/${supplierId}`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${plain}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ billingCurrency: "EUR", isStrategic: true }),
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
        assert.notEqual(
          row.actorEmail,
          "system@procuro.ai",
          "audit row must record the resolved actor, not the static system fallback",
        );
        // The api-key bearer path encodes the key's label so reviewers
        // can tell which client made the change. Pinning the exact
        // shape here guards against future middleware refactors that
        // might silently drop the label.
        assert.equal(
          row.actorEmail,
          `apikey:${keyLabel}@procuro.ai`,
          "audit row must reflect the api-key identity",
        );
      }
    });
  } finally {
    await db
      .delete(supplierAuditLogTable)
      .where(eq(supplierAuditLogTable.supplierId, supplierId));
    await db.delete(suppliersTable).where(eq(suppliersTable.id, supplierId));
    await db.delete(apiKeysTable).where(eq(apiKeysTable.orgId, orgId));
    await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  }
});
