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
import { scrubError } from "@/lib/scrub-error";
import { useMyRole } from "@/lib/use-my-role";
import { leverLabel, formatUsd } from "@/lib/format";

/**
 * Today — operator landing page (#199 step 4 path b, extended in #204,
 * enriched in #209).
 *
 * Renders the fail-soft `/api/today/feed` aggregator into a four-card
 * triage view (alerts, proposed opportunities, pending approvals,
 * recently failed jobs) plus a "What changed since last cycle" deltas
 * card sourced from the funnel substrate (auto-annotations and
 * cycle-over-cycle conversion-rate diffs).
 *
 * #209 contracts (these are TESTS, not just style):
 *
 *  - **No raw SQL on the screen.** Every per-source error string is
 *    routed through `scrubError()` before it hits the DOM. The original
 *    unscrubbed text is shown ONLY inside a role-gated `<details>`
 *    disclosure visible to org_admin / platform_admin.
 *  - **Empty and failure are mutually exclusive.** A card that has a
 *    per-source error renders the failure ribbon and SUPPRESSES the
 *    empty state ("No alerts data."), and vice versa. Same card never
 *    shows both.
 *  - **Capability-gated context lines (RT-92, RT-100).** Each card
 *    renders an extra context line under its big number ONLY when the
 *    payload includes the new #209 fields. Missing/undefined/null
 *    falls back to the original number-only rendering — so the page
 *    works whether #209 has shipped or not.
 */
export default function Today() {
  const { data, isLoading, isError } = useGetTodayFeed();
  const { isOrgAdmin } = useMyRole();

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
        <AlertsCard
          item={alerts}
          error={errFor("getAlertsSummary")}
          isAdmin={isOrgAdmin}
        />
        <OpportunitiesCard
          item={opps}
          error={errFor("listOpportunities")}
          isAdmin={isOrgAdmin}
        />
        <ApprovalsCard
          item={approvals}
          error={errFor("approvalsPending")}
          isAdmin={isOrgAdmin}
        />
        <OpsHealthCard
          item={jobs}
          error={errFor("listJobs")}
          isAdmin={isOrgAdmin}
        />
      </div>

      <DeltasCard
        annotations={annotations}
        conversionDeltas={conversionDeltas}
        annotationsError={errFor("funnelAutoAnnotations")}
        conversionError={errFor("funnelConversionDeltas")}
        isAdmin={isOrgAdmin}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Per-card components. Each capability-gates its enriched context line
// against the actual payload it received — missing #209 fields fall
// back to the pre-#209 number-only rendering.
// ────────────────────────────────────────────────────────────────────

interface FeedItem {
  payload: Record<string, unknown>;
  severity: "info" | "warn" | "error";
}

interface CardCommon {
  item: FeedItem | undefined;
  error: string | undefined;
  isAdmin: boolean;
}

interface TopAlertPayload {
  id: string;
  title: string;
  severity: string;
  ageMs: number;
}

function AlertsCard({ item, error, isAdmin }: CardCommon) {
  const payload = (item?.payload ?? {}) as {
    openTotal?: number;
    openCriticalOrHigh?: number;
    topAlert?: TopAlertPayload;
  };
  const openCH = payload.openCriticalOrHigh ?? 0;
  const openTotal = payload.openTotal ?? 0;
  // Deep-link: pre-filter the alerts page to `state:open`. The card
  // counts open critical OR high, which the documented `?filter`
  // convention would express as two repeated `severity` keys — but
  // the alerts page's severity filter is a single-select today, so a
  // multi-value link would silently collapse to one severity and
  // mis-represent the slice. Until the alerts page grows a
  // multi-select severity (reserved for #204), the deep-link
  // intentionally lands on `state:open` only and lets the operator
  // pick a severity if they want to narrow further. Documented in
  // `docs/command-center-ia.md`.
  const href = "/alerts?filter=state:open";
  return (
    <TriageCard
      title="Alerts"
      icon={AlertTriangle}
      severity={item?.severity ?? "info"}
      href={href}
      error={error}
      isAdmin={isAdmin}
      testId="today-card-alerts"
    >
      {error ? null : item ? (
        <>
          <p className="text-3xl font-bold tabular-nums">{openCH}</p>
          <p
            className="text-xs text-muted-foreground mt-1"
            data-testid="today-card-alerts-context"
          >
            Open critical / high — {openTotal} open total
            {payload.topAlert ? (
              <>
                {" · top: "}
                <span className="font-medium text-foreground/80">
                  &ldquo;{payload.topAlert.title}&rdquo;
                </span>
                {" · "}
                {formatAge(payload.topAlert.ageMs)} ago
              </>
            ) : null}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No alerts data.</p>
      )}
    </TriageCard>
  );
}

interface TopOpportunityPayload {
  id: string;
  title: string;
  leverId: string;
  projectedSavingsUsd: number;
}

function OpportunitiesCard({ item, error, isAdmin }: CardCommon) {
  const payload = (item?.payload ?? {}) as {
    count?: number;
    topOpportunity?: TopOpportunityPayload;
  };
  const href = "/opportunities?filter=status:proposed";
  return (
    <TriageCard
      title="Proposed opportunities"
      icon={Sparkles}
      severity={item?.severity ?? "info"}
      href={href}
      error={error}
      isAdmin={isAdmin}
      testId="today-card-opportunities"
    >
      {error ? null : item ? (
        <>
          <p className="text-3xl font-bold tabular-nums">
            {payload.count ?? 0}
          </p>
          <p
            className="text-xs text-muted-foreground mt-1"
            data-testid="today-card-opportunities-context"
          >
            {payload.topOpportunity ? (
              <>
                top: {leverLabel(payload.topOpportunity.leverId)}
                {" · "}
                {formatUsd(payload.topOpportunity.projectedSavingsUsd, {
                  compact: true,
                })}{" "}
                projected
              </>
            ) : (
              "Top by projected savings"
            )}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No opportunity data.
        </p>
      )}
    </TriageCard>
  );
}

function ApprovalsCard({ item, error, isAdmin }: CardCommon) {
  const payload = (item?.payload ?? {}) as {
    pending?: number;
    needsActionToday?: number;
    oldestAgeMs?: number;
  };
  const total = payload.pending ?? 0;
  // RT-83: when the enriched split is present, the headline is the
  // actionable number (proposed in last 24h), with the structural
  // backlog total as muted secondary context. When the enrichment is
  // missing (older server, partial deploy), fall back to the pre-#209
  // total-only rendering — never two numbers competing for attention.
  // RT-92/RT-100: gate must treat both `undefined` AND `null` as
  // absent (JSON serialization of an explicit-null field is a real
  // wire shape we have to handle), and only consider numeric values
  // as a valid split.
  const hasSplit = typeof payload.needsActionToday === "number";
  const head = hasSplit ? payload.needsActionToday! : total;
  const href = "/approvals";
  return (
    <TriageCard
      title="Pending approvals"
      icon={CheckSquare}
      severity={item?.severity ?? "info"}
      href={href}
      error={error}
      isAdmin={isAdmin}
      testId="today-card-approvals"
    >
      {error ? null : item ? (
        <>
          <p className="text-3xl font-bold tabular-nums">{head}</p>
          {hasSplit ? (
            <p
              className="text-xs text-muted-foreground mt-1"
              data-testid="today-card-approvals-context"
            >
              Need action today (proposed in last 24h)
              {" · "}
              {total.toLocaleString()} total pending
              {payload.oldestAgeMs !== undefined && total > 0 ? (
                <> · oldest {formatAge(payload.oldestAgeMs)}</>
              ) : null}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No approvals data.
        </p>
      )}
    </TriageCard>
  );
}

interface TopFailedPayload {
  kind: string;
  ageMs: number;
}
interface LastCyclePayload {
  generation: number;
  completedAt: string;
  ageMs: number;
}

function OpsHealthCard({ item, error, isAdmin }: CardCommon) {
  const payload = (item?.payload ?? {}) as {
    count?: number;
    topFailed?: TopFailedPayload;
    lastSuccessfulCycle?: LastCyclePayload;
  };
  const failedCount = payload.count ?? 0;
  const href = "/operations";
  return (
    <TriageCard
      title="Operations health"
      icon={Activity}
      severity={item?.severity ?? "info"}
      href={href}
      error={error}
      isAdmin={isAdmin}
      testId="today-card-jobs"
    >
      {error ? null : item ? (
        <>
          <p className="text-3xl font-bold tabular-nums">{failedCount}</p>
          <p
            className="text-xs text-muted-foreground mt-1"
            data-testid="today-card-jobs-context"
          >
            {failedCount > 0 && payload.topFailed ? (
              <>
                Failed in last 24h · last: {payload.topFailed.kind} ·{" "}
                {formatAge(payload.topFailed.ageMs)} ago
              </>
            ) : failedCount === 0 && payload.lastSuccessfulCycle ? (
              <>
                Failed jobs in the last 24h · last cycle ran{" "}
                {formatAge(payload.lastSuccessfulCycle.ageMs)} ago
              </>
            ) : (
              "Failed jobs in the last 24h"
            )}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No job data.</p>
      )}
    </TriageCard>
  );
}

// ────────────────────────────────────────────────────────────────────
// Deltas card (#204) — unchanged structurally; per-source error strings
// now flow through the scrubber.
// ────────────────────────────────────────────────────────────────────

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

interface DeltasCardProps {
  annotations: FeedItem | undefined;
  conversionDeltas: FeedItem | undefined;
  annotationsError: string | undefined;
  conversionError: string | undefined;
  isAdmin: boolean;
}

function DeltasCard({
  annotations,
  conversionDeltas,
  annotationsError,
  conversionError,
  isAdmin,
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
            <FailureRibbon
              error={annotationsError}
              isAdmin={isAdmin}
              testId="today-deltas-annotations-error"
            />
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
            <FailureRibbon
              error={conversionError}
              isAdmin={isAdmin}
              testId="today-deltas-conversion-error"
            />
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
  isAdmin: boolean;
  testId: string;
  children: React.ReactNode;
}

function TriageCard({
  title,
  icon: Icon,
  severity,
  href,
  error,
  isAdmin,
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
          <FailureRibbon
            error={error}
            isAdmin={isAdmin}
            testId={`${testId}-error`}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The error/failure rendering boundary (#209 step 1, RT-91).
 *
 * Every per-source error string flows through `scrubError()` here, so
 * raw SQL / param markers / file paths / stack frames never reach the
 * DOM. The original unscrubbed string is rendered ONLY inside a
 * `<details>` disclosure visible to org_admin / platform_admin (RT-85,
 * matching the #205 disclosure pattern). Non-admin users see no
 * "What happened?" affordance at all.
 */
function FailureRibbon({
  error,
  isAdmin,
  testId,
  className,
}: {
  error: string;
  isAdmin: boolean;
  testId: string;
  className?: string;
}) {
  const safe = scrubError(error);
  return (
    <div
      data-testid={testId}
      className={
        className ??
        "mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1"
      }
    >
      <p>Couldn&rsquo;t load this right now. {safe}</p>
      {isAdmin ? (
        <details className="mt-1" data-testid={`${testId}-disclosure`}>
          <summary className="cursor-pointer text-amber-800/80 hover:text-amber-900">
            What happened?
          </summary>
          <pre
            className="mt-1 whitespace-pre-wrap break-words text-[11px] text-amber-900/80"
            data-testid={`${testId}-disclosure-body`}
          >
            {error}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Tiny age formatter — keeps the muted secondary line short.
// ────────────────────────────────────────────────────────────────────
function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}
