export const KPIS = {
  // Hero — outcome
  realized: { value: 4_280_000, target: 5_000_000, prior: 3_460_000, label: "Realized savings", periodLabel: "QTD" },
  pipeline: { value: 18_750_000, target: 16_000_000, prior: 17_100_000, label: "Pipeline value", periodLabel: "Open" },
  roi: { value: 7.4, target: 5.0, prior: 6.1, label: "ROI multiple", periodLabel: "QTD", suffix: "×" },
  // Supporting — leading + quality
  capture: { value: 0.42, target: 0.5, prior: 0.36, label: "Capture rate", periodLabel: "QTD" },
  cycleP50: { value: 14, target: 10, prior: 17, label: "Cycle time p50", periodLabel: "days", suffix: "d", lowerIsBetter: true },
  coverage: { value: 0.78, target: 0.9, prior: 0.71, label: "Spend coverage", periodLabel: "of $312M" },
  // Engine trust
  precision: { value: 0.81, target: 0.75, prior: 0.79, label: "Recommendation precision", periodLabel: "approved → realized" },
  freshness: { value: 0.94, target: 0.98, prior: 0.96, label: "Signal freshness", periodLabel: "≤24h fresh" },
};

export const TRIAGE = [
  {
    id: "alert-fx",
    kind: "alert",
    severity: "critical" as const,
    title: "EUR/USD moved 3.2% — 4 contracts breach FX collar",
    detail: "Acme Logistics, Northwind, Globex, Initech · combined exposure $1.4M",
    age: "12m",
    cta: "Review hedge",
    href: "/alerts?filter=state:open",
  },
  {
    id: "appr-1",
    kind: "approval",
    severity: "high" as const,
    title: "12 high-confidence opportunities awaiting your sign-off",
    detail: "$840k projected · oldest waiting 9 days · ≥70% confidence",
    age: "9d",
    cta: "Open approvals",
    href: "/approvals",
  },
  {
    id: "ops-1",
    kind: "ops",
    severity: "high" as const,
    title: "SAP Ariba collector failed 3× in last 24h",
    detail: "Last success 31h ago — supplier master is going stale",
    age: "31h",
    cta: "Inspect",
    href: "/operations",
  },
  {
    id: "alert-supplier",
    kind: "alert",
    severity: "medium" as const,
    title: "Supplier Cargill flagged: news risk score jumped to 71",
    detail: "Spend exposure $3.2M · 2 active SOWs",
    age: "2h",
    cta: "Open file",
    href: "/suppliers/cargill",
  },
  {
    id: "appr-2",
    kind: "approval",
    severity: "medium" as const,
    title: "3 contract renewals enter the 30-day window today",
    detail: "Datadog ($420k) · Snowflake ($1.1M) · Confluent ($95k)",
    age: "today",
    cta: "Review",
    href: "/contracts?filter=renewal:30d",
  },
];

export const FUNNEL = [
  { stage: "Proposed", count: 47, value: 2_400_000, tone: "muted" as const },
  { stage: "Approved", count: 23, value: 6_100_000, tone: "blue" as const },
  { stage: "Executing", count: 11, value: 7_900_000, tone: "amber" as const },
  { stage: "Realized", count: 38, value: 4_280_000, tone: "green" as const },
  { stage: "Rejected", count: 9, value: 1_200_000, tone: "red" as const },
];

export const DELTAS = [
  { transition: "Proposed → Approved", prev: 0.41, curr: 0.52, dir: "up" as const },
  { transition: "Approved → Executing", prev: 0.68, curr: 0.61, dir: "down" as const },
  { transition: "Executing → Realized", prev: 0.74, curr: 0.79, dir: "up" as const },
];

export const ANNOTATIONS = [
  { kind: "spike", text: "Approved opps jumped 3.4× — new SAP feed unlocked 17 fresh leads", cycle: 142 },
  { kind: "drop", text: "Executing → Realized rate slipped 7pp — finance attribution is 4 days behind", cycle: 142 },
  { kind: "flag", text: "Volume rebate on Office Depot triggered — extra $84k expected next cycle", cycle: 141 },
];

export const LEVERS = [
  { id: "rate_card", label: "Rate-card renegotiation", opps: 18, realized: 1_640_000, projected: 2_100_000 },
  { id: "consolidation", label: "Supplier consolidation", opps: 9, realized: 980_000, projected: 1_200_000 },
  { id: "fx_hedge", label: "FX hedging", opps: 6, realized: 720_000, projected: 950_000 },
  { id: "tail_spend", label: "Tail-spend cleanup", opps: 24, realized: 410_000, projected: 1_400_000 },
  { id: "renewal_timing", label: "Renewal timing", opps: 7, realized: 530_000, projected: 600_000 },
];

export const SYSTEM = {
  lastCycle: { gen: 142, agedHrs: 4, status: "ok" as const },
  jobs: { pending: 2, running: 1, succeeded24h: 47, failed24h: 3 },
  collectors: { enabled: 14, total: 16, stale: 1 },
  signals24h: 312,
  ingest: { rowsToday: 18420, source: "SAP Ariba" },
};

export function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}
export function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}
export function pctDelta(curr: number, prior: number): number {
  if (prior === 0) return 0;
  return (curr - prior) / prior;
}
