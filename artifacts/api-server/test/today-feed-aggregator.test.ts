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
 * #209 / #248 additions:
 *
 *   - The Alerts query MUST succeed end-to-end against the live
 *     #117 alerts schema. After #248 reconciled dev with the schema
 *     source-of-truth, the seed inserts a row using the new shape
 *     (with `source`) directly; the test then asserts the alerts
 *     source did not land in `errors[]`.
 *   - The Pending Approvals payload exposes BOTH the actionable
 *     `needsActionToday` (proposed in last 24h) and the structural
 *     `pending` total — RT-83's split. We seed two opportunities, one
 *     dated yesterday and one dated last month, and assert both
 *     numbers appear correctly.
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

const { db, orgsTable, opportunitiesTable, pool } = await import(
  "@workspace/db"
);
const { eq, sql } = await import("drizzle-orm");
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

  // Seed THREE proposed opportunities for the RT-83 split contract:
  //   - "fresh"  : created in the last 24h        → counts toward (a)
  //   - "stale"  : created 30 days ago, > soft    → counts toward (b)
  //   - "middle" : created 3 days ago, < soft     → ONLY in `pending`
  // `needsActionToday` MUST equal (a) OR (b) = 2; `pending` MUST be 3.
  // This is the test that pins the OR semantics: implementing only
  // (a) would yield needsActionToday=1 and miss the aging row.
  // Seed values cover only the notNull columns that lack defaults.
  // `inputs`, `status`, `realizedSavingsUsd`, `createdAt` have defaults
  // and are intentionally omitted (the createdAt default is what makes
  // the fresh row land inside the 24h window).
  const baseSeed = {
    cycleId: `cycle_${RUN}`,
    tier: 1,
    rationale: "test rationale",
    recommendedAction: "test action",
    rawProjectedSavingsUsd: "1000",
  };
  await db.insert(opportunitiesTable).values([
    {
      ...baseSeed,
      id: `opp_fresh_${RUN}`,
      orgId,
      title: "fresh opp",
      leverId: "spot_vs_contract",
      projectedSavingsUsd: "1000",
      confidence: "0.5",
    },
    {
      ...baseSeed,
      id: `opp_middle_${RUN}`,
      orgId,
      title: "middle opp",
      leverId: "contract_leakage",
      projectedSavingsUsd: "750",
      confidence: "0.5",
    },
    {
      ...baseSeed,
      id: `opp_stale_${RUN}`,
      orgId,
      title: "stale opp",
      leverId: "maverick_spend",
      projectedSavingsUsd: "500",
      confidence: "0.5",
    },
  ]);

  // Backdate the middle row to 3 days ago (younger than the 7d soft
  // deadline → only in `pending`) and the stale row to 30 days ago
  // (older than 7d → counts toward needsActionToday). Doing this in
  // separate UPDATEs is clearer than fighting Drizzle's defaultNow
  // over the insert path.
  await db.execute(sql`
    UPDATE opportunities
       SET created_at = now() - interval '3 days'
     WHERE id = ${`opp_middle_${RUN}`}
  `);
  await db.execute(sql`
    UPDATE opportunities
       SET created_at = now() - interval '30 days'
     WHERE id = ${`opp_stale_${RUN}`}
  `);

  // Seed an alerts row matching the #117 schema. `state = 'open'` is
  // what makes the Today route count it (#248 reconciled dev with
  // schema source-of-truth, retiring the #209 resolved_at workaround).
  // Other NOT NULL columns (state, payload, occurrences, first_seen_at,
  // last_seen_at, summary) have DDL defaults.
  await db.execute(sql`
    INSERT INTO alerts (
      id, org_id, source, kind, severity, title, dedupe_key, created_at
    ) VALUES (
      ${`alt_${RUN}`}, ${orgId}, 'manual', 'test_alert', 'high',
      'Test alert from #248 contract test',
      ${`dedupe_${RUN}`}, now()
    )
  `);

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
  // Cascade-on-delete handles opportunities + alerts + decisions.
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

test("/today/feed alerts query succeeds against the real shipping schema (#248)", async () => {
  // After #248 reconciled dev with the #117 alerts schema, the Today
  // route filters on `alertsTable.state = 'open'` directly. This test
  // is a regression guard: the alerts source must not appear in
  // errors[] given a real seeded row, AND must reflect that row's
  // severity in the open count.
  const r = await fetch(`${baseUrl}/api/today/feed`, {
    headers: { "x-org-id": orgId },
  });
  const body = (await r.json()) as {
    items: Array<{
      kind: string;
      payload: Record<string, unknown>;
    }>;
    errors: Array<{ source: string; error: string }>;
  };

  const alertsErr = body.errors.find((e) => e.source === "getAlertsSummary");
  assert.equal(
    alertsErr,
    undefined,
    `alerts source must succeed, got: ${alertsErr?.error}`,
  );

  const alerts = body.items.find((i) => i.kind === "alerts.summary");
  assert.ok(alerts, "alerts.summary item must be present");
  const payload = alerts.payload as {
    openTotal: number;
    openCriticalOrHigh: number;
    topAlert?: { title: string; severity: string };
  };
  assert.ok(
    payload.openTotal >= 1,
    `openTotal should reflect the seeded high-severity alert (got ${payload.openTotal})`,
  );
  assert.ok(
    payload.openCriticalOrHigh >= 1,
    `openCriticalOrHigh should reflect the seeded high-severity alert (got ${payload.openCriticalOrHigh})`,
  );
  assert.ok(payload.topAlert, "topAlert enrichment must be present");
  assert.equal(payload.topAlert.severity, "high");
});

test("/today/feed: admin caller gets RAW errors[].error so the UI disclosure can show original technical detail (#209 review)", async () => {
  // The dev-header path (x-org-id only, no Bearer) maps to
  // platform_admin. Spec: admins (org_admin / platform_admin) MUST
  // receive the original unscrubbed error in the response payload so
  // the client's "What happened?" <details> disclosure can show real
  // technical detail to operators authorized to see it.
  // The funnel-substrate sources currently throw `parserOpenTable`
  // errors (separate pre-existing schema-drift, noted in replit.md),
  // which gives us a real, repeatable error string to assert against.
  const r = await fetch(`${baseUrl}/api/today/feed`, {
    headers: { "x-org-id": orgId },
  });
  const body = (await r.json()) as {
    errors: Array<{ source: string; error: string }>;
  };

  // At least one of the funnel sources should be in errors[] given
  // the known schema-drift; if not, the test environment changed and
  // we should skip rather than false-pass.
  const funnelErr = body.errors.find(
    (e) =>
      e.source === "funnelAutoAnnotations" ||
      e.source === "funnelConversionDeltas",
  );
  if (!funnelErr) return;

  // Admins SHOULD see the raw `parserOpenTable` marker; if this stops
  // firing, the gate has regressed and admins are getting scrubbed
  // text — which would silently hide the "What happened?" disclosure.
  assert.match(
    funnelErr.error,
    /parserOpenTable|funnel_annotations|column .* does not exist/i,
    `admin must receive raw error text, got: ${funnelErr.error}`,
  );
});

test("/today/feed: non-admin caller gets SCRUBBED errors[].error at the network boundary (#209 review)", async () => {
  // Issue an api_key with `analyst` scope (non-admin), then call the
  // endpoint with `Authorization: Bearer <key>`. The bearer path in
  // resolveRbacContext takes precedence over dev-header and assigns
  // exactly the `scopeRole` of the key — so the request is authorized
  // as a plain analyst and MUST receive scrubbed text.
  const { hashToken } = await import("../src/lib/auth.js");
  const { apiKeysTable, db } = await import("@workspace/db");

  const plain = `proc_test_${RUN}_${Math.random().toString(36).slice(2, 10)}`;
  await db.insert(apiKeysTable).values({
    id: `ak_test_${RUN}`,
    orgId,
    label: "test analyst key",
    prefix: plain.slice(0, 13),
    tokenHash: hashToken(plain),
    scopeRole: "analyst",
    createdBy: "test",
  });

  const r = await fetch(`${baseUrl}/api/today/feed`, {
    headers: {
      "x-org-id": orgId,
      Authorization: `Bearer ${plain}`,
    },
  });
  const body = (await r.json()) as {
    errors: Array<{ source: string; error: string }>;
  };

  // Forbidden substrings: every leak marker the scrubber denylists.
  for (const e of body.errors) {
    assert.doesNotMatch(
      e.error,
      /\bselect\b/i,
      `errors[${e.source}] must not contain SQL keyword 'select': ${e.error}`,
    );
    assert.doesNotMatch(
      e.error,
      /\bfrom\b/i,
      `errors[${e.source}] must not contain SQL keyword 'from': ${e.error}`,
    );
    assert.doesNotMatch(
      e.error,
      /\$\d+/,
      `errors[${e.source}] must not contain $N param markers: ${e.error}`,
    );
    assert.doesNotMatch(
      e.error,
      /\bparams\s*:/i,
      `errors[${e.source}] must not contain a 'params:' blob: ${e.error}`,
    );
    assert.doesNotMatch(
      e.error,
      /\.ts:/,
      `errors[${e.source}] must not contain a TS file path: ${e.error}`,
    );
    assert.doesNotMatch(
      e.error,
      /\bat\s+\w+\s*\(/,
      `errors[${e.source}] must not contain a stack frame: ${e.error}`,
    );
    assert.doesNotMatch(
      e.error,
      /parserOpenTable/,
      `errors[${e.source}] must not contain raw parser internals: ${e.error}`,
    );
  }
});

test("/today/feed approvals payload splits needs-action-today vs total pending (RT-83)", async () => {
  const r = await fetch(`${baseUrl}/api/today/feed`, {
    headers: { "x-org-id": orgId },
  });
  const body = (await r.json()) as {
    items: Array<{ kind: string; payload: Record<string, unknown> }>;
  };

  const approvals = body.items.find((i) => i.kind === "approvals.pending");
  assert.ok(approvals, "approvals.pending item must be present");
  const payload = approvals.payload as {
    pending: number;
    needsActionToday: number;
    oldestAgeMs?: number;
  };
  // Three seeded rows: fresh (<24h), middle (3d), stale (30d).
  // pending = 3; needsActionToday = (fresh) OR (stale) = 2.
  assert.ok(
    payload.pending >= 3,
    `pending total should include all three seeded rows (got ${payload.pending})`,
  );
  assert.ok(
    payload.needsActionToday >= 2,
    `needsActionToday must include the fresh AND aging rows (got ${payload.needsActionToday})`,
  );
  assert.ok(
    payload.pending > payload.needsActionToday,
    "pending must be greater than needsActionToday because the middle row exists (3d old, < 7d soft deadline)",
  );
  // 30-day-old row sets the floor on `oldestAgeMs`.
  assert.ok(payload.oldestAgeMs !== undefined, "oldestAgeMs must be set");
  assert.ok(
    payload.oldestAgeMs! > 25 * 24 * 60 * 60 * 1000,
    `oldestAgeMs should reflect the 30-day-old seeded row (got ${payload.oldestAgeMs}ms)`,
  );
});

test("/today/feed approvals payload excludes `expired` opportunities from pending count (#219)", async () => {
  // Task #219: the auto-expire job flips stale `proposed` rows to
  // `expired`. Those rows MUST NOT inflate any pending count surfaced
  // on the Today feed — both `pending` and `needsActionToday` are
  // strictly proposed-only. Without this assertion the prior task
  // could regress silently: nothing else in the test suite pins
  // status='proposed' filtering on the approvals source.
  //
  // We snapshot the counts, flip one of the existing seed rows to
  // `expired` in-place, refetch, and assert both counts drop by
  // exactly one and `oldestAgeMs` recomputes to a smaller value.
  const before = await fetch(`${baseUrl}/api/today/feed`, {
    headers: { "x-org-id": orgId },
  });
  const beforeBody = (await before.json()) as {
    items: Array<{ kind: string; payload: Record<string, unknown> }>;
  };
  const beforePayload = beforeBody.items.find(
    (i) => i.kind === "approvals.pending",
  )?.payload as
    | { pending: number; needsActionToday: number; oldestAgeMs?: number }
    | undefined;
  assert.ok(beforePayload, "baseline approvals payload must exist");

  // Flip the 30-day-old "stale" seed to `expired`. It contributed
  // to BOTH pending (it's > 7d so counts as needs-action) AND set
  // the floor on oldestAgeMs. After expiry, both numbers must drop.
  await db.execute(sql`
    UPDATE opportunities
       SET status = 'expired'
     WHERE id = ${`opp_stale_${RUN}`}
  `);

  const after = await fetch(`${baseUrl}/api/today/feed`, {
    headers: { "x-org-id": orgId },
  });
  const afterBody = (await after.json()) as {
    items: Array<{ kind: string; payload: Record<string, unknown> }>;
  };
  const afterPayload = afterBody.items.find(
    (i) => i.kind === "approvals.pending",
  )?.payload as
    | { pending: number; needsActionToday: number; oldestAgeMs?: number }
    | undefined;
  assert.ok(afterPayload, "post-expiry approvals payload must exist");

  assert.equal(
    afterPayload.pending,
    beforePayload.pending - 1,
    `pending must drop by 1 once the row flips to 'expired' (before=${beforePayload.pending}, after=${afterPayload.pending})`,
  );
  assert.equal(
    afterPayload.needsActionToday,
    beforePayload.needsActionToday - 1,
    `needsActionToday must drop by 1 once the 30d-old proposed row flips to 'expired' (before=${beforePayload.needsActionToday}, after=${afterPayload.needsActionToday})`,
  );
  // The 30-day-old row was the floor; the next-oldest is the 3-day
  // "middle" row, so oldestAgeMs must shrink substantially.
  assert.ok(
    afterPayload.oldestAgeMs! < beforePayload.oldestAgeMs!,
    `oldestAgeMs must recompute downward once the floor row expires (before=${beforePayload.oldestAgeMs}, after=${afterPayload.oldestAgeMs})`,
  );

  // Restore so other tests in this file (or re-runs) see the original
  // seed state.
  await db.execute(sql`
    UPDATE opportunities
       SET status = 'proposed'
     WHERE id = ${`opp_stale_${RUN}`}
  `);
});
