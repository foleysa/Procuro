import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getListMarketSignalsQueryOptions,
  type MarketSignal,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  LineChart as LineChartIcon,
  History,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type ChartMode = "indexed" | "absolute";

/**
 * Currency pairs the ECB collector emits today (see
 * `artifacts/api-server/src/lib/intelligence/collectors/ecb-fx-rates.ts`).
 * Listed roughly in order of how often they show up on procurement
 * contracts. The chart lets the user toggle which ones are visible.
 */
const DEFAULT_FX_PAIRS = [
  "EUR/USD",
  "USD/JPY",
  "USD/GBP",
  "USD/CNY",
  "USD/CHF",
  "USD/CAD",
  "USD/MXN",
  "USD/INR",
  "USD/BRL",
  "USD/AUD",
] as const;

/**
 * High-contrast palette that survives both light and dark mode without
 * pulling in a separate theming token system.
 */
const PAIR_COLORS = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#ca8a04", // amber
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
  "#ea580c", // orange
  "#475569", // slate
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_YEARS_MS = 5 * 365 * ONE_DAY_MS;

type ChartPoint = { observedAtMs: number } & Record<string, number>;

export interface FxTrendChartProps {
  /**
   * Pairs to render. Defaults to the full ECB-tracked set. Pass a smaller
   * list when embedding the chart on a supplier/contract detail screen
   * filtered to that record's billing currency.
   */
  pairs?: readonly string[];
  /** Title shown in the card header. */
  title?: string;
  /** Subtitle / description shown under the title. */
  description?: string;
  /**
   * Hint shown in the empty state. Use to point admins at the
   * "Backfill history" button on the same page.
   */
  emptyStateHint?: string;
}

export function FxTrendChart({
  pairs = DEFAULT_FX_PAIRS,
  title = "FX-rate trends",
  description = "Daily ECB reference rates. Use these to explain cost movements on suppliers and contracts billed in non-base currencies.",
  emptyStateHint,
}: FxTrendChartProps) {
  const [activePairs, setActivePairs] = useState<Set<string>>(
    () => new Set(pairs.slice(0, 4)),
  );
  // Default to indexed (rebased to 100 at start) so pairs with very
  // different absolute magnitudes (e.g. USD/JPY ~150 vs USD/GBP ~0.8)
  // can be compared on a single readable axis. Users who care about the
  // raw rate can flip to "Absolute".
  const [mode, setMode] = useState<ChartMode>("indexed");

  // Pull one chart-friendly time-series per pair. Ranged five years back so
  // the chart matches the ECB historical-archive backfill window.
  const observedAfter = useMemo(
    () => new Date(Date.now() - FIVE_YEARS_MS).toISOString(),
    [],
  );

  // Fire one query per pair via `useQueries` so the hook count stays stable
  // even when the parent passes a different `pairs` array. React Query
  // dedupes & caches the results and the server responds quickly because
  // (signalType, scopeMaterialCode, observedAt) are all indexed.
  const queries = useQueries({
    queries: pairs.map((pair) =>
      getListMarketSignalsQueryOptions<MarketSignal[], Error>({
        signalType: "fx_rate",
        scopeMaterialCode: pair,
        observedAfter,
        order: "asc",
        limit: 5000,
      }),
    ),
  });

  const isLoading = queries.some((q) => q.isLoading);
  const totalPoints = queries.reduce(
    (acc, q) => acc + (q.data?.length ?? 0),
    0,
  );

  const chartData = useMemo<ChartPoint[]>(() => {
    // Bucket every (pair, observedAt) into a shared timeline so recharts can
    // render multiple lines aligned on the X axis.
    const byTs = new Map<number, ChartPoint>();
    queries.forEach((q, i) => {
      const pair = pairs[i]!;
      if (!q.data || q.data.length === 0) return;
      // Find the earliest observation in the active range to use as the
      // index baseline. Server returned them sorted ascending.
      const baseline = q.data[0]?.value;
      const useIndex = mode === "indexed" && baseline && baseline !== 0;
      for (const row of q.data) {
        const ts = new Date(row.observedAt).getTime();
        if (!Number.isFinite(ts)) continue;
        let point = byTs.get(ts);
        if (!point) {
          point = { observedAtMs: ts };
          byTs.set(ts, point);
        }
        point[pair] = useIndex ? (row.value / baseline) * 100 : row.value;
      }
    });
    return Array.from(byTs.values()).sort(
      (a, b) => a.observedAtMs - b.observedAtMs,
    );
  }, [queries, pairs, mode]);

  // Per-pair summary used to decorate each toggle button with a "% change
  // over the visible window" figure plus the latest rate. We compute this
  // for *every* pair (not just the active ones) so the user can see the
  // headline numbers before deciding which lines to render. The percentage
  // is always derived from raw values so it matches the underlying market
  // move regardless of which display mode is selected — the displayed
  // "latest" value, however, reflects the active mode so it lines up with
  // the value the user sees at the right edge of the chart.
  type PairStat = {
    pair: string;
    color: string;
    pointCount: number;
    firstRaw: number | null;
    latestRaw: number | null;
    firstAt: string | null;
    lastAt: string | null;
    /** Pct change from first to last raw value over the visible window. */
    pct: number | null;
    /** Latest value formatted for the active display mode. */
    latestDisplay: string | null;
  };

  const pairStats = useMemo<PairStat[]>(() => {
    return pairs.map((pair, i): PairStat => {
      const data = queries[i]?.data ?? [];
      const first = data[0];
      const last = data[data.length - 1];
      const firstRaw = first ? first.value : null;
      const latestRaw = last ? last.value : null;
      const pct =
        firstRaw !== null && latestRaw !== null && firstRaw !== 0
          ? ((latestRaw - firstRaw) / firstRaw) * 100
          : null;
      let latestDisplay: string | null = null;
      if (latestRaw !== null) {
        if (mode === "indexed" && firstRaw !== null && firstRaw !== 0) {
          // Match what the chart's right-edge tick shows in indexed mode.
          latestDisplay = ((latestRaw / firstRaw) * 100).toFixed(1);
        } else {
          // Absolute mode: show enough precision for sub-1 rates without
          // making 158.3 noisy.
          latestDisplay =
            Math.abs(latestRaw) >= 10
              ? latestRaw.toFixed(2)
              : latestRaw.toFixed(4);
        }
      }
      return {
        pair,
        color: PAIR_COLORS[i % PAIR_COLORS.length]!,
        pointCount: data.length,
        firstRaw,
        latestRaw,
        firstAt: first ? first.observedAt : null,
        lastAt: last ? last.observedAt : null,
        pct,
        latestDisplay,
      };
    });
  }, [pairs, queries, mode]);

  const windowLabel = useMemo(() => {
    // Anchor the label on the earliest observation across the *active*
    // pairs so the figure lines up with what the chart is actually showing.
    const visible = pairStats
      .filter((s) => activePairs.has(s.pair) && s.firstAt)
      .map((s) => new Date(s.firstAt!).getTime())
      .filter((v) => Number.isFinite(v));
    if (visible.length === 0) return "5y";
    const earliest = Math.min(...visible);
    const days = Math.round((Date.now() - earliest) / ONE_DAY_MS);
    if (days >= 365) return `${(days / 365).toFixed(1)}y`;
    return `${days}d`;
  }, [pairStats, activePairs]);

  const formatPct = (pct: number) => {
    const sign = pct > 0 ? "+" : "";
    const digits = Math.abs(pct) >= 10 ? 1 : 2;
    return `${sign}${pct.toFixed(digits)}%`;
  };

  const togglePair = (pair: string) => {
    setActivePairs((prev) => {
      const next = new Set(prev);
      if (next.has(pair)) {
        next.delete(pair);
      } else {
        next.add(pair);
      }
      return next;
    });
  };

  return (
    <Card data-testid="fx-trend-chart">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <LineChartIcon className="w-5 h-5 text-primary" />
              {title}
            </CardTitle>
            {description && (
              <p className="text-sm text-muted-foreground mt-1">{description}</p>
            )}
          </div>
          <div className="inline-flex rounded-md border p-0.5 shrink-0" role="group">
            <Button
              type="button"
              size="sm"
              variant={mode === "indexed" ? "default" : "ghost"}
              onClick={() => setMode("indexed")}
              data-testid="fx-mode-indexed"
              className="h-7 text-xs"
              title="Rebase each pair to 100 at the start of the visible window so trend shapes can be compared on a single axis."
            >
              Indexed
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "absolute" ? "default" : "ghost"}
              onClick={() => setMode("absolute")}
              data-testid="fx-mode-absolute"
              className="h-7 text-xs"
              title="Show raw FX rates."
            >
              Absolute
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" data-testid="fx-pair-toggles">
          {pairStats.map((stat) => {
            const { pair, color, pointCount, pct, latestDisplay } = stat;
            const isActive = activePairs.has(pair);
            const hasData = pointCount > 0 && pct !== null;
            const TrendIcon =
              pct === null || Math.abs(pct) < 0.05
                ? Minus
                : pct > 0
                  ? TrendingUp
                  : TrendingDown;
            const tooltip =
              pointCount === 0
                ? `No data for ${pair} yet`
                : [
                    `${pair}: ${stat.firstRaw?.toFixed(4)} → ${stat.latestRaw?.toFixed(4)}`,
                    stat.firstAt && stat.lastAt
                      ? `${new Date(stat.firstAt).toLocaleDateString()} → ${new Date(stat.lastAt).toLocaleDateString()}`
                      : null,
                    `${pointCount.toLocaleString()} observations · window ${windowLabel}`,
                  ]
                    .filter(Boolean)
                    .join("\n");
            return (
              <Button
                key={pair}
                type="button"
                size="sm"
                variant={isActive ? "default" : "outline"}
                onClick={() => togglePair(pair)}
                data-testid={`fx-pair-toggle-${pair}`}
                className="h-auto py-1.5 px-2.5 text-xs gap-2"
                disabled={pointCount === 0}
                title={tooltip}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="font-medium">{pair}</span>
                {hasData ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 tabular-nums",
                      isActive ? "opacity-90" : "opacity-80",
                    )}
                    data-testid={`fx-pair-stat-${pair}`}
                  >
                    <TrendIcon className="w-3 h-3" aria-hidden />
                    <span data-testid={`fx-pair-pct-${pair}`}>
                      {formatPct(pct!)}
                    </span>
                    <span
                      className="opacity-70"
                      data-testid={`fx-pair-latest-${pair}`}
                    >
                      · {latestDisplay}
                    </span>
                  </span>
                ) : (
                  <span className="opacity-60 italic">no data</span>
                )}
              </Button>
            );
          })}
        </div>

        {isLoading && totalPoints === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading FX history…
          </div>
        ) : totalPoints === 0 ? (
          <div
            data-testid="fx-trend-empty-state"
            className="flex flex-col items-center justify-center gap-3 py-12 text-center border border-dashed rounded-md"
          >
            <History className="w-8 h-8 text-muted-foreground" />
            <div className="space-y-1 max-w-md">
              <p className="text-sm font-medium">No FX history yet</p>
              <p className="text-xs text-muted-foreground">
                {emptyStateHint ??
                  'Click "Backfill history" on the ECB FX Rates collector above to seed five years of daily reference rates.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="h-80 w-full" data-testid="fx-trend-chart-canvas">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="observedAtMs"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(v: number) =>
                    new Date(v).toLocaleDateString("en-US", {
                      month: "short",
                      year: "2-digit",
                    })
                  }
                  className="text-xs fill-muted-foreground"
                  minTickGap={48}
                />
                <YAxis
                  className="text-xs fill-muted-foreground"
                  domain={mode === "indexed" ? ["auto", "auto"] : [0, "auto"]}
                  tickFormatter={(v: number) =>
                    mode === "indexed"
                      ? v.toFixed(0)
                      : v >= 10
                        ? v.toFixed(0)
                        : v.toFixed(3)
                  }
                  width={56}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--background))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  labelFormatter={(v) => formatDate(new Date(v as number))}
                  formatter={(value: number, name) => {
                    if (typeof value !== "number") return [value, name];
                    if (mode === "indexed") {
                      const pct = value - 100;
                      const sign = pct >= 0 ? "+" : "";
                      return [
                        `${value.toFixed(2)} (${sign}${pct.toFixed(2)}%)`,
                        name,
                      ];
                    }
                    return [value.toFixed(4), name];
                  }}
                />
                {pairs.map((pair, i) => {
                  if (!activePairs.has(pair)) return null;
                  return (
                    <Line
                      key={pair}
                      type="monotone"
                      dataKey={pair}
                      stroke={PAIR_COLORS[i % PAIR_COLORS.length]}
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
