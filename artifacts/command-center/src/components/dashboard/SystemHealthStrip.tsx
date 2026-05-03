/**
 * SystemHealthStrip — bottom-of-dashboard health summary bar (#286).
 *
 * A compact horizontal strip showing Engine status (🔴/🟡/🟢) and a
 * one-line plain-text summary. Clicking the strip expands a collapsible
 * drawer that contains the original diagnostic tiles (Cycle P50,
 * Recommendation Precision, Signals 24h, Collector Coverage, Data Pulse).
 *
 * When status evaluates to 🔴 Red the component fires — and deduplicates
 * via `dedupeKey` — an "Engine Stalled" high-severity alert so the
 * Critical Alerts counter in the status tiles stops showing a misleading
 * zero.
 */

import { useEffect, useRef } from "react";
import { Link } from "wouter";
import {
  useCreateManualAlert,
  getGetAlertsSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Activity,
  Radar,
  Timer,
  Zap,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatPercent, formatUsd } from "@/lib/format";

// ---------- Status logic ----------

export type HealthStatus = "green" | "yellow" | "red";

/**
 * Per-tenant thresholds the strip uses to decide green/yellow/red.
 * Default values match the original hardcoded behaviour so callers
 * that don't pass thresholds see no change. Operators tune these
 * from the Settings page (Task #295) and they ride through
 * `GetMe.org.healthThresholds`.
 */
export interface HealthThresholds {
  minSignalsPerDay: number;
  maxStaleCollectors: number;
  maxQueuedJobs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  minSignalsPerDay: 1,
  maxStaleCollectors: 1,
  maxQueuedJobs: 5,
};

export interface SystemHealthInputs {
  signals24h: number;
  signals7dayAvg: number;
  failedJobs: number;
  pendingJobs: number;
  runningJobs: number;
  staleCollectors: number;
  thresholds?: HealthThresholds;
}

export function computeHealthStatus(inputs: SystemHealthInputs): HealthStatus {
  const { signals24h, signals7dayAvg, failedJobs, pendingJobs, runningJobs, staleCollectors } = inputs;
  const t = inputs.thresholds ?? DEFAULT_HEALTH_THRESHOLDS;

  // Tier 3 — Red: any hard-stop condition
  if (signals24h < t.minSignalsPerDay) return "red";
  if (failedJobs > 0) return "red";
  if (pendingJobs > t.maxQueuedJobs && runningJobs === 0) return "red";

  // Tier 1 — Green: all clear thresholds
  const sigOk = signals7dayAvg === 0 || signals24h >= signals7dayAvg * 0.5;
  const jobsOk = failedJobs === 0;
  const collectorsOk = staleCollectors <= t.maxStaleCollectors;
  if (sigOk && jobsOk && collectorsOk) return "green";

  // Tier 2 — Yellow: any threshold breached but not hard-stop
  return "yellow";
}

export function buildHealthSummary(inputs: SystemHealthInputs, status: HealthStatus): string {
  const { signals24h, failedJobs, pendingJobs, runningJobs, staleCollectors } = inputs;
  const t = inputs.thresholds ?? DEFAULT_HEALTH_THRESHOLDS;
  if (status === "green") {
    return `Engine healthy — ${signals24h} signals in 24h, no failed jobs, ${staleCollectors} stale collector${staleCollectors === 1 ? "" : "s"}.`;
  }
  if (status === "red") {
    const parts: string[] = [];
    if (signals24h < t.minSignalsPerDay) {
      parts.push(
        signals24h === 0
          ? "0 signals in 24h"
          : `${signals24h} signals in 24h (min ${t.minSignalsPerDay})`,
      );
    }
    if (failedJobs > 0) parts.push(`${failedJobs} failed job${failedJobs === 1 ? "" : "s"}`);
    if (pendingJobs > 0) parts.push(`${pendingJobs + runningJobs} jobs queued`);
    if (staleCollectors > 0) parts.push(`${staleCollectors} stale collector${staleCollectors === 1 ? "" : "s"}`);
    return `Engine intake stalled — ${parts.join(", ")}.`;
  }
  // yellow
  const warnings: string[] = [];
  if (staleCollectors > t.maxStaleCollectors) warnings.push(`${staleCollectors} stale collectors`);
  if (failedJobs > 0) warnings.push(`${failedJobs} failed jobs`);
  return warnings.length > 0
    ? `Engine degraded — ${warnings.join(", ")}.`
    : "Engine degraded — some thresholds breached.";
}

// ---------- Engine Stalled alert rule ----------

const ENGINE_STALLED_DEDUPE = "engine_stalled";

interface EngineStalledProps {
  status: HealthStatus;
  summary: string;
  onOpenDrawer: () => void;
}

function useEngineStalledAlert({ status, summary, onOpenDrawer }: EngineStalledProps) {
  const qc = useQueryClient();
  const hasFiredfRef = useRef(false);

  const createAlert = useCreateManualAlert({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAlertsSummaryQueryKey() });
      },
    },
  });

  useEffect(() => {
    if (status !== "red") {
      hasFiredfRef.current = false;
      return;
    }
    // Fire once per status transition to red; dedupeKey prevents DB
    // duplicates — subsequent calls just bump the occurrence counter.
    if (!hasFiredfRef.current) {
      hasFiredfRef.current = true;
      void createAlert.mutateAsync({
        data: {
          severity: "high",
          source: "manual",
          kind: ENGINE_STALLED_DEDUPE,
          title: "Engine intake has stopped — investigate collectors and job queue.",
          summary,
          dedupeKey: ENGINE_STALLED_DEDUPE,
          payload: {
            ctaLabel: "Open Engine Telemetry",
            ctaUrl: "/?health=open",
          },
        },
      }).catch(() => {
        hasFiredfRef.current = false;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, summary]);

  void onOpenDrawer;
}

// ---------- Main component ----------

export interface SystemHealthStripProps {
  // Telemetry inputs for status computation
  signals24h: number;
  signals7dayAvg: number;
  failedJobs: number;
  pendingJobs: number;
  runningJobs: number;
  staleCollectors: number;
  // Per-tenant thresholds (Task #295). Optional — falls back to
  // `DEFAULT_HEALTH_THRESHOLDS` so legacy callers keep working.
  thresholds?: HealthThresholds;
  // Drawer diagnostic content
  cycleP50Hours: number | null;
  precisionRate: number | null;
  decidedCount: number;
  realizedCount: number;
  signalsDir?: "up" | "down" | "flat";
  signals24to48hCount: number;
  lastSignalAt?: string | null;
  enabledCollectorCount: number;
  collectorTotal: number;
  spendTotalUsd: number;
  supplierCount: number;
  // Drawer state (lifted to parent for CTA wiring)
  isOpen: boolean;
  onToggle: () => void;
}

export function SystemHealthStrip({
  signals24h,
  signals7dayAvg,
  failedJobs,
  pendingJobs,
  runningJobs,
  staleCollectors,
  thresholds,
  cycleP50Hours,
  precisionRate,
  decidedCount,
  realizedCount,
  signalsDir,
  signals24to48hCount,
  lastSignalAt,
  enabledCollectorCount,
  collectorTotal,
  spendTotalUsd,
  supplierCount,
  isOpen,
  onToggle,
}: SystemHealthStripProps) {
  const inputs: SystemHealthInputs = { signals24h, signals7dayAvg, failedJobs, pendingJobs, runningJobs, staleCollectors, thresholds };
  const status = computeHealthStatus(inputs);
  const summary = buildHealthSummary(inputs, status);

  useEngineStalledAlert({ status, summary, onOpenDrawer: onToggle });

  const dot =
    status === "green"
      ? "🟢"
      : status === "yellow"
        ? "🟡"
        : "🔴";

  const stripCls =
    status === "green"
      ? "border-emerald-200 bg-emerald-50/60 dark:bg-emerald-950/20 dark:border-emerald-900"
      : status === "yellow"
        ? "border-amber-200 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-900"
        : "border-red-200 bg-red-50/60 dark:bg-red-950/20 dark:border-red-900";

  const CYCLE_TARGET_HOURS = 6;

  return (
    <div
      className={`rounded-lg border ${stripCls} transition-colors`}
      data-testid="system-health-strip"
      id="system-health-strip"
    >
      {/* Strip header — always visible */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium cursor-pointer hover:opacity-90 transition-opacity"
        aria-expanded={isOpen}
        aria-controls="system-health-drawer"
        data-testid="btn-system-health-toggle"
      >
        <span className="flex items-center gap-3 min-w-0">
          <span className="text-base leading-none" aria-hidden="true">
            {dot}
          </span>
          <span className="font-semibold">
            Engine:{" "}
            {status === "green"
              ? "Operational"
              : status === "yellow"
                ? "Degraded"
                : "Stalled"}
          </span>
          <span className="text-xs text-muted-foreground font-normal truncate hidden sm:inline">
            {summary}
          </span>
        </span>
        <span className="flex items-center gap-2 shrink-0 ml-4">
          <span className="text-xs text-muted-foreground">
            {isOpen ? "Collapse" : "Engine telemetry"}
          </span>
          {isOpen ? (
            <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </span>
      </button>

      {/* Drawer — original diagnostic tiles */}
      {isOpen && (
        <div
          id="system-health-drawer"
          className="border-t px-4 pb-4 pt-4 space-y-4"
          data-testid="system-health-drawer"
        >
          {/* KPI tiles row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <DiagKpi
              label="Cycle p50"
              value={cycleP50Hours === null ? "—" : `${cycleP50Hours.toFixed(1)}h`}
              progress={
                cycleP50Hours === null
                  ? null
                  : Math.min(1, CYCLE_TARGET_HOURS / Math.max(0.01, cycleP50Hours))
              }
              targetText={`target ≤${CYCLE_TARGET_HOURS}h`}
              icon={Timer}
              href="/system"
              testId="kpi-cycle-p50"
            />
            <DiagKpi
              label="Recommendation precision"
              value={precisionRate === null ? "—" : formatPercent(precisionRate)}
              progress={precisionRate}
              targetText={
                precisionRate === null
                  ? "needs decided opps"
                  : `${realizedCount} realized of ${decidedCount} decided`
              }
              icon={Zap}
              href="/results"
              testId="kpi-precision"
            />
            <DiagKpi
              label="Signals · 24h"
              value={signals24h.toLocaleString()}
              progress={null}
              targetText={
                signals24to48hCount === 0
                  ? lastSignalAt
                    ? `last ${timeAgo(lastSignalAt)}`
                    : "no signals yet"
                  : `vs ${signals24to48hCount} prior 24h`
              }
              dir={signals24to48hCount > 0 ? signalsDir : undefined}
              icon={Radar}
              href="/fusion"
              testId="kpi-signals"
            />
            <DiagKpi
              label="Collector coverage"
              value={
                collectorTotal === 0
                  ? "—"
                  : `${enabledCollectorCount}/${collectorTotal}`
              }
              progress={
                collectorTotal === 0
                  ? null
                  : enabledCollectorCount / collectorTotal
              }
              targetText={
                staleCollectors > 0 ? `${staleCollectors} stale` : "all fresh"
              }
              icon={Radar}
              href="/collectors"
              testId="kpi-coverage"
              tone={staleCollectors > 0 ? "warn" : undefined}
            />
          </div>

          {/* Data Pulse card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="w-4 h-4 text-emerald-500" />
                Data pulse
              </CardTitle>
              <CardDescription>
                Engine intake — collectors, signals, and active jobs.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <DataTile
                label="Collectors"
                value={`${enabledCollectorCount}/${collectorTotal}`}
                sub={staleCollectors > 0 ? `${staleCollectors} stale` : "all fresh"}
                tone={staleCollectors > 0 ? "warn" : "ok"}
                href="/collectors"
              />
              <DataTile
                label="Signals · 24h"
                value={signals24h.toLocaleString()}
                sub={
                  signals24to48hCount === 0
                    ? "first window"
                    : `vs ${signals24to48hCount} prior`
                }
                tone="ok"
                href="/fusion"
              />
              <DataTile
                label="Jobs in flight"
                value={String(runningJobs + pendingJobs)}
                sub={`${runningJobs} run · ${pendingJobs} queued`}
                tone={pendingJobs + runningJobs > 0 ? "info" : "ok"}
                href="/system"
              />
              <DataTile
                label="Addressable spend"
                value={formatUsd(spendTotalUsd, { compact: true })}
                sub={`${supplierCount} suppliers`}
                tone="ok"
                href="/spend"
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------- Internal sub-components ----------

function DiagKpi({
  label,
  value,
  progress,
  targetText,
  dir,
  icon: Icon,
  href,
  testId,
  tone,
}: {
  label: string;
  value: string;
  progress: number | null;
  targetText: string;
  dir?: "up" | "down" | "flat";
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  testId: string;
  tone?: "warn";
}) {
  const barColor =
    progress === null
      ? "bg-muted"
      : tone === "warn"
        ? "bg-amber-500"
        : progress >= 0.8
          ? "bg-emerald-500"
          : progress >= 0.5
            ? "bg-blue-500"
            : "bg-amber-500";
  const dirIcon =
    dir === "up" ? (
      <TrendingUp className="w-3 h-3 text-emerald-600" />
    ) : dir === "down" ? (
      <TrendingDown className="w-3 h-3 text-red-600" />
    ) : dir === "flat" ? (
      <Minus className="w-3 h-3 text-muted-foreground" />
    ) : null;
  return (
    <Link href={href} data-testid={testId}>
      <div className="group rounded-lg border bg-card p-3 hover:border-foreground/20 transition-colors cursor-pointer h-full">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-semibold truncate">
            {label}
          </span>
          <Icon className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
        </div>
        <div className="flex items-baseline gap-1.5 mt-1.5">
          <p
            className="text-xl font-bold tabular-nums text-foreground"
            data-testid={`${testId}-value`}
          >
            {value}
          </p>
          {dirIcon}
        </div>
        {progress !== null && (
          <div className="mt-2 h-1 bg-muted rounded overflow-hidden">
            <div
              className={`h-full rounded ${barColor}`}
              style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
            />
          </div>
        )}
        <p className="text-[10px] text-muted-foreground mt-1.5 truncate">
          {targetText}
        </p>
      </div>
    </Link>
  );
}

function DataTile({
  label,
  value,
  sub,
  tone,
  href,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "ok" | "warn" | "info";
  href: string;
}) {
  const valueColor =
    tone === "warn"
      ? "text-amber-700 dark:text-amber-300"
      : tone === "info"
        ? "text-blue-700 dark:text-blue-300"
        : "text-foreground";
  return (
    <Link href={href}>
      <div className="rounded-md border px-3 py-2 hover:border-foreground/20 cursor-pointer transition-colors">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          {label}
        </p>
        <p className={`text-lg font-bold tabular-nums ${valueColor}`}>{value}</p>
        <p className="text-[10px] text-muted-foreground truncate">{sub}</p>
      </div>
    </Link>
  );
}

function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ${future ? "away" : "ago"}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ${future ? "away" : "ago"}`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ${future ? "away" : "ago"}`;
  const months = Math.round(days / 30);
  return `${months}mo ${future ? "away" : "ago"}`;
}

// Needed for the "Open Engine Telemetry" link rendered by the strip header
void ArrowRight;
