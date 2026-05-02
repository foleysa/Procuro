import { useMemo } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetJob,
  useRetryJob,
  getGetJobQueryKey,
  getListJobsQueryKey,
  getListRecentlyFailedJobsQueryKey,
  type Job,
} from "@workspace/api-client-react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  PlayCircle,
  Ban,
  RotateCw,
  Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { TruncatedError } from "@/components/truncated-error";
import { formatDateTime } from "@/lib/format";

/**
 * Job-detail page (#94).
 *
 * The "click-through target" for the failed-jobs banner. Shows the
 * job's metadata (id, kind, status, attempts), the failure error
 * message, and the redacted original payload so the operator can
 * understand *why* the job died (which CSV row, which ERP query)
 * without having to ssh into the server.
 *
 * Why a dedicated page rather than reusing the System / Jobs row
 * expand?
 *   - Banner click-through needs a stable, deep-linkable URL —
 *     `/system/jobs/<id>` — so the operator can paste it into a Slack
 *     thread.
 *   - The redacted payload can be large; rendering it in the System
 *     page's row-expand would crowd the dense table view.
 *   - A dedicated page keeps the retry CTA front-and-center on the
 *     thing the operator came to fix.
 *
 * The `payload` field is the server-side defensively-redacted copy
 * (see `lib/jobs/redact-payload.ts`); we show it pretty-printed so
 * structurally-rich payloads (CSV row indices, ERP query parameters)
 * are scannable.
 */

const STATUS_BADGE: Record<Job["status"], string> = {
  pending: "bg-slate-100 text-slate-800",
  running: "bg-blue-100 text-blue-800",
  succeeded: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-amber-100 text-amber-900",
};

const STATUS_ICON: Record<
  Job["status"],
  React.ComponentType<{ className?: string }>
> = {
  pending: Clock,
  running: PlayCircle,
  succeeded: CheckCircle2,
  failed: AlertCircle,
  cancelled: Ban,
};

const KIND_LABEL: Record<string, string> = {
  ingest_csv: "CSV ingest",
  ingest_mock_erp: "Mock ERP sync",
  run_analysis_cycle: "Analysis cycle",
  run_collector: "Collector run",
  sync_erp_connection: "ERP sync",
  prune_jobs: "Job pruner",
  prune_funnel_snapshots: "Funnel snapshot pruner",
  renewal_alert_scan: "Renewal alert scan",
  analysis_cycle_fanout: "Analysis cycle scheduler",
  deliver_alerts: "Alert delivery",
  escalate_alerts: "Alert escalation",
  synthesize_operational_alerts: "Operational alert synthesizer",
  expire_stale_opportunities: "Opportunity auto-expire",
  routing_health_check: "Routing health check",
};

function durationLabel(job: Job): string {
  if (!job.startedAt) return "—";
  const start = new Date(job.startedAt).getTime();
  const end = job.completedAt
    ? new Date(job.completedAt).getTime()
    : Date.now();
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

export default function JobDetail() {
  const [, params] = useRoute<{ id: string }>("/system/jobs/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const jobId = params?.id ?? "";

  const { data, isLoading, isError, error } = useGetJob(jobId, {
    query: {
      queryKey: getGetJobQueryKey(jobId),
      enabled: jobId.length > 0,
    },
  });

  const retry = useRetryJob({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "Job re-queued",
          description: `New job ${resp.jobId} enqueued (${resp.status}).`,
        });
        // Invalidate every surface that lists this job so the operator
        // sees the new pending row immediately.
        void queryClient.invalidateQueries({
          queryKey: getListJobsQueryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: getListRecentlyFailedJobsQueryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: getGetJobQueryKey(jobId),
        });
        // Pivot to the freshly-enqueued job so the operator can watch
        // it succeed (or fail again).
        setLocation(`/system/jobs/${encodeURIComponent(resp.jobId)}`);
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Could not retry job",
          description:
            err instanceof Error ? err.message : "Unknown error",
        });
      },
    },
  });

  const payloadJson = useMemo(() => {
    const p = data?.payload as Record<string, unknown> | undefined;
    if (!p) return "";
    try {
      return JSON.stringify(p, null, 2);
    } catch {
      return "[unserializable payload]";
    }
  }, [data?.payload]);

  if (!jobId) {
    return (
      <div className="p-8 text-sm text-destructive">No job id in URL.</div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-8 text-sm text-muted-foreground" data-testid="job-detail-loading">
        Loading job…
      </div>
    );
  }

  if (isError || !data) {
    const msg =
      error instanceof Error ? error.message : "Could not load this job.";
    return (
      <div className="p-8 space-y-4" data-testid="job-detail-error">
        <Link
          href="/system"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground gap-1"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to System &amp; Jobs
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Job not found</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>{msg}</p>
            <p className="mt-2">
              The job may have been pruned (failed jobs are kept for 30
              days by default) or it belongs to a different workspace.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const StatusIcon = STATUS_ICON[data.status] ?? AlertCircle;
  const kindLabel = KIND_LABEL[data.kind] ?? data.kind;

  return (
    <div className="p-8 space-y-6" data-testid="job-detail-page">
      <div>
        <Link
          href="/system"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground gap-1"
          data-testid="job-detail-back"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to System &amp; Jobs
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            Job
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            data-testid="job-detail-title"
          >
            {kindLabel}
          </h1>
          <code
            className="mt-1 inline-block text-xs text-muted-foreground"
            data-testid="job-detail-id"
          >
            {data.id}
          </code>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            className={STATUS_BADGE[data.status] ?? ""}
            data-testid="job-detail-status"
          >
            <StatusIcon className="w-3 h-3 mr-1 inline" />
            {data.status}
          </Badge>
          {data.status === "failed" ? (
            <Button
              size="sm"
              variant="default"
              data-testid="job-detail-retry"
              disabled={retry.isPending}
              onClick={() => retry.mutate({ id: data.id })}
            >
              {retry.isPending ? (
                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              ) : (
                <RotateCw className="w-3.5 h-3.5 mr-1" />
              )}
              Retry
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Lifecycle</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            <Row label="Enqueued" value={formatDateTime(data.enqueuedAt)} />
            <Row label="Started" value={formatDateTime(data.startedAt)} />
            <Row label="Completed" value={formatDateTime(data.completedAt)} />
            <Row label="Duration" value={durationLabel(data)} />
            <Row
              label="Attempts"
              value={`${data.attempts} / ${data.maxAttempts}`}
            />
            {data.scheduledFor ? (
              <Row
                label="Next attempt"
                value={formatDateTime(data.scheduledFor)}
              />
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Identity</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            <Row label="Kind" value={data.kind} />
            <Row
              label="Org"
              value={
                data.orgId ?? (
                  <span className="text-muted-foreground italic">
                    system-scoped
                  </span>
                )
              }
            />
            <Row
              label="Cancel requested"
              value={data.cancelRequested ? "yes" : "no"}
            />
          </CardContent>
        </Card>
      </div>

      {data.error ? (
        <Card data-testid="job-detail-error-card" className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-destructive" />
              Error
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TruncatedError
              message={data.error}
              copyContext={{
                fileName: undefined,
                entity: kindLabel,
                timestamp: data.completedAt
                  ? new Date(data.completedAt)
                  : new Date(),
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card data-testid="job-detail-payload-card">
        <CardHeader>
          <CardTitle className="text-sm">Payload (redacted)</CardTitle>
        </CardHeader>
        <CardContent>
          {payloadJson ? (
            <pre
              data-testid="job-detail-payload"
              className="font-mono text-xs whitespace-pre-wrap break-words max-h-96 overflow-auto rounded border bg-muted/40 p-3"
            >
              {payloadJson}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">
              This job carried no payload.
            </p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Credential-shaped fields (passwords, tokens, secrets, API keys)
            are replaced with <code>[REDACTED]</code> server-side before
            this view ever sees them.
          </p>
        </CardContent>
      </Card>

      {data.result ? (
        <Card data-testid="job-detail-result-card">
          <CardHeader>
            <CardTitle className="text-sm">Result</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="font-mono text-xs whitespace-pre-wrap break-words max-h-96 overflow-auto rounded border bg-muted/40 p-3">
              {JSON.stringify(data.result, null, 2)}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-sm tabular-nums text-right">{value}</span>
    </div>
  );
}
