import { useGetSpendOverview, useGetMe } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUsd, formatPercent } from "@/lib/format";
import { Loader2 } from "lucide-react";

export default function Dashboard() {
  const { data: me } = useGetMe();
  const { data, isLoading, error } = useGetSpendOverview();

  if (isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading spend overview…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-8 text-destructive">
        Failed to load spend overview.
      </div>
    );
  }

  const top10Cat = [...data.byCategory]
    .sort((a, b) => b.spendUsd - a.spendUsd)
    .slice(0, 10);
  const top10Sup = [...data.bySupplier]
    .sort((a, b) => b.spendUsd - a.spendUsd)
    .slice(0, 10);

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div>
        <h1 data-testid="text-page-title" className="text-3xl font-bold">
          Spend Overview
        </h1>
        <p className="text-muted-foreground mt-1">
          {me?.org.name} · all addressable spend (last 12 months)
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="Total spend" value={formatUsd(data.totalSpendUsd, { compact: true })} />
        <Kpi label="Active suppliers" value={data.concentration.activeSupplierCount.toLocaleString()} />
        <Kpi
          label="Top‑10 supplier share"
          value={formatPercent(data.concentration.top10SupplierShare)}
        />
        <Kpi
          label="Tail spend"
          value={formatUsd(data.concentration.tailSpendUsd, { compact: true })}
          sub={`${data.concentration.tailSupplierCount} tail suppliers`}
        />
      </div>

      <Card>
        <CardHeader><CardTitle>Spend by class</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-3">
            {data.byClass.map((c) => {
              const pct = data.totalSpendUsd > 0 ? c.spendUsd / data.totalSpendUsd : 0;
              return (
                <div key={c.spendClass} data-testid={`row-class-${c.spendClass}`}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium capitalize">{c.spendClass}</span>
                    <span className="tabular-nums">
                      {formatUsd(c.spendUsd, { compact: true })} · {formatPercent(pct)}
                    </span>
                  </div>
                  <div className="h-2 bg-muted rounded">
                    <div
                      className="h-full bg-primary rounded"
                      style={{ width: `${pct * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Top 10 categories</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                {top10Cat.map((c) => (
                  <tr key={c.categoryId} className="border-b last:border-0">
                    <td className="py-2">
                      <div className="font-medium">{c.categoryName}</div>
                      <div className="text-xs text-muted-foreground capitalize">
                        {c.categoryClass}
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatUsd(c.spendUsd, { compact: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Top 10 suppliers</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                {top10Sup.map((s) => (
                  <tr key={s.supplierId} className="border-b last:border-0">
                    <td className="py-2">
                      <div className="font-medium">{s.supplierName}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.poCount} POs
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatUsd(s.spendUsd, { compact: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Spend by business unit</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {data.byBusinessUnit.map((bu) => (
              <div key={bu.businessUnit} className="bg-muted/40 rounded-lg p-4">
                <div className="text-sm font-medium">{bu.businessUnit}</div>
                <div className="text-xl font-bold tabular-nums mt-1">
                  {formatUsd(bu.spendUsd, { compact: true })}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">
        {label}
      </div>
      <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
      {sub && (
        <div className="text-xs text-muted-foreground mt-1">{sub}</div>
      )}
    </div>
  );
}
