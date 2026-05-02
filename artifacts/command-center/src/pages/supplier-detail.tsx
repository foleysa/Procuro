import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  useGetSupplier,
  usePatchSupplier,
  getGetSupplierQueryKey,
  getListSuppliersQueryKey,
  useGetSupplierIntelligence,
  useOverrideSupplierBillingCurrency,
  getGetSupplierIntelligenceQueryKey,
  type SupplierDetail,
  type SupplierLinkedContract,
  type SupplierLinkedOpportunity,
  type SupplierAuditEntry,
  type SupplierSpendRollup,
  type SupplierServicesEngagement,
  type MarketSignal,
  type PatchSupplierRequest,
  type SupplierIntelligenceSignal,
  type SupplierIntelligenceSignalType,
  type SupplierIntelligenceResponse,
  type InsightSource,
  type BillingCurrencySource,
  type BillingCurrencyConfidence,
} from "@workspace/api-client-react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Banknote,
  Building2,
  ExternalLink,
  FileText,
  IdCard,
  Loader2,
  Plus,
  Radar,
  Save,
  ShieldCheck,
  Siren,
  Star,
  TrendingUp,
  Wind,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { formatUsd, formatDate, formatDateTime } from "@/lib/format";
import { FxTrendChart } from "@/components/fx-trend-chart";
import { BlsTrendChart } from "@/components/bls-trend-chart";
import { InsightCitations } from "@/components/insight-citations";
import { usePolicy } from "@/lib/use-policy";
import { DerivedStatusBadge } from "./contracts";

// ---------------------------------------------------------------------
// Tab plumbing — `?tab=` deep links survive refresh + browser nav.
// ---------------------------------------------------------------------

const TAB_VALUES = [
  "overview",
  "spend",
  "contracts",
  "opportunities",
  "fx",
  "risk",
  "activity",
] as const;
type TabValue = (typeof TAB_VALUES)[number];
const isTab = (v: string | null): v is TabValue =>
  !!v && (TAB_VALUES as readonly string[]).includes(v);

function readTabFromUrl(): TabValue {
  if (typeof window === "undefined") return "overview";
  const t = new URLSearchParams(window.location.search).get("tab");
  return isTab(t) ? t : "overview";
}

function writeTabToUrl(t: TabValue) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (t === "overview") url.searchParams.delete("tab");
  else url.searchParams.set("tab", t);
  window.history.replaceState({}, "", url.toString());
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export default function SupplierDetailPage() {
  const params = useParams<{ id: string }>();
  const supplierId = params.id ?? "";
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const policy = usePolicy();

  const { data, isLoading, error } = useGetSupplier(supplierId);

  // Risk timeline still comes from the dedicated intelligence endpoint
  // — that has all the public-API enrichment our /suppliers/{id} call
  // intentionally doesn't bundle into the canonical detail payload.
  const { data: intel, isLoading: intelLoading } = useGetSupplierIntelligence(
    supplierId,
    {
      query: {
        queryKey: getGetSupplierIntelligenceQueryKey(supplierId),
        enabled: !!supplierId,
      },
    },
  );

  // Tab state, kept in sync with `?tab=` so deep-links work both ways.
  const [tab, setTab] = useState<TabValue>(readTabFromUrl);
  useEffect(() => {
    const onPop = () => setTab(readTabFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const onTabChange = (v: string) => {
    if (!isTab(v)) return;
    setTab(v);
    writeTabToUrl(v);
  };

  // Inline-edit state — controlled, seeded from the server payload, and
  // diffed against the original on save so we only PATCH actually changed
  // fields (matches the contract-detail behaviour).
  const [billingCurrency, setBillingCurrency] = useState("");
  const [isStrategic, setIsStrategic] = useState(false);
  const [isPreferred, setIsPreferred] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [internalNotes, setInternalNotes] = useState("");

  useEffect(() => {
    if (!data) return;
    setBillingCurrency(data.billingCurrency ?? "");
    setIsStrategic(data.isStrategic);
    setIsPreferred(data.isPreferred);
    setTags(data.tags ?? []);
    setInternalNotes(data.internalNotes ?? "");
  }, [data]);

  const patchM = usePatchSupplier({
    mutation: {
      onSuccess: (resp) => {
        toast({ title: "Supplier updated" });
        qc.setQueryData(getGetSupplierQueryKey(supplierId), resp);
        qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not save changes",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  if (isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading supplier…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-8 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/suppliers")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to suppliers
        </Button>
        <Card>
          <CardContent className="pt-6 text-destructive flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Could not load this supplier.
          </CardContent>
        </Card>
      </div>
    );
  }

  // What's dirty? Compute against the canonical server values so the
  // Save bar disappears the moment the cache is updated.
  const trimmedNotes = internalNotes.length > 0 ? internalNotes : null;
  const trimmedCurrency = billingCurrency.trim().toUpperCase() || null;
  const tagsChanged =
    tags.length !== (data.tags?.length ?? 0) ||
    tags.some((t, i) => (data.tags ?? [])[i] !== t);
  const dirty =
    trimmedCurrency !== (data.billingCurrency ?? null) ||
    isStrategic !== data.isStrategic ||
    isPreferred !== data.isPreferred ||
    tagsChanged ||
    trimmedNotes !== (data.internalNotes ?? null);

  const onSave = () => {
    if (!dirty) return;
    const payload: PatchSupplierRequest = {};
    if (trimmedCurrency !== (data.billingCurrency ?? null))
      payload.billingCurrency = trimmedCurrency;
    if (isStrategic !== data.isStrategic) payload.isStrategic = isStrategic;
    if (isPreferred !== data.isPreferred) payload.isPreferred = isPreferred;
    if (tagsChanged) payload.tags = tags;
    if (trimmedNotes !== (data.internalNotes ?? null))
      payload.internalNotes = trimmedNotes;
    patchM.mutate({ id: supplierId, data: payload });
  };
  const onDiscard = () => {
    setBillingCurrency(data.billingCurrency ?? "");
    setIsStrategic(data.isStrategic);
    setIsPreferred(data.isPreferred);
    setTags(data.tags ?? []);
    setTagDraft("");
    setInternalNotes(data.internalNotes ?? "");
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <Link
        href="/suppliers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        data-testid="link-back-to-suppliers"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to suppliers
      </Link>

      <Header data={data} />

      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList
          className="flex h-auto flex-wrap justify-start gap-1"
          data-testid="tabs-supplier"
        >
          <TabsTrigger value="overview" data-testid="tab-overview">
            <Building2 className="w-4 h-4 mr-1" /> Overview
          </TabsTrigger>
          <TabsTrigger value="spend" data-testid="tab-spend">
            <TrendingUp className="w-4 h-4 mr-1" /> Spend
          </TabsTrigger>
          <TabsTrigger value="contracts" data-testid="tab-contracts">
            <FileText className="w-4 h-4 mr-1" /> Contracts
            <Badge variant="outline" className="ml-1 text-[10px]">
              {data.contracts.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="opportunities" data-testid="tab-opportunities">
            <Zap className="w-4 h-4 mr-1" /> Opportunities
            <Badge variant="outline" className="ml-1 text-[10px]">
              {data.opportunities.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="fx" data-testid="tab-fx">
            <TrendingUp className="w-4 h-4 mr-1" /> FX exposure
          </TabsTrigger>
          <TabsTrigger value="risk" data-testid="tab-risk">
            <AlertTriangle className="w-4 h-4 mr-1" /> Risk &amp; alerts
          </TabsTrigger>
          <TabsTrigger value="activity" data-testid="tab-activity">
            <Activity className="w-4 h-4 mr-1" /> Activity
            <Badge variant="outline" className="ml-1 text-[10px]">
              {data.auditLog.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <ProfileEditCard
            billingCurrency={billingCurrency}
            setBillingCurrency={setBillingCurrency}
            isStrategic={isStrategic}
            setIsStrategic={setIsStrategic}
            isPreferred={isPreferred}
            setIsPreferred={setIsPreferred}
            tags={tags}
            setTags={setTags}
            tagDraft={tagDraft}
            setTagDraft={setTagDraft}
            internalNotes={internalNotes}
            setInternalNotes={setInternalNotes}
          />
          {intel ? <BillingCurrencyCard intel={intel} /> : null}
          <OverviewSummaryCard data={data} />
          {data.services.hasServicesActivity ? (
            <ServicesEngagementCard
              services={data.services}
              supplierId={data.id}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="spend" className="mt-4">
          <SpendTab spend={data.spend} />
        </TabsContent>

        <TabsContent value="contracts" className="mt-4">
          <ContractsTab items={data.contracts} />
        </TabsContent>

        <TabsContent value="opportunities" className="mt-4">
          <OpportunitiesTab items={data.opportunities} />
        </TabsContent>

        <TabsContent value="fx" className="mt-4">
          <FxTab
            billingCurrency={data.billingCurrency}
            fxSignals={data.fxSignals}
          />
        </TabsContent>

        <TabsContent value="risk" className="mt-4">
          <RiskTab
            intel={intel}
            isLoading={intelLoading}
            policy={policy}
          />
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <ActivityTab items={data.auditLog} />
        </TabsContent>
      </Tabs>

      {dirty && (
        <SaveBar
          onSave={onSave}
          onDiscard={onDiscard}
          saving={patchM.isPending}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------

function Header({ data }: { data: SupplierDetail }) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex items-start gap-3">
        <Building2 className="w-7 h-7 text-muted-foreground mt-1" />
        <div>
          <h1
            data-testid="text-supplier-name"
            className="text-3xl font-bold leading-tight flex items-center gap-2 flex-wrap"
          >
            {data.name}
            {data.isStrategic && (
              <Badge variant="default" className="text-[10px]">
                <Star className="w-3 h-3 mr-1" />
                Strategic
              </Badge>
            )}
            {data.isPreferred && (
              <Badge variant="secondary" className="text-[10px]">
                <ShieldCheck className="w-3 h-3 mr-1" />
                Preferred
              </Badge>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {data.countryCode ? `${data.countryCode} · ` : ""}
            Supplier ID <span className="font-mono">{data.id}</span>
            {data.billingCurrency ? (
              <>
                {" "}
                · Bills in{" "}
                <span className="font-mono">{data.billingCurrency}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>
      <Link
        href={`/fusion?tab=entity&entity=supplier:${data.id}`}
        data-testid="link-open-entity-360"
      >
        <Button variant="outline" size="sm">
          <Radar className="w-4 h-4 mr-2" />
          Open in Entity 360
          <ExternalLink className="w-3 h-3 ml-2" />
        </Button>
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------
// Save bar
// ---------------------------------------------------------------------

function SaveBar({
  onSave,
  onDiscard,
  saving,
}: {
  onSave: () => void;
  onDiscard: () => void;
  saving: boolean;
}) {
  return (
    <div
      className="sticky bottom-4 z-30 flex justify-end"
      data-testid="bar-save"
    >
      <div className="bg-card border border-border shadow-lg rounded-md px-4 py-2 flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          You have unsaved changes
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDiscard}
          disabled={saving}
          data-testid="btn-discard"
        >
          Discard
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={saving}
          data-testid="btn-save"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          Save
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------

function ProfileEditCard(props: {
  billingCurrency: string;
  setBillingCurrency: (v: string) => void;
  isStrategic: boolean;
  setIsStrategic: (v: boolean) => void;
  isPreferred: boolean;
  setIsPreferred: (v: boolean) => void;
  tags: string[];
  setTags: (v: string[]) => void;
  tagDraft: string;
  setTagDraft: (v: string) => void;
  internalNotes: string;
  setInternalNotes: (v: string) => void;
}) {
  const {
    billingCurrency,
    setBillingCurrency,
    isStrategic,
    setIsStrategic,
    isPreferred,
    setIsPreferred,
    tags,
    setTags,
    tagDraft,
    setTagDraft,
    internalNotes,
    setInternalNotes,
  } = props;

  const addTag = () => {
    const t = tagDraft.trim().toLowerCase();
    if (!t) return;
    if (tags.includes(t)) {
      setTagDraft("");
      return;
    }
    setTags([...tags, t]);
    setTagDraft("");
  };
  const removeTag = (t: string) => setTags(tags.filter((x) => x !== t));

  return (
    <Card data-testid="card-profile-edit">
      <CardHeader>
        <CardTitle className="text-base">Profile</CardTitle>
        <CardDescription>
          Inline-editable. Changes are audit-logged on save.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid sm:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="billing-currency">Billing currency</Label>
            <Input
              id="billing-currency"
              value={billingCurrency}
              onChange={(e) =>
                setBillingCurrency(e.target.value.toUpperCase().slice(0, 3))
              }
              placeholder="e.g. USD"
              maxLength={3}
              className="font-mono uppercase"
              data-testid="input-billing-currency"
            />
            <p className="text-xs text-muted-foreground">
              ISO-4217. Leave blank to inherit org base currency.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="strategic">Strategic supplier</Label>
            <div className="flex items-center gap-2 h-9">
              <Switch
                id="strategic"
                checked={isStrategic}
                onCheckedChange={setIsStrategic}
                data-testid="switch-strategic"
              />
              <span className="text-sm text-muted-foreground">
                {isStrategic ? "Yes" : "No"}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="preferred">Preferred supplier</Label>
            <div className="flex items-center gap-2 h-9">
              <Switch
                id="preferred"
                checked={isPreferred}
                onCheckedChange={setIsPreferred}
                data-testid="switch-preferred"
              />
              <span className="text-sm text-muted-foreground">
                {isPreferred ? "Yes" : "No"}
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Tags</Label>
          <div className="flex flex-wrap items-center gap-2">
            {tags.length === 0 && (
              <span className="text-xs text-muted-foreground">No tags</span>
            )}
            {tags.map((t) => (
              <Badge
                key={t}
                variant="outline"
                className="gap-1 pl-2 pr-1 py-0.5"
                data-testid={`tag-${t}`}
              >
                {t}
                <button
                  type="button"
                  onClick={() => removeTag(t)}
                  className="hover:text-destructive"
                  aria-label={`Remove ${t}`}
                  data-testid={`btn-remove-tag-${t}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex items-center gap-2 max-w-md">
            <Input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="Add tag and press Enter"
              data-testid="input-tag-draft"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addTag}
              disabled={!tagDraft.trim()}
              data-testid="btn-add-tag"
            >
              <Plus className="w-4 h-4 mr-1" />
              Add
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="internal-notes">Internal notes</Label>
          <Textarea
            id="internal-notes"
            value={internalNotes}
            onChange={(e) => setInternalNotes(e.target.value)}
            placeholder="Private notes visible only to your team. Up to 5000 characters."
            rows={4}
            maxLength={5000}
            data-testid="textarea-internal-notes"
          />
          <p className="text-xs text-muted-foreground tabular-nums">
            {internalNotes.length} / 5000
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function OverviewSummaryCard({ data }: { data: SupplierDetail }) {
  return (
    <Card data-testid="card-overview-summary">
      <CardHeader>
        <CardTitle className="text-base">At a glance (last 365 days)</CardTitle>
      </CardHeader>
      <CardContent className="grid sm:grid-cols-4 gap-4">
        <Stat
          label="Spend"
          value={formatUsd(data.spend.totalSpendUsd, { compact: true })}
          testid="stat-spend"
        />
        <Stat
          label="POs"
          value={data.spend.poCount.toLocaleString()}
          testid="stat-po-count"
        />
        <Stat
          label="Active contracts"
          value={data.contracts
            .filter((c) => c.derivedStatus !== "expired")
            .length.toLocaleString()}
          testid="stat-active-contracts"
        />
        <Stat
          label="Open opportunities"
          value={data.opportunities.length.toLocaleString()}
          testid="stat-open-opps"
        />
      </CardContent>
    </Card>
  );
}

function ServicesEngagementCard({
  services,
  supplierId,
}: {
  services: SupplierServicesEngagement;
  supplierId: string;
}) {
  // KPI deep-link targets — every counter that has a meaningful list
  // page on the Services tab routes through `?supplier=<id>` so the
  // operator can pivot from this 360 card straight into the filtered
  // listing. The Services page reads `supplier` off the URL and
  // applies it to the SOW/rate-card list endpoints.
  const sowsHref = `/services?tab=sows&supplier=${supplierId}`;
  const rateCardsHref = `/services?tab=rate-cards&supplier=${supplierId}`;
  const spendHref = `/services?tab=spend&supplier=${supplierId}`;
  return (
    <Card data-testid="card-services-engagement">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Wrench className="w-4 h-4 text-primary" />
          Services engagement (last 365 days)
        </CardTitle>
        <CardDescription>
          Operator-grade services KPIs: blended bill rate, off-card spend
          leakage, change-order volatility, and active utilisation signals.
          Each counter links to the filtered listing for this supplier.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Headline metrics
          </div>
          <div className="grid sm:grid-cols-4 gap-4">
            <Stat
              label="Avg blended rate"
              value={
                services.avgBlendedRateUsd != null
                  ? `${formatUsd(services.avgBlendedRateUsd)}/hr`
                  : "—"
              }
              href={rateCardsHref}
              testid="stat-avg-blended-rate"
            />
            <Stat
              label="Off-card spend"
              value={
                services.offCardSpendShare > 0
                  ? `${(services.offCardSpendShare * 100).toFixed(1)}%`
                  : "0%"
              }
              href={rateCardsHref}
              testid="stat-off-card-share"
            />
            <Stat
              label="Change-order ratio"
              value={
                services.changeOrderRatio > 0
                  ? `${(services.changeOrderRatio * 100).toFixed(1)}%`
                  : "0%"
              }
              href={sowsHref}
              testid="stat-change-order-ratio"
            />
            <Stat
              label="Utilisation signals"
              value={services.utilizationSignalCount.toLocaleString()}
              sub={
                services.utilizationSignalCount > 0
                  ? `${services.utilizationOverloadCount} overload · ${services.utilizationUnderutilCount} bench`
                  : "no person-week alerts"
              }
              href={sowsHref}
              testid="stat-utilization-signals"
            />
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Operational counters
          </div>
          <div className="grid sm:grid-cols-4 gap-4">
            <Stat
              label="Active SOWs"
              value={services.activeSowCount.toLocaleString()}
              href={sowsHref}
              testid="stat-active-sows"
            />
            <Stat
              label="Open milestones"
              value={services.openMilestoneCount.toLocaleString()}
              href={sowsHref}
              testid="stat-open-milestones"
            />
            <Stat
              label="Rate cards"
              value={services.rateCardCount.toLocaleString()}
              href={rateCardsHref}
              testid="stat-rate-cards"
            />
            <Stat
              label="Services spend"
              value={formatUsd(services.totalServicesSpendUsd, { compact: true })}
              href={spendHref}
              testid="stat-services-spend"
            />
            <Stat
              label="T&M spend"
              value={formatUsd(services.timeAndMaterialsSpendUsd, { compact: true })}
              href={spendHref}
              testid="stat-tm-spend"
            />
            <Stat
              label="Fixed-price spend"
              value={formatUsd(services.fixedPriceSpendUsd, { compact: true })}
              href={spendHref}
              testid="stat-fp-spend"
            />
            <Stat
              label="Next milestone due"
              value={
                services.upcomingMilestoneDueDate
                  ? formatDate(services.upcomingMilestoneDueDate)
                  : "—"
              }
              href={sowsHref}
              testid="stat-next-milestone"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  sub,
  href,
  testid,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Optional deep-link target. When set, the value renders as a link. */
  href?: string;
  testid?: string;
}) {
  const inner = (
    <>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div
        className={`text-base font-semibold tabular-nums mt-0.5${href ? " text-primary hover:underline" : ""}`}
      >
        {value}
      </div>
      {sub ? (
        <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>
      ) : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} data-testid={testid} className="block group">
        {inner}
      </Link>
    );
  }
  return <div data-testid={testid}>{inner}</div>;
}

// ---------------------------------------------------------------------
// Spend tab
// ---------------------------------------------------------------------

function SpendTab({ spend }: { spend: SupplierSpendRollup }) {
  const monthly = useMemo(
    () =>
      spend.monthly.map((m) => ({
        month: m.month.slice(0, 7),
        spend: m.spendUsd,
      })),
    [spend.monthly],
  );
  // CPI pushback context (#68): collapse the supplier's top categories
  // down to the unique BLS CPI scopes they map onto. Direct-materials
  // categories are intentionally unmapped (they belong to the PPI/
  // spot-vs-contract levers), so this list is small in practice.
  const cpiSeries = useMemo(() => {
    const seen = new Map<string, { label: string; categoryCode: string }>();
    for (const c of spend.topCategories) {
      const scope = c.cpiScopeCode;
      if (!scope || seen.has(scope)) continue;
      seen.set(scope, {
        label: cpiSeriesLabel(scope),
        categoryCode: scope,
      });
    }
    return Array.from(seen.values());
  }, [spend.topCategories]);
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-2" data-testid="card-spend-chart">
        <CardHeader>
          <CardTitle className="text-base">Monthly spend (USD)</CardTitle>
          <CardDescription>
            Trailing 365 days. Bars show invoiced PO spend converted to
            USD at PO posting time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {monthly.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No spend recorded for this supplier yet.
            </p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthly}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) =>
                      formatUsd(Number(v), { compact: true })
                    }
                    width={70}
                  />
                  <Tooltip
                    formatter={(v: number) => formatUsd(Number(v))}
                    labelFormatter={(l) => `Month: ${l}`}
                  />
                  <Bar dataKey="spend" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-top-categories">
        <CardHeader>
          <CardTitle className="text-base">Top categories</CardTitle>
          <CardDescription>By spend, last 365 days.</CardDescription>
        </CardHeader>
        <CardContent>
          {spend.topCategories.length === 0 ? (
            <p className="text-sm text-muted-foreground">No spend yet.</p>
          ) : (
            <ul className="text-sm divide-y">
              {spend.topCategories.map((c) => (
                <li
                  key={c.categoryId}
                  className="flex items-center justify-between py-2"
                  data-testid={`row-category-${c.categoryId}`}
                >
                  <span className="truncate pr-2 flex items-center gap-2">
                    {c.categoryName}
                    {c.cpiScopeCode ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] font-normal"
                        data-testid={`badge-cpi-${c.categoryId}`}
                        title={`Mapped to BLS CPI sub-series ${c.cpiScopeCode}. The CPI pushback chart below shows its trend.`}
                      >
                        CPI
                      </Badge>
                    ) : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground whitespace-nowrap">
                    {formatUsd(c.spendUsd, { compact: true })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {cpiSeries.length > 0 && (
        <div className="lg:col-span-3" data-testid="card-cpi-pushback">
          <BlsTrendChart
            series={cpiSeries}
            title="CPI pushback — relevant sub-indexes"
            description="Monthly BLS CPI sub-series for the consumer-facing categories this supplier serves. When the supplier asks for a price increase citing inflation, compare the ask to the matching CPI move and push back on anything that runs ahead of the index."
            emptyStateHint="Run the BLS Economic Index collector from the Collector Workbench to seed the CPI sub-series."
          />
        </div>
      )}
    </div>
  );
}

/**
 * Pretty-print a canonical BLS CPI scope code (`FOOD_AT_HOME`,
 * `ENERGY`, …) into a chart-friendly label. Mirrors the helper on
 * `contract-detail.tsx` — we keep them local rather than extracting a
 * shared util because the formatting is one line and a shared module
 * would invert the dependency direction (page → util → page).
 */
function cpiSeriesLabel(scopeCode: string): string {
  return `CPI: ${scopeCode
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ")}`;
}

// ---------------------------------------------------------------------
// Contracts tab
// ---------------------------------------------------------------------

function ContractsTab({ items }: { items: SupplierLinkedContract[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          No contracts linked to this supplier.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card data-testid="card-contracts">
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Contract</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Ends</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead className="text-right">Annual baseline</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow key={c.id} data-testid={`row-contract-${c.id}`}>
                <TableCell>
                  <Link
                    href={`/contracts/${c.id}`}
                    className="text-primary hover:underline"
                    data-testid={`link-contract-${c.id}`}
                  >
                    <div className="font-medium">{c.title}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {c.contractNumber}
                    </div>
                  </Link>
                </TableCell>
                <TableCell>
                  <DerivedStatusBadge
                    status={c.derivedStatus}
                    daysToExpiry={c.daysToExpiry ?? null}
                  />
                </TableCell>
                <TableCell className="text-sm">
                  {formatDate(c.endDate)}
                </TableCell>
                <TableCell className="text-sm font-mono">
                  {c.billingCurrency ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {c.annualBaselineUsd != null
                    ? formatUsd(c.annualBaselineUsd, { compact: true })
                    : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
// Opportunities tab
// ---------------------------------------------------------------------

function OpportunitiesTab({ items }: { items: SupplierLinkedOpportunity[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          No open savings opportunities for this supplier.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card data-testid="card-opportunities">
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Opportunity</TableHead>
              <TableHead>Lever</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Projected savings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((o) => (
              <TableRow key={o.id} data-testid={`row-opp-${o.id}`}>
                <TableCell>
                  <Link
                    href={`/opportunities/${o.id}`}
                    className="text-primary hover:underline"
                    data-testid={`link-opp-${o.id}`}
                  >
                    {o.title}
                  </Link>
                </TableCell>
                <TableCell className="text-xs uppercase tracking-wide text-muted-foreground">
                  {o.leverId.replace(/_/g, " ")}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px]">
                    {o.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">
                  {formatDate(o.createdAt)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatUsd(o.projectedSavingsUsd, { compact: true })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
// FX tab
// ---------------------------------------------------------------------

function FxTab({
  billingCurrency,
  fxSignals,
}: {
  billingCurrency: string | null | undefined;
  fxSignals: MarketSignal[];
}) {
  const cur = billingCurrency?.toUpperCase();
  if (!cur || cur === "USD") {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          {cur === "USD"
            ? "This supplier bills in USD — no FX exposure to chart."
            : "No billing currency on file. Set one in Overview to enable the FX exposure chart."}
        </CardContent>
      </Card>
    );
  }
  const pair = pickFxPair(billingCurrency, fxSignals);
  return (
    <FxTrendChart
      pairs={pair ? [pair] : []}
      title={`FX exposure — ${pair ?? cur}`}
      description={`Daily ECB reference rates for ${cur}. Movement here is an early indicator that the ${cur}-denominated side of this supplier's spend is drifting against your USD baseline.`}
      emptyStateHint="Backfill FX history from the Collector Workbench to populate this chart."
    />
  );
}

function pickFxPair(
  billingCurrency: string | null | undefined,
  fxSignals: MarketSignal[],
): string | null {
  const cur = billingCurrency?.toUpperCase();
  if (!cur || cur === "USD") return null;
  const pairs = new Set(
    fxSignals
      .map((s) => s.scopeMaterialCode?.toUpperCase())
      .filter((p): p is string => Boolean(p)),
  );
  const eurPair = `EUR/${cur}`;
  const usdPair = `USD/${cur}`;
  if (pairs.has(eurPair)) return eurPair;
  if (pairs.has(usdPair)) return usdPair;
  return eurPair;
}

// ---------------------------------------------------------------------
// Risk tab — wraps the existing supplier-intelligence panel.
// ---------------------------------------------------------------------

const RISK_TYPE_ORDER: SupplierIntelligenceSignalType[] = [
  "sanctions_match",
  "risk_screening_match",
  "corporate_filing",
  "entity_registry",
  "facility_emissions",
  "natural_hazard",
  "event_geocoded",
];

const RISK_TYPE_LABELS: Record<SupplierIntelligenceSignalType, string> = {
  sanctions_match: "Sanctions matches",
  risk_screening_match: "Risk-screening matches",
  corporate_filing: "Corporate filings",
  entity_registry: "Entity-registry updates",
  facility_emissions: "Facility emissions",
  natural_hazard: "Natural hazards",
  event_geocoded: "Geocoded events",
};

const RISK_TYPE_ICONS: Record<
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

/**
 * Auto-detected billing currency display + manual override form.
 * Lives in the Overview tab next to the editable profile so users can
 * see how the currency was inferred (source + confidence) and override
 * it via a dedicated mutation that records `manual_override` server-side.
 *
 * Only renders when the intelligence response has loaded — the bare
 * billing-currency string is also editable from the ProfileEditCard.
 */
export function BillingCurrencyCard({
  intel,
}: {
  intel: SupplierIntelligenceResponse;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const mutation = useOverrideSupplierBillingCurrency({
    mutation: {
      onSuccess: () => {
        // Refetch the intelligence response so the chip + source line
        // update in place. The `manual_override` source is server-set.
        // Also refetch the supplier detail so ProfileEditCard reflects
        // the new value without a manual reload.
        void queryClient.invalidateQueries({
          queryKey: getGetSupplierIntelligenceQueryKey(intel.supplierId),
        });
        void queryClient.invalidateQueries({
          queryKey: getGetSupplierQueryKey(intel.supplierId),
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
      id: intel.supplierId,
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
          {intel.billingCurrency ? (
            <span
              className="inline-flex items-center rounded-md border bg-card px-2 py-0.5 text-base font-mono font-medium"
              data-testid="text-billing-currency"
            >
              {intel.billingCurrency}
            </span>
          ) : (
            <span
              className="text-sm text-muted-foreground"
              data-testid="text-billing-currency-empty"
            >
              Not set — defaults to org base currency
            </span>
          )}
          {intel.billingCurrencyConfidence ? (
            <Badge
              variant={confidenceBadgeVariant(intel.billingCurrencyConfidence)}
              data-testid="badge-billing-confidence"
              data-confidence={intel.billingCurrencyConfidence}
            >
              {intel.billingCurrencyConfidence} confidence
            </Badge>
          ) : null}
        </div>

        {intel.billingCurrencySource ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-billing-source"
            data-source={intel.billingCurrencySource}
          >
            {BILLING_SOURCE_LABEL[intel.billingCurrencySource]}
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

function RiskTab({
  intel,
  isLoading,
  policy,
}: {
  intel: SupplierIntelligenceResponse | undefined;
  isLoading: boolean;
  policy: ReturnType<typeof usePolicy>;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading risk signals…
        </CardContent>
      </Card>
    );
  }
  if (!intel) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          No risk intelligence available.
        </CardContent>
      </Card>
    );
  }
  const grouped = new Map<
    SupplierIntelligenceSignalType,
    SupplierIntelligenceSignal[]
  >();
  for (const it of intel.items) {
    const arr = grouped.get(it.signalType) ?? [];
    arr.push(it);
    grouped.set(it.signalType, arr);
  }
  return (
    <Card data-testid="card-risk-and-filings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5" />
          Risk &amp; alerts
        </CardTitle>
        <CardDescription>
          Compact view — host for the full risk sidebar (#110).{" "}
          {intel.resolvedEntityUid ? (
            <>
              Resolved entity uid:{" "}
              <span className="font-mono">{intel.resolvedEntityUid}</span>
              {intel.resolvedMatchType
                ? ` · ${intel.resolvedMatchType}`
                : ""}
            </>
          ) : (
            "No canonical entity uid resolved — matched on supplier name only."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {intel.items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-signals">
            No sanctions, corporate-filing, or hazard signals matched
            this supplier in the current data window.
          </p>
        ) : (
          <div className="space-y-6">
            {RISK_TYPE_ORDER.filter((t) => grouped.has(t)).map((t) => (
              <RiskSignalGroup
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

function RiskSignalGroup({
  signalType,
  items,
  policy,
}: {
  signalType: SupplierIntelligenceSignalType;
  items: SupplierIntelligenceSignal[];
  policy: ReturnType<typeof usePolicy>;
}) {
  const Icon = RISK_TYPE_ICONS[signalType];
  return (
    <section data-testid={`group-${signalType}`}>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">
          {RISK_TYPE_LABELS[signalType]}
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          ({items.length})
        </span>
      </div>
      <ul className="space-y-3">
        {items.map((it) => (
          <RiskSignalRow key={it.id} item={it} policy={policy} />
        ))}
      </ul>
    </section>
  );
}

function RiskSignalRow({
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
          {formatDate(item.observedAt)}
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

// ---------------------------------------------------------------------
// Activity tab — supplier audit log
// ---------------------------------------------------------------------

function ActivityTab({ items }: { items: SupplierAuditEntry[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          No edits recorded for this supplier yet.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card data-testid="card-activity">
      <CardHeader>
        <CardTitle className="text-base">Audit log</CardTitle>
        <CardDescription>
          Every inline edit to this supplier, newest first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {items.map((e) => (
            <li
              key={e.id}
              className="py-3 flex items-start justify-between gap-4"
              data-testid={`row-audit-${e.id}`}
            >
              <div>
                <div className="text-sm">
                  <span className="font-medium">{e.actorEmail}</span> changed{" "}
                  <span className="font-mono text-xs">{e.field}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1 space-x-2">
                  <span>
                    from <code className="bg-muted px-1 py-0.5 rounded">
                      {renderAuditValue(e.oldValue)}
                    </code>
                  </span>
                  <span>
                    to <code className="bg-muted px-1 py-0.5 rounded">
                      {renderAuditValue(e.newValue)}
                    </code>
                  </span>
                </div>
              </div>
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                {formatDateTime(e.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function renderAuditValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length === 0 ? '""' : v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.length === 0 ? "[]" : v.join(", ");
  return JSON.stringify(v);
}
