export function formatUsd(n: number, opts?: { compact?: boolean }): string {
  if (!Number.isFinite(n)) return "$0";
  if (opts?.compact && Math.abs(n) >= 1_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export function formatPercent(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export const LEVER_DESCRIPTIONS: Record<string, string> = {
  sku_price_benchmark: "SKU Price Benchmark",
  maverick_spend: "Maverick Spend",
  contract_leakage: "Contract Leakage",
  duplicate_payment: "Duplicate Payment",
  missed_volume_threshold: "Missed Volume Threshold",
  payment_term_extension: "Payment Term Extension",
  tail_spend_rationalization: "Tail Spend Rationalization",
  supplier_consolidation: "Supplier Consolidation",
  contract_renegotiation_trigger: "Contract Renegotiation Trigger",
  spot_vs_contract: "Spot vs Contract",
  catalog_standardization: "Catalog Standardization",
  indirect_category_strategy: "Indirect Category Strategy",
  freight_mode_optimization: "Freight Mode Optimization",
  lane_consolidation: "Lane Consolidation",
  incoterms_optimization: "Incoterms Optimization",
  should_cost_modeling: "Should-Cost Modeling",
  index_based_pricing: "Index-Based Pricing",
  demand_aggregation: "Demand Aggregation",
  raw_material_hedging: "Raw Material Hedging",
  supplier_fx_exposure: "Supplier FX Exposure",
  dual_sourcing: "Dual Sourcing",
  services_rate_card_benchmark: "Services Rate-Card Benchmark",
  sow_to_msa_conversion: "SOW → MSA Conversion",
  outcome_based_contract: "Outcome-Based Contract",
  unbundling_rebundling: "Unbundling / Rebundling",
  multi_year_tco: "Multi-Year TCO",
};

export function leverLabel(id: string): string {
  return LEVER_DESCRIPTIONS[id] ?? id;
}

export const REJECTION_REASON_LABELS: Record<string, string> = {
  supplier_strategic_do_not_consolidate: "Supplier is strategic — do not consolidate",
  supplier_dei_or_diverse_program: "Supplier DEI / diversity program",
  data_quality_issue: "Data quality issue",
  already_negotiated: "Already negotiated",
  compliance_or_legal_block: "Compliance / legal block",
  specification_required: "Specification required",
  lead_time_critical: "Lead time critical",
  cash_flow_constraint: "Cash flow constraint",
  category_owner_disagrees: "Category owner disagrees",
  other: "Other",
};
