import { Link } from "wouter";
import {
  useListOpportunities,
  ListOpportunitiesStatus,
  type Opportunity,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatUsd, formatPercent, leverLabel } from "@/lib/format";
import { Loader2, ArrowRight, CheckSquare } from "lucide-react";

function Pipeline({
  title,
  status,
  emptyMsg,
  accent,
}: {
  title: string;
  status: keyof typeof ListOpportunitiesStatus;
  emptyMsg: string;
  accent: string;
}) {
  const { data, isLoading } = useListOpportunities({
    status: ListOpportunitiesStatus[status],
    limit: 50,
  });

  const sum = (data?.items ?? []).reduce((s, o) => s + o.projectedSavingsUsd, 0);
  const real = (data?.items ?? []).reduce(
    (s, o) => s + (o.realizedSavingsUsd ?? 0),
    0,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className={`flex items-center gap-2 ${accent}`}>
            <Badge variant="outline">{data?.items.length ?? 0}</Badge>
            {title}
          </span>
          <span className="text-sm font-normal text-muted-foreground tabular-nums">
            {status === "realized"
              ? `${formatUsd(real, { compact: true })} realized`
              : `${formatUsd(sum, { compact: true })} projected`}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {!isLoading && (data?.items ?? []).length === 0 && (
          <div className="text-sm text-muted-foreground py-4">{emptyMsg}</div>
        )}
        <div className="space-y-1">
          {(data?.items ?? []).slice(0, 8).map((opp) => (
            <Row key={opp.id} opp={opp} status={status} />
          ))}
          {(data?.items ?? []).length > 8 && (
            <div className="text-xs text-muted-foreground text-center pt-2">
              + {data!.items.length - 8} more
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ opp, status }: { opp: Opportunity; status: string }) {
  return (
    <Link
      href={`/opportunities/${opp.id}`}
      data-testid={`approval-row-${opp.id}`}
      className="flex items-center justify-between p-2.5 rounded-md border text-sm hover:bg-accent/40 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{opp.title}</div>
        <div className="text-xs text-muted-foreground truncate">
          {leverLabel(opp.leverId)}
        </div>
      </div>
      <div className="flex items-center gap-3 ml-3 flex-shrink-0">
        <div className="text-right tabular-nums">
          <div className="font-semibold">
            {status === "realized" && opp.realizedSavingsUsd != null
              ? formatUsd(opp.realizedSavingsUsd, { compact: true })
              : formatUsd(opp.projectedSavingsUsd, { compact: true })}
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

export default function Approvals() {
  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div>
        <h1 data-testid="text-page-title" className="text-3xl font-bold flex items-center gap-2">
          <CheckSquare className="w-7 h-7 text-primary" />
          Approvals & Pipeline
        </h1>
        <p className="text-muted-foreground mt-1">
          Move proposed opportunities through approve → executing → realized.
          Rejection reasons feed the priors so future cycles get smarter.
        </p>
      </div>

      <div className="grid lg:grid-cols-2 xl:grid-cols-3 gap-6">
        <Pipeline
          title="Proposed"
          status="proposed"
          emptyMsg="Nothing proposed. Run a new cycle from the OODA Wheel."
          accent="text-yellow-700 dark:text-yellow-400"
        />
        <Pipeline
          title="Approved"
          status="approved"
          emptyMsg="Nothing approved yet."
          accent="text-blue-700 dark:text-blue-400"
        />
        <Pipeline
          title="Executing"
          status="executing"
          emptyMsg="Nothing in flight."
          accent="text-purple-700 dark:text-purple-400"
        />
        <Pipeline
          title="Realized"
          status="realized"
          emptyMsg="No realized savings yet."
          accent="text-green-700 dark:text-green-400"
        />
        <Pipeline
          title="Rejected"
          status="rejected"
          emptyMsg="Nothing rejected."
          accent="text-destructive"
        />
      </div>
    </div>
  );
}
