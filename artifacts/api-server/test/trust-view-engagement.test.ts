/**
 * Tests for the Trust Center engagement signal (task #169).
 *
 * Two contracts are pinned here:
 *
 *  1. Every `GET /api/trust/summary` writes a `trust.view` row to
 *     `admin_audit_log`, deduped per (orgId, actor) inside a 5-minute
 *     window. A reviewer reloading the page must not flood the log,
 *     but a *different* viewer must always be counted.
 *  2. `GET /api/admin/trust-engagement` aggregates those rows into the
 *     30-day view count, distinct-viewer count, last-view timestamp,
 *     and last-viewer email — scoped strictly to the calling tenant.
 *
 * The fixture seeds rows directly into `admin_audit_log` for the
 * aggregation test rather than spamming `/trust/summary`, both for
 * speed and so we can dial-in stale (>30 day) and cross-tenant
 * fixtures the route is supposed to ignore.
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
  type UserRoleName,
} from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import app from "../src/app";
import { generateToken } from "../src/lib/auth";
import { newId } from "../src/lib/ids";

interface Handle {
  port: number;
  close: () => Promise<void>;
}

async function startServer(): Promise<Handle> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Could not bind ephemeral port");
  }
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((r) => server.close(() => r())),
  };
}

async function pickOrgIds(): Promise<{ a: string; b?: string }> {
  const rows = await db.select({ id: orgsTable.id }).from(orgsTable).limit(2);
  if (rows.length === 0) throw new Error("No org seeded");
  return { a: rows[0]!.id, b: rows[1]?.id };
}

async function issueKey(
  orgId: string,
  scopeRole: UserRoleName,
  label: string,
): Promise<string> {
  const { plain, hash } = generateToken();
  await db.insert(apiKeysTable).values({
    id: newId("ak"),
    orgId,
    label,
    prefix: plain.slice(0, 12),
    tokenHash: hash,
    scopeRole,
    createdBy: "trust-engagement-test@procuro.ai",
  });
  return plain;
}

async function countTrustViews(
  orgId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ id: adminAuditLogTable.id })
    .from(adminAuditLogTable)
    .where(
      and(
        eq(adminAuditLogTable.orgId, orgId),
        eq(adminAuditLogTable.action, "trust.view"),
        gte(adminAuditLogTable.createdAt, since),
      ),
    );
  return rows.length;
}

interface EngagementResponse {
  windowDays: number;
  viewCount30d: number;
  distinctViewers30d: number;
  lastViewAt: string | null;
  lastViewer: string | null;
}

test("/trust/summary writes a trust.view audit row, deduped per actor inside 5 minutes", async () => {
  const { a: orgId } = await pickOrgIds();
  const tokenAlice = await issueKey(orgId, "read_only", "trust-dedupe-alice");
  const tokenBob = await issueKey(orgId, "read_only", "trust-dedupe-bob");
  const handle = await startServer();
  const start = new Date();
  try {
    // Alice fetches the trust summary three times in quick succession.
    // The first should record a `trust.view`; the next two are within
    // the 5-minute dedupe window and must be collapsed.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/trust/summary`,
        { headers: { authorization: `Bearer ${tokenAlice}` } },
      );
      assert.equal(res.status, 200, `alice call ${i + 1}: status`);
      // Drain the body so the server closes the response cleanly
      // before we issue the next call.
      await res.text();
    }
    const aliceCount = await countTrustViews(orgId, start);
    assert.equal(
      aliceCount,
      1,
      `expected dedupe to collapse alice's 3 views into 1, got ${aliceCount}`,
    );

    // Bob is a *different* actor: his view must be recorded even
    // though Alice already viewed inside the same 5-minute window.
    const resBob = await fetch(
      `http://127.0.0.1:${handle.port}/api/trust/summary`,
      { headers: { authorization: `Bearer ${tokenBob}` } },
    );
    assert.equal(resBob.status, 200, "bob call: status");
    await resBob.text();

    const totalCount = await countTrustViews(orgId, start);
    assert.equal(
      totalCount,
      2,
      `expected 2 distinct-actor views, got ${totalCount}`,
    );

    // The two recorded rows must carry distinct actor strings.
    const recorded = await db
      .select({ actor: adminAuditLogTable.actor })
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, orgId),
          eq(adminAuditLogTable.action, "trust.view"),
          gte(adminAuditLogTable.createdAt, start),
        ),
      );
    const actors = new Set(recorded.map((r) => r.actor));
    assert.equal(
      actors.size,
      2,
      `expected 2 distinct actors recorded, got ${actors.size} (${[...actors].join(",")})`,
    );
  } finally {
    await handle.close();
    // Clean up so reruns of the test don't accumulate fixtures.
    await db
      .delete(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, orgId),
          eq(adminAuditLogTable.action, "trust.view"),
          gte(adminAuditLogTable.createdAt, start),
        ),
      );
  }
});

test("/admin/trust-engagement aggregates the last 30 days, scoped to the active tenant", async () => {
  const { a, b } = await pickOrgIds();
  if (!b) {
    // Skip when only one org is seeded — the cross-tenant assertion
    // below cannot run without a second tenant. The dedupe test
    // above still covers the recording path.
    return;
  }

  // Wipe any existing trust.view rows for both tenants so prior
  // runs (or the dedupe test above) cannot pollute the counts.
  for (const id of [a, b]) {
    await db
      .delete(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, id),
          eq(adminAuditLogTable.action, "trust.view"),
        ),
      );
  }

  // Seed three rows directly: two distinct actors inside the 30-day
  // window for org A, plus one stale (>30d) row that the route must
  // ignore. Org B gets a single row that the route must NOT include
  // when the caller is org A.
  const now = new Date();
  const recentA1 = new Date(now.getTime() - 60 * 1000); // 1 min ago
  const recentA2 = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
  const staleA = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000); // 40d ago
  const recentB = new Date(now.getTime() - 30 * 60 * 1000); // 30 min ago

  const seedIds = [
    newId("aud"),
    newId("aud"),
    newId("aud"),
    newId("aud"),
  ];
  await db.insert(adminAuditLogTable).values([
    {
      id: seedIds[0]!,
      orgId: a,
      actor: "alice@procuro.ai",
      action: "trust.view",
      targetId: a,
      targetLabel: "Org A",
      metadata: {},
      createdAt: recentA2,
    },
    {
      id: seedIds[1]!,
      orgId: a,
      actor: "bob@procuro.ai",
      action: "trust.view",
      targetId: a,
      targetLabel: "Org A",
      metadata: {},
      createdAt: recentA1,
    },
    {
      id: seedIds[2]!,
      orgId: a,
      actor: "carol@procuro.ai",
      action: "trust.view",
      targetId: a,
      targetLabel: "Org A",
      metadata: {},
      createdAt: staleA,
    },
    {
      id: seedIds[3]!,
      orgId: b,
      actor: "dave@procuro.ai",
      action: "trust.view",
      targetId: b,
      targetLabel: "Org B",
      metadata: {},
      createdAt: recentB,
    },
  ]);

  const tokenA = await issueKey(a, "auditor", "trust-engagement-a");
  const tokenB = await issueKey(b, "auditor", "trust-engagement-b");
  const handle = await startServer();
  try {
    // Org A: must see only its own two recent views, with bob (most
    // recent) as the lastViewer. The stale carol row must not count.
    const resA = await fetch(
      `http://127.0.0.1:${handle.port}/api/admin/trust-engagement`,
      { headers: { authorization: `Bearer ${tokenA}` } },
    );
    assert.equal(resA.status, 200, "engagement A: status");
    const bodyA = (await resA.json()) as EngagementResponse;
    assert.equal(bodyA.windowDays, 30, "windowDays");
    assert.equal(
      bodyA.viewCount30d,
      2,
      `org A viewCount30d: expected 2 (recent only), got ${bodyA.viewCount30d}`,
    );
    assert.equal(
      bodyA.distinctViewers30d,
      2,
      `org A distinctViewers30d: expected 2, got ${bodyA.distinctViewers30d}`,
    );
    // The route returns the most recent view across *all* time, not
    // just the 30-day window — but the most recent for org A is bob
    // either way (1 min ago beats 40d-ago carol).
    assert.equal(
      bodyA.lastViewer,
      "bob@procuro.ai",
      `org A lastViewer: expected bob, got ${bodyA.lastViewer}`,
    );
    assert.ok(
      bodyA.lastViewAt && new Date(bodyA.lastViewAt).getTime() > 0,
      "org A lastViewAt should be set",
    );

    // Org B: must see only dave; counts must be 1/1, lastViewer dave.
    // This is the cross-tenant isolation check.
    const resB = await fetch(
      `http://127.0.0.1:${handle.port}/api/admin/trust-engagement`,
      { headers: { authorization: `Bearer ${tokenB}` } },
    );
    assert.equal(resB.status, 200, "engagement B: status");
    const bodyB = (await resB.json()) as EngagementResponse;
    assert.equal(
      bodyB.viewCount30d,
      1,
      `org B viewCount30d: expected 1, got ${bodyB.viewCount30d}`,
    );
    assert.equal(
      bodyB.distinctViewers30d,
      1,
      `org B distinctViewers30d: expected 1, got ${bodyB.distinctViewers30d}`,
    );
    assert.equal(
      bodyB.lastViewer,
      "dave@procuro.ai",
      `org B lastViewer: expected dave, got ${bodyB.lastViewer}`,
    );
  } finally {
    await handle.close();
    await db
      .delete(adminAuditLogTable)
      .where(eq(adminAuditLogTable.id, seedIds[0]!));
    await db
      .delete(adminAuditLogTable)
      .where(eq(adminAuditLogTable.id, seedIds[1]!));
    await db
      .delete(adminAuditLogTable)
      .where(eq(adminAuditLogTable.id, seedIds[2]!));
    await db
      .delete(adminAuditLogTable)
      .where(eq(adminAuditLogTable.id, seedIds[3]!));
  }
});

test("/admin/trust-engagement reports zeroes for a tenant with no views", async () => {
  const { a } = await pickOrgIds();
  // Wipe any existing trust.view rows for this tenant so we get a
  // clean slate. Other tests in this file clean up after themselves;
  // belt-and-braces here makes the assertion deterministic regardless
  // of test ordering.
  await db
    .delete(adminAuditLogTable)
    .where(
      and(
        eq(adminAuditLogTable.orgId, a),
        eq(adminAuditLogTable.action, "trust.view"),
      ),
    );

  const token = await issueKey(a, "auditor", "trust-engagement-empty");
  const handle = await startServer();
  try {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/admin/trust-engagement`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as EngagementResponse;
    assert.equal(body.windowDays, 30);
    assert.equal(body.viewCount30d, 0);
    assert.equal(body.distinctViewers30d, 0);
    assert.equal(body.lastViewAt, null);
    assert.equal(body.lastViewer, null);
  } finally {
    await handle.close();
  }
});

test("/admin/trust-engagement requires the audit:read permission", async () => {
  const { a } = await pickOrgIds();
  // `read_only` keys carry only `read`, not `audit:read`, so the
  // permission gate must reject them with 403.
  const token = await issueKey(a, "read_only", "trust-engagement-readonly");
  const handle = await startServer();
  try {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/admin/trust-engagement`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(
      res.status,
      403,
      `expected 403 for read_only, got ${res.status}`,
    );
  } finally {
    await handle.close();
  }
});
