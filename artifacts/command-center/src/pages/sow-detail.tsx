/**
 * SOW detail — header KPIs, milestones table, change orders table, and
 * back-links to the parent MSA contract and supplier.
 */
import { Link, useLocation, useParams } from "wouter";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  useGetSow,
  type SowMilestone,
  type SowChangeOrder,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  FileSignature,
  Building2,
  FileText,
  Lightbulb,
} from "lucide-react";
import { formatUsd, formatDate } from "@/lib/format";

const MILESTONE_BADGE: Record<SowMilestone["status"], string> = {
  pending: "bg-slate-200 text-slate-800",
  in_progress: "bg-sky-100 text-sky-800",
  delivered: "bg-amber-100 text-amber-800",
  accepted: "bg-emerald-100 text-emerald-800",
  invoiced: "bg-violet-100 text-violet-800",
  paid: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-rose-100 text-rose-800",
};

const CHANGE_BADGE: Record<SowChangeOrder["status"], string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-rose-100 text-rose-800",
};

const BILLING_MODEL_LABEL: Record<string, string> = {
  t_and_m: "Time & materials",
  fixed_price: "Fixed price",
  milestone: "Milestone",
  retainer: "Retainer",
  outcome: "Outcome",
  goods: "Goods",
};

export default function SowDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const [, navigate] = useLocation();
  const { data, isLoading, error } = useGetSow(id);

  if (isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading SOW…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-8 space-y-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/services")}
          data-testid="btn-back"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to services
        </Button>
        <Card>
          <CardContent className="pt-6 text-destructive flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Could not load this SOW.
          </CardContent>
        </Card>
      </div>
    );
  }

  const earnedUsd = data.burn?.earnedUsd ?? data.milestones
    .filter((m) =>
      m.status === "accepted" ||
      m.status === "invoiced" ||
      m.status === "paid"
    )
    .reduce((sum, m) => sum + m.amountUsd, 0);
  const committedUsd = data.burn?.committedUsd ?? data.totalValueUsd;
  const nteUsd = data.burn?.nteUsd ?? committedUsd;
  const invoicedUsd = data.burn?.invoicedUsd ?? null;
  const runwayDays = data.burn?.runwayDays ?? null;
  const burnPct = committedUsd > 0 ? earnedUsd / committedUsd : 0;
  const burnedUsd = data.burn?.burnedUsd ?? 0;
  const burnedPctNte = data.burn?.burnedPct ?? (nteUsd > 0 ? burnedUsd / nteUsd : 0);
  const avgWeeklyBurnUsd = data.burn?.avgWeeklyBurnUsd ?? 0;
  const weekly = data.burn?.weekly ?? [];
  const billingModelLabel = data.billingModel
    ? (BILLING_MODEL_LABEL[data.billingModel] ?? data.billingModel)
    : null;

  return (
    <div className="p-8 space-y-6 max-w-6xl">
      <Link
        href="/services"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        data-testid="link-back-to-services"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Services
      </Link>

      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <FileSignature className="w-6 h-6 text-primary" />
          <h1 data-testid="text-page-title" className="text-2xl font-bold">
            {data.title}
          </h1>
          <Badge
            variant={
              data.status === "active"
                ? "default"
                : data.status === "completed"
                  ? "secondary"
                  : data.status === "cancelled"
                    ? "destructive"
                    : "outline"
            }
            className="capitalize"
            data-testid={`sow-status-${data.status}`}
          >
            {data.status}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          <span className="font-mono">{data.sowNumber}</span>
          {data.supplierId && data.supplierName && (
            <>
              {" · "}
              <Link
                href={`/suppliers/${data.supplierId}`}
                className="hover:underline inline-flex items-center gap-1"
                data-testid="link-sow-supplier"
              >
                <Building2 className="w-3 h-3" />
                {data.supplierName}
              </Link>
            </>
          )}
          {data.msaContractId && data.msaContractNumber && (
            <>
              {" · "}
              <Link
                href={`/contracts/${data.msaContractId}`}
                className="hover:underline inline-flex items-center gap-1"
                data-testid="link-sow-msa"
              >
                <FileText className="w-3 h-3" />
                MSA {data.msaContractNumber}
              </Link>
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="Start" value={formatDate(data.startDate)} />
        <Kpi label="End" value={formatDate(data.endDate)} />
        <Kpi
          label="Total committed"
          value={formatUsd(committedUsd, { compact: true })}
          sub={data.currency}
        />
        <Kpi
          label="Milestones"
          value={`${data.openMilestoneCount}/${data.milestoneCount}`}
          sub="open / total"
        />
        <Kpi
          label="Billing model"
          value={billingModelLabel ?? "—"}
          sub="from MSA contract"
        />
        <Kpi
          label="Earned"
          value={formatUsd(earnedUsd, { compact: true })}
          sub={`${Math.round(burnPct * 100)}% burned`}
        />
        <Kpi
          label="Time-entry burn"
          value={formatUsd(burnedUsd, { compact: true })}
          sub={`${Math.round(burnedPctNte * 100)}% of NTE`}
        />
        <Kpi
          label="Invoiced"
          value={
            invoicedUsd !== null
              ? formatUsd(invoicedUsd, { compact: true })
              : "—"
          }
        />
        <Kpi
          label="Runway"
          value={
            runwayDays !== null ? `${runwayDays.toLocaleString()} days` : "—"
          }
          sub={
            avgWeeklyBurnUsd > 0
              ? `${formatUsd(avgWeeklyBurnUsd, { compact: true })}/wk avg`
              : "at current earn rate"
          }
        />
      </div>

      {weekly.length > 0 && (
        <Card data-testid="card-sow-burn-chart">
          <CardHeader>
            <CardTitle>Weekly burn</CardTitle>
            <CardDescription>
              Time-entry spend per ISO week (last 26 weeks). The dashed
              line is the not-to-exceed ceiling for this SOW.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64" data-testid="sow-burn-chart">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={weekly}
                  margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis
                    dataKey="weekStart"
                    tickFormatter={(v: string) => formatDate(v) ?? ""}
                    fontSize={10}
                  />
                  <YAxis
                    tickFormatter={(v: number) =>
                      formatUsd(v, { compact: true }) ?? ""
                    }
                    fontSize={10}
                    width={70}
                  />
                  <Tooltip
                    formatter={(v: number, name: string) => [
                      formatUsd(v, { compact: true }),
                      name === "amountUsd"
                        ? "This week"
                        : "Cumulative",
                    ]}
                    labelFormatter={(v: string) => formatDate(v) ?? ""}
                  />
                  {nteUsd > 0 && (
                    <ReferenceLine
                      y={nteUsd}
                      stroke="#dc2626"
                      strokeDasharray="4 4"
                      label={{
                        value: "NTE",
                        position: "right",
                        fill: "#dc2626",
                        fontSize: 10,
                      }}
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey="cumulativeUsd"
                    stroke="#0ea5e9"
                    fill="#0ea5e9"
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="amountUsd"
                    stroke="#1d4ed8"
                    fill="#1d4ed8"
                    fillOpacity={0.45}
                    strokeWidth={1.5}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {(data.scope || data.acceptanceCriteria) && (
        <Card data-testid="card-sow-scope">
          <CardHeader>
            <CardTitle>Scope &amp; acceptance</CardTitle>
            <CardDescription>
              Statement-of-work scope and acceptance criteria as captured
              when the SOW was executed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {data.scope ? (
              <div data-testid="sow-scope">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Scope
                </div>
                {typeof data.scope === "string" ? (
                  <p className="whitespace-pre-wrap">{data.scope}</p>
                ) : (
                  <pre className="text-xs bg-muted/40 rounded p-3 overflow-auto">
                    {JSON.stringify(data.scope, null, 2)}
                  </pre>
                )}
              </div>
            ) : null}
            {data.acceptanceCriteria && (
              <div data-testid="sow-acceptance">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Acceptance criteria
                </div>
                <p className="whitespace-pre-wrap">
                  {data.acceptanceCriteria}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {data.linkedOpportunities && data.linkedOpportunities.length > 0 && (
        <Card data-testid="card-sow-linked-opps">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-amber-500" />
              Linked opportunities
            </CardTitle>
            <CardDescription>
              Open OODA opportunities flagged by any lever against this SOW.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left p-3">Title</th>
                  <th className="text-left p-3">Lever</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Projected savings</th>
                  <th className="text-right p-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.linkedOpportunities.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b last:border-b-0"
                    data-testid={`linked-opp-${o.id}`}
                  >
                    <td className="p-3">
                      <Link
                        href={`/opportunities/${o.id}`}
                        className="font-medium hover:underline"
                      >
                        {o.title}
                      </Link>
                    </td>
                    <td className="p-3 text-xs font-mono text-muted-foreground">
                      {o.leverId}
                    </td>
                    <td className="p-3 text-xs capitalize">{o.status}</td>
                    <td className="p-3 text-right tabular-nums">
                      {formatUsd(o.projectedSavingsUsd, { compact: true })}
                    </td>
                    <td className="p-3 text-right tabular-nums text-xs text-muted-foreground">
                      {formatDate(o.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Milestones</CardTitle>
          <CardDescription>
            {formatUsd(earnedUsd, { compact: true })} earned of{" "}
            {formatUsd(committedUsd, { compact: true })} committed
            {committedUsd > 0 && (
              <>
                {" "}
                ({Math.round(burnPct * 100)}%)
              </>
            )}
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.milestones.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No milestones recorded for this SOW.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left p-3 w-12">#</th>
                  <th className="text-left p-3">Title</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Amount</th>
                  <th className="text-right p-3">Due</th>
                  <th className="text-right p-3">Delivered</th>
                  <th className="text-right p-3">Accepted</th>
                </tr>
              </thead>
              <tbody>
                {data.milestones.map((m) => (
                  <tr
                    key={m.id}
                    className={`border-b last:border-b-0 ${m.isOverdue ? "bg-rose-50/50" : ""}`}
                    data-testid={`milestone-${m.id}`}
                  >
                    <td className="p-3 font-mono text-xs">{m.sequence}</td>
                    <td className="p-3">
                      <div className="font-medium flex items-center gap-2">
                        {m.title}
                        {m.isOverdue && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded"
                            data-testid={`milestone-overdue-${m.id}`}
                          >
                            <AlertTriangle className="w-3 h-3" />
                            Overdue
                          </span>
                        )}
                      </div>
                      {m.acceptanceCriteria && (
                        <div className="text-xs text-muted-foreground">
                          {m.acceptanceCriteria}
                        </div>
                      )}
                    </td>
                    <td className="p-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium capitalize ${MILESTONE_BADGE[m.status]}`}
                      >
                        {m.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {formatUsd(m.amountUsd, { compact: true })}
                    </td>
                    <td className={`p-3 text-right tabular-nums text-xs ${m.isOverdue ? "text-rose-700 font-semibold" : "text-muted-foreground"}`}>
                      {formatDate(m.dueDate)}
                    </td>
                    <td className="p-3 text-right tabular-nums text-xs text-muted-foreground">
                      {formatDate(m.deliveredDate)}
                    </td>
                    <td className="p-3 text-right tabular-nums text-xs text-muted-foreground">
                      {formatDate(m.acceptedDate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change orders</CardTitle>
          <CardDescription>
            Scope, value, or date deltas against this SOW.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.changeOrders.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No change orders recorded.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left p-3">CO #</th>
                  <th className="text-left p-3">Title</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Δ Amount</th>
                  <th className="text-left p-3">Approver</th>
                  <th className="text-right p-3">Created</th>
                  <th className="text-right p-3">Approved</th>
                </tr>
              </thead>
              <tbody>
                {data.changeOrders.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b last:border-b-0"
                    data-testid={`change-order-${c.id}`}
                  >
                    <td className="p-3 font-mono text-xs">{c.changeNumber}</td>
                    <td className="p-3">
                      <div className="font-medium">{c.title}</div>
                      {c.reason && (
                        <div className="text-xs text-muted-foreground">
                          {c.reason}
                        </div>
                      )}
                    </td>
                    <td className="p-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium capitalize ${CHANGE_BADGE[c.status]}`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td
                      className={`p-3 text-right tabular-nums ${c.amountDeltaUsd < 0 ? "text-rose-600" : c.amountDeltaUsd > 0 ? "text-emerald-600" : ""}`}
                    >
                      {c.amountDeltaUsd > 0 ? "+" : ""}
                      {formatUsd(c.amountDeltaUsd, { compact: true })}
                    </td>
                    <td
                      className="p-3 text-xs text-muted-foreground"
                      data-testid={`change-order-approver-${c.id}`}
                    >
                      {c.approver ?? "—"}
                    </td>
                    <td className="p-3 text-right tabular-nums text-xs text-muted-foreground">
                      {formatDate(c.createdAt)}
                    </td>
                    <td
                      className="p-3 text-right tabular-nums text-xs text-muted-foreground"
                      data-testid={`change-order-approved-${c.id}`}
                    >
                      {c.approvedAt ? formatDate(c.approvedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">
        {label}
      </div>
      <div className="text-xl font-bold mt-1 tabular-nums">{value}</div>
      {sub && (
        <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
      )}
    </div>
  );
}
