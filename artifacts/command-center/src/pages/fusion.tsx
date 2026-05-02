import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearch } from "wouter";
import {
  useListIntelligenceSignals,
  useGetIntelligenceEntity360,
  useGetIntelligenceRiskHeatmap,
  useListIntelligenceEvents,
  useGetIntelligenceCoverageGaps,
  useListSuppliers,
  useListAlerts,
  getListIntelligenceSignalsQueryKey,
  getGetIntelligenceEntity360QueryKey,
  getGetIntelligenceRiskHeatmapQueryKey,
  getListIntelligenceEventsQueryKey,
  getGetIntelligenceCoverageGapsQueryKey,
  getListAlertsQueryKey,
  type IntelligenceSignal,
  type IntelligenceRiskScore,
  type IntelligenceRiskHeatmapCell,
  type IntelligenceRiskHeatmapResponseSitesItem,
  type IntelligenceEvent,
  type IntelligenceEventImpactPathItem,
  type IntelligenceCoverageGap,
  type Alert,
  type ListAlertsParams,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { InsightCitations } from "@/components/insight-citations";
import { RiskHeatmapMap } from "@/components/risk-heatmap-map";
import { usePolicy } from "@/lib/use-policy";
import { useWarRoomAlerts } from "@/lib/use-war-room-alerts";
import { formatUsd, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Building2,
  CirclePause,
  CirclePlay,
  Compass,
  Filter,
  Globe2,
  Map as MapIcon,
  Radar,
  Search,
  Siren,
  Sparkles,
  Shield,
  TrendingUp,
  X,
} from "lucide-react";
import { DefensePackPane } from "@/components/defense-pack-pane";
import { BlsTrendChart } from "@/components/bls-trend-chart";

const POLL_MS = 60_000;
// War room polls more aggressively than the rest of the fusion center
// because operators expect new disruption events to surface promptly.
// Same cadence is used by the global `WarRoomAlertsProvider` so the
// two queries dedupe inside React Query.
const WAR_ROOM_POLL_MS = 15_000;
// `NEW_BADGE_LINGER_MS` lives alongside the shared seen-id tracker in
// `use-war-room-alerts` so the per-row highlight inside this pane and
// the global decay loop agree on the linger window.

type FusionTab =
  | "signals"
  | "entity"
  | "heatmap"
  | "events"
  | "coverage"
  | "defense";

export default function Fusion() {
  // The fusion page accepts ?tab=… and ?cycleId=… deep-links from
  // sibling pages (OODA cycle cards, dashboard tiles). We read them
  // once at mount + whenever the search string changes so a click on
  // /fusion?tab=events&cycleId=cyc_… lands directly on the war room
  // pre-filtered to the cycle's window.
  const search = useSearch();
  const initialTab = useMemo<FusionTab>(() => {
    const t = new URLSearchParams(search).get("tab");
    return t === "entity" ||
      t === "heatmap" ||
      t === "events" ||
      t === "coverage" ||
      t === "defense"
      ? t
      : "signals";
  }, [search]);
  const [tab, setTab] = useState<FusionTab>(initialTab);
  const [activeEntityRef, setActiveEntityRef] = useState<string | null>(null);

  // Cross-link entry point: sibling pages can deep-link into a specific
  // Entity 360 view via `/fusion?tab=entity&entity=<kind>:<id>`. We
  // seed `activeEntityRef` from the URL param and re-sync whenever the
  // search string changes so back/forward and in-app pivots both work.
  const initialEntityRef = useMemo(
    () => new URLSearchParams(search).get("entity"),
    [search],
  );

  // Initialize activeEntityRef with initialEntityRef if provided
  useEffect(() => {
    if (initialEntityRef) {
      setActiveEntityRef(initialEntityRef);
    }
  }, [initialEntityRef]);

  // Pre-filter applied to the Signal Browser when the user clicks a
  // country on the Risk Heatmap map. We bump a nonce alongside the
  // value so back-to-back clicks on the same country still trigger
  // the child to sync (otherwise React would skip the prop update).
  const [signalsCountryPrefill, setSignalsCountryPrefill] = useState<{
    country: string;
    nonce: number;
  } | null>(null);
  const policy = usePolicy();
  const cycleId = useMemo(
    () => new URLSearchParams(search).get("cycleId"),
    [search],
  );
  // #161 cross-link: `/fusion?tab=events&eventId=<sig_…>` lands the
  // user on the war room with a specific event highlighted and the
  // row scrolled into view. We validate the prefix here so a
  // malformed deep-link can't poison the highlight state. Only
  // `sig_*` ids are valid market_signals ids.
  const focusedEventId = useMemo(() => {
    const raw = new URLSearchParams(search).get("eventId");
    return raw && /^sig_[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
  }, [search]);
  // If the URL switches tab while the page is mounted (in-app
  // navigation back to /fusion?tab=events) keep the visible pane in
  // sync with it.
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  // Auto-open the war room when a cycleId is supplied so the user
  // doesn't have to click into Events themselves.
  useEffect(() => {
    if (cycleId) setTab("events");
  }, [cycleId]);
  // #161: same auto-pivot for `?eventId=<sig_…>` deep-links from the
  // alerts inbox. We don't `setTab` inside the same effect as
  // `cycleId` because the two are independent triggers and combining
  // them would re-pivot whenever either changed.
  useEffect(() => {
    if (focusedEventId) setTab("events");
  }, [focusedEventId]);
  // Same for `?entity=` deep-links from Supplier 360 et al.
  useEffect(() => {
    if (initialEntityRef) setTab("entity");
  }, [initialEntityRef]);

  const openEntity = (ref: string) => {
    setActiveEntityRef(ref);
    setTab("entity");
  };
  const openSignalsForCountry = (countryIso2: string) => {
    setSignalsCountryPrefill((prev) => ({
      country: countryIso2.toUpperCase(),
      nonce: (prev?.nonce ?? 0) + 1,
    }));
    setTab("signals");
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex justify-between items-end gap-4 flex-wrap">
        <div>
          <h1
            data-testid="text-page-title"
            className="text-3xl font-bold flex items-center gap-2"
          >
            <Radar className="w-7 h-7 text-primary" />
            Intelligence Fusion Center
          </h1>
          <p className="text-muted-foreground mt-1 max-w-3xl">
            One pane of glass over every market signal your collectors gather.
            Browse signals, drill into a supplier or category, watch the
            geo-risk heatmap, follow the live war room, and find the coverage
            gaps where your spend has no eyes on it.
          </p>
        </div>
        <Badge
          variant="outline"
          data-testid="badge-policy"
          className="text-xs uppercase tracking-wide"
        >
          Disclosure policy: {policy}
        </Badge>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as FusionTab)}
        className="w-full"
      >
        <TabsList
          className="flex h-auto flex-wrap justify-start gap-1"
          data-testid="tabs-fusion"
        >
          <TabsTrigger value="signals" data-testid="tab-signals">
            <Filter className="w-4 h-4 mr-1" /> Signal Browser
          </TabsTrigger>
          <TabsTrigger value="entity" data-testid="tab-entity">
            <Building2 className="w-4 h-4 mr-1" /> Entity 360
          </TabsTrigger>
          <TabsTrigger value="heatmap" data-testid="tab-heatmap">
            <MapIcon className="w-4 h-4 mr-1" /> Risk Heatmap
          </TabsTrigger>
          <TabsTrigger value="events" data-testid="tab-events">
            <Siren className="w-4 h-4 mr-1" /> War Room
          </TabsTrigger>
          <TabsTrigger value="coverage" data-testid="tab-coverage">
            <Compass className="w-4 h-4 mr-1" /> Coverage Gaps
          </TabsTrigger>
          <TabsTrigger value="defense" data-testid="tab-defense-pack">
            <Shield className="w-4 h-4 mr-1" /> Defense Pack
          </TabsTrigger>
        </TabsList>

        <TabsContent value="signals" className="mt-4">
          {tab === "signals" && (
            <SignalBrowserPane
              onOpenEntity={openEntity}
              countryPrefill={signalsCountryPrefill}
            />
          )}
        </TabsContent>
        <TabsContent value="entity" className="mt-4">
          {tab === "entity" && (
            <EntityPane
              activeRef={activeEntityRef}
              onChange={setActiveEntityRef}
            />
          )}
        </TabsContent>
        <TabsContent value="heatmap" className="mt-4">
          {tab === "heatmap" && (
            <HeatmapPane
              onOpenEntity={openEntity}
              onOpenSignalsForCountry={openSignalsForCountry}
            />
          )}
        </TabsContent>
        <TabsContent value="events" className="mt-4">
          {tab === "events" && (
            <EventStreamPane
              cycleId={cycleId}
              focusedEventId={focusedEventId}
              onOpenEntity={openEntity}
            />
          )}
        </TabsContent>
        <TabsContent value="coverage" className="mt-4">
          {tab === "coverage" && <CoverageGapsPane onOpenEntity={openEntity} />}
        </TabsContent>
        <TabsContent value="defense" className="mt-4">
          {tab === "defense" && <DefensePackPane />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// =====================================================================
// Pane: Signal Browser
// =====================================================================

function SignalBrowserPane({
  onOpenEntity,
  countryPrefill,
}: {
  onOpenEntity: (ref: string) => void;
  countryPrefill?: { country: string; nonce: number } | null;
}) {
  const policy = usePolicy();
  const [signalType, setSignalType] = useState<string>("__all__");
  const [country, setCountry] = useState<string>(
    () => countryPrefill?.country ?? "",
  );
  const [q, setQ] = useState<string>("");

  // When the user clicks a country on the Risk Heatmap map, the
  // parent updates `countryPrefill` (with a nonce so back-to-back
  // clicks on the same country still re-trigger this effect). Mirror
  // it into local state so the input shows the value and the query
  // refetches.
  useEffect(() => {
    if (countryPrefill) setCountry(countryPrefill.country);
  }, [countryPrefill?.nonce, countryPrefill?.country]);

  const params = useMemo(() => {
    const out: {
      signalType?: string;
      country?: string;
      q?: string;
      limit: number;
    } = { limit: 100 };
    if (signalType !== "__all__") out.signalType = signalType;
    if (country.trim()) out.country = country.trim().toUpperCase();
    if (q.trim()) out.q = q.trim();
    return out;
  }, [signalType, country, q]);

  const { data, isLoading } = useListIntelligenceSignals(params, {
    query: {
      queryKey: getListIntelligenceSignalsQueryKey(params),
      refetchInterval: POLL_MS,
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="w-5 h-5" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Signal type
              </label>
              <Select value={signalType} onValueChange={setSignalType}>
                <SelectTrigger data-testid="signal-type-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All types</SelectItem>
                  <SelectItem value="commodity_price">Commodity price</SelectItem>
                  <SelectItem value="fx_rate">FX rate</SelectItem>
                  <SelectItem value="geopolitical_event">
                    Geopolitical event
                  </SelectItem>
                  <SelectItem value="supplier_news">Supplier news</SelectItem>
                  <SelectItem value="weather_disruption">
                    Weather disruption
                  </SelectItem>
                  <SelectItem value="freight_index">Freight index</SelectItem>
                  <SelectItem value="lead_time_index">
                    Lead-time index
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Country (ISO‑2)
              </label>
              <Input
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="e.g. CN"
                maxLength={2}
                data-testid="signal-country-input"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">
                Search supplier / material / lane
              </label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="acme corp, copper, US‑CN…"
                  className="pl-8"
                  data-testid="signal-q-input"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 justify-between">
            <span className="flex items-center gap-2">
              <Activity className="w-5 h-5" /> Signals
            </span>
            <span className="text-xs text-muted-foreground font-normal">
              {data
                ? `${data.totalCount} shown · ${data.droppedByPolicy} hidden by ${data.policy} policy`
                : null}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <SkeletonRows count={6} />}
          {!isLoading && items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No signals match these filters.
            </p>
          )}
          {!isLoading && items.length > 0 && (
            <div className="divide-y">
              {items.map((s) => (
                <SignalRow
                  key={s.id}
                  signal={s}
                  policy={policy}
                  onOpenEntity={onOpenEntity}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SignalRow({
  signal,
  policy,
  onOpenEntity,
}: {
  signal: IntelligenceSignal;
  policy: ReturnType<typeof usePolicy>;
  onOpenEntity: (ref: string) => void;
}) {
  const ref = entityRefForScope(signal.scope);
  return (
    <div
      className="py-3 grid grid-cols-12 gap-3 items-start text-sm"
      data-testid={`signal-row-${signal.id}`}
    >
      <div className="col-span-3 min-w-0">
        <div className="font-medium truncate">{signal.signalType}</div>
        <div className="text-xs text-muted-foreground">
          {formatDateTime(signal.observedAt)}
        </div>
      </div>
      <div className="col-span-3 min-w-0">
        {ref ? (
          <button
            type="button"
            onClick={() => onOpenEntity(ref)}
            className="text-left hover:underline truncate block"
            data-testid={`signal-scope-${signal.id}`}
          >
            <span className="text-xs uppercase text-muted-foreground mr-1">
              {signal.scope.kind}
            </span>
            {signal.scope.label}
          </button>
        ) : (
          <span className="text-muted-foreground italic">global</span>
        )}
      </div>
      <div className="col-span-2 tabular-nums">
        {Number.isFinite(signal.value) ? signal.value.toLocaleString() : "—"}
        {signal.unit ? (
          <span className="text-xs text-muted-foreground ml-1">
            {signal.unit}
          </span>
        ) : null}
      </div>
      <div className="col-span-1">
        <TierPill tier={signal.tier} />
      </div>
      <div className="col-span-3">
        <InsightCitations
          sources={[signal.source]}
          policy={policy}
          variant="compact"
          aggregateConfidence={signal.confidence ?? undefined}
        />
      </div>
    </div>
  );
}

// =====================================================================
// Pane: Entity 360
// =====================================================================

function EntityPane({
  activeRef,
  onChange,
}: {
  activeRef: string | null;
  onChange: (ref: string) => void;
}) {
  type EntityKind =
    | "supplier"
    | "material"
    | "category"
    | "lane"
    | "contract"
    | "site";
  const VALID_KINDS: readonly EntityKind[] = [
    "supplier",
    "material",
    "category",
    "lane",
    "contract",
    "site",
  ];
  const parseRef = (
    r: string | null,
  ): { kind: EntityKind; id: string } | null => {
    if (!r) return null;
    const sep = r.indexOf(":");
    if (sep <= 0 || sep === r.length - 1) return null;
    const k = r.slice(0, sep) as EntityKind;
    if (!VALID_KINDS.includes(k)) return null;
    return { kind: k, id: r.slice(sep + 1) };
  };
  const initial = parseRef(activeRef);
  const [kind, setKind] = useState<EntityKind>(initial?.kind ?? "supplier");
  const [supplierId, setSupplierId] = useState<string>(() =>
    initial && (initial.kind === "supplier" || initial.kind === "site")
      ? initial.id
      : "",
  );
  const [code, setCode] = useState<string>(() =>
    initial &&
    (initial.kind === "material" ||
      initial.kind === "category" ||
      initial.kind === "lane" ||
      initial.kind === "contract")
      ? initial.id
      : "",
  );

  // Deep-link consumption: when sibling pages navigate into the
  // Fusion Center via `/fusion?tab=entity&entity=<kind>:<id>`, the
  // parent seeds `activeEntityRef` from the URL inside a useEffect —
  // which runs AFTER our state initializers have already locked in
  // their (then-null) defaults. Sync them whenever `activeRef`
  // changes so a deep-link from supplier-detail (or any future
  // page) actually pre-fills the entity selector.
  useEffect(() => {
    const parsed = parseRef(activeRef);
    if (!parsed) return;
    setKind(parsed.kind);
    if (parsed.kind === "supplier" || parsed.kind === "site") {
      setSupplierId(parsed.id);
      setCode("");
    } else {
      setCode(parsed.id);
      setSupplierId("");
    }
    // `parseRef` is a stable closure over `VALID_KINDS` (constant),
    // so depending only on `activeRef` is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRef]);

  const { data: suppliersData } = useListSuppliers({ limit: 200 });
  const suppliers = suppliersData?.items ?? [];

  const usesSupplierPicker = kind === "supplier" || kind === "site";
  const id = usesSupplierPicker ? supplierId : code.trim();
  const enabled = id.length > 0;

  const { data, isLoading, error } = useGetIntelligenceEntity360(
    kind,
    enabled ? id : "__skip__",
    {
      query: {
        queryKey: getGetIntelligenceEntity360QueryKey(
          kind,
          enabled ? id : "__skip__",
        ),
        enabled,
        refetchInterval: POLL_MS,
      },
    },
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5" /> Entity selector
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Kind
              </label>
              <Select
                value={kind}
                onValueChange={(v) => {
                  setKind(v as typeof kind);
                  setSupplierId("");
                  setCode("");
                }}
              >
                <SelectTrigger data-testid="entity-kind-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="supplier">Supplier</SelectItem>
                  <SelectItem value="site">Site (supplier proxy)</SelectItem>
                  <SelectItem value="contract">Contract</SelectItem>
                  <SelectItem value="category">Category</SelectItem>
                  <SelectItem value="material">Material</SelectItem>
                  <SelectItem value="lane">Lane (country)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-2">
              {usesSupplierPicker ? (
                <>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    {kind === "site" ? "Site (supplier)" : "Supplier"}
                  </label>
                  <Select
                    value={supplierId || "__none__"}
                    onValueChange={(v) => {
                      const next = v === "__none__" ? "" : v;
                      setSupplierId(next);
                      if (next) onChange(`${kind}:${next}`);
                    }}
                  >
                    <SelectTrigger data-testid="entity-supplier-select">
                      <SelectValue placeholder="Pick a supplier" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— pick —</SelectItem>
                      {suppliers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    {kind === "lane"
                      ? "Country code (ISO‑2)"
                      : kind === "contract"
                        ? "Contract id"
                        : `${kind} code`}
                  </label>
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onBlur={() =>
                      code.trim() && onChange(`${kind}:${code.trim()}`)
                    }
                    placeholder={
                      kind === "lane"
                        ? "CN"
                        : kind === "material"
                          ? "SKU‑123"
                          : kind === "contract"
                            ? "ctr_..."
                            : "CAT‑01"
                    }
                    data-testid="entity-code-input"
                  />
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {!enabled && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Pick a {usesSupplierPicker ? "supplier" : kind} or enter a code to
            view its 360.
          </CardContent>
        </Card>
      )}

      {enabled && isLoading && (
        <Card>
          <CardContent className="py-6">
            <SkeletonRows count={4} />
          </CardContent>
        </Card>
      )}

      {enabled && error && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {String((error as Error).message ?? error)}
          </CardContent>
        </Card>
      )}

      {enabled && data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 justify-between">
                <span className="flex items-center gap-2">
                  {data.label}
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {data.kind}
                  </Badge>
                  {data.country && (
                    <Badge variant="outline" className="text-[10px]">
                      {data.country}
                    </Badge>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  {data.kind === "supplier" && id && (
                    <Link
                      href={`/suppliers/${id}`}
                      className="text-xs text-primary hover:underline font-normal"
                      data-testid="link-open-supplier-360"
                    >
                      Open Supplier 360 →
                    </Link>
                  )}
                  <span className="text-xs text-muted-foreground font-normal">
                    {data.recentSpend != null
                      ? `${
                          data.kind === "contract"
                            ? "Annual baseline"
                            : "Spend (90d)"
                        }: ${formatUsd(data.recentSpend, { compact: true })}`
                      : "Spend: n/a"}
                  </span>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {data.risk.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No risk dimensions scored yet — collectors haven't surfaced
                  signals for this entity.
                </p>
              )}
              {data.risk.map((r) => (
                <RiskScoreCard key={r.dimension} score={r} />
              ))}
            </CardContent>
          </Card>

          {data.details && (
            <EntityDetailsCard
              kind={data.kind}
              details={data.details}
              onOpenEntity={onChange}
            />
          )}

          {(data.kind === "material" || data.kind === "category") && id && (
            <BlsTrendChart
              series={[
                data.kind === "material"
                  ? { label: data.label, materialCode: id }
                  : { label: data.label, categoryCode: id },
              ]}
              title={`BLS price-index trend — ${data.label}`}
              description={
                data.kind === "material"
                  ? `Monthly BLS PPI observations scoped to material ${id}. Use the index trend to set context for any cost-driver discussion on this material.`
                  : `Monthly BLS PPI/CPI observations scoped to category ${id}. Use the index trend to set context for any cost-driver discussion on this category.`
              }
              emptyStateHint="Run the BLS Economic Index collector from the Collector Workbench to seed the index history for this scope."
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="w-5 h-5" /> Recent signals (
                {data.signals.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.signals.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No signals attached to this entity in the lookback window.
                </p>
              ) : (
                <div className="divide-y">
                  {data.signals.slice(0, 50).map((s) => (
                    <SignalRow
                      key={s.id}
                      signal={s}
                      policy={data.policy}
                      onOpenEntity={onChange}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * Renders the kind-specific `details` payload from the Entity 360
 * response. We keep this as a label/value grid that can grow as new
 * kinds add fields, instead of a one-component-per-kind explosion.
 *
 * Recognised links into other entities (contract → supplier / category,
 * site → supplier) are surfaced as click-to-open buttons so the user
 * can pivot without bouncing back to the kind selector.
 */
function EntityDetailsCard({
  kind,
  details,
  onOpenEntity,
}: {
  kind: string;
  details: Record<string, unknown>;
  onOpenEntity: (ref: string) => void;
}) {
  const get = (k: string) => details[k];
  const str = (k: string): string | null => {
    const v = get(k);
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const num = (k: string): number | null => {
    const v = get(k);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const date = (k: string): string | null => {
    const v = str(k);
    if (!v) return null;
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? formatDateTime(v) : v;
  };

  const rows: Array<{
    label: string;
    value: React.ReactNode;
    testid?: string;
  }> = [];

  if (kind === "contract") {
    if (str("contractNumber"))
      rows.push({
        label: "Contract #",
        value: str("contractNumber"),
        testid: "details-contract-number",
      });
    if (str("status"))
      rows.push({ label: "Status", value: str("status") });
    if (date("startDate"))
      rows.push({ label: "Start", value: date("startDate") });
    if (date("endDate"))
      rows.push({ label: "End", value: date("endDate") });
    const baseline = num("annualBaselineUsd");
    if (baseline != null)
      rows.push({
        label: "Annual baseline",
        value: formatUsd(baseline, { compact: true }),
      });
    const supplierId = str("supplierId");
    const supplierName = str("supplierName");
    if (supplierId && supplierName) {
      rows.push({
        label: "Supplier",
        value: (
          <button
            type="button"
            onClick={() => onOpenEntity(`supplier:${supplierId}`)}
            className="text-primary hover:underline"
            data-testid="details-supplier-link"
          >
            {supplierName} →
          </button>
        ),
      });
    }
    const categoryCode = str("categoryCode");
    const categoryName = str("categoryName");
    if (categoryCode) {
      rows.push({
        label: "Category",
        value: (
          <button
            type="button"
            onClick={() => onOpenEntity(`category:${categoryCode}`)}
            className="text-primary hover:underline"
            data-testid="details-category-link"
          >
            {categoryName ?? categoryCode} →
          </button>
        ),
      });
    }
  } else if (kind === "site") {
    const supplierId = str("supplierId");
    const supplierName = str("supplierName");
    if (supplierId && supplierName) {
      rows.push({
        label: "Supplier",
        value: (
          <button
            type="button"
            onClick={() => onOpenEntity(`supplier:${supplierId}`)}
            className="text-primary hover:underline"
            data-testid="details-supplier-link"
          >
            {supplierName} →
          </button>
        ),
      });
    }
    if (str("country"))
      rows.push({ label: "Country", value: str("country") });
    const lat = num("lat");
    const lng = num("lng");
    if (lat != null && lng != null) {
      rows.push({
        label: "Coordinates",
        value: `${lat.toFixed(2)}, ${lng.toFixed(2)}`,
      });
    }
    if (str("proxiedAs"))
      rows.push({
        label: "Source",
        value: `Proxied as ${str("proxiedAs")} (v1 — no dedicated sites table yet)`,
      });
  }

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          {kind === "contract" ? "Contract details" : "Site details"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {rows.map((r, i) => (
            <div key={i} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd
                className="font-medium tabular-nums"
                data-testid={r.testid}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function RiskScoreCard({ score }: { score: IntelligenceRiskScore }) {
  return (
    <div
      className={cn(
        "rounded-md border p-3 space-y-2",
        bandStyles(score.band),
      )}
      data-testid={`risk-${score.dimension}`}
    >
      <div className="flex items-center justify-between text-xs uppercase tracking-wide">
        <span className="font-medium">{score.dimension}</span>
        <Badge variant="outline" className="text-[10px]">
          {score.band}
        </Badge>
      </div>
      <div className="text-2xl font-bold tabular-nums">
        {Math.round(score.score)}
      </div>
      <div className="text-xs text-muted-foreground">
        {score.signalCount} signal{score.signalCount === 1 ? "" : "s"}
      </div>
      {score.topContributors.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          {score.topContributors.slice(0, 3).map((c) => (
            <li
              key={c.signalId}
              className="flex justify-between gap-2"
              data-testid={`contributor-${c.signalId}`}
            >
              <span className="truncate">
                {c.signalType}
                {c.collectorName ? (
                  <span className="opacity-60"> · {c.collectorName}</span>
                ) : null}
              </span>
              <span className="tabular-nums">{c.weighted.toFixed(1)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// =====================================================================
// Pane: Risk Heatmap
// =====================================================================
// We render an interactive Maplibre world map with country-level
// choropleth shading by default. Each country's color comes from its
// highest-band dimension across the window so regional concentrations
// jump out at a glance. The original grid table is still available
// (toggle, or automatic fallback if the map can't initialize) since
// it's the only view that surfaces the per-dimension breakdown.

function HeatmapPane({
  onOpenEntity,
  onOpenSignalsForCountry,
}: {
  onOpenEntity: (ref: string) => void;
  onOpenSignalsForCountry: (countryIso2: string) => void;
}) {
  const heatmapParams = { lookbackDays: 90 };
  const { data, isLoading } = useGetIntelligenceRiskHeatmap(heatmapParams, {
    query: {
      queryKey: getGetIntelligenceRiskHeatmapQueryKey(heatmapParams),
      refetchInterval: POLL_MS,
    },
  });

  const cellMap = useMemo(() => {
    const m = new Map<string, IntelligenceRiskHeatmapCell>();
    (data?.cells ?? []).forEach((c) => m.set(`${c.country}::${c.dimension}`, c));
    return m;
  }, [data?.cells]);

  const sites = data?.sites ?? [];
  const cells = data?.cells ?? [];

  // `view` controls what's primarily shown. When the map fails to
  // initialize we force-flip to "grid" and remember why so we can
  // surface a hint to the user instead of a blank pane.
  const [view, setView] = useState<"map" | "grid">("map");
  const [mapError, setMapError] = useState<string | null>(null);
  const handleMapUnavailable = useCallback((reason: string) => {
    setMapError(reason);
    setView("grid");
  }, []);

  return (
    <div className="space-y-4"><Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 justify-between flex-wrap">
          <span className="flex items-center gap-2">
            <Globe2 className="w-5 h-5" /> Geo × dimension risk heatmap
          </span>
          <span className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground font-normal">
              {data
                ? `${data.countries.length} countries · ${data.dimensions.length} dimensions · ${data.policy} policy`
                : null}
            </span>
            {!mapError && (
              <div className="flex rounded-md border overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setView("map")}
                  className={cn(
                    "px-2 py-1",
                    view === "map"
                      ? "bg-primary text-primary-foreground"
                      : "bg-card hover:bg-accent",
                  )}
                  data-testid="heatmap-view-map"
                >
                  Map
                </button>
                <button
                  type="button"
                  onClick={() => setView("grid")}
                  className={cn(
                    "px-2 py-1 border-l",
                    view === "grid"
                      ? "bg-primary text-primary-foreground"
                      : "bg-card hover:bg-accent",
                  )}
                  data-testid="heatmap-view-grid"
                >
                  Grid
                </button>
              </div>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <SkeletonRows count={6} />}
        {!isLoading && data && data.countries.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No country-scoped risk signals in the lookback window. Enable a
            geopolitical or sanctions collector on the Collector Workbench to
            populate this view.
          </p>
        )}
        {!isLoading && data && data.countries.length > 0 && view === "map" && (
          <div className="space-y-2">
            <RiskHeatmapMap
              cells={cells}
              sites={sites}
              onCountryClick={onOpenSignalsForCountry}
              onSiteClick={(siteId) => onOpenEntity(`site:${siteId}`)}
              onMapUnavailable={handleMapUnavailable}
            />
            <p className="text-xs text-muted-foreground">
              Click a country to open the Signal Browser pre-filtered to it.
              Each country is shaded by its highest-band dimension over the
              last 90 days. Switch to Grid for the per-dimension breakdown.
            </p>
          </div>
        )}
        {!isLoading && data && data.countries.length > 0 && view === "grid" && (
          <>
            {mapError && (
              <p
                className="text-xs text-amber-600 dark:text-amber-400 mb-2"
                data-testid="heatmap-map-fallback-notice"
              >
                Live world map unavailable — falling back to grid view.
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="text-sm border-collapse w-full">
                <thead>
                  <tr>
                    <th className="text-left p-2 text-xs text-muted-foreground sticky left-0 bg-card">
                      Country
                    </th>
                    {data.dimensions.map((d) => (
                      <th
                        key={d}
                        className="text-left p-2 text-xs text-muted-foreground uppercase"
                      >
                        {d}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.countries.map((c) => (
                    <tr key={c} className="border-t">
                      <td className="p-2 font-mono sticky left-0 bg-card">
                        <button
                          type="button"
                          onClick={() => onOpenSignalsForCountry(c)}
                          className="hover:underline"
                          data-testid={`heatmap-country-${c}`}
                        >
                          {c}
                        </button>
                      </td>
                      {data.dimensions.map((d) => {
                        const cell = cellMap.get(`${c}::${d}`);
                        return (
                          <td key={d} className="p-1">
                            {cell ? <HeatmapCell cell={cell} /> : <EmptyCell />}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
    {!isLoading && sites.length > 0 && (
      <Card data-testid="card-heatmap-sites">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 justify-between">
            <span className="flex items-center gap-2">
              <Globe2 className="w-5 h-5" /> Site exposure (top suppliers as
              proxy sites)
            </span>
            <span className="text-xs text-muted-foreground font-normal">
              {sites.length} site{sites.length === 1 ? "" : "s"} · sorted by
              max-dimension risk
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Each site's score is the highest-scoring risk dimension for its
            country. Lat/lng are country centroids until per-site geocoding
            ships. Click a row to open Entity 360.
          </p>
          <ul className="divide-y border rounded-md">
            {sites.slice(0, 25).map((s) => (
              <SiteRow
                key={`site-${s.siteId}`}
                site={s}
                onOpen={() => onOpenEntity(`site:${s.siteId}`)}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
    )}
    </div>
  );
}

/**
 * One row in the heatmap site list. Renders supplier name, country, the
 * single max-dimension risk score (band-tinted), 90d spend exposure, and
 * the centroid lat/lng for transparency about the proxy assumption.
 */
function SiteRow({
  site,
  onOpen,
}: {
  site: IntelligenceRiskHeatmapResponseSitesItem;
  onOpen: () => void;
}) {
  // `band` is generated as optional from the OpenAPI schema (the
  // server always emits it, but the spec doesn't list it under
  // required). Default to "low" for styling so we never throw on a
  // legacy payload.
  const band = site.band ?? "low";
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-3 py-2 text-left hover:bg-accent text-sm"
        data-testid={`heatmap-site-${site.siteId}`}
      >
        <div className="min-w-0">
          <div className="font-medium truncate">{site.label}</div>
          <div className="text-xs text-muted-foreground">
            {site.country}
            {site.lat != null && site.lng != null
              ? ` · ${site.lat.toFixed(1)}, ${site.lng.toFixed(1)}`
              : ""}
            {" · "}
            {site.signalCount} sig
          </div>
        </div>
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 text-xs font-mono tabular-nums",
            bandStyles(band),
          )}
        >
          {Math.round(site.riskScore)}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {site.recentSpend != null
            ? formatUsd(site.recentSpend, { compact: true })
            : "—"}
        </span>
        <span className="text-xs text-primary">→</span>
      </button>
    </li>
  );
}

function HeatmapCell({ cell }: { cell: IntelligenceRiskHeatmapCell }) {
  const top = (cell.topContributors ?? []).slice(0, 2);
  return (
    <div
      className={cn(
        "min-w-[5.5rem] rounded p-2 text-xs space-y-0.5",
        bandStyles(cell.band),
      )}
      data-testid={`heatmap-cell-${cell.country}-${cell.dimension}`}
      title={top.map((t) => `${t.signalType} (${t.weighted.toFixed(1)})`).join("\n")}
    >
      <div className="font-bold tabular-nums text-base">
        {Math.round(cell.score)}
      </div>
      <div className="opacity-70">
        {cell.signalCount} sig · {cell.band}
      </div>
    </div>
  );
}

function EmptyCell() {
  return (
    <div className="min-w-[5.5rem] rounded p-2 text-xs text-muted-foreground bg-muted/30">
      —
    </div>
  );
}

// =====================================================================
// Pane: Event Stream / War Room
// =====================================================================

function EventStreamPane({
  cycleId,
  focusedEventId,
  onOpenEntity,
}: {
  cycleId: string | null;
  focusedEventId: string | null;
  onOpenEntity: (ref: string) => void;
}) {
  const policy = usePolicy();
  const eventsParams: {
    hours: number;
    limit: number;
    cycleId?: string;
  } = { hours: 72, limit: 200 };
  if (cycleId) eventsParams.cycleId = cycleId;

  // Pause toggle: when paused we freeze the *visible* list (so an
  // analyst can study a specific event without it scrolling away) but
  // we deliberately keep polling in the background. That way we can
  // show a "X new events queued — resume" affordance the moment fresh
  // data lands, instead of leaving the operator blind to the firehose
  // they've temporarily silenced.
  const [paused, setPaused] = useState(false);

  const { data, isLoading, dataUpdatedAt, isFetching } =
    useListIntelligenceEvents(eventsParams, {
      query: {
        queryKey: getListIntelligenceEventsQueryKey(eventsParams),
        refetchInterval: WAR_ROOM_POLL_MS,
        refetchOnWindowFocus: true,
      },
    });
  const items = data?.items ?? [];

  // #161 cross-link: fetch the most recent alerts (any state) once so
  // each event row can show "triggered N alert(s)" without an N+1
  // round-trip per row. The alert payloads carry `marketSignalId` (or
  // the array form `marketSignalIds`); we build a `Map<eventId,
  // Alert[]>` and the EventRow looks itself up by `event.id`. We pull
  // 200 — same cap as the events list — which comfortably covers the
  // war-room window in steady state. If an event sits outside the
  // alerts cap (very busy tenant) the row simply shows no badge,
  // which fails closed.
  const alertsParams = useMemo<ListAlertsParams>(
    () => ({ limit: 200 }),
    [],
  );
  const alertsQ = useListAlerts(alertsParams, {
    query: {
      queryKey: getListAlertsQueryKey(alertsParams),
      refetchInterval: WAR_ROOM_POLL_MS,
      refetchOnWindowFocus: true,
    },
  });
  const alertsByEventId = useMemo<Map<string, Alert[]>>(() => {
    const m = new Map<string, Alert[]>();
    for (const a of alertsQ.data?.items ?? []) {
      const p = (a.payload ?? {}) as Record<string, unknown>;
      const ids: string[] = [];
      const arr = p["marketSignalIds"];
      if (Array.isArray(arr)) {
        for (const v of arr) if (typeof v === "string") ids.push(v);
      }
      const single = p["marketSignalId"];
      if (typeof single === "string" && !ids.includes(single)) {
        ids.push(single);
      }
      for (const id of ids) {
        const list = m.get(id);
        if (list) list.push(a);
        else m.set(id, [a]);
      }
    }
    return m;
  }, [alertsQ.data]);

  // ---- NEW-badge tracking ---------------------------------------------
  // The seen-id baseline + arrival timestamps now live in the global
  // `WarRoomAlertsProvider` (#170) so an arrival that happens while the
  // operator is on Dashboard still shows up as NEW the moment they
  // pivot to the war room — and so the sidebar counter and the row
  // highlight share a single source of truth. We also tell the
  // provider we're actively viewing so it suppresses toasts and
  // resets the unread counter on mount.
  const { newSince, registerViewing } = useWarRoomAlerts();
  useEffect(() => {
    return registerViewing();
  }, [registerViewing]);
  // Snapshot of items rendered at the moment the user clicked Pause.
  // We render this snapshot instead of the live `items` while paused.
  const [snapshot, setSnapshot] = useState<typeof items | null>(null);

  // #161: when an `?eventId=…` deep-link lands, scroll the matching
  // row into view and pulse it briefly. We watch `items` rather than
  // the URL because the row only exists in the DOM after the events
  // payload arrives — a one-shot effect against `focusedEventId`
  // alone would fire before the row was mounted. The DOM lookup uses
  // the existing `event-row-${id}` testid hook so we don't have to
  // wire up refs into every row.
  const focusedSatisfiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedEventId) {
      focusedSatisfiedRef.current = null;
      return;
    }
    if (focusedSatisfiedRef.current === focusedEventId) return;
    if (!items.some((e) => e.id === focusedEventId)) return;
    // Defer to the next frame so the just-rendered row is measurable.
    const handle = requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-testid="event-row-${focusedEventId}"]`,
      );
      if (el && "scrollIntoView" in el) {
        (el as HTMLElement).scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
      focusedSatisfiedRef.current = focusedEventId;
    });
    return () => cancelAnimationFrame(handle);
  }, [focusedEventId, items]);

  // Seen-id diff + NEW-badge decay used to live here as two effects;
  // both moved into `WarRoomAlertsProvider` so they keep ticking when
  // the operator is on Dashboard or Spend. We just read `newSince`
  // from the context now.

  // Snapshot management: capture on pause, drop on unpause.
  useEffect(() => {
    if (paused) {
      setSnapshot(items);
    } else {
      setSnapshot(null);
    }
    // We intentionally only re-snapshot when `paused` flips, not when
    // `items` shifts — that would defeat the freeze.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const displayed = paused && snapshot ? snapshot : items;
  const queuedWhilePaused = useMemo(() => {
    if (!paused || !snapshot) return 0;
    const snapIds = new Set(snapshot.map((e) => e.id));
    return items.reduce((n, e) => (snapIds.has(e.id) ? n : n + 1), 0);
  }, [paused, snapshot, items]);

  const lastUpdatedLabel = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString()
    : null;

  // Once data has arrived, decide whether the focused event is even
  // present in the current war-room window. If not, surface that
  // gracefully in the banner — sending the operator on a hunt for a
  // row that isn't there is worse than telling them outright.
  const focusedEventInWindow =
    focusedEventId !== null && items.some((e) => e.id === focusedEventId);

  return (
    <div className="space-y-4">
      {cycleId && (
        <Card data-testid="card-cycle-banner">
          <CardContent className="py-3 text-sm flex items-center justify-between gap-3 flex-wrap">
            <span className="text-muted-foreground">
              Filtered to OODA cycle{" "}
              <span className="font-mono text-foreground">{cycleId}</span> —
              window expanded to that cycle's start → completion.
            </span>
            <Link
              href="/fusion?tab=events"
              className="text-xs text-primary hover:underline"
              data-testid="link-clear-cycle"
            >
              Clear cycle filter →
            </Link>
          </CardContent>
        </Card>
      )}
      {focusedEventId && (
        <Card
          className="border-primary/30 bg-primary/5"
          data-testid="card-event-focus-banner"
        >
          <CardContent className="py-3 text-sm flex items-center justify-between gap-3 flex-wrap">
            <span className="flex items-center gap-2 min-w-0">
              <Bell className="w-4 h-4 text-primary shrink-0" />
              <span className="truncate">
                Highlighting stream event{" "}
                <span className="font-mono text-foreground">
                  {focusedEventId}
                </span>{" "}
                {isLoading
                  ? "— loading events…"
                  : focusedEventInWindow
                    ? "— scrolled into view below."
                    : `— not found in the current ${
                        cycleId ? "cycle window" : "72h window"
                      }.`}
              </span>
            </span>
            <Link
              href={
                cycleId
                  ? `/fusion?tab=events&cycleId=${encodeURIComponent(cycleId)}`
                  : "/fusion?tab=events"
              }
              className="text-xs text-primary hover:underline inline-flex items-center gap-1 shrink-0"
              data-testid="link-clear-event-focus"
            >
              <X className="w-3 h-3" /> Clear focus
            </Link>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 justify-between flex-wrap">
            <span className="flex items-center gap-2">
              <Siren className="w-5 h-5" /> War Room{" "}
              {cycleId ? "(cycle window)" : "(last 72h)"}
            </span>
            <div className="flex items-center gap-3 text-xs font-normal">
              {data && (
                <span className="text-muted-foreground">
                  {displayed.length} events · {data.droppedByPolicy} hidden by{" "}
                  {data.policy}
                </span>
              )}
              <div
                className="flex items-center gap-2"
                data-testid="war-room-pause-control"
              >
                {paused ? (
                  <CirclePause
                    className="w-3.5 h-3.5 text-amber-600"
                    aria-hidden
                  />
                ) : (
                  <CirclePlay
                    className={cn(
                      "w-3.5 h-3.5 text-emerald-600",
                      isFetching && "animate-pulse",
                    )}
                    aria-hidden
                  />
                )}
                <span
                  className={cn(
                    "uppercase tracking-wide",
                    paused ? "text-amber-600" : "text-emerald-600",
                  )}
                  data-testid="war-room-pause-state"
                >
                  {paused ? "Paused" : "Live"}
                </span>
                <Switch
                  checked={!paused}
                  onCheckedChange={(v) => setPaused(!v)}
                  aria-label={
                    paused ? "Resume War Room" : "Pause War Room"
                  }
                  data-testid="war-room-pause-toggle"
                />
              </div>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="flex items-center justify-between gap-3 flex-wrap text-xs text-muted-foreground mb-3"
            data-testid="war-room-status-line"
          >
            <span>
              {paused
                ? lastUpdatedLabel
                  ? `View frozen · backend last polled ${lastUpdatedLabel}`
                  : "View frozen"
                : lastUpdatedLabel
                  ? `Last refresh ${lastUpdatedLabel} · auto-refresh every ${
                      WAR_ROOM_POLL_MS / 1000
                    }s`
                  : `Auto-refresh every ${WAR_ROOM_POLL_MS / 1000}s`}
            </span>
            {paused && queuedWhilePaused > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setPaused(false)}
                data-testid="war-room-queued-button"
              >
                {queuedWhilePaused} new event
                {queuedWhilePaused === 1 ? "" : "s"} queued — resume
              </Button>
            )}
          </div>
          {isLoading && <SkeletonRows count={6} />}
          {!isLoading && displayed.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No geopolitical / disruption events in the{" "}
              {cycleId ? "cycle window" : "last 72 hours"}.
            </p>
          )}
          {!isLoading && displayed.length > 0 && (
            <ul className="space-y-2">
              {displayed.map((e) => (
                <EventRow
                  key={e.id}
                  event={e}
                  policy={policy}
                  onOpenEntity={onOpenEntity}
                  isNew={newSince.has(e.id)}
                  isFocused={e.id === focusedEventId}
                  triggeredAlerts={alertsByEventId.get(e.id) ?? []}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EventRow({
  event,
  policy,
  onOpenEntity,
  isNew = false,
  isFocused = false,
  triggeredAlerts = [],
}: {
  event: IntelligenceEvent;
  policy: ReturnType<typeof usePolicy>;
  onOpenEntity: (ref: string) => void;
  isNew?: boolean;
  // #161: when set, the row is the target of a `?eventId=…` deep-link
  // from the alerts inbox. We outline it and pulse a "Focused" chip
  // so the operator can immediately spot the event the alert pointed
  // at. Independent of `isNew` because the two have different
  // semantics — `isNew` = arrived since mount, `isFocused` = the URL
  // names this event.
  isFocused?: boolean;
  // #161: alerts whose payload references this event id. Pre-resolved
  // by the parent pane so we don't fan out an N+1 of per-row fetches.
  triggeredAlerts?: Alert[];
}) {
  const sev = event.severity ?? null;
  const sevTone =
    sev != null
      ? sev >= 7
        ? "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30"
        : sev >= 4
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30"
          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
      : "bg-muted text-muted-foreground border-border";
  // The set of distinct alert states across the triggered alerts —
  // shown in the badge title so an operator hovering the chip can
  // tell at a glance whether they've all been triaged or some are
  // still open.
  const triggeredOpenCount = triggeredAlerts.reduce(
    (n, a) => (a.state === "open" ? n + 1 : n),
    0,
  );
  return (
    <li
      className={cn(
        "border rounded-md p-3 space-y-1 transition-colors",
        isNew &&
          "border-primary/50 bg-primary/5 animate-in fade-in slide-in-from-top-2 duration-500",
        isFocused &&
          "ring-2 ring-primary/60 border-primary/60 bg-primary/5",
      )}
      data-testid={`event-row-${event.id}`}
      data-new={isNew ? "true" : "false"}
      data-focused={isFocused ? "true" : "false"}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium truncate flex items-center gap-2">
          {isNew && (
            <span
              className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-foreground animate-pulse"
              data-testid={`event-row-new-${event.id}`}
              aria-label="New event"
            >
              New
            </span>
          )}
          {isFocused && (
            <span
              className="rounded border border-primary/60 bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
              data-testid={`event-row-focused-${event.id}`}
              aria-label="Focused via deep-link"
            >
              Focus
            </span>
          )}
          <span className="truncate">
            {event.title ?? event.signalType}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {triggeredAlerts.length > 0 && (
            <Link
              href={`/alerts?filter=marketSignalId:${encodeURIComponent(
                event.id,
              )}`}
              className={cn(
                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:underline",
                triggeredOpenCount > 0
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-border bg-muted/40 text-muted-foreground",
              )}
              title={
                triggeredOpenCount > 0
                  ? `${triggeredOpenCount} open of ${triggeredAlerts.length} triggered`
                  : `${triggeredAlerts.length} triggered (all triaged)`
              }
              data-testid={`event-row-alerts-${event.id}`}
            >
              <Bell className="w-3 h-3" />
              {triggeredAlerts.length}
              {triggeredOpenCount > 0 ? ` · ${triggeredOpenCount} open` : ""}
              <ArrowUpRight className="w-3 h-3" />
            </Link>
          )}
          {event.country && (
            <Badge variant="outline" className="text-[10px]">
              {event.country}
            </Badge>
          )}
          {sev != null && (
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-[10px] font-mono",
                sevTone,
              )}
            >
              sev {sev.toFixed(1)}
            </span>
          )}
          <TierPill tier={event.tier} />
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {formatDateTime(event.observedAt)}
        {event.actor ? ` · ${event.actor}` : ""}
        {event.eventCode ? ` · ${event.eventCode}` : ""}
      </div>
      {event.impactPath && event.impactPath.length > 1 && (
        <ImpactPath
          path={event.impactPath}
          onOpenEntity={onOpenEntity}
        />
      )}
      <InsightCitations
        sources={[event.source]}
        policy={policy}
        variant="compact"
      />
    </li>
  );
}

/**
 * Renders the propagation chain for a war-room event:
 *   event → site → supplier → contract → category → spend
 *
 * Each step is a clickable chip that deep-links into Entity 360 via
 * the `kind:id` ref convention used by every other pane. The terminal
 * `spend` step shows the exposure dollar amount and is non-clickable.
 */
function ImpactPath({
  path,
  onOpenEntity,
}: {
  path: IntelligenceEventImpactPathItem[];
  onOpenEntity: (ref: string) => void;
}) {
  return (
    <div
      className="flex items-center flex-wrap gap-1 text-[11px] pt-1"
      data-testid="impact-path"
    >
      <span className="text-muted-foreground uppercase tracking-wide mr-1">
        Impact:
      </span>
      {path.map((step, i) => {
        const isLast = i === path.length - 1;
        const clickable =
          step.kind !== "event" &&
          step.kind !== "spend" &&
          typeof step.id === "string" &&
          step.id.length > 0;
        const label =
          step.kind === "spend" && step.exposureUsd != null
            ? `${step.label}: ${formatUsd(step.exposureUsd, { compact: true })}`
            : step.label;
        return (
          <span
            key={`${step.kind}-${i}`}
            className="flex items-center gap-1"
          >
            {clickable ? (
              <button
                type="button"
                onClick={() => onOpenEntity(`${step.kind}:${step.id}`)}
                className="rounded border px-1.5 py-0.5 hover:bg-accent hover:underline truncate max-w-[14rem]"
                data-testid={`impact-step-${step.kind}`}
                title={`${step.kind}: ${step.label}`}
              >
                {label}
              </button>
            ) : (
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 truncate max-w-[14rem]",
                  step.kind === "spend"
                    ? "bg-emerald-500/10 border-emerald-500/30"
                    : "bg-muted/50",
                )}
                data-testid={`impact-step-${step.kind}`}
              >
                {label}
              </span>
            )}
            {!isLast && (
              <span className="text-muted-foreground select-none">→</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// =====================================================================
// Pane: Coverage Gaps
// =====================================================================

function CoverageGapsPane({
  onOpenEntity,
}: {
  onOpenEntity: (ref: string) => void;
}) {
  const gapsParams = { lookbackDays: 90 };
  const { data, isLoading } = useGetIntelligenceCoverageGaps(gapsParams, {
    query: {
      queryKey: getGetIntelligenceCoverageGapsQueryKey(gapsParams),
      refetchInterval: POLL_MS,
    },
  });
  const items = data?.items ?? [];
  const totals = useMemo(() => {
    const t = { critical: 0, high: 0, medium: 0, low: 0 };
    items.forEach((g) => {
      t[g.severity] += 1;
    });
    return t;
  }, [items]);

  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-4 gap-3">
        <SeverityKpi
          label="Critical gaps"
          count={totals.critical}
          tone="red"
          icon={AlertTriangle}
        />
        <SeverityKpi
          label="High gaps"
          count={totals.high}
          tone="amber"
          icon={TrendingUp}
        />
        <SeverityKpi
          label="Medium"
          count={totals.medium}
          tone="amber"
          icon={Sparkles}
        />
        <SeverityKpi
          label="Well-covered"
          count={totals.low}
          tone="green"
          icon={Activity}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 justify-between">
            <span className="flex items-center gap-2">
              <Compass className="w-5 h-5" /> Coverage gaps (last 90d spend)
            </span>
            <Link
              href="/collectors"
              className="text-xs text-primary hover:underline"
              data-testid="link-collectors"
            >
              Open Collector Workbench →
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <SkeletonRows count={6} />}
          {!isLoading && items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Every spend bucket has at least one signal — no coverage gaps.
            </p>
          )}
          {!isLoading && items.length > 0 && (
            <div className="divide-y">
              {items.map((g, i) => (
                <CoverageGapRow
                  key={`${g.scopeKind}-${g.scopeId ?? g.scopeCode ?? g.scopeLabel}-${i}`}
                  gap={g}
                  onOpenEntity={onOpenEntity}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CoverageGapRow({
  gap,
  onOpenEntity,
}: {
  gap: IntelligenceCoverageGap;
  onOpenEntity: (ref: string) => void;
}) {
  const ref = entityRefForGap(gap);
  return (
    <div
      className="py-3 grid grid-cols-12 gap-3 items-center text-sm"
      data-testid={`gap-row-${gap.scopeKind}-${gap.scopeId ?? gap.scopeCode ?? gap.scopeLabel}`}
    >
      <div className="col-span-4 min-w-0">
        {ref ? (
          <button
            type="button"
            onClick={() => onOpenEntity(ref)}
            className="text-left hover:underline truncate block font-medium"
          >
            {gap.scopeLabel}
          </button>
        ) : (
          <span className="font-medium truncate block">{gap.scopeLabel}</span>
        )}
        <div className="text-xs text-muted-foreground">
          {gap.scopeKind}
          {gap.country ? ` · ${gap.country}` : ""}
        </div>
      </div>
      <div className="col-span-2 tabular-nums">
        {formatUsd(gap.recentSpend, { compact: true })}
      </div>
      <div className="col-span-2 tabular-nums">
        {gap.signalCount}{" "}
        <span className="text-xs text-muted-foreground">signals</span>
      </div>
      <div className="col-span-2">
        <Badge
          variant="outline"
          className={cn("text-[10px] uppercase", severityStyles(gap.severity))}
        >
          {gap.severity}
        </Badge>
      </div>
      <div className="col-span-2 text-xs text-muted-foreground truncate">
        {gap.recommendedCollectors && gap.recommendedCollectors.length > 0
          ? `Try: ${gap.recommendedCollectors.slice(0, 2).join(", ")}`
          : "—"}
      </div>
    </div>
  );
}

function SeverityKpi({
  label,
  count,
  tone,
  icon: Icon,
}: {
  label: string;
  count: number;
  tone: "red" | "amber" | "green";
  icon: React.ComponentType<{ className?: string }>;
}) {
  const tones: Record<typeof tone, string> = {
    red: "text-red-600 dark:text-red-400",
    amber: "text-amber-600 dark:text-amber-400",
    green: "text-emerald-600 dark:text-emerald-400",
  };
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className={cn("w-5 h-5", tones[tone])} />
        <div>
          <div className="text-2xl font-bold tabular-nums">{count}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

// =====================================================================
// Shared helpers / atoms
// =====================================================================

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

function TierPill({ tier }: { tier: "T1" | "T2" | "T3" | "T4" }) {
  const styles: Record<typeof tier, string> = {
    T1: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20",
    T2: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20",
    T3: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20",
    T4: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase",
        styles[tier],
      )}
    >
      {tier}
    </span>
  );
}

function bandStyles(
  band: "low" | "moderate" | "elevated" | "high",
): string {
  switch (band) {
    case "high":
      return "bg-red-500/10 border-red-500/30";
    case "elevated":
      return "bg-amber-500/10 border-amber-500/30";
    case "moderate":
      return "bg-yellow-500/10 border-yellow-500/30";
    case "low":
    default:
      return "bg-emerald-500/10 border-emerald-500/30";
  }
}

function severityStyles(
  s: "critical" | "high" | "medium" | "low",
): string {
  switch (s) {
    case "critical":
      return "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30";
    case "high":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30";
    case "medium":
      return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 border-yellow-500/30";
    case "low":
    default:
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
  }
}

function entityRefForScope(
  scope: IntelligenceSignal["scope"],
): string | null {
  switch (scope.kind) {
    case "supplier":
      // Prefer the resolved id; fall back to name only if no id is
      // available — Entity 360 keys suppliers by db id.
      if (scope.supplierId) return `supplier:${scope.supplierId}`;
      return null;
    case "category":
      return scope.categoryCode ? `category:${scope.categoryCode}` : null;
    case "material":
    case "sku":
      return scope.materialCode ? `material:${scope.materialCode}` : null;
    case "lane":
      return scope.laneKey ? `lane:${scope.laneKey}` : null;
    case "none":
    default:
      return null;
  }
}

function entityRefForGap(g: IntelligenceCoverageGap): string | null {
  switch (g.scopeKind) {
    case "supplier":
      return g.scopeId ? `supplier:${g.scopeId}` : null;
    case "category":
      return g.scopeCode ? `category:${g.scopeCode}` : null;
    case "material":
      return g.scopeCode ? `material:${g.scopeCode}` : null;
    default:
      return null;
  }
}
