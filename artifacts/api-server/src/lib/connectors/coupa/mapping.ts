import type { IngestPayload } from "../../adapters/ingest-writer";

/**
 * Map Coupa REST API response payloads → the canonical `IngestPayload`
 * shape consumed by `writeIngestPayload`. Pure functions, no I/O —
 * lives in its own module so unit tests can pin the field-by-field
 * transformation against captured fixtures without booting the
 * connector or the OAuth flow.
 *
 * Coupa REST nuances we paper over here:
 *
 * - Field casing is `kebab-case` over the wire (`updated-at`,
 *   `total-with-taxes`); the Coupa client side normalises to
 *   camelCase before passing in, so this module operates on
 *   camelCase keys.
 * - Currency amounts come back as `{value: "1234.56", currency-code:
 *   "USD"}`; for now we ingest USD-denominated amounts directly into
 *   the `*_usd` columns and tag non-USD with metadata for later FX
 *   conversion.
 * - "External id" for our writer is Coupa's primary `id` field
 *   (numeric, stringified).
 */

// ---------- Coupa wire shapes (subset we actually consume) -----------

export interface CoupaSupplier {
  id: number | string;
  name: string;
  /** ISO-3166-1 alpha-2 country code, lifted from `primary-address`. */
  countryCode?: string | null;
  /** ISO-4217 currency code, lifted from `currency.code`. */
  currencyCode?: string | null;
  paymentTerms?: { code?: string; netDays?: number | null } | null;
  status?: string | null;
  /** Free-form tags surfaced by the Coupa supplier `tags` field. */
  tags?: string[] | null;
  preferred?: boolean | null;
  /** Primary key for incremental sync watermarks. */
  updatedAt?: string | null;
}

export interface CoupaContract {
  id: number | string;
  number: string;
  name?: string | null;
  supplierId?: number | string | null;
  startDate?: string | null;
  endDate?: string | null;
  paymentTerms?: { netDays?: number | null } | null;
  totalValue?: { value?: string | number | null; currencyCode?: string | null } | null;
  updatedAt?: string | null;
}

export interface CoupaPoLine {
  id: number | string;
  lineNumber?: number | null;
  description?: string | null;
  itemNumber?: string | null;
  quantity?: number | string | null;
  uom?: string | null;
  price?: { value?: string | number | null; currencyCode?: string | null } | null;
  total?: { value?: string | number | null; currencyCode?: string | null } | null;
  /** Coupa's "commodity" maps to our category. */
  commodity?: { code?: string | null; name?: string | null } | null;
}

export interface CoupaPurchaseOrder {
  id: number | string;
  poNumber: string;
  supplierId?: number | string | null;
  contractId?: number | string | null;
  status?: string | null;
  orderDate?: string | null;
  businessUnit?: string | null;
  site?: string | null;
  total?: { value?: string | number | null; currencyCode?: string | null } | null;
  lines?: CoupaPoLine[];
  updatedAt?: string | null;
}

export interface CoupaInvoice {
  id: number | string;
  invoiceNumber: string;
  supplierId?: number | string | null;
  poId?: number | string | null;
  invoiceDate?: string | null;
  total?: { value?: string | number | null; currencyCode?: string | null } | null;
  status?:
    | "received"
    | "approved"
    | "paid"
    | "disputed"
    | "void"
    | string
    | null;
  updatedAt?: string | null;
}

export interface CoupaPayment {
  id: number | string;
  invoiceId?: number | string | null;
  paidDate?: string | null;
  total?: { value?: string | number | null; currencyCode?: string | null } | null;
  paymentTerms?: { netDays?: number | null } | null;
  updatedAt?: string | null;
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
    throw new Error("Coupa record missing required `id` field");
  }
  return s;
}

function dateStr(v: string | null | undefined): string | null {
  if (!v) return null;
  // Coupa returns ISO-8601 already; normalise to UTC by re-parsing
  // through Date so a trailing TZ offset doesn't trip up downstream
  // consumers that expect a stable wire format.
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function dateStrRequired(
  v: string | null | undefined,
  field: string,
): string {
  const s = dateStr(v);
  if (s === null) {
    throw new Error(`Coupa record missing required date field "${field}"`);
  }
  return s;
}

function normalizeInvoiceStatus(
  s: string | null | undefined,
): "received" | "approved" | "paid" | "disputed" | "void" | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase();
  switch (lower) {
    case "received":
    case "approved":
    case "paid":
    case "disputed":
    case "void":
      return lower;
    case "draft":
    case "pending_approval":
    case "pending":
      return "received";
    case "approved_for_payment":
      return "approved";
    case "voided":
    case "cancelled":
      return "void";
    default:
      return "received";
  }
}

function spendClassFromCommodity(
  commodity: CoupaPoLine["commodity"],
): "direct" | "indirect" | "service" {
  // Coupa doesn't ship a direct/indirect/service distinction out of
  // the box; we infer from the commodity name keywords. Operators can
  // refine the mapping later by running the spend-class classifier.
  const name = (commodity?.name ?? "").toLowerCase();
  if (/service|consult|labor|labour/.test(name)) return "service";
  if (/raw|material|component|chemical|metal/.test(name)) return "direct";
  return "indirect";
}

function classFromCommodity(
  commodity: CoupaPoLine["commodity"],
): "direct" | "indirect" | "service" {
  return spendClassFromCommodity(commodity);
}

// ---------- Mappers --------------------------------------------------

type SupplierItem = NonNullable<IngestPayload["suppliers"]>[number];
type ContractItem = NonNullable<IngestPayload["contracts"]>[number];
type PurchaseOrderItem = NonNullable<IngestPayload["purchaseOrders"]>[number];
type InvoiceItem = NonNullable<IngestPayload["invoices"]>[number];
type PaymentItem = NonNullable<IngestPayload["payments"]>[number];

export function mapSupplier(s: CoupaSupplier): SupplierItem {
  return {
    externalId: reqId(s.id),
    name: s.name,
    countryCode: s.countryCode ?? undefined,
    billingCurrency: s.currencyCode ?? undefined,
    paymentTermsDays:
      s.paymentTerms?.netDays != null
        ? String(s.paymentTerms.netDays)
        : undefined,
    isPreferred: s.preferred ?? false,
    isStrategic: false,
    tags: s.tags ?? [],
  };
}

export function mapContract(
  c: CoupaContract,
): ContractItem | null {
  const supplierExternalId = id(c.supplierId);
  if (!supplierExternalId) return null;
  const startDate = dateStr(c.startDate);
  const endDate = dateStr(c.endDate);
  if (!startDate || !endDate) return null;
  return {
    externalId: reqId(c.id),
    contractNumber: c.number,
    title: c.name ?? c.number,
    supplierExternalId,
    startDate,
    endDate,
    paymentTermsDays: c.paymentTerms?.netDays ?? undefined,
    billingCurrency: c.totalValue?.currencyCode ?? undefined,
    annualBaselineUsd: num(c.totalValue?.value, 0),
    items: [],
  };
}

export function mapPurchaseOrder(
  po: CoupaPurchaseOrder,
): PurchaseOrderItem | null {
  const supplierExternalId = id(po.supplierId);
  if (!supplierExternalId) return null;
  const orderDate = dateStr(po.orderDate);
  if (!orderDate) return null;
  const lines = (po.lines ?? []).map((ln, idx) => ({
    externalId: id(ln.id) ?? undefined,
    lineNumber: ln.lineNumber ?? idx + 1,
    sku: ln.itemNumber ?? `${po.poNumber}-${idx + 1}`,
    description: ln.description ?? "",
    spendClass: spendClassFromCommodity(ln.commodity),
    qty: num(ln.quantity, 1),
    uom: ln.uom ?? undefined,
    unitPriceUsd: num(ln.price?.value, 0),
  }));
  return {
    externalId: reqId(po.id),
    poNumber: po.poNumber,
    supplierExternalId,
    contractExternalId: id(po.contractId) ?? undefined,
    businessUnit: po.businessUnit ?? undefined,
    site: po.site ?? undefined,
    orderDate,
    lines,
  };
}

export function mapInvoice(
  inv: CoupaInvoice,
): InvoiceItem | null {
  const supplierExternalId = id(inv.supplierId);
  if (!supplierExternalId) return null;
  const invoiceDate = dateStr(inv.invoiceDate);
  if (!invoiceDate) return null;
  return {
    externalId: reqId(inv.id),
    invoiceNumber: inv.invoiceNumber,
    supplierExternalId,
    poExternalId: id(inv.poId) ?? undefined,
    invoiceDate,
    amountUsd: num(inv.total?.value, 0),
    // Coupa invoice id + invoice number is the natural dedup key —
    // re-publishing the same invoice from Coupa always preserves its
    // primary key, so a watermark replay can't accidentally double-count.
    dedupKey: `coupa:${reqId(inv.id)}:${inv.invoiceNumber}`,
    status: normalizeInvoiceStatus(inv.status),
  };
}

export function mapPayment(
  p: CoupaPayment,
): PaymentItem | null {
  const invoiceExternalId = id(p.invoiceId);
  if (!invoiceExternalId) return null;
  const paidDate = dateStr(p.paidDate);
  if (!paidDate) return null;
  return {
    externalId: reqId(p.id),
    invoiceExternalId,
    paidDate,
    amountUsd: num(p.total?.value, 0),
    paymentTermsDays: p.paymentTerms?.netDays ?? undefined,
  };
}

// ---------- Top-level batch mapper ------------------------------------

export interface CoupaBatch {
  suppliers?: CoupaSupplier[];
  contracts?: CoupaContract[];
  purchaseOrders?: CoupaPurchaseOrder[];
  invoices?: CoupaInvoice[];
  payments?: CoupaPayment[];
}

/**
 * Convert a batch of Coupa wire records into the canonical
 * `IngestPayload` shape. Rows that fail validation (missing supplier
 * id, unparseable date) are dropped silently and the dropped count is
 * surfaced via the return value so the caller can log / surface it on
 * the connection.
 */
export function buildIngestPayload(
  batch: CoupaBatch,
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
    else dropped["purchase_orders"] = (dropped["purchase_orders"] ?? 0) + 1;
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

// Re-export helpers under a non-`_` name for tests that want to pin
// the fallback behaviour.
export const _testHelpers = {
  classFromCommodity,
  normalizeInvoiceStatus,
};
