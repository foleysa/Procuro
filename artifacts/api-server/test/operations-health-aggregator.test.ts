/**
 * #199 — Operations health aggregator fail-soft contract.
 *
 * Mirrors `today-feed-aggregator.test.ts`. Pins the response shape and
 * the per-source failure semantics for the `/api/operations/health`
 * endpoint. The contract:
 *
 *   - Response is `{ items, partial, errors }` where `items` is an
 *     array of `{ kind, source, payload, occurredAt, severity }`.
 *   - Successful sources contribute one or more items.
 *   - A source that throws populates `errors[]` and DOES NOT short-circuit
 *     the response — sibling sources still run and contribute their items.
 *   - `partial` is `true` iff `errors.length > 0`.
 *
 * The Operations page is the operator's go-to view when something
 * breaks; a silent contract drift here would hide outages from the
 * very people who need to see them. Pin the contract so a regression
 * has to declare itself loudly.
 *
 * Strategy: mount the route against a real Postgres pool, against an
 * org id we created in `before()`. For a brand-new org all five sources
 * resolve to trivially-empty rollups, so this also doubles as a smoke
 * test that all five sub-queries actually execute.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";

// Allow the dev `x-org-id` header so we can drive the route without
// standing up a Clerk session or minting an API key. Must be set before
// the tenant middleware module is imported, since it reads NODE_ENV
// at evaluation time via `isProduction()`. The dev-header path also
// grants `platform_admin` via `resolveRbacContext`, which satisfies
// the `requireRole("org_admin", "platform_admin")` gate on this route.
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

const { db, orgsTable, pool } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const operationsRouter = (await import("../src/routes/operations")).default;

const RUN = `t199-ops-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const orgId = `org_${RUN}`;

let server: http.Server;
let baseUrl: string;

before(async () => {
  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} Operations Test Org`,
    slug: RUN,
  });

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
  await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  await pool.end();
});

test("/operations/health returns the discriminated-union shape with all five kinds", async () => {
  const r = await fetch(`${baseUrl}/api/operations/health`, {
    headers: { "x-org-id": orgId },
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

  // Shape is the contract the UI relies on; pin it.
  assert.ok(Array.isArray(body.items), "items must be an array");
  assert.equal(typeof body.partial, "boolean");
  assert.ok(Array.isArray(body.errors), "errors must be an array");

  for (const item of body.items) {
    assert.equal(typeof item.kind, "string");
    assert.equal(typeof item.source, "string");
    assert.equal(typeof item.occurredAt, "string");
    assert.ok(["info", "warn", "error"].includes(item.severity));
    assert.equal(typeof item.payload, "object");
  }

  // The five kinds must all be present for a healthy org. If any one
  // fails the corresponding source must show up in `errors[]` —
  // there must be no silent gaps.
  const successfulKinds = new Set(body.items.map((i) => i.kind));
  const failedSources = new Set(body.errors.map((e) => e.source));
  const SOURCE_TO_KIND: Record<string, string> = {
    listCollectors: "collectors.summary",
    listJobs: "jobs.summary",
    listDataSources: "data_sources.summary",
    listIntegrations: "integrations.summary",
    funnelSnapshotFailures: "funnel.failures",
  };
  for (const [source, kind] of Object.entries(SOURCE_TO_KIND)) {
    const succeeded = successfulKinds.has(kind);
    const failed = failedSources.has(source);
    assert.ok(
      succeeded || failed,
      `source ${source} (kind ${kind}) must either contribute an item or be present in errors[]`,
    );
  }

  // partial = true iff there is at least one error.
  assert.equal(body.partial, body.errors.length > 0);
});
