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
  /**
   * Coupa surfaces master/child contract relationships via either a
   * `parent-id` or `master-agreement-id` field depending on tenant
   * configuration. The adapter normalises both into this single
   * camelCase key so the mapper can resolve MSA → SOW links without
   * caring which variant the wire used.
   */
  parentContractId?: number | string | null;
  startDate?: string | null;
  endDate?: string | null;
  paymentTerms?: { netDays?: number | null } | null;
  totalValue?: { value?: string | number | null; currencyCode?: string | null } | null;
  updatedAt?: string | null;
}

// ---------- Services-spend wire shapes (Task #232) -------------------

export interface CoupaSowMilestone {
  id?: number | string;
  number?: number | string | null;
  name: string;
  description?: string | null;
  dueDate?: string | null;
  value?: { value?: string | number | null; currencyCode?: string | null } | null;
  status?: string | null;
  deliveredAt?: string | null;
  acceptedAt?: string | null;
}

export interface CoupaSowChangeOrder {
  id?: number | string;
  number: string;
  name: string;
  description?: string | null;
  status?: string | null;
  valueDelta?:
    | { value?: string | number | null; currencyCode?: string | null }
    | null;
  dateDeltaDays?: number | string | null;
  proposedAt?: string | null;
  executedAt?: string | null;
}

export interface CoupaStatementOfWork {
  id: number | string;
  number: string;
  name?: string | null;
  /** Parent MSA contract id (Coupa contract this SOW rolls up to). */
  contractId?: number | string | null;
  supplierId?: number | string | null;
  status?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  totalValue?:
    | { value?: string | number | null; currencyCode?: string | null }
    | null;
  scope?: unknown;
  acceptanceCriteria?: string | null;
  milestones?: CoupaSowMilestone[];
  changeOrders?: CoupaSowChangeOrder[];
  updatedAt?: string | null;
}

export interface CoupaRateCardLine {
  id?: number | string;
  role: string;
  seniority?: string | null;
  hourlyRate?: number | string | null;
  dailyRate?: number | string | null;
  roleCode?: string | null;
}

export interface CoupaRateCard {
  id: number | string;
  name: string;
  supplierId?: number | string | null;
  contractId?: number | string | null;
  sowId?: number | string | null;
  currencyCode?: string | null;
  effectiveDate?: string | null;
  expiryDate?: string | null;
  lines?: CoupaRateCardLine[];
  updatedAt?: string | null;
}

export interface CoupaTimeEntry {
  id: number | string;
  supplierId?: number | string | null;
  contractId?: number | string | null;
  sowId?: number | string | null;
  rateCardId?: number | string | null;
  /** Free-form resource identifier (consultant name, vendor employee id). */
  resource: string;
  role?: string | null;
  seniority?: string | null;
  workDate?: string | null;
  hours?: number | string | null;
  billRate?:
    | { value?: string | number | null; currencyCode?: string | null }
    | null;
  amount?:
    | { value?: string | number | null; currencyCode?: string | null }
    | null;
  description?: string | null;
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

/**
 * Map a Coupa commodity → one of our canonical category codes from
 * `lib/db/seeds/taxonomy.sql` (Task #214). Pattern-matches on the
 * commodity name first (more reliable than Coupa's free-form `code`).
 *
 * Returns `null` when no confident mapping exists; the caller is
 * expected to fall back to its existing classification flow (which
 * eventually surfaces the row as `INDIRECT_OTHER`).
 *
 * Kept conservative on purpose — false-positive category mappings
 * are worse than misses because they pin a contract to the wrong
 * band and route it to the wrong levers.
 */
export function categoryCodeFromCommodity(
  commodity: CoupaPoLine["commodity"],
): string | null {
  const name = (commodity?.name ?? "").toLowerCase();
  if (!name) return null;

  // Professional services
  if (/\blegal\b|law firm|outside counsel/.test(name)) return "PROF_LEGAL";
  if (/\baudit\b|tax advisory|big four/.test(name)) return "PROF_AUDIT_TAX";
  if (/strategy consulting|management consult/.test(name))
    return "PROF_CONSULTING_STRATEGY";
  if (/operations consulting|process consulting|implementation/.test(name))
    return "PROF_CONSULTING_OPS";
  if (/m&a|investment bank|transaction advisor/.test(name))
    return "PROF_M_AND_A_ADVISORY";
  if (/consulting/.test(name)) return "PROF_CONSULTING_OPS";

  // IT services / SaaS
  if (/\bsaas\b|software as a service|cloud subscription/.test(name))
    return "IT_SAAS";
  if (/managed service|\bmsp\b/.test(name)) return "IT_MANAGED_SERVICES";
  if (/cyber|infosec|security service/.test(name)) return "IT_CYBER";
  if (/help desk|service desk|it support/.test(name)) return "IT_HELP_DESK";
  if (/application development|software development|custom software/.test(name))
    return "IT_APP_DEV";
  if (/datacenter|cloud infrastructure|it infrastructure/.test(name))
    return "IT_INFRA";

  // HR / contingent
  if (/staff aug|temp labor|temp staffing|contingent labor|staffing agency/.test(name))
    return "HR_CONTINGENT_LABOR";
  if (/recruit|talent acquisition|executive search/.test(name))
    return "HR_RECRUITING";
  if (/training|learning & development|\bl&d\b/.test(name))
    return "HR_TRAINING";
  if (/payroll|benefits administration/.test(name))
    return "HR_PAYROLL_BENEFITS";

  // Marketing
  if (/martech|marketing automation/.test(name))
    return "MKT_MARTECH_SAAS";
  if (/media buying|programmatic ad/.test(name)) return "MKT_MEDIA_BUYING";
  if (/public relations|\bpr agency\b/.test(name)) return "MKT_PR";
  if (/trade show|event/.test(name)) return "MKT_EVENTS_TRADE_SHOWS";
  if (/market research|consumer insight/.test(name)) return "MKT_RESEARCH";
  if (/creative agency|ad agency|brand agency/.test(name))
    return "MKT_AGENCY_CREATIVE";

  // Facilities
  if (/janitorial|cleaning service|facility cleaning/.test(name))
    return "FAC_JANITORIAL";
  if (/security guard|physical security/.test(name)) return "FAC_SECURITY";
  if (/landscaping|grounds maintenance/.test(name)) return "FAC_LANDSCAPING";
  if (/cafeteria|catering/.test(name)) return "FAC_CATERING";
  if (/building maintenance|hvac/.test(name)) return "FAC_MAINTENANCE";
  if (/lease|property rent|office rent/.test(name)) return "FAC_LEASES";
  if (/utilit|water & sewer|waste disposal/.test(name)) return "FAC_UTILITIES";

  // Logistics
  if (/ocean freight|\bfcl\b|\blcl\b/.test(name)) return "LOG_FREIGHT_OCEAN";
  if (/air freight|airfreight/.test(name)) return "LOG_FREIGHT_AIR";
  if (/last mile|final mile/.test(name)) return "LOG_LAST_MILE";
  if (/customs broker/.test(name)) return "LOG_CUSTOMS_BROKERAGE";
  if (/parcel|express shipping/.test(name)) return "LOG_PARCEL";
  if (/3pl/.test(name)) return "LOG_3PL";

  // Telecom
  if (/wireless|cellular/.test(name)) return "TEL_WIRELESS";
  if (/conferencing/.test(name)) return "TEL_CONFERENCING";
  if (/network service|\bwan\b|\bmpls\b/.test(name)) return "TEL_NETWORK";

  // Travel
  if (/travel management|\btmc\b/.test(name)) return "TRV_TMC";
  if (/airfare|corporate air/.test(name)) return "TRV_AIR";
  if (/hotel|lodging/.test(name)) return "TRV_HOTEL";
  if (/car rental|rideshare|ground transport/.test(name)) return "TRV_GROUND";

  // Financial
  if (/insurance/.test(name)) return "FIN_INSURANCE";
  if (/treasury|cash management/.test(name)) return "FIN_TREASURY";
  if (/external audit|statutory audit/.test(name)) return "FIN_AUDIT_EXTERNAL";
  if (/banking|bank fee/.test(name)) return "FIN_BANKING";

  // Engineering
  if (/r&d|research & development/.test(name)) return "ENG_RND";
  if (/engineering design|product design/.test(name)) return "ENG_DESIGN";
  if (/testing & certification|quality certif/.test(name))
    return "ENG_TESTING_CERT";

  return null;
}

/**
 * Infer the contract commercial structure (Task #214) from Coupa's free-form
 * commodity name + the contract's payment terms shape. Defaults to `goods`
 * for any contract we can't confidently classify so the back-compatible
 * default is preserved.
 */
function contractTypeFromCoupa(
  c: CoupaContract,
): "goods" | "t_and_m" | "fixed_price" | "milestone" | "retainer" | "outcome" {
  const name = (c.name ?? "").toLowerCase();
  if (/retainer|monthly fee/.test(name)) return "retainer";
  if (/outcome|success fee|gain.?share/.test(name)) return "outcome";
  if (/milestone|deliverable/.test(name)) return "milestone";
  if (/time & material|t&m|hourly/.test(name)) return "t_and_m";
  if (/fixed price|lump sum|fixed fee/.test(name)) return "fixed_price";
  // Service-flavored consulting / staffing without explicit T&M wording
  // tends to be T&M in practice.
  if (/consult|staff|advisor|managed service|sow/.test(name))
    return "t_and_m";
  return "goods";
}

// ---------- Mappers --------------------------------------------------

type SupplierItem = NonNullable<IngestPayload["suppliers"]>[number];
type ContractItem = NonNullable<IngestPayload["contracts"]>[number];
type PurchaseOrderItem = NonNullable<IngestPayload["purchaseOrders"]>[number];
type InvoiceItem = NonNullable<IngestPayload["invoices"]>[number];
type PaymentItem = NonNullable<IngestPayload["payments"]>[number];
type StatementOfWorkItem =
  NonNullable<IngestPayload["statementsOfWork"]>[number];
type RateCardItem = NonNullable<IngestPayload["rateCards"]>[number];
type TimeEntryItem = NonNullable<IngestPayload["timeEntries"]>[number];

function normalizeSowStatus(
  s: string | null | undefined,
): "draft" | "active" | "completed" | "cancelled" | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase();
  switch (lower) {
    case "draft":
      return "draft";
    case "active":
    case "signed":
    case "in_progress":
    case "in-progress":
      return "active";
    case "completed":
    case "closed":
    case "done":
      return "completed";
    case "cancelled":
    case "canceled":
    case "void":
    case "voided":
      return "cancelled";
    default:
      return "active";
  }
}

function normalizeMilestoneStatus(
  s: string | null | undefined,
):
  | "pending"
  | "in_progress"
  | "delivered"
  | "accepted"
  | "invoiced"
  | "paid"
  | "cancelled"
  | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase().replace(/[\s-]/g, "_");
  switch (lower) {
    case "pending":
    case "open":
    case "not_started":
      return "pending";
    case "in_progress":
    case "started":
    case "active":
      return "in_progress";
    case "delivered":
    case "submitted":
      return "delivered";
    case "accepted":
    case "approved":
      return "accepted";
    case "invoiced":
    case "billed":
      return "invoiced";
    case "paid":
      return "paid";
    case "cancelled":
    case "canceled":
    case "void":
      return "cancelled";
    default:
      return "pending";
  }
}

function normalizeChangeOrderStatus(
  s: string | null | undefined,
): "proposed" | "approved" | "rejected" | "executed" | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase();
  switch (lower) {
    case "proposed":
    case "pending":
    case "draft":
      return "proposed";
    case "approved":
      return "approved";
    case "rejected":
    case "denied":
      return "rejected";
    case "executed":
    case "active":
    case "signed":
      return "executed";
    default:
      return "proposed";
  }
}

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
  const parentExt = id(c.parentContractId);
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
    // Task #214 — pre-populate the commercial structure so downstream
    // analyzers (T&M utilization, milestone burn-down) can scope.
    contractType: contractTypeFromCoupa(c),
    // Task #232 — when Coupa surfaces a parent/child contract link,
    // forward it so the ingest writer's MSA second-pass resolves the
    // child's `msa_parent_id` after the contract batch upsert.
    ...(parentExt ? { msaParentExternalId: parentExt } : {}),
    items: [],
  };
}

// ---------- Services-spend mappers (Task #232) -----------------------

export function mapStatementOfWork(
  s: CoupaStatementOfWork,
): StatementOfWorkItem | null {
  const supplierExternalId = id(s.supplierId);
  const contractExternalId = id(s.contractId);
  if (!supplierExternalId || !contractExternalId) return null;
  const startDate = dateStr(s.startDate);
  const endDate = dateStr(s.endDate);
  if (!startDate || !endDate) return null;
  const milestones = (s.milestones ?? []).map((m, idx) => ({
    milestoneNumber:
      typeof m.number === "number"
        ? m.number
        : m.number != null && Number.isFinite(Number(m.number))
          ? Number(m.number)
          : idx + 1,
    title: m.name,
    ...(m.description ? { description: m.description } : {}),
    ...(m.dueDate ? { dueDate: dateStr(m.dueDate) ?? undefined } : {}),
    ...(m.value?.value != null
      ? { valueUsd: num(m.value.value, 0) }
      : {}),
    ...(m.status
      ? { status: normalizeMilestoneStatus(m.status) ?? "pending" }
      : {}),
    ...(m.deliveredAt
      ? { deliveredAt: dateStr(m.deliveredAt) ?? undefined }
      : {}),
    ...(m.acceptedAt
      ? { acceptedAt: dateStr(m.acceptedAt) ?? undefined }
      : {}),
  }));
  const changeOrders = (s.changeOrders ?? []).map((co) => ({
    ...(co.id != null ? { externalId: id(co.id) ?? undefined } : {}),
    changeOrderNumber: co.number,
    title: co.name,
    ...(co.description ? { description: co.description } : {}),
    ...(co.status
      ? { status: normalizeChangeOrderStatus(co.status) ?? "proposed" }
      : {}),
    ...(co.valueDelta?.value != null
      ? { valueDeltaUsd: num(co.valueDelta.value, 0) }
      : {}),
    ...(co.dateDeltaDays != null
      ? { dateDeltaDays: Number(co.dateDeltaDays) }
      : {}),
    ...(co.proposedAt
      ? { proposedAt: dateStr(co.proposedAt) ?? undefined }
      : {}),
    ...(co.executedAt
      ? { executedAt: dateStr(co.executedAt) ?? undefined }
      : {}),
  }));
  return {
    externalId: reqId(s.id),
    sowNumber: s.number,
    title: s.name ?? s.number,
    contractExternalId,
    supplierExternalId,
    ...(s.status ? { status: normalizeSowStatus(s.status) ?? "active" } : {}),
    startDate,
    endDate,
    ...(s.totalValue?.value != null
      ? { totalValueUsd: num(s.totalValue.value, 0) }
      : {}),
    ...(s.totalValue?.currencyCode
      ? { billingCurrency: s.totalValue.currencyCode }
      : {}),
    ...(s.scope !== undefined && s.scope !== null ? { scope: s.scope } : {}),
    ...(s.acceptanceCriteria
      ? { acceptanceCriteria: s.acceptanceCriteria }
      : {}),
    ...(milestones.length > 0 ? { milestones } : {}),
    ...(changeOrders.length > 0 ? { changeOrders } : {}),
  };
}

export function mapRateCard(rc: CoupaRateCard): RateCardItem | null {
  const supplierExternalId = id(rc.supplierId);
  if (!supplierExternalId) return null;
  const contractExternalId = id(rc.contractId);
  const sowExternalId = id(rc.sowId);
  // The ingest writer requires either a contract or sow link — drop
  // orphan rate cards at the connector boundary so the writer warning
  // log isn't spammed with rows we already know are unattached.
  if (!contractExternalId && !sowExternalId) return null;
  const effectiveDate = dateStr(rc.effectiveDate);
  if (!effectiveDate) return null;
  const lines = (rc.lines ?? []).map((ln) => ({
    role: ln.role,
    ...(ln.seniority ? { seniority: ln.seniority } : {}),
    ...(ln.hourlyRate != null
      ? { hourlyRate: num(ln.hourlyRate, 0) }
      : {}),
    ...(ln.dailyRate != null
      ? { dailyRate: num(ln.dailyRate, 0) }
      : {}),
    ...(ln.roleCode ? { roleCode: ln.roleCode } : {}),
  }));
  return {
    externalId: reqId(rc.id),
    name: rc.name,
    supplierExternalId,
    ...(contractExternalId ? { contractExternalId } : {}),
    ...(sowExternalId ? { sowExternalId } : {}),
    ...(rc.currencyCode ? { currency: rc.currencyCode } : {}),
    effectiveDate,
    ...(rc.expiryDate
      ? { expiryDate: dateStr(rc.expiryDate) ?? undefined }
      : {}),
    ...(lines.length > 0 ? { lines } : {}),
  };
}

export function mapTimeEntry(t: CoupaTimeEntry): TimeEntryItem | null {
  const supplierExternalId = id(t.supplierId);
  if (!supplierExternalId) return null;
  const workDate = dateStr(t.workDate);
  if (!workDate) return null;
  const hours = num(t.hours, NaN);
  if (!Number.isFinite(hours)) return null;
  return {
    externalId: reqId(t.id),
    supplierExternalId,
    ...(t.contractId != null
      ? { contractExternalId: id(t.contractId) ?? undefined }
      : {}),
    ...(t.sowId != null
      ? { sowExternalId: id(t.sowId) ?? undefined }
      : {}),
    ...(t.rateCardId != null
      ? { rateCardExternalId: id(t.rateCardId) ?? undefined }
      : {}),
    resource: t.resource,
    ...(t.role ? { role: t.role } : {}),
    ...(t.seniority ? { seniority: t.seniority } : {}),
    workDate,
    hours,
    ...(t.billRate?.value != null
      ? { billRateUsd: num(t.billRate.value, 0) }
      : {}),
    ...(t.amount?.value != null
      ? { amountUsd: num(t.amount.value, 0) }
      : {}),
    ...(t.description ? { description: t.description } : {}),
  };
}

export function mapPurchaseOrder(
  po: CoupaPurchaseOrder,
): PurchaseOrderItem | null {
  const supplierExternalId = id(po.supplierId);
  if (!supplierExternalId) return null;
  const orderDate = dateStr(po.orderDate);
  if (!orderDate) return null;
  const lines = (po.lines ?? []).map((ln, idx) => {
    // Task #232 — emit `categoryExternalId` derived from the commodity
    // name so the ingest writer can resolve a category row by code on
    // the upsert path. The category itself is not auto-created by the
    // PO mapper (the writer drops the link if the code isn't already
    // in the categories table) — this just lets a tenant that
    // ingested categories first benefit from auto-linking.
    const categoryExternalId = categoryCodeFromCommodity(ln.commodity);
    return {
      externalId: id(ln.id) ?? undefined,
      lineNumber: ln.lineNumber ?? idx + 1,
      sku: ln.itemNumber ?? `${po.poNumber}-${idx + 1}`,
      description: ln.description ?? "",
      spendClass: spendClassFromCommodity(ln.commodity),
      qty: num(ln.quantity, 1),
      uom: ln.uom ?? undefined,
      unitPriceUsd: num(ln.price?.value, 0),
      ...(categoryExternalId ? { categoryExternalId } : {}),
    };
  });
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
  // Task #232 — services-spend taxonomy.
  statementsOfWork?: CoupaStatementOfWork[];
  rateCards?: CoupaRateCard[];
  timeEntries?: CoupaTimeEntry[];
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
    statements_of_work: 0,
    rate_cards: 0,
    time_entries: 0,
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

  const statementsOfWork: StatementOfWorkItem[] = [];
  for (const s of batch.statementsOfWork ?? []) {
    const mapped = mapStatementOfWork(s);
    if (mapped) statementsOfWork.push(mapped);
    else
      dropped["statements_of_work"] =
        (dropped["statements_of_work"] ?? 0) + 1;
  }

  const rateCards: RateCardItem[] = [];
  for (const rc of batch.rateCards ?? []) {
    const mapped = mapRateCard(rc);
    if (mapped) rateCards.push(mapped);
    else dropped["rate_cards"] = (dropped["rate_cards"] ?? 0) + 1;
  }

  const timeEntries: TimeEntryItem[] = [];
  for (const t of batch.timeEntries ?? []) {
    const mapped = mapTimeEntry(t);
    if (mapped) timeEntries.push(mapped);
    else dropped["time_entries"] = (dropped["time_entries"] ?? 0) + 1;
  }

  return {
    payload: {
      suppliers,
      contracts,
      purchaseOrders,
      invoices,
      payments,
      ...(statementsOfWork.length > 0 ? { statementsOfWork } : {}),
      ...(rateCards.length > 0 ? { rateCards } : {}),
      ...(timeEntries.length > 0 ? { timeEntries } : {}),
    },
    dropped,
  };
}

// Re-export helpers under a non-`_` name for tests that want to pin
// the fallback behaviour.
export const _testHelpers = {
  classFromCommodity,
  normalizeInvoiceStatus,
  categoryCodeFromCommodity,
  contractTypeFromCoupa,
};
