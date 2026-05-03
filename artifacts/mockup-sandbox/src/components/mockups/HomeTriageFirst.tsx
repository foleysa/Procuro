import {
  AlertTriangle,
  CheckSquare,
  Activity,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Sparkles,
  Sun,
  Workflow,
  ChevronRight,
} from "lucide-react";
import {
  KPIS,
  TRIAGE,
  FUNNEL,
  DELTAS,
  LEVERS,
  fmtUsd,
  fmtPct,
  pctDelta,
} from "./_shared/seed";

const sev = {
  critical: "border-red-300 bg-red-50 text-red-900",
  high: "border-amber-300 bg-amber-50 text-amber-900",
  medium: "border-blue-200 bg-blue-50 text-blue-900",
};
const sevDot = {
  critical: "bg-red-500",
  high: "bg-amber-500",
  medium: "bg-blue-500",
};
const iconForKind = {
  alert: AlertTriangle,
  approval: CheckSquare,
  ops: Activity,
};

export default function HomeTriageFirst() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans antialiased flex">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        <Header />
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[1400px] mx-auto px-10 py-8 space-y-8">
            {/* Hero greeting */}
            <div className="flex items-end justify-between gap-6 flex-wrap">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500 font-semibold">
                  Direction A · Triage-first
                </p>
                <h1 className="text-[34px] leading-tight font-bold tracking-tight mt-2">
                  Good morning, Priya.
                </h1>
                <p className="text-base text-slate-600 mt-1">
                  3 things need you today. Clear them and the engine keeps
                  flowing.
                </p>
              </div>
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <RefreshCw className="w-4 h-4" />
                Live · refreshed 8s ago
              </div>
            </div>

            {/* Triage stack — the visual primary */}
            <section className="space-y-3">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
                  Action queue · {TRIAGE.length}
                </h2>
                <a className="text-xs text-slate-500 hover:text-slate-900 inline-flex items-center gap-1">
                  See everything <ArrowRight className="w-3 h-3" />
                </a>
              </div>
              <div className="space-y-2.5">
                {TRIAGE.map((t, i) => {
                  const Icon = iconForKind[t.kind as keyof typeof iconForKind];
                  return (
                    <div
                      key={t.id}
                      className={`group rounded-xl border-l-4 ${
                        t.severity === "critical"
                          ? "border-l-red-500"
                          : t.severity === "high"
                            ? "border-l-amber-500"
                            : "border-l-blue-500"
                      } bg-white border border-slate-200 hover:shadow-md hover:-translate-y-px transition-all p-4 flex items-center gap-4`}
                    >
                      <div className="text-xs font-mono text-slate-400 w-6 text-right tabular-nums">
                        {String(i + 1).padStart(2, "0")}
                      </div>
                      <div
                        className={`w-9 h-9 rounded-lg ${sev[t.severity]} border flex items-center justify-center shrink-0`}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${sev[t.severity]} border`}
                          >
                            {t.severity}
                          </span>
                          <span className="text-[11px] text-slate-500">
                            {t.kind} · {t.age}
                          </span>
                        </div>
                        <p className="text-sm font-semibold text-slate-900 mt-1 leading-snug">
                          {t.title}
                        </p>
                        <p className="text-xs text-slate-600 mt-0.5 truncate">
                          {t.detail}
                        </p>
                      </div>
                      <button className="text-sm font-medium text-blue-700 hover:text-blue-900 inline-flex items-center gap-1 shrink-0 px-3 py-1.5 rounded-lg group-hover:bg-blue-50 transition-colors">
                        {t.cta} <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* KPI band — outcomes (hero row) + leading indicators (supporting row) */}
            <section className="space-y-3">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
                  Scoreboard · QTD
                </h2>
                <span className="text-[11px] text-slate-400">
                  Outcomes · then leading indicators · then engine trust
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <KpiSlim {...KPIS.realized} format="usd" tier="hero" />
                <KpiSlim {...KPIS.pipeline} format="usd" tier="hero" />
                <KpiSlim {...KPIS.roi} format="num" tier="hero" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <KpiSlim {...KPIS.capture} format="pct" tier="lead" />
                <KpiSlim {...KPIS.cycleP50} format="num" tier="lead" />
                <KpiSlim {...KPIS.coverage} format="pct" tier="lead" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <KpiSlim {...KPIS.precision} format="pct" tier="trust" />
                <KpiSlim {...KPIS.freshness} format="pct" tier="trust" />
              </div>
            </section>

            {/* Lower band — funnel + deltas */}
            <section className="grid lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-5">
                <div className="flex items-baseline justify-between mb-4">
                  <div>
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-blue-600" /> Pipeline
                      funnel
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Snapshot of every open opportunity · click a stage to
                      drill in
                    </p>
                  </div>
                  <span className="text-xs text-slate-400">128 open</span>
                </div>
                <div className="space-y-2.5">
                  {FUNNEL.map((s) => (
                    <Bar key={s.stage} {...s} />
                  ))}
                </div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-emerald-600" /> Cycle
                  deltas
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Cycle #141 → #142
                </p>
                <ul className="mt-4 space-y-3">
                  {DELTAS.map((d) => (
                    <li
                      key={d.transition}
                      className="flex items-center justify-between"
                    >
                      <span className="text-sm text-slate-700">
                        {d.transition}
                      </span>
                      <span
                        className={`text-xs font-semibold tabular-nums inline-flex items-center gap-1 ${
                          d.dir === "up" ? "text-emerald-700" : "text-red-700"
                        }`}
                      >
                        {d.dir === "up" ? (
                          <TrendingUp className="w-3 h-3" />
                        ) : (
                          <TrendingDown className="w-3 h-3" />
                        )}
                        {fmtPct(d.prev)} → {fmtPct(d.curr)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            {/* Lever performance */}
            <section className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-sm font-semibold">Plays landing this quarter</h3>
                <span className="text-xs text-slate-500">
                  Realized ÷ projected per lever
                </span>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                {LEVERS.map((l) => {
                  const rate = l.realized / l.projected;
                  return (
                    <div
                      key={l.id}
                      className="rounded-lg border border-slate-200 p-3"
                    >
                      <p className="text-xs text-slate-500 truncate">
                        {l.label}
                      </p>
                      <p className="text-base font-bold tabular-nums mt-1">
                        {fmtPct(rate)}
                      </p>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        {fmtUsd(l.realized)} · {l.opps} opps
                      </p>
                      <div className="mt-2 h-1 bg-slate-100 rounded">
                        <div
                          className={`h-full rounded ${rate >= 0.7 ? "bg-emerald-500" : rate >= 0.4 ? "bg-amber-500" : "bg-slate-400"}`}
                          style={{ width: `${rate * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

function KpiSlim(props: {
  label: string;
  value: number;
  target: number;
  prior: number;
  periodLabel?: string;
  format: "usd" | "pct" | "num";
  suffix?: string;
  lowerIsBetter?: boolean;
  tier?: "hero" | "lead" | "trust";
}) {
  const fmt =
    props.format === "usd"
      ? (n: number) => fmtUsd(n)
      : props.format === "pct"
        ? (n: number) => fmtPct(n)
        : (n: number) => `${n}${props.suffix ?? ""}`;
  const lower = props.lowerIsBetter ?? false;
  const rawDelta = pctDelta(props.value, props.prior);
  const goodDirection = lower ? rawDelta < 0 : rawDelta > 0;
  const pctOfTarget = lower ? props.target / props.value : props.value / props.target;
  const tier = props.tier ?? "hero";
  const sizing = {
    hero: { pad: "p-4", num: "text-2xl", label: "text-xs" },
    lead: { pad: "p-3", num: "text-xl", label: "text-[11px]" },
    trust: { pad: "p-3", num: "text-lg", label: "text-[11px]" },
  }[tier];
  const toneClass =
    pctOfTarget >= 1
      ? "bg-emerald-500"
      : pctOfTarget >= 0.7
        ? "bg-blue-500"
        : "bg-amber-500";
  return (
    <div className={`bg-white rounded-xl border border-slate-200 ${sizing.pad}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`${sizing.label} text-slate-500 truncate`}>
          {props.label}
        </span>
        <span
          className={`text-[11px] tabular-nums inline-flex items-center gap-0.5 shrink-0 ${
            goodDirection ? "text-emerald-700" : "text-red-700"
          }`}
        >
          {rawDelta >= 0 ? (
            <TrendingUp className="w-3 h-3" />
          ) : (
            <TrendingDown className="w-3 h-3" />
          )}
          {Math.abs(rawDelta * 100).toFixed(1)}%
        </span>
      </div>
      <div className={`${sizing.num} font-bold tabular-nums mt-1`}>
        {fmt(props.value)}
      </div>
      <div className="text-[11px] text-slate-500 mt-0.5 truncate">
        target {fmt(props.target)} · {Math.round(pctOfTarget * 100)}%{" "}
        {props.periodLabel ? `· ${props.periodLabel}` : ""}
      </div>
      <div className="mt-2 h-1 rounded bg-slate-100 overflow-hidden">
        <div
          className={`h-full ${toneClass}`}
          style={{ width: `${Math.min(100, pctOfTarget * 100)}%` }}
        />
      </div>
    </div>
  );
}

function Bar({
  stage,
  count,
  value,
  tone,
}: {
  stage: string;
  count: number;
  value: number;
  tone: "muted" | "blue" | "amber" | "green" | "red";
}) {
  const max = 8_000_000;
  const colors = {
    muted: "bg-slate-300",
    blue: "bg-blue-500",
    amber: "bg-amber-500",
    green: "bg-emerald-500",
    red: "bg-red-400",
  };
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm mb-1">
        <span className="font-medium text-slate-800">{stage}</span>
        <span className="tabular-nums text-slate-600">
          {fmtUsd(value)}{" "}
          <span className="text-xs text-slate-400">· {count}</span>
        </span>
      </div>
      <div className="h-2 bg-slate-100 rounded">
        <div
          className={`h-full rounded ${colors[tone]}`}
          style={{ width: `${(value / max) * 100}%` }}
        />
      </div>
    </div>
  );
}

function Sidebar() {
  const groups = [
    { label: "Home", items: ["Home"] },
    { label: "Workspace", items: ["Spend", "Suppliers", "Contracts", "Approvals"] },
    { label: "Intelligence", items: ["Intelligence", "Opportunities", "Alerts"] },
    { label: "Engine", items: ["Engine", "Operations", "Playbook"] },
  ];
  return (
    <aside className="w-56 bg-slate-900 text-slate-300 flex-shrink-0 flex flex-col">
      <div className="px-5 py-4 flex items-center gap-2 text-white">
        <Workflow className="w-4 h-4 text-blue-400" />
        <span className="text-sm font-bold">Atlas Procure</span>
      </div>
      <nav className="px-3 py-2 space-y-4 text-sm">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
              {g.label}
            </div>
            {g.items.map((it, i) => (
              <div
                key={it}
                className={`px-3 py-1.5 rounded-md text-[13px] ${
                  i === 0 && g.label === "Home"
                    ? "bg-blue-600 text-white"
                    : "text-slate-300/80"
                }`}
              >
                {it}
              </div>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function Header() {
  return (
    <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-8 flex-shrink-0">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Sun className="w-4 h-4" />
        Today, Tuesday May 5
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-500">
        <span>priya@northwind.com</span>
        <div className="w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-semibold flex items-center justify-center">
          P
        </div>
      </div>
    </header>
  );
}
