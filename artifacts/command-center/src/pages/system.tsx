import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListJobsQueryKey,
  getListJobKindSettingsQueryKey,
  useListJobs,
  useListJobKindSettings,
  useRetryJob,
  useCancelJob,
  useUpdateJobKindSetting,
  ListJobsStatus,
  type Job,
  type JobKindSetting,
  type ListJobsParams,
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
} from "lucide-react";

const STATUS_OPTS: { v: string; l: string }[] = [
  { v: "all", l: "All statuses" },
  { v: ListJobsStatus.pending, l: "Pending" },
  { v: ListJobsStatus.running, l: "Running" },
  { v: ListJobsStatus.succeeded, l: "Succeeded" },
  { v: ListJobsStatus.failed, l: "Failed" },
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
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  succeeded:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> =
  {
    pending: Clock,
    running: PlayCircle,
    succeeded: CheckCircle2,
    failed: AlertCircle,
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
};

interface RetryBudgetRowProps {
  setting: JobKindSetting;
  onSave: (kind: JobKindSetting["kind"], maxAttempts: number) => void;
  isSaving: boolean;
}

function RetryBudgetRow({ setting, onSave, isSaving }: RetryBudgetRowProps) {
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
        {setting.updatedAt ? formatDateTime(setting.updatedAt) : "—"}
      </td>
      <td className="py-2 pr-2 text-right">
        <Button
          data-testid={`btn-save-${setting.kind}`}
          size="sm"
          variant="outline"
          disabled={!isDirty || isSaving}
          onClick={() => onSave(setting.kind, parsed)}
        >
          {isSaving ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Save className="w-3 h-3 mr-1" />
          )}
          Save
        </Button>
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
    const c = { pending: 0, running: 0, succeeded: 0, failed: 0 };
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
            ? `Job ${resp.jobId} was pending and is now marked failed.`
            : `Job ${resp.jobId} is running; it will be marked failed at the next safe checkpoint.`,
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(["pending", "running", "succeeded", "failed"] as const).map((s) => {
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
                      isSaving={
                        updateSettingM.isPending &&
                        updateSettingM.variables?.kind === s.kind
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

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
