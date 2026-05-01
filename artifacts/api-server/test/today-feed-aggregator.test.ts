/**
 * #199 — Today aggregator fail-soft contract.
 *
 * Pins the response shape and the per-source failure semantics for the
 * `/api/today/feed` endpoint. The contract:
 *
 *   - Response is `{ items, partial, errors }` where `items` is an
 *     array of `{ kind, source, payload, occurredAt, severity }`.
 *   - Successful sources contribute one or more items.
 *   - A source that throws populates `errors[]` and DOES NOT short-circuit
 *     the response — sibling sources still run and contribute their items.
 *   - `partial` is `true` iff `errors.length > 0`.
 *
 * This contract is what lets the operator's daily-flow page degrade
 * gracefully when an upstream system is down. Breaking it would
 * silently take the operator's morning offline.
 *
 * Strategy: mount the route against a real Postgres pool, against an
 * org id we created in `before()`. The alerts query happens to be a
 * trivially-empty source for a brand-new org, so this also doubles as
 * a smoke test that the four sub-queries all execute.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";

// Allow the dev `x-org-id` header so we can drive the route without
// standing up a Clerk session or minting an API key. Must be set before
// the tenant middleware module is imported, since it reads NODE_ENV
// at evaluation time via `isProduction()`.
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

const { db, orgsTable, pool } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const todayRouter = (await import("../src/routes/today")).default;

const RUN = `t199-today-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const orgId = `org_${RUN}`;

let server: http.Server;
let baseUrl: string;

before(async () => {
  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} Today Test Org`,
    slug: RUN,
  });

  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: (...args: unknown[]) => void } }).log =
      { error: () => undefined };
    next();
  });
  app.use("/api", todayRouter);

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

test("/today/feed returns the discriminated-union shape with all six kinds", async () => {
  const r = await fetch(`${baseUrl}/api/today/feed`, {
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

  // All six kinds must be accounted for: present in `items` for a
  // healthy source, or surfaced in `errors[]` if the source failed.
  // There must be no silent gaps.
  const successfulKinds = new Set(body.items.map((i) => i.kind));
  const failedSources = new Set(body.errors.map((e) => e.source));
  const SOURCE_TO_KIND: Record<string, string> = {
    getAlertsSummary: "alerts.summary",
    listOpportunities: "opportunities.proposed",
    listJobs: "jobs.failed",
    approvalsPending: "approvals.pending",
    // Substrate sources added in #204. Both must either contribute an
    // item or surface in errors[] — no silent gaps allowed.
    funnelAutoAnnotations: "funnel.auto_annotations",
    funnelConversionDeltas: "funnel.conversion_deltas",
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
