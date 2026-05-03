/**
 * #210 — Acknowledge / dismiss auto-annotations from the Today screen.
 *
 * Two contracts pinned here:
 *
 *   1. POST /today/annotations/:id/ack stamps `acked_by` / `acked_at`
 *      on the underlying funnel_annotations row, returns 200, and is
 *      tenant-scoped (a sibling org's row must surface as 404, never
 *      flip the timestamp).
 *
 *   2. After ack, `getRecentAutoAnnotations(orgId)` (the Today reader)
 *      filters the row out by default, but `{ includeAcked: true }`
 *      still returns it — so admin views that want the full history
 *      keep working.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

const {
  db,
  orgsTable,
  analysisCyclesTable,
  funnelSnapshotsTable,
  funnelAnnotationsTable,
  pool,
} = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const todayRouter = (await import("../src/routes/today")).default;
const { getRecentAutoAnnotations } = await import(
  "../src/lib/ooda/funnel"
);

const RUN = `t210-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const newId = (p: string) =>
  `${p}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;

let server: http.Server;
let baseUrl: string;
let orgId: string;
let otherOrgId: string;
let snapshotId: string;
let otherSnapshotId: string;
let annotationId: string;
let otherAnnotationId: string;

before(async () => {
  orgId = newId("org");
  otherOrgId = newId("org");
  await db.insert(orgsTable).values([
    { id: orgId, name: `${RUN} A`, slug: `${RUN}-a` },
    { id: otherOrgId, name: `${RUN} B`, slug: `${RUN}-b` },
  ]);

  const cycleId = newId("cyc");
  const otherCycleId = newId("cyc");
  await db.insert(analysisCyclesTable).values([
    {
      id: cycleId,
      orgId,
      generation: 1,
      triggeredBy: "test",
      status: "completed",
      completedAt: new Date(),
    },
    {
      id: otherCycleId,
      orgId: otherOrgId,
      generation: 1,
      triggeredBy: "test",
      status: "completed",
      completedAt: new Date(),
    },
  ]);

  snapshotId = newId("fnl");
  otherSnapshotId = newId("fnl");
  await db.insert(funnelSnapshotsTable).values([
    {
      id: snapshotId,
      orgId,
      cycleId,
      cycleGeneration: 1,
      stages: {},
      cohorts: {},
      calibration: {},
    },
    {
      id: otherSnapshotId,
      orgId: otherOrgId,
      cycleId: otherCycleId,
      cycleGeneration: 1,
      stages: {},
      cohorts: {},
      calibration: {},
    },
  ]);

  annotationId = newId("fnlann");
  otherAnnotationId = newId("fnlann");
  await db.insert(funnelAnnotationsTable).values([
    {
      id: annotationId,
      orgId,
      snapshotId,
      source: "auto",
      kind: "stage_drop",
      targetStage: "drafts_produced",
      summary: "drafts dropped 30%",
      detail: {},
    },
    {
      id: otherAnnotationId,
      orgId: otherOrgId,
      snapshotId: otherSnapshotId,
      source: "auto",
      kind: "stage_drop",
      summary: "sibling org row, must not be ack-able from orgId",
      detail: {},
    },
  ]);

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
  // FK cascade from orgs cleans up cycles/snapshots/annotations.
  await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  await db.delete(orgsTable).where(eq(orgsTable.id, otherOrgId));
  await pool.end();
});

test("ack stamps acked_by from req.rbac.userId / req.clerkUserId when an authenticated user is present", async () => {
  // Seed a fresh annotation to ack so the assertion isn't entangled
  // with the broader idempotency test below.
  const localId = newId("fnlann");
  await db.insert(funnelAnnotationsTable).values({
    id: localId,
    orgId,
    snapshotId,
    source: "auto",
    kind: "stage_drop",
    summary: "row used to verify ackedBy attribution",
    detail: {},
  });

  // Stand up a tiny app that injects an authenticated rbac context
  // before the route runs — emulating what `tenantMiddleware` +
  // `resolveRbacContext` would do for a real Clerk-signed request.
  const userIdActor = `user_${RUN}_actor`;
  const localApp = express();
  localApp.use(express.json());
  localApp.use((req, _res, next) => {
    (req as unknown as { log: { error: (...a: unknown[]) => void } }).log =
      { error: () => undefined };
    req.rbac = {
      orgId,
      userId: userIdActor,
      role: "owner",
      permissions: new Set<string>(),
      isOwner: true,
    } as unknown as NonNullable<typeof req.rbac>;
    req.clerkUserId = userIdActor;
    next();
  });
  localApp.use("/api", todayRouter);
  const localServer = http.createServer(localApp);
  await new Promise<void>((resolve) =>
    localServer.listen(0, "127.0.0.1", resolve),
  );
  try {
    const addr = localServer.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const r = await fetch(
      `http://127.0.0.1:${addr.port}/api/today/annotations/${localId}/ack`,
      { method: "POST", headers: { "x-org-id": orgId } },
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ackedBy: string | null };
    assert.equal(
      body.ackedBy,
      userIdActor,
      "ackedBy in response reflects authenticated user",
    );
    const [row] = await db
      .select({ ackedBy: funnelAnnotationsTable.ackedBy })
      .from(funnelAnnotationsTable)
      .where(eq(funnelAnnotationsTable.id, localId));
    assert.equal(
      row?.ackedBy,
      userIdActor,
      "ackedBy persisted on the row for audit attribution",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      localServer.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("POST /today/annotations/:id/ack stamps acked_at and returns 200", async () => {
  // Sanity: before ack, the reader includes the row.
  const beforeRows = await getRecentAutoAnnotations(orgId);
  assert.ok(
    beforeRows.some((r) => r.id === annotationId),
    "row visible before ack",
  );

  const r = await fetch(
    `${baseUrl}/api/today/annotations/${annotationId}/ack`,
    { method: "POST", headers: { "x-org-id": orgId } },
  );
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    id: string;
    ackedAt: string | null;
  };
  assert.equal(body.id, annotationId);
  assert.ok(body.ackedAt, "ackedAt populated in response");

  // The row in the DB now has a non-null acked_at.
  const [row] = await db
    .select({
      ackedAt: funnelAnnotationsTable.ackedAt,
    })
    .from(funnelAnnotationsTable)
    .where(eq(funnelAnnotationsTable.id, annotationId));
  assert.ok(row?.ackedAt, "row stamped with acked_at in db");
});

test("getRecentAutoAnnotations filters out acked rows by default and surfaces them with includeAcked", async () => {
  const defaultRows = await getRecentAutoAnnotations(orgId);
  assert.ok(
    !defaultRows.some((r) => r.id === annotationId),
    "acked row hidden from default Today reader",
  );

  const allRows = await getRecentAutoAnnotations(orgId, {
    includeAcked: true,
  });
  assert.ok(
    allRows.some((r) => r.id === annotationId),
    "acked row reappears with includeAcked: true",
  );
});

test("repeat ack is idempotent: returns 200 with the original ackedAt and does not bump the timestamp", async () => {
  const [before] = await db
    .select({ ackedAt: funnelAnnotationsTable.ackedAt })
    .from(funnelAnnotationsTable)
    .where(eq(funnelAnnotationsTable.id, annotationId));
  assert.ok(before?.ackedAt, "row was acked by an earlier test");
  const originalAckedAt = before.ackedAt.toISOString();

  // Wait a tick so a "wrong" implementation that re-stamps would be
  // observable (>=1ms drift in the column).
  await new Promise((r) => setTimeout(r, 10));

  const r = await fetch(
    `${baseUrl}/api/today/annotations/${annotationId}/ack`,
    { method: "POST", headers: { "x-org-id": orgId } },
  );
  assert.equal(r.status, 200);
  const body = (await r.json()) as { id: string; ackedAt: string | null };
  assert.equal(body.id, annotationId);
  assert.equal(
    body.ackedAt,
    originalAckedAt,
    "repeat ack returns the original timestamp",
  );

  const [after] = await db
    .select({ ackedAt: funnelAnnotationsTable.ackedAt })
    .from(funnelAnnotationsTable)
    .where(eq(funnelAnnotationsTable.id, annotationId));
  assert.equal(
    after?.ackedAt?.toISOString(),
    originalAckedAt,
    "row's acked_at column was not bumped by repeat ack",
  );
});

test("ack endpoint refuses non-auto annotations (operator notes) with 404", async () => {
  const operatorId = newId("fnlann");
  await db.insert(funnelAnnotationsTable).values({
    id: operatorId,
    orgId,
    snapshotId,
    source: "operator",
    kind: "operator_note",
    summary: "operator note, not ack-able from Today",
    detail: {},
  });

  const r = await fetch(
    `${baseUrl}/api/today/annotations/${operatorId}/ack`,
    { method: "POST", headers: { "x-org-id": orgId } },
  );
  assert.equal(r.status, 404);

  const [row] = await db
    .select({ ackedAt: funnelAnnotationsTable.ackedAt })
    .from(funnelAnnotationsTable)
    .where(eq(funnelAnnotationsTable.id, operatorId));
  assert.equal(row?.ackedAt, null, "operator note left untouched");
});

test("ack endpoint is tenant-scoped: cross-tenant id returns 404 and does NOT mutate the row", async () => {
  const r = await fetch(
    `${baseUrl}/api/today/annotations/${otherAnnotationId}/ack`,
    { method: "POST", headers: { "x-org-id": orgId } },
  );
  assert.equal(r.status, 404);

  const [row] = await db
    .select({ ackedAt: funnelAnnotationsTable.ackedAt })
    .from(funnelAnnotationsTable)
    .where(eq(funnelAnnotationsTable.id, otherAnnotationId));
  assert.equal(
    row?.ackedAt,
    null,
    "sibling-org row left untouched by cross-tenant ack",
  );
});
