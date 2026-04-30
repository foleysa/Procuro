/**
 * Integration spot check for the post-PO-ingest supplier
 * `billing_currency` backfill helper (#55).
 *
 * Seeds three suppliers under a per-run org:
 *
 *   1. `nullSupplier` — no billing currency, PO lines mention "EUR".
 *      Expect: persisted as EUR / source `backfill_invoice` / high.
 *   2. `dollarizedSupplier` — low-confidence dollarized country hint
 *      (USD / `country_dollarized`), PO lines mention "GBP".
 *      Expect: upgraded to GBP / `backfill_invoice` / high.
 *   3. `manualSupplier` — billingCurrency=JPY, source=manual_override.
 *      PO lines mention EUR — must NEVER be touched (override sticks).
 *
 * Plus a fourth `noEvidenceSupplier` with null currency and zero
 * PO-line evidence — counted as `noEvidence` and left untouched.
 *
 * Self-cleaning per existing test conventions.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, like, or } from "drizzle-orm";

import {
  db,
  orgsTable,
  suppliersTable,
  purchaseOrdersTable,
  poLinesTable,
} from "@workspace/db";

import { backfillSupplierBillingCurrency } from "../src/lib/suppliers/backfill-billing-currency";

const RUN = `t55bf-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgId: string;
let nullSupplier: string;
let dollarizedSupplier: string;
let manualSupplier: string;
let noEvidenceSupplier: string;

async function seedPoWithLines(opts: {
  supplierId: string;
  descriptions: string[];
}): Promise<void> {
  const today = new Date();
  const poId = newId("po");
  await db.insert(purchaseOrdersTable).values({
    id: poId,
    orgId,
    poNumber: `${RUN}-${opts.supplierId.slice(-6)}`,
    supplierId: opts.supplierId,
    contractId: null,
    orderDate: today,
    sourceSystem: SOURCE,
    sourceExternalId: `${RUN}-po-${opts.supplierId.slice(-6)}`,
  });
  let line = 0;
  for (const desc of opts.descriptions) {
    line += 1;
    await db.insert(poLinesTable).values({
      id: newId("pol"),
      orgId,
      poId,
      lineNumber: line,
      sku: `${RUN}-SKU-${line}`,
      description: desc,
      categoryId: null,
      spendClass: "indirect",
      qty: "1",
      unitPriceUsd: "100.0000",
      extendedUsd: "100.00",
      orderDate: today,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-pol-${opts.supplierId.slice(-6)}-${line}`,
    });
  }
}

describe("backfillSupplierBillingCurrency (#55)", () => {
  before(async () => {
    orgId = newId("org");
    await db.insert(orgsTable).values({
      id: orgId,
      name: `${RUN} backfill org`,
      slug: `${RUN}-backfill-org`,
    });

    // 1) Null currency, EUR-evidence lines.
    nullSupplier = newId("sup");
    await db.insert(suppliersTable).values({
      id: nullSupplier,
      orgId,
      name: `${RUN} EU Co.`,
      normalizedName: `${RUN} eu co.`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-eu`,
      // billingCurrency / source / confidence intentionally null.
    });
    await seedPoWithLines({
      supplierId: nullSupplier,
      descriptions: [
        `${RUN} office services — total EUR 1,234.00`,
        `${RUN} stationery — net EUR 50.00`,
      ],
    });

    // 2) Dollarized country (low confidence), GBP-evidence lines.
    dollarizedSupplier = newId("sup");
    await db.insert(suppliersTable).values({
      id: dollarizedSupplier,
      orgId,
      name: `${RUN} EC Co.`,
      normalizedName: `${RUN} ec co.`,
      countryCode: "EC",
      billingCurrency: "USD",
      billingCurrencySource: "country_dollarized",
      billingCurrencyConfidence: "low",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-ec`,
    });
    await seedPoWithLines({
      supplierId: dollarizedSupplier,
      descriptions: [`${RUN} consulting — invoice GBP 5,000.00`],
    });

    // 3) Manual override, EUR-evidence lines (override must not move).
    manualSupplier = newId("sup");
    await db.insert(suppliersTable).values({
      id: manualSupplier,
      orgId,
      name: `${RUN} JP Co.`,
      normalizedName: `${RUN} jp co.`,
      billingCurrency: "JPY",
      billingCurrencySource: "manual_override",
      billingCurrencyConfidence: "high",
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-jp`,
    });
    await seedPoWithLines({
      supplierId: manualSupplier,
      descriptions: [`${RUN} test — total EUR 999.00`],
    });

    // 4) Null currency, zero PO-line evidence.
    noEvidenceSupplier = newId("sup");
    await db.insert(suppliersTable).values({
      id: noEvidenceSupplier,
      orgId,
      name: `${RUN} Unknown Co.`,
      normalizedName: `${RUN} unknown co.`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-unk`,
    });
  });

  after(async () => {
    await db
      .delete(poLinesTable)
      .where(like(poLinesTable.sourceExternalId, `${RUN}-%`));
    await db
      .delete(purchaseOrdersTable)
      .where(like(purchaseOrdersTable.sourceExternalId, `${RUN}-%`));
    await db
      .delete(suppliersTable)
      .where(
        or(
          eq(suppliersTable.id, nullSupplier),
          eq(suppliersTable.id, dollarizedSupplier),
          eq(suppliersTable.id, manualSupplier),
          eq(suppliersTable.id, noEvidenceSupplier),
        ),
      );
    await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  });

  it("backfills null + dollarized rows from PO-line evidence", async () => {
    const result = await backfillSupplierBillingCurrency(orgId);

    // Considered = the 3 candidates (null + dollarized + noEvidence).
    // The manual_override row is excluded by the candidate query.
    assert.equal(
      result.considered,
      3,
      `considered: expected 3, got ${result.considered}`,
    );
    assert.equal(
      result.updated,
      2,
      `updated: expected 2, got ${result.updated}`,
    );
    assert.equal(result.noEvidence, 1, "noEvidence: expected 1");
    assert.equal(result.noMatch, 0, "noMatch: expected 0");

    const [n] = await db
      .select({
        billingCurrency: suppliersTable.billingCurrency,
        billingCurrencySource: suppliersTable.billingCurrencySource,
        billingCurrencyConfidence: suppliersTable.billingCurrencyConfidence,
      })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, nullSupplier));
    assert.ok(n, "expected nullSupplier row");
    assert.equal(n.billingCurrency, "EUR");
    assert.equal(n.billingCurrencySource, "backfill_invoice");
    assert.equal(n.billingCurrencyConfidence, "high");

    const [d] = await db
      .select({
        billingCurrency: suppliersTable.billingCurrency,
        billingCurrencySource: suppliersTable.billingCurrencySource,
        billingCurrencyConfidence: suppliersTable.billingCurrencyConfidence,
      })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, dollarizedSupplier));
    assert.ok(d, "expected dollarizedSupplier row");
    assert.equal(
      d.billingCurrency,
      "GBP",
      "dollarized hint must be overwritten by GBP invoice ISO match",
    );
    assert.equal(d.billingCurrencySource, "backfill_invoice");
    assert.equal(d.billingCurrencyConfidence, "high");

    const [m] = await db
      .select({
        billingCurrency: suppliersTable.billingCurrency,
        billingCurrencySource: suppliersTable.billingCurrencySource,
        billingCurrencyConfidence: suppliersTable.billingCurrencyConfidence,
      })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, manualSupplier));
    assert.ok(m, "expected manualSupplier row");
    assert.equal(
      m.billingCurrency,
      "JPY",
      "manual_override row must never be touched by backfill",
    );
    assert.equal(m.billingCurrencySource, "manual_override");
    assert.equal(m.billingCurrencyConfidence, "high");

    const [u] = await db
      .select({
        billingCurrency: suppliersTable.billingCurrency,
        billingCurrencySource: suppliersTable.billingCurrencySource,
      })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, noEvidenceSupplier));
    assert.ok(u, "expected noEvidenceSupplier row");
    assert.equal(
      u.billingCurrency,
      null,
      "no-evidence supplier must remain null",
    );
    assert.equal(u.billingCurrencySource, null);
  });

  it("is idempotent on a second run", async () => {
    const second = await backfillSupplierBillingCurrency(orgId);
    // After the first run only the no-evidence row remains as a
    // candidate (still null), so we re-consider it but never update it.
    assert.equal(second.updated, 0, "second run must update zero rows");
    assert.equal(second.considered, 1, "only the noEvidence row stays candidate");
    assert.equal(second.noEvidence, 1);
  });
});
