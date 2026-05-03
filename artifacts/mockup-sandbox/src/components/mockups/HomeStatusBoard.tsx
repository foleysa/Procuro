import {
  AlertTriangle,
  CheckSquare,
  Activity,
  TrendingUp,
  TrendingDown,
  Server,
  Radio,
  Zap,
  Workflow,
  CircleDot,
} from "lucide-react";
import {
  KPIS,
  TRIAGE,
  FUNNEL,
  DELTAS,
  SYSTEM,
  LEVERS,
  fmtUsd,
  fmtPct,
  pctDelta,
} from "./_shared/seed";

/**
 * Direction B — Status board / always-on monitor.
 * Dense, dark, monitor-friendly. Every tile is state-coloured. Designed
 * for a second screen the operator can glance at across the room.
 */
export default function HomeStatusBoard() {
  return (
    <div className="min-h-screen bg-[#0b1220] text-slate-100 font-sans antialiased flex">
      <Rail />
      <main className="flex-1 min-w-0 flex flex-col">
        <TopBar />
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Headline strip — what's on fire */}
          <div className="grid grid-cols-12 gap-3">
            <StatusTile
              span={3}
              label="System"
              value="OPERATIONAL"
              tone="ok"
              sub={`Cycle #${SYSTEM.lastCycle.gen} · ${SYSTEM.lastCycle.agedHrs}h ago`}
              icon={Server}
            />
            <StatusTile
              span={3}
              label="Critical alerts"
              value="1"
              tone="critical"
              sub="EUR/USD breach · 12m old"
              icon={AlertTriangle}
            />
            <StatusTile
              span={3}
              label="Approvals queue"
              value="12"
              tone="warn"
              sub="$840k projected · oldest 9d"
              icon={CheckSquare}
            />
            <StatusTile
              span={3}
              label="Failed jobs · 24h"
              value="3"
              tone="warn"
              sub="SAP Ariba collector"
              icon={Activity}
            />
          </div>

          {/* Hero KPI bank — outcomes */}
          <div className="grid grid-cols-3 gap-3">
            <BigKpi {...KPIS.realized} format="usd" />
            <BigKpi {...KPIS.pipeline} format="usd" />
            <BigKpi {...KPIS.roi} format="num" />
          </div>

          {/* Supporting KPI strip — leading indicators + engine trust */}
          <div className="grid grid-cols-5 gap-3">
            <SmallKpi {...KPIS.capture} format="pct" />
            <SmallKpi {...KPIS.cycleP50} format="num" />
            <SmallKpi {...KPIS.coverage} format="pct" />
            <SmallKpi {...KPIS.precision} format="pct" />
            <SmallKpi {...KPIS.freshness} format="pct" />
          </div>

          {/* Live action queue + funnel */}
          <div className="grid grid-cols-12 gap-3">
            <Panel className="col-span-7" title="LIVE QUEUE" accent="amber">
              <div className="space-y-2">
                {TRIAGE.map((t) => (
                  <div
                    key={t.id}
                    className="grid grid-cols-[auto_60px_1fr_auto] items-center gap-3 py-1.5 border-b border-slate-800/70 last:border-0"
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${
                        t.severity === "critical"
                          ? "bg-red-500"
                          : t.severity === "high"
                            ? "bg-amber-400"
                            : "bg-blue-400"
                      } shadow-[0_0_8px_currentColor]`}
                    />
                    <span className="font-mono text-[10px] text-slate-500 uppercase tracking-wider">
                      {t.severity}
                    </span>
                    <span className="text-sm text-slate-200 truncate">
                      {t.title}
                    </span>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {t.age}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel className="col-span-5" title="PIPELINE" accent="blue">
              <div className="space-y-2.5">
                {FUNNEL.map((s) => (
                  <BarRow key={s.stage} {...s} />
                ))}
              </div>
            </Panel>
          </div>

          {/* Telemetry row */}
          <div className="grid grid-cols-12 gap-3">
            <Panel className="col-span-5" title="DATA PULSE" accent="emerald">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Telemetry
                  label="Collectors"
                  value={`${SYSTEM.collectors.enabled} / ${SYSTEM.collectors.total}`}
                  sub={`${SYSTEM.collectors.stale} stale`}
                  tone={SYSTEM.collectors.stale > 0 ? "warn" : "ok"}
                />
                <Telemetry
                  label="Signals 24h"
                  value={SYSTEM.signals24h.toLocaleString()}
                  sub="vs 281 prior"
                  tone="ok"
                />
                <Telemetry
                  label="Jobs running"
                  value={`${SYSTEM.jobs.running}`}
                  sub={`${SYSTEM.jobs.pending} queued`}
                  tone="ok"
                />
                <Telemetry
                  label="Ingest today"
                  value={`${(SYSTEM.ingest.rowsToday / 1000).toFixed(1)}k`}
                  sub={SYSTEM.ingest.source}
                  tone="ok"
                />
              </div>
            </Panel>
            <Panel className="col-span-4" title="CYCLE DELTA" accent="blue">
              <ul className="space-y-2.5 text-sm">
                {DELTAS.map((d) => (
                  <li
                    key={d.transition}
                    className="flex items-center justify-between"
                  >
                    <span className="text-slate-300">{d.transition}</span>
                    <span
                      className={`tabular-nums font-mono text-xs inline-flex items-center gap-1 ${
                        d.dir === "up" ? "text-emerald-400" : "text-red-400"
                      }`}
                    >
                      {d.dir === "up" ? (
                        <TrendingUp className="w-3 h-3" />
                      ) : (
                        <TrendingDown className="w-3 h-3" />
                      )}
                      {fmtPct(d.prev)}→{fmtPct(d.curr)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel className="col-span-3" title="TOP LEVER" accent="emerald">
              {(() => {
                const top = [...LEVERS].sort(
                  (a, b) => b.realized - a.realized,
                )[0];
                return (
                  <div>
                    <p className="text-[11px] text-slate-400 uppercase tracking-wider">
                      {top.label}
                    </p>
                    <p className="text-2xl font-bold tabular-nums mt-1 text-emerald-300">
                      {fmtUsd(top.realized)}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      {fmtPct(top.realized / top.projected)} of {fmtUsd(top.projected)}{" "}
                      projected
                    </p>
                    <div className="mt-3 h-1.5 bg-slate-800 rounded">
                      <div
                        className="h-full bg-emerald-500 rounded"
                        style={{
                          width: `${(top.realized / top.projected) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                );
              })()}
            </Panel>
          </div>
        </div>
      </main>
    </div>
  );
}

function StatusTile({
  span,
  label,
  value,
  sub,
  tone,
  icon: Icon,
}: {
  span: number;
  label: string;
  value: string;
  sub: string;
  tone: "ok" | "warn" | "critical";
  icon: React.ComponentType<{ className?: string }>;
}) {
  const styles = {
    ok: "bg-emerald-500/5 border-emerald-500/30 text-emerald-300",
    warn: "bg-amber-500/5 border-amber-500/30 text-amber-300",
    critical: "bg-red-500/10 border-red-500/40 text-red-300",
  };
  const dot = {
    ok: "bg-emerald-400",
    warn: "bg-amber-400",
    critical: "bg-red-500",
  };
  return (
    <div
      className={`col-span-${span} rounded-lg border ${styles[tone]} p-4`}
      style={{ gridColumn: `span ${span} / span ${span}` }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${dot[tone]} shadow-[0_0_6px_currentColor]`}
          />
          <span className="text-[10px] uppercase tracking-[0.2em] text-slate-400 font-semibold">
            {label}
          </span>
        </div>
        <Icon className="w-3.5 h-3.5 opacity-60" />
      </div>
      <p className={`text-2xl font-bold tabular-nums mt-2 ${styles[tone].split(" ").pop()}`}>
        {value}
      </p>
      <p className="text-[11px] text-slate-400 mt-1 truncate">{sub}</p>
    </div>
  );
}

function BigKpi(props: {
  label: string;
  value: number;
  target: number;
  prior: number;
  format: "usd" | "pct" | "num";
  suffix?: string;
  lowerIsBetter?: boolean;
}) {
  const fmt =
    props.format === "usd"
      ? (n: number) => fmtUsd(n)
      : props.format === "pct"
        ? (n: number) => fmtPct(n)
        : (n: number) => `${n}${props.suffix ?? ""}`;
  const lower = props.lowerIsBetter ?? false;
  const delta = pctDelta(props.value, props.prior);
  const goodDir = lower ? delta < 0 : delta > 0;
  const pctOfTarget = lower ? props.target / props.value : props.value / props.target;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold">
          {props.label}
        </span>
        <span
          className={`text-xs tabular-nums font-mono ${goodDir ? "text-emerald-400" : "text-red-400"}`}
        >
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta * 100).toFixed(1)}%
        </span>
      </div>
      <p className="text-4xl font-bold tabular-nums mt-2 text-white">
        {fmt(props.value)}
      </p>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-400">
        <span>tgt {fmt(props.target)}</span>
        <div className="flex-1 h-1.5 bg-slate-800 rounded">
          <div
            className={`h-full rounded ${pctOfTarget >= 1 ? "bg-emerald-500" : pctOfTarget >= 0.7 ? "bg-blue-500" : "bg-amber-500"}`}
            style={{ width: `${Math.min(100, pctOfTarget * 100)}%` }}
          />
        </div>
        <span className="tabular-nums">{Math.round(pctOfTarget * 100)}%</span>
      </div>
    </div>
  );
}

function SmallKpi(props: {
  label: string;
  value: number;
  target: number;
  prior: number;
  periodLabel?: string;
  format: "usd" | "pct" | "num";
  suffix?: string;
  lowerIsBetter?: boolean;
}) {
  const fmt =
    props.format === "usd"
      ? (n: number) => fmtUsd(n)
      : props.format === "pct"
        ? (n: number) => fmtPct(n)
        : (n: number) => `${n}${props.suffix ?? ""}`;
  const lower = props.lowerIsBetter ?? false;
  const delta = pctDelta(props.value, props.prior);
  const goodDir = lower ? delta < 0 : delta > 0;
  const pctOfTarget = lower ? props.target / props.value : props.value / props.target;
  return (
    <div className="rounded-lg border border-slate-800/80 bg-slate-900/30 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-semibold truncate">
          {props.label}
        </span>
        <span
          className={`text-[10px] tabular-nums font-mono ${goodDir ? "text-emerald-400" : "text-red-400"}`}
        >
          {delta >= 0 ? "▲" : "▼"}{Math.abs(delta * 100).toFixed(0)}%
        </span>
      </div>
      <p className="text-xl font-bold tabular-nums mt-1 text-slate-100">
        {fmt(props.value)}
      </p>
      <div className="mt-2 h-1 bg-slate-800 rounded">
        <div
          className={`h-full rounded ${pctOfTarget >= 1 ? "bg-emerald-500" : pctOfTarget >= 0.7 ? "bg-blue-500" : "bg-amber-500"}`}
          style={{ width: `${Math.min(100, pctOfTarget * 100)}%` }}
        />
      </div>
      <p className="text-[10px] text-slate-500 mt-1.5 truncate">
        tgt {fmt(props.target)}
      </p>
    </div>
  );
}

function Panel({
  title,
  accent,
  className,
  children,
}: {
  title: string;
  accent: "blue" | "amber" | "emerald" | "red";
  className?: string;
  children: React.ReactNode;
}) {
  const accents = {
    blue: "border-l-blue-500",
    amber: "border-l-amber-500",
    emerald: "border-l-emerald-500",
    red: "border-l-red-500",
  };
  return (
    <div
      className={`rounded-lg border border-slate-800 border-l-2 ${accents[accent]} bg-slate-900/40 p-4 ${className ?? ""}`}
    >
      <div className="flex items-center gap-2 mb-3">
        <CircleDot className="w-3 h-3 text-slate-500" />
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

function BarRow({
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
  const colors = {
    muted: "bg-slate-600",
    blue: "bg-blue-500",
    amber: "bg-amber-500",
    green: "bg-emerald-500",
    red: "bg-red-500",
  };
  const max = 8_000_000;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="text-slate-300 font-medium">{stage}</span>
        <span className="tabular-nums font-mono text-slate-400">
          {fmtUsd(value)} · {count}
        </span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded">
        <div
          className={`h-full rounded ${colors[tone]}`}
          style={{ width: `${(value / max) * 100}%` }}
        />
      </div>
    </div>
  );
}

function Telemetry({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "ok" | "warn";
}) {
  const colors = {
    ok: "text-emerald-300",
    warn: "text-amber-300",
  };
  return (
    <div className="rounded border border-slate-800 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`text-lg font-bold tabular-nums ${colors[tone]}`}>{value}</p>
      <p className="text-[10px] text-slate-500">{sub}</p>
    </div>
  );
}

function Rail() {
  const items = [
    { icon: Radio, label: "Home", active: true },
    { icon: Zap, label: "Intel" },
    { icon: Activity, label: "Ops" },
    { icon: Server, label: "Engine" },
  ];
  return (
    <aside className="w-16 bg-[#070d18] border-r border-slate-800 flex flex-col items-center py-4 gap-1">
      <div className="w-9 h-9 rounded-md bg-blue-600 text-white grid place-items-center mb-3">
        <Workflow className="w-4 h-4" />
      </div>
      {items.map((it) => (
        <div
          key={it.label}
          className={`w-12 py-2.5 rounded-md grid place-items-center text-[10px] gap-1 ${
            it.active
              ? "bg-blue-600/20 text-blue-300"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          <it.icon className="w-4 h-4" />
          {it.label}
        </div>
      ))}
    </aside>
  );
}

function TopBar() {
  return (
    <header className="h-12 bg-[#0b1220] border-b border-slate-800 flex items-center justify-between px-6 flex-shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-[11px] uppercase tracking-[0.2em] text-slate-500 font-semibold">
          Direction B · Status board
        </span>
        <span className="text-xs font-mono text-slate-600">
          | NORTHWIND PROCUREMENT · live
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs font-mono text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_currentColor]" />
          stream OK
        </span>
        <span>05:14:02 PT</span>
      </div>
    </header>
  );
}
