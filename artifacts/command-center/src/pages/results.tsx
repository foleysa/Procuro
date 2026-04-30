import { useGetBillingSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUsd, formatPercent, leverLabel } from "@/lib/format";
import { Loader2, TrendingUp, DollarSign } from "lucide-react";

export default function Results() {
  const { data, isLoading, error } = useGetBillingSummary();

  if (isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading results…
      </div>
    );
  }
  if (error || !data) {
    return <div className="p-8 text-destructive">Failed to load billing summary.</div>;
  }

  const realizationRate =
    data.totalProjectedUsd > 0 ? data.totalRealizedUsd / data.totalProjectedUsd : 0;

  const sortedLevers = data.byLever.slice().sort((a, b) => b.realizedUsd - a.realizedUsd);

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div>
        <h1 data-testid="text-page-title" className="text-3xl font-bold flex items-center gap-2">
          <TrendingUp className="w-7 h-7 text-primary" />
          Results & Billing
        </h1>
        <p className="text-muted-foreground mt-1">
          You only pay on realized savings. Procuro contingency = {formatPercent(data.successFeePct)}.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="Realized savings" value={formatUsd(data.totalRealizedUsd, { compact: true })} />
        <Kpi label="Projected savings" value={formatUsd(data.totalProjectedUsd, { compact: true })} />
        <Kpi label="Realization rate" value={formatPercent(realizationRate)} />
        <Kpi
          label="Success fee owed"
          value={formatUsd(data.successFeeUsd, { compact: true })}
          accent
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="w-5 h-5" /> Invoice preview
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="bg-muted/30 rounded-md p-4 max-w-md">
            <div className="flex justify-between text-sm">
              <span>Realized savings</span>
              <span className="tabular-nums">{formatUsd(data.totalRealizedUsd)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>Contingency rate</span>
              <span className="tabular-nums">{formatPercent(data.successFeePct)}</span>
            </div>
            <div className="border-t mt-2 pt-2 flex justify-between font-semibold">
              <span>Procuro fee due</span>
              <span data-testid="text-fee-due" className="tabular-nums text-primary">
                {formatUsd(data.successFeeUsd)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Realized savings by lever</CardTitle></CardHeader>
        <CardContent>
          {sortedLevers.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No realized savings yet. Move executing opportunities to "realized" on the detail page.
            </p>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
                <th className="py-2">Lever</th>
                <th className="py-2 text-right">Opps realized</th>
                <th className="py-2 text-right">Projected</th>
                <th className="py-2 text-right">Realized</th>
              </tr>
            </thead>
            <tbody>
              {sortedLevers.map((row) => (
                <tr key={row.leverId} className="border-t">
                  <td className="py-2 font-medium">{leverLabel(row.leverId)}</td>
                  <td className="py-2 text-right tabular-nums">{row.opportunityCount}</td>
                  <td className="py-2 text-right tabular-nums">
                    {row.projectedUsd != null ? formatUsd(row.projectedUsd, { compact: true }) : "—"}
                  </td>
                  <td className="py-2 text-right tabular-nums font-semibold">
                    {formatUsd(row.realizedUsd, { compact: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg p-4 border ${accent ? "bg-primary/5 border-primary/40" : "bg-card"}`}
    >
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${accent ? "text-primary" : ""}`}>
        {value}
      </div>
    </div>
  );
}
