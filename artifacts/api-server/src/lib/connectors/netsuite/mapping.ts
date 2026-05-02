import type { IngestPayload } from "../../adapters/ingest-writer";

/**
 * Map NetSuite SuiteTalk REST API response payloads → the canonical
 * `IngestPayload` shape consumed by `writeIngestPayload`. Pure
 * functions, no I/O — lives in its own module so unit tests can pin
 * the field-by-field transformation against captured fixtures without
 * booting the connector or the OAuth flow.
 *
 * NetSuite REST nuances we paper over here:
 *
 *  - Field casing is `camelCase` over the wire (`tranDate`,
 *    `lastModifiedDate`); no normalisation step needed before the
 *    mapping module.
 *  - Dollar amounts come back as plain numbers in the account's base
 *    currency; we treat them as USD by default and tag the
 *    `billingCurrency` from the `currency.symbol` field when present.
 *  - Records carry a numeric `id` plus an upstream-stable
 *    `externalId` field; we prefer NetSuite's `id` as our writer's
 *    external id (the field most commonly populated and unique).
 *  - The watermark is `lastModifiedDate`, requested via
 *    `?q=lastModifiedDate AFTER "<iso>"` per SuiteQL.
 */

// ---------- NetSuite wire shapes (subset we actually consume) -------

export interface NetSuiteCurrencyRef {
  symbol?: string | null;
  refName?: string | null;
}

export interface NetSuiteVendor {
  id: number | string;
  entityId?: string | null;
  companyName?: string | null;
  /** ISO-3166-1 alpha-2 country code from `addressbook[0].country`. */
  countryCode?: string | null;
  currency?: NetSuiteCurrencyRef | null;
  terms?: { refName?: string | null; daysUntilNetDue?: number | null } | null;
  isInactive?: boolean | null;
  /** NetSuite-side preferred-vendor flag. */
  isPreferred?: boolean | null;
  /** Free-form custom segments surfaced as `customsegmentNN` keys. */
  category?: { refName?: string | null } | null;
  lastModifiedDate?: string | null;
}

export interface NetSuiteContract {
  id: number | string;
  /** SuiteTalk surface contract number; mirrors PO/Invoice tranid. */
  tranid?: string | null;
  title?: string | null;
  vendor?: { id: number | string | null } | null;
  startDate?: string | null;
  endDate?: string | null;
  terms?: { daysUntilNetDue?: number | null } | null;
  amount?: number | string | null;
  currency?: NetSuiteCurrencyRef | null;
  lastModifiedDate?: string | null;
}

export interface NetSuitePoLine {
  line?: number | null;
  itemId?: string | null;
  description?: string | null;
  quantity?: number | string | null;
  units?: string | null;
  rate?: number | string | null;
  amount?: number | string | null;
  /** NetSuite "class" segment; we treat it as a category hint. */
  klass?: { refName?: string | null } | null;
  /** Item type — `InvtPart`, `Service`, `OthCharge`, etc. */
  itemType?: string | null;
}

export interface NetSuitePurchaseOrder {
  id: number | string;
  tranid: string;
  entity?: { id: number | string | null } | null;
  /** NetSuite "linked contract" segment, when present. */
  contract?: { id: number | string | null } | null;
  status?: string | null;
  tranDate?: string | null;
  subsidiary?: { refName?: string | null } | null;
  location?: { refName?: string | null } | null;
  total?: number | string | null;
  currency?: NetSuiteCurrencyRef | null;
  item?: { items?: NetSuitePoLine[] } | null;
  lastModifiedDate?: string | null;
}

export interface NetSuiteInvoice {
  id: number | string;
  tranid: string;
  entity?: { id: number | string | null } | null;
  createdFrom?: { id: number | string | null } | null;
  tranDate?: string | null;
  total?: number | string | null;
  currency?: NetSuiteCurrencyRef | null;
  /**
   * NetSuite vendor-bill statuses: "Pending Approval", "Open",
   * "Paid In Full", "Voided", "Rejected".
   */
  status?: string | null;
  lastModifiedDate?: string | null;
}

export interface NetSuitePayment {
  id: number | string;
  /** When the payment is for a single bill, this is the `apply` row. */
  bill?: { id: number | string | null } | null;
  tranDate?: string | null;
  total?: number | string | null;
  currency?: NetSuiteCurrencyRef | null;
  terms?: { daysUntilNetDue?: number | null } | null;
  lastModifiedDate?: string | null;
}

// ---------- Helpers --------------------------------------------------

function num(v: string | number | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function id(v: number | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function reqId(v: number | string | null | undefined): string {
  const s = id(v);
  if (s === null) {
    throw new Error("NetSuite record missing required `id` field");
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
  if (lower.includes("paid")) return "paid";
  if (lower.includes("void") || lower.includes("cancel")) return "void";
  if (lower.includes("reject") || lower.includes("dispute")) return "disputed";
  if (lower.includes("approved") || lower === "open") return "approved";
  if (lower.includes("pending") || lower === "received") return "received";
  return "received";
}

/**
 * NetSuite tags every PO line with an `itemType`; SuiteTalk's
 * `InvtPart` / `NonInvtPart` are physical goods (direct), while
 * `Service` / `OthCharge` map to services. Anything else falls back
 * to indirect (the catch-all most NetSuite implementations use).
 */
function spendClassFromLine(
  line: NetSuitePoLine,
): "direct" | "indirect" | "service" {
  const t = (line.itemType ?? "").toLowerCase();
  if (t.includes("service") || t === "othcharge" || t === "discount") {
    return "service";
  }
  if (
    t === "invtpart" ||
    t === "noninvtpart" ||
    t === "assembly" ||
    t === "kitpackage"
  ) {
    return "direct";
  }
  // Class / department naming is a softer signal — only fall back if
  // the itemType didn't decide.
  const klass = (line.klass?.refName ?? "").toLowerCase();
  if (/service|consult|labor/.test(klass)) return "service";
  if (/raw|material|component/.test(klass)) return "direct";
  return "indirect";
}

// ---------- Mappers --------------------------------------------------

type SupplierItem = NonNullable<IngestPayload["suppliers"]>[number];
type ContractItem = NonNullable<IngestPayload["contracts"]>[number];
type PurchaseOrderItem = NonNullable<IngestPayload["purchaseOrders"]>[number];
type InvoiceItem = NonNullable<IngestPayload["invoices"]>[number];
type PaymentItem = NonNullable<IngestPayload["payments"]>[number];

export function mapVendor(v: NetSuiteVendor): SupplierItem {
  return {
    externalId: reqId(v.id),
    name: v.companyName ?? v.entityId ?? `vendor-${reqId(v.id)}`,
    countryCode: v.countryCode ?? undefined,
    billingCurrency: v.currency?.symbol ?? undefined,
    paymentTermsDays:
      v.terms?.daysUntilNetDue != null
        ? String(v.terms.daysUntilNetDue)
        : undefined,
    isPreferred: v.isPreferred ?? false,
    isStrategic: false,
    tags: v.category?.refName ? [v.category.refName] : [],
  };
}

export function mapContract(
  c: NetSuiteContract,
): ContractItem | null {
  const supplierExternalId = id(c.vendor?.id ?? null);
  if (!supplierExternalId) return null;
  const startDate = dateStr(c.startDate);
  const endDate = dateStr(c.endDate);
  if (!startDate || !endDate) return null;
  return {
    externalId: reqId(c.id),
    contractNumber: c.tranid ?? `NS-${reqId(c.id)}`,
    title: c.title ?? c.tranid ?? `NS-${reqId(c.id)}`,
    supplierExternalId,
    startDate,
    endDate,
    paymentTermsDays: c.terms?.daysUntilNetDue ?? undefined,
    billingCurrency: c.currency?.symbol ?? undefined,
    annualBaselineUsd: num(c.amount, 0),
    items: [],
  };
}

export function mapPurchaseOrder(
  po: NetSuitePurchaseOrder,
): PurchaseOrderItem | null {
  const supplierExternalId = id(po.entity?.id ?? null);
  if (!supplierExternalId) return null;
  const orderDate = dateStr(po.tranDate);
  if (!orderDate) return null;
  const lines = (po.item?.items ?? []).map((ln, idx) => ({
    lineNumber: ln.line ?? idx + 1,
    sku: ln.itemId ?? `${po.tranid}-${idx + 1}`,
    description: ln.description ?? "",
    spendClass: spendClassFromLine(ln),
    qty: num(ln.quantity, 1),
    uom: ln.units ?? undefined,
    unitPriceUsd: num(ln.rate, 0),
  }));
  return {
    externalId: reqId(po.id),
    poNumber: po.tranid,
    supplierExternalId,
    contractExternalId: id(po.contract?.id ?? null) ?? undefined,
    businessUnit: po.subsidiary?.refName ?? undefined,
    site: po.location?.refName ?? undefined,
    orderDate,
    lines,
  };
}

export function mapInvoice(
  inv: NetSuiteInvoice,
): InvoiceItem | null {
  const supplierExternalId = id(inv.entity?.id ?? null);
  if (!supplierExternalId) return null;
  const invoiceDate = dateStr(inv.tranDate);
  if (!invoiceDate) return null;
  return {
    externalId: reqId(inv.id),
    invoiceNumber: inv.tranid,
    supplierExternalId,
    poExternalId: id(inv.createdFrom?.id ?? null) ?? undefined,
    invoiceDate,
    amountUsd: num(inv.total, 0),
    // NetSuite's bill `id` is globally unique within a tenant; we pin
    // the dedup key on it so a watermark replay can't accidentally
    // double-count.
    dedupKey: `netsuite:${reqId(inv.id)}:${inv.tranid}`,
    status: normalizeInvoiceStatus(inv.status),
  };
}

export function mapPayment(
  p: NetSuitePayment,
): PaymentItem | null {
  const invoiceExternalId = id(p.bill?.id ?? null);
  if (!invoiceExternalId) return null;
  const paidDate = dateStr(p.tranDate);
  if (!paidDate) return null;
  return {
    externalId: reqId(p.id),
    invoiceExternalId,
    paidDate,
    amountUsd: num(p.total, 0),
    paymentTermsDays: p.terms?.daysUntilNetDue ?? undefined,
  };
}

// ---------- Top-level batch mapper ------------------------------------

export interface NetSuiteBatch {
  vendors?: NetSuiteVendor[];
  contracts?: NetSuiteContract[];
  purchaseOrders?: NetSuitePurchaseOrder[];
  invoices?: NetSuiteInvoice[];
  payments?: NetSuitePayment[];
}

/**
 * Convert a batch of NetSuite wire records into the canonical
 * `IngestPayload` shape. Rows that fail validation (missing vendor id,
 * unparseable date) are dropped silently and the dropped count is
 * surfaced via the return value so the caller can log / surface it on
 * the connection.
 */
export function buildIngestPayload(
  batch: NetSuiteBatch,
): { payload: IngestPayload; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {
    suppliers: 0,
    contracts: 0,
    purchase_orders: 0,
    invoices: 0,
    payments: 0,
  };

  const suppliers: SupplierItem[] = [];
  for (const v of batch.vendors ?? []) {
    try {
      suppliers.push(mapVendor(v));
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
  spendClassFromLine,
  normalizeInvoiceStatus,
};
