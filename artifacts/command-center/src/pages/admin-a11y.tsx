import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Activity, Lock, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { useMyRole } from "@/lib/use-my-role";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useQuery } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface TrendPoint {
  runId: string;
  scannedAt: string;
  totalViolations: number;
  criticalCount: number;
  seriousCount: number;
  moderateCount: number;
  minorCount: number;
  newCount: number;
  baselinedCount: number;
  totalNodes: number;
}

interface TrendResponse {
  windowDays: number;
  points: TrendPoint[];
}

interface RunSummary {
  runId: string;
  scannedAt: string;
  routeCount: number;
  totalViolations: number;
  criticalCount: number;
  seriousCount: number;
  moderateCount: number;
  minorCount: number;
  newCount: number;
  baselinedCount: number;
}

interface RunsResponse {
  windowDays: number;
  runs: RunSummary[];
}

interface ByRouteEntry {
  route: string;
  routeName: string;
  points: Array<{
    runId: string;
    scannedAt: string;
    totalViolations: number;
    criticalCount: number;
    seriousCount: number;
    moderateCount: number;
    minorCount: number;
  }>;
}

interface ByRouteResponse {
  windowDays: number;
  routes: ByRouteEntry[];
}

function formatDate(s: string): string {
  const d = new Date(s);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const IMPACT_COLORS: Record<string, string> = {
  critical: "#dc2626",
  serious: "#ea580c",
  moderate: "#d97706",
  minor: "#6b7280",
};

function ViolationSparkline({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">no data</span>
    );
  }

  const maxVal = Math.max(1, ...points.map((p) => p.totalViolations));
  const width = 240;
  const height = 48;
  const padding = 4;
  const chartW = width - padding * 2;
  const chartH = height - padding * 2;

  const xStep = points.length > 1 ? chartW / (points.length - 1) : chartW / 2;

  const pathParts = points.map((p, i) => {
    const x = padding + i * xStep;
    const y = padding + chartH - (p.totalViolations / maxVal) * chartH;
    return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  });

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`Violation trend over ${points.length} scans`}
      className="inline-block"
    >
      <path
        d={pathParts.join(" ")}
        fill="none"
        stroke="hsl(221, 83%, 53%)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map((p, i) => {
        const x = padding + i * xStep;
        const y = padding + chartH - (p.totalViolations / maxVal) * chartH;
        return (
          <circle key={i} cx={x} cy={y} r={2.5} fill="hsl(221, 83%, 53%)">
            <title>
              {formatDate(p.scannedAt)}: {p.totalViolations} violations
            </title>
          </circle>
        );
      })}
    </svg>
  );
}

function SeverityBreakdownBar({ point }: { point: TrendPoint }) {
  const total = point.totalViolations;
  if (total === 0) {
    return <span className="text-xs text-muted-foreground">Clean</span>;
  }

  const segments = [
    { label: "Critical", count: point.criticalCount, color: IMPACT_COLORS.critical },
    { label: "Serious", count: point.seriousCount, color: IMPACT_COLORS.serious },
    { label: "Moderate", count: point.moderateCount, color: IMPACT_COLORS.moderate },
    { label: "Minor", count: point.minorCount, color: IMPACT_COLORS.minor },
  ].filter((s) => s.count > 0);

  return (
    <div className="flex items-center gap-2">
      <div className="flex h-3 w-28 rounded overflow-hidden">
        {segments.map((s) => (
          <div
            key={s.label}
            style={{
              width: `${(s.count / total) * 100}%`,
              backgroundColor: s.color,
            }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      <span className="text-[10px] text-muted-foreground">
        {segments.map((s) => `${s.count} ${s.label.charAt(0)}`).join(" / ")}
      </span>
    </div>
  );
}

function RouteHeatmap({ routes }: { routes: ByRouteEntry[] }) {
  if (routes.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">no data</span>
    );
  }

  const latest = routes
    .map((r) => {
      const last = r.points[r.points.length - 1];
      const prev = r.points.length > 1 ? r.points[r.points.length - 2] : null;
      return {
        route: r.route,
        routeName: r.routeName,
        current: last?.totalViolations ?? 0,
        previous: prev?.totalViolations ?? null,
        critical: last?.criticalCount ?? 0,
        serious: last?.seriousCount ?? 0,
      };
    })
    .sort((a, b) => b.current - a.current);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Route</TableHead>
          <TableHead className="w-28 text-right">Violations</TableHead>
          <TableHead className="w-20 text-right">Crit/Srs</TableHead>
          <TableHead className="w-24 text-center">Trend</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {latest.map((r) => {
          const delta =
            r.previous !== null ? r.current - r.previous : null;
          return (
            <TableRow
              key={r.route}
              className={
                r.critical > 0
                  ? "bg-red-50/40"
                  : r.serious > 0
                    ? "bg-orange-50/30"
                    : undefined
              }
            >
              <TableCell>
                <div className="font-mono text-xs">{r.route}</div>
                <div className="text-[10px] text-muted-foreground">
                  {r.routeName}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {r.current}
              </TableCell>
              <TableCell className="text-right">
                {r.critical > 0 && (
                  <Badge variant="destructive" className="text-[10px] mr-1">
                    {r.critical}C
                  </Badge>
                )}
                {r.serious > 0 && (
                  <Badge
                    variant="outline"
                    className="text-[10px] border-orange-300 text-orange-700"
                  >
                    {r.serious}S
                  </Badge>
                )}
                {r.critical === 0 && r.serious === 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    --
                  </span>
                )}
              </TableCell>
              <TableCell className="text-center">
                {delta === null ? (
                  <Minus className="inline h-3 w-3 text-muted-foreground" />
                ) : delta > 0 ? (
                  <span className="inline-flex items-center gap-0.5 text-red-600 text-xs">
                    <TrendingUp className="h-3 w-3" />+{delta}
                  </span>
                ) : delta < 0 ? (
                  <span className="inline-flex items-center gap-0.5 text-emerald-600 text-xs">
                    <TrendingDown className="h-3 w-3" />
                    {delta}
                  </span>
                ) : (
                  <Minus className="inline h-3 w-3 text-muted-foreground" />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const WINDOW_OPTIONS: Array<{ label: string; days: number }> = [
  { label: "Last 7d", days: 7 },
  { label: "Last 30d", days: 30 },
  { label: "Last 90d", days: 90 },
];

export default function AdminA11yPage() {
  const { isPlatformAdmin, isLoading: roleLoading } = useMyRole();
  const [windowDays, setWindowDays] = useState(30);

  const trendQ = useQuery<TrendResponse>({
    queryKey: ["a11y-trend", windowDays],
    queryFn: async () => {
      const res = await fetch(
        `${BASE}/api/admin/a11y/trend?days=${windowDays}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: isPlatformAdmin,
  });

  const runsQ = useQuery<RunsResponse>({
    queryKey: ["a11y-runs", windowDays],
    queryFn: async () => {
      const res = await fetch(
        `${BASE}/api/admin/a11y/runs?days=${windowDays}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: isPlatformAdmin,
  });

  const byRouteQ = useQuery<ByRouteResponse>({
    queryKey: ["a11y-by-route", windowDays],
    queryFn: async () => {
      const res = await fetch(
        `${BASE}/api/admin/a11y/by-route?days=${windowDays}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: isPlatformAdmin,
  });

  const points = trendQ.data?.points ?? [];
  const latestPoint = points.length > 0 ? points[points.length - 1] : null;
  const previousPoint =
    points.length > 1 ? points[points.length - 2] : null;

  const deltaTotal =
    latestPoint && previousPoint
      ? latestPoint.totalViolations - previousPoint.totalViolations
      : null;

  if (!roleLoading && !isPlatformAdmin) {
    return (
      <div className="p-6 md:p-12">
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Platform admin only</EmptyTitle>
            <EmptyDescription>
              Accessibility trend data is platform-wide and visible only to
              platform admins.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const isLoading = trendQ.isLoading || runsQ.isLoading || byRouteQ.isLoading;
  const error = trendQ.error || runsQ.error || byRouteQ.error;

  return (
    <div className="p-8 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between">
        <div>
          <h1
            data-testid="text-page-title"
            className="text-3xl font-bold flex items-center gap-2"
          >
            <Activity className="w-7 h-7 text-primary" />
            Accessibility trends
          </h1>
          <p className="text-muted-foreground mt-1">
            Track WCAG 2.2 AA violation counts over time across all scanned
            routes. Each data point represents a complete scan run ingested
            from the a11y test suite.
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {WINDOW_OPTIONS.map((opt) => (
            <Button
              key={opt.days}
              size="sm"
              variant={windowDays === opt.days ? "default" : "outline"}
              onClick={() => setWindowDays(opt.days)}
              data-testid={`btn-window-${opt.days}d`}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading...
        </div>
      ) : error ? (
        <div className="text-sm text-destructive py-4">
          Failed to load a11y data:{" "}
          {(error as Error).message ?? "unknown error"}
        </div>
      ) : points.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <div className="text-sm text-muted-foreground text-center">
              No scan data recorded yet. Run the a11y scan and then ingest
              the results:
              <pre className="mt-2 text-xs bg-muted rounded p-3 inline-block text-left">
                npx playwright test --config playwright.a11y.config.ts{"\n"}
                pnpm --filter @workspace/scripts run ingest-a11y
              </pre>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total violations (latest)</CardDescription>
                <CardTitle className="text-2xl">
                  {latestPoint?.totalViolations ?? 0}
                  {deltaTotal !== null && deltaTotal !== 0 && (
                    <span
                      className={`ml-2 text-sm font-normal ${deltaTotal > 0 ? "text-red-600" : "text-emerald-600"}`}
                    >
                      {deltaTotal > 0 ? "+" : ""}
                      {deltaTotal}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Critical + Serious</CardDescription>
                <CardTitle className="text-2xl text-red-700">
                  {(latestPoint?.criticalCount ?? 0) +
                    (latestPoint?.seriousCount ?? 0)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>New (unbaselined)</CardDescription>
                <CardTitle className="text-2xl text-orange-600">
                  {latestPoint?.newCount ?? 0}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Scans in window</CardDescription>
                <CardTitle className="text-2xl">
                  {runsQ.data?.runs.length ?? 0}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Violation count over time</CardTitle>
              <CardDescription>
                Total WCAG 2.2 AA violations per scan run.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ViolationSparkline points={points} />
              {latestPoint && (
                <div className="mt-3">
                  <SeverityBreakdownBar point={latestPoint} />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Scan history</CardTitle>
              <CardDescription>
                Per-run summary with severity breakdown.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Routes</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Critical</TableHead>
                    <TableHead className="text-right">Serious</TableHead>
                    <TableHead className="text-right">Moderate</TableHead>
                    <TableHead className="text-right">Minor</TableHead>
                    <TableHead className="text-right">New</TableHead>
                    <TableHead className="text-right">Baselined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(runsQ.data?.runs ?? []).map((run) => (
                    <TableRow key={run.runId}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {formatDate(run.scannedAt)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {run.routeCount}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold">
                        {run.totalViolations}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {run.criticalCount > 0 ? (
                          <span className="text-red-700 font-semibold">
                            {run.criticalCount}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {run.seriousCount > 0 ? (
                          <span className="text-orange-700 font-semibold">
                            {run.seriousCount}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {run.moderateCount > 0 ? (
                          <span className="text-amber-700">
                            {run.moderateCount}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {run.minorCount}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {run.newCount > 0 ? (
                          <span className="text-orange-600 font-semibold">
                            {run.newCount}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {run.baselinedCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Violations by route</CardTitle>
              <CardDescription>
                Latest violation count per scanned route, sorted by severity.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RouteHeatmap routes={byRouteQ.data?.routes ?? []} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
