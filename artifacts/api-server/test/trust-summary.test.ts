/**
 * Tests for `GET /api/trust/summary` (task #121).
 *
 * The Trust Center is the primary self-serve security review surface,
 * so the contract is non-negotiable on three axes:
 *
 *  1. Tenant isolation — a key scoped to org A must never see counts
 *     drawn from org B (citation coverage, audit volume, opted-in
 *     collectors). This is the highest-stakes property of the page.
 *  2. Permission gate — every authenticated principal with `read`
 *     can fetch the summary; unauthenticated requests are rejected.
 *  3. Shape — the response carries the sections the page renders, in
 *     the format the OpenAPI spec promises. We pin the keys + a few
 *     invariant values rather than the absolute counts (which depend
 *     on the seeded fixture).
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
  opportunitiesTable,
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

async function pickOrgIds(): Promise<{ a: string; b?: string }> {
  const rows = await db.select({ id: orgsTable.id }).from(orgsTable).limit(2);
  if (rows.length === 0) throw new Error("No org seeded; cannot run trust tests");
  return { a: rows[0]!.id, b: rows[1]?.id };
}

async function issueKey(
  orgId: string,
  scopeRole: UserRoleName,
): Promise<string> {
  const { plain, hash } = generateToken();
  await db.insert(apiKeysTable).values({
    id: newId("ak"),
    orgId,
    label: `trust-test-${scopeRole}-${Date.now()}`,
    prefix: plain.slice(0, 12),
    tokenHash: hash,
    scopeRole,
    createdBy: "trust-test@procuro.ai",
  });
  return plain;
}

async function getSummary(
  port: number,
  token: string,
): Promise<{ status: number; body: TrustResponse | { error: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trust/summary`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as TrustResponse | { error: string }) : { error: "empty" },
  };
}

interface TrustResponse {
  generatedAt: string;
  tenant: { orgId: string; orgName: string; disclosurePolicy: string };
  dataSources: {
    enabledCount: number;
    totalCount: number;
    byTier: { T1: number; T2: number; T3: number; T4: number };
    collectors: Array<{ id: string; status: string; disclosureTier: string }>;
  };
  operationalControls: {
    killSwitch: { killedCount: number; killedCollectors: unknown[] };
    schemaDrift: { recentEventCount: number; recentEvents: unknown[] };
    retryBudgets: Array<{ kind: string; maxAttempts: number; defaultMaxAttempts: number; isOverride: boolean }>;
  };
  provenance: {
    opportunitiesTotal: number;
    opportunitiesWithCitations: number;
    opportunitiesUnverified: number;
    coveragePct: number;
  };
  audit: {
    retentionDays: number;
    eventCount30d: number;
    lastEventAt: string | null;
    exportFormats: string[];
  };
  identity: {
    sso: { enabled: boolean };
    scimEnabled: boolean;
    roles: Array<{ role: string; permissions: string[] }>;
  };
  compliance: {
    attestations: Array<{ name: string; status: string }>;
    securityContact: { email: string };
  };
}

test("GET /api/trust/summary returns the documented shape for a read_only key", async () => {
  const { a: orgId } = await pickOrgIds();
  const token = await issueKey(orgId, "read_only");
  const handle = await startServer();
  try {
    const r = await getSummary(handle.port, token);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as TrustResponse;

    // Top-level sections.
    for (const k of [
      "generatedAt",
      "tenant",
      "dataSources",
      "operationalControls",
      "provenance",
      "audit",
      "identity",
      "compliance",
    ] as const) {
      assert.ok(k in body, `missing key: ${k}`);
    }

    // Tenant context echoes the auth's orgId (no cross-tenant leak).
    assert.equal(body.tenant.orgId, orgId);
    assert.ok(body.tenant.orgName.length > 0);
    assert.ok(
      ["conservative", "standard", "analyst"].includes(
        body.tenant.disclosurePolicy,
      ),
      `unexpected disclosurePolicy: ${body.tenant.disclosurePolicy}`,
    );

    // dataSources counts add up.
    assert.ok(body.dataSources.totalCount >= body.dataSources.enabledCount);
    const tierSum =
      body.dataSources.byTier.T1 +
      body.dataSources.byTier.T2 +
      body.dataSources.byTier.T3 +
      body.dataSources.byTier.T4;
    assert.equal(tierSum, body.dataSources.enabledCount);
    // No collector visible to this tenant should be opted-out (the
    // route filters those out).
    for (const c of body.dataSources.collectors) {
      assert.ok(["enabled", "disabled", "killed"].includes(c.status));
      assert.ok(["T1", "T2", "T3", "T4"].includes(c.disclosureTier));
    }

    // retryBudgets cover the documented kinds.
    const kinds = body.operationalControls.retryBudgets.map((r) => r.kind);
    for (const expected of [
      "ingest_csv",
      "run_collector",
      "sync_erp_connection",
    ]) {
      assert.ok(
        kinds.includes(expected),
        `retryBudgets missing ${expected}; got ${kinds.join(",")}`,
      );
    }

    // Provenance arithmetic.
    assert.equal(
      body.provenance.opportunitiesUnverified,
      body.provenance.opportunitiesTotal -
        body.provenance.opportunitiesWithCitations,
    );
    assert.ok(body.provenance.coveragePct >= 0 && body.provenance.coveragePct <= 1);

    // Audit retention is positive.
    assert.ok(body.audit.retentionDays > 0);
    assert.ok(body.audit.exportFormats.includes("csv"));

    // Identity carries the full role catalogue (6 fixed roles).
    const roleNames = body.identity.roles.map((r) => r.role);
    for (const expected of [
      "platform_admin",
      "org_admin",
      "approver",
      "analyst",
      "read_only",
      "auditor",
    ]) {
      assert.ok(
        roleNames.includes(expected),
        `roles missing ${expected}; got ${roleNames.join(",")}`,
      );
    }

    // Compliance attestations + a security contact email.
    assert.ok(body.compliance.attestations.length >= 1);
    assert.ok(body.compliance.securityContact.email.includes("@"));
  } finally {
    await handle.close();
  }
});

test("GET /api/trust/summary requires authentication", async () => {
  const handle = await startServer();
  try {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/trust/summary`,
    );
    // The tenantMiddleware rejects unauthenticated requests with 401.
    assert.equal(
      res.status,
      401,
      `expected 401 for unauth, got ${res.status}`,
    );
  } finally {
    await handle.close();
  }
});

test("GET /api/trust/summary stays tenant-scoped (no cross-tenant leak)", async () => {
  const { a, b } = await pickOrgIds();
  if (!b) {
    // Skip when the seed only carries one org — the test still
    // protects against a regression once a second tenant exists.
    return;
  }
  const tokenA = await issueKey(a, "read_only");
  const tokenB = await issueKey(b, "read_only");
  const handle = await startServer();
  try {
    const ra = (await getSummary(handle.port, tokenA)).body as TrustResponse;
    const rb = (await getSummary(handle.port, tokenB)).body as TrustResponse;
    assert.equal(ra.tenant.orgId, a);
    assert.equal(rb.tenant.orgId, b);
    // Provenance numbers must reflect only the calling tenant's
    // opportunities — verify by counting org A's opportunities
    // directly and comparing.
    const rowsA = await db
      .select({ id: opportunitiesTable.id })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.orgId, a));
    assert.equal(
      ra.provenance.opportunitiesTotal,
      rowsA.length,
      `opportunity count mismatch: route returned ${ra.provenance.opportunitiesTotal}, db has ${rowsA.length}`,
    );
    // And tenant B's count must be independent (proves no leak).
    const rowsB = await db
      .select({ id: opportunitiesTable.id })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.orgId, b));
    assert.equal(
      rb.provenance.opportunitiesTotal,
      rowsB.length,
      `tenant B opportunity count mismatch: route returned ${rb.provenance.opportunitiesTotal}, db has ${rowsB.length}`,
    );
  } finally {
    await handle.close();
  }
});
