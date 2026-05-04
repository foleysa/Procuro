import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import {
  useListOpportunities,
  useBulkApproveOpportunities,
  useBulkRejectOpportunities,
  useBulkSnoozeOpportunities,
  useBulkUnsnoozeOpportunities,
  getListOpportunitiesQueryKey,
  LeverId,
  ListOpportunitiesStatus,
  ListOpportunitiesSnoozed,
  ListOpportunitiesCanonicalStage,
  RejectionReasonCode,
  type Opportunity,
  type BulkOpportunityActionResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { parseFilters, firstFilterValue } from "@/lib/url-filters";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  formatUsd,
  formatPercent,
  leverLabel,
  REJECTION_REASON_LABELS,
} from "@/lib/format";
import {
  Loader2,
  Sparkles,
  ArrowRight,
  Check,
  X,
  Clock,
  RotateCcw,
  AlertTriangle,
  Lightbulb,
} from "lucide-react";

const STATUS_OPTS = [
  { v: "all", l: "All" },
  { v: ListOpportunitiesStatus.proposed, l: "Proposed" },
  { v: ListOpportunitiesStatus.approved, l: "Approved" },
  { v: ListOpportunitiesStatus.executing, l: "Executing" },
  { v: ListOpportunitiesStatus.realized, l: "Realized" },
  { v: ListOpportunitiesStatus.rejected, l: "Rejected" },
  { v: ListOpportunitiesStatus.expired, l: "Expired" },
  { v: "snoozed", l: "Snoozed" },
];

const CONFIRM_THRESHOLD = 25;
const MAX_BULK = 1000;

type PendingAction =
  | { kind: "approve"; notes?: string }
  | { kind: "reject"; reasonCode: RejectionReasonCode; reasonText?: string }
  | { kind: "snooze"; snoozedUntil: string }
  | { kind: "unsnooze" };

const SNOOZE_PRESETS: Array<{ label: string; days: number }> = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

function isoFromDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function formatSnoozeBadge(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d`;
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)));
  return `${hours}h`;
}

export default function Opportunities() {
  // #209 step 7: deep-links from the Today aggregator land here with
  // `?filter=status:proposed&filter=leverId:spot_vs_contract`.
  const search = useSearch();
  const initial = useMemo(() => {
    const f = parseFilters(search);
    const validStatus = new Set<string>(Object.values(ListOpportunitiesStatus));
    const validLever = new Set<string>(Object.values(LeverId));
    const status = firstFilterValue(f, "status", "all");
    const lever = firstFilterValue(f, "leverId", "all");
    return {
      status: validStatus.has(status) ? status : "all",
      lever: validLever.has(lever) ? lever : "all",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [statusFilter, setStatusFilter] = useState<string>(initial.status);
  const [leverFilter, setLeverFilter] = useState<string>(initial.lever);
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingAction | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string | number> = { limit: 200 };
    if (statusFilter === "snoozed") {
      p.status = ListOpportunitiesStatus.proposed;
      p.snoozed = ListOpportunitiesSnoozed.only;
    } else {
      if (statusFilter !== "all") p.status = statusFilter;
      // Default `snoozed=exclude` is server-side; no need to set explicitly.
    }
    if (leverFilter !== "all") p.leverId = leverFilter;
    if (stageFilter !== "all") p.canonicalStage = stageFilter;
    return p as never;
  }, [statusFilter, leverFilter, stageFilter]);

  const { data, isLoading, error } = useListOpportunities(params);
  const allItems = data?.items ?? [];

  // Drop selections that no longer exist after filter/data changes.
  useEffect(() => {
    if (selected.size === 0) return;
    const visible = new Set(allItems.map((o) => o.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of selected) {
      if (visible.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelected(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const grouped = useMemo(() => {
    const groups: Record<string, Opportunity[]> = {};
    for (const opp of allItems) {
      (groups[opp.leverId] ??= []).push(opp);
    }
    for (const arr of Object.values(groups)) {
      arr.sort((a, b) => b.projectedSavingsUsd - a.projectedSavingsUsd);
    }
    return Object.entries(groups).sort(
      (a, b) =>
        b[1].reduce((s, o) => s + o.projectedSavingsUsd, 0) -
        a[1].reduce((s, o) => s + o.projectedSavingsUsd, 0),
    );
  }, [allItems]);

  const totalProj = allItems.reduce((s, o) => s + o.projectedSavingsUsd, 0);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setSelection = (ids: string[], add: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (add) for (const id of ids) next.add(id);
      else for (const id of ids) next.delete(id);
      return next;
    });
  };

  const allVisibleIds = allItems.map((o) => o.id);
  const allChecked =
    allVisibleIds.length > 0 && allVisibleIds.every((id) => selected.has(id));
  const someChecked = !allChecked && allVisibleIds.some((id) => selected.has(id));

  const requestAction = (a: PendingAction) => {
    if (selected.size === 0) return;
    setPending(a);
  };

  return (
    <div className="p-8 pb-32 space-y-6 max-w-7xl">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1
            data-testid="text-page-title"
            className="text-3xl font-bold flex items-center gap-2"
          >
            <Sparkles className="w-7 h-7 text-primary" />
            Opportunities Feed
          </h1>
          <p className="text-muted-foreground mt-1">
            {allItems.length} opportunities ·{" "}
            {formatUsd(totalProj, { compact: true })} projected
          </p>
        </div>

        <div className="flex gap-2">
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              setSelected(new Set());
            }}
          >
            <SelectTrigger className="w-[160px]" data-testid="filter-status" aria-label="Filter by status">
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

          <Select
            value={leverFilter}
            onValueChange={(v) => {
              setLeverFilter(v);
              setSelected(new Set());
            }}
          >
            <SelectTrigger className="w-[260px]" data-testid="filter-lever" aria-label="Filter by lever">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All levers</SelectItem>
              {Object.values(LeverId).map((id) => (
                <SelectItem key={id} value={id}>
                  {leverLabel(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={stageFilter}
            onValueChange={(v) => {
              setStageFilter(v);
              setSelected(new Set());
            }}
          >
            <SelectTrigger className="w-[200px]" data-testid="filter-stage" aria-label="Filter by stage">
              <SelectValue placeholder="All stages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              {Object.values(ListOpportunitiesCanonicalStage).map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {allItems.length > 0 && (
        <div className="flex items-center gap-3 px-2 text-sm">
          <Checkbox
            checked={allChecked ? true : someChecked ? "indeterminate" : false}
            onCheckedChange={(v) =>
              setSelection(allVisibleIds, v === true)
            }
            data-testid="select-all-global"
            aria-label="Select all visible opportunities"
          />
          <span className="text-muted-foreground">
            {selected.size > 0
              ? `${selected.size} selected`
              : `Select rows to act in bulk`}
          </span>
          {selected.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => setSelected(new Set())}
              data-testid="button-clear-selection"
            >
              Clear
            </Button>
          )}
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      )}
      {error && (
        <div className="text-destructive">Failed to load opportunities.</div>
      )}

      {grouped.length === 0 && !isLoading && (
        <div className="bg-card border rounded-lg p-12 text-center space-y-2">
          <Lightbulb className="w-8 h-8 mx-auto text-muted-foreground/40" />
          <div className="font-medium">
            {statusFilter === "snoozed"
              ? "Nothing snoozed"
              : "No opportunities found"}
          </div>
          <div className="text-sm text-muted-foreground max-w-sm mx-auto">
            {statusFilter === "snoozed"
              ? "Snoozed opportunities will appear here when you snooze them from the detail page."
              : "Opportunities are generated by analysis cycles. Run a cycle from the dashboard or wait for the next scheduled run."}
          </div>
        </div>
      )}

      {grouped.map(([lever, opps]) => {
        const sum = opps.reduce((s, o) => s + o.projectedSavingsUsd, 0);
        const ids = opps.map((o) => o.id);
        const allInGroup = ids.every((id) => selected.has(id));
        const someInGroup =
          !allInGroup && ids.some((id) => selected.has(id));
        return (
          <Card key={lever} data-testid={`group-${lever}`}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-3">
                  <Checkbox
                    checked={
                      allInGroup
                        ? true
                        : someInGroup
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(v) => setSelection(ids, v === true)}
                    data-testid={`select-group-${lever}`}
                    aria-label={`Select all in ${leverLabel(lever)}`}
                  />
                  <span>{leverLabel(lever)}</span>
                </span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {opps.length} opps · {formatUsd(sum, { compact: true })}{" "}
                  projected
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {opps.map((opp) => (
                <OppRow
                  key={opp.id}
                  opp={opp}
                  selected={selected.has(opp.id)}
                  onToggle={() => toggle(opp.id)}
                />
              ))}
            </CardContent>
          </Card>
        );
      })}

      {selected.size > 0 && (
        <BulkActionBar
          count={selected.size}
          onApprove={() => requestAction({ kind: "approve" })}
          onReject={() =>
            requestAction({
              kind: "reject",
              reasonCode: RejectionReasonCode.savings_overstated,
            })
          }
          onSnooze={() =>
            requestAction({ kind: "snooze", snoozedUntil: isoFromDays(7) })
          }
          onUnsnooze={() => requestAction({ kind: "unsnooze" })}
        />
      )}

      {pending && (
        <BulkActionDialog
          ids={Array.from(selected)}
          action={pending}
          onChange={setPending}
          onClose={(clearSelection) => {
            setPending(null);
            if (clearSelection) setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}

function BulkActionBar({
  count,
  onApprove,
  onReject,
  onSnooze,
  onUnsnooze,
}: {
  count: number;
  onApprove: () => void;
  onReject: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
}) {
  const oversize = count > MAX_BULK;
  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-card border rounded-full shadow-lg px-4 py-2 flex items-center gap-2"
      data-testid="bulk-action-bar"
    >
      <span className="text-sm font-medium pr-2 border-r mr-1">
        {count} selected
      </span>
      {oversize && (
        <span className="text-xs text-destructive pr-2">
          Max {MAX_BULK} per action
        </span>
      )}
      <Button
        size="sm"
        variant="default"
        disabled={oversize}
        onClick={onApprove}
        data-testid="button-bulk-approve"
      >
        <Check className="w-4 h-4 mr-1" />
        Approve
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={oversize}
        onClick={onReject}
        data-testid="button-bulk-reject"
      >
        <X className="w-4 h-4 mr-1" />
        Reject
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={oversize}
        onClick={onSnooze}
        data-testid="button-bulk-snooze"
      >
        <Clock className="w-4 h-4 mr-1" />
        Snooze
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={oversize}
        onClick={onUnsnooze}
        data-testid="button-bulk-unsnooze"
      >
        <RotateCcw className="w-4 h-4 mr-1" />
        Unsnooze
      </Button>
    </div>
  );
}

function BulkActionDialog({
  ids,
  action,
  onChange,
  onClose,
}: {
  ids: string[];
  action: PendingAction;
  onChange: (a: PendingAction) => void;
  onClose: (clearSelection: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirmedLarge, setConfirmedLarge] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListOpportunitiesQueryKey() });
    qc.invalidateQueries({ queryKey: ["getToday"] });
    qc.invalidateQueries({ queryKey: ["listCycles"] });
  };

  const verb =
    action.kind === "approve"
      ? "Approve"
      : action.kind === "reject"
        ? "Reject"
        : action.kind === "snooze"
          ? "Snooze"
          : "Unsnooze";

  const summarize = (r: BulkOpportunityActionResult) => {
    const bits = [`${r.succeeded} succeeded`];
    if (r.skippedWrongStatus) bits.push(`${r.skippedWrongStatus} skipped`);
    if (r.skippedNoPermission) bits.push(`${r.skippedNoPermission} no perm`);
    if (r.failed) bits.push(`${r.failed} failed`);
    return bits.join(" · ");
  };

  const onSuccess = (r: BulkOpportunityActionResult) => {
    toast({
      title: `${verb}: ${summarize(r)}`,
      description: `Requested ${r.requested} opportunities.`,
      variant: r.failed > 0 ? "destructive" : undefined,
    });
    invalidate();
    onClose(true);
  };

  const onError = (e: Error) =>
    toast({
      title: `${verb} failed`,
      description: String(e),
      variant: "destructive",
    });

  const approveM = useBulkApproveOpportunities({
    mutation: { onSuccess, onError },
  });
  const rejectM = useBulkRejectOpportunities({
    mutation: { onSuccess, onError },
  });
  const snoozeM = useBulkSnoozeOpportunities({
    mutation: { onSuccess, onError },
  });
  const unsnoozeM = useBulkUnsnoozeOpportunities({
    mutation: { onSuccess, onError },
  });

  const isPending =
    approveM.isPending ||
    rejectM.isPending ||
    snoozeM.isPending ||
    unsnoozeM.isPending;

  const needsConfirm = ids.length >= CONFIRM_THRESHOLD && !confirmedLarge;

  const submit = () => {
    if (needsConfirm) {
      setConfirmedLarge(true);
      return;
    }
    if (action.kind === "approve") {
      approveM.mutate({
        data: action.notes ? { ids, notes: action.notes } : { ids },
      });
    } else if (action.kind === "reject") {
      rejectM.mutate({
        data: {
          ids,
          reasonCode: action.reasonCode,
          ...(action.reasonText ? { reasonText: action.reasonText } : {}),
        },
      });
    } else if (action.kind === "snooze") {
      snoozeM.mutate({
        data: { ids, snoozedUntil: action.snoozedUntil },
      });
    } else {
      unsnoozeM.mutate({ data: { ids } });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent data-testid={`dialog-bulk-${action.kind}`}>
        <DialogHeader>
          <DialogTitle>
            {verb} {ids.length} opportunit{ids.length === 1 ? "y" : "ies"}
          </DialogTitle>
          <DialogDescription>
            Rows in the wrong status are silently skipped. Each affected row
            records an audit event.
          </DialogDescription>
        </DialogHeader>

        {action.kind === "approve" && (
          <div className="space-y-2">
            <Label htmlFor="bulk-approve-notes">Notes (optional)</Label>
            <Textarea
              id="bulk-approve-notes"
              value={action.notes ?? ""}
              onChange={(e) =>
                onChange({ kind: "approve", notes: e.target.value })
              }
              placeholder="Applied to every approved row."
              data-testid="input-bulk-approve-notes"
            />
          </div>
        )}

        {action.kind === "reject" && (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Reason</Label>
              <Select
                value={action.reasonCode}
                onValueChange={(v) =>
                  onChange({
                    ...action,
                    reasonCode: v as RejectionReasonCode,
                  })
                }
              >
                <SelectTrigger data-testid="select-bulk-reject-reason" aria-label="Bulk reject reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(RejectionReasonCode).map((code) => (
                    <SelectItem key={code} value={code}>
                      {REJECTION_REASON_LABELS[code] ?? code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulk-reject-note">Note (optional)</Label>
              <Textarea
                id="bulk-reject-note"
                value={action.reasonText ?? ""}
                onChange={(e) =>
                  onChange({ ...action, reasonText: e.target.value })
                }
                data-testid="input-bulk-reject-note"
              />
            </div>
          </div>
        )}

        {action.kind === "snooze" && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {SNOOZE_PRESETS.map((p) => {
                const iso = isoFromDays(p.days);
                return (
                  <Button
                    key={p.days}
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onChange({ kind: "snooze", snoozedUntil: iso })
                    }
                    data-testid={`snooze-preset-${p.days}d`}
                  >
                    {p.label}
                  </Button>
                );
              })}
            </div>
            <div className="space-y-2">
              <Label htmlFor="snooze-until">Snooze until</Label>
              <Input
                id="snooze-until"
                type="datetime-local"
                value={toLocalInputValue(action.snoozedUntil)}
                onChange={(e) =>
                  onChange({
                    kind: "snooze",
                    snoozedUntil: new Date(e.target.value).toISOString(),
                  })
                }
                data-testid="input-snooze-until"
              />
            </div>
          </div>
        )}

        {needsConfirm && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            You're about to {verb.toLowerCase()} {ids.length} rows. Click{" "}
            {verb} again to confirm.
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onClose(false)}
            disabled={isPending}
            data-testid="button-bulk-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={isPending}
            data-testid="button-bulk-confirm"
            variant={action.kind === "reject" ? "destructive" : "default"}
          >
            {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {needsConfirm ? `Confirm ${verb}` : verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Pull the supplier billing-currency code (ISO 4217) out of an FX
 * exposure title. The title is generated server-side as
 * `FX exposure: {supplier_name} ({CCC}) — ±X.XX% in {BASE} cost vs {PAIR}`
 * (see `artifacts/api-server/src/lib/levers/fx-exposure.ts`), so the
 * first `(XXX)` group is always the billing currency. Returns `null`
 * for any other shape (defensive for older drafts).
 */
export function parseFxBillingCurrency(title: string): string | null {
  const m = /\(([A-Z]{3})\)/.exec(title);
  return m ? m[1] : null;
}

/**
 * Detect whether an FX-exposure title represents an *adverse* move for
 * the buyer (cost goes up). Adverse moves render with a leading `+`
 * after the em-dash; favorable moves render with `-`. A flat `0.00%`
 * is treated as non-adverse.
 */
export function isFxAdverseFromTitle(title: string): boolean {
  const m = /—\s*([+-])\d/.exec(title);
  return m?.[1] === "+";
}

export function OppRow({
  opp,
  selected,
  onToggle,
}: {
  opp: Opportunity;
  selected?: boolean;
  onToggle?: () => void;
}) {
  const isFx = opp.leverId === LeverId.supplier_fx_exposure;
  const fxCurrency = isFx ? parseFxBillingCurrency(opp.title) : null;
  const fxAdverse = isFx ? isFxAdverseFromTitle(opp.title) : false;

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-md border hover:bg-accent/40 transition-colors"
      data-testid={`opp-${opp.id}`}
    >
      {onToggle && (
        <Checkbox
          checked={!!selected}
          onCheckedChange={onToggle}
          data-testid={`select-opp-${opp.id}`}
          aria-label={`Select ${opp.title}`}
        />
      )}
      <Link
        href={`/opportunities/${opp.id}`}
        className="flex items-center justify-between flex-1 min-w-0"
      >
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{opp.title}</div>
          <div className="text-xs text-muted-foreground truncate mt-0.5 flex items-center gap-2">
            {fxCurrency && (
              <>
                <Badge
                  variant="outline"
                  className="font-mono tabular-nums"
                  data-testid={`fx-currency-${opp.id}`}
                >
                  {fxCurrency}
                </Badge>
                <Badge
                  variant={fxAdverse ? "destructive" : "secondary"}
                  data-testid={`fx-direction-${opp.id}`}
                >
                  {fxAdverse ? "Adverse" : "Favorable"}
                </Badge>
                <span className="text-muted-foreground/60">·</span>
              </>
            )}
            <span className="truncate">
              {opp.supplierName ?? opp.categoryName ?? "—"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-4 flex-wrap justify-end">
          {(opp.breachingSla || opp.breachingDoaSla) && (
            <Badge
              variant="destructive"
              className="gap-1"
              data-testid={`sla-breach-${opp.id}`}
              title={
                opp.breachingDoaSla
                  ? "Exceeds DOA-tier identification SLA"
                  : "Exceeds gate SLA for current stage"
              }
            >
              <AlertTriangle className="w-3 h-3" />
              SLA breach
            </Badge>
          )}
          {opp.canonicalStage && (
            <Badge
              variant="outline"
              className="hidden sm:inline-flex"
              data-testid={`stage-${opp.id}`}
            >
              {opp.canonicalStage}
            </Badge>
          )}
          {opp.savingsType && (
            <Badge
              variant="secondary"
              className="hidden md:inline-flex"
              data-testid={`savings-type-${opp.id}`}
            >
              {opp.savingsType}
            </Badge>
          )}
          {opp.doaTier && (
            <Badge
              variant="outline"
              className="hidden md:inline-flex font-mono"
              data-testid={`doa-tier-${opp.id}`}
              title={`DOA Tier ${opp.doaTier}`}
            >
              T{opp.doaTier}
            </Badge>
          )}
          {opp.snoozedUntil && (
            <Badge
              variant="outline"
              className="gap-1"
              data-testid={`snoozed-${opp.id}`}
            >
              <Clock className="w-3 h-3" />
              Snoozed {formatSnoozeBadge(opp.snoozedUntil)}
            </Badge>
          )}
          {opp.status === "expired" && opp.expiryReason && (
            <Badge
              variant="outline"
              data-testid={`expiry-reason-${opp.id}`}
              title={
                opp.expiryReason === "ttl"
                  ? "Aged out: hit the absolute TTL cap (default 30 days since creation)."
                  : "Aged out: the underlying signal went quiet for the configured number of cycles."
              }
            >
              {opp.expiryReason === "ttl" ? "TTL" : "Quiet cycles"}
            </Badge>
          )}
          <StatusBadge status={opp.status} />
          <div className="text-right tabular-nums">
            <div className="font-semibold">
              {formatUsd(opp.projectedSavingsUsd, { compact: true })}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatPercent(opp.confidence)} conf.
            </div>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        </div>
      </Link>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const variant: "default" | "secondary" | "outline" | "destructive" =
    status === "realized"
      ? "default"
      : status === "rejected"
        ? "destructive"
        : status === "approved" || status === "executing"
          ? "secondary"
          : "outline";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

