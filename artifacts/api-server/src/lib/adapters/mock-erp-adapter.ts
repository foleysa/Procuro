import { db } from "@workspace/db";
import {
  suppliersTable,
  purchaseOrdersTable,
  poLinesTable,
  invoicesTable,
  type PoStatus,
  type InvoiceStatus,
  type CategoryClass,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { newId } from "../ids";
import { CANCELLED_ERROR_MESSAGE } from "../jobs/queue";
import { logger } from "../logger";
import type { SourceAdapter, SyncResult } from "./source-adapter";

/**
 * Mock ERP adapter — proves the SourceAdapter abstraction works against a
 * synthetic "ERP" feed. In real life this is replaced with SAP, Oracle Fusion,
 * Coupa, etc.; the contract (cursor-based pagination, idempotent upsert
 * keyed on source_external_id, deletion replay, optional incremental window)
 * is identical.
 *
 * Behavior:
 *   - fullSync: idempotent rescan of every record returned by the mock feed.
 *   - incrementalSync: paginates from `cursor` (a timestamp) and only emits
 *     records changed since.
 *   - deleteRecord: tombstones the canonical row.
 *
 * The mock "feed" is supplied by config.feed for test determinism.
 */
export interface MockErpRecord {
  type: "supplier" | "purchase_order" | "invoice";
  externalId: string;
  updatedAt: string;
  payload: Record<string, unknown>;
  deleted?: boolean;
}

export interface MockErpConfig {
  feed: MockErpRecord[];
  pageSize?: number;
}

const SOURCE = "mock_erp";

export const mockErpSourceAdapter: SourceAdapter<MockErpConfig> = {
  key: SOURCE,
  label: "Mock ERP (SAP-like)",

  async fullSync({ orgId, config, onProgress, isCancelled }): Promise<SyncResult> {
    const start = Date.now();
    let processed = 0;
    let created = 0;
    let updated = 0;
    let deleted = 0;
    const pageSize = config.pageSize ?? 250;
    for (let i = 0; i < config.feed.length; i += pageSize) {
      // Page boundary is the natural cancel checkpoint — we've finished
      // a self-contained chunk of upserts and the operator's Cancel
      // signal hasn't lost any work.
      if (isCancelled && (await isCancelled())) {
        throw new Error(CANCELLED_ERROR_MESSAGE);
      }
      const page = config.feed.slice(i, i + pageSize);
      for (const rec of page) {
        const r = await applyRecord(orgId, rec);
        processed += 1;
        created += r.created;
        updated += r.updated;
        deleted += r.deleted;
      }
      await onProgress?.({ recordsProcessed: processed, cursor: String(i + page.length) });
    }
    return {
      recordsProcessed: processed,
      recordsCreated: created,
      recordsUpdated: updated,
      recordsDeleted: deleted,
      cursor: new Date().toISOString(),
      durationMs: Date.now() - start,
    };
  },

  async incrementalSync({ orgId, config, cursor, onProgress, isCancelled }): Promise<SyncResult> {
    const start = Date.now();
    const since = cursor ? new Date(cursor) : new Date(0);
    let processed = 0;
    let created = 0;
    let updated = 0;
    let deleted = 0;
    const filtered = config.feed
      .filter((r) => new Date(r.updatedAt) > since)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const pageSize = config.pageSize ?? 250;
    let lastCursor = cursor ?? new Date(0).toISOString();
    for (let i = 0; i < filtered.length; i += pageSize) {
      if (isCancelled && (await isCancelled())) {
        throw new Error(CANCELLED_ERROR_MESSAGE);
      }
      const page = filtered.slice(i, i + pageSize);
      for (const rec of page) {
        const r = await applyRecord(orgId, rec);
        processed += 1;
        created += r.created;
        updated += r.updated;
        deleted += r.deleted;
        lastCursor = rec.updatedAt;
      }
      await onProgress?.({ recordsProcessed: processed, cursor: lastCursor });
    }
    return {
      recordsProcessed: processed,
      recordsCreated: created,
      recordsUpdated: updated,
      recordsDeleted: deleted,
      cursor: lastCursor,
      durationMs: Date.now() - start,
    };
  },

  async deleteRecord({ orgId, type, externalId }) {
    if (type === "supplier") {
      await db
        .delete(suppliersTable)
        .where(
          and(
            eq(suppliersTable.orgId, orgId),
            eq(suppliersTable.sourceSystem, SOURCE),
            eq(suppliersTable.sourceExternalId, externalId),
          ),
        );
    } else if (type === "purchase_order") {
      await db
        .delete(purchaseOrdersTable)
        .where(
          and(
            eq(purchaseOrdersTable.orgId, orgId),
            eq(purchaseOrdersTable.sourceSystem, SOURCE),
            eq(purchaseOrdersTable.sourceExternalId, externalId),
          ),
        );
    } else if (type === "invoice") {
      await db
        .delete(invoicesTable)
        .where(
          and(
            eq(invoicesTable.orgId, orgId),
            eq(invoicesTable.sourceSystem, SOURCE),
            eq(invoicesTable.sourceExternalId, externalId),
          ),
        );
    }
  },
};

async function applyRecord(
  orgId: string,
  rec: MockErpRecord,
): Promise<{ created: number; updated: number; deleted: number }> {
  if (rec.deleted) {
    await mockErpSourceAdapter.deleteRecord!({
      orgId,
      type: rec.type,
      externalId: rec.externalId,
    });
    return { created: 0, updated: 0, deleted: 1 };
  }
  if (rec.type === "supplier") {
    const p = rec.payload as {
      name: string;
      countryCode?: string;
      paymentTermsDays?: string;
      isStrategic?: boolean;
      isPreferred?: boolean;
    };
    await db
      .insert(suppliersTable)
      .values({
        id: newId("sup"),
        orgId,
        name: p.name,
        normalizedName: p.name.trim().toLowerCase(),
        countryCode: p.countryCode ?? null,
        paymentTermsDays: p.paymentTermsDays ?? null,
        isStrategic: p.isStrategic ?? false,
        isPreferred: p.isPreferred ?? false,
        sourceSystem: SOURCE,
        sourceExternalId: rec.externalId,
        sourceSyncedAt: new Date(rec.updatedAt),
      })
      .onConflictDoUpdate({
        target: [
          suppliersTable.orgId,
          suppliersTable.sourceSystem,
          suppliersTable.sourceExternalId,
        ],
        set: {
          name: p.name,
          isStrategic: p.isStrategic ?? false,
          isPreferred: p.isPreferred ?? false,
          sourceSyncedAt: new Date(rec.updatedAt),
        },
      });
    return { created: 1, updated: 0, deleted: 0 };
  }
  if (rec.type === "purchase_order") {
    const p = rec.payload as {
      poNumber: string;
      supplierExternalId: string;
      businessUnit?: string;
      site?: string;
      status?: PoStatus;
      orderDate: string;
      lines: Array<{
        lineNumber: number;
        sku: string;
        description: string;
        spendClass?: CategoryClass;
        qty: number;
        uom?: string;
        unitPriceUsd: number;
      }>;
    };
    const supplier = await resolveSupplierId(orgId, p.supplierExternalId);
    if (!supplier) return { created: 0, updated: 0, deleted: 0 };
    const orderDate = new Date(p.orderDate);
    const total = p.lines.reduce((s, l) => s + l.qty * l.unitPriceUsd, 0);
    const [poRow] = await db
      .insert(purchaseOrdersTable)
      .values({
        id: newId("po"),
        orgId,
        poNumber: p.poNumber,
        supplierId: supplier,
        businessUnit: p.businessUnit ?? null,
        site: p.site ?? null,
        status: p.status ?? "open",
        orderDate,
        totalUsd: total.toFixed(2),
        sourceSystem: SOURCE,
        sourceExternalId: rec.externalId,
        sourceSyncedAt: new Date(rec.updatedAt),
      })
      .onConflictDoUpdate({
        target: [
          purchaseOrdersTable.orgId,
          purchaseOrdersTable.sourceSystem,
          purchaseOrdersTable.sourceExternalId,
        ],
        set: {
          status: p.status ?? "open",
          totalUsd: total.toFixed(2),
          sourceSyncedAt: new Date(rec.updatedAt),
        },
      })
      .returning({ id: purchaseOrdersTable.id });
    if (poRow && p.lines.length > 0) {
      // Dedupe `lines` by `lineNumber` with last-write-wins (Task #279).
      // The poLines upsert below targets `(orgId, sourceSystem,
      // sourceExternalId)` where the source external id is built as
      // `${rec.externalId}#${l.lineNumber}`. Two lines sharing
      // `lineNumber` would otherwise drive a single
      // `INSERT ... ON CONFLICT DO UPDATE` to reject with SQLSTATE
      // 21000. Collapsing duplicates here matches the result of
      // Postgres applying separate INSERTs in payload order.
      const lineDedupMap = new Map<number, (typeof p.lines)[number]>();
      for (const l of p.lines) {
        lineDedupMap.set(l.lineNumber, l);
      }
      const dedupedLines = Array.from(lineDedupMap.values());
      if (dedupedLines.length < p.lines.length) {
        logger.info(
          {
            orgId,
            poExternalId: rec.externalId,
            inputLineCount: p.lines.length,
            uniqueLineCount: dedupedLines.length,
            collapsedLineCount: p.lines.length - dedupedLines.length,
          },
          "mock-erp ingest: collapsed duplicate PO lines by lineNumber (last write wins)",
        );
      }
      // Upsert by source identity so ERP re-syncs update in place.
      await db
        .insert(poLinesTable)
        .values(
          dedupedLines.map((l) => ({
            id: newId("pol"),
            orgId,
            poId: poRow.id,
            lineNumber: l.lineNumber,
            sku: l.sku,
            description: l.description,
            // Default to "indirect" when feed omits classification —
            // downstream analyzers treat unknown spend as indirect tail.
            spendClass: (l.spendClass ?? "indirect") as CategoryClass,
            qty: l.qty.toFixed(4),
            uom: l.uom ?? null,
            unitPriceUsd: l.unitPriceUsd.toFixed(4),
            extendedUsd: (l.qty * l.unitPriceUsd).toFixed(2),
            orderDate,
            sourceSystem: SOURCE,
            sourceExternalId: `${rec.externalId}#${l.lineNumber}`,
            sourceSyncedAt: new Date(rec.updatedAt),
          })),
        )
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
            sourceSyncedAt: sql`excluded.source_synced_at`,
          },
        });
    }
    return { created: 1, updated: 0, deleted: 0 };
  }
  if (rec.type === "invoice") {
    const p = rec.payload as {
      invoiceNumber: string;
      supplierExternalId: string;
      poExternalId?: string;
      invoiceDate: string;
      amountUsd: number;
      dedupKey?: string;
      status?: InvoiceStatus;
    };
    const supplier = await resolveSupplierId(orgId, p.supplierExternalId);
    if (!supplier) return { created: 0, updated: 0, deleted: 0 };
    const poId = p.poExternalId
      ? await resolvePoId(orgId, p.poExternalId)
      : null;
    const invoiceDate = new Date(p.invoiceDate);
    // Same dedup convention as seed/CSV adapters so the duplicate-payment
    // analyzer triggers across ingest sources.
    const dedupKey =
      p.dedupKey ??
      `${supplier}|${p.amountUsd.toFixed(2)}|${invoiceDate.toISOString().slice(0, 10)}`;
    await db
      .insert(invoicesTable)
      .values({
        id: newId("inv"),
        orgId,
        invoiceNumber: p.invoiceNumber,
        supplierId: supplier,
        poId,
        invoiceDate,
        amountUsd: p.amountUsd.toFixed(2),
        status: p.status ?? "received",
        dedupKey,
        sourceSystem: SOURCE,
        sourceExternalId: rec.externalId,
        sourceSyncedAt: new Date(rec.updatedAt),
      })
      .onConflictDoUpdate({
        target: [
          invoicesTable.orgId,
          invoicesTable.sourceSystem,
          invoicesTable.sourceExternalId,
        ],
        set: {
          amountUsd: p.amountUsd.toFixed(2),
          status: p.status ?? "received",
          sourceSyncedAt: new Date(rec.updatedAt),
        },
      });
    return { created: 1, updated: 0, deleted: 0 };
  }
  return { created: 0, updated: 0, deleted: 0 };
}

async function resolveSupplierId(
  orgId: string,
  externalId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: suppliersTable.id })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.orgId, orgId),
        eq(suppliersTable.sourceSystem, SOURCE),
        eq(suppliersTable.sourceExternalId, externalId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function resolvePoId(
  orgId: string,
  externalId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: purchaseOrdersTable.id })
    .from(purchaseOrdersTable)
    .where(
      and(
        eq(purchaseOrdersTable.orgId, orgId),
        eq(purchaseOrdersTable.sourceSystem, SOURCE),
        eq(purchaseOrdersTable.sourceExternalId, externalId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
