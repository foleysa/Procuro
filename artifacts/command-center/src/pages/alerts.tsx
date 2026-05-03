import { useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { parseFilters, firstFilterValue } from "@/lib/url-filters";
import {
  useListAlerts,
  useGetAlertsSummary,
  useTransitionAlert,
  useListAlertEvents,
  useListAlertDeliveries,
  getListAlertsQueryKey,
  getGetAlertsSummaryQueryKey,
  getGetAlertQueryKey,
  getListAlertEventsQueryKey,
  getListAlertDeliveriesQueryKey,
  type Alert,
  type AlertSeverity,
  type AlertSource,
  type AlertState,
  type ListAlertsParams,
} from "@workspace/api-client-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  RefreshCw,
  Loader2,
  ArrowUpRight,
  History,
  Send,
  Siren,
  X,
  Activity,
} from "lucide-react";

const POLL_MS = 15_000;

const SEVERITY_OPTS: { v: "all" | AlertSeverity; l: string }[] = [
  { v: "all", l: "All severities" },
  { v: "critical", l: "Critical" },
  { v: "high", l: "High" },
  { v: "medium", l: "Medium" },
  { v: "low", l: "Low" },
  { v: "info", l: "Info" },
];

const STATE_OPTS: { v: "all" | AlertState; l: string }[] = [
  { v: "all", l: "All states" },
  { v: "open", l: "Open" },
  { v: "acknowledged", l: "Acknowledged" },
  { v: "snoozed", l: "Snoozed" },
  { v: "resolved", l: "Resolved" },
];

const SOURCE_OPTS: { v: "all" | AlertSource; l: string }[] = [
  { v: "all", l: "All sources" },
  { v: "sanctions", l: "Sanctions" },
  { v: "corporate_filing", l: "Corporate filings" },
  { v: "disruption_event", l: "Disruption events" },
  { v: "natural_hazard", l: "Natural hazards" },
  { v: "risk_screening", l: "Risk screening" },
  { v: "operational_job_failed", l: "Op: failed jobs" },
  { v: "operational_collector_stale", l: "Op: stale collectors" },
  { v: "operational_collector_never_run", l: "Op: never-run collectors" },
  { v: "operational_high_confidence_opportunity", l: "Op: high-conf opps" },
  { v: "rule_match", l: "Rule match" },
  { v: "manual", l: "Manual" },
];

export default function Alerts() {
  const qc = useQueryClient();
  const { toast } = useToast();

  // #209 step 7: deep-links from the Today aggregator land here with
  // `?filter=state:open&filter=severity:critical` etc. Whitelist three
  // keys (`state`, `severity`, `source`); anything else is ignored.
  // Multi-value `severity` collapses to the first match because the
  // page's UI only renders a single-select (a future multi-select
  // would consume the full Set instead). Initial-state-only — manual
  // filter changes do not write back to the URL, by design (we don't
  // want bookmark drift).
  //
  // #161: the war-room cross-link adds a fourth key,
  // `marketSignalId`, that scopes the inbox to alerts triggered by a
  // single Fusion event. Unlike severity/state/source it has no
  // matching dropdown — it's always sticky for the lifetime of the
  // mounted page (so the user can keep flipping severity/state while
  // staying scoped to that event), and a banner offers a one-click
  // "clear" that drops the filter without rewriting the URL.
  const search = useSearch();
  const initial = useMemo(() => {
    const f = parseFilters(search);
    const validSeverity = new Set<AlertSeverity>([
      "info",
      "low",
      "medium",
      "high",
      "critical",
    ]);
    const validState = new Set<AlertState>([
      "open",
      "acknowledged",
      "snoozed",
      "resolved",
    ]);
    const sev = firstFilterValue(f, "severity", "all");
    const st = firstFilterValue(f, "state", "open");
    const eventId = firstFilterValue(f, "marketSignalId", "");
    // Mirror the server-side prefix guard so a malformed deep-link
    // never gets passed to the API as a filter (which would silently
    // return zero rows and confuse the operator).
    const isValidSignalId = /^sig_[A-Za-z0-9_-]{1,64}$/.test(eventId);
    return {
      severity: validSeverity.has(sev as AlertSeverity)
        ? (sev as AlertSeverity)
        : ("all" as const),
      state: validState.has(st as AlertState)
        ? (st as AlertState)
        : ("open" as const),
      marketSignalId: isValidSignalId ? eventId : null,
    };
    // Initial state captured once; subsequent URL edits don't reflow
    // local state (intentional — same as opportunities.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [severity, setSeverity] = useState<"all" | AlertSeverity>(
    initial.severity,
  );
  const [state, setState] = useState<"all" | AlertState>(initial.state);
  const [source, setSource] = useState<"all" | AlertSource>("all");
  const [marketSignalId, setMarketSignalId] = useState<string | null>(
    initial.marketSignalId,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const params: ListAlertsParams = useMemo(() => {
    const p: ListAlertsParams = { limit: 200 };
    if (severity !== "all") p.severity = severity;
    if (state !== "all") p.state = state;
    if (source !== "all") p.source = source;
    if (marketSignalId) p.marketSignalId = marketSignalId;
    return p;
  }, [severity, state, source, marketSignalId]);

  const alertsQ = useListAlerts(params, {
    query: {
      queryKey: getListAlertsQueryKey(params),
      refetchInterval: POLL_MS,
    },
  });
  const summaryQ = useGetAlertsSummary({
    query: {
      queryKey: getGetAlertsSummaryQueryKey(),
      refetchInterval: POLL_MS,
    },
  });

  const alerts = alertsQ.data?.items ?? [];
  const selected = alerts.find((a) => a.id === selectedId) ?? null;

  const transition = useTransitionAlert({
    mutation: {
      onSuccess: (_, vars) => {
        qc.invalidateQueries({ queryKey: getListAlertsQueryKey(params) });
        qc.invalidateQueries({ queryKey: getGetAlertsSummaryQueryKey() });
        qc.invalidateQueries({ queryKey: getGetAlertQueryKey(vars.id) });
        qc.invalidateQueries({
          queryKey: getListAlertEventsQueryKey(vars.id),
        });
        toast({ title: "Alert updated" });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not update alert",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const summary = summaryQ.data;
  const open = summary?.byState?.open ?? 0;
  const acked = summary?.byState?.acknowledged ?? 0;
  const snoozed = summary?.byState?.snoozed ?? 0;
  const criticalOrHigh = summary?.openCriticalOrHigh ?? 0;

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            data-testid="text-page-title"
            className="text-3xl font-bold flex items-center gap-3"
          >
            <Bell className="w-7 h-7 text-primary" />
            Alerts
            {alertsQ.isFetching && (
              <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            Inbox of supplier risk, market disruption, and operational signals.
            Auto-refreshes every 15s.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => qc.invalidateQueries()}
          data-testid="button-refresh-alerts"
        >
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard
          label="Open"
          value={open}
          icon={AlertTriangle}
          tone={open > 0 ? "amber" : "muted"}
        />
        <SummaryCard
          label="Critical / High open"
          value={criticalOrHigh}
          icon={AlertTriangle}
          tone={criticalOrHigh > 0 ? "red" : "muted"}
        />
        <SummaryCard
          label="Acknowledged"
          value={acked}
          icon={CheckCircle2}
          tone={acked > 0 ? "blue" : "muted"}
        />
        <SummaryCard
          label="Snoozed"
          value={snoozed}
          icon={Clock}
          tone={snoozed > 0 ? "muted" : "muted"}
        />
      </div>

      {marketSignalId && (
        <Card
          className="border-primary/30 bg-primary/5"
          data-testid="banner-event-filter"
        >
          <CardContent className="py-3 text-sm flex items-center justify-between gap-3 flex-wrap">
            <span className="flex items-center gap-2 min-w-0">
              <Siren className="w-4 h-4 text-primary shrink-0" />
              <span className="truncate">
                Filtered to alerts triggered by stream event{" "}
                <span className="font-mono text-foreground">
                  {marketSignalId}
                </span>
              </span>
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <Link
                href={`/fusion?tab=events&eventId=${encodeURIComponent(
                  marketSignalId,
                )}`}
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                data-testid="link-open-event-in-war-room"
              >
                Open in War Room <ArrowUpRight className="w-3 h-3" />
              </Link>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setMarketSignalId(null)}
                data-testid="button-clear-event-filter"
              >
                <X className="w-3 h-3 mr-1" /> Clear
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 gap-3 flex-wrap">
          <CardTitle className="text-base">Inbox</CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={state}
              onValueChange={(v) => setState(v as typeof state)}
            >
              <SelectTrigger
                className="w-[150px]"
                data-testid="select-state"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATE_OPTS.map((o) => (
                  <SelectItem key={o.v} value={o.v}>
                    {o.l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={severity}
              onValueChange={(v) => setSeverity(v as typeof severity)}
            >
              <SelectTrigger
                className="w-[150px]"
                data-testid="select-severity"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_OPTS.map((o) => (
                  <SelectItem key={o.v} value={o.v}>
                    {o.l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={source}
              onValueChange={(v) => setSource(v as typeof source)}
            >
              <SelectTrigger
                className="w-[200px]"
                data-testid="select-source"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_OPTS.map((o) => (
                  <SelectItem key={o.v} value={o.v}>
                    {o.l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {alertsQ.isLoading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading alerts…
            </div>
          ) : alerts.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" /> No alerts
              match your filters. Either nothing is firing or you've already
              triaged everything — both are good.
            </div>
          ) : (
            <ul className="divide-y" data-testid="list-alerts">
              {alerts.map((a) => (
                <AlertRow
                  key={a.id}
                  alert={a}
                  onOpen={() => setSelectedId(a.id)}
                  onAck={() =>
                    transition.mutate({
                      id: a.id,
                      data: { action: "ack" },
                    })
                  }
                  onResolve={() =>
                    transition.mutate({
                      id: a.id,
                      data: { action: "resolve" },
                    })
                  }
                  onSnooze={() => {
                    const until = new Date(
                      Date.now() + 24 * 60 * 60 * 1000,
                    ).toISOString();
                    transition.mutate({
                      id: a.id,
                      data: { action: "snooze", snoozedUntil: until },
                    });
                  }}
                  onReopen={() =>
                    transition.mutate({
                      id: a.id,
                      data: { action: "reopen" },
                    })
                  }
                  busy={
                    transition.isPending && transition.variables?.id === a.id
                  }
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDetailDialog
        alert={selected}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}

// ---------- Row & detail ----------

function AlertRow({
  alert,
  onOpen,
  onAck,
  onResolve,
  onSnooze,
  onReopen,
  busy,
}: {
  alert: Alert;
  onOpen: () => void;
  onAck: () => void;
  onResolve: () => void;
  onSnooze: () => void;
  onReopen: () => void;
  busy: boolean;
}) {
  const isOpen = alert.state === "open";
  const isAcked = alert.state === "acknowledged";
  const isSnoozed = alert.state === "snoozed";
  const isResolved = alert.state === "resolved";

  return (
    <li
      className="py-3 flex items-start gap-3"
      data-testid={`row-alert-${alert.id}`}
    >
      <SeverityChip severity={alert.severity} />
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={onOpen}
          className="text-left w-full"
          data-testid={`button-open-alert-${alert.id}`}
        >
          <div className="text-sm font-medium hover:underline truncate">
            {alert.title}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {alert.summary}
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <Badge variant="outline" className="text-[10px]">
              {labelForSource(alert.source)}
            </Badge>
            <StateBadge state={alert.state} />
            {alert.occurrences > 1 && (
              <Badge variant="outline" className="text-[10px]">
                ×{alert.occurrences}
              </Badge>
            )}
            <span className="text-[10px] text-muted-foreground">
              {timeAgo(alert.lastSeenAt)}
              {alert.snoozedUntil
                ? ` · snoozed until ${formatShort(alert.snoozedUntil)}`
                : ""}
            </span>
          </div>
        </button>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {/* "Open Engine Telemetry" one-click CTA for the Engine Stalled
            alert rule (#286). The payload carries ctaUrl/ctaLabel so
            future alert rules can also get deep-link CTAs without code
            changes. */}
        {alert.kind === "engine_stalled" && (
          <Link
            href={
              typeof (alert.payload as Record<string, unknown> | null)?.["ctaUrl"] === "string"
                ? (alert.payload as Record<string, string>)["ctaUrl"]
                : "/?health=open"
            }
            className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 rounded px-2 py-1 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
            data-testid={`btn-open-engine-telemetry-${alert.id}`}
          >
            <Activity className="w-3 h-3" />
            Open Engine Telemetry
          </Link>
        )}
        {isOpen && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={onAck}
              disabled={busy}
              data-testid={`button-ack-${alert.id}`}
            >
              Ack
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onSnooze}
              disabled={busy}
              data-testid={`button-snooze-${alert.id}`}
            >
              Snooze 24h
            </Button>
          </>
        )}
        {(isOpen || isAcked || isSnoozed) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onResolve}
            disabled={busy}
            data-testid={`button-resolve-${alert.id}`}
          >
            Resolve
          </Button>
        )}
        {isResolved && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReopen}
            disabled={busy}
            data-testid={`button-reopen-${alert.id}`}
          >
            Reopen
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpen}
          aria-label="Open"
          data-testid={`button-detail-${alert.id}`}
        >
          <ArrowUpRight className="w-4 h-4" />
        </Button>
      </div>
    </li>
  );
}

function AlertDetailDialog({
  alert,
  onClose,
}: {
  alert: Alert | null;
  onClose: () => void;
}) {
  const id = alert?.id ?? "";
  const eventsQ = useListAlertEvents(id, {
    query: {
      queryKey: getListAlertEventsQueryKey(id),
      enabled: Boolean(id),
    },
  });
  const deliveriesQ = useListAlertDeliveries(id, {
    query: {
      queryKey: getListAlertDeliveriesQueryKey(id),
      enabled: Boolean(id),
    },
  });

  // #161: alerts produced by the collector fan-out stamp
  // `payload.marketSignalId` (and the array form `payload.marketSignalIds`)
  // with the originating Fusion war-room event id. Surface the link
  // so an analyst triaging an alert can pivot back to the raw stream
  // event in one click. We accept either shape — array first because
  // a future multi-source alert composer may set only the array.
  const relatedEventIds = useMemo<string[]>(() => {
    const p = (alert?.payload ?? {}) as Record<string, unknown>;
    const arr = p["marketSignalIds"];
    if (Array.isArray(arr)) {
      return arr.filter((v): v is string => typeof v === "string");
    }
    const single = p["marketSignalId"];
    return typeof single === "string" ? [single] : [];
  }, [alert?.payload]);

  return (
    <Dialog open={Boolean(alert)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-2xl max-h-[85vh] overflow-y-auto"
        data-testid="dialog-alert-detail"
      >
        <DialogHeader>
          <DialogTitle className="flex items-start gap-3 pr-6">
            {alert && <SeverityChip severity={alert.severity} />}
            <span className="flex-1">{alert?.title ?? ""}</span>
          </DialogTitle>
        </DialogHeader>
        {alert && (
          <div className="space-y-4 text-sm">
            <div className="text-muted-foreground whitespace-pre-wrap">
              {alert.summary}
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <KvRow label="Source" value={labelForSource(alert.source)} />
              <KvRow label="Kind" value={alert.kind} />
              <KvRow label="State" value={alert.state} />
              <KvRow label="Occurrences" value={String(alert.occurrences)} />
              <KvRow label="First seen" value={formatShort(alert.firstSeenAt)} />
              <KvRow label="Last seen" value={formatShort(alert.lastSeenAt)} />
              {alert.dedupeKey && (
                <KvRow label="Dedupe key" value={alert.dedupeKey} />
              )}
              {alert.supplierId && (
                <KvRow label="Supplier" value={alert.supplierId} />
              )}
              {alert.entityUid && (
                <KvRow label="Entity UID" value={alert.entityUid} />
              )}
              {alert.opportunityId && (
                <KvRow
                  label="Opportunity"
                  value={alert.opportunityId}
                  link={`/opportunities/${alert.opportunityId}`}
                />
              )}
            </div>

            {relatedEventIds.length > 0 && (
              <section data-testid="section-related-events">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Siren className="w-3.5 h-3.5" /> Related stream event
                  {relatedEventIds.length === 1 ? "" : "s"}
                </h3>
                <ul className="space-y-1.5">
                  {relatedEventIds.map((evtId) => (
                    <li
                      key={evtId}
                      className="text-xs flex items-center justify-between gap-2 border rounded p-2"
                      data-testid={`related-event-${evtId}`}
                    >
                      <span className="font-mono truncate">{evtId}</span>
                      <Link
                        href={`/fusion?tab=events&eventId=${encodeURIComponent(
                          evtId,
                        )}`}
                        className="text-primary hover:underline inline-flex items-center gap-1 shrink-0"
                        data-testid={`link-event-${evtId}`}
                      >
                        Open in War Room <ArrowUpRight className="w-3 h-3" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {alert.payload && Object.keys(alert.payload).length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Raw payload
                </summary>
                <pre className="mt-2 bg-muted/40 rounded p-2 overflow-x-auto text-[11px]">
                  {JSON.stringify(alert.payload, null, 2)}
                </pre>
              </details>
            )}

            <section>
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" /> Activity
              </h3>
              {eventsQ.isLoading ? (
                <div className="text-xs text-muted-foreground">Loading…</div>
              ) : (eventsQ.data?.items ?? []).length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No activity recorded yet.
                </div>
              ) : (
                <ul className="space-y-1.5" data-testid="list-alert-events">
                  {(eventsQ.data?.items ?? []).map((e) => (
                    <li key={e.id} className="text-xs flex items-start gap-2">
                      <span className="text-muted-foreground tabular-nums shrink-0">
                        {formatShort(e.createdAt)}
                      </span>
                      <span className="font-medium">{e.eventType}</span>
                      {e.actor && (
                        <span className="text-muted-foreground">
                          by {e.actor}
                        </span>
                      )}
                      {e.note && (
                        <span className="text-muted-foreground italic">
                          — {e.note}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                <Send className="w-3.5 h-3.5" /> Deliveries
              </h3>
              {deliveriesQ.isLoading ? (
                <div className="text-xs text-muted-foreground">Loading…</div>
              ) : (deliveriesQ.data?.items ?? []).length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No notification channels matched this alert (no
                  subscriptions, or all skipped).
                </div>
              ) : (
                <ul className="space-y-1.5" data-testid="list-alert-deliveries">
                  {(deliveriesQ.data?.items ?? []).map((d) => (
                    <li key={d.id} className="text-xs flex items-start gap-2">
                      <DeliveryStateBadge state={d.state} />
                      <span className="text-muted-foreground tabular-nums">
                        {d.sentAt ? formatShort(d.sentAt) : "—"}
                      </span>
                      <span className="text-muted-foreground">
                        attempts: {d.attempts}
                      </span>
                      {d.lastError && (
                        <span className="text-red-600 truncate">
                          {d.lastError}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- Sub-components ----------

function SummaryCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone: "red" | "amber" | "blue" | "muted";
}) {
  const toneCls: Record<string, string> = {
    red: "text-red-600 bg-red-50 dark:bg-red-950/40",
    amber: "text-amber-600 bg-amber-50 dark:bg-amber-950/40",
    blue: "text-blue-600 bg-blue-50 dark:bg-blue-950/40",
    muted: "text-muted-foreground bg-muted",
  };
  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="text-xs uppercase text-muted-foreground tracking-wide">
          {label}
        </div>
        <div className={`p-1.5 rounded ${toneCls[tone]}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
      </div>
      <div className="text-2xl font-bold mt-2 tabular-nums">{value}</div>
    </div>
  );
}

function SeverityChip({ severity }: { severity: AlertSeverity }) {
  const map: Record<AlertSeverity, { label: string; cls: string }> = {
    critical: {
      label: "CRIT",
      cls: "bg-red-600 text-white",
    },
    high: {
      label: "HIGH",
      cls: "bg-red-500/15 text-red-700 dark:text-red-300",
    },
    medium: {
      label: "MED",
      cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    },
    low: {
      label: "LOW",
      cls: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    },
    info: {
      label: "INFO",
      cls: "bg-muted text-muted-foreground",
    },
  };
  const m = map[severity] ?? map.info;
  return (
    <span
      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function StateBadge({ state }: { state: AlertState }) {
  const map: Record<AlertState, { label: string; cls: string }> = {
    open: {
      label: "Open",
      cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    },
    acknowledged: {
      label: "Acked",
      cls: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    },
    snoozed: {
      label: "Snoozed",
      cls: "bg-muted text-muted-foreground",
    },
    resolved: {
      label: "Resolved",
      cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    },
  };
  const m = map[state] ?? map.open;
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function DeliveryStateBadge({
  state,
}: {
  state: "pending" | "sent" | "failed" | "skipped";
}) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "pending", cls: "bg-muted text-muted-foreground" },
    sent: {
      label: "sent",
      cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    },
    failed: {
      label: "failed",
      cls: "bg-red-500/15 text-red-700 dark:text-red-300",
    },
    skipped: { label: "skipped", cls: "bg-muted text-muted-foreground" },
  };
  const m = map[state] ?? map.pending;
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function KvRow({
  label,
  value,
  link,
}: {
  label: string;
  value: string;
  link?: string;
}) {
  return (
    <div className="border rounded p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-medium truncate text-xs mt-0.5">
        {link ? (
          <a href={link} className="text-primary hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </div>
    </div>
  );
}

function labelForSource(s: AlertSource): string {
  const m = SOURCE_OPTS.find((o) => o.v === s);
  return m?.l ?? s;
}

function formatShort(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
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
  return `${days}d ${future ? "away" : "ago"}`;
}

