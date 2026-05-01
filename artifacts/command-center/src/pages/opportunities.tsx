import { useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import {
  useListOpportunities,
  LeverId,
  ListOpportunitiesStatus,
  type Opportunity,
} from "@workspace/api-client-react";
import { parseFilters, firstFilterValue } from "@/lib/url-filters";
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
import { formatUsd, formatPercent, leverLabel } from "@/lib/format";
import { Loader2, Sparkles, ArrowRight } from "lucide-react";

const STATUS_OPTS = [
  { v: "all", l: "All" },
  { v: ListOpportunitiesStatus.proposed, l: "Proposed" },
  { v: ListOpportunitiesStatus.approved, l: "Approved" },
  { v: ListOpportunitiesStatus.executing, l: "Executing" },
  { v: ListOpportunitiesStatus.realized, l: "Realized" },
  { v: ListOpportunitiesStatus.rejected, l: "Rejected" },
  { v: ListOpportunitiesStatus.expired, l: "Expired" },
];

export default function Opportunities() {
  // #209 step 7: deep-links from the Today aggregator land here with
  // `?filter=status:proposed&filter=leverId:spot_vs_contract`. Initial-
  // state-only — manual changes don't write back to the URL (mirror of
  // the alerts page contract). Unknown values fall through to "all".
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

  const params = useMemo(() => {
    const p: Record<string, string | number> = { limit: 200 };
    if (statusFilter !== "all") p.status = statusFilter;
    if (leverFilter !== "all") p.leverId = leverFilter;
    return p as never;
  }, [statusFilter, leverFilter]);

  const { data, isLoading, error } = useListOpportunities(params);

  const grouped = useMemo(() => {
    const items = data?.items ?? [];
    const groups: Record<string, Opportunity[]> = {};
    for (const opp of items) {
      const k = opp.leverId;
      (groups[k] ??= []).push(opp);
    }
    for (const arr of Object.values(groups)) {
      arr.sort((a, b) => b.projectedSavingsUsd - a.projectedSavingsUsd);
    }
    return Object.entries(groups).sort(
      (a, b) =>
        b[1].reduce((s, o) => s + o.projectedSavingsUsd, 0) -
        a[1].reduce((s, o) => s + o.projectedSavingsUsd, 0),
    );
  }, [data]);

  const totalProj = (data?.items ?? []).reduce(
    (s, o) => s + o.projectedSavingsUsd,
    0,
  );

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 data-testid="text-page-title" className="text-3xl font-bold flex items-center gap-2">
            <Sparkles className="w-7 h-7 text-primary" />
            Opportunities Feed
          </h1>
          <p className="text-muted-foreground mt-1">
            {data?.items.length ?? 0} opportunities · {formatUsd(totalProj, { compact: true })} projected
          </p>
        </div>

        <div className="flex gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]" data-testid="filter-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTS.map((o) => (
                <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={leverFilter} onValueChange={setLeverFilter}>
            <SelectTrigger className="w-[260px]" data-testid="filter-lever">
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
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      )}
      {error && <div className="text-destructive">Failed to load opportunities.</div>}

      {grouped.length === 0 && !isLoading && (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          No opportunities match the current filters.
        </div>
      )}

      {grouped.map(([lever, opps]) => {
        const sum = opps.reduce((s, o) => s + o.projectedSavingsUsd, 0);
        return (
          <Card key={lever} data-testid={`group-${lever}`}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>{leverLabel(lever)}</span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {opps.length} opps · {formatUsd(sum, { compact: true })} projected
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {opps.slice(0, 8).map((opp) => (
                <OppRow key={opp.id} opp={opp} />
              ))}
              {opps.length > 8 && (
                <div className="text-xs text-muted-foreground text-center pt-2">
                  + {opps.length - 8} more in this lever
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
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
  // The cost-change percent is the first `+`/`-` after `— `.
  const m = /—\s*([+-])\d/.exec(title);
  return m?.[1] === "+";
}

export function OppRow({ opp }: { opp: Opportunity }) {
  const isFx = opp.leverId === LeverId.supplier_fx_exposure;
  const fxCurrency = isFx ? parseFxBillingCurrency(opp.title) : null;
  const fxAdverse = isFx ? isFxAdverseFromTitle(opp.title) : false;

  return (
    <Link
      href={`/opportunities/${opp.id}`}
      className="flex items-center justify-between p-3 rounded-md border hover:bg-accent/40 transition-colors"
      data-testid={`opp-${opp.id}`}
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
      <div className="flex items-center gap-3 ml-4">
        <StatusBadge status={opp.status} />
        <div className="text-right tabular-nums">
          <div className="font-semibold">
            {formatUsd(opp.projectedSavingsUsd, { compact: true })}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatPercent(opp.confidence)} conf.
          </div>
        </div>
        <ArrowRight className="w-4 h-4 text-muted-foreground" />
      </div>
    </Link>
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
  return <Badge variant={variant} className="capitalize">{status}</Badge>;
}
