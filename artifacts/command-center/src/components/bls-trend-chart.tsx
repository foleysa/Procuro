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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, LineChart as LineChartIcon, History } from "lucide-react";
import { formatDate } from "@/lib/format";
import {
  SeriesDeltaCallouts,
  type SeriesDeltaInput,
} from "./series-delta-callouts";
import {
  TrendWindowPicker,
  trendWindowToMs,
  type TrendWindow,
} from "./trend-window-picker";

type ChartMode = "indexed" | "absolute";

/**
 * Curated headline BLS price-index series rendered on the dashboard.
 *
 * These mirror entries from the api-server BLS_SERIES registry. Each
 * series is identified by exactly one of `materialCode` or `categoryCode`
 * — that's how the api-server emits the signal and how `/market-signals`
 * filters them, so the same disambiguation lives here on the client.
 *
 * The list is deliberately a subset of the full collector registry — a
 * dashboard chart with 25 toggles is unreadable. Extend cautiously.
 */
const DEFAULT_BLS_SERIES = [
  { label: "PPI: Iron and steel", materialCode: "STEEL" },
  { label: "PPI: Crude petroleum", materialCode: "CRUDE_OIL" },
  { label: "PPI: Diesel fuel", materialCode: "DIESEL" },
  { label: "PPI: Natural gas (industrial)", materialCode: "NATURAL_GAS" },
  { label: "PPI: Softwood lumber", materialCode: "LUMBER" },
  { label: "PPI: Plastic resins", materialCode: "PLASTIC_RESIN" },
  { label: "PPI: Industrial chemicals", categoryCode: "CHEMICALS" },
  { label: "PPI: Truck freight", categoryCode: "FREIGHT" },
  { label: "CPI: Energy", categoryCode: "ENERGY" },
  { label: "CPI: Electricity", categoryCode: "ELECTRICITY_RETAIL" },
] as const satisfies readonly BlsTrendSeries[];

export interface BlsTrendSeries {
  label: string;
  materialCode?: string;
  categoryCode?: string;
}

const PAIR_COLORS = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#ca8a04",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#ea580c",
  "#475569",
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The BLS Economic Index collector that emits these signals. Used to
 * scope the chart away from FRED's `economic_index` rows — FRED uses
 * the same `signalType` and overlaps on some scope codes (e.g. LUMBER),
 * so without this filter the chart could interleave points from both
 * sources for the same series.
 */
const BLS_COLLECTOR_ID = "bls-economic-index";

type ChartPoint = { observedAtMs: number } & Record<string, number>;

export interface BlsTrendChartProps {
  series?: readonly BlsTrendSeries[];
  title?: string;
  description?: string;
  emptyStateHint?: string;
}

/**
 * Multi-series line chart for BLS PPI / CPI economic indexes.
 *
 * Mirrors the FX trend chart (so admins get a consistent UX), but
 * filters market signals by the BLS-specific scope codes. Like the FX
 * chart, defaults to indexed mode (rebased to 100) so series whose
 * absolute index values diverge wildly (e.g. CPI Electricity ~270 vs
 * PPI Crude Oil ~120) can still be compared on one axis.
 */
export function BlsTrendChart({
  series = DEFAULT_BLS_SERIES,
  title = "BLS price-index trends",
  description = "Monthly PPI commodity and CPI sub-series from the U.S. Bureau of Labor Statistics. Use these to explain category-level cost swings on suppliers and contracts.",
  emptyStateHint,
}: BlsTrendChartProps) {
  const [activeKeys, setActiveKeys] = useState<Set<string>>(
    () => new Set(series.slice(0, 4).map((s) => s.label)),
  );
  const [mode, setMode] = useState<ChartMode>("indexed");
  // BLS sub-series are released monthly (PPI commodity) or quarterly
  // (ECI). Default to 1y so the chart has enough rhythm without
  // spamming tick marks; operators can widen to 5y for a longer view
  // or narrow to 90d/30d to focus on a recent move.
  const [dateWindow, setDateWindow] = useState<TrendWindow>("1y");

  // Pull one query per series anchored to the currently selected
  // date window.
  const observedAfter = useMemo(
    () => new Date(Date.now() - trendWindowToMs(dateWindow)).toISOString(),
    [dateWindow],
  );

  // One query per series. The BLS collector emits one signal per
  // observation in its 2-year window, so a 600-row cap covers monthly
  // (24 obs) and quarterly (8 obs) series with comfortable headroom.
  const queries = useQueries({
    queries: series.map((s) =>
      getListMarketSignalsQueryOptions<MarketSignal[], Error>({
        signalType: "economic_index",
        collectorId: BLS_COLLECTOR_ID,
        ...(s.materialCode ? { scopeMaterialCode: s.materialCode } : {}),
        ...(s.categoryCode ? { scopeCategoryCode: s.categoryCode } : {}),
        observedAfter,
        order: "asc",
        limit: 600,
      }),
    ),
  });

  const isLoading = queries.some((q) => q.isLoading);
  const totalPoints = queries.reduce(
    (acc, q) => acc + (q.data?.length ?? 0),
    0,
  );

  const chartData = useMemo<ChartPoint[]>(() => {
    const byTs = new Map<number, ChartPoint>();
    queries.forEach((q, i) => {
      const label = series[i]!.label;
      if (!q.data || q.data.length === 0) return;
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
        point[label] = useIndex ? (row.value / baseline) * 100 : row.value;
      }
    });
    return Array.from(byTs.values()).sort(
      (a, b) => a.observedAtMs - b.observedAtMs,
    );
  }, [queries, series, mode]);

  // Window-delta callout inputs. Always raw values (not indexed) so the
  // % shown matches the underlying index move regardless of display mode.
  const deltas = useMemo<SeriesDeltaInput[]>(() => {
    return series
      .filter((s) => activeKeys.has(s.label))
      .map((s, idx): SeriesDeltaInput => {
        const i = series.findIndex((x) => x.label === s.label);
        const data = queries[i]?.data ?? [];
        const first = data[0];
        const last = data[data.length - 1];
        return {
          label: s.label,
          color: PAIR_COLORS[idx % PAIR_COLORS.length]!,
          first: first ? first.value : null,
          last: last ? last.value : null,
          firstAt: first ? first.observedAt : null,
          lastAt: last ? last.observedAt : null,
        };
      });
  }, [series, queries, activeKeys]);

  const windowLabel = useMemo(() => {
    const visible = deltas
      .map((d) => (d.firstAt ? new Date(d.firstAt).getTime() : null))
      .filter((v): v is number => v !== null);
    if (visible.length === 0) return dateWindow;
    const earliest = Math.min(...visible);
    const days = Math.round((Date.now() - earliest) / ONE_DAY_MS);
    if (days >= 365) return `${(days / 365).toFixed(1)}y`;
    return `${days}d`;
  }, [deltas, dateWindow]);

  const toggle = (label: string) => {
    setActiveKeys((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  return (
    <Card data-testid="bls-trend-chart">
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
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            <TrendWindowPicker
              value={dateWindow}
              onChange={setDateWindow}
              testIdPrefix="bls-trend"
            />
            <div
              className="inline-flex rounded-md border p-0.5"
              role="group"
              aria-label="Display mode"
            >
              <Button
                type="button"
                size="sm"
                variant={mode === "indexed" ? "default" : "ghost"}
                onClick={() => setMode("indexed")}
                data-testid="bls-mode-indexed"
                className="h-7 text-xs"
                title="Rebase each series to 100 at the start of the visible window so trend shapes can be compared on a single axis."
              >
                Indexed
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "absolute" ? "default" : "ghost"}
                onClick={() => setMode("absolute")}
                data-testid="bls-mode-absolute"
                className="h-7 text-xs"
                title="Show raw BLS index values (1982=100 for PPI commodity series)."
              >
                Absolute
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" data-testid="bls-series-toggles">
          {series.map((s, i) => {
            const isActive = activeKeys.has(s.label);
            const color = PAIR_COLORS[i % PAIR_COLORS.length];
            const pointCount = queries[i]?.data?.length ?? 0;
            return (
              <Button
                key={s.label}
                type="button"
                size="sm"
                variant={isActive ? "default" : "outline"}
                onClick={() => toggle(s.label)}
                data-testid={`bls-series-toggle-${s.label}`}
                className="h-7 text-xs gap-2"
                disabled={pointCount === 0}
                title={
                  pointCount === 0
                    ? `No data for ${s.label} yet`
                    : `${pointCount.toLocaleString()} observations`
                }
              >
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
                {s.label}
                <Badge
                  variant="secondary"
                  className="ml-1 px-1.5 py-0 text-[10px]"
                >
                  {pointCount.toLocaleString()}
                </Badge>
              </Button>
            );
          })}
        </div>

        {isLoading && totalPoints === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading BLS history…
          </div>
        ) : totalPoints === 0 ? (
          <div
            data-testid="bls-trend-empty-state"
            className="flex flex-col items-center justify-center gap-3 py-12 text-center border border-dashed rounded-md"
          >
            <History className="w-8 h-8 text-muted-foreground" />
            <div className="space-y-1 max-w-md">
              <p className="text-sm font-medium">No BLS history yet</p>
              <p className="text-xs text-muted-foreground">
                {emptyStateHint ??
                  "Run the BLS Economic Index collector above. It emits two years of monthly/quarterly observations per series on each successful run."}
              </p>
            </div>
          </div>
        ) : (
          <>
            <SeriesDeltaCallouts
              series={deltas}
              windowLabel={windowLabel}
              data-testid="bls-trend-deltas"
            />
            <div className="h-80 w-full" data-testid="bls-trend-chart-canvas">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-border"
                  />
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
                      mode === "indexed" ? v.toFixed(0) : v.toFixed(1)
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
                      return [value.toFixed(2), name];
                    }}
                  />
                  {series.map((s, i) => {
                    if (!activeKeys.has(s.label)) return null;
                    return (
                      <Line
                        key={s.label}
                        type="monotone"
                        dataKey={s.label}
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
