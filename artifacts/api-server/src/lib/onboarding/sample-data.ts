import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  suppliersTable,
  contractsTable,
  categoriesTable,
  itemsTable,
  purchaseOrdersTable,
  poLinesTable,
  invoicesTable,
  paymentsTable,
} from "@workspace/db";
import { SAMPLE_DATA_SOURCE_SYSTEM } from "./sample-data-constants";

const SOURCE = SAMPLE_DATA_SOURCE_SYSTEM;

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export interface SampleDataLoadResult {
  installed: boolean;
  counts: {
    suppliers: number;
    categories: number;
    items: number;
    contracts: number;
    purchaseOrders: number;
    poLines: number;
    invoices: number;
    payments: number;
  };
}

export interface SampleDataRemovalResult {
  removed: boolean;
  counts: SampleDataLoadResult["counts"];
}

/**
 * Idempotent: returns `installed: false` with current row counts if the
 * sentinel rows are already present. Otherwise inserts a small but
 * realistic dataset (5 suppliers, 4 contracts, 30 PO lines, payments)
 * tagged with `source_system = 'sample_data'` so the DELETE endpoint can
 * cleanly remove every row it created.
 */
export async function loadSampleData(args: {
  orgId: string;
}): Promise<SampleDataLoadResult> {
  const { orgId } = args;

  const existing = await sampleDataCounts(orgId);
  if (existing.suppliers > 0) {
    return { installed: false, counts: existing };
  }

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  // Categories
  const cats = [
    { code: "DIRECT-RAW", name: "Raw materials", class: "direct" as const },
    { code: "INDIRECT-IT", name: "IT hardware", class: "indirect" as const },
    {
      code: "INDIRECT-MRO",
      name: "MRO supplies",
      class: "indirect" as const,
    },
    {
      code: "SERVICE-LOG",
      name: "Logistics services",
      class: "service" as const,
    },
  ].map((c) => ({
    id: id("cat"),
    orgId,
    code: c.code,
    name: c.name,
    class: c.class,
    sourceSystem: SOURCE,
    sourceExternalId: `sample-${c.code}`,
  }));
  await db.insert(categoriesTable).values(cats);

  // Suppliers
  const supplierSeeds = [
    {
      name: "Acme Industrial Co.",
      country: "US",
      currency: "USD",
      terms: "30",
      strategic: true,
    },
    {
      name: "Globex Components Ltd.",
      country: "GB",
      currency: "GBP",
      terms: "60",
      strategic: false,
    },
    {
      name: "Initech Logistics",
      country: "DE",
      currency: "EUR",
      terms: "45",
      strategic: false,
    },
    {
      name: "Stark Materials Inc.",
      country: "US",
      currency: "USD",
      terms: "30",
      strategic: true,
    },
    {
      name: "Hooli Office Supply",
      country: "US",
      currency: "USD",
      terms: "60",
      strategic: false,
    },
  ];
  const suppliers = supplierSeeds.map((s, i) => ({
    id: id("sup"),
    orgId,
    name: s.name,
    normalizedName: s.name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim(),
    countryCode: s.country,
    billingCurrency: s.currency,
    billingCurrencySource: "provided",
    billingCurrencyConfidence: "high",
    paymentTermsDays: s.terms,
    isStrategic: s.strategic,
    sourceSystem: SOURCE,
    sourceExternalId: `sample-sup-${i}`,
  }));
  await db.insert(suppliersTable).values(suppliers);

  // Items
  const itemSeeds: Array<{ sku: string; desc: string; cat: number; uom: string }> = [
    { sku: "RAW-STEEL-A36", desc: "Hot-rolled steel A36 plate", cat: 0, uom: "kg" },
    { sku: "RAW-STEEL-A36-EU", desc: "Hot-rolled steel A36 plate", cat: 0, uom: "kg" },
    { sku: "IT-LAPTOP-14", desc: "14-inch business laptop", cat: 1, uom: "ea" },
    { sku: "IT-MONITOR-27", desc: "27-inch monitor", cat: 1, uom: "ea" },
    { sku: "MRO-GLOVE-NIT", desc: "Nitrile gloves, box of 100", cat: 2, uom: "box" },
    { sku: "MRO-LUBE-5L", desc: "Industrial lubricant 5L", cat: 2, uom: "ea" },
    { sku: "LOG-FRT-LANE-EU", desc: "EU freight lane lot", cat: 3, uom: "lot" },
  ];
  const items = itemSeeds.map((it) => ({
    id: id("item"),
    orgId,
    sku: it.sku,
    description: it.desc,
    normalizedKey: it.sku.toLowerCase(),
    categoryId: cats[it.cat]!.id,
    uom: it.uom,
    sourceSystem: SOURCE,
    sourceExternalId: `sample-item-${it.sku}`,
  }));
  await db.insert(itemsTable).values(items);

  // Contracts
  const contractSeeds = [
    {
      supplier: 0,
      title: "Acme steel supply",
      cat: 0,
      baseline: 1_200_000,
      terms: 30,
      idx: "PPI-IRON-STEEL",
      currency: "USD",
      owner: "owner-direct@example.com",
    },
    {
      supplier: 1,
      title: "Globex IT hardware MSA",
      cat: 1,
      baseline: 750_000,
      terms: 60,
      idx: null,
      currency: "GBP",
      owner: "owner-it@example.com",
    },
    {
      supplier: 2,
      title: "Initech EU logistics",
      cat: 3,
      baseline: 480_000,
      terms: 45,
      idx: null,
      currency: "EUR",
      owner: null,
    },
    {
      supplier: 3,
      title: "Stark materials supply",
      cat: 0,
      baseline: 900_000,
      terms: 30,
      idx: "PPI-IRON-STEEL",
      currency: "USD",
      owner: "owner-direct@example.com",
    },
  ];
  const contracts = contractSeeds.map((c, i) => ({
    id: id("ctr"),
    orgId,
    supplierId: suppliers[c.supplier]!.id,
    categoryId: cats[c.cat]!.id,
    contractNumber: `SAMPLE-${1000 + i}`,
    title: c.title,
    status: "active" as const,
    startDate: new Date(now.getTime() - 365 * dayMs),
    endDate: new Date(now.getTime() + (60 + i * 30) * dayMs),
    paymentTermsDays: c.terms,
    referenceIndex: c.idx,
    billingCurrency: c.currency,
    annualBaselineUsd: c.baseline.toFixed(2),
    owner: c.owner,
    sourceSystem: SOURCE,
    sourceExternalId: `sample-ctr-${i}`,
  }));
  await db.insert(contractsTable).values(contracts);

  // Purchase orders + lines
  const poRows: (typeof purchaseOrdersTable.$inferInsert)[] = [];
  const poLineRows: (typeof poLinesTable.$inferInsert)[] = [];
  let poIdx = 0;
  for (let s = 0; s < suppliers.length; s++) {
    for (let p = 0; p < 2; p++) {
      const orderDate = new Date(now.getTime() - (30 + poIdx * 14) * dayMs);
      const poId = id("po");
      // Maverick: alternate between contract-linked and unlinked so the
      // analyzer has both signals.
      const linkedContract =
        s < contracts.length ? contracts.find((c) => c.supplierId === suppliers[s]!.id) : undefined;
      const contractId = p === 0 && linkedContract ? linkedContract.id : null;
      const poLines = [0, 1].map((l) => {
        // Vary unit price across POs to give SKU price benchmark a signal.
        const item = items[(s + l + p) % items.length]!;
        const basePrice = 50 + ((s + 1) * 7) + l * 3;
        const unitPrice = basePrice * (p === 0 ? 1 : 1.18);
        const qty = 100 + s * 10;
        return {
          id: id("pol"),
          orgId,
          poId,
          lineNumber: l + 1,
          itemId: item.id,
          sku: item.sku,
          description: item.description,
          categoryId: item.categoryId,
          spendClass: "direct" as const,
          qty: qty.toFixed(4),
          uom: item.uom ?? "ea",
          unitPriceUsd: unitPrice.toFixed(4),
          extendedUsd: (unitPrice * qty).toFixed(2),
          orderDate,
          sourceSystem: SOURCE,
          sourceExternalId: `sample-pol-${poIdx}-${l}`,
        };
      });
      const total = poLines.reduce((acc, ln) => acc + Number(ln.extendedUsd), 0);
      poRows.push({
        id: poId,
        orgId,
        poNumber: `PO-SAMPLE-${1000 + poIdx}`,
        supplierId: suppliers[s]!.id,
        contractId,
        businessUnit: "Operations",
        site: "HQ",
        status: "received",
        orderDate,
        totalUsd: total.toFixed(2),
        sourceSystem: SOURCE,
        sourceExternalId: `sample-po-${poIdx}`,
      });
      poLineRows.push(...poLines);
      poIdx++;
    }
  }
  await db.insert(purchaseOrdersTable).values(poRows);
  await db.insert(poLinesTable).values(poLineRows);

  // Invoices + payments (one duplicate to seed duplicate-payment lever)
  const invRows: (typeof invoicesTable.$inferInsert)[] = [];
  const paymentRows: (typeof paymentsTable.$inferInsert)[] = [];
  poRows.forEach((po, i) => {
    const inv1 = {
      id: id("inv"),
      orgId,
      invoiceNumber: `INV-SAMPLE-${2000 + i}`,
      supplierId: po.supplierId,
      poId: po.id,
      invoiceDate: po.orderDate,
      amountUsd: po.totalUsd ?? "0",
      status: "paid" as const,
      dedupKey: `${po.supplierId}|${po.totalUsd}|${(po.orderDate as Date).toISOString().slice(0, 10)}`,
      sourceSystem: SOURCE,
      sourceExternalId: `sample-inv-${i}`,
    };
    invRows.push(inv1);
    if (i === 0) {
      // Plant a duplicate so the duplicate-payment lever lights up.
      invRows.push({
        ...inv1,
        id: id("inv"),
        invoiceNumber: `${inv1.invoiceNumber}-DUP`,
        sourceExternalId: `sample-inv-${i}-dup`,
      });
    }
  });
  await db.insert(invoicesTable).values(invRows);
  invRows.forEach((inv, i) => {
    paymentRows.push({
      id: id("pay"),
      orgId,
      invoiceId: inv.id!,
      paidDate: new Date(now.getTime() - (5 + i * 3) * dayMs),
      amountUsd: inv.amountUsd!,
      paymentTermsDays: 30 + (i % 3) * 15,
      sourceSystem: SOURCE,
      sourceExternalId: `sample-pay-${i}`,
    });
  });
  await db.insert(paymentsTable).values(paymentRows);

  return {
    installed: true,
    counts: await sampleDataCounts(orgId),
  };
}

/**
 * Removes every sample-data row for the tenant. Order respects FK
 * cascades; cascades from `payments` happen automatically when the
 * parent invoice is deleted, but we delete payments first explicitly so
 * the cleanup is idempotent even when an org admin manually unmarks an
 * invoice's `source_system`.
 */
export async function removeSampleData(args: {
  orgId: string;
}): Promise<SampleDataRemovalResult> {
  const { orgId } = args;
  const before = await sampleDataCounts(orgId);

  // Order respects FKs: payments → invoices → PO lines → POs →
  // contracts → items → suppliers → categories.
  const sampleInvoiceIds = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.orgId, orgId),
        eq(invoicesTable.sourceSystem, SOURCE),
      ),
    );
  const invoiceIds = sampleInvoiceIds.map((r) => r.id);
  if (invoiceIds.length > 0) {
    await db
      .delete(paymentsTable)
      .where(
        and(
          eq(paymentsTable.orgId, orgId),
          inArray(paymentsTable.invoiceId, invoiceIds),
        ),
      );
  }
  await db
    .delete(paymentsTable)
    .where(
      and(
        eq(paymentsTable.orgId, orgId),
        eq(paymentsTable.sourceSystem, SOURCE),
      ),
    );
  await db
    .delete(invoicesTable)
    .where(
      and(
        eq(invoicesTable.orgId, orgId),
        eq(invoicesTable.sourceSystem, SOURCE),
      ),
    );
  await db
    .delete(poLinesTable)
    .where(
      and(
        eq(poLinesTable.orgId, orgId),
        eq(poLinesTable.sourceSystem, SOURCE),
      ),
    );
  await db
    .delete(purchaseOrdersTable)
    .where(
      and(
        eq(purchaseOrdersTable.orgId, orgId),
        eq(purchaseOrdersTable.sourceSystem, SOURCE),
      ),
    );
  await db
    .delete(contractsTable)
    .where(
      and(
        eq(contractsTable.orgId, orgId),
        eq(contractsTable.sourceSystem, SOURCE),
      ),
    );
  await db
    .delete(itemsTable)
    .where(
      and(eq(itemsTable.orgId, orgId), eq(itemsTable.sourceSystem, SOURCE)),
    );
  await db
    .delete(suppliersTable)
    .where(
      and(
        eq(suppliersTable.orgId, orgId),
        eq(suppliersTable.sourceSystem, SOURCE),
      ),
    );
  await db
    .delete(categoriesTable)
    .where(
      and(
        eq(categoriesTable.orgId, orgId),
        eq(categoriesTable.sourceSystem, SOURCE),
      ),
    );

  return { removed: before.suppliers > 0, counts: before };
}

async function sampleDataCounts(
  orgId: string,
): Promise<SampleDataLoadResult["counts"]> {
  const [s, c, i, ct, po, pol, inv, pay] = await Promise.all([
    countByOrg("suppliers", orgId),
    countByOrg("categories", orgId),
    countByOrg("items", orgId),
    countByOrg("contracts", orgId),
    countByOrg("purchase_orders", orgId),
    countByOrg("po_lines", orgId),
    countByOrg("invoices", orgId),
    countByOrg("payments", orgId),
  ]);
  return {
    suppliers: s,
    categories: c,
    items: i,
    contracts: ct,
    purchaseOrders: po,
    poLines: pol,
    invoices: inv,
    payments: pay,
  };
}

async function countByOrg(table: string, orgId: string): Promise<number> {
  const out = await db.execute(sql.raw(
    `SELECT COUNT(*)::int AS n FROM ${table}
       WHERE org_id = '${orgId.replace(/'/g, "''")}'
         AND source_system = '${SAMPLE_DATA_SOURCE_SYSTEM}'`,
  ));
  return Number((out.rows[0] as { n: number } | undefined)?.n ?? 0);
}
