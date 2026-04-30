/**
 * Post-PO-ingest backfill for supplier `billing_currency`.
 *
 * The supplier CSV is processed before the PO CSV in a typical ingest
 * payload, so at supplier-row time we don't yet have invoice / line
 * text to scan. This helper closes that gap: after PO ingest finishes
 * it walks every supplier in the org whose `billing_currency` is null
 * (or whose source is the low-confidence dollarized hint), pulls a
 * small sample of recent PO line descriptions for that supplier, and
 * runs the same deterministic resolver the ingest path uses.
 *
 * Hits are persisted with `source = 'backfill_invoice'` and the
 * resolver's confidence (`high` for ISO codes, `medium` for symbols).
 * `manual_override` rows are NEVER touched. `provided` and `country`
 * sources are not re-run unless the row is null — backfill is a
 * "fill the gap" pass, not a re-detector.
 *
 * Why not run on every ingest:
 *   - It scans potentially every supplier and joins PO lines, so it's
 *     called once at the end of an ingest run rather than per-row.
 *   - For tests / one-offs you can call it directly with an `orgId`.
 */

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  poLinesTable,
  purchaseOrdersTable,
  suppliersTable,
} from "@workspace/db/schema";
import { logger } from "../logger";
import { resolveBillingCurrency } from "./billing-currency-resolver";

const SAMPLES_PER_SUPPLIER = 25;

export interface BackfillResult {
  /** Suppliers considered for backfill (null or dollarized source). */
  considered: number;
  /** Suppliers we actually updated. */
  updated: number;
  /** Suppliers where no PO-line evidence existed. */
  noEvidence: number;
  /** Suppliers where the resolver returned no match against samples. */
  noMatch: number;
}

/**
 * Run the backfill for one org. Returns counters useful for logging.
 *
 * Safe to call repeatedly — only rows with null `billingCurrency` or
 * `billingCurrencySource = 'country_dollarized'` are touched, and the
 * resolver is deterministic so results are stable across calls.
 */
export async function backfillSupplierBillingCurrency(
  orgId: string,
): Promise<BackfillResult> {
  // Candidates: null currency OR low-confidence dollarized hint.
  // `manual_override` and high-confidence rows are intentionally excluded.
  const candidates = await db
    .select({
      id: suppliersTable.id,
      name: suppliersTable.name,
    })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.orgId, orgId),
        or(
          isNull(suppliersTable.billingCurrency),
          eq(suppliersTable.billingCurrencySource, "country_dollarized"),
        ),
      ),
    );

  const result: BackfillResult = {
    considered: candidates.length,
    updated: 0,
    noEvidence: 0,
    noMatch: 0,
  };
  if (candidates.length === 0) return result;

  // Bulk-fetch PO line descriptions for every candidate in one query,
  // then group in JS — cheaper than N round-trips per supplier.
  const candidateIds = candidates.map((c) => c.id);
  const lines = await db
    .select({
      supplierId: purchaseOrdersTable.supplierId,
      description: poLinesTable.description,
      orderDate: poLinesTable.orderDate,
    })
    .from(poLinesTable)
    .innerJoin(
      purchaseOrdersTable,
      eq(poLinesTable.poId, purchaseOrdersTable.id),
    )
    .where(
      and(
        eq(poLinesTable.orgId, orgId),
        inArray(purchaseOrdersTable.supplierId, candidateIds),
      ),
    )
    .orderBy(sql`${poLinesTable.orderDate} desc`)
    .limit(SAMPLES_PER_SUPPLIER * candidateIds.length);

  const samplesBySupplier = new Map<string, string[]>();
  for (const row of lines) {
    const arr = samplesBySupplier.get(row.supplierId) ?? [];
    if (arr.length < SAMPLES_PER_SUPPLIER) {
      arr.push(row.description);
      samplesBySupplier.set(row.supplierId, arr);
    }
  }

  for (const supplier of candidates) {
    const samples = samplesBySupplier.get(supplier.id) ?? [];
    if (samples.length === 0) {
      result.noEvidence++;
      continue;
    }
    // Country code intentionally NOT passed: backfill is the
    // invoice-evidence path. A null/low country signal already steered
    // this supplier into the candidate set.
    const resolved = resolveBillingCurrency({ invoiceSamples: samples });
    if (!resolved) {
      result.noMatch++;
      continue;
    }
    if (resolved.confidence !== "high" && resolved.confidence !== "medium") {
      result.noMatch++;
      continue;
    }
    await db
      .update(suppliersTable)
      .set({
        billingCurrency: resolved.currency,
        billingCurrencySource: "backfill_invoice",
        billingCurrencyConfidence: resolved.confidence,
      })
      .where(eq(suppliersTable.id, supplier.id));
    result.updated++;
  }

  if (result.updated > 0 || result.considered > 0) {
    logger.info(
      { orgId, ...result },
      "supplier billing-currency backfill complete",
    );
  }
  return result;
}
