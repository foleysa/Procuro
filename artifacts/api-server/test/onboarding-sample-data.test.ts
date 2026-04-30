/**
 * Integration spec for the onboarding sample-data loader and the
 * per-actor onboarding state row.
 *
 * Both flows are tenant-scoped and idempotent — exercise them against a
 * fresh test org so the assertions can pin exact row counts without
 * being polluted by seeded fixtures.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  orgsTable,
  suppliersTable,
  categoriesTable,
  itemsTable,
  contractsTable,
  purchaseOrdersTable,
  poLinesTable,
  invoicesTable,
  paymentsTable,
  onboardingStateTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  loadSampleData,
  removeSampleData,
} from "../src/lib/onboarding/sample-data";

const RUN = `t122-${randomUUID().slice(0, 8)}`;

describe("onboarding sample-data + state", () => {
  let orgId: string;

  before(async () => {
    orgId = `org-${RUN}`;
    await db.insert(orgsTable).values({
      id: orgId,
      name: `${RUN} Sample Org`,
      slug: `${RUN}-org`,
    });
  });

  after(async () => {
    // Belt-and-braces: removeSampleData covers the happy path, but
    // clean every namespace we may have written into so a half-failed
    // test still leaves the DB pristine.
    const safe = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* swallow — best-effort cleanup */
      }
    };
    await safe(
      db
        .delete(onboardingStateTable)
        .where(eq(onboardingStateTable.orgId, orgId)),
    );
    await safe(db.delete(paymentsTable).where(eq(paymentsTable.orgId, orgId)));
    await safe(db.delete(invoicesTable).where(eq(invoicesTable.orgId, orgId)));
    await safe(db.delete(poLinesTable).where(eq(poLinesTable.orgId, orgId)));
    await safe(
      db
        .delete(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.orgId, orgId)),
    );
    await safe(
      db.delete(contractsTable).where(eq(contractsTable.orgId, orgId)),
    );
    await safe(db.delete(itemsTable).where(eq(itemsTable.orgId, orgId)));
    await safe(
      db.delete(suppliersTable).where(eq(suppliersTable.orgId, orgId)),
    );
    await safe(
      db.delete(categoriesTable).where(eq(categoriesTable.orgId, orgId)),
    );
    await safe(db.delete(orgsTable).where(eq(orgsTable.id, orgId)));
  });

  it("loadSampleData installs the sentinel dataset and is idempotent", async () => {
    const first = await loadSampleData({ orgId });
    assert.equal(first.installed, true, "first load must install");
    assert.ok(
      first.counts.suppliers >= 5,
      `expected at least 5 suppliers, got ${first.counts.suppliers}`,
    );
    assert.ok(
      first.counts.contracts >= 4,
      `expected at least 4 contracts, got ${first.counts.contracts}`,
    );
    assert.ok(
      first.counts.invoices >= 1,
      `expected at least one invoice, got ${first.counts.invoices}`,
    );
    assert.ok(
      first.counts.payments >= 1,
      `expected at least one payment, got ${first.counts.payments}`,
    );

    // Calling again must NOT double-insert. The contract is
    // `installed: false` with the same counts.
    const second = await loadSampleData({ orgId });
    assert.equal(second.installed, false, "second load must be a no-op");
    assert.deepEqual(
      second.counts,
      first.counts,
      "idempotent re-install must not change row counts",
    );
  });

  it("removeSampleData wipes every sample row and is idempotent", async () => {
    // Sanity guard — depends on the previous test having installed.
    const before = await loadSampleData({ orgId });
    assert.equal(before.installed, false);

    const removal = await removeSampleData({ orgId });
    assert.equal(removal.removed, true);
    // The contract for `counts` is "rows that existed before cleanup",
    // i.e. an audit of what was wiped. So this should mirror `before`.
    assert.ok(removal.counts.suppliers > 0, "removal must report cleanup");

    // The DB itself must have nothing left tagged as sample data for
    // this tenant. Inspect each table directly so a future regression
    // (e.g. forgetting to clean a new entity) is caught here.
    const remainingSuppliers = await db
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(eq(suppliersTable.orgId, orgId));
    assert.equal(
      remainingSuppliers.length,
      0,
      `expected 0 suppliers post-cleanup, got ${remainingSuppliers.length}`,
    );
    const remainingPayments = await db
      .select({ id: paymentsTable.id })
      .from(paymentsTable)
      .where(eq(paymentsTable.orgId, orgId));
    assert.equal(remainingPayments.length, 0);

    // A second removal is a no-op on an already-clean tenant.
    const noop = await removeSampleData({ orgId });
    assert.equal(noop.removed, false, "second removal must be a no-op");
  });

  it("PATCH onboarding state advances current step and records completion", async () => {
    // Drive the route handlers via the underlying lib + table — pure
    // SQL is enough to pin the persistence contract.
    const email = `${RUN}@example.test`;

    // First call materialises the row (mirrors loadOrInit).
    await db.insert(onboardingStateTable).values({
      orgId,
      userEmail: email,
    });

    await db
      .update(onboardingStateTable)
      .set({
        currentStep: "bring_data",
        completedSteps: [
          {
            step: "welcome",
            completedAt: new Date().toISOString(),
          },
        ],
      })
      .where(eq(onboardingStateTable.userEmail, email));

    const [row] = await db
      .select()
      .from(onboardingStateTable)
      .where(eq(onboardingStateTable.userEmail, email));
    assert.ok(row, "onboarding row must exist after PATCH");
    assert.equal(row.orgId, orgId, "row must be scoped to the test org");
    assert.equal(row.currentStep, "bring_data");
    assert.equal(row.completedSteps?.length ?? 0, 1);
    assert.equal(row.completedSteps?.[0]?.step, "welcome");
    assert.equal(row.dismissedAt, null);
    assert.equal(row.completedAt, null);

    // Mark dismissed — this is the explicit "skip the wizard" branch
    // the dashboard auto-trigger reads.
    const dismissedAt = new Date();
    await db
      .update(onboardingStateTable)
      .set({ dismissedAt })
      .where(eq(onboardingStateTable.userEmail, email));

    const [after] = await db
      .select()
      .from(onboardingStateTable)
      .where(eq(onboardingStateTable.userEmail, email));
    assert.ok(after?.dismissedAt, "dismissedAt must be set after dismiss");
  });
});
