import { db } from "@workspace/db";
import {
  suppliersTable,
  itemsTable,
  categoriesTable,
  contractsTable,
  contractItemsTable,
  purchaseOrdersTable,
  poLinesTable,
  invoicesTable,
  paymentsTable,
  shipmentsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";
import { CANCELLED_ERROR_MESSAGE } from "../jobs/queue";
import { resolveBillingCurrency } from "../suppliers/billing-currency-resolver";
import type {
  IsCancelledFn,
  SyncProgress,
  SyncResult,
} from "./source-adapter";

/**
 * Auto-detect a supplier's billing currency on ingest when the upstream
 * feed didn't supply one. Mirrors the helper in `csv-adapter.ts` so
 * both the structured-payload path (CSV bulk + live ERP) and the
 * per-entity streaming CSV path apply the same resolution order.
 *
 * Resolution order at ingest:
 *   1. Operator-provided value wins (high, source=`provided`).
 *   2. Else if the row carries an `invoiceSample` (free-form invoice
 *      text — line description, "Total: £1,234.56", an invoice
 *      number with embedded ISO code, etc.) the resolver's
 *      invoice-pattern path fires (ISO → high; symbol → medium).
 *   3. Else if `countryCode` maps to a single-currency country,
 *      auto-apply that (high, source=`country`).
 *   4. Else: leave null. Low-confidence hits (multi-currency or
 *      dollarized economies) are NOT auto-applied here — they're
 *      picked up later by `backfillSupplierBillingCurrency` (PO line
 *      descriptions) or via the `manual_override` Supplier 360
 *      endpoint.
 */
export interface IngestBillingCurrencyDecision {
  billingCurrency: string | null;
  billingCurrencySource:
    | "provided"
    | "country"
    | "invoice_iso"
    | "invoice_symbol"
    | null;
  billingCurrencyConfidence: "high" | "medium" | "low" | null;
}

function autoDetectBillingCurrency(
  explicit: string | null | undefined,
  countryCode: string | null | undefined,
  invoiceSample: string | null | undefined,
  supplierExternalId: string,
): IngestBillingCurrencyDecision {
  const trimmed = explicit?.trim();
  if (trimmed && trimmed.length >= 3) {
    return {
      billingCurrency: trimmed.toUpperCase(),
      billingCurrencySource: "provided",
      billingCurrencyConfidence: "high",
    };
  }
  const samples =
    invoiceSample && invoiceSample.trim() ? [invoiceSample] : [];
  const resolved = resolveBillingCurrency({
    countryCode,
    invoiceSamples: samples,
  });
  if (!resolved) {
    return {
      billingCurrency: null,
      billingCurrencySource: null,
      billingCurrencyConfidence: null,
    };
  }
  if (resolved.confidence === "high" || resolved.confidence === "medium") {
    const source =
      resolved.source === "country"
        ? "country"
        : resolved.source === "invoice_iso"
          ? "invoice_iso"
          : "invoice_symbol";
    return {
      billingCurrency: resolved.currency,
      billingCurrencySource: source,
      billingCurrencyConfidence: resolved.confidence,
    };
  }
  // Low confidence — log and leave it for the post-PO backfill or a
  // manual override.
  logger.info(
    { supplierExternalId, countryCode, resolved },
    "supplier billing currency auto-detect skipped (low confidence)",
  );
  return {
    billingCurrency: null,
    billingCurrencySource: null,
    billingCurrencyConfidence: null,
  };
}

/**
 * Shared structured-payload writer used by both the CSV bulk path and
 * the live ERP connector path. Both ingestion modes produce the same
 * tenant-shaped procurement records (suppliers / categories / items /
 * contracts / POs / invoices / payments / shipments), so the actual DB
 * upserts live here once and the source-system tag (`csv`,
 * `erp_coupa`, …) is parameterised so each ingest path keeps its own
 * conflict identity in the underlying tables.
 *
 * Idempotency contract: every entity is upserted on
 * `(org_id, source_system, source_external_id)` so re-running the same
 * payload (or running a Coupa sync after a CSV bootstrap with
 * overlapping external IDs but a different source_system) updates the
 * existing row in place without duplicating.
 */

export const DEFAULT_BATCH_SIZE = 1000;

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

async function bulkInsert<T>(
  rows: T[],
  insertChunk: (chunk: T[]) => Promise<unknown>,
  chunkSize: number,
  isCancelled: IsCancelledFn | undefined,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    if (isCancelled && (await isCancelled())) {
      throw new Error(CANCELLED_ERROR_MESSAGE);
    }
    await insertChunk(rows.slice(i, i + chunkSize));
  }
}

export interface IngestPayload {
  suppliers?: Array<{
    externalId: string;
    name: string;
    countryCode?: string;
    billingCurrency?: string;
    /**
     * Optional invoice text snippet (line description, "Total: £1,234.56",
     * an invoice number with embedded ISO code). When present and
     * `billingCurrency` is empty, the ingest writer runs the
     * invoice-pattern path on the resolver — symbols → medium
     * confidence, ISO codes → high confidence.
     */
    invoiceSample?: string;
    paymentTermsDays?: string;
    isStrategic?: boolean;
    isPreferred?: boolean;
    tags?: string[];
  }>;
  categories?: Array<{
    externalId: string;
    code: string;
    name: string;
    class: "direct" | "indirect" | "service";
  }>;
  items?: Array<{
    externalId: string;
    sku: string;
    description: string;
    categoryExternalId?: string;
    mfgPartNumber?: string;
    uom?: string;
    normalizedKey?: string;
  }>;
  contracts?: Array<{
    externalId: string;
    contractNumber: string;
    title: string;
    supplierExternalId: string;
    categoryExternalId?: string;
    startDate: string;
    endDate: string;
    paymentTermsDays?: number;
    referenceIndex?: string;
    billingCurrency?: string;
    annualBaselineUsd?: number;
    items: Array<{
      sku: string;
      contractedUnitPriceUsd: number;
      tiers?: { minQty: number; unitPriceUsd: number }[];
    }>;
  }>;
  purchaseOrders?: Array<{
    externalId: string;
    poNumber: string;
    supplierExternalId: string;
    contractExternalId?: string;
    businessUnit?: string;
    site?: string;
    orderDate: string;
    lines: Array<{
      externalId?: string;
      lineNumber: number;
      sku: string;
      description: string;
      categoryExternalId?: string;
      spendClass: "direct" | "indirect" | "service";
      qty: number;
      uom?: string;
      unitPriceUsd: number;
    }>;
  }>;
  invoices?: Array<{
    externalId: string;
    invoiceNumber: string;
    supplierExternalId: string;
    poExternalId?: string;
    invoiceDate: string;
    amountUsd: number;
    dedupKey: string;
    status?: "received" | "approved" | "paid" | "disputed" | "void";
  }>;
  payments?: Array<{
    externalId: string;
    invoiceExternalId: string;
    paidDate: string;
    amountUsd: number;
    paymentTermsDays?: number;
  }>;
  shipments?: Array<{
    externalId: string;
    poExternalId?: string;
    supplierExternalId?: string;
    carrier: string;
    mode: "ocean" | "air" | "ltl" | "tl" | "parcel" | "rail";
    laneKey: string;
    originCountry?: string;
    destCountry?: string;
    weightKg?: number;
    freightCostUsd: number;
    incoterms?: string;
    shipDate: string;
  }>;
}

export interface WriteIngestPayloadArgs {
  orgId: string;
  /**
   * Stable identifier carried into every row's `source_system` column.
   * Use `"csv"` for the CSV bulk-upload path and `"erp_<adapter>"`
   * (e.g. `"erp_coupa"`) for live ERP connectors. The same external id
   * coming from different source systems is treated as different rows
   * by the upsert conflict targets.
   */
  sourceSystem: string;
  payload: IngestPayload;
  batchSize?: number;
  onProgress?: (p: SyncProgress) => Promise<void> | void;
  isCancelled?: IsCancelledFn;
}

/**
 * Write a structured `IngestPayload` to the procurement tables. Returns
 * the canonical `SyncResult` shape, suitable for both
 * `SourceAdapter.fullSync` and the live ERP sync job handler.
 */
export async function writeIngestPayload(
  args: WriteIngestPayloadArgs,
): Promise<SyncResult> {
  const {
    orgId,
    sourceSystem,
    payload,
    batchSize = DEFAULT_BATCH_SIZE,
    onProgress,
    isCancelled,
  } = args;

  const start = Date.now();
  let created = 0;
  let processed = 0;

  const checkpoint = async (): Promise<void> => {
    if (isCancelled && (await isCancelled())) {
      throw new Error(CANCELLED_ERROR_MESSAGE);
    }
  };
  const bulkC = async <T>(
    rows: T[],
    insertChunk: (chunk: T[]) => Promise<unknown>,
  ): Promise<void> => bulkInsert(rows, insertChunk, batchSize, isCancelled);

  await checkpoint();

  // 1. Categories.
  const categoryMap = new Map<string, string>();
  if (payload.categories?.length) {
    const rows = payload.categories.map((c) => ({
      id: newId("cat"),
      orgId,
      code: c.code,
      name: c.name,
      class: c.class,
    }));
    await bulkC(rows, async (chunk) => {
      const inserted = await db
        .insert(categoriesTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [categoriesTable.orgId, categoriesTable.code],
          set: {
            name: sql`excluded.name`,
            class: sql`excluded.class`,
          },
        })
        .returning({ id: categoriesTable.id, code: categoriesTable.code });
      for (const r of inserted) categoryMap.set(r.code, r.id);
    });
    for (const c of payload.categories) {
      const id = categoryMap.get(c.code);
      if (id) categoryMap.set(c.externalId, id);
    }
    created += payload.categories.length;
    processed += payload.categories.length;
    await onProgress?.({ recordsProcessed: processed });
  }

  await checkpoint();

  // 2. Suppliers.
  const supplierMap = new Map<string, string>();
  if (payload.suppliers?.length) {
    const rows = payload.suppliers.map((s) => {
      const decision = autoDetectBillingCurrency(
        s.billingCurrency,
        s.countryCode,
        s.invoiceSample,
        s.externalId,
      );
      return {
        id: newId("sup"),
        orgId,
        name: s.name,
        normalizedName: normalizeName(s.name),
        countryCode: s.countryCode ?? null,
        billingCurrency: decision.billingCurrency,
        billingCurrencySource: decision.billingCurrencySource,
        billingCurrencyConfidence: decision.billingCurrencyConfidence,
        paymentTermsDays: s.paymentTermsDays ?? null,
        isStrategic: s.isStrategic ?? false,
        isPreferred: s.isPreferred ?? false,
        tags: s.tags ?? [],
        sourceSystem,
        sourceExternalId: s.externalId,
      };
    });
    await bulkC(rows, async (chunk) => {
      const inserted = await db
        .insert(suppliersTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            suppliersTable.orgId,
            suppliersTable.sourceSystem,
            suppliersTable.sourceExternalId,
          ],
          set: {
            name: sql`excluded.name`,
            normalizedName: sql`excluded.normalized_name`,
            countryCode: sql`excluded.country_code`,
            // Only overwrite billing_currency / source / confidence on
            // re-ingest if the inbound row carries a non-null value.
            // This protects a `manual_override` from being clobbered by
            // a re-upload that didn't include the column.
            billingCurrency: sql`coalesce(excluded.billing_currency, ${suppliersTable.billingCurrency})`,
            billingCurrencySource: sql`coalesce(excluded.billing_currency_source, ${suppliersTable.billingCurrencySource})`,
            billingCurrencyConfidence: sql`coalesce(excluded.billing_currency_confidence, ${suppliersTable.billingCurrencyConfidence})`,
            isStrategic: sql`excluded.is_strategic`,
            isPreferred: sql`excluded.is_preferred`,
            tags: sql`excluded.tags`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({
          id: suppliersTable.id,
          ext: suppliersTable.sourceExternalId,
        });
      for (const r of inserted) if (r.ext) supplierMap.set(r.ext, r.id);
    });
    created += payload.suppliers.length;
    processed += payload.suppliers.length;
    await onProgress?.({ recordsProcessed: processed });
  }

  await checkpoint();

  // 3. Items.
  const itemMap = new Map<string, string>();
  if (payload.items?.length) {
    const rows = payload.items.map((it) => ({
      id: newId("itm"),
      orgId,
      sku: it.sku,
      description: it.description,
      normalizedKey: it.normalizedKey ?? it.sku.toUpperCase(),
      categoryId: it.categoryExternalId
        ? categoryMap.get(it.categoryExternalId) ?? null
        : null,
      mfgPartNumber: it.mfgPartNumber ?? null,
      uom: it.uom ?? null,
      sourceSystem,
      sourceExternalId: it.externalId,
    }));
    await bulkC(rows, async (chunk) => {
      const inserted = await db
        .insert(itemsTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            itemsTable.orgId,
            itemsTable.sourceSystem,
            itemsTable.sourceExternalId,
          ],
          set: {
            description: sql`excluded.description`,
            normalizedKey: sql`excluded.normalized_key`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({
          id: itemsTable.id,
          ext: itemsTable.sourceExternalId,
        });
      for (const r of inserted) if (r.ext) itemMap.set(r.ext, r.id);
    });
    created += payload.items.length;
    processed += payload.items.length;
    await onProgress?.({ recordsProcessed: processed });
  }

  await checkpoint();

  // 4. Contracts + items.
  const contractMap = new Map<string, string>();
  if (payload.contracts?.length) {
    const rows = payload.contracts
      .filter((c) => supplierMap.has(c.supplierExternalId))
      .map((c) => ({
        id: newId("ctr"),
        orgId,
        supplierId: supplierMap.get(c.supplierExternalId)!,
        categoryId: c.categoryExternalId
          ? categoryMap.get(c.categoryExternalId) ?? null
          : null,
        contractNumber: c.contractNumber,
        title: c.title,
        startDate: new Date(c.startDate),
        endDate: new Date(c.endDate),
        paymentTermsDays: c.paymentTermsDays ?? null,
        referenceIndex: c.referenceIndex ?? null,
        billingCurrency: c.billingCurrency ?? null,
        annualBaselineUsd: c.annualBaselineUsd?.toFixed(2) ?? "0",
        sourceSystem,
        sourceExternalId: c.externalId,
      }));
    await bulkC(rows, async (chunk) => {
      const inserted = await db
        .insert(contractsTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            contractsTable.orgId,
            contractsTable.sourceSystem,
            contractsTable.sourceExternalId,
          ],
          set: {
            title: sql`excluded.title`,
            endDate: sql`excluded.end_date`,
            billingCurrency: sql`excluded.billing_currency`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({
          id: contractsTable.id,
          ext: contractsTable.sourceExternalId,
        });
      for (const r of inserted) if (r.ext) contractMap.set(r.ext, r.id);
    });
    for (const c of payload.contracts) {
      const cid = contractMap.get(c.externalId);
      if (!cid) continue;
      await db.execute(
        sql`DELETE FROM contract_items WHERE contract_id = ${cid}`,
      );
      if (c.items.length === 0) continue;
      const itemRows = c.items.map((ci) => ({
        id: newId("ctri"),
        orgId,
        contractId: cid,
        sku: ci.sku,
        contractedUnitPriceUsd: ci.contractedUnitPriceUsd.toFixed(4),
        tiers: ci.tiers ?? [],
      }));
      await bulkC(itemRows, (chunk) =>
        db.insert(contractItemsTable).values(chunk),
      );
    }
    created += payload.contracts.length;
    processed += payload.contracts.length;
    await onProgress?.({ recordsProcessed: processed });
  }

  await checkpoint();

  // 5. POs + lines.
  const poMap = new Map<string, string>();
  if (payload.purchaseOrders?.length) {
    const valid = payload.purchaseOrders.filter((po) =>
      supplierMap.has(po.supplierExternalId),
    );
    const poRows = valid.map((po) => {
      const totalUsd = po.lines.reduce(
        (acc, l) => acc + l.qty * l.unitPriceUsd,
        0,
      );
      return {
        id: newId("po"),
        orgId,
        poNumber: po.poNumber,
        supplierId: supplierMap.get(po.supplierExternalId)!,
        contractId: po.contractExternalId
          ? contractMap.get(po.contractExternalId) ?? null
          : null,
        businessUnit: po.businessUnit ?? null,
        site: po.site ?? null,
        status: "open" as const,
        orderDate: new Date(po.orderDate),
        totalUsd: totalUsd.toFixed(2),
        sourceSystem,
        sourceExternalId: po.externalId,
      };
    });
    await bulkC(poRows, async (chunk) => {
      const inserted = await db
        .insert(purchaseOrdersTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            purchaseOrdersTable.orgId,
            purchaseOrdersTable.sourceSystem,
            purchaseOrdersTable.sourceExternalId,
          ],
          set: {
            totalUsd: sql`excluded.total_usd`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({
          id: purchaseOrdersTable.id,
          ext: purchaseOrdersTable.sourceExternalId,
        });
      for (const r of inserted) if (r.ext) poMap.set(r.ext, r.id);
    });

    const allLines: (typeof poLinesTable.$inferInsert)[] = [];
    for (const po of valid) {
      const poId = poMap.get(po.externalId);
      if (!poId) continue;
      const orderDate = new Date(po.orderDate);
      for (const ln of po.lines) {
        const lineExtId =
          ln.externalId ?? `${po.externalId}#${ln.lineNumber}`;
        allLines.push({
          id: newId("pol"),
          orgId,
          poId,
          lineNumber: ln.lineNumber,
          sku: ln.sku,
          description: ln.description,
          categoryId: ln.categoryExternalId
            ? categoryMap.get(ln.categoryExternalId) ?? null
            : null,
          spendClass: ln.spendClass,
          qty: ln.qty.toFixed(4),
          uom: ln.uom ?? null,
          unitPriceUsd: ln.unitPriceUsd.toFixed(4),
          extendedUsd: (ln.qty * ln.unitPriceUsd).toFixed(2),
          orderDate,
          sourceSystem,
          sourceExternalId: lineExtId,
        });
      }
    }
    await bulkC(allLines, (chunk) =>
      db
        .insert(poLinesTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            poLinesTable.orgId,
            poLinesTable.sourceSystem,
            poLinesTable.sourceExternalId,
          ],
          set: {
            qty: sql`excluded.qty`,
            unitPriceUsd: sql`excluded.unit_price_usd`,
            extendedUsd: sql`excluded.extended_usd`,
            description: sql`excluded.description`,
            categoryId: sql`excluded.category_id`,
            spendClass: sql`excluded.spend_class`,
            uom: sql`excluded.uom`,
            sourceSyncedAt: sql`now()`,
          },
        }),
    );
    created += valid.length;
    processed += valid.length;
    await onProgress?.({ recordsProcessed: processed });
  }

  await checkpoint();

  // 6. Invoices.
  const invoiceMap = new Map<string, string>();
  if (payload.invoices?.length) {
    const rows = payload.invoices
      .filter((inv) => supplierMap.has(inv.supplierExternalId))
      .map((inv) => ({
        id: newId("inv"),
        orgId,
        invoiceNumber: inv.invoiceNumber,
        supplierId: supplierMap.get(inv.supplierExternalId)!,
        poId: inv.poExternalId ? poMap.get(inv.poExternalId) ?? null : null,
        invoiceDate: new Date(inv.invoiceDate),
        amountUsd: inv.amountUsd.toFixed(2),
        status: inv.status ?? "received",
        dedupKey: inv.dedupKey,
        sourceSystem,
        sourceExternalId: inv.externalId,
      }));
    await bulkC(rows, async (chunk) => {
      const inserted = await db
        .insert(invoicesTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            invoicesTable.orgId,
            invoicesTable.sourceSystem,
            invoicesTable.sourceExternalId,
          ],
          set: { sourceSyncedAt: sql`now()` },
        })
        .returning({
          id: invoicesTable.id,
          ext: invoicesTable.sourceExternalId,
        });
      for (const r of inserted) if (r.ext) invoiceMap.set(r.ext, r.id);
    });
    created += payload.invoices.length;
    processed += payload.invoices.length;
  }

  await checkpoint();

  // 7. Payments.
  if (payload.payments?.length) {
    const rows = payload.payments
      .filter((p) => invoiceMap.has(p.invoiceExternalId))
      .map((p) => ({
        id: newId("pay"),
        orgId,
        invoiceId: invoiceMap.get(p.invoiceExternalId)!,
        paidDate: new Date(p.paidDate),
        amountUsd: p.amountUsd.toFixed(2),
        paymentTermsDays: p.paymentTermsDays ?? null,
        sourceSystem,
        sourceExternalId: p.externalId,
      }));
    await bulkC(rows, (chunk) =>
      db.insert(paymentsTable).values(chunk).onConflictDoNothing(),
    );
    created += rows.length;
    processed += rows.length;
  }

  await checkpoint();

  // 8. Shipments.
  if (payload.shipments?.length) {
    const rows = payload.shipments.map((sh) => ({
      id: newId("shp"),
      orgId,
      poId: sh.poExternalId ? poMap.get(sh.poExternalId) ?? null : null,
      supplierId: sh.supplierExternalId
        ? supplierMap.get(sh.supplierExternalId) ?? null
        : null,
      carrier: sh.carrier,
      mode: sh.mode,
      originCountry: sh.originCountry ?? null,
      destCountry: sh.destCountry ?? null,
      laneKey: sh.laneKey,
      weightKg: sh.weightKg?.toFixed(2) ?? null,
      freightCostUsd: sh.freightCostUsd.toFixed(2),
      incoterms: sh.incoterms ?? null,
      shipDate: new Date(sh.shipDate),
      sourceSystem,
      sourceExternalId: sh.externalId,
    }));
    await bulkC(rows, (chunk) =>
      db.insert(shipmentsTable).values(chunk).onConflictDoNothing(),
    );
    created += rows.length;
    processed += rows.length;
  }

  return {
    recordsProcessed: processed,
    recordsCreated: created,
    recordsUpdated: 0,
    recordsDeleted: 0,
    cursor: new Date().toISOString(),
    durationMs: Date.now() - start,
  };
}
