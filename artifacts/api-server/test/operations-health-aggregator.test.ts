/**
 * #199 — Operations health aggregator fail-soft contract + admin gating.
 *
 * Pins three things that, if regressed, hurt the operator's ability to
 * trust the daily-flow page or open up an authz hole:
 *
 *   1. The response shape is `{ items, partial, errors }` matching the
 *      Today aggregator (so the frontend renders both with one
 *      reducer).
 *   2. Each successful source contributes at least one item; a failing
 *      source populates `errors[]` and DOES NOT short-circuit the rest.
 *   3. The endpoint is gated to org_admin / platform_admin — non-admin
 *      authenticated users receive 403, not the payload.
 *
 * Strategy: provision two test users in the same org, one with
 * org_admin role and one with read_only. Drive the route via Clerk-
 * style auth shim by patching `getAuth` is too invasive — instead we
 * use the API-keys path via the `apiKeysTable` (cleanly tested in
 * other suites). For role gating we seed a key bound to a role.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

const { db, orgsTable, apiKeysTable, pool } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const operationsRouter = (await import("../src/routes/operations")).default;

const RUN = `t199-ops-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const orgId = `org_${RUN}`;
const adminToken = `tok_admin_${RUN}`;
const readonlyToken = `tok_ro_${RUN}`;

let server: http.Server;
let baseUrl: string;

function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

before(async () => {
  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} Ops Test Org`,
    slug: RUN,
  });
  await db.insert(apiKeysTable).values([
    {
      id: `apk_${RUN}_a`,
      orgId,
      label: `${RUN}-admin`,
      prefix: adminToken.slice(0, 12),
      tokenHash: hashToken(adminToken),
      scopeRole: "org_admin",
      createdBy: "test@procuro.ai",
    },
    {
      id: `apk_${RUN}_r`,
      orgId,
      label: `${RUN}-readonly`,
      prefix: readonlyToken.slice(0, 12),
      tokenHash: hashToken(readonlyToken),
      scopeRole: "read_only",
      createdBy: "test@procuro.ai",
    },
  ]);

  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: (...args: unknown[]) => void } }).log =
      { error: () => undefined };
    next();
  });
  app.use("/api", operationsRouter);

  server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await db.delete(apiKeysTable).where(eq(apiKeysTable.orgId, orgId));
  await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  await pool.end();
});

test("/operations/health: admin gets the discriminated-union shape", async () => {
  const r = await fetch(`${baseUrl}/api/operations/health`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    items: Array<{
      kind: string;
      source: string;
      payload: Record<string, unknown>;
      occurredAt: string;
      severity: string;
    }>;
    partial: boolean;
    errors: Array<{ source: string; error: string }>;
  };

  assert.ok(Array.isArray(body.items));
  assert.equal(typeof body.partial, "boolean");
  assert.ok(Array.isArray(body.errors));

  for (const item of body.items) {
    assert.equal(typeof item.kind, "string");
    assert.equal(typeof item.source, "string");
    assert.ok(["info", "warn", "error"].includes(item.severity));
  }

  // Every declared source must either contribute an item or appear in
  // `errors[]`. No silent gaps — that's the operator-trust contract.
  const SOURCE_TO_KIND: Record<string, string> = {
    listCollectors: "collectors.summary",
    listJobs: "jobs.summary",
    listDataSources: "data_sources.summary",
    listIntegrations: "integrations.summary",
    funnelSnapshotFailures: "funnel.failures",
  };
  const successKinds = new Set(body.items.map((i) => i.kind));
  const failedSources = new Set(body.errors.map((e) => e.source));
  for (const [source, kind] of Object.entries(SOURCE_TO_KIND)) {
    assert.ok(
      successKinds.has(kind) || failedSources.has(source),
      `source ${source} (kind ${kind}) must contribute an item or appear in errors[]`,
    );
  }

  assert.equal(body.partial, body.errors.length > 0);
});

test("/operations/health: non-admin (read_only) gets 403, not the payload", async () => {
  const r = await fetch(`${baseUrl}/api/operations/health`, {
    headers: { authorization: `Bearer ${readonlyToken}` },
  });
  assert.equal(
    r.status,
    403,
    "Operations health must not be reachable by non-admin authenticated users",
  );
  const text = await r.text();
  // Defense-in-depth: even if the status was wrong, the body must not
  // contain the operational signal payload (we look for one of the
  // five known kinds).
  for (const kind of [
    "collectors.summary",
    "jobs.summary",
    "data_sources.summary",
    "integrations.summary",
    "funnel.failures",
  ]) {
    assert.ok(
      !text.includes(kind),
      `403 response body must not leak operations payload (${kind})`,
    );
  }
});

