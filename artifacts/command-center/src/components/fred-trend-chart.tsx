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

type ChartMode = "indexed" | "absolute";

const FRED_COLLECTOR_ID = "fred-economic-index";

/**
 * Curated FRED PPI series rendered on the workbench.
 *
 * Each entry mirrors a row in the api-server `FRED_SERIES_CATALOG`
 * (see `artifacts/api-server/src/lib/intelligence/scope-taxonomy.ts`)
 * via its `materialCode` or `categoryCode`. The chart filters by both
 * `collectorId='fred-economic-index'` and that scope code so it stays
 * a true FRED-only view even though BLS shares `signalType='economic_index'`.
 *
 * The default visible subset is the four most asked-about cost drivers
 * (steel, plastics, lumber, freight) so the chart is legible on first
 * load — operators can toggle on the rest from the chip row.
 */
const DEFAULT_FRED_SERIES = [
  // Materials
  { label: "PPI: Iron and steel", materialCode: "IRON_STEEL" },
  { label: "PPI: Steel mill products", materialCode: "STEEL_MILL_PRODUCTS" },
  { label: "PPI: Nonferrous metals", materialCode: "NONFERROUS_METALS" },
  { label: "PPI: Industrial chemicals", materialCode: "INDUSTRIAL_CHEMICALS" },
  { label: "PPI: Plastic resins", materialCode: "PLASTIC_RESINS" },
  { label: "PPI: Lumber", materialCode: "LUMBER" },
  { label: "PPI: Pulp & paper", materialCode: "PULP_PAPER" },
  { label: "PPI: Crude petroleum", materialCode: "CRUDE_PETROLEUM" },
  {
    label: "PPI: Natural gas (industrial)",
    materialCode: "NATURAL_GAS_INDUSTRIAL",
  },
  { label: "PPI: Fuels & power", materialCode: "FUELS_AND_POWER" },
  // Freight & logistics categories
  { label: "PPI: Truckload freight", categoryCode: "FREIGHT_TRUCKING_TL" },
  { label: "PPI: LTL freight", categoryCode: "FREIGHT_TRUCKING_LTL" },
  { label: "PPI: Rail freight", categoryCode: "RAIL_FREIGHT" },
  { label: "PPI: Warehousing & storage", categoryCode: "WAREHOUSING_STORAGE" },
  { label: "PPI: Freight brokerage", categoryCode: "FREIGHT_BROKERAGE" },
] as const satisfies readonly FredTrendSeries[];

export interface FredTrendSeries {
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
const FIVE_YEARS_MS = 5 * 365 * ONE_DAY_MS;

type ChartPoint = { observedAtMs: number } & Record<string, number>;

export interface FredTrendChartProps {
  series?: readonly FredTrendSeries[];
  title?: string;
  description?: string;
  emptyStateHint?: string;
}

/**
 * Multi-series line chart for FRED Producer Price Index sub-series.
 *
 * Mirrors the BLS trend chart UX (toggle chips, indexed vs absolute,
 * window-delta callouts) but pulls only FRED rows by adding the
 * `collectorId='fred-economic-index'` filter. That distinction matters
 * because both BLS and FRED emit `signalType='economic_index'` — without
 * the collector filter, the same `scopeMaterialCode` (e.g. STEEL) could
 * show data from both sources interleaved.
 *
 * Defaults to indexed mode (each series rebased to 100 at the start of
 * the visible window) so series with very different absolute index
 * values can be compared on a single axis.
 */
export function FredTrendChart({
  series = DEFAULT_FRED_SERIES,
  title = "FRED PPI category trends",
  description = "Producer Price Index sub-series (metals, chemicals, plastics, lumber, energy, freight, warehousing) from the St. Louis Fed FRED API. Use these to spot category-level cost momentum and inflection points on contracts and supplier scorecards.",
  emptyStateHint,
}: FredTrendChartProps) {
  const [activeKeys, setActiveKeys] = useState<Set<string>>(
    () => new Set(series.slice(0, 4).map((s) => s.label)),
  );
  const [mode, setMode] = useState<ChartMode>("indexed");

  // FRED PPI sub-series are released monthly. Five years matches the
  // backfill window the FRED collector seeds, so the chart can show
  // every backfilled point without truncating the start of the window.
  const observedAfter = useMemo(
    () => new Date(Date.now() - FIVE_YEARS_MS).toISOString(),
    [],
  );

  // One query per series. 600 rows comfortably covers five years of
  // monthly observations (~60 points) with headroom for any extra
  // weekly/daily series we may add later.
  const queries = useQueries({
    queries: series.map((s) =>
      getListMarketSignalsQueryOptions<MarketSignal[], Error>({
        signalType: "economic_index",
        collectorId: FRED_COLLECTOR_ID,
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

  // Window-delta callout inputs use raw values (not indexed) so the %
  // matches the underlying index move regardless of display mode.
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
    if (visible.length === 0) return "5y";
    const earliest = Math.min(...visible);
    const days = Math.round((Date.now() - earliest) / ONE_DAY_MS);
    if (days >= 365) return `${(days / 365).toFixed(1)}y`;
    return `${days}d`;
  }, [deltas]);

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
    <Card data-testid="fred-trend-chart">
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
          <div
            className="inline-flex rounded-md border p-0.5 shrink-0"
            role="group"
          >
            <Button
              type="button"
              size="sm"
              variant={mode === "indexed" ? "default" : "ghost"}
              onClick={() => setMode("indexed")}
              data-testid="fred-mode-indexed"
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
              data-testid="fred-mode-absolute"
              className="h-7 text-xs"
              title="Show raw FRED PPI index values (1982=100 for most WPU sub-series)."
            >
              Absolute
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" data-testid="fred-series-toggles">
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
                data-testid={`fred-series-toggle-${s.label}`}
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
            Loading FRED history…
          </div>
        ) : totalPoints === 0 ? (
          <div
            data-testid="fred-trend-empty-state"
            className="flex flex-col items-center justify-center gap-3 py-12 text-center border border-dashed rounded-md"
          >
            <History className="w-8 h-8 text-muted-foreground" />
            <div className="space-y-1 max-w-md">
              <p className="text-sm font-medium">No FRED history yet</p>
              <p className="text-xs text-muted-foreground">
                {emptyStateHint ??
                  'Click "Backfill history" on the FRED Economic Index collector above to seed five years of monthly PPI observations.'}
              </p>
            </div>
          </div>
        ) : (
          <>
            <SeriesDeltaCallouts
              series={deltas}
              windowLabel={windowLabel}
              data-testid="fred-trend-deltas"
            />
            <div className="h-80 w-full" data-testid="fred-trend-chart-canvas">
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
