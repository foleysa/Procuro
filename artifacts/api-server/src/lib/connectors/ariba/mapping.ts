import type { IngestPayload } from "../../adapters/ingest-writer";

/**
 * Map SAP Ariba Operational Reporting / Procurement API payloads →
 * the canonical `IngestPayload` shape consumed by `writeIngestPayload`.
 * Pure functions, no I/O — lives in its own module so unit tests can
 * pin the field-by-field transformation against captured fixtures
 * without booting the connector or the OAuth flow.
 *
 * SAP Ariba REST nuances we paper over here:
 *
 *  - All payloads are camelCase JSON; no normalisation needed.
 *  - Currency amounts come back as `{amount: 1234.56, currency:
 *    "USD"}`; we ingest USD directly into `*_usd` columns and tag
 *    other currencies via `billingCurrency`.
 *  - Each record carries a tenant-stable `internalId` plus a separate
 *    realm-scoped `documentNumber`; we use `internalId` as the
 *    writer's external id.
 *  - The watermark is `lastUpdatedTime`, requested via
 *    `?filter=lastUpdatedTime gt <iso>`.
 */

// ---------- Ariba wire shapes (subset we actually consume) ----------

export interface AribaMoney {
  amount?: number | string | null;
  currency?: string | null;
}

export interface AribaSupplier {
  internalId: string;
  name?: string | null;
  smVendorId?: string | null;
  /** ISO-3166-1 alpha-2. */
  country?: string | null;
  baseCurrency?: string | null;
  paymentTerms?: { code?: string | null; netDays?: number | null } | null;
  status?: string | null;
  preferred?: boolean | null;
  classifications?: string[] | null;
  lastUpdatedTime?: string | null;
}

export interface AribaContract {
  internalId: string;
  documentNumber: string;
  title?: string | null;
  supplierInternalId?: string | null;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  paymentTerms?: { netDays?: number | null } | null;
  contractAmount?: AribaMoney | null;
  lastUpdatedTime?: string | null;
}

export interface AribaPoLine {
  lineNumber?: number | null;
  itemDescription?: string | null;
  partNumber?: string | null;
  quantity?: number | string | null;
  unitOfMeasure?: string | null;
  unitPrice?: AribaMoney | null;
  amount?: AribaMoney | null;
  /** Ariba commodity classification (UNSPSC family). */
  commodity?: { code?: string | null; description?: string | null } | null;
}

export interface AribaPurchaseOrder {
  internalId: string;
  documentNumber: string;
  supplierInternalId?: string | null;
  contractInternalId?: string | null;
  status?: string | null;
  orderDate?: string | null;
  /** Operational unit / cost-center hint from Ariba's `entityName`. */
  entityName?: string | null;
  shipToLocation?: string | null;
  totalAmount?: AribaMoney | null;
  lineItems?: AribaPoLine[];
  lastUpdatedTime?: string | null;
}

export interface AribaInvoice {
  internalId: string;
  documentNumber: string;
  supplierInternalId?: string | null;
  poInternalId?: string | null;
  invoiceDate?: string | null;
  totalAmount?: AribaMoney | null;
  /**
   * Ariba invoice statuses: `RECEIVED`, `APPROVED`, `PAID`,
   * `RECONCILING`, `REJECTED`, `CANCELLED`.
   */
  status?: string | null;
  lastUpdatedTime?: string | null;
}

export interface AribaPayment {
  internalId: string;
  invoiceInternalId?: string | null;
  paymentDate?: string | null;
  totalAmount?: AribaMoney | null;
  paymentTerms?: { netDays?: number | null } | null;
  lastUpdatedTime?: string | null;
}

// ---------- Helpers --------------------------------------------------

function num(v: string | number | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function id(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > 0 ? s : null;
}

function reqId(v: string | null | undefined, label = "internalId"): string {
  const s = id(v);
  if (s === null) {
    throw new Error(`Ariba record missing required \`${label}\` field`);
  }
  return s;
}

function dateStr(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeInvoiceStatus(
  s: string | null | undefined,
): "received" | "approved" | "paid" | "disputed" | "void" | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase().trim();
  switch (lower) {
    case "received":
    case "approved":
    case "paid":
    case "disputed":
    case "void":
      return lower;
    case "reconciling":
    case "submitted":
    case "pending":
      return "received";
    case "rejected":
      return "disputed";
    case "cancelled":
    case "canceled":
    case "voided":
      return "void";
    default:
      return "received";
  }
}

/**
 * SAP Ariba commodity codes follow UNSPSC; the first two digits are
 * the "segment" (50 = Food, 81 = Engineering Services, 80 = Management
 * Services, etc.). Services live in segments 70-86; raw materials in
 * 11-15; everything else falls to "indirect".
 */
function spendClassFromCommodity(
  commodity: AribaPoLine["commodity"],
): "direct" | "indirect" | "service" {
  const code = (commodity?.code ?? "").trim();
  const desc = (commodity?.description ?? "").toLowerCase();

  if (code.length >= 2) {
    const seg = Number(code.slice(0, 2));
    if (Number.isFinite(seg)) {
      if (seg >= 70 && seg <= 86) return "service";
      if (seg >= 11 && seg <= 15) return "direct";
    }
  }
  if (/service|consult|labor|labour/.test(desc)) return "service";
  if (/raw|material|component|chemical|metal/.test(desc)) return "direct";
  return "indirect";
}

// ---------- Mappers --------------------------------------------------

type SupplierItem = NonNullable<IngestPayload["suppliers"]>[number];
type ContractItem = NonNullable<IngestPayload["contracts"]>[number];
type PurchaseOrderItem = NonNullable<IngestPayload["purchaseOrders"]>[number];
type InvoiceItem = NonNullable<IngestPayload["invoices"]>[number];
type PaymentItem = NonNullable<IngestPayload["payments"]>[number];

export function mapSupplier(s: AribaSupplier): SupplierItem {
  return {
    externalId: reqId(s.internalId),
    name: s.name ?? s.smVendorId ?? `supplier-${s.internalId}`,
    countryCode: s.country ?? undefined,
    billingCurrency: s.baseCurrency ?? undefined,
    paymentTermsDays:
      s.paymentTerms?.netDays != null
        ? String(s.paymentTerms.netDays)
        : undefined,
    isPreferred: s.preferred ?? false,
    isStrategic: false,
    tags: s.classifications ?? [],
  };
}

export function mapContract(c: AribaContract): ContractItem | null {
  const supplierExternalId = id(c.supplierInternalId ?? null);
  if (!supplierExternalId) return null;
  const startDate = dateStr(c.effectiveDate);
  const endDate = dateStr(c.expirationDate);
  if (!startDate || !endDate) return null;
  return {
    externalId: reqId(c.internalId),
    contractNumber: c.documentNumber,
    title: c.title ?? c.documentNumber,
    supplierExternalId,
    startDate,
    endDate,
    paymentTermsDays: c.paymentTerms?.netDays ?? undefined,
    billingCurrency: c.contractAmount?.currency ?? undefined,
    annualBaselineUsd: num(c.contractAmount?.amount, 0),
    items: [],
  };
}

export function mapPurchaseOrder(
  po: AribaPurchaseOrder,
): PurchaseOrderItem | null {
  const supplierExternalId = id(po.supplierInternalId ?? null);
  if (!supplierExternalId) return null;
  const orderDate = dateStr(po.orderDate);
  if (!orderDate) return null;
  const lines = (po.lineItems ?? []).map((ln, idx) => ({
    lineNumber: ln.lineNumber ?? idx + 1,
    sku: ln.partNumber ?? `${po.documentNumber}-${idx + 1}`,
    description: ln.itemDescription ?? "",
    spendClass: spendClassFromCommodity(ln.commodity),
    qty: num(ln.quantity, 1),
    uom: ln.unitOfMeasure ?? undefined,
    unitPriceUsd: num(ln.unitPrice?.amount, 0),
  }));
  return {
    externalId: reqId(po.internalId),
    poNumber: po.documentNumber,
    supplierExternalId,
    contractExternalId: id(po.contractInternalId ?? null) ?? undefined,
    businessUnit: po.entityName ?? undefined,
    site: po.shipToLocation ?? undefined,
    orderDate,
    lines,
  };
}

export function mapInvoice(inv: AribaInvoice): InvoiceItem | null {
  const supplierExternalId = id(inv.supplierInternalId ?? null);
  if (!supplierExternalId) return null;
  const invoiceDate = dateStr(inv.invoiceDate);
  if (!invoiceDate) return null;
  return {
    externalId: reqId(inv.internalId),
    invoiceNumber: inv.documentNumber,
    supplierExternalId,
    poExternalId: id(inv.poInternalId ?? null) ?? undefined,
    invoiceDate,
    amountUsd: num(inv.totalAmount?.amount, 0),
    // Ariba's `internalId` plus the document number is the natural
    // dedup key — re-publishing the same invoice from Ariba always
    // preserves both fields, so a watermark replay can't accidentally
    // double-count.
    dedupKey: `ariba:${reqId(inv.internalId)}:${inv.documentNumber}`,
    status: normalizeInvoiceStatus(inv.status),
  };
}

export function mapPayment(p: AribaPayment): PaymentItem | null {
  const invoiceExternalId = id(p.invoiceInternalId ?? null);
  if (!invoiceExternalId) return null;
  const paidDate = dateStr(p.paymentDate);
  if (!paidDate) return null;
  return {
    externalId: reqId(p.internalId),
    invoiceExternalId,
    paidDate,
    amountUsd: num(p.totalAmount?.amount, 0),
    paymentTermsDays: p.paymentTerms?.netDays ?? undefined,
  };
}

// ---------- Top-level batch mapper ------------------------------------

export interface AribaBatch {
  suppliers?: AribaSupplier[];
  contracts?: AribaContract[];
  purchaseOrders?: AribaPurchaseOrder[];
  invoices?: AribaInvoice[];
  payments?: AribaPayment[];
}

/**
 * Convert a batch of Ariba wire records into the canonical
 * `IngestPayload` shape. Rows that fail validation are dropped
 * silently and the dropped count is surfaced via the return value so
 * the caller can log / surface it on the connection.
 */
export function buildIngestPayload(
  batch: AribaBatch,
): { payload: IngestPayload; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {
    suppliers: 0,
    contracts: 0,
    purchase_orders: 0,
    invoices: 0,
    payments: 0,
  };

  const suppliers: SupplierItem[] = [];
  for (const s of batch.suppliers ?? []) {
    try {
      suppliers.push(mapSupplier(s));
    } catch {
      dropped["suppliers"] = (dropped["suppliers"] ?? 0) + 1;
    }
  }

  const contracts: ContractItem[] = [];
  for (const c of batch.contracts ?? []) {
    const mapped = mapContract(c);
    if (mapped) contracts.push(mapped);
    else dropped["contracts"] = (dropped["contracts"] ?? 0) + 1;
  }

  const purchaseOrders: PurchaseOrderItem[] = [];
  for (const po of batch.purchaseOrders ?? []) {
    const mapped = mapPurchaseOrder(po);
    if (mapped) purchaseOrders.push(mapped);
    else
      dropped["purchase_orders"] =
        (dropped["purchase_orders"] ?? 0) + 1;
  }

  const invoices: InvoiceItem[] = [];
  for (const inv of batch.invoices ?? []) {
    const mapped = mapInvoice(inv);
    if (mapped) invoices.push(mapped);
    else dropped["invoices"] = (dropped["invoices"] ?? 0) + 1;
  }

  const payments: PaymentItem[] = [];
  for (const p of batch.payments ?? []) {
    const mapped = mapPayment(p);
    if (mapped) payments.push(mapped);
    else dropped["payments"] = (dropped["payments"] ?? 0) + 1;
  }

  return {
    payload: {
      suppliers,
      contracts,
      purchaseOrders,
      invoices,
      payments,
    },
    dropped,
  };
}

export const _testHelpers = {
  spendClassFromCommodity,
  normalizeInvoiceStatus,
};
