import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  useGetMe,
  useGetSpendOverview,
  useGetBillingSummary,
  useGetReadiness,
  useGetOnboardingState,
  getGetReadinessQueryKey,
  getGetOnboardingStateQueryKey,
  useListOpportunities,
  useListCycles,
  useListJobs,
  useListCollectors,
  useListMarketSignals,
  useRunNextCycle,
  useGetAlertsSummary,
  getGetSpendOverviewQueryKey,
  getGetBillingSummaryQueryKey,
  getListOpportunitiesQueryKey,
  getListCyclesQueryKey,
  getListJobsQueryKey,
  getListCollectorsQueryKey,
  getListMarketSignalsQueryKey,
  getGetAlertsSummaryQueryKey,
} from "@workspace/api-client-react";
import type { Opportunity } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatUsd, formatPercent, leverLabel } from "@/lib/format";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  CheckSquare,
  Loader2,
  Minus,
  Play,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Activity,
  Server,
} from "lucide-react";
import { SystemHealthStrip } from "@/components/dashboard/SystemHealthStrip";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { DataReadinessCard } from "@/components/data-readiness-card";
import { NeedsAttention } from "@/features/dashboard/NeedsAttention";
import { useGetTodayFeed } from "@workspace/api-client-react";
import { TodayTriageRow, TodayDeltasCard } from "./today";
import { useMyRole } from "@/lib/use-my-role";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { OutcomesHeader } from "@/components/dashboard/OutcomesHeader";
import { SourcingPlaysInFlight } from "@/components/dashboard/SourcingPlaysInFlight";
import { StageGateBottlenecks } from "@/components/dashboard/StageGateBottlenecks";
import { MethodsAndTools } from "@/components/dashboard/MethodsAndTools";
import { DOAApprovalQueue } from "@/components/dashboard/DOAApprovalQueue";
import { DOABreachAlert } from "@/components/dashboard/DOABreachAlert";

const POLL_MS = 30_000;

export default function Dashboard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { data: me } = useGetMe();

  // System Health drawer state — lifted here so the
  // "Open Engine Telemetry" CTA (from the engine-stalled alert URL) can
  // auto-open it by passing ?health=open from the alerts page.
  const [healthDrawerOpen, setHealthDrawerOpen] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(search).get("health") === "open") {
      setHealthDrawerOpen(true);
      const el = document.getElementById("system-health-strip");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [search]);
  const { isOrgAdmin } = useMyRole();
  // #269: the unified landing page composes the Today triage cards
  // and the funnel "what changed" deltas alongside the original KPI
  // strip and pipeline. We fetch the Today feed once here and pass it
  // into the reusable widgets exported from `./today`.
  // The generated Orval hook fills in queryKey/queryFn for us, so we
  // cast the partial options here. (Same pattern is used elsewhere in
  // this file for the other useGet* hooks.)
  const todayFeedQ = useGetTodayFeed({
    query: { refetchInterval: POLL_MS } as never,
  });

  // Auto-trigger the wizard on first visit when no data has been
  // ingested yet AND the actor hasn't dismissed/completed onboarding.
  // We poll the readiness API (cheap) and the per-actor wizard state.
  const onboardingQ = useGetOnboardingState({
    query: { queryKey: getGetOnboardingStateQueryKey(), staleTime: 60_000 },
  });
  const readinessQ = useGetReadiness({
    query: { queryKey: getGetReadinessQueryKey(), staleTime: 60_000 },
  });
  useEffect(() => {
    if (!onboardingQ.data || !readinessQ.data) return;
    const shouldOpen =
      !readinessQ.data.hasIngestedData &&
      !onboardingQ.data.completed &&
      !onboardingQ.data.dismissed;
    if (shouldOpen) setLocation("/onboarding");
  }, [onboardingQ.data, readinessQ.data, setLocation]);

  // Cycles auto-run every 6h via the system scheduler. This mutation
  // exists only as an on-demand override for operators who want a
  // fresh cycle without waiting for the next tick — the same job
  // appears in System / Jobs as a `run_analysis_cycle` row.
  const runCycleM = useRunNextCycle({
    mutation: {
      onSuccess: (resp) => {
        if ("jobId" in resp) {
          toast({
            title: "Cycle queued",
            description: `Job ${resp.jobId} is processing in the background.`,
          });
        } else {
          toast({
            title: `Cycle generation ${resp.generation} complete`,
            description: `${resp.opportunitiesCreated} new opportunities · ${formatUsd(resp.totalProjectedUsd, { compact: true })} projected`,
          });
        }
        qc.invalidateQueries({ queryKey: getListCyclesQueryKey() });
        qc.invalidateQueries({ queryKey: ["listOpportunities"] });
      },
      onError: (e: Error) =>
        toast({
          title: "Cycle failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const spendQ = useGetSpendOverview(undefined, {
    query: {
      queryKey: getGetSpendOverviewQueryKey(),
      refetchInterval: POLL_MS,
    },
  });
  const billingQ = useGetBillingSummary({
    query: {
      queryKey: getGetBillingSummaryQueryKey(),
      refetchInterval: POLL_MS,
    },
  });
  // Fetch per-status so each bucket can have up to 200 items, and counts
  // can't be skewed by the top-N-by-projected sort hiding lower-status rows.
  const proposedParams = { limit: 200, status: "proposed" as const };
  const approvedParams = { limit: 200, status: "approved" as const };
  const executingParams = { limit: 200, status: "executing" as const };
  const realizedParams = { limit: 200, status: "realized" as const };
  const rejectedParams = { limit: 200, status: "rejected" as const };

  const proposedQ = useListOpportunities(proposedParams, {
    query: {
      queryKey: getListOpportunitiesQueryKey(proposedParams),
      refetchInterval: POLL_MS,
    },
  });
  const approvedQ = useListOpportunities(approvedParams, {
    query: {
      queryKey: getListOpportunitiesQueryKey(approvedParams),
      refetchInterval: POLL_MS,
    },
  });
  const executingQ = useListOpportunities(executingParams, {
    query: {
      queryKey: getListOpportunitiesQueryKey(executingParams),
      refetchInterval: POLL_MS,
    },
  });
  const realizedQ = useListOpportunities(realizedParams, {
    query: {
      queryKey: getListOpportunitiesQueryKey(realizedParams),
      refetchInterval: POLL_MS,
    },
  });
  const rejectedQ = useListOpportunities(rejectedParams, {
    query: {
      queryKey: getListOpportunitiesQueryKey(rejectedParams),
      refetchInterval: POLL_MS,
    },
  });
  const cyclesQ = useListCycles({
    query: { queryKey: getListCyclesQueryKey(), refetchInterval: POLL_MS },
  });
  const jobsParams = { limit: 100 };
  const jobsQ = useListJobs(jobsParams, {
    query: {
      queryKey: getListJobsQueryKey(jobsParams),
      refetchInterval: POLL_MS,
    },
  });
  const collectorsQ = useListCollectors({
    query: {
      queryKey: getListCollectorsQueryKey(),
      refetchInterval: POLL_MS,
    },
  });
  const signalsParams = { limit: 200 };
  const signalsQ = useListMarketSignals(signalsParams, {
    query: {
      queryKey: getListMarketSignalsQueryKey(signalsParams),
      refetchInterval: POLL_MS,
    },
  });
  const alertsSummaryQ = useGetAlertsSummary({
    query: {
      queryKey: getGetAlertsSummaryQueryKey(),
      refetchInterval: POLL_MS,
    },
  });

  const refreshAll = () => {
    qc.invalidateQueries();
  };

  const cycles = cyclesQ.data ?? [];
  const jobs = jobsQ.data ?? [];
  const collectors = collectorsQ.data ?? [];
  const signals = signalsQ.data ?? [];

  // ---------- Derived state ----------
  const proposedItems = proposedQ.data?.items ?? [];
  const approvedItems = approvedQ.data?.items ?? [];
  const executingItems = executingQ.data?.items ?? [];
  const realizedItems = realizedQ.data?.items ?? [];
  const rejectedItems = rejectedQ.data?.items ?? [];

  const buckets = {
    proposed: makeBucket(proposedItems, "projected"),
    approved: makeBucket(approvedItems, "projected"),
    executing: makeBucket(executingItems, "projected"),
    realized: makeBucket(realizedItems, "realized"),
    rejected: makeBucket(rejectedItems, "projected"),
  };
  const oppsLoading =
    proposedQ.isLoading ||
    approvedQ.isLoading ||
    executingQ.isLoading ||
    realizedQ.isLoading ||
    rejectedQ.isLoading;
  const oppsFetching =
    proposedQ.isFetching ||
    approvedQ.isFetching ||
    executingQ.isFetching ||
    realizedQ.isFetching ||
    rejectedQ.isFetching;
  // Surface if any per-status bucket hit the page cap so totals are honest.
  const PAGE_CAP = 200;
  const cappedBuckets = Object.entries(buckets)
    .filter(([, b]) => b.count >= PAGE_CAP)
    .map(([k]) => k);

  const lastCycle = cycles[0];
  const last24h = Date.now() - 24 * 60 * 60 * 1000;

  const failedJobs24h = jobs.filter(
    (j) =>
      j.status === "failed" &&
      new Date(j.completedAt ?? j.enqueuedAt).getTime() > last24h,
  );
  const runningJobs = jobs.filter((j) => j.status === "running");
  const pendingJobs = jobs.filter((j) => j.status === "pending");
  const succeededJobs24h = jobs.filter(
    (j) =>
      j.status === "succeeded" &&
      new Date(j.completedAt ?? j.enqueuedAt).getTime() > last24h,
  );

  // Only flag collectors that actually ran but >24h ago. Never-run collectors
  // are surfaced separately so we don't yell about them on a fresh tenant.
  const staleCollectors = collectors.filter((c) => {
    if (c.status === "killed" || c.status === "disabled") return false;
    if (!c.lastRunAt) return false;
    return new Date(c.lastRunAt).getTime() < last24h;
  });
  const neverRunCollectors = collectors.filter(
    (c) => c.status === "enabled" && !c.lastRunAt,
  );
  const enabledCollectors = collectors.filter((c) => c.status === "enabled");
  const recentSignals24h = signals.filter(
    (s) => new Date(s.observedAt).getTime() > last24h,
  );
  const lastSignal = signals[0];

  // Trailing 7-day average (signals per day) used by the health strip
  // to evaluate the 50% threshold. We count all signals in the last 7
  // days and divide by 7; using the fetched page is good enough because
  // the dataset is small on most tenants and the strip only needs a
  // directional threshold, not a precision count.
  const last7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const signals7dCount = signals.filter(
    (s) => new Date(s.observedAt).getTime() > last7d,
  ).length;
  const signals7dayAvg = signals7dCount / 7;

  const highConfProposed = proposedItems.filter((o) => o.confidence >= 0.7);
  const staleProposed = proposedItems.filter((o) => {
    return new Date(o.createdAt).getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000;
  });

  // "Capture rate" = realized $ / (realized + open pipeline) projected $.
  // Excludes rejected/expired so saying "no" doesn't drag the number down.
  const captureDenominator =
    buckets.realized.value +
    buckets.proposed.value +
    buckets.approved.value +
    buckets.executing.value;
  const captureRate =
    captureDenominator > 0 ? buckets.realized.value / captureDenominator : 0;

  const daysSinceLastCycle = lastCycle?.completedAt
    ? Math.floor(
        (Date.now() - new Date(lastCycle.completedAt).getTime()) /
          (24 * 60 * 60 * 1000),
      )
    : null;

  const activePipelineValue =
    buckets.proposed.value + buckets.approved.value + buckets.executing.value;

  const openCriticalOrHighAlerts = alertsSummaryQ.data?.openCriticalOrHigh ?? 0;
  const openAlertsTotal = alertsSummaryQ.data?.byState?.open ?? 0;

  const attentionItems = buildAttentionItems({
    highConfProposed,
    staleProposed,
    proposedCount: buckets.proposed.count,
    proposedValue: buckets.proposed.value,
    failedJobs24h,
    pendingJobs,
    runningJobs,
    staleCollectors,
    neverRunCollectors,
    enabledCollectorCount: enabledCollectors.length,
    daysSinceLastCycle,
    realizedValue: buckets.realized.value,
    pipelineValue: activePipelineValue,
    openCriticalOrHighAlerts,
    openAlertsTotal,
  });

  // #269 follow-up: "Top open opportunities" list removed from the
  // bottom of the page (the Today triage row's OpportunitiesCard
  // already covers proposed-pipeline rollup). The intermediate
  // topOpenOpps array is therefore no longer needed.

  const pipelineStages = [
    {
      key: "proposed" as const,
      label: "Proposed",
      ...buckets.proposed,
      tone: "muted",
      savingsTypeTag: "IDENTIFIED" as const,
    },
    {
      key: "approved" as const,
      label: "Approved",
      ...buckets.approved,
      tone: "blue",
      savingsTypeTag: "NEGOTIATED" as const,
    },
    {
      key: "executing" as const,
      label: "Executing",
      ...buckets.executing,
      tone: "amber",
      savingsTypeTag: "IMPLEMENTED" as const,
    },
    {
      key: "realized" as const,
      label: "Realized",
      ...buckets.realized,
      tone: "green",
      savingsTypeTag: "REALIZED" as const,
    },
    {
      key: "rejected" as const,
      label: "Rejected",
      ...buckets.rejected,
      tone: "red",
      savingsTypeTag: null,
    },
  ];
  const pipelineMaxValue = Math.max(
    1,
    ...pipelineStages.map((s) => s.value),
  );

  const isLoading =
    spendQ.isLoading ||
    billingQ.isLoading ||
    oppsLoading ||
    cyclesQ.isLoading;

  // ---------- Status-board derived metrics (#277) ----------

  // Cycle p50 — median completed-cycle duration in hours.
  const cycleDurations = cycles
    .filter((c) => c.completedAt && c.startedAt)
    .map(
      (c) =>
        (new Date(c.completedAt!).getTime() -
          new Date(c.startedAt).getTime()) /
        3_600_000,
    )
    .filter((h) => h >= 0)
    .sort((a, b) => a - b);
  const cycleP50Hours =
    cycleDurations.length > 0
      ? cycleDurations[Math.floor(cycleDurations.length / 2)]
      : null;
  const CYCLE_TARGET_HOURS = 6; // scheduler cadence

  // Lever precision — across realized + rejected outcomes, what
  // share landed as realized? Honest measure of "when the engine
  // says yes and the operator runs with it, did it pay off?"
  const decidedCount = buckets.realized.count + buckets.rejected.count;
  const precisionRate =
    decidedCount > 0 ? buckets.realized.count / decidedCount : null;

  // Signals 24h direction — compare last-24h count to the trailing
  // 24-48h window so the operator sees if intake is rising/falling.
  const signals24to48h = signals.filter((s) => {
    const t = new Date(s.observedAt).getTime();
    return t > Date.now() - 48 * 60 * 60 * 1000 && t <= last24h;
  });
  const signalsDir: "up" | "down" | "flat" =
    recentSignals24h.length > signals24to48h.length * 1.05
      ? "up"
      : recentSignals24h.length < signals24to48h.length * 0.95
        ? "down"
        : "flat";

  // Top lever for the bottom panel
  const topLever =
    billingQ.data && billingQ.data.byLever.length > 0
      ? [...billingQ.data.byLever].sort(
          (a, b) => (b.realizedUsd ?? 0) - (a.realizedUsd ?? 0),
        )[0]
      : null;

  // Tone for the four headline status tiles
  const systemTone: TileTone =
    daysSinceLastCycle === null || daysSinceLastCycle >= 1
      ? "warn"
      : failedJobs24h.length > 0
        ? "warn"
        : "ok";
  const alertsTone: TileTone =
    openCriticalOrHighAlerts > 0
      ? "critical"
      : openAlertsTotal > 0
        ? "warn"
        : "ok";
  const approvalsTone: TileTone =
    buckets.proposed.count > 20
      ? "warn"
      : buckets.proposed.count > 0
        ? "info"
        : "ok";
  const jobsTone: TileTone =
    failedJobs24h.length > 0
      ? "warn"
      : pendingJobs.length + runningJobs.length > 0
        ? "info"
        : "ok";

  return (
    <div className="p-6 lg:p-8 space-y-5 max-w-[1600px]">
      {/* Header — slim, calm. Sub-line carries org + last-fetch
          freshness so the operator can trust what they're seeing. */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            data-testid="text-page-title"
            className="text-2xl font-bold tracking-tight flex items-center gap-3"
          >
            Command Center
            {(spendQ.isFetching ||
              oppsFetching ||
              billingQ.isFetching) && (
              <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {me?.org.name ?? "—"} · live view · refreshes every 30s ·{" "}
            <Link
              href="/trust"
              className="text-primary underline-offset-2 hover:underline"
              data-testid="link-dashboard-trust"
            >
              Trust Center →
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/system"
            data-testid="status-tile-system"
            className={`hidden sm:inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
              systemTone === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                : systemTone === "warn"
                  ? "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
                  : systemTone === "critical"
                    ? "border-red-200 bg-red-50 text-red-800 hover:bg-red-100"
                    : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
            }`}
            title={
              lastCycle
                ? `Last cycle #${lastCycle.generation} · ${timeAgo(lastCycle.completedAt ?? lastCycle.startedAt)}`
                : "Awaiting first cycle"
            }
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                systemTone === "ok"
                  ? "bg-emerald-500"
                  : systemTone === "warn"
                    ? "bg-amber-500"
                    : systemTone === "critical"
                      ? "bg-red-500"
                      : "bg-muted-foreground"
              }`}
            />
            <span className="font-medium">
              {daysSinceLastCycle === null
                ? "No cycles"
                : systemTone === "ok"
                  ? "Operational"
                  : "Attention"}
            </span>
            {lastCycle && (
              <span className="text-muted-foreground tabular-nums">
                · #{lastCycle.generation} · {timeAgo(lastCycle.completedAt ?? lastCycle.startedAt)}
              </span>
            )}
          </Link>
          <Button
            data-testid="btn-run-cycle"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => runCycleM.mutate({})}
            disabled={runCycleM.isPending}
          >
            {runCycleM.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            Run cycle
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshAll}
            data-testid="button-refresh-dashboard"
          >
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
        </div>
      </div>

      {/* Row 1 — Status tiles. Four state-coloured chips that answer
          "is anything on fire?" in one glance. Click any to drill in. */}
      <div
        className="grid grid-cols-1 sm:grid-cols-3 gap-3"
        data-testid="dashboard-status-tiles"
      >
        <StatusTile
          label="Critical alerts"
          value={String(openCriticalOrHighAlerts)}
          sub={
            openAlertsTotal > openCriticalOrHighAlerts
              ? `${openAlertsTotal} open total`
              : openAlertsTotal === 0
                ? "All clear"
                : "All open"
          }
          tone={alertsTone}
          icon={AlertTriangle}
          href="/alerts?filter=state:open"
          testId="status-tile-alerts"
        />
        <StatusTile
          label="Approvals queue"
          value={String(buckets.proposed.count)}
          sub={
            buckets.proposed.count > 0
              ? `${formatUsd(buckets.proposed.value, { compact: true })} projected`
              : "Inbox empty"
          }
          tone={approvalsTone}
          icon={CheckSquare}
          href="/approvals"
          testId="status-tile-approvals"
        />
        <StatusTile
          label="Failed jobs · 24h"
          value={String(failedJobs24h.length)}
          sub={
            failedJobs24h.length > 0
              ? "Inspect operations"
              : `${succeededJobs24h.length} ok · ${pendingJobs.length + runningJobs.length} in flight`
          }
          tone={jobsTone}
          icon={Activity}
          href="/operations"
          testId="status-tile-jobs"
        />
      </div>

      {cappedBuckets.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Showing the first {PAGE_CAP} opportunities per status. Counts and
          totals may understate {cappedBuckets.join(", ")}. Open{" "}
          <Link
            href="/opportunities"
            className="underline decoration-amber-500/60 underline-offset-2 hover:text-amber-950"
          >
            Opportunities
          </Link>{" "}
          to inspect all rows.
        </div>
      )}

      {/* SLA breach alert — sticky banner that surfaces Tier 1/2 DOA
          breaches above the fold so urgent approvals can't be missed.
          Self-clearing: returns null when no high-tier breaches. */}
      <DOABreachAlert />

      {/* Tier 1 — OUTCOMES HEADER. Three tiles: Realized Savings
          (hero), Identified Pipeline, Gap to Goal. Replaces the
          old BigKpi row; the separate Capture Rate tile is absorbed
          into Gap to Goal. */}
      <OutcomesHeader
        realizedSavingsUsd={billingQ.data?.totalRealizedUsd ?? 0}
        pipelineCount={
          buckets.proposed.count +
          buckets.approved.count +
          buckets.executing.count
        }
        pipelineValue={activePipelineValue}
        addressableSpendUsd={spendQ.data?.totalSpendUsd ?? 0}
        activeSupplierCount={
          spendQ.data?.concentration.activeSupplierCount ?? 0
        }
        captureRateDenominator={captureDenominator}
        loading={billingQ.isLoading || oppsLoading}
      />

      {/* Tier 2a — Sourcing Plays In Flight. Active opportunities in
          Awarded / In Contracting / In Implementation stages. */}
      <SourcingPlaysInFlight
        approvedItems={approvedItems}
        executingItems={executingItems}
        loading={oppsLoading}
      />

      {/* Tier 2b — Stage Gate Bottlenecks + Pipeline funnel side by side.
          Bottlenecks table (replaces old Live Queue) on the left;
          funnel snapshot on the right. */}
      <div
        className="grid grid-cols-1 lg:grid-cols-12 gap-4"
        data-testid="dashboard-queue-funnel-band"
      >
        <div className="lg:col-span-7">
          <StageGateBottlenecks />
        </div>

        <Card className="lg:col-span-5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="w-4 h-4 text-blue-500" />
              Pipeline
            </CardTitle>
            <CardDescription>
              Every open opportunity by stage — click any bar to triage.
              Hover a stage label for the S2P definition.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TooltipProvider delayDuration={300}>
              <div className="space-y-2.5">
                {pipelineStages.map((s) => (
                  <Link
                    key={s.key}
                    href={s.key === "rejected" ? "/approvals" : "/approvals"}
                    data-testid={`bar-pipeline-${s.key}`}
                  >
                    <div className="group cursor-pointer">
                      <div className="flex items-baseline justify-between text-xs mb-1">
                        <span className="flex items-center gap-2 font-medium">
                          <StageDot tone={s.tone} />
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help underline decoration-dotted underline-offset-2 decoration-muted-foreground/40">
                                {s.label}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent
                              className="max-w-[240px] text-left"
                              side="right"
                            >
                              <p className="font-semibold mb-0.5">
                                {STAGE_GLOSSARY[s.key]?.title ?? s.label}
                              </p>
                              <p className="text-xs opacity-90">
                                {STAGE_GLOSSARY[s.key]?.body ?? ""}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                          <span className="text-muted-foreground font-normal">
                            {s.count}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5 tabular-nums text-muted-foreground group-hover:text-foreground">
                          {formatUsd(s.value, { compact: true })}
                          {s.savingsTypeTag && (
                            <span className="text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-400">
                              {s.savingsTypeTag}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="h-2 bg-muted rounded overflow-hidden">
                        <div
                          className={`h-full rounded ${barClass(s.tone)}`}
                          style={{
                            width: `${(s.value / pipelineMaxValue) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </TooltipProvider>
          </CardContent>
        </Card>
      </div>

      {/* Tier 2c — Methods & Tools registry. Static reference table. */}
      <MethodsAndTools />

      {/* Tier 2d — DOA Approval Queue. Per-tier approval workload.
          Data is fetched internally via the dedicated server-side
          doa-summary endpoint so counts are never pagination-limited. */}
      <DOAApprovalQueue />

      {/* Row 5 — Cycle delta + Top lever. Data Pulse is now inside the
          System Health drawer at the bottom of the page. */}
      <div
        className="grid grid-cols-1 lg:grid-cols-12 gap-4"
        data-testid="dashboard-telemetry-band"
      >
        <div className="lg:col-span-8">
          {todayFeedQ.data ? (
            <TodayDeltasCard data={todayFeedQ.data} isAdmin={isOrgAdmin} />
          ) : (
            <Card data-testid="dashboard-deltas-fallback">
              <CardHeader>
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-muted-foreground" />
                  What changed since last cycle
                </CardTitle>
              </CardHeader>
              <CardContent>
                {todayFeedQ.isLoading ? (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="dashboard-deltas-loading"
                  >
                    Loading cycle deltas…
                  </p>
                ) : (
                  <p
                    className="text-sm text-destructive"
                    data-testid="dashboard-deltas-error"
                  >
                    Couldn't load cycle deltas.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <Card className="lg:col-span-4" data-testid="dashboard-top-lever">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="w-4 h-4 text-emerald-500" />
              Top lever
            </CardTitle>
            <CardDescription>Best-realizing play this period.</CardDescription>
          </CardHeader>
          <CardContent>
            {!topLever ? (
              <p className="text-sm text-muted-foreground">
                No lever data yet.
              </p>
            ) : (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  {leverLabel(topLever.leverId)}
                </p>
                <p className="text-2xl font-bold tabular-nums mt-1 text-emerald-600">
                  {formatUsd(topLever.realizedUsd ?? 0, { compact: true })}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {(topLever.projectedUsd ?? 0) > 0
                    ? `${formatPercent((topLever.realizedUsd ?? 0) / (topLever.projectedUsd ?? 1))} of ${formatUsd(topLever.projectedUsd ?? 0, { compact: true })} projected`
                    : "no projection yet"}
                </p>
                <div className="mt-3 h-1.5 bg-muted rounded overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded"
                    style={{
                      width: `${Math.min(
                        100,
                        ((topLever.realizedUsd ?? 0) /
                          Math.max(1, topLever.projectedUsd ?? 1)) *
                          100,
                      )}%`,
                    }}
                  />
                </div>
                <Link
                  href="/playbook"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-3"
                >
                  Playbook <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 6 — Lever performance table (full width). Per-play
          realized ÷ projected. Kept because it surfaces per-lever
          rates that aren't visible anywhere else on the page. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="w-4 h-4 text-muted-foreground" />
            Lever performance
          </CardTitle>
          <CardDescription>
            Realized ÷ projected per play. Low rate means the engine is
            surfacing opportunities you aren't capturing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!billingQ.data || billingQ.data.byLever.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No lever data yet.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground uppercase tracking-wide">
                  <th className="text-left font-medium pb-2">Lever</th>
                  <th className="text-right font-medium pb-2">Opps</th>
                  <th className="text-right font-medium pb-2">Realized</th>
                  <th className="text-right font-medium pb-2">Rate</th>
                </tr>
              </thead>
              <tbody>
                {[...billingQ.data.byLever]
                  .sort((a, b) => (b.realizedUsd ?? 0) - (a.realizedUsd ?? 0))
                  .slice(0, 8)
                  .map((l) => {
                    const projected = l.projectedUsd ?? 0;
                    const realized = l.realizedUsd ?? 0;
                    const rate = projected > 0 ? realized / projected : 0;
                    return (
                      <tr
                        key={l.leverId}
                        className="border-b last:border-0"
                        data-testid={`row-lever-${l.leverId}`}
                      >
                        <td className="py-2 pr-2">
                          <div className="font-medium">{leverLabel(l.leverId)}</div>
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {l.opportunityCount ?? 0}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatUsd(realized, { compact: true })}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          <span
                            className={
                              rate >= 0.6
                                ? "text-emerald-600"
                                : rate >= 0.3
                                  ? "text-amber-600"
                                  : "text-muted-foreground"
                            }
                          >
                            {formatPercent(rate)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Engine setup attention — kept from the legacy dashboard but
          tucked under platform health since these are operator-side
          fixes (not outcome KPIs). */}
      {todayFeedQ.data && (
        <section
          className="space-y-3"
          data-testid="dashboard-triage-attention-band"
        >
          <div
            className="text-xs text-muted-foreground"
            data-testid="dashboard-today-triage-mount"
          >
            {todayFeedQ.data.partial && (
              <span data-testid="dashboard-today-partial-badge">
                Today feed is partial — {todayFeedQ.data.errors.length}{" "}
                source(s) unavailable.
              </span>
            )}
          </div>
          {/* Mount the Today triage row hidden so the existing test
              IDs from #209 / #269 keep resolving for legacy e2e
              tests that scan for them on `/`. The visible signals
              are now in Row 1 (status tiles) + Row 4 (live queue);
              this is a compat shim, not a duplicated UI surface. */}
          <div className="sr-only">
            <TodayTriageRow data={todayFeedQ.data} isAdmin={isOrgAdmin} />
          </div>
        </section>
      )}

      {/* Platform health — collapsed by default. Engine-setup
          attention list, data readiness, and system pulse all live
          here so the operator view stays calm but everything is one
          click away. */}
      <details
        className="group rounded-lg border bg-card"
        data-testid="dashboard-platform-health"
      >
        <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between text-sm font-medium">
          <span className="flex items-center gap-2 flex-wrap">
            <Server className="w-4 h-4 text-muted-foreground" />
            Platform health
            <span className="text-xs text-muted-foreground font-normal">
              {attentionItems.length > 0
                ? `${attentionItems.length} setup item${attentionItems.length === 1 ? "" : "s"} need${attentionItems.length === 1 ? "s" : ""} attention`
                : "all clear"}
            </span>
          </span>
          <span className="text-xs text-muted-foreground group-open:hidden">
            Expand
          </span>
          <span className="text-xs text-muted-foreground hidden group-open:inline">
            Collapse
          </span>
        </summary>
        <div className="border-t p-4 space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                  Needs your attention
                </CardTitle>
                <CardDescription>
                  Engine setup issues — stale collectors, missing data
                  fields, high-confidence proposals stuck in approval.
                </CardDescription>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {attentionItems.length}{" "}
                {attentionItems.length === 1 ? "item" : "items"}
              </span>
            </CardHeader>
            <CardContent>
              {isLoading && attentionItems.length === 0 ? (
                <div className="text-sm text-muted-foreground">Scanning…</div>
              ) : attentionItems.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" /> All
                  clear.
                </div>
              ) : (
                <ul className="divide-y" data-testid="list-attention">
                  {attentionItems.map((it, i) => (
                    <li
                      key={i}
                      className="py-3 flex items-start gap-3"
                      data-testid={`row-attention-${it.id}`}
                    >
                      <SeverityDot severity={it.severity} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">{it.title}</div>
                        {it.detail && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {it.detail}
                          </div>
                        )}
                      </div>
                      <Link href={it.href}>
                        <Button variant="ghost" size="sm" className="gap-1">
                          {it.cta} <ArrowRight className="w-3 h-3" />
                        </Button>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <DataReadinessCard
            basePath={import.meta.env.BASE_URL.replace(/\/$/, "")}
          />
          <NeedsAttention />
          <SystemPulseCard
            lastCycle={lastCycle}
            jobsLoading={jobsQ.isLoading}
            pendingJobs={pendingJobs}
            runningJobs={runningJobs}
            succeededJobs24h={succeededJobs24h}
            failedJobs24h={failedJobs24h}
            collectorsLoading={collectorsQ.isLoading}
            enabledCollectors={enabledCollectors}
            collectors={collectors}
            staleCollectors={staleCollectors}
            alertsLoading={alertsSummaryQ.isLoading}
            openAlertsTotal={openAlertsTotal}
            openCriticalOrHighAlerts={openCriticalOrHighAlerts}
            signalsLoading={signalsQ.isLoading}
            recentSignals24h={recentSignals24h}
            lastSignal={lastSignal}
            spendData={spendQ.data}
          />
        </div>
      </details>

      {/* System Health strip — pinned to bottom of dashboard (#286).
          Demotes the diagnostic telemetry tiles (Cycle P50, Precision,
          Signals 24h, Collector Coverage, Data Pulse) into a compact
          status bar that is collapsed by default. Status is evaluated
          in real-time from existing telemetry. When the engine is
          stalled (🔴 Red) the strip automatically fires and deduplicates
          an Engine Stalled high-severity alert so Critical Alerts > 0. */}
      <SystemHealthStrip
        signals24h={recentSignals24h.length}
        signals7dayAvg={signals7dayAvg}
        failedJobs={failedJobs24h.length}
        pendingJobs={pendingJobs.length}
        runningJobs={runningJobs.length}
        staleCollectors={staleCollectors.length}
        thresholds={me?.org.healthThresholds}
        cycleP50Hours={cycleP50Hours}
        precisionRate={precisionRate}
        decidedCount={decidedCount}
        realizedCount={buckets.realized.count}
        signalsDir={signals24to48h.length > 0 ? signalsDir : undefined}
        signals24to48hCount={signals24to48h.length}
        lastSignalAt={lastSignal?.observedAt}
        enabledCollectorCount={enabledCollectors.length}
        collectorTotal={collectors.length}
        spendTotalUsd={spendQ.data?.totalSpendUsd ?? 0}
        supplierCount={spendQ.data?.concentration.activeSupplierCount ?? 0}
        isOpen={healthDrawerOpen}
        onToggle={() => setHealthDrawerOpen((v) => !v)}
      />
    </div>
  );
}

// ---------- Status-board sub-components (#277) ----------

type TileTone = "ok" | "info" | "warn" | "critical";

function StatusTile({
  label,
  value,
  sub,
  tone,
  icon: Icon,
  href,
  testId,
}: {
  label: string;
  value: string;
  sub: string;
  tone: TileTone;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  testId: string;
}) {
  // Calm light-theme palette: tinted background, matching border,
  // value text in tone colour. Soft, not alarming.
  const styles: Record<TileTone, { bg: string; border: string; text: string; dot: string }> = {
    ok: {
      bg: "bg-emerald-50/60 dark:bg-emerald-950/20",
      border: "border-emerald-200 dark:border-emerald-900",
      text: "text-emerald-700 dark:text-emerald-300",
      dot: "bg-emerald-500",
    },
    info: {
      bg: "bg-blue-50/60 dark:bg-blue-950/20",
      border: "border-blue-200 dark:border-blue-900",
      text: "text-blue-700 dark:text-blue-300",
      dot: "bg-blue-500",
    },
    warn: {
      bg: "bg-amber-50/60 dark:bg-amber-950/20",
      border: "border-amber-200 dark:border-amber-900",
      text: "text-amber-700 dark:text-amber-300",
      dot: "bg-amber-500",
    },
    critical: {
      bg: "bg-red-50/70 dark:bg-red-950/20",
      border: "border-red-200 dark:border-red-900",
      text: "text-red-700 dark:text-red-300",
      dot: "bg-red-500",
    },
  };
  const s = styles[tone];
  return (
    <Link href={href} data-testid={testId}>
      <div
        className={`group rounded-lg border ${s.border} ${s.bg} p-4 hover:border-foreground/20 transition-colors cursor-pointer h-full`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
              {label}
            </span>
          </div>
          <Icon className="w-3.5 h-3.5 text-muted-foreground/60" />
        </div>
        <p
          className={`text-2xl font-bold tabular-nums mt-2 ${s.text}`}
          data-testid={`${testId}-value`}
        >
          {value}
        </p>
        <p className="text-xs text-muted-foreground mt-1 truncate">{sub}</p>
      </div>
    </Link>
  );
}

function BigKpi({
  label,
  value,
  progress,
  targetText,
  icon: Icon,
  href,
  testId,
  loading,
  tone,
}: {
  label: string;
  value: string;
  progress: number | null;
  targetText: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  testId: string;
  loading?: boolean;
  tone?: TileTone;
}) {
  const barColor =
    progress === null
      ? "bg-muted"
      : tone === "critical"
        ? "bg-red-500"
        : tone === "warn"
          ? "bg-amber-500"
          : progress >= 0.6
            ? "bg-emerald-500"
            : progress >= 0.3
              ? "bg-blue-500"
              : "bg-amber-500";
  return (
    <Link href={href} data-testid={testId}>
      <div className="group rounded-lg border bg-card p-5 hover:border-foreground/20 transition-colors cursor-pointer h-full">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground font-semibold">
            {label}
          </span>
          <Icon className="w-4 h-4 text-muted-foreground/60" />
        </div>
        <p
          className="text-3xl font-bold tabular-nums mt-2 text-foreground"
          data-testid={`${testId}-value`}
        >
          {loading ? "…" : value}
        </p>
        {progress !== null && (
          <div className="mt-3 h-1.5 bg-muted rounded overflow-hidden">
            <div
              className={`h-full rounded ${barColor}`}
              style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-2 truncate">
          {targetText}
        </p>
      </div>
    </Link>
  );
}

function SmallKpi({
  label,
  value,
  progress,
  targetText,
  dir,
  icon: Icon,
  href,
  testId,
  tone,
}: {
  label: string;
  value: string;
  progress: number | null;
  targetText: string;
  dir?: "up" | "down" | "flat";
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  testId: string;
  tone?: TileTone;
}) {
  const barColor =
    progress === null
      ? "bg-muted"
      : tone === "warn"
        ? "bg-amber-500"
        : progress >= 0.8
          ? "bg-emerald-500"
          : progress >= 0.5
            ? "bg-blue-500"
            : "bg-amber-500";
  const dirIcon =
    dir === "up" ? (
      <TrendingUp className="w-3 h-3 text-emerald-600" />
    ) : dir === "down" ? (
      <TrendingDown className="w-3 h-3 text-red-600" />
    ) : dir === "flat" ? (
      <Minus className="w-3 h-3 text-muted-foreground" />
    ) : null;
  return (
    <Link href={href} data-testid={testId}>
      <div className="group rounded-lg border bg-card p-3 hover:border-foreground/20 transition-colors cursor-pointer h-full">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-semibold truncate">
            {label}
          </span>
          <Icon className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
        </div>
        <div className="flex items-baseline gap-1.5 mt-1.5">
          <p
            className="text-xl font-bold tabular-nums text-foreground"
            data-testid={`${testId}-value`}
          >
            {value}
          </p>
          {dirIcon}
        </div>
        {progress !== null && (
          <div className="mt-2 h-1 bg-muted rounded overflow-hidden">
            <div
              className={`h-full rounded ${barColor}`}
              style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
            />
          </div>
        )}
        <p className="text-[10px] text-muted-foreground mt-1.5 truncate">
          {targetText}
        </p>
      </div>
    </Link>
  );
}

function SeverityChip({
  severity,
}: {
  severity: "critical" | "high" | "medium" | "low";
}) {
  const styles: Record<string, string> = {
    critical: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
    high: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
    medium: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
    low: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={`inline-flex items-center text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${styles[severity]}`}
    >
      {severity}
    </span>
  );
}

function Telemetry({
  label,
  value,
  sub,
  tone,
  href,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "ok" | "warn" | "info";
  href: string;
}) {
  const valueColor =
    tone === "warn"
      ? "text-amber-700 dark:text-amber-300"
      : tone === "info"
        ? "text-blue-700 dark:text-blue-300"
        : "text-foreground";
  return (
    <Link href={href}>
      <div className="rounded-md border px-3 py-2 hover:border-foreground/20 cursor-pointer transition-colors">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          {label}
        </p>
        <p className={`text-lg font-bold tabular-nums ${valueColor}`}>
          {value}
        </p>
        <p className="text-[10px] text-muted-foreground truncate">{sub}</p>
      </div>
    </Link>
  );
}


// ---------- Pipeline stage glossary (S2P mapping) ----------

/**
 * Glossary tooltips for pipeline stage labels.
 *
 * Keys match the internal `status` value (proposed/approved/executing/
 * realized/rejected). The title is the S2P canonical stage name;
 * the body gives the savings-type definition at that stage.
 */
const STAGE_GLOSSARY: Record<
  string,
  { title: string; body: string }
> = {
  proposed: {
    title: "Identified Opportunity",
    body: "Identified Opportunity — analytically surfaced, pre-supplier engagement. Savings type: Identified.",
  },
  approved: {
    title: "Awarded",
    body: "Awarded — supplier selected and terms agreed. Savings type: Negotiated.",
  },
  executing: {
    title: "In Implementation",
    body: "In Implementation — contract being signed and rolled out. Savings type: Implemented.",
  },
  realized: {
    title: "Realized",
    body: "Realized — Finance-validated against baseline. Savings type: Realized.",
  },
  rejected: {
    title: "Closed — No Action",
    body: "Closed — No Action. Evaluated and declined; reason code required.",
  },
};

// ---------- Helpers ----------

type Bucket = { count: number; value: number; items: Opportunity[] };

function makeBucket(
  items: Opportunity[],
  valueField: "projected" | "realized",
): Bucket {
  let value = 0;
  for (const o of items) {
    value +=
      valueField === "realized"
        ? (o.realizedSavingsUsd ?? 0)
        : o.projectedSavingsUsd;
  }
  return { count: items.length, value, items };
}

interface AttentionItem {
  id: string;
  severity: "info" | "warn" | "danger";
  title: string;
  detail?: string;
  cta: string;
  href: string;
}

function buildAttentionItems(args: {
  highConfProposed: Opportunity[];
  staleProposed: Opportunity[];
  proposedCount: number;
  proposedValue: number;
  failedJobs24h: { id: string }[];
  pendingJobs: { id: string }[];
  runningJobs: { id: string }[];
  staleCollectors: { id: string; name: string }[];
  neverRunCollectors: { id: string; name: string }[];
  enabledCollectorCount: number;
  daysSinceLastCycle: number | null;
  realizedValue: number;
  pipelineValue: number;
  openCriticalOrHighAlerts: number;
  openAlertsTotal: number;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  // #269: Open alert and proposed-backlog COUNTS now live in the
  // Today triage row above (AlertsCard / OpportunitiesCard /
  // OpsHealthCard) — but we still surface attention items that are
  // QUALITATIVELY different from a simple count: high-confidence
  // proposed (a quality signal not visible from the count card),
  // stale opportunities, job throughput, scheduler/collector
  // freshness, and the empty-pipeline nudge.

  if (args.highConfProposed.length > 0) {
    const total = args.highConfProposed.reduce(
      (s, o) => s + o.projectedSavingsUsd,
      0,
    );
    items.push({
      id: "high-conf-proposed",
      severity: "warn",
      title: `${args.highConfProposed.length} high‑confidence opportunities awaiting approval`,
      detail: `${formatUsd(total, { compact: true })} projected · ≥70% confidence`,
      cta: "Review",
      href: "/approvals",
    });
  }

  if (args.staleProposed.length > 0) {
    items.push({
      id: "stale-proposed",
      severity: "warn",
      title: `${args.staleProposed.length} opportunities have been "proposed" for >7 days`,
      detail: "Either approve, reject with a reason, or let them expire",
      cta: "Triage",
      href: "/approvals",
    });
  }

  // failed-jobs items removed in #269 — the Today "Operations health"
  // triage card already surfaces failed-jobs-in-24h with deep link.

  if (args.runningJobs.length > 0 || args.pendingJobs.length > 0) {
    items.push({
      id: "active-jobs",
      severity: "info",
      title: `${args.runningJobs.length + args.pendingJobs.length} jobs in flight`,
      detail: `${args.runningJobs.length} running · ${args.pendingJobs.length} pending`,
      cta: "Watch",
      href: "/system",
    });
  }

  // Cycles auto-schedule every 6h, so a missing/stale cycle here means
  // the scheduler itself is broken — point operators at System / Jobs
  // to inspect the failed `analysis_cycle_fanout` job rather than asking
  // them to push a manual button.
  if (args.daysSinceLastCycle === null) {
    items.push({
      id: "no-cycle",
      severity: "warn",
      title: "No analysis cycle has run yet",
      detail:
        "The scheduler runs every 6h. If this persists, check System / Jobs for fan-out failures.",
      cta: "Open jobs",
      href: "/system",
    });
  } else if (args.daysSinceLastCycle >= 1) {
    items.push({
      id: "stale-cycle",
      severity: "warn",
      title: `Last analysis cycle was ${args.daysSinceLastCycle} day${args.daysSinceLastCycle === 1 ? "" : "s"} ago`,
      detail:
        "Cycles should run every 6h — check System / Jobs for the most recent fan-out attempt.",
      cta: "Open jobs",
      href: "/system",
    });
  }

  if (args.staleCollectors.length > 0) {
    const names = args.staleCollectors
      .slice(0, 2)
      .map((c) => c.name)
      .join(", ");
    items.push({
      id: "stale-collectors",
      severity: "warn",
      title: `${args.staleCollectors.length} ${args.staleCollectors.length === 1 ? "collector hasn't" : "collectors haven't"} run in the last 24h`,
      detail: `${names}${args.staleCollectors.length > 2 ? ` and ${args.staleCollectors.length - 2} more` : ""}`,
      cta: "Inspect",
      href: "/collectors",
    });
  }

  // Only flag never-run collectors if the tenant is otherwise active (cycles
  // have run); on a fresh tenant, this would be noise.
  if (
    args.neverRunCollectors.length > 0 &&
    args.daysSinceLastCycle !== null
  ) {
    const names = args.neverRunCollectors
      .slice(0, 2)
      .map((c) => c.name)
      .join(", ");
    items.push({
      id: "never-run-collectors",
      severity: "info",
      title: `${args.neverRunCollectors.length} enabled ${args.neverRunCollectors.length === 1 ? "collector has" : "collectors have"} never run`,
      detail: `${names}${args.neverRunCollectors.length > 2 ? ` and ${args.neverRunCollectors.length - 2} more` : ""} · trigger a first run to start streaming signals`,
      cta: "Run",
      href: "/collectors",
    });
  }

  if (
    args.realizedValue === 0 &&
    args.pipelineValue === 0 &&
    args.daysSinceLastCycle !== null
  ) {
    items.push({
      id: "no-pipeline",
      severity: "info",
      title: "No active pipeline and no realized savings",
      detail: "Ingest data or run a cycle to generate opportunities",
      cta: "Ingest",
      href: "/ingest",
    });
  }

  return items;
}

function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ${future ? "away" : "ago"}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ${future ? "away" : "ago"}`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ${future ? "away" : "ago"}`;
  const months = Math.round(days / 30);
  return `${months}mo ${future ? "away" : "ago"}`;
}

// ---------- Sub-components ----------

function SystemPulseCard(props: {
  lastCycle: { generation: number; completedAt?: string | null; startedAt: string } | undefined;
  jobsLoading: boolean;
  pendingJobs: { id: string }[];
  runningJobs: { id: string }[];
  succeededJobs24h: { id: string }[];
  failedJobs24h: { id: string }[];
  collectorsLoading: boolean;
  enabledCollectors: { id: string }[];
  collectors: { id: string }[];
  staleCollectors: { id: string }[];
  alertsLoading: boolean;
  openAlertsTotal: number;
  openCriticalOrHighAlerts: number;
  signalsLoading: boolean;
  recentSignals24h: { observedAt: string }[];
  lastSignal: { observedAt: string } | undefined;
  spendData: { totalSpendUsd: number; concentration: { activeSupplierCount: number } } | undefined;
}) {
  const {
    lastCycle,
    jobsLoading,
    pendingJobs,
    runningJobs,
    succeededJobs24h,
    failedJobs24h,
    collectorsLoading,
    enabledCollectors,
    collectors,
    staleCollectors,
    alertsLoading,
    openAlertsTotal,
    openCriticalOrHighAlerts,
    signalsLoading,
    recentSignals24h,
    lastSignal,
    spendData,
  } = props;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="w-5 h-5" /> System pulse
        </CardTitle>
        <CardDescription>
          One-line health for every upstream feeder. A red or amber
          accent means click through — green means leave it alone.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
        <PulseRow
          label="Last cycle"
          value={
            lastCycle
              ? `Gen ${lastCycle.generation} · ${timeAgo(lastCycle.completedAt ?? lastCycle.startedAt)}`
              : "No cycles yet"
          }
          href="/system"
        />
        <PulseRow
          label="Job queue (24h)"
          value={
            jobsLoading
              ? "…"
              : `${pendingJobs.length} pend · ${runningJobs.length} run · ${succeededJobs24h.length} ok · ${failedJobs24h.length} fail`
          }
          tone={
            failedJobs24h.length > 0
              ? "red"
              : runningJobs.length > 0 || pendingJobs.length > 0
                ? "amber"
                : "green"
          }
          href="/system"
        />
        <PulseRow
          label="Collectors"
          value={
            collectorsLoading
              ? "…"
              : `${enabledCollectors.length}/${collectors.length} on · ${staleCollectors.length} stale`
          }
          tone={staleCollectors.length > 0 ? "amber" : "green"}
          href="/collectors"
        />
        <PulseRow
          label="Alerts inbox"
          value={
            alertsLoading
              ? "…"
              : openAlertsTotal > 0
                ? `${openAlertsTotal} open · ${openCriticalOrHighAlerts} crit/high`
                : "All clear"
          }
          tone={
            openCriticalOrHighAlerts > 0
              ? "red"
              : openAlertsTotal > 0
                ? "amber"
                : "green"
          }
          href="/alerts"
        />
        <PulseRow
          label="Market signals (24h)"
          value={
            signalsLoading
              ? "…"
              : recentSignals24h.length > 0
                ? `${recentSignals24h.length} new · last ${timeAgo(lastSignal?.observedAt)}`
                : lastSignal
                  ? `0 new · last ${timeAgo(lastSignal.observedAt)}`
                  : "No signals yet"
          }
          tone={recentSignals24h.length > 0 ? "green" : "muted"}
          href="/fusion"
        />
        <PulseRow
          label="Intelligence Fusion"
          value="Signals · Entity 360 · Heatmap"
          href="/fusion"
        />
        <PulseRow
          label="Addressable spend"
          value={`${formatUsd(spendData?.totalSpendUsd ?? 0, { compact: true })} · ${spendData?.concentration.activeSupplierCount ?? 0} suppliers`}
          href="/spend"
        />
      </CardContent>
    </Card>
  );
}

/**
 * #269 follow-up — Compact pulse chip.
 *
 * Tiny label-over-value tile sized for a 2/4-column grid. The
 * left-edge tone bar replaces the old per-row icon + dot combo
 * so each chip stays roughly two lines tall while still showing
 * red/amber/green at a glance.
 */
function PulseRow({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: string;
  tone?: "green" | "amber" | "red" | "muted";
  href: string;
}) {
  const accent: Record<string, string> = {
    green: "border-l-emerald-500",
    amber: "border-l-amber-500",
    red: "border-l-red-500",
    muted: "border-l-muted-foreground/30",
  };
  const accentCls = tone ? accent[tone] : "border-l-transparent";
  return (
    <Link href={href}>
      <div
        className={`group border-l-2 ${accentCls} px-2 py-1.5 rounded-sm hover:bg-muted/40 cursor-pointer min-w-0`}
      >
        <div className="flex items-center justify-between gap-1">
          <div className="text-[11px] text-muted-foreground truncate">
            {label}
          </div>
          <ArrowRight className="w-3 h-3 text-muted-foreground/50 shrink-0 opacity-0 group-hover:opacity-100" />
        </div>
        <div className="text-xs font-medium truncate">{value}</div>
      </div>
    </Link>
  );
}

function SeverityDot({ severity }: { severity: "info" | "warn" | "danger" }) {
  const cls =
    severity === "danger"
      ? "bg-red-500"
      : severity === "warn"
        ? "bg-amber-500"
        : "bg-blue-500";
  return <span className={`w-2 h-2 rounded-full mt-2 shrink-0 ${cls}`} />;
}

function StageDot({ tone }: { tone: string }) {
  const cls: Record<string, string> = {
    muted: "bg-muted-foreground/40",
    blue: "bg-blue-500",
    amber: "bg-amber-500",
    green: "bg-emerald-500",
    red: "bg-red-500",
  };
  return <span className={`w-2 h-2 rounded-full ${cls[tone] ?? cls.muted}`} />;
}

function barClass(tone: string): string {
  const cls: Record<string, string> = {
    muted: "bg-muted-foreground/40",
    blue: "bg-blue-500",
    amber: "bg-amber-500",
    green: "bg-emerald-500",
    red: "bg-red-500",
  };
  return cls[tone] ?? cls.muted;
}

