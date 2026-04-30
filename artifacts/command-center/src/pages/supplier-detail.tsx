import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSupplierIntelligence,
  useOverrideSupplierBillingCurrency,
  getGetSupplierIntelligenceQueryKey,
  type SupplierIntelligenceSignal,
  type SupplierIntelligenceSignalType,
  type SupplierIntelligenceResponse,
  type InsightSource,
  type BillingCurrencySource,
  type BillingCurrencyConfidence,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  Building2,
  FileText,
  IdCard,
  Loader2,
  Radar,
  Siren,
  Wind,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { InsightCitations } from "@/components/insight-citations";
import { usePolicy } from "@/lib/use-policy";

const TYPE_ORDER: SupplierIntelligenceSignalType[] = [
  "sanctions_match",
  "risk_screening_match",
  "corporate_filing",
  "entity_registry",
  "facility_emissions",
  "natural_hazard",
  "event_geocoded",
];

const TYPE_LABELS: Record<SupplierIntelligenceSignalType, string> = {
  sanctions_match: "Sanctions matches",
  risk_screening_match: "Risk-screening matches",
  corporate_filing: "Corporate filings",
  entity_registry: "Entity-registry updates",
  facility_emissions: "Facility emissions",
  natural_hazard: "Natural hazards",
  event_geocoded: "Geocoded events",
};

const TYPE_ICONS: Record<
  SupplierIntelligenceSignalType,
  React.ComponentType<{ className?: string }>
> = {
  sanctions_match: Siren,
  risk_screening_match: Radar,
  corporate_filing: FileText,
  entity_registry: IdCard,
  facility_emissions: Wind,
  natural_hazard: AlertTriangle,
  event_geocoded: Zap,
};

export default function SupplierDetail() {
  const params = useParams<{ id: string }>();
  const supplierId = params.id ?? "";
  const policy = usePolicy();
  const { data, isLoading, error } = useGetSupplierIntelligence(supplierId);

  if (isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading supplier intelligence…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-8 space-y-4">
        <BackToSpend />
        <div className="text-destructive">
          Failed to load supplier intelligence.
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <BackToSpend />
      <Header data={data} />
      <BillingCurrencyCard data={data} />
      <RiskAndFilingsPanel data={data} policy={policy} />
    </div>
  );
}

function BackToSpend() {
  return (
    <Link
      href="/spend"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      data-testid="link-back-to-spend"
    >
      <ArrowLeft className="w-4 h-4" />
      Back to Spend
    </Link>
  );
}

function Header({ data }: { data: SupplierIntelligenceResponse }) {
  return (
    <div className="flex items-start gap-3">
      <Building2 className="w-7 h-7 text-muted-foreground mt-1" />
      <div>
        <h1
          data-testid="text-supplier-name"
          className="text-3xl font-bold leading-tight"
        >
          {data.supplierName}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {data.countryCode ? `${data.countryCode} · ` : ""}
          Supplier ID {data.supplierId}
        </p>
        <ResolutionLine data={data} />
      </div>
    </div>
  );
}

function ResolutionLine({ data }: { data: SupplierIntelligenceResponse }) {
  if (!data.resolvedEntityUid) {
    return (
      <p
        className="text-xs text-muted-foreground mt-1"
        data-testid="text-entity-resolution"
      >
        No canonical entity uid resolved — risk timeline is matched on
        supplier name only.
      </p>
    );
  }
  return (
    <p
      className="text-xs text-muted-foreground mt-1"
      data-testid="text-entity-resolution"
    >
      Resolved entity uid:{" "}
      <span className="font-mono">{data.resolvedEntityUid}</span>
      {data.resolvedMatchType ? ` · ${data.resolvedMatchType}` : ""}
    </p>
  );
}

/**
 * Source labels match the persisted `billing_currency_source` column.
 * `country_dollarized` exists on the response but is never auto-applied
 * at ingest — we still label it so it renders if it ever shows up.
 */
const BILLING_SOURCE_LABEL: Record<BillingCurrencySource, string> = {
  provided: "From supplier feed",
  country: "Auto-detected from country",
  country_dollarized: "Country (dollarized)",
  invoice_iso: "Auto-detected from invoice ISO code",
  invoice_symbol: "Auto-detected from invoice symbol",
  backfill_invoice: "Auto-detected from PO line text",
  manual_override: "Manually overridden",
};

function confidenceBadgeVariant(
  c: BillingCurrencyConfidence,
): "default" | "secondary" | "outline" {
  if (c === "high") return "default";
  if (c === "medium") return "secondary";
  return "outline";
}

export function BillingCurrencyCard({
  data,
}: {
  data: SupplierIntelligenceResponse;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const mutation = useOverrideSupplierBillingCurrency({
    mutation: {
      onSuccess: () => {
        // Refetch the intelligence response so the chip + source line
        // update in place. The `manual_override` source is server-set.
        void queryClient.invalidateQueries({
          queryKey: getGetSupplierIntelligenceQueryKey(data.supplierId),
        });
        setDraft("");
        setErrMsg(null);
      },
      onError: (err: unknown) => {
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to override billing currency";
        setErrMsg(msg);
      },
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!/^[A-Za-z]{3}$/.test(trimmed)) {
      setErrMsg("Enter a 3-letter ISO 4217 currency code, e.g. EUR.");
      return;
    }
    setErrMsg(null);
    mutation.mutate({
      id: data.supplierId,
      data: { billingCurrency: trimmed.toUpperCase() },
    });
  };

  return (
    <Card data-testid="card-billing-currency">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Banknote className="w-5 h-5" />
          Billing Currency
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          {data.billingCurrency ? (
            <span
              className="inline-flex items-center rounded-md border bg-card px-2 py-0.5 text-base font-mono font-medium"
              data-testid="text-billing-currency"
            >
              {data.billingCurrency}
            </span>
          ) : (
            <span
              className="text-sm text-muted-foreground"
              data-testid="text-billing-currency-empty"
            >
              Not set — defaults to org base currency
            </span>
          )}
          {data.billingCurrencyConfidence ? (
            <Badge
              variant={confidenceBadgeVariant(data.billingCurrencyConfidence)}
              data-testid="badge-billing-confidence"
              data-confidence={data.billingCurrencyConfidence}
            >
              {data.billingCurrencyConfidence} confidence
            </Badge>
          ) : null}
        </div>

        {data.billingCurrencySource ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-billing-source"
            data-source={data.billingCurrencySource}
          >
            {BILLING_SOURCE_LABEL[data.billingCurrencySource]}
          </p>
        ) : null}

        <form
          onSubmit={handleSubmit}
          className="flex flex-wrap items-end gap-2"
          data-testid="form-billing-override"
        >
          <div className="flex flex-col gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor="billing-currency-override-input"
            >
              Override (3-letter ISO)
            </label>
            <Input
              id="billing-currency-override-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              placeholder="EUR"
              maxLength={3}
              className="w-28 font-mono uppercase"
              data-testid="input-billing-currency-override"
              disabled={mutation.isPending}
            />
          </div>
          <Button
            type="submit"
            data-testid="button-billing-currency-override"
            disabled={mutation.isPending || draft.trim().length === 0}
          >
            {mutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              "Save override"
            )}
          </Button>
          {errMsg ? (
            <p
              className="text-xs text-destructive basis-full"
              data-testid="text-billing-error"
            >
              {errMsg}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function RiskAndFilingsPanel({
  data,
  policy,
}: {
  data: SupplierIntelligenceResponse;
  policy: ReturnType<typeof usePolicy>;
}) {
  const grouped = useMemo(() => {
    const buckets = new Map<
      SupplierIntelligenceSignalType,
      SupplierIntelligenceSignal[]
    >();
    for (const it of data.items) {
      const arr = buckets.get(it.signalType) ?? [];
      arr.push(it);
      buckets.set(it.signalType, arr);
    }
    return buckets;
  }, [data.items]);

  return (
    <Card data-testid="card-risk-and-filings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5" />
          Risk &amp; Filings
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-signals">
            No sanctions, corporate-filing, or hazard signals matched
            this supplier in the current data window.
          </p>
        ) : (
          <div className="space-y-6">
            {TYPE_ORDER.filter((t) => grouped.has(t)).map((t) => (
              <SignalGroup
                key={t}
                signalType={t}
                items={grouped.get(t) ?? []}
                policy={policy}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SignalGroup({
  signalType,
  items,
  policy,
}: {
  signalType: SupplierIntelligenceSignalType;
  items: SupplierIntelligenceSignal[];
  policy: ReturnType<typeof usePolicy>;
}) {
  const Icon = TYPE_ICONS[signalType];
  return (
    <section data-testid={`group-${signalType}`}>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{TYPE_LABELS[signalType]}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          ({items.length})
        </span>
      </div>
      <ul className="space-y-3">
        {items.map((it) => (
          <SignalRow key={it.id} item={it} policy={policy} />
        ))}
      </ul>
    </section>
  );
}

function SignalRow({
  item,
  policy,
}: {
  item: SupplierIntelligenceSignal;
  policy: ReturnType<typeof usePolicy>;
}) {
  const sources: InsightSource[] = [
    {
      collectorId: item.collectorId,
      collectorName: item.collectorName,
      sourceUrl: item.sourceUrl,
      observedAt: item.observedAt,
      contract: item.contract,
    },
  ];
  return (
    <li
      className="rounded-md border border-border/60 bg-card p-3 space-y-2"
      data-testid={`row-signal-${item.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">
            {item.headline ?? item.collectorName}
          </div>
          {item.detail ? (
            <div className="text-xs text-muted-foreground mt-0.5">
              {item.detail}
            </div>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {formatObserved(item.observedAt)}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[10px] uppercase tracking-wide text-muted-foreground"
          data-match-kind={item.matchKind}
        >
          match: {item.matchKind === "entity_uid" ? "entity uid" : "supplier name"}
        </span>
      </div>
      <InsightCitations sources={sources} policy={policy} variant="compact" />
    </li>
  );
}

function formatObserved(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
