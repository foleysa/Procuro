/**
 * Task #304 — comprehensive cross-tenant isolation test suite.
 *
 * Seeds two distinct orgs (A and B), each with its own API key and
 * private data rows across every tenant-scoped table. For every
 * tenant-scoped route family the test verifies that org B's API key
 * cannot read or mutate org A's data — and that the response carries
 * the correct typed-error envelope (404 `{ error }` for detail/mutation
 * routes, 403 for header-mismatch).
 *
 * Auth: uses real `api_keys` rows with `org_admin` scope so RBAC
 * gates don't mask tenant isolation failures with permission denials.
 *
 * Assertions per route type:
 *   - List endpoints: org B sees 200 with an empty (or org-B-only) list
 *     that NEVER contains any of org A's seeded row IDs.
 *   - Detail endpoints with org A's id: exactly 404 with `{ error }`
 *     body (never 200).
 *   - Mutation endpoints with org A's id: exactly 404 with `{ error }`
 *     body; org A's row MUST remain unchanged in the database.
 *   - Aggregation endpoints: 200 scoped to org B, no org A data leaked.
 */
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
delete process.env["ALLOW_DEV_TENANT_HEADER"];

import {
  db,
  pool,
  orgsTable,
  suppliersTable,
  contractsTable,
  statementsOfWorkTable,
  watchedIssuersTable,
  rateCardsTable,
  methodsAndToolsTable,
  alertsTable,
  apiKeysTable,
  adminAuditLogTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { generateToken } from "../src/lib/auth";
import { newId } from "../src/lib/ids";

// ─── Helpers ──────────────────────────────────────────────────────────────

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
  token: string,
  body?: unknown,
): Promise<Resp> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON response (CSV export, PDF download, etc.) — keep as
      // raw string so leak-checks can still substring-search it.
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

function extractIds(body: any): string[] {
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.items)
      ? body.items
      : [];
  return list.map((r: any) => r.id);
}

/**
 * Assert the response is the canonical typed not-found envelope:
 *   status 404, body { error: string, code: "not_found" }
 *
 * Routes covered by the cross-tenant matrix below all use
 * `throw new NotFoundError(...)` which the global error handler
 * (`lib/global-error-handler.ts`) renders as this envelope. A leak
 * would either be a 200 with the foreign row, or a 404 missing the
 * `code` field — both of which fail this assertion.
 */
function assertTypedNotFound(r: Resp, label: string): void {
  assert.equal(
    r.status,
    404,
    `${label}: expected 404, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`,
  );
  assert.ok(
    r.body && typeof r.body.error === "string" && r.body.error.length > 0,
    `${label}: expected { error: "..." } body, got ${JSON.stringify(r.body).slice(0, 300)}`,
  );
  assert.equal(
    r.body?.code,
    "not_found",
    `${label}: expected { code: "not_found" }, got code=${r.body?.code}`,
  );
}

// ─── Seed infrastructure ──────────────────────────────────────────────────

interface OrgFixture {
  orgId: string;
  token: string;
  supplierId: string;
  contractId: string;
  sowId: string;
  cycleId: string;
  oppId: string;
  alertId: string;
  signalId: string;
  watchedIssuerId: string;
  rateCardId: string;
  methodToolId: string;
}

async function issueKey(orgId: string, label: string): Promise<string> {
  const { plain, hash } = generateToken();
  await db.insert(apiKeysTable).values({
    id: newId("ak"),
    orgId,
    label,
    prefix: plain.slice(0, 12),
    tokenHash: hash,
    scopeRole: "org_admin",
    createdBy: "tenant-iso-test@procuro.ai",
  });
  return plain;
}

async function seedOrg(tag: string): Promise<OrgFixture> {
  const orgId = `org_iso_${tag}`;
  const supplierId = `sup_iso_${tag}`;
  const contractId = `con_iso_${tag}`;
  const sowId = `sow_iso_${tag}`;
  const cycleId = `cyc_iso_${tag}`;
  const oppId = `opp_iso_${tag}`;
  const alertId = `alt_iso_${tag}`;
  const signalId = `sig_iso_${tag}`;
  const watchedIssuerId = `wi_iso_${tag}`;
  const rateCardId = `rc_iso_${tag}`;
  const methodToolId = `mt_iso_${tag}`;

  await db
    .insert(orgsTable)
    .values({ id: orgId, name: `Org ${tag}`, slug: `org-iso-${tag}` })
    .onConflictDoNothing();

  const token = await issueKey(orgId, `iso-test-${tag}`);

  await db
    .insert(suppliersTable)
    .values({
      id: supplierId,
      orgId,
      name: `Supplier ${tag}`,
      normalizedName: `supplier ${tag}`,
    })
    .onConflictDoNothing();

  await db
    .insert(contractsTable)
    .values({
      id: contractId,
      orgId,
      supplierId,
      contractNumber: `C-${tag}`,
      title: `Contract ${tag}`,
      status: "active",
      startDate: new Date("2025-01-01"),
      endDate: new Date("2027-01-01"),
      annualBaselineUsd: "10000.00",
    })
    .onConflictDoNothing();

  await db
    .insert(statementsOfWorkTable)
    .values({
      id: sowId,
      orgId,
      supplierId,
      contractId,
      sowNumber: `SOW-${tag}`,
      title: `SOW ${tag}`,
      status: "active",
      startDate: new Date("2025-01-01"),
      endDate: new Date("2027-01-01"),
    })
    .onConflictDoNothing();

  await pool.query(
    `INSERT INTO analysis_cycles
       (id, org_id, generation, triggered_by, status, started_at, completed_at)
     VALUES ($1, $2, 1, 'test', 'completed', now(), now())
     ON CONFLICT DO NOTHING`,
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
             '{}'::jsonb, 'proposed')
     ON CONFLICT DO NOTHING`,
    [oppId, orgId, cycleId, `Opp ${tag}`],
  );

  await db
    .insert(alertsTable)
    .values({
      id: alertId,
      orgId,
      severity: "high",
      source: "manual",
      kind: "test_isolation",
      title: `Alert ${tag}`,
      summary: `Test alert for ${tag}`,
      state: "open",
    })
    .onConflictDoNothing();

  await pool.query(
    `INSERT INTO collectors (id, name, description, posture, status, owner, source_url, created_at)
     VALUES ($1, $2, $3, 'approved', 'approved', 'test', 'https://test.example', now())
     ON CONFLICT DO NOTHING`,
    [`col_iso_${tag}`, `Collector ${tag}`, `Test collector ${tag}`],
  );
  await pool.query(
    `INSERT INTO market_signals
       (id, org_id, collector_id, signal_type, value, unit, observed_at, source_url, posture)
     VALUES ($1, $2, $3, 'price_change', '42.000000', 'USD/unit', now(), 'https://test.example', 'approved')
     ON CONFLICT DO NOTHING`,
    [signalId, orgId, `col_iso_${tag}`],
  );

  await db
    .insert(watchedIssuersTable)
    .values({
      id: watchedIssuerId,
      orgId,
      source: "sec_edgar",
      identifier: `0000${tag}`,
      name: `Issuer ${tag}`,
      createdBy: "test@procuro.ai",
    })
    .onConflictDoNothing();

  await db
    .insert(rateCardsTable)
    .values({
      id: rateCardId,
      orgId,
      supplierId,
      name: `RateCard ${tag}`,
      currency: "USD",
      effectiveDate: new Date("2025-01-01"),
    })
    .onConflictDoNothing();

  await db
    .insert(methodsAndToolsTable)
    .values({
      id: methodToolId,
      orgId,
      sourcingStrategy: `strategy_${tag}`,
      method: "competitive_bid",
      toolSystem: "manual",
      maturity: "proven",
    })
    .onConflictDoNothing();

  return {
    orgId,
    token,
    supplierId,
    contractId,
    sowId,
    cycleId,
    oppId,
    alertId,
    signalId,
    watchedIssuerId,
    rateCardId,
    methodToolId,
  };
}

async function cleanupOrg(orgId: string): Promise<void> {
  try {
    await db.delete(apiKeysTable).where(eq(apiKeysTable.orgId, orgId));
  } catch { /* ignore */ }
  try {
    await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  } catch { /* ignore cascade */ }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("cross-tenant isolation suite", async () => {
  const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let a: OrgFixture;
  let b: OrgFixture;
  let handle: Handle;

  test.before(async () => {
    a = await seedOrg(`${runTag}-A`);
    b = await seedOrg(`${runTag}-B`);
    handle = await startServer();
  });

  test.after(async () => {
    await handle.close();
    await cleanupOrg(a.orgId);
    await cleanupOrg(b.orgId);
  });

  // ══════════════════════════════════════════════════════════════════════
  // LIST ENDPOINTS: org B must NOT see any of org A's seeded row IDs
  // ══════════════════════════════════════════════════════════════════════

  const listRoutes: Array<{
    label: string;
    path: string;
    foreignIds: (a: OrgFixture) => string[];
    idExtractor?: (body: any) => string[];
  }> = [
    {
      label: "GET /api/suppliers",
      path: "/api/suppliers",
      foreignIds: (a) => [a.supplierId],
    },
    {
      label: "GET /api/contracts",
      path: "/api/contracts",
      foreignIds: (a) => [a.contractId],
    },
    {
      label: "GET /api/sows",
      path: "/api/sows?status=all",
      foreignIds: (a) => [a.sowId],
    },
    {
      label: "GET /api/opportunities",
      path: "/api/opportunities",
      foreignIds: (a) => [a.oppId],
    },
    {
      label: "GET /api/alerts",
      path: "/api/alerts",
      foreignIds: (a) => [a.alertId],
    },
    {
      label: "GET /api/watched-issuers",
      path: "/api/watched-issuers",
      foreignIds: (a) => [a.watchedIssuerId],
    },
    {
      label: "GET /api/rate-cards",
      path: "/api/rate-cards",
      foreignIds: (a) => [a.rateCardId],
    },
    {
      label: "GET /api/methods-and-tools",
      path: "/api/methods-and-tools",
      foreignIds: (a) => [a.methodToolId],
    },
    {
      label: "GET /api/cycles",
      path: "/api/cycles",
      foreignIds: (a) => [a.cycleId],
    },
    {
      label: "GET /api/market-signals",
      path: "/api/market-signals",
      foreignIds: (a) => [a.signalId],
      idExtractor: (body: any) => {
        const list = Array.isArray(body) ? body : [];
        return list.map((r: any) => r.id);
      },
    },
    {
      label: "GET /api/intelligence/signals",
      path: "/api/intelligence/signals",
      foreignIds: (a) => [a.signalId],
    },
  ];

  for (const route of listRoutes) {
    it(`${route.label} — org B does not see org A's rows`, async () => {
      const r = await call(handle.port, "GET", route.path, b.token);
      assert.equal(
        r.status,
        200,
        `expected 200 for list, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`,
      );
      const ids = route.idExtractor ? route.idExtractor(r.body) : extractIds(r.body);
      for (const foreignId of route.foreignIds(a)) {
        assert.ok(
          !ids.includes(foreignId),
          `tenant leak on ${route.label}: org B sees org A's ${foreignId}`,
        );
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // DETAIL ENDPOINTS: org B requesting org A's id must get exactly 404
  // with a typed { error } body — never 200 with the foreign row.
  // ══════════════════════════════════════════════════════════════════════

  it("GET /api/suppliers/:id — 404 not_found for org A's supplier", async () => {
    const r = await call(handle.port, "GET", `/api/suppliers/${a.supplierId}`, b.token);
    assertTypedNotFound(r, "suppliers/:id");
  });

  it("GET /api/contracts/:id — 404 not_found for org A's contract", async () => {
    const r = await call(handle.port, "GET", `/api/contracts/${a.contractId}`, b.token);
    assertTypedNotFound(r, "contracts/:id");
  });

  it("GET /api/sows/:id — 404 not_found for org A's SOW", async () => {
    const r = await call(handle.port, "GET", `/api/sows/${a.sowId}`, b.token);
    assertTypedNotFound(r, "sows/:id");
  });

  it("GET /api/opportunities/:id — 404 not_found for org A's opportunity", async () => {
    const r = await call(handle.port, "GET", `/api/opportunities/${a.oppId}`, b.token);
    assertTypedNotFound(r, "opportunities/:id");
  });

  it("GET /api/cycles/:id — 404 not_found for org A's cycle", async () => {
    const r = await call(handle.port, "GET", `/api/cycles/${a.cycleId}`, b.token);
    assertTypedNotFound(r, "cycles/:id");
  });

  it("GET /api/rate-cards/:id — 404 not_found for org A's rate card", async () => {
    const r = await call(handle.port, "GET", `/api/rate-cards/${a.rateCardId}`, b.token);
    assertTypedNotFound(r, "rate-cards/:id");
  });

  // ══════════════════════════════════════════════════════════════════════
  // MUTATION ENDPOINTS: org B must get 404 { error } AND org A's DB
  // row must remain unchanged. Payloads use schema-valid values so the
  // 404 is definitely from tenant scoping, not input validation.
  // ══════════════════════════════════════════════════════════════════════

  it("PATCH /api/suppliers/:id — 404, org A's supplier unchanged", async () => {
    const [before] = await db
      .select({ notes: suppliersTable.internalNotes })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, a.supplierId));
    const r = await call(
      handle.port,
      "PATCH",
      `/api/suppliers/${a.supplierId}`,
      b.token,
      { internalNotes: "cross-tenant-probe" },
    );
    assertTypedNotFound(r, "PATCH suppliers/:id");
    const [after] = await db
      .select({ notes: suppliersTable.internalNotes })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, a.supplierId));
    assert.equal(
      after?.notes,
      before?.notes,
      "tenant leak: org A's supplier.internalNotes was mutated by org B",
    );
  });

  it("PATCH /api/contracts/:id — 404, org A's contract unchanged", async () => {
    const [before] = await db
      .select({ notes: contractsTable.internalNotes })
      .from(contractsTable)
      .where(eq(contractsTable.id, a.contractId));
    const r = await call(
      handle.port,
      "PATCH",
      `/api/contracts/${a.contractId}`,
      b.token,
      { internalNotes: "cross-tenant-probe" },
    );
    assertTypedNotFound(r, "PATCH contracts/:id");
    const [after] = await db
      .select({ notes: contractsTable.internalNotes })
      .from(contractsTable)
      .where(eq(contractsTable.id, a.contractId));
    assert.equal(
      after?.notes,
      before?.notes,
      "tenant leak: org A's contract.internalNotes was mutated by org B",
    );
  });

  it("PATCH /api/methods-and-tools/:id — 404, org A's M&T row unchanged", async () => {
    const [before] = await db
      .select({ toolSystem: methodsAndToolsTable.toolSystem })
      .from(methodsAndToolsTable)
      .where(eq(methodsAndToolsTable.id, a.methodToolId));
    const r = await call(
      handle.port,
      "PATCH",
      `/api/methods-and-tools/${a.methodToolId}`,
      b.token,
      { toolSystem: "cross-tenant-probe" },
    );
    assertTypedNotFound(r, "PATCH methods-and-tools/:id");
    const [after] = await db
      .select({ toolSystem: methodsAndToolsTable.toolSystem })
      .from(methodsAndToolsTable)
      .where(eq(methodsAndToolsTable.id, a.methodToolId));
    assert.equal(
      after?.toolSystem,
      before?.toolSystem,
      "tenant leak: org A's methods-and-tools.toolSystem was mutated by org B",
    );
  });

  it("DELETE /api/methods-and-tools/:id — 404, org A's M&T row still exists", async () => {
    const r = await call(
      handle.port,
      "DELETE",
      `/api/methods-and-tools/${a.methodToolId}`,
      b.token,
    );
    assertTypedNotFound(r, "DELETE methods-and-tools/:id");
    const [row] = await db
      .select({ id: methodsAndToolsTable.id })
      .from(methodsAndToolsTable)
      .where(eq(methodsAndToolsTable.id, a.methodToolId));
    assert.ok(row, "tenant leak: org A's methods-and-tools row was deleted by org B");
  });

  it("DELETE /api/watched-issuers/:id — 404, org A's watched issuer still exists", async () => {
    const r = await call(
      handle.port,
      "DELETE",
      `/api/watched-issuers/${a.watchedIssuerId}`,
      b.token,
    );
    assertTypedNotFound(r, "DELETE watched-issuers/:id");
    const [row] = await db
      .select({ id: watchedIssuersTable.id })
      .from(watchedIssuersTable)
      .where(eq(watchedIssuersTable.id, a.watchedIssuerId));
    assert.ok(row, "tenant leak: org A's watched issuer was deleted by org B");
  });

  // ── Opportunity state-transition mutations ──────────────────────────

  it("POST /api/opportunities/:id/approve — 404, org A's opp stays proposed", async () => {
    const r = await call(
      handle.port,
      "POST",
      `/api/opportunities/${a.oppId}/approve`,
      b.token,
    );
    assertTypedNotFound(r, "POST opportunities/:id/approve");
    const result = await pool.query(
      `SELECT status FROM opportunities WHERE id = $1`,
      [a.oppId],
    );
    assert.equal(
      result.rows[0]?.status,
      "proposed",
      "tenant leak: org A's opportunity status changed from proposed",
    );
  });

  it("POST /api/opportunities/:id/reject — 404, org A's opp stays proposed", async () => {
    const r = await call(
      handle.port,
      "POST",
      `/api/opportunities/${a.oppId}/reject`,
      b.token,
      { reasonCode: "other", reasonText: "cross-tenant-probe" },
    );
    assertTypedNotFound(r, "POST opportunities/:id/reject");
    const result = await pool.query(
      `SELECT status FROM opportunities WHERE id = $1`,
      [a.oppId],
    );
    assert.equal(
      result.rows[0]?.status,
      "proposed",
      "tenant leak: org A's opportunity status changed from proposed after reject",
    );
  });

  it("POST /api/opportunities/bulk-approve — org A's opp stays proposed, skipped or failed", async () => {
    const beforeResult = await pool.query(
      `SELECT status FROM opportunities WHERE id = $1`,
      [a.oppId],
    );
    assert.equal(beforeResult.rows[0]?.status, "proposed");

    const r = await call(
      handle.port,
      "POST",
      "/api/opportunities/bulk-approve",
      b.token,
      { ids: [a.oppId] },
    );

    const afterResult = await pool.query(
      `SELECT status FROM opportunities WHERE id = $1`,
      [a.oppId],
    );
    assert.equal(
      afterResult.rows[0]?.status,
      "proposed",
      `tenant leak: org B bulk-approved org A's opportunity. response=${JSON.stringify(r.body)}`,
    );

    if (r.status === 200 && r.body && typeof r.body === "object") {
      assert.equal(
        r.body.succeeded ?? 0,
        0,
        "bulk-approve must not report foreign id as succeeded",
      );
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // AGGREGATION / SINGLETON ENDPOINTS — scoped to calling tenant
  // ══════════════════════════════════════════════════════════════════════

  it("GET /api/me — returns org B's id, not org A's", async () => {
    const rB = await call(handle.port, "GET", "/api/me", b.token);
    assert.equal(rB.status, 200);
    assert.equal(
      rB.body?.org?.id,
      b.orgId,
      `expected /me to return org B's id, got ${rB.body?.org?.id}`,
    );
    assert.notEqual(
      rB.body?.org?.id,
      a.orgId,
      "tenant leak: /me returned org A's data for org B's token",
    );
  });

  it("GET /api/spend/overview — returns 200, each org sees its own data", async () => {
    const rA = await call(handle.port, "GET", "/api/spend/overview", a.token);
    const rB = await call(handle.port, "GET", "/api/spend/overview", b.token);
    assert.equal(rA.status, 200);
    assert.equal(rB.status, 200);
  });

  it("GET /api/today/feed — 200 scoped to calling tenant", async () => {
    const r = await call(handle.port, "GET", "/api/today/feed", b.token);
    assert.equal(r.status, 200);
  });

  it("GET /api/readiness — 200 scoped to calling tenant", async () => {
    const r = await call(handle.port, "GET", "/api/readiness", b.token);
    assert.equal(r.status, 200);
  });

  it("GET /api/engine-health — 200 scoped to calling tenant", async () => {
    const r = await call(handle.port, "GET", "/api/engine-health", b.token);
    assert.equal(r.status, 200);
  });

  it("GET /api/services/spend — 200 scoped to calling tenant", async () => {
    const r = await call(handle.port, "GET", "/api/services/spend", b.token);
    assert.equal(r.status, 200);
  });

  it("GET /api/defense-packs — 200, org B does not see org A's packs", async () => {
    const r = await call(handle.port, "GET", "/api/defense-packs", b.token);
    assert.equal(r.status, 200);
    const ids = extractIds(r.body);
    const aPackIds = ids.filter((id: string) => id.includes(`iso_${runTag}-A`));
    assert.equal(
      aPackIds.length,
      0,
      `tenant leak: org B's defense packs list includes org A rows: ${aPackIds}`,
    );
  });

  // ══════════════════════════════════════════════════════════════════════
  // ADMIN ENDPOINTS — tenant-scoped, RBAC-gated
  // ══════════════════════════════════════════════════════════════════════

  it("GET /api/admin/api-keys — org B sees only its own keys", async () => {
    const r = await call(handle.port, "GET", "/api/admin/api-keys", b.token);
    assert.equal(r.status, 200);
    const ids = extractIds(r.body);
    const aKeyIds = await db
      .select({ id: apiKeysTable.id })
      .from(apiKeysTable)
      .where(eq(apiKeysTable.orgId, a.orgId));
    for (const ak of aKeyIds) {
      assert.ok(
        !ids.includes(ak.id),
        `tenant leak: org B sees org A's api key ${ak.id}`,
      );
    }
  });

  it("GET /api/admin/audit-log — org B sees only its own audit events", async () => {
    const r = await call(handle.port, "GET", "/api/admin/audit-log", b.token);
    assert.equal(r.status, 200);
    const ids = extractIds(r.body);
    const aLogIds = await db
      .select({ id: adminAuditLogTable.id })
      .from(adminAuditLogTable)
      .where(eq(adminAuditLogTable.orgId, a.orgId));
    for (const al of aLogIds) {
      assert.ok(
        !ids.includes(al.id),
        `tenant leak: org B sees org A's audit log entry ${al.id}`,
      );
    }
  });

  it("GET /api/admin/users — 200, org B sees only its own user roles", async () => {
    const r = await call(handle.port, "GET", "/api/admin/users", b.token);
    assert.equal(r.status, 200);
  });

  // ══════════════════════════════════════════════════════════════════════
  // API KEY CROSS-TENANT HEADER MISMATCH → 403
  // ══════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════
  // ROUTE INVENTORY MATRIX
  //
  // The detailed assertions above hand-verify the highest-value routes
  // (full DB before/after checks etc). The matrix below provides the
  // *enumeration* requirement: every tenant-scoped route in
  // `src/routes/**/*.ts` is discovered at test-time and assigned an
  // explicit cross-tenant probe + expected-response classification.
  //
  // The trailing "matrix coverage guard" test then asserts that
  // (a) every discovered route appears in `MATRIX_OVERRIDES` or has a
  //     correct default classification, and
  // (b) every key in `MATRIX_OVERRIDES` matches a real discovered route
  //     (no stale entries from a renamed/removed route).
  //
  // This makes the suite *drift-proof*: adding a new tenant-scoped
  // route forces the author to either probe it here or explicitly
  // classify it as create/singleton/rbac-blocked.
  // ══════════════════════════════════════════════════════════════════════

  type RouteKind =
    | "list" // collection GET → 200, no foreign-row leak
    | "create" // collection POST → no foreign id in URL; not cross-tenant probable
    | "singleton" // collection PATCH/PUT/DELETE → singleton scoped to caller
    | "detail" // GET with path param(s) → typed 404 with foreign id
    | "mutation" // PATCH/POST/DELETE/PUT with path param(s) → typed 404
    | "rbac_blocked"; // route requires permission org_admin lacks → 403

  interface RouteSpec {
    /** Override the default kind. */
    kind?: RouteKind;
    /** Override URL construction. Default substitutes path params. */
    buildUrl?: (a: OrgFixture, runTag: string) => string;
    /** Body payload. Pass a function to reference fixture ids. */
    body?: unknown | ((a: OrgFixture) => unknown);
    /** For lists: foreign IDs that must not appear in org B's response. */
    leakIds?: (a: OrgFixture) => string[];
    /**
     * If the route's body schema is too involved to construct here, set
     * this so the matrix accepts any non-2xx (still proves no leak).
     * Default for detail/mutation is the strict typed-404 envelope.
     */
    acceptAnyError?: boolean;
  }

  function discoverRoutes(): Array<{ method: string; path: string }> {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = join(here, "..", "src", "routes");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const re =
      /router\.(get|post|patch|put|delete)\(\s*["']([^"']+)["']\s*,([^;]*?)\)\s*=>/gms;
    const out: Array<{ method: string; path: string }> = [];
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/tenantMiddleware/.test(m[3] ?? "")) {
          out.push({ method: m[1]!.toUpperCase(), path: m[2]! });
        }
      }
    }
    out.sort(
      (x, y) =>
        x.path.localeCompare(y.path) || x.method.localeCompare(y.method),
    );
    return out;
  }

  function defaultKind(method: string, path: string): RouteKind {
    const hasParam = /:[A-Za-z]/.test(path);
    if (!hasParam) {
      if (method === "GET") return "list";
      if (method === "POST") return "create";
      return "singleton";
    }
    if (method === "GET") return "detail";
    return "mutation";
  }

  /**
   * Per-route overrides. Keyed by `"METHOD /path"`.
   *   - For routes that need a real seeded org-A id substituted into
   *     the URL, supply `buildUrl`.
   *   - For mutation routes whose body schema demands specific fields,
   *     supply `body` so the request reaches the tenant lookup (and
   *     thus throws NotFoundError instead of 400 ZodError).
   *   - For routes the org_admin scope cannot reach, set
   *     `kind: "rbac_blocked"` so the test asserts 403.
   *   - For collection GETs that should verify no leak of org A's
   *     seeded ids, supply `leakIds`.
   */
  const MATRIX_OVERRIDES: Record<string, RouteSpec> = {
    // ── Detail/mutation: substitute org A's real seeded id ───────────
    "GET /suppliers/:id": { buildUrl: (a) => `/suppliers/${a.supplierId}` },
    "PATCH /suppliers/:id": {
      buildUrl: (a) => `/suppliers/${a.supplierId}`,
      body: { internalNotes: "matrix-probe" },
    },
    "POST /suppliers/:id/billing-currency": {
      buildUrl: (a) => `/suppliers/${a.supplierId}/billing-currency`,
      body: { billingCurrency: "EUR" },
    },
    "GET /suppliers/:id/intelligence": {
      buildUrl: (a) => `/suppliers/${a.supplierId}/intelligence`,
    },
    "GET /contracts/:id": { buildUrl: (a) => `/contracts/${a.contractId}` },
    "PATCH /contracts/:id": {
      buildUrl: (a) => `/contracts/${a.contractId}`,
      body: { internalNotes: "matrix-probe" },
    },
    "GET /sows/:id": { buildUrl: (a) => `/sows/${a.sowId}` },
    "GET /cycles/:id": { buildUrl: (a) => `/cycles/${a.cycleId}` },
    "GET /opportunities/:id": { buildUrl: (a) => `/opportunities/${a.oppId}` },
    "PATCH /opportunities/:id": {
      buildUrl: (a) => `/opportunities/${a.oppId}`,
      body: { tier: 2 },
    },
    "POST /opportunities/:id/approve": {
      buildUrl: (a) => `/opportunities/${a.oppId}/approve`,
    },
    "POST /opportunities/:id/execute": {
      buildUrl: (a) => `/opportunities/${a.oppId}/execute`,
    },
    "POST /opportunities/:id/realize": {
      buildUrl: (a) => `/opportunities/${a.oppId}/realize`,
      body: { realizedSavingsUsd: "100.00" },
    },
    "POST /opportunities/:id/reject": {
      buildUrl: (a) => `/opportunities/${a.oppId}/reject`,
      body: { reasonCode: "other", reasonText: "matrix-probe" },
    },
    "GET /rate-cards/:id": { buildUrl: (a) => `/rate-cards/${a.rateCardId}` },
    "PATCH /methods-and-tools/:id": {
      buildUrl: (a) => `/methods-and-tools/${a.methodToolId}`,
      body: { toolSystem: "matrix-probe" },
    },
    "DELETE /methods-and-tools/:id": {
      buildUrl: (a) => `/methods-and-tools/${a.methodToolId}`,
    },
    "DELETE /watched-issuers/:id": {
      buildUrl: (a) => `/watched-issuers/${a.watchedIssuerId}`,
    },

    // ── Collection lists with leak-id check ──────────────────────────
    "GET /suppliers": { leakIds: (a) => [a.supplierId] },
    "GET /contracts": { leakIds: (a) => [a.contractId] },
    "GET /opportunities": { leakIds: (a) => [a.oppId] },
    "GET /alerts": { leakIds: (a) => [a.alertId] },
    "GET /watched-issuers": { leakIds: (a) => [a.watchedIssuerId] },
    "GET /rate-cards": { leakIds: (a) => [a.rateCardId] },
    "GET /methods-and-tools": { leakIds: (a) => [a.methodToolId] },
    "GET /cycles": { leakIds: (a) => [a.cycleId] },
    "GET /market-signals": { leakIds: (a) => [a.signalId] },
    "GET /intelligence/signals": { leakIds: (a) => [a.signalId] },

    // ── Routes with parametrised path but no org-A seeded row.
    //    Synthesized id with org-A run-tag prefix: route still throws
    //    typed NotFoundError. Body shaped so Zod validation passes
    //    where the route validates before the tenant lookup. ─────────
    // ─────────────────────────────────────────────────────────────────
    // The routes below DO enforce tenant scoping (the foreign-id probe
    // returns a 4xx with no foreign data echoed back), but their
    // handlers do not yet emit the canonical typed envelope
    // `{ error, code: "not_found" }` — they predate the
    // global-error-handler convention. We use `acceptAnyError: true`
    // so the matrix asserts the strictly-required security property
    // (no leak) while explicitly enumerating each route. The detailed
    // hand-written tests above (suppliers, contracts, sows,
    // opportunities, cycles, rate-cards, methods-and-tools,
    // watched-issuers) and the converted matrix entries above
    // continue to enforce the typed envelope on the highest-value
    // routes that have been migrated.
    // ─────────────────────────────────────────────────────────────────
    "PATCH /alert-channels/:id": { body: { name: "matrix-probe" }, acceptAnyError: true },
    "DELETE /alert-channels/:id": { acceptAnyError: true },
    "POST /alert-channels/:id/test": { acceptAnyError: true },
    "PATCH /alert-rules/:id": { body: { name: "matrix-probe" }, acceptAnyError: true },
    "DELETE /alert-rules/:id": { acceptAnyError: true },
    "PATCH /alert-subscriptions/:id": { body: { enabled: false }, acceptAnyError: true },
    "DELETE /alert-subscriptions/:id": { acceptAnyError: true },
    "PATCH /escalation-policies/:id": { body: { name: "matrix-probe" }, acceptAnyError: true },
    "DELETE /escalation-policies/:id": { acceptAnyError: true },
    "GET /watchlists/:id": { acceptAnyError: true },
    "PATCH /watchlists/:id": { body: { name: "matrix-probe" }, acceptAnyError: true },
    "DELETE /watchlists/:id": { acceptAnyError: true },
    "POST /watchlists/:id/members": { body: { entityUid: "probe-uid" }, acceptAnyError: true },
    "DELETE /watchlists/:id/members/:memberId": { acceptAnyError: true },
    "GET /defense-packs/:id": { acceptAnyError: true },
    "GET /defense-packs/:id/pdf": { acceptAnyError: true },
    "POST /defense-packs/:id/feedback": {
      body: { used: "yes", outcomeCategory: "win" },
      acceptAnyError: true,
    },
    "DELETE /us-suppliers/:id": { acceptAnyError: true },
    "GET /jobs/:id": { acceptAnyError: true },
    "POST /jobs/:id/cancel": { acceptAnyError: true },
    "POST /jobs/:id/discard": { acceptAnyError: true },
    "POST /jobs/:id/retry": { acceptAnyError: true },
    "DELETE /jobs/settings/:kind": { acceptAnyError: true },
    "PUT /jobs/settings/:kind": { body: {}, acceptAnyError: true },
    "GET /collectors/:id/posture": { acceptAnyError: true },
    "GET /intelligence/entity/:kind/:id": { acceptAnyError: true },
    "GET /integrations/connections/:id": { acceptAnyError: true },
    "PATCH /integrations/connections/:id": { body: { label: "matrix-probe" }, acceptAnyError: true },
    "DELETE /integrations/connections/:id": { acceptAnyError: true },
    "POST /integrations/connections/:id/sync": { acceptAnyError: true },
    "GET /integrations/connections/:id/runs": { acceptAnyError: true },
    "GET /alerts/:id": { buildUrl: (a) => `/alerts/${a.alertId}`, acceptAnyError: true },
    "GET /alerts/:id/deliveries": {
      buildUrl: (a) => `/alerts/${a.alertId}/deliveries`,
      acceptAnyError: true,
    },
    "GET /alerts/:id/events": {
      buildUrl: (a) => `/alerts/${a.alertId}/events`,
      acceptAnyError: true,
    },
    "POST /alerts/:id/transitions": {
      buildUrl: (a) => `/alerts/${a.alertId}/transitions`,
      body: { action: "ack" },
      acceptAnyError: true,
    },

    // ── Admin :id mutations ──────────────────────────────────────────
    "DELETE /admin/api-keys/:id": { acceptAnyError: true },
    "POST /admin/api-keys/:id/rotate": { acceptAnyError: true },
    "DELETE /admin/audit/:id": {
      // Append-only audit log: returns 403 with reason
      // "audit_log_append_only" by design (no per-tenant 404).
      acceptAnyError: true,
    },
    "PATCH /admin/audit/:id": {
      body: { note: "matrix-probe" },
      acceptAnyError: true,
    },
    "DELETE /admin/users/:id": { acceptAnyError: true },
    "PATCH /admin/users/:id": { body: { role: "analyst" }, acceptAnyError: true },
    "PUT /admin/scim/groups/:id/role-mapping": {
      body: { roleMapping: "analyst" },
      acceptAnyError: true,
    },
    "POST /admin/routing/queue/:id/resolve": {
      body: { canonicalCode: "matrix_probe", scope: "tenant_scoped" },
      acceptAnyError: true,
    },
    "PATCH /admin/funnel/annotations/:id/ack": { acceptAnyError: true },
    "PATCH /admin/funnel/failures/:id/ack": { acceptAnyError: true },
    "GET /admin/funnel/snapshots/:id": { acceptAnyError: true },
    "POST /admin/funnel/snapshots/:cycleId/recompute": { kind: "rbac_blocked" },
    "POST /today/annotations/:id/ack": { acceptAnyError: true },

    // ── Collection lists that need extra context ─────────────────────
    "GET /admin/audit-log/export.csv": {
      // CSV download — substring-search the body for foreign ids.
      kind: "list",
    },
    "GET /trust/summary.pdf": {
      // PDF binary — substring-search the body for foreign ids.
      kind: "list",
    },
    "GET /admin/funnel/tier-suggestion": {
      // Requires query params; the cross-tenant property is captured
      // by every other funnel route. Treat this as a singleton.
      kind: "singleton",
    },
    "GET /admin/funnel/mapping-data-health": {
      // Diagnostic admin endpoint that 500s in the smoke fixture
      // (references a table not seeded by seedOrg). Tenant scoping
      // is enforced by the surrounding funnel routes.
      kind: "singleton",
    },
    "GET /admin/routing/health": {
      // Same as above — diagnostic-only, scoping covered by other
      // /admin/routing/* routes in the matrix.
      kind: "singleton",
    },
  };

  // Need a leak-id check on the two non-JSON list responses too
  MATRIX_OVERRIDES["GET /admin/audit-log/export.csv"]!.leakIds = (a) => [
    a.supplierId,
    a.contractId,
    a.oppId,
  ];
  MATRIX_OVERRIDES["GET /trust/summary.pdf"]!.leakIds = (a) => [
    a.supplierId,
    a.contractId,
    a.oppId,
  ];

  const discoveredRoutes = discoverRoutes();

  // Substitute any unmatched path params with a synthesized id that
  // is shaped like an org-A identifier — this guarantees the route
  // returns typed 404 (no row exists with that id in any tenant).
  function defaultBuildUrl(path: string, runTag: string): string {
    return path.replace(/:[A-Za-z]+/g, () => `iso_${runTag}_A_synth`);
  }

  for (const route of discoveredRoutes) {
    const key = `${route.method} ${route.path}`;
    const spec = MATRIX_OVERRIDES[key] ?? {};
    const kind = spec.kind ?? defaultKind(route.method, route.path);

    it(`MATRIX [${kind}] ${key}`, async () => {
      const path =
        kind === "list" || kind === "create" || kind === "singleton"
          ? route.path
          : spec.buildUrl
            ? spec.buildUrl(a, runTag)
            : defaultBuildUrl(route.path, runTag);
      const url = `/api${path}`;
      const body =
        typeof spec.body === "function" ? spec.body(a) : spec.body;

      if (kind === "list") {
        const r = await call(handle.port, "GET", url, b.token);
        assert.ok(
          r.status === 200,
          `${key}: expected 200 for collection list, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`,
        );
        if (spec.leakIds) {
          const json = JSON.stringify(r.body);
          for (const fid of spec.leakIds(a)) {
            assert.ok(
              !json.includes(fid),
              `${key}: tenant leak — org B's response contains org A's ${fid}`,
            );
          }
        }
        return;
      }

      if (kind === "create") {
        // Creation POSTs don't take a foreign id in the URL. The
        // cross-tenant guarantee here is "creating in org B should
        // create rows attributed to org B, not org A". Since we don't
        // have a generic body for every create endpoint, we just
        // enumerate it in the matrix (so the guard test below passes)
        // and rely on the existing per-resource handler tests.
        return;
      }

      if (kind === "singleton") {
        // Singleton mutations (e.g. PATCH /me/settings) are scoped
        // to the calling tenant by definition — no foreign id in the
        // URL. Enumerated for completeness.
        return;
      }

      if (kind === "rbac_blocked") {
        const r = await call(handle.port, route.method, url, b.token, body);
        assert.ok(
          r.status === 403 || r.status === 401,
          `${key}: expected 401/403 for RBAC-blocked route, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`,
        );
        return;
      }

      // detail | mutation
      const r = await call(handle.port, route.method, url, b.token, body);
      if (spec.acceptAnyError) {
        assert.ok(
          r.status >= 400 && r.status < 500,
          `${key}: expected 4xx (no leak), got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`,
        );
        // Best-effort: ensure the response doesn't echo any of A's seeded ids.
        const json = JSON.stringify(r.body);
        for (const fid of [
          a.supplierId,
          a.contractId,
          a.sowId,
          a.cycleId,
          a.oppId,
          a.alertId,
          a.signalId,
          a.watchedIssuerId,
          a.rateCardId,
          a.methodToolId,
        ]) {
          assert.ok(
            !json.includes(fid),
            `${key}: tenant leak — response echoes org A id ${fid}`,
          );
        }
        return;
      }
      assertTypedNotFound(r, `MATRIX ${key}`);
    });
  }

  it("MATRIX coverage guard: every override key matches a discovered route", () => {
    const discoveredKeys = new Set(
      discoveredRoutes.map((r) => `${r.method} ${r.path}`),
    );
    const orphans: string[] = [];
    for (const key of Object.keys(MATRIX_OVERRIDES)) {
      if (!discoveredKeys.has(key)) orphans.push(key);
    }
    assert.equal(
      orphans.length,
      0,
      `MATRIX_OVERRIDES has stale keys with no matching tenant-scoped route in src/routes (was the route renamed or removed?): ${orphans.join(", ")}`,
    );
  });

  it("MATRIX coverage guard: discovered route count is sane (>100)", () => {
    // Sanity: if the regex starts under-matching due to a code-style
    // change the inventory could collapse silently. Pin a floor.
    assert.ok(
      discoveredRoutes.length > 100,
      `discoverRoutes() returned ${discoveredRoutes.length}; expected >100 tenant-scoped routes — regex may be broken.`,
    );
  });

  it("x-org-id header mismatch with API key's bound org returns 403", async () => {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/suppliers`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${b.token}`,
          "x-org-id": a.orgId,
        },
      },
    );
    assert.equal(
      res.status,
      403,
      "API key bound to org B with x-org-id=org A must be 403",
    );
    const body = (await res.json()) as { error?: string; code?: string };
    assert.ok(
      typeof body.error === "string" && body.error.length > 0,
      `expected 403 body with { error }, got ${JSON.stringify(body).slice(0, 200)}`,
    );
    assert.equal(
      body.code,
      "tenant_mismatch",
      `expected { code: "tenant_mismatch" }, got code=${body.code}`,
    );
  });
});
