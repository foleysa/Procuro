import { useState } from "react";
import { Link } from "wouter";
import {
  useGetSpendOverview,
  useGetMe,
  useGetSpendByBand,
  type SpendByBand,
  type SpendByBandByBandItemBand,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatUsd, formatPercent } from "@/lib/format";
import { Loader2, Layers, Wrench, Package, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type SegmentTab = "all" | "goods" | "services";

const BAND_LABELS: Record<SpendByBandByBandItemBand, string> = {
  indexable: "Indexable",
  concentrated: "Concentrated",
  fragmented: "Fragmented",
  subscription: "Subscription",
  capital: "Capital",
  services: "Services",
};

const BAND_COLORS: Record<SpendByBandByBandItemBand, string> = {
  indexable: "bg-emerald-500",
  concentrated: "bg-sky-500",
  fragmented: "bg-amber-500",
  subscription: "bg-violet-500",
  capital: "bg-slate-500",
  services: "bg-fuchsia-500",
};

const BAND_BLURBS: Record<SpendByBandByBandItemBand, string> = {
  indexable: "Commodity-like, benchmarkable.",
  concentrated: "Few suppliers, leverage available.",
  fragmented: "Many suppliers, consolidation upside.",
  subscription: "Recurring contracts, term-based plays.",
  capital: "Capital projects, milestone-based.",
  services: "Labour, T&M, fixed-price engagements.",
};

export default function SpendOverview() {
  const { data: me } = useGetMe();
  const [segment, setSegment] = useState<SegmentTab>("all");
  // Re-fetch the entire overview when the segment changes so every
  // card on the page (KPIs, by-class, top categories, top suppliers,
  // by business unit, concentration) reflects the same slice the
  // segmented control announces. Without this the per-segment view
  // misleads operators by showing an unrelated org-wide rollup
  // alongside the segment-scoped header.
  const { data, isLoading, error } = useGetSpendOverview({ segment });
  const { data: byBand, isLoading: byBandLoading } = useGetSpendByBand();

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

  // The goods/services pills always reflect the org-wide split
  // (computed against the full 12-month roll-up server-side), so the
  // segmented control surfaces share regardless of which slice is
  // active.
  const gvs = data.goodsVsServices;

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

      <Tabs value={segment} onValueChange={(v) => setSegment(v as SegmentTab)}>
        <TabsList data-testid="tabs-segment">
          <TabsTrigger value="all" data-testid="tab-segment-all">
            <Layers className="w-4 h-4 mr-1" /> All spend
          </TabsTrigger>
          <TabsTrigger value="goods" data-testid="tab-segment-goods">
            <Package className="w-4 h-4 mr-1" /> Goods
            <span className="ml-2 text-[10px] text-muted-foreground tabular-nums">
              {formatPercent(gvs.goodsShare)}
            </span>
          </TabsTrigger>
          <TabsTrigger value="services" data-testid="tab-segment-services">
            <Wrench className="w-4 h-4 mr-1" /> Services
            <span className="ml-2 text-[10px] text-muted-foreground tabular-nums">
              {formatPercent(gvs.servicesShare)}
            </span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi
          label={
            segment === "goods"
              ? "Goods spend"
              : segment === "services"
                ? "Services spend"
                : "Total spend"
          }
          value={formatUsd(data.totalSpendUsd, { compact: true })}
        />
        <Kpi
          label="Active suppliers"
          value={data.concentration.activeSupplierCount.toLocaleString()}
        />
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

      <GoodsVsServicesCard
        goods={gvs.goodsSpendUsd}
        services={gvs.servicesSpendUsd}
        goodsShare={gvs.goodsShare}
        servicesShare={gvs.servicesShare}
        cta={
          <Link
            href="/services?tab=spend"
            className="text-sm text-primary hover:underline"
            data-testid="link-services-detail"
          >
            Open Services workspace →
          </Link>
        }
      />

      <SpendByBandCard
        data={byBand}
        isLoading={byBandLoading}
      />

      <Card>
        <CardHeader>
          <CardTitle>Spend by class</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byClass.length === 0 ? (
            <div className="py-6 text-center space-y-2">
              <Layers className="w-8 h-8 mx-auto text-muted-foreground/40" />
              <div className="font-medium">No spend-class breakdown yet</div>
              <div className="text-sm text-muted-foreground max-w-sm mx-auto">
                Ingest PO data to populate this view. Each purchase order is
                classified into a spend class automatically.
              </div>
            </div>
          ) : (
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
          )}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Top 10 categories</CardTitle>
          </CardHeader>
          <CardContent>
            {top10Cat.length === 0 ? (
              <div className="py-6 text-center space-y-2">
                <Layers className="w-6 h-6 mx-auto text-muted-foreground/40" />
                <div className="text-sm font-medium">No category data yet</div>
                <div className="text-xs text-muted-foreground">
                  Categories appear once PO data has been ingested and classified.
                </div>
              </div>
            ) : (
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
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top 10 suppliers</CardTitle>
          </CardHeader>
          <CardContent>
            {top10Sup.length === 0 ? (
              <div className="py-6 text-center space-y-2">
                <Package className="w-6 h-6 mx-auto text-muted-foreground/40" />
                <div className="text-sm font-medium">No supplier data yet</div>
                <div className="text-xs text-muted-foreground">
                  Suppliers appear once PO data has been ingested.
                </div>
              </div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {top10Sup.map((s) => (
                    <tr key={s.supplierId} className="border-b last:border-0">
                      <td className="py-2">
                        <Link
                          href={`/suppliers/${s.supplierId}`}
                          className="font-medium hover:underline"
                          data-testid={`link-supplier-${s.supplierId}`}
                        >
                          {s.supplierName}
                        </Link>
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
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Spend by business unit</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byBusinessUnit.length === 0 ? (
            <div className="py-6 text-center space-y-2">
              <Layers className="w-6 h-6 mx-auto text-muted-foreground/40" />
              <div className="text-sm font-medium">No business-unit data yet</div>
              <div className="text-xs text-muted-foreground">
                Business-unit breakdown appears once PO data includes cost-center
                or department mappings.
              </div>
            </div>
          ) : (
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
          )}
        </CardContent>
      </Card>

    </div>
  );
}

function GoodsVsServicesCard({
  goods,
  services,
  goodsShare,
  servicesShare,
  cta,
}: {
  goods: number;
  services: number;
  goodsShare: number;
  servicesShare: number;
  cta?: React.ReactNode;
}) {
  const pctGoods = Math.max(0, Math.min(1, goodsShare));
  const pctServices = Math.max(0, Math.min(1, servicesShare));

  return (
    <Card data-testid="card-goods-vs-services">
      <CardHeader>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle>Goods vs Services</CardTitle>
            <CardDescription>
              Trailing 12 months. Services = lines whose category is class
              <code className="mx-1">service</code> or routed to the
              <code className="mx-1">services</code> band. Always reconciles to
              the by-Band <em>services</em> bucket below.
            </CardDescription>
          </div>
          {cta}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex h-4 w-full overflow-hidden rounded">
          <div
            className="bg-emerald-500 h-full"
            style={{ width: `${pctGoods * 100}%` }}
            title={`Goods · ${formatPercent(pctGoods)}`}
          />
          <div
            className="bg-fuchsia-500 h-full"
            style={{ width: `${pctServices * 100}%` }}
            title={`Services · ${formatPercent(pctServices)}`}
          />
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div data-testid="gvs-goods">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
              <span className="font-medium">Goods</span>
            </div>
            <div className="text-lg font-bold tabular-nums mt-1">
              {formatUsd(goods, { compact: true })}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatPercent(pctGoods)}
            </div>
          </div>
          <div data-testid="gvs-services">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-fuchsia-500" />
              <span className="font-medium">Services</span>
            </div>
            <div className="text-lg font-bold tabular-nums mt-1">
              {formatUsd(services, { compact: true })}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatPercent(pctServices)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SpendByBandCard({
  data,
  isLoading,
}: {
  data: SpendByBand | undefined;
  isLoading: boolean;
}) {
  // Track which band rows are expanded to show their top categories.
  const [expanded, setExpanded] = useState<Set<SpendByBandByBandItemBand>>(
    new Set(),
  );
  const toggle = (band: SpendByBandByBandItemBand) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(band)) next.delete(band);
      else next.add(band);
      return next;
    });
  };

  return (
    <Card data-testid="card-spend-by-band">
      <CardHeader>
        <CardTitle>Spend by routing band (last 90 days)</CardTitle>
        <CardDescription>
          The six bands are the routing model&rsquo;s shared vocabulary — they
          determine which intelligence levers fire against each category.
          Categories without an explicit band binding (including
          class=&quot;service&quot; rows that haven&rsquo;t been bound to
          <code>services</code>) fall back to <code>fragmented</code> so
          they remain addressable. Click a band to drill into its
          constituent categories.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading band rollup…
          </div>
        ) : !data || data.byBand.length === 0 || data.totalSpendUsd === 0 ? (
          <div className="text-sm text-muted-foreground">
            No spend in the trailing 90 days. The band view needs a recent
            window of PO activity to populate.
          </div>
        ) : (
          <div className="space-y-3">
            {data.unmappedCategoryCount > 0 && (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                data-testid="banner-unmapped-categories"
              >
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">
                    {data.unmappedCategoryCount} categor
                    {data.unmappedCategoryCount === 1 ? "y" : "ies"} unmapped
                  </span>
                  {" — "}
                  {formatUsd(data.unmappedSpendUsd, { compact: true })} of
                  spend is bucketed as <code>fragmented</code> by fallback.
                  Map these to a band to sharpen routing.
                </div>
              </div>
            )}
            {data.byBand.map((b) => {
              const pct = Math.max(0, Math.min(1, b.share));
              const isOpen = expanded.has(b.band);
              const topCats = b.topCategories ?? [];
              const hasDrillDown = topCats.length > 0;
              return (
                <div key={b.band} data-testid={`row-band-${b.band}`}>
                  <button
                    type="button"
                    className={cn(
                      "w-full text-left",
                      hasDrillDown && "cursor-pointer",
                    )}
                    onClick={() => hasDrillDown && toggle(b.band)}
                    disabled={!hasDrillDown}
                    data-testid={`btn-expand-band-${b.band}`}
                  >
                    <div className="flex justify-between text-sm mb-1 gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        {hasDrillDown ? (
                          isOpen ? (
                            <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />
                          )
                        ) : (
                          <span className="w-3 h-3 shrink-0" />
                        )}
                        <span
                          className={cn(
                            "w-2.5 h-2.5 rounded-sm shrink-0",
                            BAND_COLORS[b.band],
                          )}
                        />
                        <span className="font-medium">{BAND_LABELS[b.band]}</span>
                        <span className="text-xs text-muted-foreground truncate hidden sm:inline">
                          — {BAND_BLURBS[b.band]}
                        </span>
                      </div>
                      <span className="tabular-nums shrink-0 text-right">
                        {formatUsd(b.spendUsd, { compact: true })}
                        <span className="text-xs text-muted-foreground ml-2">
                          {formatPercent(pct)}
                        </span>
                      </span>
                    </div>
                    <div className="h-2 bg-muted rounded">
                      <div
                        className={cn("h-full rounded", BAND_COLORS[b.band])}
                        style={{ width: `${pct * 100}%` }}
                      />
                    </div>
                    <div className="flex gap-3 mt-1 text-[11px] text-muted-foreground pl-5">
                      {b.categoryCount != null && (
                        <span>
                          {b.categoryCount} categor
                          {b.categoryCount === 1 ? "y" : "ies"}
                        </span>
                      )}
                      {b.supplierCount != null && (
                        <span>
                          {b.supplierCount} supplier
                          {b.supplierCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                  </button>
                  {isOpen && hasDrillDown && (
                    <div
                      className="ml-5 mt-2 mb-1 rounded-md border bg-muted/30 divide-y"
                      data-testid={`drilldown-band-${b.band}`}
                    >
                      {topCats.map((c) => (
                        <div
                          key={c.categoryId}
                          className="flex items-center justify-between px-3 py-1.5 text-xs"
                        >
                          <span className="truncate">{c.categoryName}</span>
                          <span className="tabular-nums text-muted-foreground shrink-0">
                            {formatUsd(c.spendUsd, { compact: true })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
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
      <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
      {sub && (
        <div className="text-xs text-muted-foreground mt-1">{sub}</div>
      )}
    </div>
  );
}
