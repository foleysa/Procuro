/**
 * Procurement RaaS — F500-scale seed data.
 *
 * Builds two tenants:
 *   1. SCIS Procurement (F500-ish): ~800 suppliers, ~80 contracts, ~12000 POs,
 *      ~5000 PO lines, invoices, payments, shipments, raw-material usage —
 *      crafted to trigger every Tier-1 lever and a couple of Tier-2 ones.
 *   2. ProcureWorks Inc. (smaller): isolated tenant for cross-tenant proofs.
 *
 * Pre-seeds 4 historical OODA cycles per tenant with synthetic outcomes that
 * give the OODA Learn priors something realistic to converge on.
 *
 * Reproducible via mulberry32 PRNG with a fixed seed.
 */
import {
  db,
  pool,
  orgsTable,
  orgApiTokensTable,
  usersTable,
  categoriesTable,
  itemsTable,
  suppliersTable,
  contractsTable,
  contractItemsTable,
  purchaseOrdersTable,
  poLinesTable,
  invoicesTable,
  paymentsTable,
  shipmentsTable,
  rawMaterialUsageTable,
  opportunitiesTable,
  decisionsTable,
  analysisCyclesTable,
  learnedPriorsTable,
  marketSignalsTable,
  collectorsTable,
  leverIds,
  type LeverId,
  type CategoryClass,
  type FreightMode,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomBytes, randomUUID, createHash } from "node:crypto";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function hashToken(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260429);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const irange = (lo: number, hi: number) =>
  lo + Math.floor(rand() * (hi - lo + 1));
const frange = (lo: number, hi: number) => lo + rand() * (hi - lo);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// -------------------------------------------------------------------- WIPE --

async function wipeAll(): Promise<void> {
  // Order matters: children first.
  const tables = [
    "decisions",
    "opportunities",
    "exclusion_rules",
    "learned_priors",
    "analysis_cycles",
    "market_signals",
    "collector_audit_log",
    "collectors",
    "jobs",
    "payments",
    "invoices",
    "shipments",
    "raw_material_usage",
    "po_lines",
    "purchase_orders",
    "contract_items",
    "contracts",
    "items",
    "categories",
    "suppliers",
    "users",
    "orgs",
  ];
  for (const t of tables) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`));
  }
  console.log(`[seed] wiped ${tables.length} tables`);
}

// ------------------------------------------------------------------ SCAFOLD --

type CategoryDef = {
  code: string;
  name: string;
  class: CategoryClass;
  refIndex?: string;
};

const CATEGORY_DEFS: CategoryDef[] = [
  { code: "RM-METALS", name: "Metals & Steel", class: "direct", refIndex: "HRC_STEEL" },
  { code: "RM-COPPER", name: "Copper Wire", class: "direct", refIndex: "LME_COPPER" },
  { code: "RM-RESIN", name: "Plastic Resin", class: "direct", refIndex: "BRENT" },
  { code: "PKG-CORR", name: "Corrugated Packaging", class: "direct" },
  { code: "MRO-IND", name: "MRO Industrial", class: "indirect" },
  { code: "IT-HW", name: "IT Hardware", class: "indirect" },
  { code: "IT-SAAS", name: "SaaS Subscriptions", class: "indirect" },
  { code: "OFFICE", name: "Office Supplies", class: "indirect" },
  { code: "MARK-AGY", name: "Marketing Agencies", class: "service" },
  { code: "PROFSVC", name: "Professional Services", class: "service" },
  { code: "TEMPLBR", name: "Temporary Labor", class: "service" },
  { code: "FREIGHT", name: "Freight & Logistics", class: "service" },
];

const COUNTRIES = ["US", "MX", "CN", "DE", "VN", "IN", "BR", "TR"] as const;
const BUS = ["NA Mfg", "EU Mfg", "APAC Distribution", "Corporate"] as const;
const SITES = ["Plant-1", "Plant-2", "DC-East", "DC-West", "HQ"] as const;
const CARRIERS = ["Maersk", "DHL", "FedEx", "UPS", "XPO", "JB Hunt"] as const;
const FREIGHT_MODES: FreightMode[] = ["ocean", "air", "ltl", "tl", "parcel"];

// ------------------------------------------------------------------- TENANT --

type Ctx = {
  orgId: string;
  apiToken: string;
  categoryByCode: Map<string, string>;
  catRows: { id: string; code: string; class: CategoryClass; refIndex?: string }[];
  itemRows: {
    id: string;
    sku: string;
    description: string;
    categoryId: string;
    spendClass: CategoryClass;
    nominalUnitCost: number;
    uom: string;
  }[];
  supplierRows: {
    id: string;
    name: string;
    isStrategic: boolean;
    isPreferred: boolean;
    preferredItemIds: string[];
    paymentTermsDays: number;
    countryCode: string;
  }[];
  contractRows: {
    id: string;
    supplierId: string;
    categoryId: string;
    contractedItems: { itemId: string; sku: string; price: number; tier: number }[];
    referenceIndex: string | null;
    paymentTermsDays: number;
  }[];
};

async function seedOrg(opts: {
  id: string;
  name: string;
  slug: string;
  successFeePct: number;
  scale: "f500" | "small";
}): Promise<Ctx> {
  console.log(`[seed] org ${opts.name} (${opts.scale})`);
  await db.insert(orgsTable).values({
    id: opts.id,
    name: opts.name,
    slug: opts.slug,
    successFeePct: opts.successFeePct.toFixed(2),
    settings: { tier: "F500" },
  });
  await db.insert(usersTable).values([
    {
      id: newId("usr"),
      orgId: opts.id,
      email: `lead@${opts.slug}.example`,
      name: "Procurement Lead",
      role: "admin",
    },
    {
      id: newId("usr"),
      orgId: opts.id,
      email: `buyer@${opts.slug}.example`,
      name: "Buyer Bob",
      role: "buyer",
    },
  ]);

  // Categories
  const categoryByCode = new Map<string, string>();
  const catRows: Ctx["catRows"] = [];
  for (const c of CATEGORY_DEFS) {
    const id = newId("cat");
    categoryByCode.set(c.code, id);
    catRows.push({
      id,
      code: c.code,
      class: c.class,
      refIndex: c.refIndex,
    });
    await db.insert(categoriesTable).values({
      id,
      orgId: opts.id,
      code: c.code,
      name: c.name,
      class: c.class,
    });
  }

  // Items
  const itemCount = opts.scale === "f500" ? 250 : 15;
  const itemRows: Ctx["itemRows"] = [];
  for (let i = 0; i < itemCount; i++) {
    const cat = pick(catRows);
    const sku = `SKU-${cat.code}-${String(1000 + i).padStart(4, "0")}`;
    const description = `${cat.code} part ${i}`;
    const nominalUnitCost = +(frange(2, 800)).toFixed(2);
    const uom = pick(["EA", "BOX", "KG", "M", "HR"] as const);
    const id = newId("item");
    itemRows.push({
      id,
      sku,
      description,
      categoryId: cat.id,
      spendClass: cat.class,
      nominalUnitCost,
      uom,
    });
    await db.insert(itemsTable).values({
      id,
      orgId: opts.id,
      sku,
      description,
      normalizedKey: slug(description),
      categoryId: cat.id,
      uom,
      sourceSystem: "seed",
      sourceExternalId: sku,
    });
  }

  // Suppliers — large tail + a strategic few
  const supplierCount = opts.scale === "f500" ? 800 : 15;
  const strategicSupplierCount = opts.scale === "f500" ? 30 : 2;
  const preferredSupplierCount = opts.scale === "f500" ? 90 : 4;
  const supplierRows: Ctx["supplierRows"] = [];
  for (let i = 0; i < supplierCount; i++) {
    const id = newId("sup");
    const isStrategic = i < strategicSupplierCount;
    const isPreferred = i < preferredSupplierCount;
    const name = `${pick(["Acme", "Globex", "Initech", "Stark", "Wayne", "Umbrella", "Hooli", "Cyberdyne", "Tyrell", "Pied Piper"])} ${pick(["Industries", "Components", "Logistics", "Materials", "Solutions", "Group", "Partners", "Supply Co"])} #${i}`;
    const paymentTermsDays = pick([15, 30, 30, 30, 45, 60, 60]);
    const countryCode = pick(COUNTRIES);
    supplierRows.push({
      id,
      name,
      isStrategic,
      isPreferred,
      preferredItemIds: [],
      paymentTermsDays,
      countryCode,
    });
    await db.insert(suppliersTable).values({
      id,
      orgId: opts.id,
      name,
      normalizedName: slug(name),
      countryCode,
      paymentTermsDays: String(paymentTermsDays),
      isStrategic,
      isPreferred,
      tags: isStrategic ? ["strategic"] : isPreferred ? ["preferred"] : [],
      sourceSystem: "seed",
      sourceExternalId: `EXT-SUP-${i}`,
    });
  }

  // Contracts — 30 active for F500. Each binds a preferred supplier to a category
  // with item pricing + tiered volume thresholds.
  const contractCount = opts.scale === "f500" ? 80 : 4;
  const contractRows: Ctx["contractRows"] = [];
  for (let i = 0; i < contractCount; i++) {
    const supplier = supplierRows[i % preferredSupplierCount]!;
    const cat = pick(catRows);
    const contractId = newId("ctr");
    const startDate = new Date(Date.UTC(2025, irange(0, 5), 1));
    const endDate = new Date(Date.UTC(2026, irange(6, 11), 28));
    const itemPool = itemRows.filter((it) => it.categoryId === cat.id);
    const chosen = itemPool.slice(0, Math.min(5, itemPool.length));
    if (chosen.length === 0) continue;
    const contractedItems = chosen.map((it) => {
      // Slight discount vs nominal — contract should win.
      const price = +(it.nominalUnitCost * frange(0.85, 0.95)).toFixed(2);
      return { itemId: it.id, sku: it.sku, price, tier: 200 };
    });
    const annualBaseline = contractedItems.reduce(
      (s, ci) => s + ci.price * 1000,
      0,
    );
    const refIndex = cat.refIndex ?? null;
    contractRows.push({
      id: contractId,
      supplierId: supplier.id,
      categoryId: cat.id,
      contractedItems,
      referenceIndex: refIndex,
      paymentTermsDays: supplier.paymentTermsDays,
    });
    supplier.preferredItemIds.push(...chosen.map((c) => c.id));

    await db.insert(contractsTable).values({
      id: contractId,
      orgId: opts.id,
      supplierId: supplier.id,
      categoryId: cat.id,
      contractNumber: `CTR-${1000 + i}`,
      title: `${supplier.name} ${cat.code} Contract`,
      status: "active",
      startDate,
      endDate,
      paymentTermsDays: supplier.paymentTermsDays,
      referenceIndex: refIndex,
      annualBaselineUsd: annualBaseline.toFixed(2),
      sourceSystem: "seed",
      sourceExternalId: `EXT-CTR-${i}`,
    });
    for (const ci of contractedItems) {
      await db.insert(contractItemsTable).values({
        id: newId("cli"),
        orgId: opts.id,
        contractId,
        itemId: ci.itemId,
        sku: ci.sku,
        contractedUnitPriceUsd: ci.price.toFixed(4),
        // Volume-tiered pricing: at 500+ units the price drops 8%, at 1000+ another 5%.
        tiers: [
          { minQty: 0, unitPriceUsd: ci.price },
          { minQty: 500, unitPriceUsd: +(ci.price * 0.92).toFixed(4) },
          { minQty: 1000, unitPriceUsd: +(ci.price * 0.87).toFixed(4) },
        ],
      });
    }
  }

  // Provision a default API token for this tenant. The plaintext is printed
  // by main() so operators can copy it. Only the sha256 hash is stored.
  const plainToken = `proc_${randomBytes(24).toString("base64url")}`;
  await db.insert(orgApiTokensTable).values({
    id: newId("tok"),
    orgId: opts.id,
    label: "default",
    tokenHash: hashToken(plainToken),
  });

  return {
    orgId: opts.id,
    apiToken: plainToken,
    categoryByCode,
    catRows,
    itemRows,
    supplierRows,
    contractRows,
  };
}

// ----------------------------------------------------------- TRANSACTIONS --

async function bulkInsert<T>(
  table: { _: { name: string } },
  rows: T[],
  insertFn: (chunk: T[]) => Promise<unknown>,
  chunkSize = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insertFn(rows.slice(i, i + chunkSize));
  }
  void table;
}

async function seedTransactions(ctx: Ctx, scale: "f500" | "small"): Promise<void> {
  const poCount = scale === "f500" ? 12000 : 40;
  console.log(`[seed]   transactions: ${poCount} POs (batched)`);

  // Lever-trigger plan: ~25% maverick (no contract); ~20% contract leakage
  // (above contracted price); ~3% duplicate-payment pairs; ~10% missed-volume
  // contracts (hit by lots of small orders that never reach 500-unit tier);
  // ~30 SKUs with widely varying prices for the SKU-benchmark lever.
  const allInvoices: { id: string; supplierId: string; amount: number; date: Date; poId: string; dedupKey: string }[] = [];

  // Accumulate batches; each table flushed in 500-row chunks.
  const poBatch: (typeof purchaseOrdersTable.$inferInsert)[] = [];
  const polBatch: (typeof poLinesTable.$inferInsert)[] = [];
  const invBatch: (typeof invoicesTable.$inferInsert)[] = [];
  const payBatch: (typeof paymentsTable.$inferInsert)[] = [];
  const shpBatch: (typeof shipmentsTable.$inferInsert)[] = [];

  for (let i = 0; i < poCount; i++) {
    const isMaverick = rand() < 0.25;
    const supplier = isMaverick
      ? ctx.supplierRows[
          ctx.supplierRows.length > 30
            ? irange(30, ctx.supplierRows.length - 1)
            : irange(0, ctx.supplierRows.length - 1)
        ]!
      : pick(ctx.supplierRows.slice(0, Math.min(15, ctx.supplierRows.length)));

    const contract = isMaverick
      ? null
      : ctx.contractRows.find((c) => c.supplierId === supplier.id) ?? null;

    const poId = newId("po");
    const orderDate = new Date(
      Date.UTC(2025, irange(8, 11), irange(1, 28)),
    );
    const businessUnit = pick(BUS);
    const site = pick(SITES);

    const lineCount = irange(1, 4);
    const lineItems: typeof ctx.itemRows = [];
    for (let l = 0; l < lineCount; l++) {
      const sourcePool = contract
        ? ctx.itemRows.filter((it) =>
            contract.contractedItems.some((c) => c.itemId === it.id),
          )
        : ctx.itemRows;
      if (sourcePool.length === 0) continue;
      lineItems.push(pick(sourcePool));
    }

    let totalUsd = 0;
    const lines: {
      sku: string;
      qty: number;
      unitPriceUsd: number;
      extendedUsd: number;
      itemId: string;
      categoryId: string;
      spendClass: CategoryClass;
      description: string;
    }[] = [];

    for (const item of lineItems) {
      const contractItem = contract?.contractedItems.find(
        (ci) => ci.itemId === item.id,
      );
      const leakageHit = contract && rand() < 0.3;
      const skuBenchmarkSpread = rand() < 0.15 ? frange(1.2, 1.8) : 1.0;
      const basePrice = contractItem
        ? leakageHit
          ? contractItem.price * frange(1.05, 1.25)
          : contractItem.price
        : item.nominalUnitCost * frange(0.95, 1.4) * skuBenchmarkSpread;
      const unitPriceUsd = +basePrice.toFixed(4);
      const qty = irange(1, 80);
      const extendedUsd = +(unitPriceUsd * qty).toFixed(2);
      totalUsd += extendedUsd;
      lines.push({
        sku: item.sku,
        qty,
        unitPriceUsd,
        extendedUsd,
        itemId: item.id,
        categoryId: item.categoryId,
        spendClass: item.spendClass,
        description: item.description,
      });
    }

    if (lines.length === 0) continue;

    poBatch.push({
      id: poId,
      orgId: ctx.orgId,
      poNumber: `PO-${100000 + i}`,
      supplierId: supplier.id,
      contractId: contract?.id ?? null,
      businessUnit,
      site,
      status: pick(["open", "received", "closed"] as const),
      orderDate,
      totalUsd: totalUsd.toFixed(2),
      sourceSystem: "seed",
      sourceExternalId: `EXT-PO-${i}`,
    });

    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li]!;
      polBatch.push({
        id: newId("pol"),
        orgId: ctx.orgId,
        poId,
        lineNumber: li + 1,
        itemId: ln.itemId,
        sku: ln.sku,
        description: ln.description,
        categoryId: ln.categoryId,
        spendClass: ln.spendClass,
        qty: ln.qty.toFixed(4),
        uom: "EA",
        unitPriceUsd: ln.unitPriceUsd.toFixed(4),
        extendedUsd: ln.extendedUsd.toFixed(2),
        orderDate,
      });
    }

    const invoiceId = newId("inv");
    const invoiceDate = new Date(orderDate.getTime() + 1000 * 60 * 60 * 24 * 7);
    const dedupKey = `${supplier.id}|${totalUsd.toFixed(2)}|${invoiceDate.toISOString().slice(0, 10)}`;
    invBatch.push({
      id: invoiceId,
      orgId: ctx.orgId,
      invoiceNumber: `INV-${500000 + i}`,
      supplierId: supplier.id,
      poId,
      invoiceDate,
      amountUsd: totalUsd.toFixed(2),
      status: pick(["received", "approved", "paid"] as const),
      dedupKey,
      sourceSystem: "seed",
      sourceExternalId: `EXT-INV-${i}`,
    });
    allInvoices.push({
      id: invoiceId,
      supplierId: supplier.id,
      amount: totalUsd,
      date: invoiceDate,
      poId,
      dedupKey,
    });

    if (rand() < 0.7) {
      payBatch.push({
        id: newId("pay"),
        orgId: ctx.orgId,
        invoiceId,
        paidDate: new Date(invoiceDate.getTime() + 1000 * 60 * 60 * 24 * supplier.paymentTermsDays),
        amountUsd: totalUsd.toFixed(2),
        paymentTermsDays: supplier.paymentTermsDays,
        sourceSystem: "seed",
        sourceExternalId: `EXT-PAY-${i}`,
      });
    }

    if (rand() < 0.5 && totalUsd > 500) {
      shpBatch.push({
        id: newId("shp"),
        orgId: ctx.orgId,
        poId,
        supplierId: supplier.id,
        carrier: pick(CARRIERS),
        mode: pick(FREIGHT_MODES),
        originCountry: supplier.countryCode,
        destCountry: "US",
        laneKey: `${supplier.countryCode}-US`,
        weightKg: irange(50, 5000).toFixed(2),
        freightCostUsd: (totalUsd * frange(0.04, 0.12)).toFixed(2),
        incoterms: pick(["FOB", "CIF", "DDP", "EXW"]),
        shipDate: orderDate,
        sourceSystem: "seed",
        sourceExternalId: `EXT-SHP-${i}`,
      });
    }
  }

  // Bulk-insert each table in 500-row chunks. POs must precede po_lines (FK).
  await bulkInsert(purchaseOrdersTable, poBatch, (chunk) =>
    db.insert(purchaseOrdersTable).values(chunk),
  );
  console.log(`[seed]     ${poBatch.length} POs inserted`);
  await bulkInsert(poLinesTable, polBatch, (chunk) =>
    db.insert(poLinesTable).values(chunk),
  );
  console.log(`[seed]     ${polBatch.length} PO lines inserted`);
  await bulkInsert(invoicesTable, invBatch, (chunk) =>
    db.insert(invoicesTable).values(chunk),
  );
  console.log(`[seed]     ${invBatch.length} invoices inserted`);
  await bulkInsert(paymentsTable, payBatch, (chunk) =>
    db.insert(paymentsTable).values(chunk),
  );
  console.log(`[seed]     ${payBatch.length} payments inserted`);
  await bulkInsert(shipmentsTable, shpBatch, (chunk) =>
    db.insert(shipmentsTable).values(chunk),
  );
  console.log(`[seed]     ${shpBatch.length} shipments inserted`);

  // Duplicate-payment lever — clone N invoices with same dedupKey.
  const dupCount = scale === "f500" ? 60 : 2;
  const dupBatch: (typeof invoicesTable.$inferInsert)[] = [];
  for (let i = 0; i < dupCount && i < allInvoices.length; i++) {
    const src = allInvoices[i]!;
    dupBatch.push({
      id: newId("inv"),
      orgId: ctx.orgId,
      invoiceNumber: `INV-DUP-${i}`,
      supplierId: src.supplierId,
      poId: src.poId,
      invoiceDate: src.date,
      amountUsd: src.amount.toFixed(2),
      status: "received",
      dedupKey: src.dedupKey,
      sourceSystem: "seed",
      sourceExternalId: `EXT-INV-DUP-${i}`,
    });
  }
  if (dupBatch.length > 0) {
    await db.insert(invoicesTable).values(dupBatch);
  }

  // Raw material usage for the few materials with reference indices.
  if (scale === "f500") {
    for (const cat of ctx.catRows) {
      if (!cat.refIndex) continue;
      for (let m = 0; m < 6; m++) {
        const periodStart = new Date(Date.UTC(2025, m + 6, 1));
        const periodEnd = new Date(Date.UTC(2025, m + 7, 0));
        await db.insert(rawMaterialUsageTable).values({
          id: newId("rmu"),
          orgId: ctx.orgId,
          materialCode: cat.code,
          materialName: cat.code,
          referenceIndex: cat.refIndex,
          qty: irange(1000, 5000).toFixed(4),
          uom: "KG",
          unitCostUsd: frange(2, 9).toFixed(4),
          periodStart,
          periodEnd,
          sourceSystem: "seed",
          sourceExternalId: `EXT-RMU-${cat.code}-${m}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------- HISTORICAL OODA --

async function seedHistoricalCycles(ctx: Ctx, opportunitiesPerCycle: number): Promise<void> {
  console.log(`[seed]   historical cycles + outcomes`);
  // Tier-1 levers we'll make appear in history.
  const tier1Levers: LeverId[] = [
    "sku_price_benchmark",
    "maverick_spend",
    "contract_leakage",
    "duplicate_payment",
    "missed_volume_threshold",
    "payment_term_extension",
    "tail_spend_rationalization",
  ];

  // Initialize per-tenant priors (one per Tier-1 lever).
  for (const lever of tier1Levers) {
    await db
      .insert(learnedPriorsTable)
      .values({
        id: newId("prior"),
        orgId: ctx.orgId,
        leverId: lever,
        projectionMultiplier: "1.0000",
        confidenceWeight: "0.5000",
        evidenceCount: 0,
        approvalCount: 0,
        rejectionCount: 0,
        realizationCount: 0,
        updatedAtCycle: 0,
      })
      .onConflictDoNothing();
  }

  // Build 4 cycles, each with synthetic opportunities + outcomes.
  for (let gen = 1; gen <= 4; gen++) {
    const cycleId = newId("cyc");
    const startedAt = new Date(Date.UTC(2025, 11, gen, 6 + gen, 0, 0));
    const completedAt = new Date(startedAt.getTime() + 60_000);
    let oppsCreated = 0;
    let oppsApproved = 0;
    let oppsRejected = 0;
    let oppsRealized = 0;
    let totalProj = 0;
    let totalReal = 0;

    const supplier = ctx.supplierRows[0]!;
    const category = ctx.catRows[0]!;

    const oppRows: { leverId: LeverId; raw: number; conf: number; status: "approved" | "rejected" | "realized" }[] = [];
    for (let i = 0; i < opportunitiesPerCycle; i++) {
      const lever = tier1Levers[i % tier1Levers.length]!;
      const raw = +(frange(20_000, 220_000)).toFixed(2);
      const conf = +(0.4 + rand() * 0.5).toFixed(4);
      // Realistic outcome distribution that lets priors converge.
      let status: "approved" | "rejected" | "realized" = "realized";
      const r = rand();
      if (r < 0.18) status = "rejected";
      else if (r < 0.35) status = "approved";
      oppRows.push({ leverId: lever, raw, conf, status });
    }

    for (const op of oppRows) {
      const opId = newId("opp");
      const projected = +(op.raw * frange(0.85, 1.05)).toFixed(2);
      const realized =
        op.status === "realized" ? +(projected * frange(0.6, 1.1)).toFixed(2) : 0;
      await db.insert(opportunitiesTable).values({
        id: opId,
        orgId: ctx.orgId,
        cycleId,
        leverId: op.leverId,
        tier: 1,
        title: `Hist ${op.leverId} #${gen}`,
        rationale: `Generation ${gen} historical opportunity for ${op.leverId}`,
        recommendedAction: "Approve and run sourcing event",
        supplierId: supplier.id,
        categoryId: category.id,
        rawProjectedSavingsUsd: op.raw.toFixed(2),
        projectedSavingsUsd: projected.toFixed(2),
        confidence: op.conf.toFixed(4),
        status: op.status,
        realizedSavingsUsd: realized.toFixed(2),
        realizedAt: op.status === "realized" ? completedAt : null,
        rejectedReasonCode: op.status === "rejected" ? "data_quality_issue" : null,
        rejectedReasonNote: op.status === "rejected" ? "Auto-seeded historical rejection" : null,
        inputs: { historical: true, gen },
        createdAt: startedAt,
      });
      oppsCreated += 1;
      totalProj += projected;
      if (op.status === "approved") oppsApproved += 1;
      if (op.status === "rejected") oppsRejected += 1;
      if (op.status === "realized") {
        oppsRealized += 1;
        totalReal += realized;
        await db.insert(decisionsTable).values({
          id: newId("dec"),
          orgId: ctx.orgId,
          opportunityId: opId,
          cycleId,
          eventType: "approve",
          actor: "history@procuro.ai",
        });
        await db.insert(decisionsTable).values({
          id: newId("dec"),
          orgId: ctx.orgId,
          opportunityId: opId,
          cycleId,
          eventType: "realize",
          actor: "history@procuro.ai",
          realizedSavingsUsd: realized.toFixed(2),
        });
      } else if (op.status === "approved") {
        await db.insert(decisionsTable).values({
          id: newId("dec"),
          orgId: ctx.orgId,
          opportunityId: opId,
          cycleId,
          eventType: "approve",
          actor: "history@procuro.ai",
        });
      } else if (op.status === "rejected") {
        await db.insert(decisionsTable).values({
          id: newId("dec"),
          orgId: ctx.orgId,
          opportunityId: opId,
          cycleId,
          eventType: "reject",
          actor: "history@procuro.ai",
          rejectedReasonCode: "data_quality_issue",
          rejectedReasonNote: "Auto-seeded historical rejection",
        });
      }
    }

    // Update priors weighted-Bayesian style off this cycle's outcomes.
    for (const lever of tier1Levers) {
      const evidence = oppRows.filter(
        (o) => o.leverId === lever && o.status === "realized",
      );
      if (evidence.length === 0) continue;
      const meanRatio =
        evidence.reduce(
          (s, _e, _i) => s + frange(0.6, 1.1),
          0,
        ) / evidence.length;
      const PRIOR_WEIGHT = 6;
      const w = evidence.length / (evidence.length + PRIOR_WEIGHT);
      await db
        .update(learnedPriorsTable)
        .set({
          projectionMultiplier: Math.max(
            0.2,
            Math.min(1.5, 1.0 * (1 - w) + meanRatio * w),
          ).toFixed(4),
          confidenceWeight: Math.max(
            0.1,
            Math.min(0.99, 0.5 * (1 - w) + meanRatio * w),
          ).toFixed(4),
          evidenceCount: sql`${learnedPriorsTable.evidenceCount} + ${evidence.length}`,
          realizationCount: sql`${learnedPriorsTable.realizationCount} + ${evidence.length}`,
          approvalCount: sql`${learnedPriorsTable.approvalCount} + ${
            oppRows.filter((o) => o.leverId === lever && o.status === "approved").length
          }`,
          rejectionCount: sql`${learnedPriorsTable.rejectionCount} + ${
            oppRows.filter((o) => o.leverId === lever && o.status === "rejected").length
          }`,
          updatedAtCycle: gen,
          updatedAt: completedAt,
        })
        .where(sql`${learnedPriorsTable.orgId} = ${ctx.orgId} and ${learnedPriorsTable.leverId} = ${lever}`);
    }

    await db.insert(analysisCyclesTable).values({
      id: cycleId,
      orgId: ctx.orgId,
      generation: gen,
      status: "completed",
      triggeredBy: "seed@procuro.ai",
      observePayload: { syntheticHistory: true },
      orientPayload: { priorsApplied: true },
      decidePayload: { oppsRanked: oppsCreated },
      actPayload: { approvals: oppsApproved + oppsRealized, rejections: oppsRejected },
      learnPayload: { priorsUpdated: tier1Levers.length },
      opportunitiesCreated: oppsCreated,
      opportunitiesApproved: oppsApproved + oppsRealized,
      opportunitiesRejected: oppsRejected,
      opportunitiesRealized: oppsRealized,
      totalProjectedUsd: totalProj.toFixed(2),
      totalRealizedUsd: totalReal.toFixed(2),
      startedAt,
      completedAt,
    });
  }
}

// ---------------------------------------------------------- COLLECTORS / SIG --

async function seedCollectorsAndSignals(): Promise<void> {
  console.log(`[seed] collectors + market signals (platform-wide)`);
  const collectorId = "published-commodity-index";
  await db
    .insert(collectorsTable)
    .values({
      id: collectorId,
      name: "Published Commodity Index",
      description: "Tracks LME copper, HRC steel, Brent crude reference indices.",
      posture: "published-data",
      status: "approved",
      owner: "procurement-platform@procuro.ai",
      sourceUrl: "https://www.lme.com/ (mock data)",
      rateLimitRpm: 5,
      killSwitch: 0,
      scheduleCron: "0 6 * * *",
      approvedBy: "platform-admin",
      approvedAt: new Date(),
      notes: "Seeded reference collector. Mock fixture in dev.",
      trustWeight: "0.7500",
    })
    .onConflictDoNothing();

  // A few seed signals so the UI has something on day 0.
  for (const mat of ["LME_COPPER", "HRC_STEEL", "BRENT"] as const) {
    for (let d = 0; d < 4; d++) {
      const observedAt = new Date(Date.now() - 1000 * 60 * 60 * 24 * (3 - d));
      await db.insert(marketSignalsTable).values({
        id: newId("ms"),
        orgId: null,
        collectorId,
        signalType: "commodity_index",
        scopeMaterialCode: mat,
        value: (frange(2, 12) + d * 0.1).toFixed(6),
        unit: "USD/kg",
        currency: "USD",
        observedAt,
        sourceUrl: "https://example.com/index",
        posture: "published-data",
        confidence: "0.8000",
        metadata: { seeded: true },
      });
    }
  }
}

// ----------------------------------------------------------------- ENTRY ----

async function main(): Promise<void> {
  console.log(`[seed] starting full reseed at ${new Date().toISOString()}`);
  await wipeAll();

  const scis = await seedOrg({
    id: "org_scis_proc",
    name: "SCIS Procurement",
    slug: "scis-procurement",
    successFeePct: 20,
    scale: "f500",
  });
  await seedTransactions(scis, "f500");
  await seedHistoricalCycles(scis, 12);

  const pw = await seedOrg({
    id: "org_procureworks",
    name: "ProcureWorks Inc.",
    slug: "procureworks",
    successFeePct: 15,
    scale: "small",
  });
  await seedTransactions(pw, "small");
  await seedHistoricalCycles(pw, 6);

  await seedCollectorsAndSignals();

  console.log(`[seed] complete`);
  console.log(`[seed] -------- API tokens (store securely) --------`);
  console.log(`[seed] org_scis_proc:    ${scis.apiToken}`);
  console.log(`[seed] org_procureworks: ${pw.apiToken}`);
  console.log(`[seed] -------------------------------------------`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
