/**
 * Integration tests for the four bulk opportunity action routes
 * shipped under task #220:
 *
 *   POST /api/opportunities/bulk-approve
 *   POST /api/opportunities/bulk-reject
 *   POST /api/opportunities/bulk-snooze
 *   POST /api/opportunities/bulk-unsnooze
 *
 * The contract (mirrored on the server-side `BulkOpportunityActionResult`
 * shape and pinned here so a refactor cannot regress it):
 *
 *   - The body is `{ ids: string[] }` (+ extras per action). `ids` is
 *     deduped server-side and capped at 1000. Oversized batches are
 *     rejected with 400.
 *   - Permission gating is `opp:approve` for every action. A
 *     `read_only` API key gets 403, even on a syntactically-valid
 *     batch. (Cross-tenant rows look identical to "doesn't exist" and
 *     fall into `skippedNoPermission` — covered below via a foreign
 *     row id.)
 *   - Eligible rows transition (UPDATE) and write exactly one row to
 *     the `decisions` audit table per affected row, with the right
 *     `event_type` and `actor`.
 *   - Snooze sets `snoozed_until` and writes a `snooze` decision; it
 *     does NOT change `status`.
 *   - Unsnooze clears `snoozed_until` (auto-unsnooze is the same SQL
 *     condition the list/today queries use, so a row whose
 *     `snoozed_until` is in the past is treated as un-snoozed without
 *     anyone calling unsnooze — pinned via the GET test).
 *   - Bulk reject requires `reasonCode`; the server validates against
 *     the closed `rejectionReasonCodes` enum.
 *   - The Today aggregator's `approvalsPending` excludes currently-
 *     snoozed rows from BOTH `pending` and `needsActionToday` so the
 *     operator's morning queue agrees with the visible feed.
 *
 * The test uses a real Postgres pool against `DATABASE_URL` and goes
 * through the full Express app (RBAC + tenant middleware), exactly
 * like `rbac-enforcement.test.ts`. Each test seeds an isolated org
 * tagged with a `RUN_TAG` and cleans up via `t.after`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
// We exercise both API-key auth (for the permission test) and the
// dev `x-org-id` header path (for the bulk happy-path tests). The
// auth modules each gate themselves on this env var — leave it ON
// so the dev-header path is available, and only the API-key tests
// need to send a real Bearer.
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import {
  db,
  pool,
  orgsTable,
  apiKeysTable,
  opportunitiesTable,
  decisionsTable,
  type UserRoleName,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../src/app";
import { generateToken } from "../src/lib/auth";
import { newId } from "../src/lib/ids";

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
  body: unknown;
}

async function call(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; orgId?: string; body?: unknown } = {},
): Promise<Resp> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.orgId) headers["x-org-id"] = opts.orgId;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

interface BulkResult {
  requested: number;
  succeeded: number;
  skippedNoPermission: number;
  skippedWrongStatus: number;
  failed: number;
  succeededIds: string[];
}

async function issueKey(
  orgId: string,
  scopeRole: UserRoleName,
): Promise<string> {
  const { plain, hash } = generateToken();
  await db.insert(apiKeysTable).values({
    id: newId("ak"),
    orgId,
    label: `bulk-opps-test-${scopeRole}-${Date.now()}`,
    prefix: plain.slice(0, 12),
    tokenHash: hash,
    scopeRole,
    createdBy: "bulk-opps-test@procuro.ai",
  });
  return plain;
}

interface SeedRow {
  id: string;
  status:
    | "proposed"
    | "approved"
    | "executing"
    | "realized"
    | "rejected"
    | "expired";
  snoozedUntil?: Date | null;
}

async function seedOrg(runTag: string, rows: SeedRow[]): Promise<{
  orgId: string;
  cycleId: string;
  ids: string[];
}> {
  const orgId = `org_${runTag}`;
  const cycleId = `cyc_${runTag}`;
  await db
    .insert(orgsTable)
    .values({ id: orgId, name: orgId, slug: orgId })
    .onConflictDoNothing();
  // Raw SQL on purpose: the test database in this workspace does not
  // have the post-#219 `signal_key` / `last_seen_at` columns yet
  // (alerts/funnel drift means we cannot run `drizzle-kit push`).
  // Hand-rolling the inserts lets the tests run against the live
  // schema without coupling to columns drizzle declares but the DB
  // doesn't have.
  await pool.query(
    `INSERT INTO analysis_cycles
       (id, org_id, generation, triggered_by, status, started_at, completed_at)
     VALUES ($1, $2, 1, 'test', 'completed', now(), now())`,
    [cycleId, orgId],
  );
  for (const r of rows) {
    await pool.query(
      `INSERT INTO opportunities (
         id, org_id, cycle_id, lever_id, tier, title,
         rationale, recommended_action,
         raw_projected_savings_usd, projected_savings_usd, confidence,
         inputs, status, snoozed_until
       )
       VALUES ($1,$2,$3,'supplier_consolidation',1,$4,
               'test','test',
               '100.00','100.00','0.5000',
               '{}'::jsonb, $5, $6)`,
      [r.id, orgId, cycleId, r.id, r.status, r.snoozedUntil ?? null],
    );
  }
  return { orgId, cycleId, ids: rows.map((r) => r.id) };
}

async function cleanupOrg(orgId: string): Promise<void> {
  // FK CASCADE on orgs deletes opportunities, decisions, cycles,
  // api_keys, etc. Wrap in try/catch so a failed seed doesn't mask
  // the real test failure.
  try {
    await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  } catch {
    // ignore
  }
}

async function loadDecisions(
  orgId: string,
  oppIds: string[],
): Promise<
  Array<{
    opportunityId: string;
    eventType: string;
    actor: string;
    rejectedReasonCode: string | null;
  }>
> {
  if (oppIds.length === 0) return [];
  const rows = await db
    .select({
      opportunityId: decisionsTable.opportunityId,
      eventType: decisionsTable.eventType,
      actor: decisionsTable.actor,
      rejectedReasonCode: decisionsTable.rejectedReasonCode,
    })
    .from(decisionsTable)
    .where(
      and(
        eq(decisionsTable.orgId, orgId),
        inArray(decisionsTable.opportunityId, oppIds),
      ),
    );
  return rows;
}

async function statusesById(
  orgId: string,
  ids: string[],
): Promise<Map<string, { status: string; snoozedUntil: Date | null }>> {
  const rows = await db
    .select({
      id: opportunitiesTable.id,
      status: opportunitiesTable.status,
      snoozedUntil: opportunitiesTable.snoozedUntil,
    })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.orgId, orgId),
        inArray(opportunitiesTable.id, ids),
      ),
    );
  return new Map(
    rows.map((r) => [r.id, { status: r.status, snoozedUntil: r.snoozedUntil }]),
  );
}

function assertDb(): void {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run bulk-opportunities tests");
  }
}

test("bulk-approve happy path: only proposed rows transition; one decision per affected", async (t) => {
  assertDb();
  const RUN = `bulk-approve-${Date.now()}-${process.pid}`;
  const seed = await seedOrg(RUN, [
    { id: `${RUN}-p1`, status: "proposed" },
    { id: `${RUN}-p2`, status: "proposed" },
    { id: `${RUN}-already-approved`, status: "approved" },
    { id: `${RUN}-rejected`, status: "rejected" },
  ]);
  const handle = await startServer();
  t.after(async () => {
    await handle.close();
    await cleanupOrg(seed.orgId);
  });

  const r = await call(handle.port, "POST", "/api/opportunities/bulk-approve", {
    orgId: seed.orgId,
    body: { ids: seed.ids, notes: "ship it" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const out = r.body as BulkResult;
  assert.equal(out.requested, 4);
  assert.equal(out.succeeded, 2, "only the two proposed rows succeed");
  assert.equal(out.skippedWrongStatus, 2, "approved + rejected are skipped");
  assert.equal(out.skippedNoPermission, 0);
  assert.equal(out.failed, 0);
  assert.deepEqual(
    [...out.succeededIds].sort(),
    [`${RUN}-p1`, `${RUN}-p2`].sort(),
  );

  const after = await statusesById(seed.orgId, seed.ids);
  assert.equal(after.get(`${RUN}-p1`)?.status, "approved");
  assert.equal(after.get(`${RUN}-p2`)?.status, "approved");
  assert.equal(after.get(`${RUN}-already-approved`)?.status, "approved");
  assert.equal(after.get(`${RUN}-rejected`)?.status, "rejected");

  const decisions = await loadDecisions(seed.orgId, seed.ids);
  // Exactly one decision row per affected opportunity, all `approve`.
  assert.equal(decisions.length, 2, "one decision per affected row");
  for (const d of decisions) {
    assert.equal(d.eventType, "approve");
    assert.equal(d.rejectedReasonCode, null);
  }
});

test("bulk-reject requires reasonCode and writes the reason on every decision", async (t) => {
  assertDb();
  const RUN = `bulk-reject-${Date.now()}-${process.pid}`;
  const seed = await seedOrg(RUN, [
    { id: `${RUN}-p1`, status: "proposed" },
    { id: `${RUN}-p2`, status: "proposed" },
    { id: `${RUN}-approved`, status: "approved" },
  ]);
  const handle = await startServer();
  t.after(async () => {
    await handle.close();
    await cleanupOrg(seed.orgId);
  });

  // (a) Missing reasonCode → 400 with field-level issue
  const bad = await call(
    handle.port,
    "POST",
    "/api/opportunities/bulk-reject",
    { orgId: seed.orgId, body: { ids: seed.ids } },
  );
  assert.equal(bad.status, 400, "missing reasonCode must 400");
  const badBody = bad.body as { error: string; details?: Array<{ path: unknown[] }> };
  assert.equal(badBody.error, "Invalid request");
  const paths = (badBody.details ?? []).map((d) => d.path.join("."));
  assert.ok(
    paths.includes("reasonCode"),
    `expected a reasonCode issue, got ${paths.join(", ")}`,
  );

  // (b) Happy path — `data_quality_issue` is a valid rejectionReasonCode
  const ok = await call(handle.port, "POST", "/api/opportunities/bulk-reject", {
    orgId: seed.orgId,
    body: {
      ids: seed.ids,
      reasonCode: "data_quality_issue",
      reasonText: "duplicate of opp-99",
    },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const out = ok.body as BulkResult;
  assert.equal(out.succeeded, 2);
  assert.equal(out.skippedWrongStatus, 1);

  const after = await statusesById(seed.orgId, seed.ids);
  assert.equal(after.get(`${RUN}-p1`)?.status, "rejected");
  assert.equal(after.get(`${RUN}-p2`)?.status, "rejected");
  assert.equal(after.get(`${RUN}-approved`)?.status, "approved");

  const decisions = await loadDecisions(seed.orgId, seed.ids);
  assert.equal(decisions.length, 2);
  for (const d of decisions) {
    assert.equal(d.eventType, "reject");
    assert.equal(d.rejectedReasonCode, "data_quality_issue");
  }
});

test("bulk-snooze sets snoozed_until without changing status; auto-unsnooze restores visibility on the list", async (t) => {
  assertDb();
  const RUN = `bulk-snooze-${Date.now()}-${process.pid}`;
  const seed = await seedOrg(RUN, [
    { id: `${RUN}-p1`, status: "proposed" },
    { id: `${RUN}-p2`, status: "proposed" },
    { id: `${RUN}-approved`, status: "approved" },
  ]);
  const handle = await startServer();
  t.after(async () => {
    await handle.close();
    await cleanupOrg(seed.orgId);
  });

  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const snooze = await call(
    handle.port,
    "POST",
    "/api/opportunities/bulk-snooze",
    {
      orgId: seed.orgId,
      body: { ids: seed.ids, snoozedUntil: future.toISOString() },
    },
  );
  assert.equal(snooze.status, 200, JSON.stringify(snooze.body));
  const out = snooze.body as BulkResult;
  assert.equal(out.succeeded, 2, "only proposed rows snooze");
  assert.equal(out.skippedWrongStatus, 1);

  const after = await statusesById(seed.orgId, seed.ids);
  // Snooze MUST NOT change status.
  assert.equal(after.get(`${RUN}-p1`)?.status, "proposed");
  assert.equal(after.get(`${RUN}-p2`)?.status, "proposed");
  assert.ok(after.get(`${RUN}-p1`)?.snoozedUntil !== null);
  assert.ok(after.get(`${RUN}-p2`)?.snoozedUntil !== null);

  // One snooze decision per affected.
  const decisions = await loadDecisions(seed.orgId, seed.ids);
  assert.equal(decisions.length, 2);
  for (const d of decisions) assert.equal(d.eventType, "snooze");

  // GET /opportunities defaults to snoozed=exclude and must hide both.
  const defaultList = await call(
    handle.port,
    "GET",
    `/api/opportunities?status=proposed`,
    { orgId: seed.orgId },
  );
  assert.equal(defaultList.status, 200);
  const defaultIds = ((defaultList.body as { items: Array<{ id: string }> })
    .items ?? []).map((o) => o.id);
  assert.ok(!defaultIds.includes(`${RUN}-p1`), "p1 hidden by snooze");
  assert.ok(!defaultIds.includes(`${RUN}-p2`), "p2 hidden by snooze");

  // snoozed=only must surface them.
  const onlyList = await call(
    handle.port,
    "GET",
    `/api/opportunities?status=proposed&snoozed=only`,
    { orgId: seed.orgId },
  );
  assert.equal(onlyList.status, 200);
  const onlyIds = ((onlyList.body as { items: Array<{ id: string }> }).items ?? [])
    .map((o) => o.id);
  assert.ok(onlyIds.includes(`${RUN}-p1`));
  assert.ok(onlyIds.includes(`${RUN}-p2`));

  // Auto-unsnooze: backdate snoozed_until on p1 and assert it
  // re-appears on the default list WITHOUT calling /unsnooze.
  await db
    .update(opportunitiesTable)
    .set({ snoozedUntil: new Date(Date.now() - 60_000) })
    .where(eq(opportunitiesTable.id, `${RUN}-p1`));
  const refreshed = await call(
    handle.port,
    "GET",
    `/api/opportunities?status=proposed`,
    { orgId: seed.orgId },
  );
  const refreshedIds = ((refreshed.body as { items: Array<{ id: string }> })
    .items ?? []).map((o) => o.id);
  assert.ok(
    refreshedIds.includes(`${RUN}-p1`),
    "row with past snoozed_until must auto-reappear on default list",
  );
  assert.ok(
    !refreshedIds.includes(`${RUN}-p2`),
    "row with future snoozed_until stays hidden",
  );

  // Explicit bulk-unsnooze on p2 clears snoozed_until and writes
  // an `unsnooze` decision.
  const unsnooze = await call(
    handle.port,
    "POST",
    "/api/opportunities/bulk-unsnooze",
    { orgId: seed.orgId, body: { ids: [`${RUN}-p2`] } },
  );
  assert.equal(unsnooze.status, 200, JSON.stringify(unsnooze.body));
  const unsOut = unsnooze.body as BulkResult;
  assert.equal(unsOut.succeeded, 1);
  const afterUns = await statusesById(seed.orgId, [`${RUN}-p2`]);
  assert.equal(afterUns.get(`${RUN}-p2`)?.snoozedUntil, null);
  const allDecisions = await loadDecisions(seed.orgId, [`${RUN}-p2`]);
  assert.ok(allDecisions.some((d) => d.eventType === "unsnooze"));
});

test("bulk-snooze validates snoozedUntil: past dates are rejected", async (t) => {
  assertDb();
  const RUN = `bulk-snooze-validation-${Date.now()}-${process.pid}`;
  const seed = await seedOrg(RUN, [{ id: `${RUN}-p1`, status: "proposed" }]);
  const handle = await startServer();
  t.after(async () => {
    await handle.close();
    await cleanupOrg(seed.orgId);
  });

  const past = new Date(Date.now() - 60_000).toISOString();
  const r = await call(
    handle.port,
    "POST",
    "/api/opportunities/bulk-snooze",
    { orgId: seed.orgId, body: { ids: seed.ids, snoozedUntil: past } },
  );
  assert.equal(r.status, 400);
  const body = r.body as { error: string; details?: Array<{ path: unknown[] }> };
  assert.equal(body.error, "Invalid request");
  const paths = (body.details ?? []).map((d) => d.path.join("."));
  assert.ok(paths.includes("snoozedUntil"));
});

test("bulk routes reject oversized batches (>1000 ids) with 400", async (t) => {
  assertDb();
  const RUN = `bulk-oversize-${Date.now()}-${process.pid}`;
  const seed = await seedOrg(RUN, [{ id: `${RUN}-p1`, status: "proposed" }]);
  const handle = await startServer();
  t.after(async () => {
    await handle.close();
    await cleanupOrg(seed.orgId);
  });

  const tooMany = Array.from({ length: 1001 }, (_, i) => `${RUN}-fake-${i}`);
  const r = await call(handle.port, "POST", "/api/opportunities/bulk-approve", {
    orgId: seed.orgId,
    body: { ids: tooMany },
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  const body = r.body as { error: string; details?: Array<{ path: unknown[] }> };
  assert.equal(body.error, "Invalid request");
  const paths = (body.details ?? []).map((d) => d.path.join("."));
  assert.ok(paths.includes("ids"));
});

test("bulk routes treat foreign-tenant ids as skippedNoPermission (no enumeration leak)", async (t) => {
  assertDb();
  const RUN = `bulk-cross-tenant-${Date.now()}-${process.pid}`;
  // Caller's tenant
  const mine = await seedOrg(`${RUN}-mine`, [
    { id: `${RUN}-mine-p1`, status: "proposed" },
  ]);
  // Foreign tenant the caller has no access to
  const other = await seedOrg(`${RUN}-other`, [
    { id: `${RUN}-other-p1`, status: "proposed" },
  ]);
  const handle = await startServer();
  t.after(async () => {
    await handle.close();
    await cleanupOrg(mine.orgId);
    await cleanupOrg(other.orgId);
  });

  const r = await call(handle.port, "POST", "/api/opportunities/bulk-approve", {
    orgId: mine.orgId,
    body: { ids: [`${RUN}-mine-p1`, `${RUN}-other-p1`, `${RUN}-nonexistent`] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const out = r.body as BulkResult;
  assert.equal(out.requested, 3);
  assert.equal(out.succeeded, 1);
  assert.equal(
    out.skippedNoPermission,
    2,
    "cross-tenant + missing ids both look like 'no perm'",
  );

  // The foreign tenant's row MUST be untouched.
  const foreign = await statusesById(other.orgId, [`${RUN}-other-p1`]);
  assert.equal(foreign.get(`${RUN}-other-p1`)?.status, "proposed");
});

test("read_only API key cannot call bulk-approve, bulk-reject, bulk-snooze, or bulk-unsnooze (403)", async (t) => {
  assertDb();
  const RUN = `bulk-perm-${Date.now()}-${process.pid}`;
  const seed = await seedOrg(RUN, [{ id: `${RUN}-p1`, status: "proposed" }]);
  // The API key path is gated by the dev-header path being OFF for
  // the duration of these requests. Since `ALLOW_DEV_TENANT_HEADER`
  // is read at module load and we cannot toggle it per-request, we
  // simply omit the dev header — the auth chain falls through to
  // the API key, and the API key alone determines the role.
  const token = await issueKey(seed.orgId, "read_only");
  const handle = await startServer();
  t.after(async () => {
    await handle.close();
    await cleanupOrg(seed.orgId);
  });

  for (const path of [
    "/api/opportunities/bulk-approve",
    "/api/opportunities/bulk-reject",
    "/api/opportunities/bulk-snooze",
    "/api/opportunities/bulk-unsnooze",
  ]) {
    const body =
      path.endsWith("bulk-reject")
        ? { ids: seed.ids, reasonCode: "savings_overstated" }
        : path.endsWith("bulk-snooze")
          ? {
              ids: seed.ids,
              snoozedUntil: new Date(
                Date.now() + 24 * 60 * 60 * 1000,
              ).toISOString(),
            }
          : { ids: seed.ids };
    const r = await call(handle.port, "POST", path, { token, body });
    assert.equal(r.status, 403, `${path} must 403 for read_only, got ${r.status}: ${JSON.stringify(r.body)}`);
    const obj = r.body as { error?: string; required?: string[] };
    assert.ok(obj.required?.includes("opp:approve"));
  }

  // The proposed row must still be untouched after the denied calls.
  const after = await statusesById(seed.orgId, seed.ids);
  assert.equal(after.get(`${RUN}-p1`)?.status, "proposed");
  assert.equal(after.get(`${RUN}-p1`)?.snoozedUntil, null);
  // No decisions row should have been written.
  const decisions = await loadDecisions(seed.orgId, seed.ids);
  assert.equal(decisions.length, 0);
});

test("Today /feed: snoozed proposed rows are excluded from pending AND needsActionToday", async (t) => {
  assertDb();
  const RUN = `today-snooze-${Date.now()}-${process.pid}`;
  // Seed 3 proposed rows. We'll snooze two (a fresh + a stale row)
  // and leave one fresh row visible. The Today aggregator must:
  //   - count `pending`             = 1 (just the visible row)
  //   - count `needsActionToday`    = 1 (just the visible row)
  // even though 3 rows are physically `proposed`.
  const seed = await seedOrg(RUN, [
    { id: `${RUN}-fresh-visible`, status: "proposed" },
    { id: `${RUN}-fresh-snoozed`, status: "proposed" },
    { id: `${RUN}-stale-snoozed`, status: "proposed" },
  ]);
  const handle = await startServer();
  t.after(async () => {
    await handle.close();
    await cleanupOrg(seed.orgId);
  });

  // Backdate the stale row past the 7d soft deadline so it would
  // count toward `needsActionToday` if not snoozed — that's the
  // case the snooze gate must hide. Raw SQL avoids the drizzle
  // column-list (signal_key drift) and uses the pool directly.
  await pool.query(
    `UPDATE opportunities SET created_at = now() - interval '30 days' WHERE id = $1`,
    [`${RUN}-stale-snoozed`],
  );

  // Snooze the two snoozed rows for 7 days.
  const snooze = await call(
    handle.port,
    "POST",
    "/api/opportunities/bulk-snooze",
    {
      orgId: seed.orgId,
      body: {
        ids: [`${RUN}-fresh-snoozed`, `${RUN}-stale-snoozed`],
        snoozedUntil: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    },
  );
  assert.equal(snooze.status, 200);

  const r = await call(handle.port, "GET", "/api/today/feed", {
    orgId: seed.orgId,
  });
  assert.equal(r.status, 200);
  const body = r.body as {
    items: Array<{
      kind: string;
      payload: { pending?: number; needsActionToday?: number };
    }>;
  };
  const approvals = body.items.find((i) => i.kind === "approvals.pending");
  assert.ok(approvals, "approvals.pending item must be present");
  assert.equal(
    approvals!.payload.pending,
    1,
    "snoozed rows must be excluded from `pending`",
  );
  assert.equal(
    approvals!.payload.needsActionToday,
    1,
    "snoozed rows must be excluded from `needsActionToday`",
  );
});

test.after(async () => {
  await pool.end();
});
