import {
  ArrowUpRight,
  ArrowDownRight,
  ArrowRight,
  AlertTriangle,
  CheckSquare,
  Activity,
  Workflow,
  Sparkles,
} from "lucide-react";
import {
  KPIS,
  TRIAGE,
  FUNNEL,
  DELTAS,
  ANNOTATIONS,
  fmtUsd,
  fmtPct,
  pctDelta,
} from "./_shared/seed";

/**
 * Direction C — Calm executive brief.
 * Generous whitespace, one hero KPI, the rest as quiet supporting numbers.
 * Triage as a tidy list. Built for the 30-second exec scan.
 */
export default function HomeCalmExec() {
  const realizedDelta = pctDelta(KPIS.realized.value, KPIS.realized.prior);
  return (
    <div className="min-h-screen bg-[#fafaf7] text-stone-900 font-sans antialiased flex">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        <Header />
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[1080px] mx-auto px-12 py-14 space-y-16">
            <div>
              <p className="text-[11px] uppercase tracking-[0.24em] text-stone-500 font-semibold">
                Direction C · The brief · Tuesday, May 5
              </p>
              <h1 className="font-serif text-[44px] leading-[1.05] tracking-tight mt-4 text-stone-900">
                Realized savings are tracking ahead of plan, with three open
                decisions on your desk today.
              </h1>
            </div>

            {/* Hero KPI */}
            <section className="grid grid-cols-12 gap-10 items-start border-y border-stone-200 py-10">
              <div className="col-span-7">
                <p className="text-xs uppercase tracking-[0.2em] text-stone-500 font-semibold">
                  Realized savings · quarter to date
                </p>
                <p className="font-serif text-[88px] leading-none tabular-nums tracking-tight mt-4 text-stone-900">
                  {fmtUsd(KPIS.realized.value)}
                </p>
                <div className="flex items-center gap-3 mt-5">
                  <span
                    className={`inline-flex items-center gap-1 text-sm font-medium ${
                      realizedDelta >= 0 ? "text-emerald-700" : "text-red-700"
                    }`}
                  >
                    {realizedDelta >= 0 ? (
                      <ArrowUpRight className="w-4 h-4" />
                    ) : (
                      <ArrowDownRight className="w-4 h-4" />
                    )}
                    {(realizedDelta * 100).toFixed(1)}% vs prior quarter
                  </span>
                  <span className="text-sm text-stone-500">·</span>
                  <span className="text-sm text-stone-600">
                    {((KPIS.realized.value / KPIS.realized.target) * 100).toFixed(0)}%
                    of {fmtUsd(KPIS.realized.target)} target
                  </span>
                </div>
                <div className="mt-5 h-[6px] bg-stone-200 rounded-full max-w-[420px]">
                  <div
                    className="h-full bg-emerald-600 rounded-full"
                    style={{
                      width: `${Math.min(100, (KPIS.realized.value / KPIS.realized.target) * 100)}%`,
                    }}
                  />
                </div>
              </div>
              <div className="col-span-5 grid grid-cols-2 gap-x-8 gap-y-6">
                <QuietKpi {...KPIS.pipeline} label="Pipeline value" format="usd" />
                <QuietKpi {...KPIS.roi} label="ROI multiple" format="num" />
                <QuietKpi {...KPIS.capture} label="Capture rate" format="pct" />
                <QuietKpi {...KPIS.cycleP50} label="Cycle p50" format="num" />
                <QuietKpi {...KPIS.coverage} label="Spend coverage" format="pct" />
                <QuietKpi {...KPIS.precision} label="Precision" format="pct" />
              </div>
            </section>

            {/* Today's decisions */}
            <section>
              <div className="flex items-baseline justify-between mb-6">
                <h2 className="font-serif text-[28px] tracking-tight">
                  On your desk today
                </h2>
                <a className="text-sm text-stone-500 hover:text-stone-900 inline-flex items-center gap-1">
                  See all queues <ArrowRight className="w-3 h-3" />
                </a>
              </div>
              <ul className="divide-y divide-stone-200 border-y border-stone-200">
                {TRIAGE.slice(0, 3).map((t) => {
                  const Icon =
                    t.kind === "alert"
                      ? AlertTriangle
                      : t.kind === "approval"
                        ? CheckSquare
                        : Activity;
                  return (
                    <li
                      key={t.id}
                      className="grid grid-cols-12 gap-6 py-6 items-center hover:bg-white transition-colors px-2 -mx-2 rounded"
                    >
                      <div className="col-span-1 grid place-items-center">
                        <Icon
                          className={`w-5 h-5 ${
                            t.severity === "critical"
                              ? "text-red-700"
                              : t.severity === "high"
                                ? "text-amber-700"
                                : "text-stone-500"
                          }`}
                        />
                      </div>
                      <div className="col-span-9">
                        <p className="text-[17px] leading-snug text-stone-900 font-medium">
                          {t.title}
                        </p>
                        <p className="text-sm text-stone-500 mt-1">
                          {t.detail}
                        </p>
                      </div>
                      <div className="col-span-2 text-right">
                        <button className="text-sm font-medium text-stone-900 hover:text-emerald-700 inline-flex items-center gap-1">
                          {t.cta} <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                        <p className="text-[11px] text-stone-400 mt-1">
                          {t.age}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {TRIAGE.length > 3 && (
                <p className="text-xs text-stone-500 mt-4 text-center">
                  + {TRIAGE.length - 3} lower-priority items in your queues
                </p>
              )}
            </section>

            {/* What changed */}
            <section className="grid grid-cols-12 gap-10">
              <div className="col-span-7">
                <h2 className="font-serif text-[24px] tracking-tight mb-4">
                  What the engine learned overnight
                </h2>
                <ul className="space-y-4">
                  {ANNOTATIONS.map((a, i) => (
                    <li key={i} className="flex gap-3">
                      <Sparkles
                        className={`w-4 h-4 mt-1 shrink-0 ${
                          a.kind === "spike"
                            ? "text-emerald-700"
                            : a.kind === "drop"
                              ? "text-amber-700"
                              : "text-stone-500"
                        }`}
                      />
                      <div>
                        <p className="text-[15px] leading-snug text-stone-800">
                          {a.text}
                        </p>
                        <p className="text-[11px] text-stone-400 mt-1">
                          cycle #{a.cycle}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="col-span-5">
                <h2 className="font-serif text-[24px] tracking-tight mb-4">
                  Funnel snapshot
                </h2>
                <ul className="space-y-3.5">
                  {FUNNEL.map((s) => (
                    <li
                      key={s.stage}
                      className="flex items-baseline justify-between text-[15px]"
                    >
                      <span className="text-stone-700">{s.stage}</span>
                      <span className="tabular-nums text-stone-900 font-medium">
                        {fmtUsd(s.value)}
                        <span className="text-xs text-stone-400 ml-2">
                          {s.count}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 pt-5 border-t border-stone-200">
                  <p className="text-xs uppercase tracking-wider text-stone-500 mb-3 font-semibold">
                    Cycle-over-cycle
                  </p>
                  <ul className="space-y-2 text-sm">
                    {DELTAS.map((d) => (
                      <li
                        key={d.transition}
                        className="flex justify-between items-center"
                      >
                        <span className="text-stone-600">{d.transition}</span>
                        <span
                          className={`tabular-nums text-xs ${
                            d.dir === "up" ? "text-emerald-700" : "text-red-700"
                          }`}
                        >
                          {d.dir === "up" ? "↑" : "↓"} {fmtPct(d.curr)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>

            <footer className="text-center pt-10 border-t border-stone-200">
              <p className="text-xs text-stone-400 italic">
                Atlas Procure · auto-refreshed at 05:14 PT · prepared for the
                Northwind procurement office
              </p>
            </footer>
          </div>
        </div>
      </main>
    </div>
  );
}

function QuietKpi({
  label,
  value,
  target,
  prior,
  format,
  suffix,
  lowerIsBetter,
}: {
  label: string;
  value: number;
  target: number;
  prior: number;
  format: "usd" | "pct" | "num";
  suffix?: string;
  lowerIsBetter?: boolean;
}) {
  const fmt =
    format === "usd"
      ? (n: number) => fmtUsd(n)
      : format === "pct"
        ? (n: number) => fmtPct(n)
        : (n: number) => `${n}${suffix ?? ""}`;
  const lower = lowerIsBetter ?? false;
  const delta = pctDelta(value, prior);
  const goodDir = lower ? delta < 0 : delta > 0;
  const pctOfTarget = lower ? target / value : value / target;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.18em] text-stone-500 font-semibold">
        {label}
      </p>
      <p className="font-serif text-[28px] tabular-nums mt-1.5 text-stone-900">
        {fmt(value)}
      </p>
      <p className="text-xs text-stone-600 mt-0.5">
        tgt {fmt(target)} ·{" "}
        <span className={goodDir ? "text-emerald-700" : "text-red-700"}>
          {delta >= 0 ? "+" : ""}
          {(delta * 100).toFixed(1)}%
        </span>
      </p>
      <div className="mt-1.5 h-[2px] bg-stone-200 rounded-full">
        <div
          className="h-full bg-stone-700 rounded-full"
          style={{ width: `${Math.min(100, pctOfTarget * 100)}%` }}
        />
      </div>
    </div>
  );
}

function Sidebar() {
  const groups = [
    { label: "Home", items: ["Home"] },
    {
      label: "Workspace",
      items: ["Spend", "Suppliers", "Contracts", "Approvals"],
    },
    { label: "Intelligence", items: ["Intelligence", "Opportunities", "Alerts"] },
    { label: "Engine", items: ["Engine", "Operations"] },
  ];
  return (
    <aside className="w-60 bg-stone-100 border-r border-stone-200 flex-shrink-0 flex flex-col">
      <div className="px-6 py-5 flex items-center gap-2 text-stone-900 border-b border-stone-200">
        <Workflow className="w-4 h-4 text-emerald-700" />
        <span className="text-sm font-bold tracking-tight">Atlas Procure</span>
      </div>
      <nav className="px-4 py-4 space-y-5 text-sm">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500 mb-1.5">
              {g.label}
            </div>
            {g.items.map((it, i) => (
              <div
                key={it}
                className={`px-3 py-1.5 rounded-md text-[13px] ${
                  i === 0 && g.label === "Home"
                    ? "bg-stone-900 text-white"
                    : "text-stone-700"
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
    <header className="h-14 bg-[#fafaf7] border-b border-stone-200 flex items-center justify-end px-10 flex-shrink-0">
      <div className="flex items-center gap-3 text-xs text-stone-500">
        <span>priya@northwind.com</span>
        <div className="w-7 h-7 rounded-full bg-stone-900 text-white text-xs font-semibold flex items-center justify-center">
          P
        </div>
      </div>
    </header>
  );
}
