/**
 * Integration tests for the renewal-alert engine + the contract HTTP
 * surface that consumes its output.
 *
 * The PATCH-body schema unit tests in `contracts-validation.test.ts`
 * cover Zod parsing, but the rest of the engine — `runRenewalAlertScanHandler`
 * (dedupe-key idempotency + threshold tracking) and the `GET /contracts`
 * derived-status filter / cursor pagination / `PATCH /contracts/:id`
 * audit-log writer — has historically only been smoke-tested by hand.
 *
 * These tests run against the real Postgres database so dedupe semantics
 * (`alerts_dedupe_uq` on `(org_id, dedupe_key)`), the JSONB audit-log
 * columns, and the SQL window in `runRenewalAlertScanHandler` are
 * exercised the same way the production worker exercises them.
 *
 * Test isolation:
 *   - Every row is namespaced under a per-run UUID prefix so concurrent
 *     test files (or parallel CI runs against the same dev DB) cannot
 *     trample each other.
 *   - We only ever assert about rows scoped to OUR tenant. The renewal
 *     scan is system-wide, so other tenants in the dev DB may have
 *     their own alerts inserted on the first run; we just assert that
 *     the SECOND run inserts zero new alerts (an invariant that holds
 *     regardless of what other tenants are present).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { and, eq } from "drizzle-orm";
import {
  db,
  orgsTable,
  suppliersTable,
  contractsTable,
  contractAuditLogTable,
  alertsTable,
  type JobRow,
} from "@workspace/db";
import app from "../src/app";
import { runRenewalAlertScanHandler } from "../src/lib/jobs/handlers";

const RUN = `t156-${randomUUID().replace(/-/g, "").slice(0, 10)}`;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 3600 * 1000);
}

let orgId: string;
let supplierId: string;
// Three active contracts inside the 90-day renewal window (used for
// both the scan-idempotency test and the cursor-pagination test).
let cExp5: string; // end_date in 5 days
let cExp30: string; // end_date in 30 days
let cExp60: string; // end_date in 60 days
// Active but well outside the window — must NOT appear in expiring filter
// and must NOT have an alert raised.
let cFarOut: string; // end_date in 200 days
// Inside the window by date but stored as cancelled — must be excluded
// from both the alert scan (status='active' guard) and the derived
// `expiring` filter.
let cCancelled: string; // end_date in 10 days, status=cancelled

async function withServer<T>(
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("expected an AddressInfo for the test server");
    }
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

before(async () => {
  orgId = newId("org");
  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} org`,
    slug: `${RUN}-org`,
    // Settings left empty so the per-tenant threshold falls back to
    // ORG_DEFAULT_RENEWAL_ALERT_DAYS (90), which is what the dedupe
    // key embeds and what the derived-status SQL window uses.
  });

  supplierId = newId("sup");
  await db.insert(suppliersTable).values({
    id: supplierId,
    orgId,
    name: `${RUN} supplier`,
    normalizedName: `${RUN} supplier`,
    sourceSystem: "seed",
    sourceExternalId: `${RUN}-sup`,
  });

  cExp5 = newId("ctr");
  cExp30 = newId("ctr");
  cExp60 = newId("ctr");
  cFarOut = newId("ctr");
  cCancelled = newId("ctr");

  const baseRow = {
    orgId,
    supplierId,
    title: `${RUN} contract`,
    startDate: daysFromNow(-365),
    sourceSystem: "seed",
  } as const;

  await db.insert(contractsTable).values([
    {
      ...baseRow,
      id: cExp5,
      contractNumber: `${RUN}-C5`,
      sourceExternalId: `${RUN}-c5`,
      endDate: daysFromNow(5),
      status: "active",
    },
    {
      ...baseRow,
      id: cExp30,
      contractNumber: `${RUN}-C30`,
      sourceExternalId: `${RUN}-c30`,
      endDate: daysFromNow(30),
      status: "active",
    },
    {
      ...baseRow,
      id: cExp60,
      contractNumber: `${RUN}-C60`,
      sourceExternalId: `${RUN}-c60`,
      endDate: daysFromNow(60),
      status: "active",
      owner: "Alice",
    },
    {
      ...baseRow,
      id: cFarOut,
      contractNumber: `${RUN}-CFAR`,
      sourceExternalId: `${RUN}-cfar`,
      endDate: daysFromNow(200),
      status: "active",
    },
    {
      ...baseRow,
      id: cCancelled,
      contractNumber: `${RUN}-CCAN`,
      sourceExternalId: `${RUN}-ccan`,
      endDate: daysFromNow(10),
      status: "cancelled",
    },
  ]);
});

after(async () => {
  // FK cascades from `orgs` will sweep contracts, audit-log rows,
  // alerts, and the seeded supplier. Belt-and-braces deletes for the
  // few non-cascading edges (alerts.contract_id is ON DELETE SET NULL)
  // so we don't leave dangling rows pinned to our run prefix.
  await db.delete(alertsTable).where(eq(alertsTable.orgId, orgId));
  await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
});

describe("runRenewalAlertScanHandler — idempotency (#118)", () => {
  it("first run inserts alerts; second run inserts zero (dedupe by alerts_dedupe_uq)", async () => {
    // First run: seeds alerts for cExp5, cExp30, cExp60 (cFarOut is
    // outside the 90-day window; cCancelled is filtered by status='active').
    const first = (await runRenewalAlertScanHandler(
      {} as JobRow,
    )) as {
      alertsInserted: number;
      contractsUpdated: number;
      orgsScanned: number;
    };
    assert.ok(
      first.orgsScanned >= 1,
      "scan should iterate at least our seeded org",
    );

    // Verify the right contracts got an alert in OUR tenant (other
    // tenants in the dev DB may also have inserts; we don't care
    // about them — we only assert about our run's rows).
    const ourAlerts = await db
      .select()
      .from(alertsTable)
      .where(
        and(
          eq(alertsTable.orgId, orgId),
          eq(alertsTable.kind, "contract_renewal"),
        ),
      );
    const alertedContractIds = new Set(
      ourAlerts.map((a) => a.contractId).filter((x): x is string => !!x),
    );
    assert.deepEqual(
      [...alertedContractIds].sort(),
      [cExp5, cExp30, cExp60].sort(),
      "expected exactly the three in-window active contracts to be alerted",
    );

    // Severity boundary check (#118): <=7d critical, <=30d high, else info.
    const bySeverity = Object.fromEntries(
      ourAlerts.map((a) => [a.contractId, a.severity]),
    );
    assert.equal(bySeverity[cExp5], "critical");
    assert.equal(bySeverity[cExp30], "high");
    assert.equal(bySeverity[cExp60], "info");

    // Dedupe key shape — embeds threshold so flipping
    // `contractRenewalAlertDays` to a new value would yield a fresh
    // alert without colliding with the old one.
    for (const a of ourAlerts) {
      assert.equal(a.dedupeKey, `renewal:${a.contractId}:90`);
    }

    // Threshold-tracking on the contract row mirrors the dedupe key so
    // the list/detail UIs can render "alerted at 90 days" without a
    // join into `alerts`.
    const [post1] = await db
      .select({ thresholds: contractsTable.renewalAlertedThresholds })
      .from(contractsTable)
      .where(eq(contractsTable.id, cExp5));
    assert.deepEqual(post1?.thresholds, [90]);

    const alertCountBefore = ourAlerts.length;

    // Second run: every alert collides on (org_id, dedupe_key) and the
    // ON CONFLICT DO NOTHING short-circuits. The handler's
    // `alertsInserted` counter only increments on RETURNING rows, so
    // it must be exactly zero.
    const second = (await runRenewalAlertScanHandler({} as JobRow)) as {
      alertsInserted: number;
      contractsUpdated: number;
    };
    assert.equal(
      second.alertsInserted,
      0,
      "second scan must insert no new alerts (dedupe key collision)",
    );
    assert.equal(
      second.contractsUpdated,
      0,
      "second scan must not re-append thresholds (already_alerted=true)",
    );

    // And the alert table row count is unchanged for our tenant.
    const after2 = await db
      .select({ id: alertsTable.id })
      .from(alertsTable)
      .where(
        and(
          eq(alertsTable.orgId, orgId),
          eq(alertsTable.kind, "contract_renewal"),
        ),
      );
    assert.equal(after2.length, alertCountBefore);

    // Threshold list must NOT have grown to [90, 90] — array_append is
    // gated by `if (!r.already_alerted)` precisely to prevent that.
    const [post2] = await db
      .select({ thresholds: contractsTable.renewalAlertedThresholds })
      .from(contractsTable)
      .where(eq(contractsTable.id, cExp5));
    assert.deepEqual(post2?.thresholds, [90]);
  });
});

describe("PATCH /contracts/:id — audit log writes (#118)", () => {
  it("changed fields produce one audit row each, surfaced via GET detail", async () => {
    await withServer(async (baseUrl) => {
      // PATCH cExp60: change owner Alice → Bob and add internalNotes.
      // billingCurrency stays untouched so we also exercise the
      // "unchanged fields don't pollute the timeline" branch.
      const patchRes = await fetch(`${baseUrl}/api/contracts/${cExp60}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-org-id": orgId,
        },
        body: JSON.stringify({
          owner: "Bob",
          internalNotes: "Renewal scope drafted",
        }),
      });
      assert.equal(patchRes.status, 200, await patchRes.text());

      const detailRes = await fetch(`${baseUrl}/api/contracts/${cExp60}`, {
        headers: { "x-org-id": orgId },
      });
      assert.equal(detailRes.status, 200);
      const detail = (await detailRes.json()) as {
        owner: string | null;
        internalNotes: string | null;
        auditLog: Array<{
          field: string;
          oldValue: unknown;
          newValue: unknown;
        }>;
      };
      assert.equal(detail.owner, "Bob");
      assert.equal(detail.internalNotes, "Renewal scope drafted");

      // PATCH wrote one row per changed field; confirm both showed up
      // (order is desc on createdAt — the timeline view, so just
      // index by field).
      const byField = Object.fromEntries(
        detail.auditLog.map((r) => [r.field, r]),
      );
      assert.ok(
        byField["owner"],
        `expected an owner audit row, got fields: ${detail.auditLog
          .map((r) => r.field)
          .join(", ")}`,
      );
      assert.equal(byField["owner"]?.oldValue, "Alice");
      assert.equal(byField["owner"]?.newValue, "Bob");

      assert.ok(byField["internalNotes"], "expected an internalNotes audit row");
      assert.equal(byField["internalNotes"]?.oldValue, null);
      assert.equal(byField["internalNotes"]?.newValue, "Renewal scope drafted");

      // No row should have been written for fields that weren't sent.
      assert.equal(byField["billingCurrency"], undefined);
      assert.equal(byField["renewalTargetAction"], undefined);

      // Sanity check at the DB layer: no extra rows for this contract
      // beyond the two we asserted above.
      const dbRows = await db
        .select({ field: contractAuditLogTable.field })
        .from(contractAuditLogTable)
        .where(eq(contractAuditLogTable.contractId, cExp60));
      assert.equal(dbRows.length, 2, JSON.stringify(dbRows));
    });
  });

  it("re-PATCHing with the same value is a no-op (no audit row)", async () => {
    await withServer(async (baseUrl) => {
      // Use cExp30 (not cExp60) so this test does not depend on the
      // ordering of the previous test. Read the contract's current
      // owner directly from the DB and PATCH it back to itself —
      // that's the no-op path the audit-log writer is supposed to
      // skip regardless of what the seeded value was.
      const [before] = await db
        .select({
          owner: contractsTable.owner,
        })
        .from(contractsTable)
        .where(eq(contractsTable.id, cExp30));
      const auditBefore = await db
        .select({ id: contractAuditLogTable.id })
        .from(contractAuditLogTable)
        .where(eq(contractAuditLogTable.contractId, cExp30));

      const patchRes = await fetch(`${baseUrl}/api/contracts/${cExp30}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-org-id": orgId,
        },
        body: JSON.stringify({ owner: before?.owner ?? null }),
      });
      assert.equal(patchRes.status, 200);

      const auditAfter = await db
        .select({ id: contractAuditLogTable.id })
        .from(contractAuditLogTable)
        .where(eq(contractAuditLogTable.contractId, cExp30));
      assert.equal(
        auditAfter.length,
        auditBefore.length,
        "no-op PATCH should not produce additional audit rows",
      );
    });
  });
});

describe("GET /contracts — derived `expiring` filter + cursor pagination", () => {
  type ListItem = {
    id: string;
    derivedStatus: string;
    status: string;
    endDate: string;
  };
  type ListJson = { items: ListItem[]; nextCursor: string | null };

  async function getList(
    baseUrl: string,
    query: Record<string, string>,
  ): Promise<{ status: number; json: ListJson }> {
    const qs = new URLSearchParams(query).toString();
    const r = await fetch(`${baseUrl}/api/contracts?${qs}`, {
      headers: { "x-org-id": orgId },
    });
    return { status: r.status, json: (await r.json()) as ListJson };
  }

  it("?status=expiring returns only active in-window contracts (excludes far-out + cancelled)", async () => {
    await withServer(async (baseUrl) => {
      const r = await getList(baseUrl, { status: "expiring", limit: "100" });
      assert.equal(r.status, 200);
      const ids = r.json.items.map((i) => i.id).sort();
      assert.deepEqual(
        ids,
        [cExp5, cExp30, cExp60].sort(),
        `expected the three in-window active contracts; got: ${ids.join(", ")}`,
      );
      // Every returned row should also report derivedStatus='expiring'
      // so the list filter and the per-row badge agree.
      for (const item of r.json.items) {
        assert.equal(
          item.derivedStatus,
          "expiring",
          `${item.id} returned with derivedStatus=${item.derivedStatus}`,
        );
      }
    });
  });

  it("cursor pagination walks the expiring list deterministically", async () => {
    await withServer(async (baseUrl) => {
      // limit=2 across 3 expiring contracts. Order is end_date ASC,
      // so page 1 = [cExp5, cExp30], cursor → page 2 = [cExp60].
      const page1 = await getList(baseUrl, {
        status: "expiring",
        limit: "2",
      });
      assert.equal(page1.status, 200);
      assert.equal(page1.json.items.length, 2);
      assert.deepEqual(
        page1.json.items.map((i) => i.id),
        [cExp5, cExp30],
        "page 1 must be the two soonest-expiring contracts in end_date order",
      );
      assert.ok(
        page1.json.nextCursor,
        "page 1 must hand back a cursor when more rows exist",
      );

      const page2 = await getList(baseUrl, {
        status: "expiring",
        limit: "2",
        cursor: page1.json.nextCursor!,
      });
      assert.equal(page2.status, 200);
      assert.deepEqual(
        page2.json.items.map((i) => i.id),
        [cExp60],
        "page 2 must contain the remaining expiring contract",
      );
      assert.equal(
        page2.json.nextCursor,
        null,
        "page 2 must terminate the cursor walk",
      );
    });
  });
});
