import { Link } from "wouter";
import {
  useGetMe,
  useGetSpendOverview,
  useGetBillingSummary,
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
import type { Opportunity, OpportunityStatus } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatUsd, formatPercent, leverLabel } from "@/lib/format";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bell,
  CheckCircle2,
  CircleDot,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  TrendingUp,
  Activity,
  Server,
  Radar,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

const POLL_MS = 30_000;

export default function Dashboard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetMe();

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

  const spendQ = useGetSpendOverview({
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

  // Top open opportunities (still actionable: proposed/approved/executing)
  const topOpenOpps = [...proposedItems, ...approvedItems, ...executingItems]
    .sort((a, b) => b.projectedSavingsUsd - a.projectedSavingsUsd)
    .slice(0, 5);

  const pipelineStages = [
    {
      key: "proposed" as const,
      label: "Proposed",
      ...buckets.proposed,
      tone: "muted",
    },
    {
      key: "approved" as const,
      label: "Approved",
      ...buckets.approved,
      tone: "blue",
    },
    {
      key: "executing" as const,
      label: "Executing",
      ...buckets.executing,
      tone: "amber",
    },
    {
      key: "realized" as const,
      label: "Realized",
      ...buckets.realized,
      tone: "green",
    },
    {
      key: "rejected" as const,
      label: "Rejected",
      ...buckets.rejected,
      tone: "red",
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

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            data-testid="text-page-title"
            className="text-3xl font-bold flex items-center gap-3"
          >
            Command Center
            {(spendQ.isFetching ||
              oppsFetching ||
              billingQ.isFetching) && (
              <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            {me?.org.name ?? "—"} · live view of every Procuro signal · auto‑refreshes every 30s
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Reviewing security?{" "}
            <Link
              href="/trust"
              className="text-primary underline-offset-2 hover:underline"
              data-testid="link-dashboard-trust"
            >
              See your live Trust Center →
            </Link>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshAll}
          data-testid="button-refresh-dashboard"
        >
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          label="Realized savings"
          value={formatUsd(billingQ.data?.totalRealizedUsd ?? 0, {
            compact: true,
          })}
          sub={`Success fee ${formatUsd(
            billingQ.data?.successFeeUsd ?? 0,
            { compact: true },
          )}`}
          icon={TrendingUp}
          tone="green"
          href="/results"
          loading={billingQ.isLoading}
        />
        <KpiCard
          label="Pipeline value"
          value={formatUsd(activePipelineValue, { compact: true })}
          sub={`${
            buckets.proposed.count +
            buckets.approved.count +
            buckets.executing.count
          } open opps`}
          icon={Sparkles}
          tone="blue"
          href="/opportunities"
          loading={oppsLoading}
        />
        <KpiCard
          label="Capture rate"
          value={formatPercent(captureRate)}
          sub={`${formatUsd(buckets.realized.value, {
            compact: true,
          })} of ${formatUsd(captureDenominator, {
            compact: true,
          })} acted on`}
          icon={Activity}
          tone={
            captureRate >= 0.6
              ? "green"
              : captureRate >= 0.3
                ? "amber"
                : "red"
          }
          href="/results"
          loading={billingQ.isLoading || oppsLoading}
        />
        <KpiCard
          label="Awaiting approval"
          value={buckets.proposed.count.toLocaleString()}
          sub={`${formatUsd(buckets.proposed.value, { compact: true })} projected`}
          icon={Clock}
          tone={buckets.proposed.count > 0 ? "amber" : "muted"}
          href="/approvals"
          loading={oppsLoading}
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

      {/* Attention + System pulse */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Attention (2 cols) */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" /> Needs your attention
            </CardTitle>
            <span className="text-xs text-muted-foreground">
              {attentionItems.length} {attentionItems.length === 1 ? "item" : "items"}
            </span>
          </CardHeader>
          <CardContent>
            {isLoading && attentionItems.length === 0 ? (
              <div className="text-sm text-muted-foreground">Scanning…</div>
            ) : attentionItems.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" /> All clear. Nothing needs human attention right now.
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

        {/* System pulse */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="w-5 h-5" /> System pulse
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <PulseRow
              icon={Activity}
              label="Last analysis cycle"
              value={
                lastCycle
                  ? `Gen ${lastCycle.generation} · ${timeAgo(lastCycle.completedAt ?? lastCycle.startedAt)}`
                  : "No cycles yet"
              }
              sub="Auto-runs every 6h"
              href="/system"
            />
            <PulseRow
              icon={Server}
              label="Job queue (24h)"
              value={
                jobsQ.isLoading
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
              icon={Radar}
              label="Collectors"
              value={
                collectorsQ.isLoading
                  ? "…"
                  : `${enabledCollectors.length}/${collectors.length} enabled · ${staleCollectors.length} stale`
              }
              tone={staleCollectors.length > 0 ? "amber" : "green"}
              href="/collectors"
            />
            <PulseRow
              icon={Bell}
              label="Alerts inbox"
              value={
                alertsSummaryQ.isLoading
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
              icon={CircleDot}
              label="Market signals (24h)"
              value={
                signalsQ.isLoading
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
              icon={Radar}
              label="Intelligence Fusion"
              value="Signals · Entity 360 · Heatmap · Events · Coverage"
              href="/fusion"
            />
            <PulseRow
              icon={BarChart3}
              label="Total addressable spend"
              value={formatUsd(spendQ.data?.totalSpendUsd ?? 0, {
                compact: true,
              })}
              sub={`${spendQ.data?.concentration.activeSupplierCount ?? 0} suppliers`}
              href="/spend"
            />
          </CardContent>
        </Card>
      </div>

      {/* Pipeline funnel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5" /> Opportunity pipeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {pipelineStages.map((s) => (
              <Link
                key={s.key}
                href={s.key === "rejected" ? "/approvals" : "/approvals"}
                data-testid={`bar-pipeline-${s.key}`}
              >
                <div className="group cursor-pointer">
                  <div className="flex items-baseline justify-between text-sm mb-1">
                    <span className="flex items-center gap-2 font-medium">
                      <StageDot tone={s.tone} />
                      {s.label}
                      <span className="text-xs text-muted-foreground">
                        {s.count} {s.count === 1 ? "opp" : "opps"}
                      </span>
                    </span>
                    <span className="tabular-nums text-sm text-muted-foreground group-hover:text-foreground">
                      {formatUsd(s.value, { compact: true })}
                      {s.key === "realized" ? " realized" : " projected"}
                    </span>
                  </div>
                  <div className="h-2.5 bg-muted rounded overflow-hidden">
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
        </CardContent>
      </Card>

      {/* Top opportunities + Lever performance */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5" /> Top open opportunities
            </CardTitle>
            <Link href="/opportunities">
              <Button variant="ghost" size="sm" className="gap-1">
                View all <ArrowRight className="w-3 h-3" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {topOpenOpps.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No open opportunities. The next analysis cycle runs automatically every 6h, or click "Run now" below.
              </div>
            ) : (
              <ul className="divide-y" data-testid="list-top-opps">
                {topOpenOpps.map((o) => (
                  <li key={o.id} className="py-3">
                    <Link href={`/opportunities/${o.id}`}>
                      <div
                        className="flex items-start justify-between gap-3 cursor-pointer hover:bg-muted/40 -mx-2 px-2 py-1 rounded"
                        data-testid={`row-top-opp-${o.id}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">
                            {o.title}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                            <span>{leverLabel(o.leverId)}</span>
                            {o.supplierName && (
                              <>
                                <span>·</span>
                                <span className="truncate">{o.supplierName}</span>
                              </>
                            )}
                            <StatusBadge status={o.status} />
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-semibold tabular-nums">
                            {formatUsd(o.projectedSavingsUsd, { compact: true })}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {Math.round(o.confidence * 100)}% conf.
                          </div>
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5" /> Lever performance
            </CardTitle>
            <Link href="/playbook">
              <Button variant="ghost" size="sm" className="gap-1">
                Playbook <ArrowRight className="w-3 h-3" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {!billingQ.data || billingQ.data.byLever.length === 0 ? (
              <div className="text-sm text-muted-foreground">No lever data yet.</div>
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
      </div>

      {/* Recent analysis cycles — auto-scheduled every 6h. Operators
          can override with "Run now"; every run still shows up in
          System / Jobs as a `run_analysis_cycle` row. */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" /> Recent analysis cycles
          </CardTitle>
          <div className="flex items-center gap-2">
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
              Run now
            </Button>
            <Link href="/system">
              <Button variant="ghost" size="sm" className="gap-1">
                View jobs <ArrowRight className="w-3 h-3" />
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-xs text-muted-foreground">
            Cycles run automatically every 6 hours. Use{" "}
            <span className="font-medium">Run now</span> to queue one
            on demand.
          </div>
          {lastCycle && (
            <div
              className="border rounded-lg p-4 bg-muted/30"
              data-testid="card-last-cycle"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Gen {lastCycle.generation}</Badge>
                  <Badge
                    variant={
                      lastCycle.status === "completed" ? "default" : "secondary"
                    }
                  >
                    {lastCycle.status}
                  </Badge>
                </div>
                <span className="text-xs text-muted-foreground">
                  {timeAgo(lastCycle.completedAt ?? lastCycle.startedAt)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">
                    Opportunities surfaced
                  </div>
                  <div className="text-lg font-semibold tabular-nums">
                    {lastCycle.opportunitiesCreated}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Projected savings
                  </div>
                  <div className="text-lg font-semibold tabular-nums">
                    {formatUsd(lastCycle.totalProjectedUsd, { compact: true })}
                  </div>
                </div>
              </div>
            </div>
          )}
          {cycles.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No cycles yet — the next scheduled tick will queue one
              automatically. You can also click{" "}
              <span className="font-medium">Run now</span> to start
              immediately.
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {cycles.slice(0, 4).map((c) => (
                <Link
                  key={c.id}
                  href="/system"
                  data-testid={`card-cycle-${c.generation}`}
                >
                  <div className="border rounded-lg p-3 hover:bg-muted/40 cursor-pointer">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline">Gen {c.generation}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {timeAgo(c.completedAt ?? c.startedAt)}
                      </span>
                    </div>
                    <div className="mt-2 text-sm font-medium tabular-nums">
                      {formatUsd(c.totalProjectedUsd, { compact: true })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {c.opportunitiesCreated} opps · {c.status}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

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

  if (args.openCriticalOrHighAlerts > 0) {
    items.push({
      id: "open-critical-alerts",
      severity: "danger",
      title: `${args.openCriticalOrHighAlerts} critical or high‑severity alerts open`,
      detail:
        "Acknowledge or resolve in the alerts inbox so they stop escalating",
      cta: "Open inbox",
      href: "/alerts",
    });
  } else if (args.openAlertsTotal > 0) {
    items.push({
      id: "open-alerts",
      severity: "warn",
      title: `${args.openAlertsTotal} open alerts in the inbox`,
      detail: "No criticals — but worth a triage pass",
      cta: "Open inbox",
      href: "/alerts",
    });
  }

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
  } else if (args.proposedCount > 0) {
    items.push({
      id: "proposed-backlog",
      severity: "info",
      title: `${args.proposedCount} proposed opportunities in queue`,
      detail: `${formatUsd(args.proposedValue, { compact: true })} projected · review and approve to move forward`,
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

  if (args.failedJobs24h.length > 0) {
    items.push({
      id: "failed-jobs",
      severity: "danger",
      title: `${args.failedJobs24h.length} background jobs failed in the last 24h`,
      detail: "Investigate and retry from System / Jobs",
      cta: "Open jobs",
      href: "/system",
    });
  }

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

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  href,
  loading,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "green" | "blue" | "amber" | "red" | "muted";
  href: string;
  loading?: boolean;
}) {
  const toneStyles: Record<string, string> = {
    green: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40",
    blue: "text-blue-600 bg-blue-50 dark:bg-blue-950/40",
    amber: "text-amber-600 bg-amber-50 dark:bg-amber-950/40",
    red: "text-red-600 bg-red-50 dark:bg-red-950/40",
    muted: "text-muted-foreground bg-muted",
  };
  return (
    <Link href={href} data-testid={`kpi-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="bg-card border rounded-lg p-4 hover:border-primary/50 transition-colors cursor-pointer h-full">
        <div className="flex items-start justify-between">
          <div className="text-xs uppercase text-muted-foreground tracking-wide">
            {label}
          </div>
          <div className={`p-1.5 rounded ${toneStyles[tone]}`}>
            <Icon className="w-3.5 h-3.5" />
          </div>
        </div>
        <div className="text-2xl font-bold mt-2 tabular-nums">
          {loading ? "…" : value}
        </div>
        {sub && (
          <div className="text-xs text-muted-foreground mt-1 truncate">{sub}</div>
        )}
      </div>
    </Link>
  );
}

function PulseRow({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tone?: "green" | "amber" | "red" | "muted";
  href: string;
}) {
  const dot: Record<string, string> = {
    green: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    muted: "bg-muted-foreground/30",
  };
  return (
    <Link href={href}>
      <div className="flex items-center justify-between gap-3 -mx-2 px-2 py-1.5 rounded hover:bg-muted/40 cursor-pointer">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-sm font-medium truncate flex items-center gap-2">
              {tone && (
                <span className={`w-1.5 h-1.5 rounded-full ${dot[tone]}`} />
              )}
              {value}
            </div>
            {sub && (
              <div className="text-xs text-muted-foreground">{sub}</div>
            )}
          </div>
        </div>
        <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
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

function StatusBadge({ status }: { status: OpportunityStatus }) {
  const map: Record<string, { label: string; className: string }> = {
    proposed: { label: "Proposed", className: "bg-muted text-foreground" },
    approved: { label: "Approved", className: "bg-blue-500/15 text-blue-700 dark:text-blue-300" },
    executing: { label: "Executing", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
    realized: { label: "Realized", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
    rejected: { label: "Rejected", className: "bg-red-500/15 text-red-700 dark:text-red-300" },
    expired: { label: "Expired", className: "bg-muted text-muted-foreground" },
  };
  const m = map[status] ?? map.proposed;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${m.className}`}>
      {m.label}
    </span>
  );
}
