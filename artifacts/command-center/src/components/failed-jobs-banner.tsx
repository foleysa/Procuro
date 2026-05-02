import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertCircle, ArrowRight, X } from "lucide-react";
import {
  useListRecentlyFailedJobs,
  getListRecentlyFailedJobsQueryKey,
} from "@workspace/api-client-react";
import { useMyRole } from "@/lib/use-my-role";

/**
 * Persistent admin notification banner for permanently-failed jobs (#94).
 *
 * Why this exists: with the auto-retry budget for unrecoverable errors
 * collapsed to one attempt (a malformed CSV or a bad mock-ERP feed
 * fails immediately and is not retried), the only place a permanent
 * failure surfaced before this was the System / Jobs page. Operators
 * who didn't routinely open that page would miss the failure entirely.
 *
 * Design choices:
 *   - **Admin-only.** The banner is gated behind `isOrgAdmin` because
 *     the System / Jobs page (where the operator clicks through) is
 *     itself admin-only — surfacing a "go fix this" prompt to a user
 *     who can't open the linked surface would be cruel.
 *   - **Per-job dismissal in localStorage.** Once an admin has seen a
 *     failure they shouldn't be re-notified about it on every page
 *     load, but a NEW failure should re-surface the banner. We track
 *     dismissed job-ids (not a global "dismissed at" timestamp) so
 *     each new failure breaks through.
 *   - **No deletion of the failure record.** Dismissal only hides the
 *     banner — the failed job row is still on the System / Jobs page
 *     and the alert subsystem still counts it. This is informational
 *     UI, not state mutation.
 *   - **Polled gently.** 60s refetch matches the operator's morning
 *     polling cadence on the Today page; we explicitly do not poll
 *     in the background to avoid an alert-fatigue spiral.
 *
 * The banner mounts inside `Layout` so it shows on every signed-in
 * page, immediately under the header — same slot pattern as the
 * existing migration banner.
 */

const STORAGE_KEY = "procuro.failed-jobs.dismissedIds";
const POLL_INTERVAL_MS = 60_000;

function loadDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((v) => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    // Cap the persisted list so a long-lived browser doesn't
    // accumulate unbounded localStorage. Most failures retire from
    // the lookback window in <24h; 200 ids is more than enough
    // headroom for normal operation.
    const arr = Array.from(ids).slice(-200);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // localStorage can throw on quota or in private browsing —
    // dismissal silently degrades to "renotify on next load",
    // which is the safer-for-the-operator failure mode anyway.
  }
}

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
  if (!completedAt) return "just now";
  const t =
    completedAt instanceof Date
      ? completedAt.getTime()
      : new Date(completedAt).getTime();
  if (!Number.isFinite(t)) return "just now";
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

export function FailedJobsBanner() {
  const { isOrgAdmin } = useMyRole();
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  // Only fetch when the viewer is actually an admin — non-admins can
  // never see this surface, and we don't want to spend a network
  // round-trip per page-load for nothing.
  const recentParams = { withinHours: 24, limit: 20 } as const;
  const query = useListRecentlyFailedJobs(recentParams, {
    query: {
      queryKey: getListRecentlyFailedJobsQueryKey(recentParams),
      enabled: isOrgAdmin,
      refetchInterval: POLL_INTERVAL_MS,
      // The banner is decorative — never block the rest of the page on it.
      retry: false,
    },
  });

  // Visible jobs = recently-failed jobs the user hasn't dismissed yet.
  // We deliberately recompute on every render rather than memoize on
  // `dismissed` AND `query.data` separately so a fresh fetch correctly
  // re-shows a previously-seen but still-failing id only when it was
  // explicitly un-dismissed (it never is — dismissal is sticky).
  const visible = useMemo(() => {
    const jobs = query.data?.jobs ?? [];
    return jobs.filter((j) => !dismissed.has(j.id));
  }, [query.data, dismissed]);

  // Garbage-collect dismissed ids that no longer appear in the
  // lookback window — once a failure has aged out of "recent" the
  // banner can never re-surface it, so keeping its id in localStorage
  // is just bloat.
  useEffect(() => {
    if (!query.data) return;
    const recentIds = new Set(query.data.jobs.map((j) => j.id));
    let changed = false;
    const kept = new Set<string>();
    for (const id of dismissed) {
      if (recentIds.has(id)) {
        kept.add(id);
      } else {
        changed = true;
      }
    }
    if (changed) {
      setDismissed(kept);
      saveDismissed(kept);
    }
  }, [query.data, dismissed]);

  if (!isOrgAdmin) return null;
  if (visible.length === 0) return null;

  // The banner shows the most recent failure inline (kind + age + first
  // line of error) plus a count if there are more. Clicking through
  // takes the operator to the job-detail view of the most recent
  // failure, which is the action they need >90% of the time. A
  // secondary "view all N failures" link sends them to the System
  // page filtered by status=failed.
  const top = visible[0]!;
  const errorOneLine = (top.error ?? "Job failed permanently")
    .split(/\r?\n/, 1)[0]!
    .trim();
  const truncated =
    errorOneLine.length > 200
      ? `${errorOneLine.slice(0, 200)}…`
      : errorOneLine;

  const dismissOne = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    saveDismissed(next);
  };

  const dismissAll = () => {
    const next = new Set(dismissed);
    for (const j of visible) next.add(j.id);
    setDismissed(next);
    saveDismissed(next);
  };

  return (
    <div
      data-testid="failed-jobs-banner"
      role="alert"
      className="border-b border-rose-200 bg-rose-50 px-8 py-2.5 text-sm text-rose-900"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2 min-w-0">
          <AlertCircle
            className="w-4 h-4 mt-0.5 shrink-0 text-rose-700"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="font-semibold">
              Job failed permanently
              {visible.length > 1 ? (
                <span
                  className="ml-2 inline-flex items-center rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-medium text-rose-800"
                  data-testid="failed-jobs-banner-count"
                >
                  +{visible.length - 1} more
                </span>
              ) : null}
            </div>
            <div
              className="text-xs text-rose-900/90 truncate"
              data-testid="failed-jobs-banner-summary"
            >
              <span className="font-medium">{kindLabel(top.kind)}</span>
              {" · "}
              <code className="text-[11px] text-rose-900/80">{top.id}</code>
              {" · "}
              {ageLabel(top.completedAt)} — {truncated}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Link
            href={`/system/jobs/${encodeURIComponent(top.id)}`}
            data-testid="failed-jobs-banner-link"
            className="inline-flex items-center gap-1 text-xs font-medium text-rose-900 hover:underline"
          >
            View details <ArrowRight className="w-3 h-3" />
          </Link>
          {visible.length > 1 ? (
            <Link
              href="/system?status=failed"
              data-testid="failed-jobs-banner-view-all"
              className="text-xs text-rose-900/80 hover:text-rose-900 hover:underline"
            >
              View all
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => dismissOne(top.id)}
            data-testid="failed-jobs-banner-dismiss"
            className="text-rose-900/70 hover:text-rose-900 inline-flex items-center gap-1 text-xs"
            aria-label="Dismiss this failure"
            title="Hide this failure (won't notify again)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
          {visible.length > 1 ? (
            <button
              type="button"
              onClick={dismissAll}
              data-testid="failed-jobs-banner-dismiss-all"
              className="text-[11px] text-rose-900/70 hover:text-rose-900 hover:underline"
            >
              Dismiss all
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
