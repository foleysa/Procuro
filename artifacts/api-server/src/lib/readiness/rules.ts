import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import type { LeverId } from "@workspace/db";
import { tierLabels } from "@workspace/db";
import type {
  LeverReadiness,
  ReadinessBlocker,
  ReadinessContext,
} from "./types";

/**
 * Per-lever readiness rules.
 *
 * The contract is intentionally narrow: each rule receives the orgId and
 * a base path for fix-deep-links and returns a `LeverReadiness` row. A
 * rule never throws — missing tables / unexpected nulls collapse into a
 * `score: 0` blocker so the card can still render.
 *
 * Score model:
 *
 *   - Base `100`. Each blocker subtracts `missingPct` (clamped 0..100).
 *   - A `hard: true` blocker forces the score to `0` regardless of
 *     other measurements (e.g. zero suppliers means no FX exposure
 *     analyzer can possibly run).
 *
 * Centralising this here (rather than spreading SQL across analyzers)
 * keeps the readiness response cheap and stable even if an individual
 * analyzer changes its inputs.
 */
type RuleFn = (
  ctx: ReadinessContext,
) => Promise<{ blockers: ReadinessBlocker[] }>;

interface LeverRuleSpec {
  leverId: LeverId;
  label: string;
  rule: RuleFn;
}

/**
 * Build a deep-link URL the readiness card hands to the operator.
 *
 * The optional `missingField` is appended as a `?missing=<field>` query
 * param so the destination page can pre-filter to the exact rows the
 * blocker measured (e.g. `/suppliers?missing=billing_currency` shows
 * only the suppliers with no billing currency on file). Page-level
 * handlers silently ignore unknown values so the link still resolves
 * gracefully if the FE rolls out behind the BE.
 */
function fix(
  basePath: string | undefined,
  route: string,
  missingField?: string,
): string {
  const bp = basePath && basePath !== "/" ? basePath.replace(/\/$/, "") : "";
  const url = `${bp}${route.startsWith("/") ? route : `/${route}`}`;
  return missingField ? `${url}?missing=${encodeURIComponent(missingField)}` : url;
}

interface CountRow {
  total: number;
  missing: number;
}

/**
 * Run a single COUNT(*)+COUNT(field IS NULL/blank) query and translate
 * the result into a candidate blocker. Returns `null` when the field is
 * fully populated (or the table is empty AND `requireRows` is false).
 */
async function fieldCheck(args: {
  orgId: string;
  table: string;
  field: string;
  predicate?: string;
  whereExtra?: string;
  blockerId: string;
  fieldLabel: string;
  message: string;
  fixUrl: string;
  hardWhenEmpty?: boolean;
}): Promise<ReadinessBlocker | null> {
  const predicate =
    args.predicate ?? `${args.table}.${args.field} IS NULL OR ${args.table}.${args.field} = ''`;
  const where = `${args.table}.org_id = '${args.orgId.replace(/'/g, "''")}'${
    args.whereExtra ? ` AND ${args.whereExtra}` : ""
  }`;
  const q = sql.raw(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ${predicate})::int AS missing
       FROM ${args.table}
      WHERE ${where}`,
  );
  let row: CountRow;
  try {
    const out = await db.execute(q);
    row = (out.rows[0] as unknown as CountRow) ?? { total: 0, missing: 0 };
  } catch {
    // Table missing or query failed — surface as a hard blocker.
    return {
      id: args.blockerId,
      field: args.fieldLabel,
      message: args.message,
      missingPct: 100,
      missingCount: 0,
      totalCount: 0,
      fixUrl: args.fixUrl,
      hard: true,
    };
  }
  if (row.total === 0) {
    if (args.hardWhenEmpty === false) return null;
    return {
      id: args.blockerId,
      field: args.fieldLabel,
      message: args.message,
      missingPct: 100,
      missingCount: 0,
      totalCount: 0,
      fixUrl: args.fixUrl,
      hard: true,
    };
  }
  if (row.missing === 0) return null;
  const pct = Math.min(100, Math.round((row.missing / row.total) * 100));
  return {
    id: args.blockerId,
    field: args.fieldLabel,
    message: args.message,
    missingPct: pct,
    missingCount: row.missing,
    totalCount: row.total,
    fixUrl: args.fixUrl,
    hard: false,
  };
}

const RULES: LeverRuleSpec[] = [
  {
    leverId: "sku_price_benchmark",
    label: "SKU Price Benchmarking",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noSku = await fieldCheck({
        orgId: ctx.orgId,
        table: "po_lines",
        field: "sku",
        blockerId: "po_lines.sku",
        fieldLabel: "PO line SKU",
        message:
          "PO lines need a SKU to group like-for-like buys across sites and time.",
        fixUrl: fix(ctx.basePath, "/ingest", "sku"),
      });
      if (noSku) blockers.push(noSku);
      const noItem = await fieldCheck({
        orgId: ctx.orgId,
        table: "po_lines",
        field: "item_id",
        predicate: "po_lines.item_id IS NULL",
        blockerId: "po_lines.item_id",
        fieldLabel: "Item match",
        message:
          "PO lines aren't matched to a normalised item record — benchmarks group by item, not raw SKU text.",
        fixUrl: fix(ctx.basePath, "/ingest", "item_id"),
        hardWhenEmpty: false,
      });
      if (noItem) blockers.push(noItem);
      return { blockers };
    },
  },
  {
    leverId: "maverick_spend",
    label: "Maverick Spend Detection",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noContractLink = await fieldCheck({
        orgId: ctx.orgId,
        table: "purchase_orders",
        field: "contract_id",
        predicate: "purchase_orders.contract_id IS NULL",
        blockerId: "purchase_orders.contract_id",
        fieldLabel: "PO → contract link",
        message:
          "POs without a contract reference can't be classified as on- or off-contract.",
        // No `?missing=` here: the contracts list page can't filter on a
        // *PO* column. The fix is a re-import of POs with the contract
        // reference set, which lives on /ingest, but we keep the link
        // pointing at /contracts so the operator first verifies the
        // contract they meant to reference actually exists.
        fixUrl: fix(ctx.basePath, "/contracts"),
        hardWhenEmpty: false,
      });
      if (noContractLink) blockers.push(noContractLink);
      const noContracts = await fieldCheck({
        orgId: ctx.orgId,
        table: "contracts",
        field: "id",
        predicate: "FALSE",
        blockerId: "contracts.exists",
        fieldLabel: "Contracts loaded",
        message:
          "No contracts loaded — maverick-spend detection compares POs against the active contract base.",
        fixUrl: fix(ctx.basePath, "/contracts"),
      });
      if (noContracts) blockers.push(noContracts);
      return { blockers };
    },
  },
  {
    leverId: "contract_leakage",
    label: "Contract Leakage",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noBaseline = await fieldCheck({
        orgId: ctx.orgId,
        table: "contracts",
        field: "annual_baseline_usd",
        predicate:
          "contracts.annual_baseline_usd IS NULL OR contracts.annual_baseline_usd::numeric <= 0",
        blockerId: "contracts.annual_baseline_usd",
        fieldLabel: "Contract annual baseline",
        message:
          "Contract leakage can't be sized without an annual baseline value on each contract.",
        fixUrl: fix(ctx.basePath, "/contracts", "annual_baseline_usd"),
      });
      if (noBaseline) blockers.push(noBaseline);
      return { blockers };
    },
  },
  {
    leverId: "duplicate_payment",
    label: "Duplicate-Payment Detection",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noDedup = await fieldCheck({
        orgId: ctx.orgId,
        table: "invoices",
        field: "dedup_key",
        blockerId: "invoices.dedup_key",
        fieldLabel: "Invoice dedup key",
        message:
          "Invoices need a populated dedup key (supplier + amount + date hash) to flag duplicates.",
        fixUrl: fix(ctx.basePath, "/ingest", "dedup_key"),
      });
      if (noDedup) blockers.push(noDedup);
      return { blockers };
    },
  },
  {
    leverId: "missed_volume_threshold",
    label: "Missed Volume Threshold",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noBaseline = await fieldCheck({
        orgId: ctx.orgId,
        table: "contracts",
        field: "annual_baseline_usd",
        predicate:
          "contracts.annual_baseline_usd IS NULL OR contracts.annual_baseline_usd::numeric <= 0",
        blockerId: "contracts.annual_baseline_usd",
        fieldLabel: "Contract annual baseline",
        message:
          "Volume thresholds compare actual spend vs. the contract's annual baseline.",
        fixUrl: fix(ctx.basePath, "/contracts", "annual_baseline_usd"),
      });
      if (noBaseline) blockers.push(noBaseline);
      const noPos = await fieldCheck({
        orgId: ctx.orgId,
        table: "purchase_orders",
        field: "id",
        predicate: "FALSE",
        blockerId: "purchase_orders.exists",
        fieldLabel: "Purchase orders loaded",
        message: "No POs loaded — actual spend can't be measured.",
        fixUrl: fix(ctx.basePath, "/ingest", "purchase_orders"),
      });
      if (noPos) blockers.push(noPos);
      return { blockers };
    },
  },
  {
    leverId: "payment_term_extension",
    label: "Payment Term Extension",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noTerms = await fieldCheck({
        orgId: ctx.orgId,
        table: "suppliers",
        field: "payment_terms_days",
        blockerId: "suppliers.payment_terms_days",
        fieldLabel: "Supplier payment terms",
        message:
          "Supplier payment terms (days) drive the working-capital uplift estimate.",
        fixUrl: fix(ctx.basePath, "/suppliers", "payment_terms_days"),
      });
      if (noTerms) blockers.push(noTerms);
      const noPayments = await fieldCheck({
        orgId: ctx.orgId,
        table: "payments",
        field: "id",
        predicate: "FALSE",
        blockerId: "payments.exists",
        fieldLabel: "Payments loaded",
        message:
          "No payment records loaded — the analyzer can't size DPO uplift without paid-date data.",
        fixUrl: fix(ctx.basePath, "/ingest", "payments"),
      });
      if (noPayments) blockers.push(noPayments);
      return { blockers };
    },
  },
  {
    leverId: "tail_spend_rationalization",
    label: "Tail-Spend Rationalisation",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noCat = await fieldCheck({
        orgId: ctx.orgId,
        table: "po_lines",
        field: "category_id",
        predicate: "po_lines.category_id IS NULL",
        blockerId: "po_lines.category_id",
        fieldLabel: "PO line category",
        message:
          "PO lines need a category to bucket the long tail of small suppliers.",
        fixUrl: fix(ctx.basePath, "/ingest", "category_id"),
      });
      if (noCat) blockers.push(noCat);
      return { blockers };
    },
  },
  {
    leverId: "supplier_consolidation",
    label: "Supplier Consolidation",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noCat = await fieldCheck({
        orgId: ctx.orgId,
        table: "po_lines",
        field: "category_id",
        predicate: "po_lines.category_id IS NULL",
        blockerId: "po_lines.category_id",
        fieldLabel: "PO line category",
        message:
          "Consolidation candidates need PO lines grouped by category to find duplicate suppliers.",
        fixUrl: fix(ctx.basePath, "/ingest", "category_id"),
      });
      if (noCat) blockers.push(noCat);
      const noSup = await fieldCheck({
        orgId: ctx.orgId,
        table: "suppliers",
        field: "id",
        predicate: "FALSE",
        blockerId: "suppliers.exists",
        fieldLabel: "Suppliers loaded",
        message: "No suppliers loaded yet.",
        fixUrl: fix(ctx.basePath, "/suppliers"),
      });
      if (noSup) blockers.push(noSup);
      return { blockers };
    },
  },
  {
    leverId: "contract_renegotiation_trigger",
    label: "Contract Renegotiation Trigger",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noEnd = await fieldCheck({
        orgId: ctx.orgId,
        table: "contracts",
        field: "end_date",
        predicate: "contracts.end_date IS NULL",
        blockerId: "contracts.end_date",
        fieldLabel: "Contract end date",
        message:
          "Renewal triggers fire X days before contract end — end date is required.",
        // No `?missing=end_date` deep-link: `contracts.end_date` is
        // `NOT NULL` in the schema, so a list filtered on null end-dates
        // could never return rows. In practice this blocker only fires
        // in the empty-table case, where /contracts (unfiltered) is the
        // right destination so the operator sees the empty state.
        fixUrl: fix(ctx.basePath, "/contracts"),
      });
      if (noEnd) blockers.push(noEnd);
      const noOwner = await fieldCheck({
        orgId: ctx.orgId,
        table: "contracts",
        field: "owner",
        blockerId: "contracts.owner",
        fieldLabel: "Contract owner",
        message:
          "Renewal alerts route to the contract owner — without one, alerts have no recipient.",
        fixUrl: fix(ctx.basePath, "/contracts", "owner"),
        hardWhenEmpty: false,
      });
      if (noOwner) blockers.push(noOwner);
      return { blockers };
    },
  },
  {
    leverId: "spot_vs_contract",
    label: "Spot vs. Contract",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noLink = await fieldCheck({
        orgId: ctx.orgId,
        table: "purchase_orders",
        field: "contract_id",
        predicate: "purchase_orders.contract_id IS NULL",
        blockerId: "purchase_orders.contract_id",
        fieldLabel: "PO → contract link",
        message:
          "Spot vs. contract comparison needs each PO tagged with its governing contract (if any).",
        fixUrl: fix(ctx.basePath, "/contracts"),
        hardWhenEmpty: false,
      });
      if (noLink) blockers.push(noLink);
      return { blockers };
    },
  },
  {
    leverId: "supplier_fx_exposure",
    label: "Supplier FX Exposure",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noCcy = await fieldCheck({
        orgId: ctx.orgId,
        table: "suppliers",
        field: "billing_currency",
        blockerId: "suppliers.billing_currency",
        fieldLabel: "Supplier billing currency",
        message:
          "FX exposure needs each supplier's billing currency (or a country code we can infer it from).",
        fixUrl: fix(ctx.basePath, "/suppliers", "billing_currency"),
      });
      if (noCcy) blockers.push(noCcy);
      return { blockers };
    },
  },
  {
    leverId: "material_index_arbitrage",
    label: "Material-Index Arbitrage",
    rule: async (ctx) => {
      const blockers: ReadinessBlocker[] = [];
      const noIdx = await fieldCheck({
        orgId: ctx.orgId,
        table: "contracts",
        field: "reference_index",
        blockerId: "contracts.reference_index",
        fieldLabel: "Contract reference index",
        message:
          "Index-arbitrage compares your contract escalator vs. the public index — set a reference index per contract.",
        fixUrl: fix(ctx.basePath, "/contracts", "reference_index"),
      });
      if (noIdx) blockers.push(noIdx);
      return { blockers };
    },
  },
];

export function getReadinessRules(): ReadonlyArray<LeverRuleSpec> {
  return RULES;
}

export function scoreFromBlockers(blockers: ReadinessBlocker[]): number {
  if (blockers.some((b) => b.hard)) return 0;
  if (blockers.length === 0) return 100;
  const total = blockers.reduce((acc, b) => acc + b.missingPct, 0);
  return Math.max(0, Math.min(100, Math.round(100 - total / blockers.length)));
}

export function leverTier(leverId: LeverId): 1 | 2 | 3 | 4 | 5 {
  return tierLabels[leverId];
}

export function buildLeverReadiness(
  spec: LeverRuleSpec,
  blockers: ReadinessBlocker[],
): LeverReadiness {
  return {
    leverId: spec.leverId,
    label: spec.label,
    tier: leverTier(spec.leverId),
    score: scoreFromBlockers(blockers),
    blockers,
  };
}
