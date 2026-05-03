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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, ShieldAlert, ChevronDown, ChevronRight, Lock } from "lucide-react";
import {
  useListDataIntegrityLatest,
  useGetDataIntegrityTrend,
  getListDataIntegrityLatestQueryKey,
  getGetDataIntegrityTrendQueryKey,
  type DataIntegrityResult,
  type DataIntegrityTrendAssertion,
  type DataIntegrityTrendPoint,
} from "@workspace/api-client-react";
import { useMyRole } from "@/lib/use-my-role";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

const FAMILY_LABEL: Record<string, string> = {
  aggregate: "Aggregate reconciliation",
  savings_type: "Savings type integrity",
  stage_history: "Stage history integrity",
  gating: "Gating conditions",
};

function formatTime(s: string | Date | null | undefined): string {
  if (!s) return "—";
  const d = s instanceof Date ? s : new Date(s);
  return d.toLocaleString();
}

function extractDriftUsd(actual: Record<string, unknown>): number | null {
  for (const k of [
    "totalDriftUsd",
    "forbiddenAmount",
    "missingAmount",
  ] as const) {
    const v = actual[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

/**
 * Tiny inline pass/fail strip. Each point is one run; greens stack
 * left-to-right oldest→newest. We render fixed-width tick rectangles
 * rather than a polyline so individual fails are impossible to miss
 * even when the series is long.
 */
function PassFailSparkline({
  points,
}: {
  points: DataIntegrityTrendPoint[];
}) {
  if (points.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">no runs in window</span>
    );
  }
  const width = 120;
  const height = 18;
  const tickWidth = Math.max(1, Math.min(4, width / points.length));
  const gap = Math.max(0, (width - tickWidth * points.length) / points.length);
  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`Pass/fail history for the last ${points.length} runs`}
      className="inline-block align-middle"
    >
      {points.map((p, i) => {
        const x = i * (tickWidth + gap);
        const fill = p.passed ? "#10b981" : "#ef4444"; // emerald-500 / red-500
        return (
          <rect
            key={i}
            x={x}
            y={0}
            width={tickWidth}
            height={height}
            fill={fill}
            rx={0.5}
          >
            <title>
              {`${p.passed ? "PASS" : "FAIL"} — ${formatTime(p.runAt)}`}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

function AssertionRow({
  result,
  trend,
}: {
  result: DataIntegrityResult;
  trend: DataIntegrityTrendAssertion | undefined;
}) {
  const [open, setOpen] = useState(false);
  const isFail = !result.passed;
  const drift = extractDriftUsd(
    result.actual as Record<string, unknown>,
  );
  const trendPoints = trend?.points ?? [];
  const failuresInWindow = trendPoints.filter((p) => !p.passed).length;

  return (
    <>
      <TableRow
        data-testid={`row-integrity-${result.assertionName}`}
        className={isFail ? "bg-red-50/40" : undefined}
      >
        <TableCell>
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label={open ? "Hide details" : "Show details"}
                data-testid={`btn-toggle-${result.assertionName}`}
              >
                {open ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </Button>
            </CollapsibleTrigger>
          </Collapsible>
        </TableCell>
        <TableCell>
          {isFail ? (
            <Badge
              variant="destructive"
              data-testid={`badge-status-${result.assertionName}`}
            >
              FAIL
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="border-emerald-300 text-emerald-700"
              data-testid={`badge-status-${result.assertionName}`}
            >
              PASS
            </Badge>
          )}
        </TableCell>
        <TableCell>
          <div className="font-mono text-xs">{result.assertionName}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {result.message}
          </div>
        </TableCell>
        <TableCell>
          <Badge variant="outline" className="text-[10px]">
            {FAMILY_LABEL[result.family] ?? result.family}
          </Badge>
        </TableCell>
        <TableCell>
          <div className="flex flex-col gap-0.5">
            <PassFailSparkline points={trendPoints} />
            <span className="text-[10px] text-muted-foreground">
              {trendPoints.length} runs
              {failuresInWindow > 0
                ? ` · ${failuresInWindow} fail${failuresInWindow === 1 ? "" : "s"}`
                : ""}
            </span>
          </div>
        </TableCell>
        <TableCell className="text-xs whitespace-nowrap">
          {formatTime(result.runAt)}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow
          data-testid={`row-integrity-detail-${result.assertionName}`}
          className={isFail ? "bg-red-50/40" : "bg-muted/30"}
        >
          <TableCell colSpan={6}>
            <div className="grid gap-3 md:grid-cols-2 p-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Expected
                </div>
                <div className="text-xs">{result.expected}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Actual
                </div>
                <pre className="text-[11px] bg-background border rounded p-2 overflow-x-auto max-h-64">
                  {JSON.stringify(result.actual, null, 2)}
                </pre>
              </div>
              {drift !== null && drift > 0 && (
                <div className="md:col-span-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                    Offending dollar amount
                  </div>
                  <div
                    className="text-base font-semibold text-red-700"
                    data-testid={`text-drift-${result.assertionName}`}
                  >
                    ${drift.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}
                  </div>
                </div>
              )}
              <div className="md:col-span-2 text-[10px] text-muted-foreground">
                Triggered by:{" "}
                <code className="font-mono">{result.triggeredBy}</code>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

const WINDOW_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: "Last 24h", hours: 24 },
  { label: "Last 7d", hours: 24 * 7 },
];

export default function AdminDataIntegrityPage() {
  const { isPlatformAdmin, isLoading: roleLoading } = useMyRole();
  const [windowHours, setWindowHours] = useState<number>(24);
  // Only fetch when the caller is a platform_admin — the API gates
  // access to that role and we want to avoid spamming the network
  // with a guaranteed 403 for org admins who navigate here directly.
  const latestQ = useListDataIntegrityLatest({
    query: {
      queryKey: getListDataIntegrityLatestQueryKey(),
      enabled: isPlatformAdmin,
    },
  });
  const trendQ = useGetDataIntegrityTrend(
    { hours: windowHours },
    {
      query: {
        queryKey: getGetDataIntegrityTrendQueryKey({ hours: windowHours }),
        enabled: isPlatformAdmin,
      },
    },
  );

  const trendByName = useMemo(() => {
    const m = new Map<string, DataIntegrityTrendAssertion>();
    for (const a of trendQ.data?.assertions ?? []) m.set(a.assertionName, a);
    return m;
  }, [trendQ.data]);

  const sorted = useMemo(() => {
    const rows = latestQ.data ?? [];
    // Failures first; within each group, ordered by family then name so
    // related assertions cluster together.
    return [...rows].sort((a, b) => {
      if (a.passed !== b.passed) return a.passed ? 1 : -1;
      if (a.family !== b.family) return a.family.localeCompare(b.family);
      return a.assertionName.localeCompare(b.assertionName);
    });
  }, [latestQ.data]);

  const failingCount = sorted.filter((r) => !r.passed).length;

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
              Data integrity check results are platform-wide audit data
              and visible only to platform admins. Reach out to a
              platform admin if you need access.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6 max-w-6xl">
      <div>
        <h1
          data-testid="text-page-title"
          className="text-3xl font-bold flex items-center gap-2"
        >
          <ShieldAlert className="w-7 h-7 text-primary" />
          Data integrity checks
        </h1>
        <p className="text-muted-foreground mt-1">
          Eleven reconciliation assertions run every 15 minutes against
          the live database. This page shows the latest result per
          assertion and the recent pass/fail trend so finance and admin
          users can spot repeated failures without reading the raw audit
          table.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              Assertion status
              {failingCount > 0 ? (
                <Badge
                  variant="destructive"
                  data-testid="badge-failing-count"
                >
                  {failingCount} failing
                </Badge>
              ) : (
                latestQ.data && (
                  <Badge
                    variant="outline"
                    className="border-emerald-300 text-emerald-700"
                    data-testid="badge-failing-count"
                  >
                    All passing
                  </Badge>
                )
              )}
            </CardTitle>
            <CardDescription>
              Latest run per assertion. Click a row to see the
              structured `actual` vs `expected` payload.
            </CardDescription>
          </div>
          <div className="flex items-center gap-1">
            {WINDOW_OPTIONS.map((opt) => (
              <Button
                key={opt.hours}
                size="sm"
                variant={windowHours === opt.hours ? "default" : "outline"}
                onClick={() => setWindowHours(opt.hours)}
                data-testid={`btn-window-${opt.hours}h`}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {latestQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : latestQ.error ? (
            <div className="text-sm text-destructive py-4">
              Failed to load assertions:{" "}
              {(latestQ.error as Error).message ?? "unknown error"}
            </div>
          ) : sorted.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8">
              No assertion runs recorded yet. The next scheduled tick will
              populate this view (runs every 15 minutes).
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead className="w-20">Status</TableHead>
                  <TableHead>Assertion</TableHead>
                  <TableHead className="w-44">Family</TableHead>
                  <TableHead className="w-44">Trend</TableHead>
                  <TableHead className="w-44">Last run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r) => (
                  <AssertionRow
                    key={r.assertionName}
                    result={r}
                    trend={trendByName.get(r.assertionName)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
