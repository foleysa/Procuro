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

/**
 * Public id of the USGS Mineral Resources commodity collector. Mirrors
 * `USGS_MINERAL_COLLECTOR_ID` in
 * `artifacts/api-server/src/lib/intelligence/collectors/usgs-mineral.ts`.
 * Used to scope the chart away from World Bank Pink Sheet rows that
 * also share `signalType='commodity_index'`.
 */
const USGS_COLLECTOR_ID = "usgs-mineral";

/**
 * Curated USGS DS-140 critical-mineral series rendered on the chart.
 *
 * Each `materialCode` mirrors a row in the api-server `USGS_MINERALS`
 * registry. When a new mineral is added on the collector side, extend
 * this list so the matching scope shows up in the toggle row.
 */
const DEFAULT_MINERAL_SERIES = [
  { label: "Lithium", materialCode: "LITHIUM" },
  { label: "Cobalt", materialCode: "COBALT" },
  { label: "Nickel", materialCode: "NICKEL_USGS" },
  { label: "Copper", materialCode: "COPPER_USGS" },
  { label: "Aluminum", materialCode: "ALUMINUM_USGS" },
  { label: "Rare earths", materialCode: "RARE_EARTHS" },
  { label: "Graphite", materialCode: "GRAPHITE" },
] as const satisfies readonly CriticalMineralSeries[];

export interface CriticalMineralSeries {
  label: string;
  materialCode: string;
}

const PAIR_COLORS = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#ca8a04",
  "#7c3aed",
  "#0891b2",
  "#db2777",
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// USGS DS-140 publishes annual unit-value series going back decades.
// Twenty-five years gives operators enough history to spot
// multi-cycle dynamics (e.g. cobalt 2018 spike, lithium 2022 surge)
// while keeping the request payload bounded.
const TWENTY_FIVE_YEARS_MS = 25 * 365 * ONE_DAY_MS;

type ChartPoint = { observedAtMs: number } & Record<string, number>;

export interface CriticalMineralsTrendChartProps {
  series?: readonly CriticalMineralSeries[];
  title?: string;
  description?: string;
  emptyStateHint?: string;
}

/**
 * Multi-series line chart for USGS DS-140 critical-mineral unit-value
 * series.
 *
 * Mirrors the FRED/BLS trend-chart UX (toggle chips, indexed vs
 * absolute, window-delta callouts) but pulls only USGS rows by adding
 * the `collectorId='usgs-mineral'` filter. That distinction matters
 * because both World Bank Pink Sheet and USGS emit
 * `signalType='commodity_index'` — without the collector filter, the
 * same `scopeMaterialCode` (e.g. NICKEL) could show data from both
 * sources interleaved.
 *
 * Defaults to indexed mode (each series rebased to 100 at the start of
 * the visible window) so minerals with very different unit-value
 * magnitudes (lithium $/t vs rare-earth $/kg) can be compared on a
 * single axis.
 */
export function CriticalMineralsTrendChart({
  series = DEFAULT_MINERAL_SERIES,
  title = "Critical-mineral price trends (USGS)",
  description = "Annual unit-value (price) series for lithium, cobalt, nickel, copper, aluminum, rare earths, and graphite from USGS DS-140 historical statistics. Use these to spot multi-year cost drift on critical-mineral-intensive categories.",
  emptyStateHint,
}: CriticalMineralsTrendChartProps) {
  const [activeKeys, setActiveKeys] = useState<Set<string>>(
    () => new Set(series.map((s) => s.label)),
  );
  const [mode, setMode] = useState<ChartMode>("indexed");

  const observedAfter = useMemo(
    () => new Date(Date.now() - TWENTY_FIVE_YEARS_MS).toISOString(),
    [],
  );

  // One query per mineral. 200 rows comfortably covers 25 years of
  // annual observations with headroom in case USGS republishes
  // pre-1900 history for any commodity.
  const queries = useQueries({
    queries: series.map((s) =>
      getListMarketSignalsQueryOptions<MarketSignal[], Error>({
        signalType: "commodity_index",
        collectorId: USGS_COLLECTOR_ID,
        scopeMaterialCode: s.materialCode,
        observedAfter,
        order: "asc",
        limit: 200,
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

  // Window-delta callouts use raw values so % moves match the
  // underlying unit-value swing regardless of display mode.
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
    if (visible.length === 0) return "25y";
    const earliest = Math.min(...visible);
    const days = Math.round((Date.now() - earliest) / ONE_DAY_MS);
    if (days >= 365) return `${(days / 365).toFixed(1)}y`;
    return `${days}d`;
  }, [deltas]);

  // Surface which curated minerals have zero observations so operators
  // know the empty-state copy refers to the *whole* pane only when
  // *every* mineral is empty. When some minerals have data and others
  // don't, the toggle chips already communicate the gap (disabled +
  // "0" badge).
  const missingMinerals = useMemo(
    () =>
      series
        .map((s, i) => ({ s, count: queries[i]?.data?.length ?? 0 }))
        .filter((x) => x.count === 0)
        .map((x) => x.s.label),
    [series, queries],
  );

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
    <Card data-testid="critical-minerals-trend-chart">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <LineChartIcon className="w-5 h-5 text-primary" />
              {title}
            </CardTitle>
            {description && (
              <p className="text-sm text-muted-foreground mt-1">
                {description}
              </p>
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
              data-testid="critical-minerals-mode-indexed"
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
              data-testid="critical-minerals-mode-absolute"
              className="h-7 text-xs"
              title="Show raw USGS DS-140 unit-value (price) observations in their native units."
            >
              Absolute
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className="flex flex-wrap gap-2"
          data-testid="critical-minerals-series-toggles"
        >
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
                data-testid={`critical-minerals-series-toggle-${s.materialCode}`}
                className="h-7 text-xs gap-2"
                disabled={pointCount === 0}
                title={
                  pointCount === 0
                    ? `No USGS observations for ${s.label} yet`
                    : `${pointCount.toLocaleString()} annual observations`
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
            Loading USGS history…
          </div>
        ) : totalPoints === 0 ? (
          <div
            data-testid="critical-minerals-trend-empty-state"
            className="flex flex-col items-center justify-center gap-3 py-12 text-center border border-dashed rounded-md"
          >
            <History className="w-8 h-8 text-muted-foreground" />
            <div className="space-y-1 max-w-md">
              <p className="text-sm font-medium">
                No USGS critical-mineral observations yet
              </p>
              <p className="text-xs text-muted-foreground">
                {emptyStateHint ??
                  'Run the USGS Mineral Resources collector from the Collector Workbench (or click "Backfill history" on its row) to seed annual unit-value observations for lithium, cobalt, nickel, copper, aluminum, rare earths, and graphite.'}
              </p>
            </div>
          </div>
        ) : (
          <>
            <SeriesDeltaCallouts
              series={deltas}
              windowLabel={windowLabel}
              data-testid="critical-minerals-trend-deltas"
            />
            {missingMinerals.length > 0 && (
              <p
                className="text-xs text-muted-foreground"
                data-testid="critical-minerals-missing-note"
              >
                No recent observation for{" "}
                <span className="font-medium">
                  {missingMinerals.join(", ")}
                </span>
                . Re-run the USGS Mineral Resources collector to refresh.
              </p>
            )}
            <div
              className="h-80 w-full"
              data-testid="critical-minerals-trend-chart-canvas"
            >
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
                        year: "numeric",
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
