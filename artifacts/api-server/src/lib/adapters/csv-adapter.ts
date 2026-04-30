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
import { sql, and, eq, inArray } from "drizzle-orm";
import { parse, type Parser } from "csv-parse";
import type { Readable } from "node:stream";
import { newId } from "../ids";
import { logger } from "../logger";
import type { SourceAdapter, SyncResult } from "./source-adapter";

/**
 * CSV ingestion. Two entry points:
 *
 * 1. `csvSourceAdapter.fullSync({ orgId, config })` — accepts a structured
 *    JSON payload (`CsvPayload`) for the legacy demo path. All inserts are
 *    bulk-batched in 1000-row chunks for F500-scale data sets.
 *
 * 2. `streamCsvEntity({ orgId, entity, input })` — true streaming ingestion
 *    of a single entity's CSV file. The Node Readable is piped through
 *    `csv-parse`, rows are accumulated into BATCH_SIZE-row batches, and each
 *    batch is bulk-upserted via `INSERT ... ON CONFLICT DO UPDATE`. Memory
 *    stays bounded at ~`BATCH_SIZE` rows regardless of file size.
 */

// ---------- shared ----------

const SOURCE = "csv";
const BATCH_SIZE = 1000;

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

async function bulkInsert<T>(
  rows: T[],
  insertChunk: (chunk: T[]) => Promise<unknown>,
  chunkSize = BATCH_SIZE,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insertChunk(rows.slice(i, i + chunkSize));
  }
}

// ---------- structured JSON payload (legacy demo path) ----------

export interface CsvPayload {
  suppliers?: Array<{
    externalId: string;
    name: string;
    countryCode?: string;
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

export const csvSourceAdapter: SourceAdapter<CsvPayload> = {
  key: "csv",
  label: "CSV Bulk Upload",

  async fullSync({ orgId, config, onProgress }): Promise<SyncResult> {
    const start = Date.now();
    let created = 0;
    let processed = 0;

    // 1. Categories — bulk upsert, then build code→id map.
    const categoryMap = new Map<string, string>();
    if (config.categories?.length) {
      const rows = config.categories.map((c) => ({
        id: newId("cat"),
        orgId,
        code: c.code,
        name: c.name,
        class: c.class,
      }));
      await bulkInsert(rows, async (chunk) => {
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
      // Map externalId → id via code lookup.
      for (const c of config.categories) {
        const id = categoryMap.get(c.code);
        if (id) categoryMap.set(c.externalId, id);
      }
      created += config.categories.length;
      processed += config.categories.length;
      await onProgress?.({ recordsProcessed: processed });
    }

    // 2. Suppliers — bulk upsert by (org, source_system, source_external_id).
    const supplierMap = new Map<string, string>();
    if (config.suppliers?.length) {
      const rows = config.suppliers.map((s) => ({
        id: newId("sup"),
        orgId,
        name: s.name,
        normalizedName: normalizeName(s.name),
        countryCode: s.countryCode ?? null,
        paymentTermsDays: s.paymentTermsDays ?? null,
        isStrategic: s.isStrategic ?? false,
        isPreferred: s.isPreferred ?? false,
        tags: s.tags ?? [],
        sourceSystem: SOURCE,
        sourceExternalId: s.externalId,
      }));
      await bulkInsert(rows, async (chunk) => {
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
      created += config.suppliers.length;
      processed += config.suppliers.length;
      await onProgress?.({ recordsProcessed: processed });
    }

    // 3. Items — bulk upsert.
    const itemMap = new Map<string, string>();
    if (config.items?.length) {
      const rows = config.items.map((it) => ({
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
        sourceSystem: SOURCE,
        sourceExternalId: it.externalId,
      }));
      await bulkInsert(rows, async (chunk) => {
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
      created += config.items.length;
      processed += config.items.length;
      await onProgress?.({ recordsProcessed: processed });
    }

    // 4. Contracts + items — contracts bulk-upserted, then per-contract item
    // wipe+insert (item lists are typically tiny; bulk-insert each).
    const contractMap = new Map<string, string>();
    if (config.contracts?.length) {
      const rows = config.contracts
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
          annualBaselineUsd: c.annualBaselineUsd?.toFixed(2) ?? "0",
          sourceSystem: SOURCE,
          sourceExternalId: c.externalId,
        }));
      await bulkInsert(rows, async (chunk) => {
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
              sourceSyncedAt: sql`now()`,
            },
          })
          .returning({
            id: contractsTable.id,
            ext: contractsTable.sourceExternalId,
          });
        for (const r of inserted) if (r.ext) contractMap.set(r.ext, r.id);
      });
      // Contract items: wipe + insert per contract.
      for (const c of config.contracts) {
        const cid = contractMap.get(c.externalId);
        if (!cid) continue;
        await db.execute(sql`DELETE FROM contract_items WHERE contract_id = ${cid}`);
        if (c.items.length === 0) continue;
        const itemRows = c.items.map((ci) => ({
          id: newId("ctri"),
          orgId,
          contractId: cid,
          sku: ci.sku,
          contractedUnitPriceUsd: ci.contractedUnitPriceUsd.toFixed(4),
          tiers: ci.tiers ?? [],
        }));
        await bulkInsert(itemRows, (chunk) =>
          db.insert(contractItemsTable).values(chunk),
        );
      }
      created += config.contracts.length;
      processed += config.contracts.length;
      await onProgress?.({ recordsProcessed: processed });
    }

    // 5. POs + lines — POs bulk-upsert, lines wiped+bulk-inserted per PO.
    const poMap = new Map<string, string>();
    if (config.purchaseOrders?.length) {
      const valid = config.purchaseOrders.filter((po) =>
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
          sourceSystem: SOURCE,
          sourceExternalId: po.externalId,
        };
      });
      await bulkInsert(poRows, async (chunk) => {
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

      // PO lines upsert by source identity; line ext-id falls back to
      // `${po.externalId}#${lineNumber}` when not provided.
      const allLines: (typeof poLinesTable.$inferInsert)[] = [];
      for (const po of valid) {
        const poId = poMap.get(po.externalId);
        if (!poId) continue;
        const orderDate = new Date(po.orderDate);
        for (const ln of po.lines) {
          const lineExtId = ln.externalId ?? `${po.externalId}#${ln.lineNumber}`;
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
            sourceSystem: SOURCE,
            sourceExternalId: lineExtId,
          });
        }
      }
      await bulkInsert(allLines, (chunk) =>
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

    // 6. Invoices — bulk upsert.
    const invoiceMap = new Map<string, string>();
    if (config.invoices?.length) {
      const rows = config.invoices
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
          sourceSystem: SOURCE,
          sourceExternalId: inv.externalId,
        }));
      await bulkInsert(rows, async (chunk) => {
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
      created += config.invoices.length;
      processed += config.invoices.length;
    }

    // 7. Payments — bulk insert (skip if invoice not in this batch).
    if (config.payments?.length) {
      const rows = config.payments
        .filter((p) => invoiceMap.has(p.invoiceExternalId))
        .map((p) => ({
          id: newId("pay"),
          orgId,
          invoiceId: invoiceMap.get(p.invoiceExternalId)!,
          paidDate: new Date(p.paidDate),
          amountUsd: p.amountUsd.toFixed(2),
          paymentTermsDays: p.paymentTermsDays ?? null,
          sourceSystem: SOURCE,
          sourceExternalId: p.externalId,
        }));
      await bulkInsert(rows, (chunk) =>
        db.insert(paymentsTable).values(chunk).onConflictDoNothing(),
      );
      created += rows.length;
      processed += rows.length;
    }

    // 8. Shipments — bulk insert.
    if (config.shipments?.length) {
      const rows = config.shipments.map((sh) => ({
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
        sourceSystem: SOURCE,
        sourceExternalId: sh.externalId,
      }));
      await bulkInsert(rows, (chunk) =>
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
  },

  async incrementalSync(args) {
    return this.fullSync(args);
  },
};

// ---------- streaming CSV (per-entity, file-of-any-size) ----------

export type CsvEntity =
  | "suppliers"
  | "categories"
  | "items"
  | "purchase_orders"
  | "po_lines"
  | "invoices"
  | "payments"
  | "shipments";

export interface StreamCsvResult {
  entity: CsvEntity;
  rowsParsed: number;
  rowsInserted: number;
  durationMs: number;
}

interface StreamCsvArgs {
  orgId: string;
  entity: CsvEntity;
  input: Readable;
  /** Override default batch size (default 1000). */
  batchSize?: number;
}

/**
 * Stream-parse a single-entity CSV file and bulk-upsert in fixed-size
 * batches. Backpressure is honored via Parser stream events; memory stays
 * bounded at `batchSize` rows regardless of file size.
 */
export async function streamCsvEntity(
  args: StreamCsvArgs,
): Promise<StreamCsvResult> {
  const start = Date.now();
  const batchSize = args.batchSize ?? BATCH_SIZE;
  let rowsParsed = 0;
  let rowsInserted = 0;
  let buffer: Record<string, string>[] = [];

  const parser: Parser = args.input.pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
    }),
  );

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const chunk = buffer;
    buffer = [];
    const inserted = await flushBatch(args.orgId, args.entity, chunk);
    rowsInserted += inserted;
  };

  try {
    for await (const row of parser) {
      buffer.push(row as Record<string, string>);
      rowsParsed++;
      if (buffer.length >= batchSize) {
        // Pause backpressure: pause underlying stream while we flush.
        args.input.pause();
        await flush();
        args.input.resume();
      }
    }
    await flush();
  } catch (err) {
    logger.error(
      { entity: args.entity, rowsParsed, err: (err as Error).message },
      "CSV stream parse failed",
    );
    throw err;
  }

  return {
    entity: args.entity,
    rowsParsed,
    rowsInserted,
    durationMs: Date.now() - start,
  };
}

// Per-entity row mapping + bulk upsert.
async function flushBatch(
  orgId: string,
  entity: CsvEntity,
  rows: Record<string, string>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  switch (entity) {
    case "suppliers": {
      const v = rows.map((r) => ({
        id: newId("sup"),
        orgId,
        name: r["name"]!,
        normalizedName: normalizeName(r["name"]!),
        countryCode: r["countryCode"] ?? null,
        paymentTermsDays: r["paymentTermsDays"] ?? null,
        isStrategic: r["isStrategic"] === "true",
        isPreferred: r["isPreferred"] === "true",
        tags: [] as string[],
        sourceSystem: SOURCE,
        sourceExternalId: r["externalId"]!,
      }));
      const out = await db
        .insert(suppliersTable)
        .values(v)
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
            isStrategic: sql`excluded.is_strategic`,
            isPreferred: sql`excluded.is_preferred`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: suppliersTable.id });
      return out.length;
    }
    case "categories": {
      const v = rows.map((r) => ({
        id: newId("cat"),
        orgId,
        code: r["code"]!,
        name: r["name"]!,
        class: (r["class"] as "direct" | "indirect" | "service") ?? "indirect",
      }));
      const out = await db
        .insert(categoriesTable)
        .values(v)
        .onConflictDoUpdate({
          target: [categoriesTable.orgId, categoriesTable.code],
          set: {
            name: sql`excluded.name`,
            class: sql`excluded.class`,
          },
        })
        .returning({ id: categoriesTable.id });
      return out.length;
    }
    case "items": {
      const v = rows.map((r) => ({
        id: newId("itm"),
        orgId,
        sku: r["sku"]!,
        description: r["description"] ?? r["sku"]!,
        normalizedKey: r["normalizedKey"] ?? r["sku"]!.toUpperCase(),
        mfgPartNumber: r["mfgPartNumber"] ?? null,
        uom: r["uom"] ?? null,
        sourceSystem: SOURCE,
        sourceExternalId: r["externalId"]!,
      }));
      const out = await db
        .insert(itemsTable)
        .values(v)
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
        .returning({ id: itemsTable.id });
      return out.length;
    }
    case "invoices": {
      // Support both the streaming-native shape (`supplierId`/`poId` = real DB
      // ids) AND the page CSV shape (`supplierExternalId`/`poExternalId` =
      // source ids that need to be looked up). The page validator enforces the
      // external-id columns, so most real uploads go through the lookup path.
      const supExtIds = Array.from(
        new Set(
          rows
            .map((r) => r["supplierExternalId"])
            .filter((x): x is string => Boolean(x)),
        ),
      );
      const poExtIds = Array.from(
        new Set(
          rows
            .map((r) => r["poExternalId"])
            .filter((x): x is string => Boolean(x)),
        ),
      );
      const supLookup = new Map<string, string>();
      const poLookup = new Map<string, string>();
      if (supExtIds.length > 0) {
        const supRows = await db
          .select({
            id: suppliersTable.id,
            ext: suppliersTable.sourceExternalId,
          })
          .from(suppliersTable)
          .where(
            and(
              eq(suppliersTable.orgId, orgId),
              eq(suppliersTable.sourceSystem, SOURCE),
              inArray(suppliersTable.sourceExternalId, supExtIds),
            ),
          );
        for (const r of supRows) if (r.ext) supLookup.set(r.ext, r.id);
      }
      if (poExtIds.length > 0) {
        const poRows = await db
          .select({
            id: purchaseOrdersTable.id,
            ext: purchaseOrdersTable.sourceExternalId,
          })
          .from(purchaseOrdersTable)
          .where(
            and(
              eq(purchaseOrdersTable.orgId, orgId),
              eq(purchaseOrdersTable.sourceSystem, SOURCE),
              inArray(purchaseOrdersTable.sourceExternalId, poExtIds),
            ),
          );
        for (const r of poRows) if (r.ext) poLookup.set(r.ext, r.id);
      }
      const v = rows
        .map((r) => {
          const supplierId =
            r["supplierId"] ||
            (r["supplierExternalId"]
              ? supLookup.get(r["supplierExternalId"])
              : undefined);
          const poId =
            r["poId"] ||
            (r["poExternalId"] ? poLookup.get(r["poExternalId"]) : undefined);
          return { r, supplierId, poId };
        })
        .filter(
          (x) =>
            x.supplierId && x.r["amountUsd"] && x.r["invoiceDate"] && x.r["externalId"],
        )
        .map(({ r, supplierId, poId }) => ({
          id: newId("inv"),
          orgId,
          invoiceNumber: r["invoiceNumber"]!,
          supplierId: supplierId!,
          poId: poId ?? null,
          invoiceDate: new Date(r["invoiceDate"]!),
          amountUsd: Number(r["amountUsd"]!).toFixed(2),
          status:
            (r["status"] as
              | "received"
              | "approved"
              | "paid"
              | "disputed"
              | "void") ?? "received",
          dedupKey:
            r["dedupKey"] ??
            `${supplierId}|${Number(r["amountUsd"]!).toFixed(2)}|${r["invoiceDate"]!.slice(0, 10)}`,
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(invoicesTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            invoicesTable.orgId,
            invoicesTable.sourceSystem,
            invoicesTable.sourceExternalId,
          ],
          set: { sourceSyncedAt: sql`now()` },
        })
        .returning({ id: invoicesTable.id });
      return out.length;
    }
    case "purchase_orders": {
      // Resolve supplier external IDs in this batch via single grouped lookup.
      const supExtIds = Array.from(
        new Set(
          rows.map((r) => r["supplierExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const supLookup = new Map<string, string>();
      if (supExtIds.length > 0) {
        const supRows = await db
          .select({
            id: suppliersTable.id,
            ext: suppliersTable.sourceExternalId,
          })
          .from(suppliersTable)
          .where(
            and(
              eq(suppliersTable.orgId, orgId),
              eq(suppliersTable.sourceSystem, SOURCE),
              inArray(suppliersTable.sourceExternalId, supExtIds),
            ),
          );
        for (const r of supRows) if (r.ext) supLookup.set(r.ext, r.id);
      }
      const v = rows
        .filter(
          (r) =>
            r["externalId"] && supLookup.has(r["supplierExternalId"] ?? ""),
        )
        .map((r) => ({
          id: newId("po"),
          orgId,
          poNumber: r["poNumber"]!,
          supplierId: supLookup.get(r["supplierExternalId"]!)!,
          businessUnit: r["businessUnit"] ?? "Unknown",
          site: r["site"] ?? "Unknown",
          status:
            (r["status"] as
              | "open"
              | "closed"
              | "cancelled"
              | "received") ?? "open",
          orderDate: new Date(r["orderDate"]!),
          totalUsd: Number(r["totalUsd"] ?? "0").toFixed(2),
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(purchaseOrdersTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            purchaseOrdersTable.orgId,
            purchaseOrdersTable.sourceSystem,
            purchaseOrdersTable.sourceExternalId,
          ],
          set: {
            totalUsd: sql`excluded.total_usd`,
            status: sql`excluded.status`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: purchaseOrdersTable.id });
      return out.length;
    }
    case "po_lines": {
      // Resolve PO + category external IDs in two grouped lookups.
      const poExtIds = Array.from(
        new Set(
          rows.map((r) => r["poExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const catCodes = Array.from(
        new Set(
          rows
            .map((r) => r["categoryExternalId"] ?? r["categoryCode"])
            .filter(Boolean) as string[],
        ),
      );
      const poLookup = new Map<string, string>();
      const catLookup = new Map<string, string>();
      if (poExtIds.length > 0) {
        const poRows = await db
          .select({
            id: purchaseOrdersTable.id,
            ext: purchaseOrdersTable.sourceExternalId,
          })
          .from(purchaseOrdersTable)
          .where(
            and(
              eq(purchaseOrdersTable.orgId, orgId),
              eq(purchaseOrdersTable.sourceSystem, SOURCE),
              inArray(purchaseOrdersTable.sourceExternalId, poExtIds),
            ),
          );
        for (const r of poRows) if (r.ext) poLookup.set(r.ext, r.id);
      }
      if (catCodes.length > 0) {
        // Categories key off `code` (a UNIQUE business key per org); the
        // streamed feed can supply either column name.
        const catRows = await db
          .select({ id: categoriesTable.id, code: categoriesTable.code })
          .from(categoriesTable)
          .where(
            and(
              eq(categoriesTable.orgId, orgId),
              inArray(categoriesTable.code, catCodes),
            ),
          );
        for (const r of catRows) if (r.code) catLookup.set(r.code, r.id);
      }
      const v = rows
        .filter(
          (r) => r["externalId"] && poLookup.has(r["poExternalId"] ?? ""),
        )
        .map((r) => {
          const qty = Number(r["qty"] ?? "0");
          const unitPrice = Number(r["unitPriceUsd"] ?? "0");
          const catKey = r["categoryExternalId"] ?? r["categoryCode"] ?? "";
          return {
            id: newId("pol"),
            orgId,
            poId: poLookup.get(r["poExternalId"]!)!,
            lineNumber: parseInt(r["lineNumber"] ?? "1", 10) || 1,
            sku: r["sku"]!,
            description: r["description"] ?? r["sku"]!,
            categoryId: catKey ? catLookup.get(catKey) ?? null : null,
            spendClass:
              (r["spendClass"] as "direct" | "indirect" | "service") ??
              "indirect",
            qty: qty.toFixed(4),
            uom: r["uom"] ?? null,
            unitPriceUsd: unitPrice.toFixed(4),
            extendedUsd: (qty * unitPrice).toFixed(2),
            orderDate: new Date(r["orderDate"] ?? new Date().toISOString()),
            sourceSystem: SOURCE,
            sourceExternalId: r["externalId"]!,
          };
        });
      if (v.length === 0) return 0;
      const out = await db
        .insert(poLinesTable)
        .values(v)
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
            spendClass: sql`excluded.spend_class`,
            uom: sql`excluded.uom`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: poLinesTable.id });
      return out.length;
    }
    case "payments": {
      // Resolve invoice external IDs.
      const invExtIds = Array.from(
        new Set(
          rows.map((r) => r["invoiceExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const invLookup = new Map<string, string>();
      if (invExtIds.length > 0) {
        const invRows = await db
          .select({
            id: invoicesTable.id,
            ext: invoicesTable.sourceExternalId,
          })
          .from(invoicesTable)
          .where(
            and(
              eq(invoicesTable.orgId, orgId),
              eq(invoicesTable.sourceSystem, SOURCE),
              inArray(invoicesTable.sourceExternalId, invExtIds),
            ),
          );
        for (const r of invRows) if (r.ext) invLookup.set(r.ext, r.id);
      }
      const v = rows
        .filter(
          (r) =>
            r["externalId"] && invLookup.has(r["invoiceExternalId"] ?? ""),
        )
        .map((r) => ({
          id: newId("pay"),
          orgId,
          invoiceId: invLookup.get(r["invoiceExternalId"]!)!,
          paidDate: new Date(r["paidDate"]!),
          amountUsd: Number(r["amountUsd"] ?? "0").toFixed(2),
          paymentTermsDays: r["paymentTermsDays"]
            ? parseInt(r["paymentTermsDays"], 10)
            : null,
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(paymentsTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            paymentsTable.orgId,
            paymentsTable.sourceSystem,
            paymentsTable.sourceExternalId,
          ],
          set: {
            amountUsd: sql`excluded.amount_usd`,
            paidDate: sql`excluded.paid_date`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: paymentsTable.id });
      return out.length;
    }
    case "shipments": {
      // Optional PO + supplier external ID lookups.
      const poExtIds = Array.from(
        new Set(
          rows.map((r) => r["poExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const supExtIds = Array.from(
        new Set(
          rows.map((r) => r["supplierExternalId"]!).filter(Boolean) as string[],
        ),
      );
      const poLookup = new Map<string, string>();
      const supLookup = new Map<string, string>();
      if (poExtIds.length > 0) {
        const poRows = await db
          .select({
            id: purchaseOrdersTable.id,
            ext: purchaseOrdersTable.sourceExternalId,
          })
          .from(purchaseOrdersTable)
          .where(
            and(
              eq(purchaseOrdersTable.orgId, orgId),
              eq(purchaseOrdersTable.sourceSystem, SOURCE),
              inArray(purchaseOrdersTable.sourceExternalId, poExtIds),
            ),
          );
        for (const r of poRows) if (r.ext) poLookup.set(r.ext, r.id);
      }
      if (supExtIds.length > 0) {
        const supRows = await db
          .select({
            id: suppliersTable.id,
            ext: suppliersTable.sourceExternalId,
          })
          .from(suppliersTable)
          .where(
            and(
              eq(suppliersTable.orgId, orgId),
              eq(suppliersTable.sourceSystem, SOURCE),
              inArray(suppliersTable.sourceExternalId, supExtIds),
            ),
          );
        for (const r of supRows) if (r.ext) supLookup.set(r.ext, r.id);
      }
      const v = rows
        .filter((r) => r["externalId"])
        .map((r) => ({
          id: newId("shp"),
          orgId,
          poId: r["poExternalId"]
            ? poLookup.get(r["poExternalId"]) ?? null
            : null,
          supplierId: r["supplierExternalId"]
            ? supLookup.get(r["supplierExternalId"]) ?? null
            : null,
          carrier: r["carrier"]!,
          mode:
            (r["mode"] as "ocean" | "air" | "ltl" | "tl" | "parcel" | "rail") ??
            "tl",
          originCountry: r["originCountry"] ?? null,
          destCountry: r["destCountry"] ?? null,
          laneKey: r["laneKey"] ?? "UNKNOWN",
          weightKg: r["weightKg"]
            ? Number(r["weightKg"]).toFixed(2)
            : null,
          freightCostUsd: Number(r["freightCostUsd"] ?? "0").toFixed(2),
          incoterms: r["incoterms"] ?? null,
          shipDate: new Date(r["shipDate"] ?? new Date().toISOString()),
          sourceSystem: SOURCE,
          sourceExternalId: r["externalId"]!,
        }));
      if (v.length === 0) return 0;
      const out = await db
        .insert(shipmentsTable)
        .values(v)
        .onConflictDoUpdate({
          target: [
            shipmentsTable.orgId,
            shipmentsTable.sourceSystem,
            shipmentsTable.sourceExternalId,
          ],
          set: {
            carrier: sql`excluded.carrier`,
            freightCostUsd: sql`excluded.freight_cost_usd`,
            shipDate: sql`excluded.ship_date`,
            sourceSyncedAt: sql`now()`,
          },
        })
        .returning({ id: shipmentsTable.id });
      return out.length;
    }
    default: {
      const _exhaustive: never = entity;
      throw new Error(`streamCsvEntity: unknown entity '${_exhaustive}'`);
    }
  }
}
