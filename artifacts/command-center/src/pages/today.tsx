import { Link } from "wouter";
import { useGetTodayFeed } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  Sparkles,
  CheckSquare,
  Activity,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";

/**
 * Today — operator landing page (#199 step 4 path b, extended in #204).
 *
 * Renders the fail-soft `/api/today/feed` aggregator into a four-card
 * triage view (alerts, proposed opportunities, pending approvals,
 * recently failed jobs) plus a "What changed since last cycle" deltas
 * card sourced from the funnel substrate (auto-annotations and
 * cycle-over-cycle conversion-rate diffs). Per-source errors surface as
 * muted ribbons inside each card so the operator can see exactly what
 * is or isn't loaded.
 */
export default function Today() {
  const { data, isLoading, isError } = useGetTodayFeed();

  if (isLoading) {
    return (
      <div className="p-8 text-sm text-muted-foreground">Loading today's feed…</div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold mb-2">Today</h1>
        <p className="text-sm text-destructive">
          Could not load today's feed. The aggregator is up but returned an
          unexpected response.
        </p>
      </div>
    );
  }

  const itemBy = (kind: string) =>
    data.items.find((i) => i.kind === kind);

  const alerts = itemBy("alerts.summary");
  const opps = itemBy("opportunities.proposed");
  const jobs = itemBy("jobs.failed");
  const approvals = itemBy("approvals.pending");
  const annotations = itemBy("funnel.auto_annotations");
  const conversionDeltas = itemBy("funnel.conversion_deltas");

  const errFor = (source: string) =>
    data.errors.find((e) => e.source === source)?.error;

  return (
    <div className="p-8 space-y-6" data-testid="today-page">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today</h1>
          <p className="text-sm text-muted-foreground mt-1">
            What needs your attention this morning, plus what changed since
            the last cycle.
          </p>
        </div>
        {data.partial && (
          <Badge variant="outline" data-testid="today-partial-badge">
            Partial — {data.errors.length} source(s) unavailable
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TriageCard
          title="Alerts"
          icon={AlertTriangle}
          severity={alerts?.severity ?? "info"}
          href="/alerts"
          error={errFor("getAlertsSummary")}
          testId="today-card-alerts"
        >
          {alerts ? (
            <>
              <p className="text-3xl font-bold tabular-nums">
                {(alerts.payload as { openCriticalOrHigh?: number })
                  .openCriticalOrHigh ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Open critical / high alerts —{" "}
                {(alerts.payload as { openTotal?: number }).openTotal ?? 0}{" "}
                open total
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No alerts data.</p>
          )}
        </TriageCard>

        <TriageCard
          title="Proposed opportunities"
          icon={Sparkles}
          severity={opps?.severity ?? "info"}
          href="/opportunities"
          error={errFor("listOpportunities")}
          testId="today-card-opportunities"
        >
          {opps ? (
            <>
              <p className="text-3xl font-bold tabular-nums">
                {(opps.payload as { count?: number }).count ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Top by projected savings
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No opportunity data.
            </p>
          )}
        </TriageCard>

        <TriageCard
          title="Pending approvals"
          icon={CheckSquare}
          severity={approvals?.severity ?? "info"}
          href="/approvals"
          error={errFor("approvalsPending")}
          testId="today-card-approvals"
        >
          {approvals ? (
            <p className="text-3xl font-bold tabular-nums">
              {(approvals.payload as { pending?: number }).pending ?? 0}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No approvals data.
            </p>
          )}
        </TriageCard>

        <TriageCard
          title="Operations health"
          icon={Activity}
          severity={jobs?.severity ?? "info"}
          href="/operations"
          error={errFor("listJobs")}
          testId="today-card-jobs"
        >
          {jobs ? (
            <>
              <p className="text-3xl font-bold tabular-nums">
                {(jobs.payload as { count?: number }).count ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Failed jobs in the last 24h
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No job data.</p>
          )}
        </TriageCard>
      </div>

      <DeltasCard
        annotations={annotations}
        conversionDeltas={conversionDeltas}
        annotationsError={errFor("funnelAutoAnnotations")}
        conversionError={errFor("funnelConversionDeltas")}
      />
    </div>
  );
}

interface AutoAnnotation {
  id: string;
  snapshotId: string;
  cycleGeneration: number;
  kind: string;
  targetStage: string | null;
  targetLeverId: string | null;
  summary: string;
  createdAt: string;
}

interface ConversionTransition {
  transition: string;
  prevRate: number | null;
  currentRate: number | null;
  delta: number | null;
}

interface ConversionDeltasPayload {
  currentCycleGeneration: number | null;
  prevCycleGeneration: number | null;
  transitions: ConversionTransition[];
}

interface FeedItem {
  payload: Record<string, unknown>;
}

interface DeltasCardProps {
  annotations: FeedItem | undefined;
  conversionDeltas: FeedItem | undefined;
  annotationsError: string | undefined;
  conversionError: string | undefined;
}

/**
 * Substrate-driven "what changed since last cycle" panel (#204). Shows
 * recent auto-annotations from the funnel substrate's delta detector
 * alongside per-transition conversion-rate diffs between the two most
 * recent cycles. Empty states are explicit ("no notable changes",
 * "insufficient history") so the operator can tell silence apart from
 * a broken source — a per-source error ribbon shows when a feed source
 * actually failed.
 */
function DeltasCard({
  annotations,
  conversionDeltas,
  annotationsError,
  conversionError,
}: DeltasCardProps) {
  const annPayload = (annotations?.payload ?? {}) as {
    count?: number;
    recent?: AutoAnnotation[];
  };
  const cvPayload = (conversionDeltas?.payload ?? {
    currentCycleGeneration: null,
    prevCycleGeneration: null,
    transitions: [],
  }) as unknown as ConversionDeltasPayload;

  const recent = annPayload.recent ?? [];
  const transitions = cvPayload.transitions ?? [];

  return (
    <Card data-testid="today-card-deltas">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-muted-foreground" />
          What changed since last cycle
        </CardTitle>
        <Link
          href="/engine"
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          Open Engine <ArrowRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent className="space-y-5">
        <div data-testid="today-deltas-annotations">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Auto-annotations
          </h3>
          {annotationsError ? (
            <p
              data-testid="today-deltas-annotations-error"
              className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1"
            >
              Source unavailable: {annotationsError}
            </p>
          ) : recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No notable stage drops or spikes in recent cycles.
            </p>
          ) : (
            <ul className="space-y-2">
              {recent.slice(0, 5).map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-2 text-sm"
                  data-testid={`today-deltas-annotation-${a.kind}`}
                >
                  {a.kind === "stage_drop" ? (
                    <TrendingDown className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  ) : a.kind === "stage_spike" ? (
                    <TrendingUp className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                  ) : (
                    <Sparkles className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm leading-snug">{a.summary}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      cycle #{a.cycleGeneration}
                      {a.targetLeverId ? ` · ${a.targetLeverId}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div data-testid="today-deltas-conversion">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Conversion-rate deltas
            {cvPayload.currentCycleGeneration != null &&
              cvPayload.prevCycleGeneration != null && (
                <span className="ml-2 text-muted-foreground/70 normal-case font-normal">
                  cycle #{cvPayload.prevCycleGeneration} → #
                  {cvPayload.currentCycleGeneration}
                </span>
              )}
          </h3>
          {conversionError ? (
            <p
              data-testid="today-deltas-conversion-error"
              className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1"
            >
              Source unavailable: {conversionError}
            </p>
          ) : transitions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Need at least two cycles to compute conversion deltas. Check back
              after the next cycle completes.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {transitions.slice(0, 4).map((t) => (
                <li
                  key={t.transition}
                  className="flex items-center justify-between text-sm"
                  data-testid={`today-deltas-transition-${t.transition}`}
                >
                  <span className="text-foreground/90">{t.transition}</span>
                  <DeltaPill
                    prev={t.prevRate}
                    curr={t.currentRate}
                    delta={t.delta}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DeltaPill({
  prev,
  curr,
  delta,
}: {
  prev: number | null;
  curr: number | null;
  delta: number | null;
}) {
  const fmt = (r: number | null) =>
    r === null ? "—" : `${(r * 100).toFixed(1)}%`;
  if (delta === null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
        <Minus className="w-3 h-3" />
        {fmt(prev)} → {fmt(curr)}
      </span>
    );
  }
  const positive = delta > 0;
  const flat = delta === 0;
  const Icon = flat ? Minus : positive ? TrendingUp : TrendingDown;
  const cls = flat
    ? "text-muted-foreground"
    : positive
      ? "text-emerald-700"
      : "text-amber-700";
  const sign = positive ? "+" : "";
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs tabular-nums ${cls}`}
    >
      <Icon className="w-3 h-3" />
      {fmt(prev)} → {fmt(curr)} ({sign}
      {(delta * 100).toFixed(1)} pp)
    </span>
  );
}

interface TriageCardProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  severity: "info" | "warn" | "error";
  href: string;
  error: string | undefined;
  testId: string;
  children: React.ReactNode;
}

function TriageCard({
  title,
  icon: Icon,
  severity,
  href,
  error,
  testId,
  children,
}: TriageCardProps) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Icon
            className={
              severity === "error"
                ? "w-4 h-4 text-destructive"
                : severity === "warn"
                  ? "w-4 h-4 text-amber-600"
                  : "w-4 h-4 text-muted-foreground"
            }
          />
          {title}
        </CardTitle>
        <Link
          href={href}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          Open <ArrowRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {children}
        {error && (
          <p
            data-testid={`${testId}-error`}
            className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1"
          >
            Source unavailable: {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
