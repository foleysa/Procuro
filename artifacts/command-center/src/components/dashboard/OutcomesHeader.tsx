import { Link } from "wouter";
import { TrendingUp, Sparkles, Target, AlertTriangle } from "lucide-react";
import { formatUsd, formatPercent } from "@/lib/format";
import { CAPTURE_RATE_TARGET } from "@/lib/s2p-config";

type SavingsTag = "REALIZED" | "IDENTIFIED" | "NEGOTIATED" | "IMPLEMENTED";

function SavingsTypeTag({ tag }: { tag: SavingsTag }) {
  const styles: Record<SavingsTag, string> = {
    REALIZED:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    IDENTIFIED:
      "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
    NEGOTIATED:
      "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
    IMPLEMENTED:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  };
  return (
    <span
      className={`inline-block text-[9px] font-semibold uppercase tracking-[0.18em] px-1.5 py-0.5 rounded ${styles[tag]}`}
    >
      {tag}
    </span>
  );
}

interface OutcomesHeaderProps {
  realizedSavingsUsd: number;
  pipelineCount: number;
  pipelineValue: number;
  addressableSpendUsd: number;
  activeSupplierCount: number;
  captureRateDenominator: number;
  loading?: boolean;
}

export function OutcomesHeader({
  realizedSavingsUsd,
  pipelineCount,
  pipelineValue,
  addressableSpendUsd,
  activeSupplierCount,
  captureRateDenominator,
  loading,
}: OutcomesHeaderProps) {
  const captureRateActual =
    captureRateDenominator > 0
      ? realizedSavingsUsd / captureRateDenominator
      : 0;

  const goalAmount = CAPTURE_RATE_TARGET * captureRateDenominator;
  const gapAmount = Math.max(0, goalAmount - realizedSavingsUsd);
  const isOnTrack = realizedSavingsUsd >= goalAmount;

  return (
    <div
      className="grid grid-cols-1 md:grid-cols-4 gap-4"
      data-testid="dashboard-outcomes-header"
    >
      {/* Tile 1 — Realized Savings (hero tile, spans 2/4 cols on md+) */}
      <Link href="/results" className="md:col-span-2" data-testid="outcomes-tile-realized">
        <div className="group rounded-xl border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/30 dark:to-card dark:border-emerald-900 p-6 hover:border-emerald-400 dark:hover:border-emerald-700 transition-colors cursor-pointer h-full">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground font-semibold">
              Realized Savings
            </span>
            <TrendingUp className="w-4 h-4 text-emerald-600/60" />
          </div>
          <p
            className="text-4xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300 mt-2"
            data-testid="outcomes-realized-value"
          >
            {loading ? "…" : formatUsd(realizedSavingsUsd, { compact: true })}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Finance-validated, Hard Savings, period-to-date
          </p>
          <div className="mt-3">
            <SavingsTypeTag tag="REALIZED" />
          </div>
        </div>
      </Link>

      {/* Tile 2 — Identified Pipeline */}
      <Link href="/opportunities" data-testid="outcomes-tile-pipeline">
        <div className="group rounded-xl border bg-card p-5 hover:border-foreground/20 transition-colors cursor-pointer h-full">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground font-semibold">
              Identified Pipeline
            </span>
            <Sparkles className="w-4 h-4 text-muted-foreground/60" />
          </div>
          <p
            className="text-4xl font-bold tabular-nums text-foreground mt-2"
            data-testid="outcomes-pipeline-value"
          >
            {loading ? "…" : formatUsd(pipelineValue, { compact: true })}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            {loading
              ? "—"
              : `${pipelineCount} open opportunities · ${formatUsd(addressableSpendUsd, { compact: true })} addressable across ${activeSupplierCount} suppliers`}
          </p>
          <div className="mt-3">
            <SavingsTypeTag tag="IDENTIFIED" />
          </div>
        </div>
      </Link>

      {/* Tile 3 — Gap to Goal */}
      <Link href="/results" data-testid="outcomes-tile-gap">
        <div
          className={`group rounded-xl border p-5 hover:border-foreground/20 transition-colors cursor-pointer h-full ${
            isOnTrack
              ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20"
              : "border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/20"
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground font-semibold">
              Gap to Goal
            </span>
            {isOnTrack ? (
              <Target className="w-4 h-4 text-emerald-600/60" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-600/60" />
            )}
          </div>
          <p
            className={`text-4xl font-bold tabular-nums mt-2 ${
              isOnTrack
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-amber-700 dark:text-amber-300"
            }`}
            data-testid="outcomes-gap-value"
          >
            {loading
              ? "…"
              : isOnTrack
                ? "On target"
                : `${formatUsd(gapAmount, { compact: true })} short`}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            {loading
              ? "—"
              : `${isOnTrack ? "Exceeds" : `Short of`} ${formatPercent(CAPTURE_RATE_TARGET)} target (${formatUsd(goalAmount, { compact: true })})`}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {loading
              ? ""
              : `Capture Rate: ${formatPercent(captureRateActual)} actual vs ${formatPercent(CAPTURE_RATE_TARGET)} target`}
          </p>
          <div className="mt-3">
            <SavingsTypeTag tag={isOnTrack ? "REALIZED" : "IDENTIFIED"} />
          </div>
        </div>
      </Link>
    </div>
  );
}
