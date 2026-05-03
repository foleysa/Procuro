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
  statementsOfWorkTable,
  sowMilestonesTable,
  sowChangeOrdersTable,
  rateCardsTable,
  rateCardLinesTable,
  timeEntriesTable,
  type ContractType,
  type SowStatus,
  type SowMilestoneStatus,
  type SowChangeOrderStatus,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";
import { CANCELLED_ERROR_MESSAGE } from "../jobs/queue";
import { resolveBillingCurrency } from "../suppliers/billing-currency-resolver";
import {
  routeTenantCategory,
  isCanonicalCodeRouted,
} from "../intelligence/routing";
import type {
  IngestWarning,
  IsCancelledFn,
  SyncProgress,
  SyncResult,
} from "./source-adapter";

/**
 * Top-level keys recognised in `IngestPayload`. The writer iterates by
 * known name to upsert each entity, so any extra key the caller hands
 * us would normally be silently ignored at runtime (TypeScript erases
 * the type at compile time and bare `payload.frobnicators` is just
 * `undefined`). Task #93: instead of dropping those rows on the floor,
 * we compare the caller's keys against this allowlist and surface each
 * unknown record kind as a per-row `IngestWarning` in the result so a
 * partially-malformed CSV/JSON payload yields a partial-success outcome
 * (the known-entity rows still land in the DB) instead of failing the
 * whole job and forcing the operator to clean the file.
 */
const KNOWN_INGEST_PAYLOAD_KEYS: ReadonlySet<string> = new Set<
  keyof IngestPayload
>([
  "suppliers",
  "categories",
  "items",
  "contracts",
  "statementsOfWork",
  "rateCards",
  "timeEntries",
  "purchaseOrders",
  "invoices",
  "payments",
  "shipments",
] as const);

/** Cap per-warning string sizes so a million-row unknown key can't bloat the result row. */
const MAX_WARNING_FIELD_LEN = 200;
/** Cap how many warnings we accumulate per top-level key. Beyond this we collapse to a single overflow warning. */
const MAX_WARNINGS_PER_KEY = 100;

function truncate(s: unknown, max = MAX_WARNING_FIELD_LEN): string | undefined {
  if (typeof s !== "string") return undefined;
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Walk a caller-supplied `IngestPayload`-shaped object and produce
 * per-row warnings for any top-level key that isn't a known entity.
 * Returns the warnings plus the total number of skipped rows so the
 * caller can fold both into the `SyncResult`.
 *
 * Heuristics:
 *   - Unknown key whose value is an array → one warning per entry, up
 *     to `MAX_WARNINGS_PER_KEY`, plus an overflow warning summarising
 *     any rows past the cap. Each entry counts as one skipped row.
 *   - Unknown key whose value is anything else (object / string /
 *     number) → one warning, one skipped row.
 */
function collectUnknownPayloadWarnings(
  payload: unknown,
): { warnings: IngestWarning[]; recordsSkipped: number } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { warnings: [], recordsSkipped: 0 };
  }
  const warnings: IngestWarning[] = [];
  let recordsSkipped = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (KNOWN_INGEST_PAYLOAD_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      const overflow = Math.max(0, value.length - MAX_WARNINGS_PER_KEY);
      const visible = overflow > 0 ? value.slice(0, MAX_WARNINGS_PER_KEY) : value;
      visible.forEach((row, i) => {
        const externalId =
          row !== null && typeof row === "object"
            ? truncate((row as Record<string, unknown>)["externalId"])
            : undefined;
        warnings.push({
          code: "unknown_record_type",
          field: `${key}[${i}]`,
          ...(externalId !== undefined ? { externalId } : {}),
          reason: `Unknown record type "${key}" — row skipped`,
        });
      });
      if (overflow > 0) {
        warnings.push({
          code: "unknown_record_type",
          field: key,
          reason: `Unknown record type "${key}" — ${overflow} additional row(s) skipped (warning list capped at ${MAX_WARNINGS_PER_KEY})`,
        });
      }
      recordsSkipped += value.length;
    } else if (value !== undefined) {
      warnings.push({
        code: "unknown_record_type",
        field: key,
        reason: `Unknown record type "${key}" — value skipped`,
      });
      recordsSkipped += 1;
    }
  }
  return { warnings, recordsSkipped };
}

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
    /** UNSPSC code (#214) — optional cross-walk identifier. */
    unspscCode?: string;
    /** UNSPSC family (#214) — first 2 segments of the code; auto-derived
     * from `unspscCode` if omitted. */
    unspscFamily?: string;
    /** NAICS code (#214) — optional industry mapping. */
    naicsCode?: string;
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
    /**
     * Commercial structure (Task #214). Defaults to `goods` server-side
     * if omitted so legacy CSV/ERP feeds keep working unchanged. Adapters
     * that distinguish services contracts (e.g. Coupa) populate this
     * explicitly.
     */
    contractType?: ContractType;
    /**
     * `externalId` of the parent MSA contract in the same payload.
     * Resolved against `contractMap` after the contracts batch upsert,
     * so MSA + child SOWs in the same upload link correctly even when
     * row order isn't guaranteed.
     */
    msaParentExternalId?: string;
    /** Optional structured SLA / typed object payload. */
    serviceLevelTerms?: unknown;
    /** Optional plain-text acceptance criteria for services contracts. */
    acceptanceCriteria?: string;
    items: Array<{
      sku: string;
      contractedUnitPriceUsd: number;
      tiers?: { minQty: number; unitPriceUsd: number }[];
    }>;
  }>;
  /**
   * Statements of Work — child agreements under a parent contract (#214).
   * `contractExternalId` must reference a contract in this payload (or
   * already-ingested) for the SOW to land; orphan SOWs are dropped with
   * a warning rather than failing the whole batch.
   */
  statementsOfWork?: Array<{
    externalId: string;
    sowNumber: string;
    title: string;
    contractExternalId: string;
    supplierExternalId: string;
    status?: SowStatus;
    startDate: string;
    endDate: string;
    totalValueUsd?: number;
    billingCurrency?: string;
    scope?: unknown;
    acceptanceCriteria?: string;
    milestones?: Array<{
      milestoneNumber: number;
      title: string;
      description?: string;
      dueDate?: string;
      valueUsd?: number;
      status?: SowMilestoneStatus;
      deliveredAt?: string;
      acceptedAt?: string;
    }>;
    changeOrders?: Array<{
      externalId?: string;
      changeOrderNumber: string;
      title: string;
      description?: string;
      status?: SowChangeOrderStatus;
      valueDeltaUsd?: number;
      dateDeltaDays?: number;
      proposedAt?: string;
      executedAt?: string;
    }>;
  }>;
  /**
   * Rate cards (#214). Either `contractExternalId` or `sowExternalId`
   * must be set so the resolver can attach to the right parent.
   */
  rateCards?: Array<{
    externalId: string;
    name: string;
    supplierExternalId: string;
    contractExternalId?: string;
    sowExternalId?: string;
    currency?: string;
    effectiveDate: string;
    expiryDate?: string;
    lines?: Array<{
      role: string;
      seniority?: string;
      hourlyRate?: number;
      dailyRate?: number;
      roleCode?: string;
    }>;
  }>;
  /** Time entries (#214) — actuals reported against a SOW/rate card. */
  timeEntries?: Array<{
    externalId: string;
    supplierExternalId: string;
    contractExternalId?: string;
    sowExternalId?: string;
    rateCardExternalId?: string;
    resource: string;
    role?: string;
    seniority?: string;
    workDate: string;
    hours: number;
    billRateUsd?: number;
    amountUsd?: number;
    description?: string;
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

  // Task #93: surface unknown top-level keys as per-row warnings
  // BEFORE doing any work. We compute this up front so the warnings
  // land in the result even if the known-entity inserts fail later
  // (a downstream throw still propagates; the warnings only show up on
  // success, which matches the partial-success contract — failure
  // means the operator already has an error to act on).
  const { warnings: unknownWarnings, recordsSkipped: unknownSkipped } =
    collectUnknownPayloadWarnings(payload);

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
    const rows = payload.categories.map((c) => {
      // Derive UNSPSC family from full code when caller didn't supply
      // it explicitly. Family = first 4 chars (= 2 segments) per UNSPSC
      // hierarchy. Skipped when the code is too short to slice safely.
      const family =
        c.unspscFamily ??
        (c.unspscCode && c.unspscCode.length >= 4
          ? c.unspscCode.slice(0, 4)
          : null);
      return {
        id: newId("cat"),
        orgId,
        code: c.code,
        name: c.name,
        class: c.class,
        unspscCode: c.unspscCode ?? null,
        unspscFamily: family,
        naicsCode: c.naicsCode ?? null,
      };
    });
    await bulkC(rows, async (chunk) => {
      const inserted = await db
        .insert(categoriesTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [categoriesTable.orgId, categoriesTable.code],
          set: {
            name: sql`excluded.name`,
            class: sql`excluded.class`,
            unspscCode: sql`coalesce(excluded.unspsc_code, ${categoriesTable.unspscCode})`,
            unspscFamily: sql`coalesce(excluded.unspsc_family, ${categoriesTable.unspscFamily})`,
            naicsCode: sql`coalesce(excluded.naics_code, ${categoriesTable.naicsCode})`,
          },
        })
        .returning({ id: categoriesTable.id, code: categoriesTable.code });
      for (const r of inserted) categoryMap.set(r.code, r.id);
    });
    for (const c of payload.categories) {
      const id = categoryMap.get(c.code);
      if (id) categoryMap.set(c.externalId, id);
    }
    // Route each tenant-supplied category through the 4-layer
    // resolver. `routeTenantCategory` self-enqueues on a Layer-B miss,
    // so we just fire the call once per non-canonical code. This is
    // the production wire-in for the routing model — without it the
    // queue stays empty in real traffic and the Layer C admin surface
    // is informational only.
    for (const c of payload.categories) {
      try {
        if (await isCanonicalCodeRouted(c.code)) continue;
        await routeTenantCategory({ orgId, tenantString: c.name });
      } catch (err) {
        // Routing must never block ingest — log and continue.
        logger.warn(
          { err, orgId, code: c.code, name: c.name },
          "ingest: routing wire-in failed for category (continuing)",
        );
      }
    }
    created += payload.categories.length;
    processed += payload.categories.length;
    await onProgress?.({ recordsProcessed: processed });
  }

  await checkpoint();

  // 2. Suppliers.
  const supplierMap = new Map<string, string>();
  if (payload.suppliers?.length) {
    // Dedupe by externalId with last-write-wins (Task #279). The
    // suppliers upsert below targets `(orgId, sourceSystem,
    // sourceExternalId)`; two payload rows sharing externalId would
    // otherwise drive a single `INSERT ... ON CONFLICT DO UPDATE`
    // statement to reject with SQLSTATE 21000 ("ON CONFLICT DO UPDATE
    // command cannot affect row a second time"). Collapsing in-batch
    // duplicates here matches the observable result of Postgres
    // applying separate INSERT statements in upload order: the LAST
    // row for a key becomes the persisted row.
    const beforeCount = payload.suppliers.length;
    const dedupMap = new Map<string, (typeof payload.suppliers)[number]>();
    for (const s of payload.suppliers) {
      if (!s.externalId) continue;
      dedupMap.set(s.externalId, s);
    }
    const dedupedSuppliers = Array.from(dedupMap.values());
    if (dedupedSuppliers.length < beforeCount) {
      logger.info(
        {
          orgId,
          sourceSystem,
          inputRowCount: beforeCount,
          uniqueRowCount: dedupedSuppliers.length,
          collapsedRowCount: beforeCount - dedupedSuppliers.length,
        },
        "ingest writer: collapsed duplicate supplier rows by externalId (last write wins)",
      );
    }
    const rows = dedupedSuppliers.map((s) => {
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
    created += dedupedSuppliers.length;
    processed += dedupedSuppliers.length;
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
        contractType: c.contractType ?? "goods",
        serviceLevelTerms: c.serviceLevelTerms ?? null,
        acceptanceCriteria: c.acceptanceCriteria ?? null,
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
            contractType: sql`excluded.contract_type`,
            serviceLevelTerms: sql`excluded.service_level_terms`,
            acceptanceCriteria: sql`excluded.acceptance_criteria`,
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
    // Second pass: link MSA parents now that every contract row has an
    // id. Needed because both rows can appear in the same batch with
    // arbitrary order — we resolve `msaParentExternalId` against the
    // freshly-populated `contractMap` and patch the FK column. Skipped
    // when no payload row declares a parent.
    const msaUpdates = payload.contracts
      .filter((c) => c.msaParentExternalId)
      .map((c) => ({
        childExt: c.externalId,
        parentExt: c.msaParentExternalId!,
      }))
      .filter(
        (u) => contractMap.has(u.childExt) && contractMap.has(u.parentExt),
      );
    for (const u of msaUpdates) {
      await db.execute(
        sql`UPDATE contracts SET msa_parent_id = ${contractMap.get(u.parentExt)!} WHERE id = ${contractMap.get(u.childExt)!}`,
      );
    }
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

  // 4b. Statements of Work + milestones + change orders (#214). Must
  // run after contracts since SOWs FK to `contracts.id`.
  const sowMap = new Map<string, string>();
  if (payload.statementsOfWork?.length) {
    const valid = payload.statementsOfWork.filter(
      (s) =>
        contractMap.has(s.contractExternalId) &&
        supplierMap.has(s.supplierExternalId),
    );
    const skipped = payload.statementsOfWork.length - valid.length;
    if (skipped > 0) {
      logger.warn(
        { orgId, skipped, total: payload.statementsOfWork.length },
        "ingest: dropped SOWs with unresolved contract or supplier",
      );
    }
    if (valid.length > 0) {
      const rows = valid.map((s) => ({
        id: newId("sow"),
        orgId,
        contractId: contractMap.get(s.contractExternalId)!,
        supplierId: supplierMap.get(s.supplierExternalId)!,
        sowNumber: s.sowNumber,
        title: s.title,
        status: s.status ?? "active",
        startDate: new Date(s.startDate),
        endDate: new Date(s.endDate),
        totalValueUsd: s.totalValueUsd?.toFixed(2) ?? null,
        billingCurrency: s.billingCurrency ?? null,
        scope: s.scope ?? null,
        acceptanceCriteria: s.acceptanceCriteria ?? null,
        sourceSystem,
        sourceExternalId: s.externalId,
      }));
      await bulkC(rows, async (chunk) => {
        const inserted = await db
          .insert(statementsOfWorkTable)
          .values(chunk)
          .onConflictDoUpdate({
            target: [
              statementsOfWorkTable.orgId,
              statementsOfWorkTable.sourceSystem,
              statementsOfWorkTable.sourceExternalId,
            ],
            set: {
              title: sql`excluded.title`,
              status: sql`excluded.status`,
              endDate: sql`excluded.end_date`,
              totalValueUsd: sql`excluded.total_value_usd`,
              billingCurrency: sql`excluded.billing_currency`,
              scope: sql`excluded.scope`,
              acceptanceCriteria: sql`excluded.acceptance_criteria`,
              sourceSyncedAt: sql`now()`,
            },
          })
          .returning({
            id: statementsOfWorkTable.id,
            ext: statementsOfWorkTable.sourceExternalId,
          });
        for (const r of inserted) if (r.ext) sowMap.set(r.ext, r.id);
      });

      // Milestones — replace-in-place per SOW so re-ingest of the same
      // SOW with edited milestones reflects the new state without
      // duplicating rows. Mirrors the contract-items pattern above.
      for (const s of valid) {
        const sid = sowMap.get(s.externalId);
        if (!sid) continue;
        if (s.milestones && s.milestones.length > 0) {
          await db.execute(
            sql`DELETE FROM sow_milestones WHERE sow_id = ${sid}`,
          );
          const mRows = s.milestones.map((m) => ({
            id: newId("sowm"),
            orgId,
            sowId: sid,
            milestoneNumber: m.milestoneNumber,
            title: m.title,
            description: m.description ?? null,
            dueDate: m.dueDate ? new Date(m.dueDate) : null,
            valueUsd: m.valueUsd?.toFixed(2) ?? null,
            status: m.status ?? "pending",
            deliveredAt: m.deliveredAt ? new Date(m.deliveredAt) : null,
            acceptedAt: m.acceptedAt ? new Date(m.acceptedAt) : null,
          }));
          await bulkC(mRows, (chunk) =>
            db.insert(sowMilestonesTable).values(chunk),
          );
        }

        // Change orders — upserted (rather than replaced) since each
        // change order has its own external id we want to keep stable
        // across syncs.
        if (s.changeOrders && s.changeOrders.length > 0) {
          const coRows = s.changeOrders.map((co) => ({
            id: newId("sowco"),
            orgId,
            sowId: sid,
            changeOrderNumber: co.changeOrderNumber,
            title: co.title,
            description: co.description ?? null,
            status: co.status ?? "proposed",
            valueDeltaUsd: co.valueDeltaUsd?.toFixed(2) ?? null,
            dateDeltaDays: co.dateDeltaDays ?? null,
            proposedAt: co.proposedAt ? new Date(co.proposedAt) : null,
            executedAt: co.executedAt ? new Date(co.executedAt) : null,
            sourceSystem,
            sourceExternalId:
              co.externalId ?? `${s.externalId}#${co.changeOrderNumber}`,
          }));
          await bulkC(coRows, (chunk) =>
            db
              .insert(sowChangeOrdersTable)
              .values(chunk)
              .onConflictDoUpdate({
                target: [
                  sowChangeOrdersTable.orgId,
                  sowChangeOrdersTable.sourceSystem,
                  sowChangeOrdersTable.sourceExternalId,
                ],
                set: {
                  title: sql`excluded.title`,
                  description: sql`excluded.description`,
                  status: sql`excluded.status`,
                  valueDeltaUsd: sql`excluded.value_delta_usd`,
                  dateDeltaDays: sql`excluded.date_delta_days`,
                  proposedAt: sql`excluded.proposed_at`,
                  executedAt: sql`excluded.executed_at`,
                },
              }),
          );
        }
      }
      created += valid.length;
      processed += valid.length;
      await onProgress?.({ recordsProcessed: processed });
    }
  }

  await checkpoint();

  // 4c. Rate cards + lines (#214). Belong with services contracts so
  // they live alongside the contract/SOW write block.
  const rateCardMap = new Map<string, string>();
  if (payload.rateCards?.length) {
    const valid = payload.rateCards.filter(
      (rc) =>
        supplierMap.has(rc.supplierExternalId) &&
        // Either a contract or a SOW must resolve. Orphan rate cards are
        // dropped with a warning so a typo upstream doesn't silently
        // attach the rate to nothing.
        ((rc.contractExternalId && contractMap.has(rc.contractExternalId)) ||
          (rc.sowExternalId && sowMap.has(rc.sowExternalId))),
    );
    const skipped = payload.rateCards.length - valid.length;
    if (skipped > 0) {
      logger.warn(
        { orgId, skipped, total: payload.rateCards.length },
        "ingest: dropped rate cards with unresolved parent contract/sow/supplier",
      );
    }
    if (valid.length > 0) {
      const rows = valid.map((rc) => ({
        id: newId("rc"),
        orgId,
        contractId: rc.contractExternalId
          ? contractMap.get(rc.contractExternalId) ?? null
          : null,
        sowId: rc.sowExternalId ? sowMap.get(rc.sowExternalId) ?? null : null,
        supplierId: supplierMap.get(rc.supplierExternalId)!,
        name: rc.name,
        currency: rc.currency ?? "USD",
        effectiveDate: new Date(rc.effectiveDate),
        expiryDate: rc.expiryDate ? new Date(rc.expiryDate) : null,
        sourceSystem,
        sourceExternalId: rc.externalId,
      }));
      await bulkC(rows, async (chunk) => {
        const inserted = await db
          .insert(rateCardsTable)
          .values(chunk)
          .onConflictDoUpdate({
            target: [
              rateCardsTable.orgId,
              rateCardsTable.sourceSystem,
              rateCardsTable.sourceExternalId,
            ],
            set: {
              name: sql`excluded.name`,
              currency: sql`excluded.currency`,
              effectiveDate: sql`excluded.effective_date`,
              expiryDate: sql`excluded.expiry_date`,
              sourceSyncedAt: sql`now()`,
            },
          })
          .returning({
            id: rateCardsTable.id,
            ext: rateCardsTable.sourceExternalId,
          });
        for (const r of inserted) if (r.ext) rateCardMap.set(r.ext, r.id);
      });

      // Replace-in-place lines so a re-ingest of the same rate card
      // with new role rows reflects the new state without duplicates.
      for (const rc of valid) {
        const rcid = rateCardMap.get(rc.externalId);
        if (!rcid) continue;
        if (!rc.lines || rc.lines.length === 0) continue;
        await db.execute(
          sql`DELETE FROM rate_card_lines WHERE rate_card_id = ${rcid}`,
        );
        const lineRows = rc.lines.map((ln) => ({
          id: newId("rcl"),
          orgId,
          rateCardId: rcid,
          role: ln.role,
          seniority: ln.seniority ?? null,
          hourlyRate: ln.hourlyRate?.toFixed(4) ?? null,
          dailyRate: ln.dailyRate?.toFixed(4) ?? null,
          roleCode: ln.roleCode ?? null,
        }));
        await bulkC(lineRows, (chunk) =>
          db.insert(rateCardLinesTable).values(chunk),
        );
      }
      created += valid.length;
      processed += valid.length;
      await onProgress?.({ recordsProcessed: processed });
    }
  }

  await checkpoint();

  // 4d. Time entries (#214). Drops rows with unresolved supplier so a
  // bad ID doesn't fail the whole upload; rate-card / sow / contract
  // FK fields fall back to null so the entry still lands.
  if (payload.timeEntries?.length) {
    const valid = payload.timeEntries.filter((t) =>
      supplierMap.has(t.supplierExternalId),
    );
    const skipped = payload.timeEntries.length - valid.length;
    if (skipped > 0) {
      logger.warn(
        { orgId, skipped, total: payload.timeEntries.length },
        "ingest: dropped time entries with unresolved supplier",
      );
    }
    if (valid.length > 0) {
      const rows = valid.map((t) => ({
        id: newId("te"),
        orgId,
        supplierId: supplierMap.get(t.supplierExternalId)!,
        contractId: t.contractExternalId
          ? contractMap.get(t.contractExternalId) ?? null
          : null,
        sowId: t.sowExternalId ? sowMap.get(t.sowExternalId) ?? null : null,
        rateCardId: t.rateCardExternalId
          ? rateCardMap.get(t.rateCardExternalId) ?? null
          : null,
        rateCardLineId: null,
        resource: t.resource,
        role: t.role ?? null,
        seniority: t.seniority ?? null,
        workDate: new Date(t.workDate),
        hours: t.hours.toFixed(2),
        billRateUsd: t.billRateUsd?.toFixed(4) ?? null,
        amountUsd: t.amountUsd?.toFixed(2) ?? null,
        description: t.description ?? null,
        sourceSystem,
        sourceExternalId: t.externalId,
      }));
      await bulkC(rows, (chunk) =>
        db
          .insert(timeEntriesTable)
          .values(chunk)
          .onConflictDoUpdate({
            target: [
              timeEntriesTable.orgId,
              timeEntriesTable.sourceSystem,
              timeEntriesTable.sourceExternalId,
            ],
            set: {
              hours: sql`excluded.hours`,
              billRateUsd: sql`excluded.bill_rate_usd`,
              amountUsd: sql`excluded.amount_usd`,
              description: sql`excluded.description`,
              sourceSyncedAt: sql`now()`,
            },
          }),
      );
      created += valid.length;
      processed += valid.length;
      await onProgress?.({ recordsProcessed: processed });
    }
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
    // Only include skipped/warnings keys when there is something to
    // report — keeps the result row identical for the happy path so
    // existing `JSON.stringify(selectedJob.result)` snapshots stay
    // small and unchanged.
    ...(unknownSkipped > 0 ? { recordsSkipped: unknownSkipped } : {}),
    ...(unknownWarnings.length > 0 ? { warnings: unknownWarnings } : {}),
    cursor: new Date().toISOString(),
    durationMs: Date.now() - start,
  };
}
