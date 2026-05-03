/**
 * Coverage test for the admin_audit_log surface required by task #272.
 *
 * Background: external auditors should be able to reconstruct every
 * privileged operator action from a single table — admin_audit_log.
 * Pre-#272 the helper `writeAdminAudit` was only wired into the
 * SCIM/SSO/api-key/onboarding/admin-tenant routes; opportunity
 * decisions, retry-budget overrides, integration lifecycle, taxonomy
 * resolution, and the disclosure-policy switch were invisible to that
 * table. This test pins the new wiring by asserting a row-count delta
 * of EXACTLY ONE in admin_audit_log per action, with the right
 * (actor, action, target, tenant id) tuple and a non-null timestamp.
 *
 * Hits the full Express app over loopback HTTP so middleware, RBAC
 * and the route handler are all exercised end-to-end. Each action
 * gets its own isolated tenant so the row-count delta cannot be
 * polluted by sibling tests running in parallel.
 *
 * Skipped when DATABASE_URL is not set so the suite stays green on
 * unit-test-only checkouts; CI sets the URL.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

// MUST be set BEFORE importing the app: tenant + org-admin middlewares
// read these env vars at module load time.
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";
process.env["ORG_ADMIN_TOKEN"] = process.env["ORG_ADMIN_TOKEN"] ?? "audit-cov-token";
process.env["ERP_CREDENTIAL_ENCRYPTION_KEY"] =
  process.env["ERP_CREDENTIAL_ENCRYPTION_KEY"] ?? "test-key-do-not-use-in-prod";

import {
  db,
  pool,
  orgsTable,
  adminAuditLogTable,
  erpConnectionsTable,
  jobKindSettingsTable,
  unmappedCategoryQueueTable,
  synonymRegistryTable,
} from "@workspace/db";
import { and, count, eq, like } from "drizzle-orm";
import app from "../src/app";
import {
  _clearErpConnectorsForTest,
  registerErpConnector,
} from "../src/lib/connectors/erp-connector";
import { coupaConnector } from "../src/lib/connectors/coupa/adapter";

_clearErpConnectorsForTest();
registerErpConnector(coupaConnector);

const RUN = `t272-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

interface Server {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<Server> {
  const server = http.createServer(app);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((res) => {
        server.close(() => res());
      }),
  };
}

let server: Server | null = null;

const ORG_OPP = `org-${RUN}-opp`;
const ORG_JOB = `org-${RUN}-job`;
const ORG_INT = `org-${RUN}-int`;
const ORG_TAX = `org-${RUN}-tax`;
const ORG_DIS = `org-${RUN}-dis`;
const ORGS = [ORG_OPP, ORG_JOB, ORG_INT, ORG_TAX, ORG_DIS];

before(async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run admin-audit-coverage tests");
  }
  server = await startServer();
  for (const id of ORGS) {
    await db
      .insert(orgsTable)
      .values({ id, name: id, slug: id })
      .onConflictDoNothing();
  }
});

after(async () => {
  // Order: child tables first, then orgs (FK CASCADE handles most
  // children but be explicit for the audit log so the count assertions
  // a future re-run starts clean).
  for (const id of ORGS) {
    try {
      await db
        .delete(adminAuditLogTable)
        .where(eq(adminAuditLogTable.orgId, id));
    } catch {
      /* ignore */
    }
    try {
      await db.delete(orgsTable).where(eq(orgsTable.id, id));
    } catch {
      /* ignore */
    }
  }
  try {
    await db
      .delete(synonymRegistryTable)
      .where(like(synonymRegistryTable.id, `syn_%${RUN}%`));
  } catch {
    /* ignore */
  }
  if (server) await server.close();
});

interface Resp {
  status: number;
  body: unknown;
}

async function call(
  method: string,
  path: string,
  opts: { orgId: string; body?: unknown; orgAdmin?: boolean } = {
    orgId: ORG_OPP,
  },
): Promise<Resp> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-org-id": opts.orgId,
  };
  if (opts.orgAdmin) {
    headers["x-org-admin-token"] = process.env["ORG_ADMIN_TOKEN"]!;
  }
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const r = await fetch(`${server!.baseUrl}${path}`, init);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

/**
 * Count audit rows in admin_audit_log for (orgId, action). We use a
 * tight predicate so each action's row-count delta cannot collide
 * with an unrelated sibling write (e.g. SCIM provisioning) that
 * happens to share the same tenant.
 */
async function auditCount(orgId: string, action: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(adminAuditLogTable)
    .where(
      and(
        eq(adminAuditLogTable.orgId, orgId),
        eq(adminAuditLogTable.action, action),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Most recent audit row for (orgId, action), for tuple assertions. */
async function latestAudit(
  orgId: string,
  action: string,
): Promise<typeof adminAuditLogTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(adminAuditLogTable)
    .where(
      and(
        eq(adminAuditLogTable.orgId, orgId),
        eq(adminAuditLogTable.action, action),
      ),
    );
  if (rows.length === 0) return null;
  return rows.sort(
    (a, b) =>
      (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
  )[0]!;
}

/** Assert a row-count delta of exactly one for (orgId, action). */
async function assertDelta(
  orgId: string,
  action: string,
  before: number,
  expectedTargetId?: string | null,
): Promise<typeof adminAuditLogTable.$inferSelect> {
  const after = await auditCount(orgId, action);
  assert.equal(
    after - before,
    1,
    `expected exactly one new admin_audit_log row for action=${action} on org=${orgId} (before=${before}, after=${after})`,
  );
  const row = await latestAudit(orgId, action);
  assert.ok(row, `latestAudit returned null for action=${action}`);
  assert.equal(row.orgId, orgId, "tenant id must match");
  assert.ok(row.actor && row.actor.length > 0, "actor must be non-empty");
  assert.ok(row.createdAt instanceof Date, "createdAt must be a Date");
  if (expectedTargetId !== undefined) {
    assert.equal(
      row.targetId,
      expectedTargetId,
      `targetId mismatch for action=${action}`,
    );
  }
  return row;
}

// ---------- helpers to seed opportunities + cycles ------------------

// Monotonic generation counter shared across seedOpportunity calls
// so each fresh cycle id stays unique under cycles_org_gen_uq even
// when several cases in this file seed against the same org.
let cycleGeneration = 0;

async function seedOpportunity(
  orgId: string,
  oppId: string,
  cycleId: string,
): Promise<void> {
  const gen = ++cycleGeneration;
  await pool.query(
    `INSERT INTO analysis_cycles
       (id, org_id, generation, triggered_by, status, started_at, completed_at)
     VALUES ($1, $2, $3, 'audit-cov', 'completed', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [cycleId, orgId, gen],
  );
  await pool.query(
    `INSERT INTO opportunities (
       id, org_id, cycle_id, lever_id, tier, title,
       rationale, recommended_action,
       raw_projected_savings_usd, projected_savings_usd, confidence,
       inputs, status
     )
     VALUES ($1,$2,$3,'supplier_consolidation',1,$4,
             'audit-cov','audit-cov',
             '100.00','100.00','0.5000',
             '{}'::jsonb, 'proposed')`,
    [oppId, orgId, cycleId, oppId],
  );
}

// ---------- tests ----------------------------------------------------

describe("admin_audit_log coverage (#272)", () => {
  it("opportunity.approve appends exactly one row", async () => {
    const oppId = `${ORG_OPP}-opp-approve`;
    await seedOpportunity(ORG_OPP, oppId, `${ORG_OPP}-cyc-1`);
    const before = await auditCount(ORG_OPP, "opportunity.approve");
    const r = await call("POST", `/api/opportunities/${oppId}/approve`, {
      orgId: ORG_OPP,
      body: {},
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await assertDelta(ORG_OPP, "opportunity.approve", before, oppId);
  });

  it("opportunity.reject appends exactly one row", async () => {
    const oppId = `${ORG_OPP}-opp-reject`;
    await seedOpportunity(ORG_OPP, oppId, `${ORG_OPP}-cyc-2`);
    const before = await auditCount(ORG_OPP, "opportunity.reject");
    const r = await call("POST", `/api/opportunities/${oppId}/reject`, {
      orgId: ORG_OPP,
      body: { reasonCode: "data_quality_issue", reasonText: "audit-cov" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await assertDelta(ORG_OPP, "opportunity.reject", before, oppId);
  });

  it("opportunity.bulk_approve appends exactly one row per batch", async () => {
    const idA = `${ORG_OPP}-bopp-a`;
    const idB = `${ORG_OPP}-bopp-b`;
    await seedOpportunity(ORG_OPP, idA, `${ORG_OPP}-cyc-3`);
    await seedOpportunity(ORG_OPP, idB, `${ORG_OPP}-cyc-3`);
    const before = await auditCount(ORG_OPP, "opportunity.bulk_approve");
    const r = await call("POST", "/api/opportunities/bulk-approve", {
      orgId: ORG_OPP,
      body: { ids: [idA, idB] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = await assertDelta(ORG_OPP, "opportunity.bulk_approve", before);
    const meta = row.metadata as Record<string, unknown>;
    assert.deepEqual(
      [...((meta["succeededIds"] as string[]) ?? [])].sort(),
      [idA, idB].sort(),
      "metadata.succeededIds must list every affected opp",
    );
    assert.equal(meta["requested"], 2);
  });

  it("opportunity.bulk_reject appends exactly one row per batch", async () => {
    const idA = `${ORG_OPP}-brej-a`;
    const idB = `${ORG_OPP}-brej-b`;
    await seedOpportunity(ORG_OPP, idA, `${ORG_OPP}-cyc-4`);
    await seedOpportunity(ORG_OPP, idB, `${ORG_OPP}-cyc-4`);
    const before = await auditCount(ORG_OPP, "opportunity.bulk_reject");
    const r = await call("POST", "/api/opportunities/bulk-reject", {
      orgId: ORG_OPP,
      body: {
        ids: [idA, idB],
        reasonCode: "data_quality_issue",
        reasonText: "audit-cov",
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await assertDelta(ORG_OPP, "opportunity.bulk_reject", before);
  });

  it("opportunity.bulk_snooze appends exactly one row per batch", async () => {
    const idA = `${ORG_OPP}-bsnz-a`;
    const idB = `${ORG_OPP}-bsnz-b`;
    await seedOpportunity(ORG_OPP, idA, `${ORG_OPP}-cyc-5`);
    await seedOpportunity(ORG_OPP, idB, `${ORG_OPP}-cyc-5`);
    const before = await auditCount(ORG_OPP, "opportunity.bulk_snooze");
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const r = await call("POST", "/api/opportunities/bulk-snooze", {
      orgId: ORG_OPP,
      body: { ids: [idA, idB], snoozedUntil: future.toISOString() },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await assertDelta(ORG_OPP, "opportunity.bulk_snooze", before);
  });

  it("jobs.retry_budget_update appends exactly one row", async () => {
    // Clean any prior override row so the route exercises the insert
    // branch (the audit assertion is delta-based so this isn't
    // strictly required, but it keeps the test self-contained).
    try {
      await db
        .delete(jobKindSettingsTable)
        .where(
          and(
            eq(jobKindSettingsTable.orgId, ORG_JOB),
            eq(jobKindSettingsTable.kind, "ingest_csv"),
          ),
        );
    } catch {
      /* ignore */
    }
    const before = await auditCount(ORG_JOB, "jobs.retry_budget_update");
    const r = await call("PUT", "/api/jobs/settings/ingest_csv", {
      orgId: ORG_JOB,
      body: { maxAttempts: 7 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await assertDelta(ORG_JOB, "jobs.retry_budget_update", before, "ingest_csv");
  });

  it("jobs.retry_budget_clear appends exactly one row", async () => {
    const before = await auditCount(ORG_JOB, "jobs.retry_budget_clear");
    const r = await call("DELETE", "/api/jobs/settings/ingest_csv", {
      orgId: ORG_JOB,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await assertDelta(ORG_JOB, "jobs.retry_budget_clear", before, "ingest_csv");
  });

  it("integration.connect / update / disconnect each append one row", async () => {
    const label = `audit-cov-${RUN}-int`;
    // -- connect ----------------------------------------------------
    const connectBefore = await auditCount(ORG_INT, "integration.connect");
    const created = await call("POST", "/api/integrations/connections", {
      orgId: ORG_INT,
      orgAdmin: true,
      body: {
        label,
        adapterKey: "coupa",
        credentials: { clientId: "id", clientSecret: "sec" },
        settings: { instanceUrl: "https://acme.coupahost.com" },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const connId = (
      created.body as { connection: { id: string } }
    ).connection.id;
    await assertDelta(ORG_INT, "integration.connect", connectBefore, connId);

    // -- update -----------------------------------------------------
    const updateBefore = await auditCount(ORG_INT, "integration.update");
    const patched = await call(
      "PATCH",
      `/api/integrations/connections/${connId}`,
      {
        orgId: ORG_INT,
        orgAdmin: true,
        body: { status: "paused" },
      },
    );
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    await assertDelta(ORG_INT, "integration.update", updateBefore, connId);

    // -- disconnect -------------------------------------------------
    const deleteBefore = await auditCount(ORG_INT, "integration.disconnect");
    const deleted = await call(
      "DELETE",
      `/api/integrations/connections/${connId}`,
      { orgId: ORG_INT, orgAdmin: true },
    );
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
    await assertDelta(
      ORG_INT,
      "integration.disconnect",
      deleteBefore,
      connId,
    );

    // Belt-and-braces: cleanup the orphan erp_connections row if the
    // disconnect somehow failed to remove it.
    try {
      await db
        .delete(erpConnectionsTable)
        .where(eq(erpConnectionsTable.id, connId));
    } catch {
      /* ignore */
    }
  });

  it("taxonomy.synonym_resolve appends exactly one row", async () => {
    // Seed an unmapped queue entry directly so we can drive the
    // resolve route. We use a RUN-scoped tenant string so re-runs
    // never collide on the unique-by-org normalized predicate.
    const tenantString = `audit-cov-cat-${RUN}`;
    const queueId = `umq_${RUN}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    // "Open" is implicit: a queue row is open while resolvedAt IS
    // NULL (see unmapped_queue_open_uq partial index).
    await db.insert(unmappedCategoryQueueTable).values({
      id: queueId,
      orgId: ORG_TAX,
      tenantString,
      normalized: tenantString.toLowerCase(),
      spendTrailing90dUsd: "100.00",
      lastSeenAt: new Date(),
    });
    const before = await auditCount(ORG_TAX, "taxonomy.synonym_resolve");
    const r = await call(
      "POST",
      `/api/admin/routing/queue/${queueId}/resolve`,
      {
        orgId: ORG_TAX,
        body: { canonicalCode: "IRON_STEEL", scope: "tenant_scoped" },
      },
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = await assertDelta(
      ORG_TAX,
      "taxonomy.synonym_resolve",
      before,
    );
    const meta = row.metadata as Record<string, unknown>;
    assert.equal(meta["queueId"], queueId);
    assert.equal(meta["canonicalCode"], "IRON_STEEL");
    assert.equal(meta["scope"], "tenant_scoped");
  });

  it("tenant.settings_update (disclosure-policy switch) appends exactly one row", async () => {
    const before = await auditCount(ORG_DIS, "tenant.settings_update");
    const r = await call("PATCH", "/api/me/settings", {
      orgId: ORG_DIS,
      body: { disclosurePolicy: "analyst" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = await assertDelta(
      ORG_DIS,
      "tenant.settings_update",
      before,
      ORG_DIS,
    );
    const meta = row.metadata as Record<string, unknown>;
    const changes = meta["changes"] as Array<Record<string, unknown>>;
    assert.ok(
      Array.isArray(changes) && changes.some((c) => c["key"] === "disclosurePolicy"),
      "metadata.changes must include the disclosurePolicy key",
    );
  });
});

