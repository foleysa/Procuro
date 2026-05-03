/**
 * Integration test for the Platform Admin "Broadcast posture" action:
 *   POST /api/admin/collectors/:id/broadcast-posture
 *
 * This route is the highest-blast-radius admin action in the product —
 * it iterates every org in the system in a single transaction, upserts
 * (or clears) per-tenant opt-in rows, and writes one audit row per
 * tenant. Because a partial broadcast would leave the fleet in an
 * inconsistent posture, the contract is intentionally narrow:
 *
 *   1. Only callers presenting the platform-admin token may invoke it.
 *      Without the token (when the env var is set) the route returns
 *      403 and writes no rows.
 *   2. A `tenantOptedIn: true` broadcast upserts an opt-in row for
 *      every org and writes one `tenant_opt_in_broadcast` audit row
 *      per tenant with `tenantOptedIn: true` in the metadata.
 *   3. A `tenantOptedIn: false` broadcast updates the existing rows
 *      (rather than producing duplicates) and again writes one audit
 *      row per tenant with `tenantOptedIn: false`.
 *   4. A `tenantOptedIn: null` broadcast DELETES the override rows
 *      (so resolution falls back to `tenantOptInDefault`) — leaving no
 *      stale 0/1 rows behind — and writes one audit row per tenant
 *      with `tenantOptedIn: null`.
 *   5. A failure mid-transaction rolls back atomically: no opt-in row
 *      changes and no audit rows are visible after the route returns.
 *
 * The test boots the real Express app in-process so the route +
 * middleware chain matches production. Assertions are scoped to a
 * unique-per-run collector id so that orgs (and audit rows) created by
 * other tests in the same DB don't pollute the counts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
delete process.env["PLATFORM_ADMIN_TOKEN"];

import {
  db,
  collectorsTable,
  collectorAuditLogTable,
  collectorTenantOptInsTable,
  orgsTable,
} from "@workspace/db";
import { and, eq, count, desc } from "drizzle-orm";
import app from "../src/app";
import {
  registerCollector,
  upsertCollectorRegistration,
  approveCollector,
  disableCollector,
} from "../src/lib/intelligence/runtime";
import {
  defaultStableSignalKey,
  looseSignalDraftSchema,
} from "../src/lib/intelligence/contractHelpers";
import type { IntelligenceCollector } from "../src/lib/intelligence/collector";

const RUN = `${Date.now()}-${process.pid}`;
const COLLECTOR_ID = `bp-test-${RUN}`;
const ORG_IDS = [
  `bp-test-org-a-${RUN}`,
  `bp-test-org-b-${RUN}`,
  `bp-test-org-c-${RUN}`,
];

function makeCollector(): IntelligenceCollector {
  return {
    id: COLLECTOR_ID,
    name: `Broadcast Posture Test Collector ${RUN}`,
    description: "Throw-away collector for broadcast-posture admin test.",
    posture: "public-api",
    sourceUrl: `https://example.test/${COLLECTOR_ID}`,
    defaultRateLimitRpm: 60,
    defaultScheduleCron: null,
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "US",
    retentionDays: 365,
    tenantOptInDefault: false,
    signalSchema: looseSignalDraftSchema,
    stableSignalKey(d) {
      return defaultStableSignalKey(COLLECTOR_ID, d);
    },
    async collect() {
      return [];
    },
  };
}

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to bind server");
  }
  try {
    return await fn(addr.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface JsonRes<T> {
  status: number;
  body: T;
}

async function postBroadcast<T = unknown>(
  port: number,
  collectorId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonRes<T>> {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/admin/collectors/${collectorId}/broadcast-posture`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as T) : ({} as T),
  };
}

async function countAuditRows(): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, COLLECTOR_ID),
        eq(collectorAuditLogTable.event, "tenant_opt_in_broadcast"),
      ),
    );
  return Number(row?.c ?? 0);
}

async function countOptInRows(): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(collectorTenantOptInsTable)
    .where(eq(collectorTenantOptInsTable.collectorId, COLLECTOR_ID));
  return Number(row?.c ?? 0);
}

async function loadOptInsForOurOrgs(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      orgId: collectorTenantOptInsTable.orgId,
      optedIn: collectorTenantOptInsTable.optedIn,
    })
    .from(collectorTenantOptInsTable)
    .where(eq(collectorTenantOptInsTable.collectorId, COLLECTOR_ID));
  const m = new Map<string, number>();
  for (const r of rows) {
    if (ORG_IDS.includes(r.orgId)) m.set(r.orgId, r.optedIn);
  }
  return m;
}

async function totalOrgCount(): Promise<number> {
  const [row] = await db.select({ c: count() }).from(orgsTable);
  return Number(row?.c ?? 0);
}

test("admin broadcast-posture: end-to-end fleet-wide opt-in flow", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  registerCollector(makeCollector());

  await upsertCollectorRegistration({
    id: COLLECTOR_ID,
    name: `Broadcast Posture Test Collector ${RUN}`,
    description: "Throw-away collector for broadcast-posture admin test.",
    posture: "public-api",
    owner: "tests",
    sourceUrl: `https://example.test/${COLLECTOR_ID}`,
    rateLimitRpm: 60,
    scheduleCron: null,
    notes: null,
    actor: "tests",
  });
  await approveCollector(COLLECTOR_ID, "tests");

  // Insert our test orgs. The route iterates EVERY org in the orgs
  // table, so other tests' orgs (and the seed data) will also receive
  // rows — we always assert by counting opt-in rows scoped to our
  // unique collector id, not by inspecting every org.
  await db.insert(orgsTable).values(
    ORG_IDS.map((id, i) => ({
      id,
      name: `Broadcast Posture Test Org ${i} ${RUN}`,
      slug: `${id}`,
    })),
  );

  t.after(async () => {
    try {
      // Drop opt-in + audit rows for our collector across every tenant
      // (the broadcast tests below write rows for orgs we don't own).
      await db
        .delete(collectorTenantOptInsTable)
        .where(eq(collectorTenantOptInsTable.collectorId, COLLECTOR_ID));
      await db
        .delete(collectorAuditLogTable)
        .where(eq(collectorAuditLogTable.collectorId, COLLECTOR_ID));
      await disableCollector(COLLECTOR_ID, "tests", "rejected");
      // Drop our test orgs (cascades clean up anything we missed).
      for (const orgId of ORG_IDS) {
        await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
      }
    } catch (err) {
      console.error("[cleanup] broadcast-posture cleanup failed:", err);
    }
  });

  // Capture a lower-bound tenant count. Other tests may add orgs
  // concurrently so we treat this as a minimum, not an exact value.
  const expectedTenants = await totalOrgCount();
  assert.ok(
    expectedTenants >= ORG_IDS.length,
    `expected at least ${ORG_IDS.length} orgs in DB, got ${expectedTenants}`,
  );

  await withServer(async (port) => {
    // -------------------------------------------------------------------
    // 1) Auth: with PLATFORM_ADMIN_TOKEN set, requests without (or with
    //    the wrong) token must return 403 and must NOT mutate any rows.
    // -------------------------------------------------------------------
    const beforeAuthOptIns = await countOptInRows();
    const beforeAuthAudits = await countAuditRows();

    const previousToken = process.env["PLATFORM_ADMIN_TOKEN"];
    process.env["PLATFORM_ADMIN_TOKEN"] = "broadcast-test-secret";
    try {
      const noToken = await postBroadcast(port, COLLECTOR_ID, {
        tenantOptedIn: true,
      });
      assert.equal(noToken.status, 403, "missing token must be rejected");

      const wrongToken = await postBroadcast(
        port,
        COLLECTOR_ID,
        { tenantOptedIn: true },
        { "x-platform-admin-token": "definitely-wrong" },
      );
      assert.equal(wrongToken.status, 403, "wrong token must be rejected");

      assert.equal(
        await countOptInRows(),
        beforeAuthOptIns,
        "rejected requests must not write opt-in rows",
      );
      assert.equal(
        await countAuditRows(),
        beforeAuthAudits,
        "rejected requests must not write audit rows",
      );
    } finally {
      if (previousToken === undefined) {
        delete process.env["PLATFORM_ADMIN_TOKEN"];
      } else {
        process.env["PLATFORM_ADMIN_TOKEN"] = previousToken;
      }
    }

    // -------------------------------------------------------------------
    // 2) 404: unknown collector id must be rejected before any writes.
    // -------------------------------------------------------------------
    const unknownBefore = await countAuditRows();
    const unknown = await postBroadcast(port, `does-not-exist-${RUN}`, {
      tenantOptedIn: true,
    });
    assert.equal(unknown.status, 404);
    assert.equal(
      await countAuditRows(),
      unknownBefore,
      "404 path must not write audit rows",
    );

    // -------------------------------------------------------------------
    // 3) Validation: malformed body returns 400, no writes.
    // -------------------------------------------------------------------
    const badBefore = await countAuditRows();
    const bad = await postBroadcast(port, COLLECTOR_ID, {
      // tenantOptedIn must be boolean | null
      tenantOptedIn: "yes",
    });
    assert.equal(bad.status, 400);
    assert.equal(
      await countAuditRows(),
      badBefore,
      "400 path must not write audit rows",
    );

    // -------------------------------------------------------------------
    // 4) Force-opt-in (tenantOptedIn: true). Every org gets an opt-in
    //    row with optedIn=1 and one audit row each.
    //
    //    NOTE: We use the actual `tenantsAffected` from the response
    //    (not `expectedTenants`) for all row-count assertions because
    //    other tests may add orgs concurrently between when we captured
    //    `expectedTenants` and when the broadcast runs.
    // -------------------------------------------------------------------
    const optInRes = await postBroadcast<{
      id: string;
      tenantOptedIn: boolean | null;
      tenantsAffected: number;
    }>(port, COLLECTOR_ID, {
      tenantOptedIn: true,
      reason: "vendor flipped to public-api",
    });
    assert.equal(optInRes.status, 200);
    assert.equal(optInRes.body.id, COLLECTOR_ID);
    assert.equal(optInRes.body.tenantOptedIn, true);
    assert.ok(
      optInRes.body.tenantsAffected >= ORG_IDS.length,
      `tenantsAffected (${optInRes.body.tenantsAffected}) should be >= ${ORG_IDS.length} (our test orgs)`,
    );
    const n1 = optInRes.body.tenantsAffected;
    assert.equal(
      await countOptInRows(),
      n1,
      "every org gets an opt-in row after force-opt-in",
    );
    assert.equal(
      await countAuditRows(),
      n1,
      "exactly one audit row per tenant after force-opt-in",
    );
    let optIns = await loadOptInsForOurOrgs();
    assert.equal(optIns.size, ORG_IDS.length, "all our orgs got rows");
    for (const orgId of ORG_IDS) {
      assert.equal(optIns.get(orgId), 1, `${orgId} optedIn=1`);
    }

    // -------------------------------------------------------------------
    // 5) Force-opt-out (tenantOptedIn: false). The previous rows must
    //    be UPDATED in place — every value flips to optedIn=0. Any orgs
    //    added since the opt-in also receive new rows (upsert semantics).
    //    A second audit row per tenant is written.
    // -------------------------------------------------------------------
    const optOutRes = await postBroadcast<{
      id: string;
      tenantOptedIn: boolean | null;
      tenantsAffected: number;
    }>(port, COLLECTOR_ID, {
      tenantOptedIn: false,
      reason: "ToS posture downgraded",
    });
    assert.equal(optOutRes.status, 200);
    assert.equal(optOutRes.body.tenantOptedIn, false);
    assert.ok(
      optOutRes.body.tenantsAffected >= n1,
      `opt-out tenantsAffected (${optOutRes.body.tenantsAffected}) should be >= opt-in count (${n1})`,
    );
    const n2 = optOutRes.body.tenantsAffected;
    assert.equal(
      await countOptInRows(),
      n2,
      "force-opt-out upserts rows for all current orgs (no duplicates per org)",
    );
    assert.equal(
      await countAuditRows(),
      n1 + n2,
      "second broadcast adds one more audit row per tenant",
    );
    optIns = await loadOptInsForOurOrgs();
    for (const orgId of ORG_IDS) {
      assert.equal(optIns.get(orgId), 0, `${orgId} optedIn=0`);
    }

    // -------------------------------------------------------------------
    // 6) Clear (tenantOptedIn: null). The override rows must be DELETED
    //    — not left behind as stale 0/1 values — so resolution falls
    //    back to the registry default. A third audit row per tenant is
    //    written, this time with `tenantOptedIn: null` in the metadata.
    // -------------------------------------------------------------------
    const clearRes = await postBroadcast<{
      id: string;
      tenantOptedIn: boolean | null;
      tenantsAffected: number;
    }>(port, COLLECTOR_ID, {
      tenantOptedIn: null,
      reason: "restore registry default",
    });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.body.tenantOptedIn, null);
    assert.ok(
      clearRes.body.tenantsAffected >= ORG_IDS.length,
      `clear tenantsAffected (${clearRes.body.tenantsAffected}) should be >= our test org count (${ORG_IDS.length})`,
    );
    const n3 = clearRes.body.tenantsAffected;
    assert.equal(
      await countOptInRows(),
      0,
      "clear deletes every override row, leaving no stale 0/1 rows behind",
    );
    assert.equal(
      await countAuditRows(),
      n1 + n2 + n3,
      "third broadcast adds one more audit row per tenant",
    );

    // Spot-check a metadata payload to confirm the clear was recorded
    // as `tenantOptedIn: null` (not silently coerced to false).
    // Sorting by `created_at` DESC and limiting to 1 deterministically
    // returns a row from the most recent broadcast — the `null` one —
    // regardless of which org was processed last.
    const [latestBroadcastAudit] = await db
      .select()
      .from(collectorAuditLogTable)
      .where(
        and(
          eq(collectorAuditLogTable.collectorId, COLLECTOR_ID),
          eq(collectorAuditLogTable.event, "tenant_opt_in_broadcast"),
        ),
      )
      .orderBy(desc(collectorAuditLogTable.createdAt))
      .limit(1);
    assert.ok(latestBroadcastAudit, "at least one audit row exists");
    const md = latestBroadcastAudit!.metadata as Record<string, unknown>;
    assert.equal(
      md["tenantOptedIn"],
      null,
      "latest broadcast metadata records tenantOptedIn:null (not coerced to false)",
    );
    assert.ok(
      typeof md["actor"] === "string" && (md["actor"] as string).length > 0,
      "audit row carries the actor email",
    );
    assert.ok(
      typeof md["orgId"] === "string",
      "audit row carries the affected orgId",
    );

    // -------------------------------------------------------------------
    // 7) Atomicity: a failure mid-transaction must roll back EVERY
    //    write — no opt-in changes, no audit rows. We monkey-patch
    //    `db.transaction` to throw after the first per-org insert pair
    //    so the rollback boundary is exercised on a real DB.
    // -------------------------------------------------------------------
    const optInsBeforeRollback = await countOptInRows();
    const auditsBeforeRollback = await countAuditRows();

    // We monkey-patch `db.transaction` for this assertion only. Drizzle
    // exposes a generic signature, so we anchor the patched function
    // against the exact type of the property being replaced — no `any`
    // and no eslint suppressions needed. The cast on the assignment
    // target is the smallest possible widening: we narrow to a single
    // mutable property because the imported `db` is otherwise readonly
    // by convention, then immediately restore the original in `finally`.
    type TxFn = typeof db.transaction;
    type TxCallback = Parameters<TxFn>[0];
    type Tx = Parameters<TxCallback>[0];
    const dbHandle = db as { transaction: TxFn };
    const originalTransaction: TxFn = db.transaction.bind(db);

    const patchedTransaction = (async <T>(
      cb: (tx: Tx) => Promise<T>,
      cfg?: Parameters<TxFn>[1],
    ): Promise<T> => {
      return originalTransaction(async (tx: Tx): Promise<T> => {
        // Wrap `tx` so the 3rd `.insert(...)` call (audit row for the
        // 2nd org) throws — guaranteeing both the opt-in upsert AND
        // the first org's audit row must roll back.
        let inserts = 0;
        const wrapped: Tx = new Proxy(tx, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop === "insert" && typeof value === "function") {
              const insertFn = value as Tx["insert"];
              return (table: Parameters<Tx["insert"]>[0]) => {
                inserts += 1;
                if (inserts === 3) {
                  throw new Error(
                    "simulated mid-transaction failure (test only)",
                  );
                }
                return insertFn.call(target, table);
              };
            }
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        }) as Tx;
        return cb(wrapped);
      }, cfg);
    }) as TxFn;
    dbHandle.transaction = patchedTransaction;

    let rollbackRes: JsonRes<{ error?: string }>;
    try {
      rollbackRes = await postBroadcast<{ error?: string }>(
        port,
        COLLECTOR_ID,
        { tenantOptedIn: true, reason: "this should fail" },
      );
    } finally {
      dbHandle.transaction = originalTransaction;
    }

    assert.equal(
      rollbackRes.status,
      500,
      "mid-transaction failure surfaces as 500",
    );
    assert.equal(
      await countOptInRows(),
      optInsBeforeRollback,
      "atomicity: opt-in rows unchanged after rollback",
    );
    assert.equal(
      await countAuditRows(),
      auditsBeforeRollback,
      "atomicity: audit rows unchanged after rollback",
    );

    // Sanity check: with the patch removed, a real broadcast still
    // works — proving the monkey-patch was fully reverted.
    const recoveryRes = await postBroadcast<{ tenantsAffected: number }>(
      port,
      COLLECTOR_ID,
      { tenantOptedIn: true },
    );
    assert.equal(recoveryRes.status, 200);
    assert.ok(
      recoveryRes.body.tenantsAffected >= expectedTenants,
      `recovery tenantsAffected (${recoveryRes.body.tenantsAffected}) should be >= ${expectedTenants}`,
    );
  });
});
