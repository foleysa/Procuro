import {
  useGetBillingSummary,
  useGetDefensePackSummary,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUsd, formatPercent, leverLabel } from "@/lib/format";
import { Loader2, TrendingUp, DollarSign, ShieldCheck } from "lucide-react";

export default function Results() {
  const { data, isLoading, error } = useGetBillingSummary();
  const dpQ = useGetDefensePackSummary();

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
          You only pay on realized savings. Atlas Procure contingency = {formatPercent(data.successFeePct)}.
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
              <span>Atlas Procure fee due</span>
              <span data-testid="text-fee-due" className="tabular-nums text-primary">
                {formatUsd(data.successFeeUsd)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-defense-pack-roi">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5" /> Defense Pack outcomes
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dpQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading Defense Pack outcomes…
            </div>
          ) : dpQ.error || !dpQ.data ? (
            <p className="text-sm text-destructive">
              Failed to load Defense Pack outcomes.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Kpi
                  label="Packs generated"
                  value={String(dpQ.data.packsGenerated)}
                  testId="kpi-dp-generated"
                />
                <Kpi
                  label="Used in negotiation"
                  value={String(dpQ.data.packsUsed)}
                  testId="kpi-dp-used"
                />
                <Kpi
                  label="Supplier held price"
                  value={String(dpQ.data.supplierHeldPriceCount)}
                  testId="kpi-dp-held"
                />
                <Kpi
                  label="$ avoided"
                  value={formatUsd(dpQ.data.avoidedUsd, { compact: true })}
                  accent
                  testId="kpi-dp-avoided"
                />
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Counts use the latest feedback per pack. "$ avoided" sums the
                annual baseline of contracts referenced by packs whose
                supplier ultimately held price.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Realized savings by lever</CardTitle></CardHeader>
        <CardContent>
          {sortedLevers.length === 0 ? (
            <div className="py-6 text-center space-y-2">
              <DollarSign className="w-8 h-8 mx-auto text-muted-foreground/40" />
              <div className="font-medium">No realized savings yet</div>
              <div className="text-sm text-muted-foreground max-w-sm mx-auto">
                Move executing opportunities to &ldquo;realized&rdquo; on the
                opportunity detail page. Savings will appear here broken down by
                lever.
              </div>
            </div>
          ) : (
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({
  label,
  value,
  accent,
  testId,
}: {
  label: string;
  value: string;
  accent?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`rounded-lg p-4 border ${accent ? "bg-primary/5 border-primary/40" : "bg-card"}`}
    >
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${accent ? "text-primary" : ""}`}>
        {value}
      </div>
    </div>
  );
}
