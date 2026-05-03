import { Link } from "wouter";
import {
  useGetTodayFeed,
  useAckTodayAnnotation,
  getGetTodayFeedQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  Sparkles,
  CheckSquare,
  Activity,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Minus,
  Check,
} from "lucide-react";
import { scrubError } from "@/lib/scrub-error";
import { useMyRole } from "@/lib/use-my-role";
import { formatUsd } from "@/lib/format";

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

      <TodayTriageRow data={data} isAdmin={isOrgAdmin} />

      <TodayDeltasCard data={data} isAdmin={isOrgAdmin} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Reusable widgets — exported so the unified Dashboard at `/` (#269)
// can compose the same triage cards and "what changed" deltas section
// alongside the KPI strip and pipeline funnel without duplicating the
// fail-soft rendering logic.
// ────────────────────────────────────────────────────────────────────

interface TodayFeedShape {
  items: Array<{
    kind: string;
    payload: Record<string, unknown>;
    severity: "info" | "warn" | "error";
  }>;
  errors: Array<{ source: string; error: string }>;
  partial: boolean;
}

export function TodayTriageRow({
  data,
  isAdmin,
}: {
  data: TodayFeedShape;
  isAdmin: boolean;
}) {
  const itemBy = (kind: string) => data.items.find((i) => i.kind === kind);
  const errFor = (source: string) =>
    data.errors.find((e) => e.source === source)?.error;
  return (
    <div
      className="grid grid-cols-1 md:grid-cols-3 gap-4"
      data-testid="today-triage-row"
    >
      {/* #269 follow-up: "Proposed opportunities" card removed.
          It counted the same status='proposed' pool as the
          "Pending approvals" card below, so the operator was
          looking at the same number twice. ApprovalsCard wins
          because it splits the queue into "needs action today"
          (new in 24h OR aged past 7d) vs structural backlog and
          surfaces oldest age — strictly more decision-useful
          than a flat count. The server still emits
          `opportunities.proposed`; we just stop rendering it
          here. */}
      <AlertsCard
        item={itemBy("alerts.summary")}
        error={errFor("getAlertsSummary")}
        isAdmin={isAdmin}
      />
      <ApprovalsCard
        item={itemBy("approvals.pending")}
        error={errFor("approvalsPending")}
        isAdmin={isAdmin}
      />
      <OpsHealthCard
        item={itemBy("jobs.failed")}
        error={errFor("listJobs")}
        isAdmin={isAdmin}
      />
    </div>
  );
}

export function TodayDeltasCard({
  data,
  isAdmin,
}: {
  data: TodayFeedShape;
  isAdmin: boolean;
}) {
  const itemBy = (kind: string) => data.items.find((i) => i.kind === kind);
  const errFor = (source: string) =>
    data.errors.find((e) => e.source === source)?.error;
  return (
    <DeltasCard
      annotations={itemBy("funnel.auto_annotations")}
      conversionDeltas={itemBy("funnel.conversion_deltas")}
      annotationsError={errFor("funnelAutoAnnotations")}
      conversionError={errFor("funnelConversionDeltas")}
      isAdmin={isAdmin}
    />
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
      subtitle="Outside-world events the engine caught — renewals, supplier risk, market moves."
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
            {openCH > 0 ? (
              <>
                critical / high open
                {openTotal > openCH ? (
                  <> · {openTotal} open total</>
                ) : null}
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
              </>
            ) : (
              <>
                No critical or high alerts open
                {openTotal > 0 ? (
                  <> · {openTotal} lower-severity open</>
                ) : null}
              </>
            )}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No alerts data.</p>
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
  // actionable number — opportunities that are EITHER fresh (created
  // in the last 24h) OR aging past the soft deadline (still pending
  // and >7 days old). The structural backlog total appears as muted
  // secondary context. When the enrichment is missing (older server,
  // partial deploy), fall back to the pre-#209 total-only rendering —
  // never two numbers competing for attention.
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
              Need action today (new in last 24h or aged past 7 days)
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
  // #211 — significance gate. Optional on the wire so an older server
  // (pre-#211) gracefully falls back to "meaningful" rendering and
  // we don't gray out rows just because the field is missing.
  significance?: "meaningful" | "noisy" | "insufficient";
  currentDenominator?: number;
  prevDenominator?: number;
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

  // #269 follow-up — Filter out non-signal rows.
  // The card was reading as "100.0% → 100.0% — 0.0 pp" repeated four
  // times because it dumped every transition the server emitted,
  // including dead-flat ones and ones the server already flagged as
  // `noisy` or `insufficient`. Operators called this out as having
  // no value. We now keep only meaningful, non-flat shifts (>= 0.1
  // pp absolute) and fall through to a "nothing material shifted"
  // empty state when there's nothing to say.
  const meaningfulTransitions = transitions.filter((t) => {
    const sig = t.significance ?? "meaningful";
    if (sig !== "meaningful") return false;
    if (t.delta === null) return false;
    return Math.abs(t.delta) >= 0.001; // >= 0.1 pp
  });

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
                <AnnotationRow key={a.id} annotation={a} />
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
          ) : meaningfulTransitions.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="today-deltas-conversion-empty"
            >
              Funnel rates are stable — nothing moved more than 0.1 pp
              between the last two cycles.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {meaningfulTransitions.slice(0, 4).map((t) => (
                <li
                  key={t.transition}
                  className="flex items-center justify-between text-sm"
                  data-testid={`today-deltas-transition-${t.transition}`}
                  data-significance={t.significance ?? "meaningful"}
                >
                  <span className="text-foreground/90">
                    {transitionLabel(t.transition)}
                  </span>
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

/**
 * Single auto-annotation row with an inline "Acknowledge" button (#210).
 *
 * Acking calls the new POST /today/annotations/:id/ack endpoint, which
 * sets `acked_by` / `acked_at` on the underlying funnel_annotations
 * row. The Today reader filters acked rows out by default, so on the
 * next feed refetch the annotation simply disappears from the card and
 * the noise level stays manageable as cycles accumulate.
 *
 * We invalidate the Today feed query rather than mutating the cached
 * payload by hand — the feed is a `partial`/`errors`/`items[]` shape
 * across six sources, and a hand-spliced update would be brittle.
 */
function AnnotationRow({ annotation }: { annotation: AutoAnnotation }) {
  const qc = useQueryClient();
  const ack = useAckTodayAnnotation({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetTodayFeedQueryKey() });
      },
    },
  });
  return (
    <li
      className="flex items-start gap-2 text-sm"
      data-testid={`today-deltas-annotation-${annotation.kind}`}
    >
      {annotation.kind === "stage_drop" ? (
        <TrendingDown className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
      ) : annotation.kind === "stage_spike" ? (
        <TrendingUp className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
      ) : (
        <Sparkles className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        {/* #269 follow-up: translate the engine's raw metric-name
            summary ("opps_persisted dropped 100% (0 vs trailing-5
            mean 29.4)") into one plain-English sentence the
            operator can act on. Raw text is kept as the title
            attribute for ops debugging. */}
        <p className="text-sm leading-snug" title={annotation.summary}>
          {humanizeAnnotation(annotation)}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          cycle #{annotation.cycleGeneration}
          {annotation.targetLeverId ? ` · ${annotation.targetLeverId}` : ""}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground shrink-0"
        disabled={ack.isPending}
        onClick={() => ack.mutate({ id: annotation.id })}
        data-testid={`today-deltas-annotation-ack-${annotation.id}`}
        aria-label="Acknowledge annotation"
      >
        <Check className="w-3 h-3 mr-1" />
        {ack.isPending ? "Acking…" : "Acknowledge"}
      </Button>
    </li>
  );
}

/**
 * #269 follow-up — translate the engine's raw transition keys
 * ("drafts→post_exclusion", "approved_30d→realized_30d") into
 * operator language. Falls back to the raw key if we don't know
 * the transition.
 */
const TRANSITION_LABEL: Record<string, string> = {
  "drafts→post_exclusion": "Drafts kept after exclusion rules",
  "post_exclusion→persisted": "Surfaced as opportunities",
  "persisted→approved_30d": "Approved within 30 days",
  "approved_30d→realized_30d": "Realized within 30 days of approval",
};

function transitionLabel(t: string): string {
  return TRANSITION_LABEL[t] ?? t;
}

/**
 * #269 follow-up — convert an auto-annotation's machine-generated
 * summary into a sentence an operator can act on. The engine emits
 * strings like "opps_persisted dropped 100% (0 vs trailing-5 mean
 * 29.4)" using internal funnel-stage metric names; we translate
 * the metric and direction into plain English.
 */
const METRIC_LABEL: Record<string, string> = {
  opps_persisted: "Opportunities surfaced",
  opps_approved_30d: "Opportunities approved (30d)",
  opps_realized_30d: "Opportunities realized (30d)",
  drafts: "Draft opportunities",
  post_exclusion: "Opportunities after exclusion rules",
};

function humanizeAnnotation(a: AutoAnnotation): string {
  const raw = a.summary ?? "";
  // Match e.g. "opps_persisted dropped 100% (0 vs trailing-5 mean 29.4)"
  const m = raw.match(
    /^(\w+)\s+(dropped|spiked|rose|fell)\s+([\d.]+)%\s*\(([\d.]+)\s+vs\s+trailing-?\d*\s*mean\s+([\d.]+)\)/i,
  );
  if (m) {
    const [, metric, direction, , current, baseline] = m;
    const label = METRIC_LABEL[metric!] ?? metric!.replace(/_/g, " ");
    const dir = /drop|fell/i.test(direction!) ? "dropped to" : "jumped to";
    return `${label} ${dir} ${current} (typical: ${baseline}). Worth a look at the upstream collectors and recent ingest.`;
  }
  // Fallback: prefix with stage when we know it, otherwise return as-is.
  if (a.kind === "stage_drop") return `Funnel drop: ${raw}`;
  if (a.kind === "stage_spike") return `Funnel spike: ${raw}`;
  return raw;
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
  // #269 follow-up: don't put a horizontal-dash icon directly before
  // the prev percentage — it visually fuses with the digit and reads
  // as "−100%". Trend icon moved into the (delta pp) chunk instead.
  const fmt = (r: number | null) =>
    r === null ? "—" : `${(r * 100).toFixed(1)}%`;
  if (delta === null) {
    return (
      <span className="text-xs text-muted-foreground tabular-nums">
        no data yet
      </span>
    );
  }
  const positive = delta > 0;
  const flat = delta === 0;
  const Icon = flat ? Minus : positive ? TrendingUp : TrendingDown;
  const deltaCls = flat
    ? "text-muted-foreground"
    : positive
      ? "text-emerald-700"
      : "text-amber-700";
  const sign = positive ? "+" : "";
  return (
    <span className="inline-flex items-center gap-2 text-xs tabular-nums">
      <span className="text-muted-foreground">
        {fmt(prev)} → {fmt(curr)}
      </span>
      <span className={`inline-flex items-center gap-0.5 ${deltaCls}`}>
        <Icon className="w-3 h-3" />
        {sign}
        {(delta * 100).toFixed(1)} pp
      </span>
    </span>
  );
}

interface TriageCardProps {
  title: string;
  /**
   * #269 follow-up — short "what is this card actually telling me?"
   * subtitle. Optional so older callers stay valid; used to
   * distinguish the four triage cards from each other and from the
   * "Needs your attention" engine-quality list below.
   */
  subtitle?: string;
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
  subtitle,
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
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2 gap-2">
        <div className="space-y-1 min-w-0">
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
          {subtitle && (
            <p className="text-[11px] text-muted-foreground leading-snug">
              {subtitle}
            </p>
          )}
        </div>
        <Link
          href={href}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0"
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
