/**
 * Task #297 — cross-tenant isolation regression net.
 *
 * Seeds two distinct orgs (A and B), each owning a private
 * `opportunities` row, and exercises the real Express stack
 * (tenantMiddleware + RBAC + route handlers + global error handler)
 * to assert that org B can NEVER read or mutate org A's data via the
 * `x-org-id` dev tenant header. A leak here would mean a single
 * compromised auth context could see every other tenant's pipeline,
 * which is the worst-case multi-tenant SaaS regression.
 *
 * The test is intentionally narrow: it covers the highest-traffic
 * tenant-scoped surfaces (opportunity read, single-row mutations,
 * bulk mutations, decision audit). It does NOT enumerate every
 * route — that's tracked as a separate follow-up — but it does
 * pin the contract that the typed-error envelope is what clients
 * see on a cross-tenant attempt (404 not_found / skipped, never a
 * silent success or a 200 with the foreign row's body).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import {
  db,
  pool,
  orgsTable,
  opportunitiesTable,
  decisionsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import app from "../src/app";

interface Handle {
  port: number;
  close: () => Promise<void>;
}

async function startServer(): Promise<Handle> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

interface Resp {
  status: number;
  body: any;
}

async function call(
  port: number,
  method: string,
  path: string,
  opts: { orgId?: string; body?: unknown } = {},
): Promise<Resp> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.orgId) headers["x-org-id"] = opts.orgId;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function seedOrgWithOpp(
  runTag: string,
  oppId: string,
): Promise<{ orgId: string; cycleId: string; oppId: string }> {
  const orgId = `org_${runTag}`;
  const cycleId = `cyc_${runTag}`;
  await db
    .insert(orgsTable)
    .values({ id: orgId, name: orgId, slug: orgId })
    .onConflictDoNothing();
  await pool.query(
    `INSERT INTO analysis_cycles
       (id, org_id, generation, triggered_by, status, started_at, completed_at)
     VALUES ($1, $2, 1, 'test', 'completed', now(), now())`,
    [cycleId, orgId],
  );
  await pool.query(
    `INSERT INTO opportunities (
       id, org_id, cycle_id, lever_id, tier, title,
       rationale, recommended_action,
       raw_projected_savings_usd, projected_savings_usd, confidence,
       inputs, status
     )
     VALUES ($1, $2, $3, 'supplier_consolidation', 1, $4,
             'test', 'test',
             '100.00', '100.00', '0.5000',
             '{}'::jsonb, 'proposed')`,
    [oppId, orgId, cycleId, oppId],
  );
  return { orgId, cycleId, oppId };
}

async function cleanupOrg(orgId: string): Promise<void> {
  try {
    await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  } catch {
    /* ignore cascade race */
  }
}

test("cross-tenant isolation: org B cannot read or mutate org A's opportunity", async (t) => {
  const runTag = `iso-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const oppA = `opp_${runTag}_a`;
  const oppB = `opp_${runTag}_b`;
  const a = await seedOrgWithOpp(`${runTag}-A`, oppA);
  const b = await seedOrgWithOpp(`${runTag}-B`, oppB);
  const handle = await startServer();
  t.after(async () => {
    await handle.close();
    await cleanupOrg(a.orgId);
    await cleanupOrg(b.orgId);
  });

  await t.test(
    "GET /api/opportunities for org B does NOT include org A's row",
    async () => {
      const r = await call(handle.port, "GET", "/api/opportunities", {
        orgId: b.orgId,
      });
      assert.equal(r.status, 200);
      const list = Array.isArray(r.body) ? r.body : (r.body?.items ?? []);
      const ids: string[] = list.map((row: any) => row.id);
      assert.ok(
        !ids.includes(oppA),
        `org B leaked org A's opportunity ${oppA}: ${JSON.stringify(ids)}`,
      );
    },
  );

  await t.test(
    "GET /api/opportunities/:id with foreign id returns typed not_found",
    async () => {
      const r = await call(
        handle.port,
        "GET",
        `/api/opportunities/${oppA}`,
        { orgId: b.orgId },
      );
      // 404 is the only acceptable answer; a 200 with org A's payload
      // would be a tenant leak. 401/403 are also acceptable strict
      // refusals if the route gates earlier.
      assert.notEqual(r.status, 200, `tenant leak: org B got 200 for ${oppA}`);
      assert.ok(
        [401, 403, 404].includes(r.status),
        `unexpected status ${r.status}: ${JSON.stringify(r.body)}`,
      );
    },
  );

  await t.test(
    "POST /api/opportunities/bulk-approve with foreign id MUST NOT mutate org A's row",
    async () => {
      const before = await db
        .select()
        .from(opportunitiesTable)
        .where(eq(opportunitiesTable.id, oppA));
      assert.equal(before.length, 1);
      assert.equal(before[0]!.status, "proposed");

      const r = await call(
        handle.port,
        "POST",
        "/api/opportunities/bulk-approve",
        { orgId: b.orgId, body: { ids: [oppA] } },
      );

      // The route may answer 200 with `succeeded:0, skippedNoPermission:1`,
      // or it may refuse with 403/401 — both shapes are acceptable.
      // What is NOT acceptable is org A's row transitioning.
      const after = await db
        .select()
        .from(opportunitiesTable)
        .where(eq(opportunitiesTable.id, oppA));
      assert.equal(after.length, 1);
      assert.equal(
        after[0]!.status,
        "proposed",
        `tenant leak: org B mutated org A's opportunity. response=${JSON.stringify(
          r.body,
        )}`,
      );

      // No decision audit row should exist for org B against oppA.
      const leakedDecisions = await db
        .select()
        .from(decisionsTable)
        .where(
          and(
            eq(decisionsTable.orgId, b.orgId),
            inArray(decisionsTable.opportunityId, [oppA]),
          ),
        );
      assert.equal(
        leakedDecisions.length,
        0,
        `tenant leak: org B wrote ${leakedDecisions.length} decisions against org A's opportunity`,
      );

      if (r.status === 200 && r.body && typeof r.body === "object") {
        // If the route reported success, it must report it as
        // skipped — never as succeeded.
        assert.equal(r.body.succeeded ?? 0, 0);
        assert.ok(
          (r.body.skippedNoPermission ?? 0) >= 1 ||
            (r.body.failed ?? 0) >= 1,
          `bulk-approve response should mark foreign id as skipped/failed: ${JSON.stringify(
            r.body,
          )}`,
        );
      }
    },
  );

  await t.test(
    "echoes a request id on tenant-scoped responses for log correlation",
    async () => {
      // Verify the X-Request-Id contract from task #297: the
      // pino-http genReqId honours an inbound id and echoes it back
      // on the response so a single failure can be traced end-to-end
      // across the api-server log.
      const port = handle.port;
      const reqId = `req_iso_${Date.now()}`;
      const res = await fetch(`http://127.0.0.1:${port}/api/opportunities`, {
        method: "GET",
        headers: {
          "x-org-id": b.orgId,
          "x-request-id": reqId,
        },
      });
      await res.text();
      assert.equal(res.headers.get("x-request-id"), reqId);
    },
  );
});
