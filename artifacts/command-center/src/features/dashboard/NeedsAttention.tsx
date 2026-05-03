import { useMemo } from "react";
import { Link } from "wouter";
import {
  useListDeadLetterJobs,
  useRetryJob,
  useDiscardJob,
  getListDeadLetterJobsQueryKey,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, RotateCcw, Trash2, ArrowRight, Loader2 } from "lucide-react";

const POLL_MS = 30_000;

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

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

function ageLabel(completedAt: string | Date | null | undefined): string {
  if (!completedAt) return "—";
  const t =
    completedAt instanceof Date
      ? completedAt.getTime()
      : new Date(completedAt).getTime();
  if (!Number.isFinite(t)) return "—";
  const ms = Math.max(0, Date.now() - t);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

/**
 * "Needs attention" dashboard card for dead-letter jobs (#183).
 *
 * Surfaces every permanently-failed job for the active tenant with a
 * one-click retry / discard action. Without this card operators only
 * learned about dead-letter rows when an end user complained — the
 * existing `failed-jobs-banner` only shows the most recent failure
 * within a 24h window and explicitly does not let the user mutate the
 * row.
 *
 * Shows the kind, last error (truncated to one line), age, attempt
 * count, and links through to the System / Jobs detail page for full
 * context. Retry enqueues a fresh job of the same kind+payload via
 * `POST /jobs/:id/retry`; discard deletes the dead-letter row via
 * `POST /jobs/:id/discard`. Both invalidate the dead-letter query
 * after success so the list refreshes immediately.
 */
export function NeedsAttention() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const params = { limit: 20, offset: 0 } as const;
  const queryKey = getListDeadLetterJobsQueryKey(params);
  const query = useListDeadLetterJobs(params, {
    query: {
      queryKey,
      refetchInterval: POLL_MS,
      retry: false,
    },
  });

  const retryM = useRetryJob({
    mutation: {
      onSuccess: (resp, vars) => {
        toast({
          title: "Retry queued",
          description: `Job ${resp.jobId} is processing in the background (was ${vars.id}).`,
        });
        qc.invalidateQueries({ queryKey });
      },
      onError: (err: Error) =>
        toast({
          title: "Retry failed",
          description: String(err),
          variant: "destructive",
        }),
    },
  });

  const discardM = useDiscardJob({
    mutation: {
      onSuccess: (_resp, vars) => {
        toast({
          title: "Discarded",
          description: `Removed dead-letter job ${vars.id}.`,
        });
        qc.invalidateQueries({ queryKey });
      },
      onError: (err: Error) =>
        toast({
          title: "Discard failed",
          description: String(err),
          variant: "destructive",
        }),
    },
  });

  const total = query.data?.total ?? 0;
  const jobs = useMemo(() => query.data?.jobs ?? [], [query.data]);

  /**
   * #269 follow-up — Group near-identical dead-letter rows.
   *
   * Real-world tenants accumulate hundreds of repeats of the same
   * (kind, root-cause) pair (e.g. "Alert delivery / Failed query:
   * select id, org_id ..."). Listing each one individually drowns
   * the operator. We bucket by (kind + first 100 chars of the error
   * line) and render one row per bucket with a count badge. The
   * Retry / Discard buttons act on the most-recent job in the
   * bucket; clearing the underlying root cause typically unblocks
   * the rest, and the full per-job audit trail stays one click
   * away in System / Jobs.
   */
  const groups = useMemo(() => {
    const buckets = new Map<
      string,
      {
        key: string;
        kind: string;
        errorSample: string;
        rep: (typeof jobs)[number];
        count: number;
      }
    >();
    for (const j of jobs) {
      const errorOneLine = (j.error ?? "Job failed permanently")
        .split(/\r?\n/, 1)[0]!
        .trim();
      const sig = errorOneLine.slice(0, 100);
      const key = `${j.kind}::${sig}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        buckets.set(key, {
          key,
          kind: j.kind,
          errorSample: errorOneLine,
          rep: j,
          count: 1,
        });
      }
    }
    return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
  }, [jobs]);

  // Pending mutation tracking so individual rows show a spinner while
  // the action is in flight, without blocking the rest of the table.
  const pendingId =
    retryM.isPending && retryM.variables?.id
      ? retryM.variables.id
      : discardM.isPending && discardM.variables?.id
        ? discardM.variables.id
        : null;

  return (
    <Card data-testid="card-dead-letter-jobs">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <AlertOctagon className="w-5 h-5 text-rose-500" /> Dead-letter jobs
            {total > 0 ? (
              <Badge
                variant="destructive"
                className="ml-1"
                data-testid="badge-dead-letter-count"
              >
                {total}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            Background work that gave up after every retry. Grouped
            by error so you fix the root cause once instead of
            clicking 700 times. Click a job ID for its full trace.
          </CardDescription>
        </div>
        <Link
          href="/system?status=failed"
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0"
          data-testid="link-dead-letter-system"
        >
          Open System / Jobs <ArrowRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : query.isError ? (
          // Surface backend outages explicitly. Without this branch a
          // failed dead-letter query collapses into the "queue is
          // healthy" empty state, hiding the very condition operators
          // need to see.
          <div
            className="text-sm text-rose-600 dark:text-rose-400"
            data-testid="text-dead-letter-error"
          >
            Couldn't load dead-letter jobs:{" "}
            {String((query.error as Error | undefined)?.message ?? query.error)}
          </div>
        ) : jobs.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No permanently-failed jobs. The queue is healthy.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm"
              data-testid="table-dead-letter"
            >
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Kind</th>
                  <th className="py-2 pr-3 font-medium">Sample error</th>
                  <th className="py-2 pr-3 font-medium text-right">Count</th>
                  <th className="py-2 pr-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {groups.slice(0, 5).map((g) => {
                  const truncated =
                    g.errorSample.length > 140
                      ? `${g.errorSample.slice(0, 140)}…`
                      : g.errorSample;
                  const isPending = pendingId === g.rep.id;
                  return (
                    <tr
                      key={g.key}
                      data-testid={`row-dead-letter-group-${g.kind}`}
                    >
                      <td className="py-2 pr-3 align-top">
                        <div className="font-medium">{kindLabel(g.kind)}</div>
                        {/* #269 follow-up: per-job deep link restored
                            after code review. The grouped row links
                            to the most-recent representative job's
                            detail page so operators keep the same
                            drill-down they had before grouping. */}
                        <Link
                          href={`/system/jobs/${encodeURIComponent(g.rep.id)}`}
                          className="text-[11px] text-muted-foreground hover:text-foreground"
                          data-testid={`link-dead-letter-job-${g.rep.id}`}
                        >
                          <code>{g.rep.id}</code>
                        </Link>
                        <div className="text-[11px] text-muted-foreground">
                          most recent {ageLabel(g.rep.completedAt ?? g.rep.enqueuedAt)}
                        </div>
                      </td>
                      <td
                        className="py-2 pr-3 align-top text-xs text-muted-foreground max-w-md"
                        data-testid={`cell-dead-letter-error-${g.rep.id}`}
                      >
                        {truncated}
                      </td>
                      <td className="py-2 pr-3 align-top text-right">
                        <Badge variant="secondary" className="tabular-nums">
                          ×{g.count}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 align-top text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isPending}
                            onClick={() => retryM.mutate({ id: g.rep.id })}
                            data-testid={`button-retry-${g.rep.id}`}
                            title="Retry the most recent failure in this group"
                          >
                            {isPending && retryM.isPending ? (
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            ) : (
                              <RotateCcw className="w-3 h-3 mr-1" />
                            )}
                            Retry one
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isPending}
                            onClick={() => discardM.mutate({ id: g.rep.id })}
                            data-testid={`button-discard-${g.rep.id}`}
                            title="Discard the most recent failure in this group"
                          >
                            {isPending && discardM.isPending ? (
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            ) : (
                              <Trash2 className="w-3 h-3 mr-1" />
                            )}
                            Discard one
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="text-xs text-muted-foreground mt-2">
              {groups.length} unique error{groups.length === 1 ? "" : "s"} across{" "}
              {total} job{total === 1 ? "" : "s"}.{" "}
              <Link
                href="/system?status=failed"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Bulk retry / discard in System / Jobs
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
