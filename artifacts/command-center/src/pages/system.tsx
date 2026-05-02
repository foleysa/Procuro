import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getListJobsQueryKey,
  getListJobKindSettingsQueryKey,
  getGetSystemCleanupStatusQueryKey,
  getGetSystemFunnelSnapshotCleanupStatusQueryKey,
  useListJobs,
  useListJobKindSettings,
  useRetryJob,
  useCancelJob,
  useUpdateJobKindSetting,
  useClearJobKindSetting,
  useGetSystemCleanupStatus,
  useGetSystemCleanupSchedule,
  useUpdateSystemCleanupSchedule,
  getGetSystemCleanupScheduleQueryKey,
  useRunSystemCleanup,
  useGetSystemFunnelSnapshotCleanupStatus,
  useRunSystemFunnelSnapshotCleanup,
  useGetSystemCsvIngestMetrics,
  getGetSystemCsvIngestMetricsQueryKey,
  useGetSystemCsvThroughputHistory,
  getGetSystemCsvThroughputHistoryQueryKey,
  ListJobsStatus,
  type Job,
  type JobKindSetting,
  type ListJobsParams,
  type CsvIngestEntityTrend,
  type CsvJobThroughputBucket,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  RefreshCw,
  Server,
  RotateCw,
  AlertCircle,
  CheckCircle2,
  Clock,
  PlayCircle,
  Ban,
  Save,
  Settings2,
  Trash2,
  Activity,
  Gauge,
  Layers,
} from "lucide-react";

const STATUS_OPTS: { v: string; l: string }[] = [
  { v: "all", l: "All statuses" },
  { v: ListJobsStatus.pending, l: "Pending" },
  { v: ListJobsStatus.running, l: "Running" },
  { v: ListJobsStatus.succeeded, l: "Succeeded" },
  { v: ListJobsStatus.failed, l: "Failed" },
  { v: ListJobsStatus.cancelled, l: "Cancelled" },
];

const KIND_OPTS: { v: string; l: string }[] = [
  { v: "all", l: "All kinds" },
  { v: "ingest_csv", l: "CSV ingest" },
  { v: "ingest_mock_erp", l: "Mock ERP sync" },
  { v: "run_analysis_cycle", l: "Analysis cycle" },
  { v: "run_collector", l: "Collector run" },
  { v: "sync_erp_connection", l: "ERP sync" },
];

const KIND_LABEL: Record<string, string> = {
  ingest_csv: "CSV ingest",
  ingest_mock_erp: "Mock ERP sync",
  run_analysis_cycle: "Analysis cycle",
  run_collector: "Collector run",
  sync_erp_connection: "ERP sync",
  analysis_cycle_fanout: "Analysis cycle scheduler",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  succeeded:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  // Cancelled jobs are operator-initiated terminal rows. Keep them
  // visually distinct from `failed` (which means "the system tried and
  // could not"): amber on slate to read as "intentional stop".
  cancelled:
    "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
};

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> =
  {
    pending: Clock,
    running: PlayCircle,
    succeeded: CheckCircle2,
    failed: AlertCircle,
    cancelled: Ban,
  };

function durationLabel(job: Job): string {
  if (!job.startedAt) return "—";
  const start = new Date(job.startedAt).getTime();
  const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "—";
  }
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * If `job` is currently in retry-backoff (pending with `scheduledFor` set
 * to a future time), return a short human label like "in 12s" or "in 2m".
 * Returns null otherwise so callers can hide the row entirely.
 */
function retryDelayLabel(job: Job): string | null {
  if (job.status !== "pending" || !job.scheduledFor) return null;
  const next = new Date(job.scheduledFor).getTime();
  if (!Number.isFinite(next)) return null;
  const ms = next - Date.now();
  if (ms <= 0) return "any moment";
  if (ms < 60_000) return `in ${Math.max(1, Math.round(ms / 1000))}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  if (mins < 60) return secs > 0 ? `in ${mins}m ${secs}s` : `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours}h`;
}

const KIND_DESCRIPTION: Record<string, string> = {
  ingest_csv: "Per-batch CSV ingestion job",
  ingest_mock_erp: "Mock ERP sync runs",
  run_analysis_cycle: "OODA analysis cycle execution",
  run_collector: "External market-signal collector run",
  sync_erp_connection: "Live ERP connection sync (Coupa, etc.)",
  analysis_cycle_fanout:
    "System scheduler — fans out one analysis cycle per tenant every 6h",
};

interface BackfillTenantReport {
  orgId: string;
  cyclesScanned: number;
  snapshotsCreated: number;
  alreadyHadSnapshot: number;
  skippedNotCompleted: number;
  failed: number;
}
interface BackfillResponse {
  tenants: BackfillTenantReport[];
  totals: Omit<BackfillTenantReport, "orgId">;
  durationMs: number;
}

interface RetryBudgetRowProps {
  setting: JobKindSetting;
  onSave: (kind: JobKindSetting["kind"], maxAttempts: number) => void;
  onClear: (kind: JobKindSetting["kind"]) => void;
  isSaving: boolean;
  isClearing: boolean;
}

function RetryBudgetRow({
  setting,
  onSave,
  onClear,
  isSaving,
  isClearing,
}: RetryBudgetRowProps) {
  // Local input state so the operator can type freely without each
  // keystroke triggering a network round-trip. Re-syncs whenever the
  // server value changes (after a save, or when the list refetches).
  const [draft, setDraft] = useState<string>(String(setting.maxAttempts));
  useEffect(() => {
    setDraft(String(setting.maxAttempts));
  }, [setting.maxAttempts]);

  const parsed = Number(draft);
  const isValidInt =
    draft.trim() !== "" &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= 100;
  const isDirty = isValidInt && parsed !== setting.maxAttempts;

  return (
    <tr
      data-testid={`row-setting-${setting.kind}`}
      className="border-t"
    >
      <td className="py-2 pr-4">
        <div className="font-medium">
          {KIND_LABEL[setting.kind] ?? setting.kind}
        </div>
        <div className="text-xs text-muted-foreground">
          {KIND_DESCRIPTION[setting.kind] ?? setting.kind}
        </div>
      </td>
      <td className="py-2 pr-4 text-right tabular-nums text-xs text-muted-foreground">
        {setting.defaultMaxAttempts}
      </td>
      <td className="py-2 pr-4">
        <div className="flex items-center gap-2">
          <Input
            data-testid={`input-max-attempts-${setting.kind}`}
            type="number"
            min={1}
            max={100}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-20 tabular-nums"
            disabled={isSaving}
          />
          {setting.isOverride ? (
            <Badge
              variant="secondary"
              className="text-[10px]"
              data-testid={`badge-override-${setting.kind}`}
            >
              custom
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-[10px]"
              data-testid={`badge-default-${setting.kind}`}
            >
              default
            </Badge>
          )}
        </div>
        {!isValidInt && draft.trim() !== "" && (
          <div className="text-xs text-red-600 mt-1">
            Enter an integer between 1 and 100.
          </div>
        )}
      </td>
      <td className="py-2 pr-4 text-xs text-muted-foreground">
        {setting.lastChangedAt
          ? formatDateTime(setting.lastChangedAt)
          : setting.updatedAt
            ? formatDateTime(setting.updatedAt)
            : "—"}
        {setting.lastChangedBy ? (
          <div
            className="text-[11px] text-muted-foreground"
            data-testid={`text-last-changed-by-${setting.kind}`}
          >
            by {setting.lastChangedBy}
          </div>
        ) : null}
      </td>
      <td className="py-2 pr-2 text-right">
        <div className="flex justify-end gap-2">
          <Button
            data-testid={`btn-save-${setting.kind}`}
            size="sm"
            variant="outline"
            disabled={!isDirty || isSaving || isClearing}
            onClick={() => onSave(setting.kind, parsed)}
          >
            {isSaving ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <Save className="w-3 h-3 mr-1" />
            )}
            Save
          </Button>
          {setting.isOverride && (
            <Button
              data-testid={`btn-clear-${setting.kind}`}
              size="sm"
              variant="ghost"
              disabled={isSaving || isClearing}
              onClick={() => onClear(setting.kind)}
              title="Remove this override and revert to the in-code default."
            >
              {isClearing ? (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              ) : (
                <Trash2 className="w-3 h-3 mr-1" />
              )}
              Reset
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

export default function System() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

  const params = useMemo<ListJobsParams>(() => {
    const p: ListJobsParams = { limit: 100 };
    if (statusFilter !== "all") {
      p.status = statusFilter as ListJobsParams["status"];
    }
    if (kindFilter !== "all") {
      p.kind = kindFilter;
    }
    return p;
  }, [statusFilter, kindFilter]);

  const { data, isLoading, isFetching, refetch, queryKey } = useListJobs(
    params,
    {
      query: {
        queryKey: getListJobsQueryKey(params),
        // Auto-refresh every 3s while there is anything pending/running.
        refetchInterval: (query) => {
          const rows = query.state.data as Job[] | undefined;
          if (!rows) return false;
          const active = rows.some(
            (j) => j.status === "pending" || j.status === "running",
          );
          return active ? 3000 : false;
        },
      },
    },
  );

  const jobs = data ?? [];

  const counts = useMemo(() => {
    const c = { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const j of jobs) {
      if (j.status in c) c[j.status as keyof typeof c] += 1;
    }
    return c;
  }, [jobs]);

  const retryM = useRetryJob({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "Job re-queued",
          description: `New job ${resp.jobId} enqueued (${resp.status}).`,
        });
        // Invalidate the current list and any other filter combinations so
        // counts/rows stay in sync no matter which filters the operator has
        // applied.
        qc.invalidateQueries({ queryKey });
        qc.invalidateQueries({ queryKey: ["/api/jobs"] });
      },
      onError: (e: Error) =>
        toast({
          title: "Retry failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const cancelM = useCancelJob({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: resp.cancelledImmediately
            ? "Job cancelled"
            : "Cancellation requested",
          description: resp.cancelledImmediately
            ? `Job ${resp.jobId} was pending and is now marked cancelled.`
            : `Job ${resp.jobId} is running; it will be marked cancelled at the next safe checkpoint.`,
        });
        qc.invalidateQueries({ queryKey });
        qc.invalidateQueries({ queryKey: ["/api/jobs"] });
      },
      onError: (e: Error) =>
        toast({
          title: "Cancel failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  // Per-kind retry budget editor.
  const settingsQueryKey = useMemo(
    () => getListJobKindSettingsQueryKey(),
    [],
  );
  const settingsQuery = useListJobKindSettings({
    query: { queryKey: settingsQueryKey },
  });
  const settings = settingsQuery.data ?? [];

  const updateSettingM = useUpdateJobKindSetting({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "Retry budget updated",
          description: `${KIND_LABEL[resp.kind] ?? resp.kind} now retries up to ${resp.maxAttempts} time${resp.maxAttempts === 1 ? "" : "s"}.`,
        });
        qc.invalidateQueries({ queryKey: settingsQueryKey });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not save retry budget",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const clearSettingM = useClearJobKindSetting({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "Override cleared",
          description: `${KIND_LABEL[resp.kind] ?? resp.kind} reverted to the in-code default of ${resp.maxAttempts}.`,
        });
        qc.invalidateQueries({ queryKey: settingsQueryKey });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not clear override",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  // Cleanup status (#74 / #75 / #76). Polls every 5s when a prune is
  // already pending or running so the operator sees the cleanup job
  // appear and resolve in real time.
  const cleanupQueryKey = useMemo(
    () => getGetSystemCleanupStatusQueryKey(),
    [],
  );
  const cleanupQuery = useGetSystemCleanupStatus({
    query: {
      queryKey: cleanupQueryKey,
      refetchInterval: (query) => {
        const data = query.state.data as
          | { activeJobId: string | null }
          | undefined;
        return data && data.activeJobId ? 5000 : false;
      },
    },
  });
  const runCleanupM = useRunSystemCleanup({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "Cleanup queued",
          description: `Prune job ${resp.jobId} is ${resp.status}.`,
        });
        qc.invalidateQueries({ queryKey: cleanupQueryKey });
        qc.invalidateQueries({ queryKey: ["/api/jobs"] });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not run cleanup",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  // Job-prune cron schedule (#158). Pulled separately from the cleanup
  // *status* query so the schedule card doesn't refresh on the 5s
  // status poll while a prune is in flight (the cron only changes when
  // an operator saves it). `cronDraft` keeps the editable input value
  // detached from the persisted schedule so the operator can type
  // freely without losing focus on every refetch.
  const cleanupScheduleQueryKey = useMemo(
    () => getGetSystemCleanupScheduleQueryKey(),
    [],
  );
  const cleanupScheduleQuery = useGetSystemCleanupSchedule({
    query: { queryKey: cleanupScheduleQueryKey },
  });
  const [cronDraft, setCronDraft] = useState<string>("");
  const [cronDraftDirty, setCronDraftDirty] = useState(false);
  useEffect(() => {
    // Only seed the draft from the server value while the operator
    // hasn't started editing — otherwise we'd clobber their in-progress
    // input on background refetches.
    if (!cronDraftDirty && cleanupScheduleQuery.data) {
      setCronDraft(cleanupScheduleQuery.data.cron);
    }
  }, [cleanupScheduleQuery.data, cronDraftDirty]);
  const updateScheduleM = useUpdateSystemCleanupSchedule({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "Schedule updated",
          description: `prune_jobs will next run at ${formatDateTime(
            resp.nextRunAt,
          )}.`,
        });
        setCronDraftDirty(false);
        qc.invalidateQueries({ queryKey: cleanupScheduleQueryKey });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not update schedule",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  // ─── Funnel snapshot backfill (task #188) ───────────────────────────
  // Cycles that completed before the funnel snapshot writer shipped
  // have no `funnel_snapshots` row, so the observability page is blank
  // for historical generations. This card lets a platform operator
  // backfill — per-tenant by id, or for every tenant when the field
  // is left blank. Idempotent: existing snapshots are skipped.
  const [backfillOrgId, setBackfillOrgId] = useState<string>("");
  const [backfillResult, setBackfillResult] = useState<
    BackfillResponse | null
  >(null);
  const backfillM = useMutation<BackfillResponse, Error, string>({
    mutationFn: async (orgId: string) => {
      const res = await fetch("/api/platform/funnel/backfill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(orgId ? { orgId } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status} ${text || res.statusText}`);
      }
      return (await res.json()) as BackfillResponse;
    },
    onSuccess: (resp) => {
      setBackfillResult(resp);
      const created = resp.totals.snapshotsCreated;
      const skipped = resp.totals.alreadyHadSnapshot;
      toast({
        title: "Backfill complete",
        description: `${created} snapshot(s) created, ${skipped} already present across ${resp.tenants.length} tenant(s).`,
      });
    },
    onError: (e: Error) =>
      toast({
        title: "Backfill failed",
        description: String(e),
        variant: "destructive",
      }),
  });

  // Funnel-snapshot cleanup (#189). Same polling/refetch pattern as the
  // generic cleanup card so an in-flight prune resolves visibly without
  // a manual refresh.
  const funnelCleanupQueryKey = useMemo(
    () => getGetSystemFunnelSnapshotCleanupStatusQueryKey(),
    [],
  );
  const funnelCleanupQuery = useGetSystemFunnelSnapshotCleanupStatus({
    query: {
      queryKey: funnelCleanupQueryKey,
      refetchInterval: (query) => {
        const data = query.state.data as
          | { activeJobId: string | null }
          | undefined;
        return data && data.activeJobId ? 5000 : false;
      },
    },
  });
  const runFunnelCleanupM = useRunSystemFunnelSnapshotCleanup({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "Funnel snapshot cleanup queued",
          description: `Prune job ${resp.jobId} is ${resp.status}.`,
        });
        qc.invalidateQueries({ queryKey: funnelCleanupQueryKey });
        qc.invalidateQueries({ queryKey: ["/api/jobs"] });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not run funnel snapshot cleanup",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  // CSV ingest throughput history (#157). Hourly p50/p95 latency +
  // rows/sec rollups across the last 24h, aggregated server-side from
  // the same `ingest_csv` job rows the aggregate percentiles below
  // are computed from. Powers the inline sparkline next to the
  // existing percentile numbers so an operator can spot a slow
  // database evening at a glance.
  const csvThroughputHistoryParams = useMemo(
    () => ({ windowHours: 24 }),
    [],
  );
  const csvThroughputHistoryQuery = useGetSystemCsvThroughputHistory(
    csvThroughputHistoryParams,
    {
      query: {
        queryKey: getGetSystemCsvThroughputHistoryQueryKey(
          csvThroughputHistoryParams,
        ),
        // 60s refresh keeps the chart in step with the auto-refreshing
        // jobs table above (which polls every 3s while jobs are
        // pending/running) without hammering the DB on a quiet system.
        refetchInterval: 60_000,
      },
    },
  );

  // CSV throughput trends (#73 / #74). Computed client-side from the
  // last `ingest_csv` jobs already in the table so we do not need a
  // separate query: each succeeded ingest_csv row carries
  // result.recordsProcessed and durationMs in its result blob.
  const csvThroughput = useMemo(() => {
    const samples: { rows: number; durationMs: number; rps: number }[] = [];
    for (const j of jobs) {
      if (j.kind !== "ingest_csv" || j.status !== "succeeded") continue;
      const result = (j.result ?? {}) as Record<string, unknown>;
      const rows =
        typeof result["recordsProcessed"] === "number"
          ? (result["recordsProcessed"] as number)
          : null;
      const ms =
        typeof result["durationMs"] === "number"
          ? (result["durationMs"] as number)
          : null;
      if (rows == null || ms == null || ms <= 0 || rows <= 0) continue;
      samples.push({ rows, durationMs: ms, rps: (rows / ms) * 1000 });
    }
    if (samples.length === 0) return null;
    const latencies = samples.map((s) => s.durationMs).sort((a, b) => a - b);
    const rpsList = samples.map((s) => s.rps).sort((a, b) => a - b);
    const pick = (arr: number[], pct: number) =>
      arr[
        Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * pct)))
      ]!;
    return {
      n: samples.length,
      p50LatencyMs: pick(latencies, 0.5),
      p95LatencyMs: pick(latencies, 0.95),
      p50Rps: pick(rpsList, 0.5),
      p95Rps: pick(rpsList, 0.95),
      totalRows: samples.reduce((acc, s) => acc + s.rows, 0),
    };
  }, [jobs]);

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            data-testid="text-page-title"
            className="text-3xl font-bold flex items-center gap-2"
          >
            <Server className="w-7 h-7 text-primary" />
            System / Jobs
          </h1>
          <p className="text-muted-foreground mt-1">
            Background work running in the Postgres job queue. Auto-refreshes
            while jobs are pending or running.
          </p>
        </div>
        <Button
          data-testid="btn-refresh-jobs"
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw
            className={`w-4 h-4 mr-1 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {(["pending", "running", "succeeded", "failed", "cancelled"] as const).map((s) => {
          const Icon = STATUS_ICON[s]!;
          return (
            <Card key={s} data-testid={`stat-${s}`}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className={`p-2 rounded-md ${STATUS_BADGE[s]}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    {s}
                  </div>
                  <div className="text-2xl font-bold tabular-nums">
                    {counts[s]}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card data-testid="card-retry-budgets">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-muted-foreground" />
            Retry budgets
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Tune the maximum number of automatic attempts (initial run +
            retries) per job kind. New values apply to the next enqueue;
            in-flight jobs keep the budget they were enqueued with.
          </p>
        </CardHeader>
        <CardContent>
          {settingsQuery.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading settings…
            </div>
          )}
          {settingsQuery.isError && (
            <div className="text-sm text-red-600">
              Failed to load retry-budget settings.
            </div>
          )}
          {!settingsQuery.isLoading && settings.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
                    <th className="py-2 pr-4">Job kind</th>
                    <th className="py-2 pr-4 text-right">Default</th>
                    <th className="py-2 pr-4">Max attempts</th>
                    <th className="py-2 pr-4">Last updated</th>
                    <th className="py-2 pr-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.map((s) => (
                    <RetryBudgetRow
                      key={s.kind}
                      setting={s}
                      onSave={(kind, maxAttempts) =>
                        updateSettingM.mutate({
                          kind,
                          data: { maxAttempts },
                        })
                      }
                      onClear={(kind) =>
                        clearSettingM.mutate({ kind })
                      }
                      isSaving={
                        updateSettingM.isPending &&
                        updateSettingM.variables?.kind === s.kind
                      }
                      isClearing={
                        clearSettingM.isPending &&
                        clearSettingM.variables?.kind === s.kind
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card data-testid="card-cleanup">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-muted-foreground" />
              Job-history cleanup
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Periodically prunes terminal job rows so the queue table
              stays bounded. Cancelled jobs share the same retention
              window as failed jobs.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {cleanupQuery.isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading
                cleanup status…
              </div>
            )}
            {cleanupQuery.isError && (
              <div className="text-sm text-red-600">
                Failed to load cleanup status. You may not have Platform
                Admin access.
              </div>
            )}
            {cleanupQuery.data && (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs uppercase text-muted-foreground">
                      Last cleanup at
                    </div>
                    <div data-testid="text-last-cleanup-at">
                      {cleanupQuery.data.lastJob?.completedAt
                        ? formatDateTime(
                            cleanupQuery.data.lastJob.completedAt,
                          )
                        : cleanupQuery.data.lastJob?.startedAt
                          ? `${formatDateTime(cleanupQuery.data.lastJob.startedAt)} (in flight)`
                          : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase text-muted-foreground">
                      Last status
                    </div>
                    <div>
                      {cleanupQuery.data.lastJob ? (
                        <Badge
                          className={
                            STATUS_BADGE[cleanupQuery.data.lastJob.status]
                          }
                          data-testid="badge-last-cleanup-status"
                        >
                          {cleanupQuery.data.lastJob.status}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">
                          never run
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {cleanupQuery.data.lastJob?.result && (
                  <div
                    className="grid grid-cols-2 gap-3 text-sm"
                    data-testid="grid-cleanup-deleted"
                  >
                    <div>
                      <div className="text-xs uppercase text-muted-foreground">
                        Succeeded deleted
                      </div>
                      <div
                        className="text-lg font-semibold tabular-nums"
                        data-testid="text-cleanup-succeeded-deleted"
                      >
                        {Number(
                          (cleanupQuery.data.lastJob.result as Record<string, unknown>)["succeededDeleted"] ?? 0,
                        ).toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase text-muted-foreground">
                        Failed deleted
                      </div>
                      <div
                        className="text-lg font-semibold tabular-nums"
                        data-testid="text-cleanup-failed-deleted"
                      >
                        {Number(
                          (cleanupQuery.data.lastJob.result as Record<string, unknown>)["failedDeleted"] ?? 0,
                        ).toLocaleString()}
                      </div>
                    </div>
                  </div>
                )}
                <div
                  className="text-xs text-muted-foreground"
                  data-testid="text-cleanup-retention"
                >
                  Retention windows: succeeded jobs kept for{" "}
                  {(
                    cleanupQuery.data.retention.succeededOlderThanMs /
                    (24 * 60 * 60 * 1000)
                  ).toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}
                  d, failed/cancelled jobs kept for{" "}
                  {(
                    cleanupQuery.data.retention.failedOlderThanMs /
                    (24 * 60 * 60 * 1000)
                  ).toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}
                  d. Configure via{" "}
                  <code className="font-mono">
                    JOB_RETENTION_SUCCEEDED_DAYS
                  </code>{" "}
                  /{" "}
                  <code className="font-mono">JOB_RETENTION_FAILED_DAYS</code>.
                </div>
                <div
                  className="border-t pt-3 space-y-2"
                  data-testid="section-cleanup-schedule"
                >
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="cleanup-cron-input"
                      className="text-xs uppercase text-muted-foreground"
                    >
                      Cron schedule
                    </label>
                    {cleanupScheduleQuery.data && (
                      <span
                        className="text-[11px] text-muted-foreground"
                        data-testid="text-cleanup-cron-default"
                      >
                        Default:{" "}
                        <code className="font-mono">
                          {cleanupScheduleQuery.data.defaultCron}
                        </code>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      id="cleanup-cron-input"
                      data-testid="input-cleanup-cron"
                      placeholder="0 */6 * * *"
                      value={cronDraft}
                      onChange={(e) => {
                        setCronDraft(e.target.value);
                        setCronDraftDirty(true);
                      }}
                      disabled={
                        cleanupScheduleQuery.isLoading ||
                        updateScheduleM.isPending
                      }
                      className="font-mono text-sm"
                    />
                    <Button
                      data-testid="btn-save-cleanup-cron"
                      size="sm"
                      onClick={() =>
                        updateScheduleM.mutate({
                          data: { cron: cronDraft.trim() },
                        })
                      }
                      disabled={
                        updateScheduleM.isPending ||
                        cronDraft.trim() === "" ||
                        (!cronDraftDirty &&
                          cleanupScheduleQuery.data?.cron ===
                            cronDraft.trim())
                      }
                    >
                      {updateScheduleM.isPending ? (
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      ) : (
                        <Save className="w-3 h-3 mr-1" />
                      )}
                      Save
                    </Button>
                  </div>
                  {cleanupScheduleQuery.data && (
                    <div
                      className="text-xs text-muted-foreground space-y-1"
                      data-testid="text-cleanup-cron-meta"
                    >
                      <div>
                        Next run at{" "}
                        <span
                          className="font-medium text-foreground"
                          data-testid="text-cleanup-next-run"
                        >
                          {formatDateTime(
                            cleanupScheduleQuery.data.nextRunAt,
                          )}
                        </span>
                        {!cleanupScheduleQuery.data.isOverride && (
                          <span className="ml-1">(using default)</span>
                        )}
                      </div>
                      {cleanupScheduleQuery.data.isOverride &&
                        cleanupScheduleQuery.data.lastChangedAt && (
                          <div data-testid="text-cleanup-cron-audit">
                            Last changed{" "}
                            {formatDateTime(
                              cleanupScheduleQuery.data.lastChangedAt,
                            )}
                            {cleanupScheduleQuery.data.lastChangedBy
                              ? ` by ${cleanupScheduleQuery.data.lastChangedBy}`
                              : ""}
                            .
                          </div>
                        )}
                    </div>
                  )}
                </div>
                <div className="flex justify-end">
                  <Button
                    data-testid="btn-run-cleanup"
                    size="sm"
                    onClick={() => runCleanupM.mutate()}
                    disabled={
                      runCleanupM.isPending ||
                      cleanupQuery.data.activeJobId != null
                    }
                    title={
                      cleanupQuery.data.activeJobId
                        ? `Cleanup job ${cleanupQuery.data.activeJobId} is already in flight.`
                        : "Enqueue a prune_jobs run now."
                    }
                  >
                    {runCleanupM.isPending ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : (
                      <PlayCircle className="w-3 h-3 mr-1" />
                    )}
                    {cleanupQuery.data.activeJobId
                      ? "Cleanup pending…"
                      : "Run cleanup now"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-funnel-backfill">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-muted-foreground" />
              Funnel snapshot backfill
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Writes funnel snapshots for completed cycles that ran
              before the snapshot writer shipped. Stages 1–5 are
              zeroed (signals/drafts cannot be reconstructed
              post-hoc); stages 6–10 are derived from current
              persisted opportunities and decisions. Idempotent —
              re-running only fills new gaps.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label
                htmlFor="backfill-org-id"
                className="text-xs uppercase text-muted-foreground"
              >
                Tenant org id (blank = all tenants)
              </label>
              <Input
                id="backfill-org-id"
                data-testid="input-backfill-org-id"
                placeholder="org_…"
                value={backfillOrgId}
                onChange={(e) => setBackfillOrgId(e.target.value.trim())}
                disabled={backfillM.isPending}
              />
            </div>
            {backfillResult && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="text-xs uppercase text-muted-foreground">
                      Snapshots created
                    </div>
                    <div data-testid="text-backfill-created">
                      {backfillResult.totals.snapshotsCreated}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase text-muted-foreground">
                      Already had snapshot
                    </div>
                    <div data-testid="text-backfill-skipped">
                      {backfillResult.totals.alreadyHadSnapshot}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase text-muted-foreground">
                      Cycles scanned
                    </div>
                    <div>{backfillResult.totals.cyclesScanned}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase text-muted-foreground">
                      Failed
                    </div>
                    <div
                      className={
                        backfillResult.totals.failed > 0
                          ? "text-red-600"
                          : ""
                      }
                      data-testid="text-backfill-failed"
                    >
                      {backfillResult.totals.failed}
                    </div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {backfillResult.tenants.length} tenant(s) processed in{" "}
                  {backfillResult.durationMs}ms.
                </div>
              </div>
            )}
            <div className="flex justify-end">
              <Button
                size="sm"
                data-testid="btn-run-backfill"
                onClick={() => backfillM.mutate(backfillOrgId)}
                disabled={backfillM.isPending}
                title={
                  backfillOrgId
                    ? `Backfill snapshots for ${backfillOrgId}`
                    : "Backfill snapshots for every tenant"
                }
              >
                {backfillM.isPending ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <PlayCircle className="w-3 h-3 mr-1" />
                )}
                {backfillM.isPending
                  ? "Running…"
                  : backfillOrgId
                    ? "Run backfill (tenant)"
                    : "Run backfill (all tenants)"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-funnel-cleanup">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-muted-foreground" />
              Funnel snapshot cleanup
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Daily prune of `funnel_snapshots` (cascading
              `funnel_annotations`) and `funnel_snapshot_failures`
              older than the configured windows so the funnel
              observability tables stay bounded.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {funnelCleanupQuery.isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading
                funnel cleanup status…
              </div>
            )}
            {funnelCleanupQuery.isError && (
              <div className="text-sm text-red-600">
                Failed to load funnel cleanup status. You may not have
                Platform Admin access.
              </div>
            )}
            {funnelCleanupQuery.data && (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs uppercase text-muted-foreground">
                      Last cleanup at
                    </div>
                    <div data-testid="text-last-funnel-cleanup-at">
                      {funnelCleanupQuery.data.lastJob?.completedAt
                        ? formatDateTime(
                            funnelCleanupQuery.data.lastJob.completedAt,
                          )
                        : funnelCleanupQuery.data.lastJob?.startedAt
                          ? `${formatDateTime(funnelCleanupQuery.data.lastJob.startedAt)} (in flight)`
                          : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase text-muted-foreground">
                      Last status
                    </div>
                    <div>
                      {funnelCleanupQuery.data.lastJob ? (
                        <Badge
                          className={
                            STATUS_BADGE[
                              funnelCleanupQuery.data.lastJob.status
                            ]
                          }
                          data-testid="badge-last-funnel-cleanup-status"
                        >
                          {funnelCleanupQuery.data.lastJob.status}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">
                          never run
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {funnelCleanupQuery.data.lastJob?.result && (
                  <pre className="bg-muted text-xs p-2 rounded-md whitespace-pre-wrap break-words max-h-40 overflow-auto">
                    {JSON.stringify(
                      funnelCleanupQuery.data.lastJob.result,
                      null,
                      2,
                    )}
                  </pre>
                )}
                <div className="text-xs text-muted-foreground">
                  Retention windows: snapshots{" "}
                  {Math.round(
                    funnelCleanupQuery.data.retention
                      .snapshotsOlderThanMs /
                      (24 * 60 * 60 * 1000),
                  )}
                  d, failures{" "}
                  {Math.round(
                    funnelCleanupQuery.data.retention
                      .failuresOlderThanMs /
                      (24 * 60 * 60 * 1000),
                  )}
                  d.
                </div>
                <div className="flex justify-end">
                  <Button
                    data-testid="btn-run-funnel-cleanup"
                    size="sm"
                    onClick={() => runFunnelCleanupM.mutate()}
                    disabled={
                      runFunnelCleanupM.isPending ||
                      funnelCleanupQuery.data.activeJobId != null
                    }
                    title={
                      funnelCleanupQuery.data.activeJobId
                        ? `Funnel cleanup job ${funnelCleanupQuery.data.activeJobId} is already in flight.`
                        : "Enqueue a prune_funnel_snapshots run now."
                    }
                  >
                    {runFunnelCleanupM.isPending ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : (
                      <PlayCircle className="w-3 h-3 mr-1" />
                    )}
                    {funnelCleanupQuery.data.activeJobId
                      ? "Cleanup pending…"
                      : "Run cleanup now"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-csv-throughput">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="w-4 h-4 text-muted-foreground" />
              CSV ingest throughput
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Latency and rows-per-second percentiles across the most
              recent succeeded `ingest_csv` jobs in the table below.
            </p>
          </CardHeader>
          <CardContent>
            {!csvThroughput && (
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <Activity className="w-4 h-4" />
                No completed CSV ingest jobs in the current window.
              </div>
            )}
            {csvThroughput && (
              <div
                className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm"
                data-testid="grid-csv-throughput"
              >
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Samples
                  </div>
                  <div className="text-lg font-semibold tabular-nums">
                    {csvThroughput.n}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Total rows
                  </div>
                  <div className="text-lg font-semibold tabular-nums">
                    {csvThroughput.totalRows.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Latency p50 / p95
                  </div>
                  <div
                    className="text-lg font-semibold tabular-nums"
                    data-testid="text-csv-latency-percentiles"
                  >
                    {Math.round(csvThroughput.p50LatencyMs)}ms /{" "}
                    {Math.round(csvThroughput.p95LatencyMs)}ms
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Rows/s p50 / p95
                  </div>
                  <div
                    className="text-lg font-semibold tabular-nums"
                    data-testid="text-csv-rps-percentiles"
                  >
                    {Math.round(csvThroughput.p50Rps).toLocaleString()} /{" "}
                    {Math.round(csvThroughput.p95Rps).toLocaleString()}
                  </div>
                </div>
              </div>
            )}
            <CsvThroughputLatencyChart
              buckets={csvThroughputHistoryQuery.data?.buckets ?? null}
              windowHours={
                csvThroughputHistoryQuery.data?.windowHours ?? 24
              }
              totalSampleCount={
                csvThroughputHistoryQuery.data?.totalSampleCount ?? 0
              }
              isLoading={csvThroughputHistoryQuery.isLoading}
              isError={csvThroughputHistoryQuery.isError}
            />
          </CardContent>
        </Card>
      </div>

      <CsvIngestPerformancePanel />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Recent jobs</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger
                  data-testid="select-job-status"
                  className="w-[170px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTS.map((o) => (
                    <SelectItem key={o.v} value={o.v}>
                      {o.l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={kindFilter} onValueChange={setKindFilter}>
                <SelectTrigger
                  data-testid="select-job-kind"
                  className="w-[180px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_OPTS.map((o) => (
                    <SelectItem key={o.v} value={o.v}>
                      {o.l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading jobs…
            </div>
          )}
          {!isLoading && jobs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No jobs found for the current filters.
            </p>
          )}
          {jobs.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
                    <th className="py-2 pr-4">Kind</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4 text-right">Attempts</th>
                    <th className="py-2 pr-4">Enqueued</th>
                    <th className="py-2 pr-4">Started</th>
                    <th className="py-2 pr-4">Completed</th>
                    <th className="py-2 pr-4 text-right">Duration</th>
                    <th className="py-2 pr-4">Error</th>
                    <th className="py-2 pr-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr
                      key={j.id}
                      data-testid={`row-job-${j.id}`}
                      className="border-t hover:bg-muted/40 cursor-pointer"
                      onClick={() => setSelectedJob(j)}
                    >
                      <td className="py-2 pr-4">
                        <div className="font-medium">
                          {KIND_LABEL[j.kind] ?? j.kind}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {j.id}
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex flex-col gap-1">
                          <Badge className={STATUS_BADGE[j.status]}>
                            {j.status}
                          </Badge>
                          {(() => {
                            const label = retryDelayLabel(j);
                            return label ? (
                              <span
                                data-testid={`text-retry-${j.id}`}
                                className="text-xs text-amber-700 dark:text-amber-400"
                                title={
                                  j.scheduledFor
                                    ? `Next retry at ${formatDateTime(j.scheduledFor)}`
                                    : undefined
                                }
                              >
                                Retry {label}
                              </span>
                            ) : null;
                          })()}
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {j.attempts}
                        <span className="text-muted-foreground">
                          {" / "}
                          {j.maxAttempts}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {formatDateTime(j.enqueuedAt)}
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {formatDateTime(j.startedAt)}
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {formatDateTime(j.completedAt)}
                      </td>
                      <td className="py-2 pr-4 text-right text-xs text-muted-foreground tabular-nums">
                        {durationLabel(j)}
                      </td>
                      <td className="py-2 pr-4 text-xs text-red-600 dark:text-red-400 max-w-[260px] truncate">
                        {j.error ?? ""}
                      </td>
                      <td
                        className="py-2 pr-2 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {j.status === "failed" && (
                          <Button
                            data-testid={`btn-retry-${j.id}`}
                            size="sm"
                            variant="outline"
                            disabled={
                              retryM.isPending &&
                              retryM.variables?.id === j.id
                            }
                            onClick={() => retryM.mutate({ id: j.id })}
                          >
                            {retryM.isPending &&
                            retryM.variables?.id === j.id ? (
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            ) : (
                              <RotateCw className="w-3 h-3 mr-1" />
                            )}
                            Retry
                          </Button>
                        )}
                        {(j.status === "pending" ||
                          j.status === "running") && (
                          <Button
                            data-testid={`btn-cancel-${j.id}`}
                            size="sm"
                            variant="outline"
                            disabled={
                              j.cancelRequested === true ||
                              (cancelM.isPending &&
                                cancelM.variables?.id === j.id)
                            }
                            onClick={() => cancelM.mutate({ id: j.id })}
                          >
                            {cancelM.isPending &&
                            cancelM.variables?.id === j.id ? (
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            ) : (
                              <Ban className="w-3 h-3 mr-1" />
                            )}
                            {j.cancelRequested === true
                              ? "Cancelling…"
                              : "Cancel"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={selectedJob !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedJob(null);
        }}
      >
        <DialogContent
          className="max-w-2xl"
          data-testid="dialog-job-detail"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedJob ? (
                <>
                  <span>{KIND_LABEL[selectedJob.kind] ?? selectedJob.kind}</span>
                  <Badge className={STATUS_BADGE[selectedJob.status]}>
                    {selectedJob.status}
                  </Badge>
                </>
              ) : (
                "Job detail"
              )}
            </DialogTitle>
          </DialogHeader>
          {selectedJob && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Job ID
                  </div>
                  <div className="font-mono text-xs break-all">
                    {selectedJob.id}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Attempts
                  </div>
                  <div className="tabular-nums">
                    {selectedJob.attempts}
                    <span className="text-muted-foreground">
                      {" / "}
                      {selectedJob.maxAttempts}
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Enqueued
                  </div>
                  <div>{formatDateTime(selectedJob.enqueuedAt)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Started
                  </div>
                  <div>{formatDateTime(selectedJob.startedAt)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Completed
                  </div>
                  <div>{formatDateTime(selectedJob.completedAt)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">
                    Duration
                  </div>
                  <div className="tabular-nums">
                    {durationLabel(selectedJob)}
                  </div>
                </div>
                {selectedJob.scheduledFor && selectedJob.status === "pending" ? (
                  <div className="col-span-2">
                    <div className="text-xs uppercase text-muted-foreground">
                      Next retry
                    </div>
                    <div
                      data-testid="text-detail-next-retry"
                      className="text-amber-700 dark:text-amber-400"
                    >
                      {formatDateTime(selectedJob.scheduledFor)}
                      {(() => {
                        const label = retryDelayLabel(selectedJob);
                        return label ? (
                          <span className="text-xs ml-2">({label})</span>
                        ) : null;
                      })()}
                    </div>
                  </div>
                ) : null}
              </div>

              {selectedJob.error && (
                <div>
                  <div className="text-xs uppercase text-muted-foreground mb-1">
                    Error
                  </div>
                  <pre className="bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-xs p-3 rounded-md whitespace-pre-wrap break-words">
                    {selectedJob.error}
                  </pre>
                </div>
              )}

              {selectedJob.result &&
                Object.keys(selectedJob.result).length > 0 && (
                  <div>
                    <div className="text-xs uppercase text-muted-foreground mb-1">
                      Result
                    </div>
                    <pre className="bg-muted text-xs p-3 rounded-md whitespace-pre-wrap break-words max-h-80 overflow-auto">
                      {JSON.stringify(selectedJob.result, null, 2)}
                    </pre>
                  </div>
                )}

              {selectedJob.status === "failed" && (
                <div className="flex justify-end">
                  <Button
                    data-testid="btn-retry-detail"
                    onClick={() => {
                      retryM.mutate({ id: selectedJob.id });
                      setSelectedJob(null);
                    }}
                  >
                    <RotateCw className="w-4 h-4 mr-1" />
                    Retry job
                  </Button>
                </div>
              )}

              {(selectedJob.status === "pending" ||
                selectedJob.status === "running") && (
                <div className="flex justify-end">
                  <Button
                    data-testid="btn-cancel-detail"
                    variant="outline"
                    disabled={
                      selectedJob.cancelRequested === true ||
                      cancelM.isPending
                    }
                    onClick={() => {
                      cancelM.mutate({ id: selectedJob.id });
                      setSelectedJob(null);
                    }}
                  >
                    <Ban className="w-4 h-4 mr-1" />
                    {selectedJob.cancelRequested === true
                      ? "Cancelling…"
                      : "Cancel job"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Per-entity CSV streaming-ingest performance panel. Reads from
 * `/system/csv-ingest/metrics` (gated by the same platform-admin
 * token as the cleanup cards above), shows the last 25 uploads in a
 * table (entity, rows, duration, rows/sec) and an inline 7-day
 * sparkline per entity so operators can spot throughput drift
 * without scraping logs. Card structure intentionally mirrors the
 * other System page cards for visual consistency.
 */
function CsvIngestPerformancePanel() {
  const params = useMemo(
    () => ({ windowDays: 7, recentLimit: 25 }),
    [],
  );
  const { data, isLoading, isError, refetch, isFetching } =
    useGetSystemCsvIngestMetrics(params, {
      query: {
        queryKey: getGetSystemCsvIngestMetricsQueryKey(params),
        refetchInterval: 30_000,
      },
    });

  return (
    <Card data-testid="card-csv-ingest-performance">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="w-4 h-4 text-muted-foreground" />
              CSV ingest performance
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Recent streaming uploads with per-entity rows/sec and a
              7-day sparkline so throughput drift surfaces between
              deploys.
            </p>
          </div>
          <Button
            data-testid="btn-refresh-csv-ingest-metrics"
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={`w-4 h-4 mr-1 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading CSV ingest
            metrics…
          </div>
        )}
        {isError && (
          <div className="text-sm text-red-600">
            Failed to load CSV ingest metrics. You may not have Platform
            Admin access.
          </div>
        )}
        {data && data.recent.length === 0 && data.entities.length === 0 && (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Activity className="w-4 h-4" />
            No streaming CSV uploads in the last {data.windowDays} days.
            Recent uploads will appear here once the streaming ingest
            route processes one.
          </div>
        )}
        {data && data.entities.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs uppercase text-muted-foreground">
              Per-entity throughput · last {data.windowDays} days
            </div>
            <div
              className="rounded-md border overflow-hidden"
              data-testid="table-csv-ingest-trends"
            >
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">
                      Entity
                    </th>
                    <th className="text-right font-medium px-3 py-2">
                      Uploads
                    </th>
                    <th className="text-right font-medium px-3 py-2">
                      Total rows
                    </th>
                    <th className="text-right font-medium px-3 py-2">
                      Rows/s p50 / p95
                    </th>
                    <th className="text-left font-medium px-3 py-2 w-[180px]">
                      7-day rows/s trend
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.entities.map((e) => (
                    <tr
                      key={e.entity}
                      className="border-t"
                      data-testid={`row-csv-ingest-trend-${e.entity}`}
                    >
                      <td className="px-3 py-2 font-medium">{e.entity}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {e.uploadCount.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {e.totalRows.toLocaleString()}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        data-testid={`text-csv-ingest-rps-${e.entity}`}
                      >
                        {e.p50RowsPerSecond.toLocaleString()} /{" "}
                        {e.p95RowsPerSecond.toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        <CsvIngestSparkline trend={e} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {data && data.recent.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs uppercase text-muted-foreground">
              Recent uploads · newest first
            </div>
            <div
              className="rounded-md border overflow-hidden"
              data-testid="table-csv-ingest-recent"
            >
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">
                      When
                    </th>
                    <th className="text-left font-medium px-3 py-2">
                      Entity
                    </th>
                    <th className="text-right font-medium px-3 py-2">
                      Rows
                    </th>
                    <th className="text-right font-medium px-3 py-2">
                      Duration
                    </th>
                    <th className="text-right font-medium px-3 py-2">
                      Rows/s
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr
                      key={r.id}
                      className="border-t"
                      data-testid={`row-csv-ingest-recent-${r.id}`}
                    >
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                        {formatDateTime(r.createdAt)}
                      </td>
                      <td className="px-3 py-2 font-medium">{r.entity}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.rowsInserted.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatDurationMs(r.durationMs)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.rowsPerSecond.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Inline SVG sparkline for a single entity's 7-day rows/sec p50
 * timeseries. No external charting dep — the dataset is at most 30
 * points so a hand-rolled SVG polyline keeps the bundle lean and
 * matches the rest of the System page's no-chart-lib aesthetic.
 *
 * Empty days (no uploads) render as a flat zero baseline so the
 * sparkline width stays comparable across entities.
 */
function CsvIngestSparkline({ trend }: { trend: CsvIngestEntityTrend }) {
  const width = 160;
  const height = 32;
  const padding = 2;
  const values = trend.days.map((d) => d.p50RowsPerSecond);
  const max = Math.max(1, ...values);
  const denom = Math.max(1, values.length - 1);

  const points = values
    .map((v, i) => {
      const x = padding + (i / denom) * (width - padding * 2);
      const y =
        height - padding - (v / max) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const lastDay = trend.days[trend.days.length - 1];
  const firstDay = trend.days[0];
  const allZero = values.every((v) => v === 0);

  return (
    <div
      className="flex items-center gap-2"
      data-testid={`sparkline-csv-ingest-${trend.entity}`}
      title={
        allZero
          ? "No uploads in window"
          : `p50 ${trend.p50RowsPerSecond.toLocaleString()} rows/s · p95 ${trend.p95RowsPerSecond.toLocaleString()} rows/s · ${firstDay?.day} → ${lastDay?.day}`
      }
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="text-primary"
        aria-hidden
      >
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={points}
        />
      </svg>
      <span className="text-xs text-muted-foreground tabular-nums">
        {allZero ? "—" : `${(lastDay?.p50RowsPerSecond ?? 0).toLocaleString()} r/s`}
      </span>
    </div>
  );
}

/**
 * 24h p50/p95 latency chart for the System page's CSV ingest
 * throughput card (#157). Hand-rolled inline SVG (no charting dep)
 * to match the existing System page aesthetic — see
 * `CsvIngestSparkline` for the same approach on the per-entity
 * trends panel.
 *
 * Two stacked polylines: muted-foreground for p50, primary for p95.
 * Empty hours from the server render as zero, so the line drops to
 * baseline rather than skipping points; this keeps the X axis stable
 * across refreshes regardless of how busy the system is. We size the
 * chart in a fixed viewBox and let CSS scale it to the card width
 * via `width="100%"` so it reflows on narrow screens.
 *
 * The Y-axis label only carries the maximum p95 value (rounded). The
 * surrounding card already shows the aggregate p50/p95 numbers
 * verbatim, so the chart's job is purely to visualise drift over
 * time, not to repeat exact percentile readings.
 */
function CsvThroughputLatencyChart(props: {
  buckets: CsvJobThroughputBucket[] | null;
  windowHours: number;
  totalSampleCount: number;
  isLoading: boolean;
  isError: boolean;
}) {
  const { buckets, windowHours, totalSampleCount, isLoading, isError } =
    props;

  if (isLoading) {
    return (
      <div
        className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"
        data-testid="text-csv-throughput-chart-loading"
      >
        <Loader2 className="w-3 h-3 animate-spin" /> Loading throughput
        history…
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="mt-4 text-xs text-red-600"
        data-testid="text-csv-throughput-chart-error"
      >
        Could not load throughput history. You may not have Platform Admin
        access.
      </div>
    );
  }

  if (!buckets || buckets.length === 0) {
    return null;
  }

  const width = 480;
  const height = 80;
  const padX = 4;
  const padY = 6;
  const denom = Math.max(1, buckets.length - 1);

  // Scale both series to the same Y axis so p50 and p95 are visually
  // comparable. Floor the max at 1 so an all-zero window still draws
  // a flat baseline rather than dividing by zero.
  const maxLatency = Math.max(
    1,
    ...buckets.map((b) => Math.max(b.p50LatencyMs, b.p95LatencyMs)),
  );

  const project = (values: number[]) =>
    values
      .map((v, i) => {
        const x = padX + (i / denom) * (width - padX * 2);
        const y =
          height - padY - (v / maxLatency) * (height - padY * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  const p50Points = project(buckets.map((b) => b.p50LatencyMs));
  const p95Points = project(buckets.map((b) => b.p95LatencyMs));

  const firstHour = buckets[0]?.hour;
  const lastHour = buckets[buckets.length - 1]?.hour;
  const allEmpty = totalSampleCount === 0;

  return (
    <div
      className="mt-6 space-y-2"
      data-testid="chart-csv-throughput-latency"
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div>
          Latency over last {windowHours}h
          <span className="ml-2 inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-0.5 bg-muted-foreground/70" />
              p50
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-0.5 bg-primary" />
              p95
            </span>
          </span>
        </div>
        <span
          className="tabular-nums"
          data-testid="text-csv-throughput-chart-samples"
        >
          {totalSampleCount} sample{totalSampleCount === 1 ? "" : "s"}
        </span>
      </div>
      {allEmpty ? (
        <div
          className="text-xs text-muted-foreground rounded-md border border-dashed py-6 text-center"
          data-testid="text-csv-throughput-chart-empty"
        >
          No completed CSV ingest jobs in the last {windowHours}h.
        </div>
      ) : (
        <div className="rounded-md border bg-muted/20 p-2">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            width="100%"
            height={height}
            role="img"
            aria-label={`CSV ingest p50 and p95 latency over the last ${windowHours} hours`}
          >
            <polyline
              data-testid="polyline-csv-throughput-p50"
              fill="none"
              stroke="hsl(var(--muted-foreground))"
              strokeOpacity={0.7}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={p50Points}
            />
            <polyline
              data-testid="polyline-csv-throughput-p95"
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={p95Points}
            />
          </svg>
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
            <span>{formatHourLabel(firstHour)}</span>
            <span>peak p95 {Math.round(maxLatency).toLocaleString()}ms</span>
            <span>{formatHourLabel(lastHour)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function formatHourLabel(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Compact human-friendly duration for the recent-uploads table. */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}
