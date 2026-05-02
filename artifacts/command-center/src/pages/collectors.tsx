/**
 * Collector Workbench — operator-facing console for the intelligence
 * collector fleet. The 8 tabs (Registry, Catalog, Source Health,
 * Lineage, Coverage, Posture & Compliance, Cost, Runs & Errors) each
 * fetch lazily so a quick visit to the Registry tab does not eagerly
 * pull every workbench dataset.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCollectors,
  useListCollectorCatalog,
  useListCollectorSourceHealth,
  useGetCollectorLineage,
  useGetCollectorCoverage,
  useGetCollectorCost,
  useGetCollectorCostTimeseries,
  useListCollectorRunsAndErrors,
  usePatchCollectorPosture,
  useBroadcastCollectorPosture,
  usePreviewBroadcastCollectorPosture,
  getPreviewBroadcastCollectorPostureQueryKey,
  useRunCollector,
  useBackfillEcbFxRates,
  useBackfillFredEconomicIndex,
  useListMarketSignals,
} from "@workspace/api-client-react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format";
import {
  Radar,
  Loader2,
  Play,
  History,
  Heart,
  Workflow,
  Map as MapIcon,
  Shield,
  DollarSign,
  AlertTriangle,
  ListChecks,
  BookMarked,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { FxTrendChart } from "@/components/fx-trend-chart";
import { BlsTrendChart } from "@/components/bls-trend-chart";
import { FredTrendChart } from "@/components/fred-trend-chart";

const ECB_FX_RATES_COLLECTOR_ID = "ecb-fx-rates";
const FRED_ECONOMIC_INDEX_COLLECTOR_ID = "fred-economic-index";

const POSTURE_LABEL: Record<string, string> = {
  "public-api": "Public API",
  "published-data": "Published data",
  "respect-robots-crawl": "Crawl (robots.txt respected)",
  "aggressive-crawl": "Aggressive crawl",
};

// Posture-class tones (the canonical lens — public_api / tos_restricted /
// gray_hat). The legacy posture badge is still rendered in some tabs for
// reference but the workbench grades risk on postureClass.
const POSTURE_CLASS_TONE: Record<string, string> = {
  public_api:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  tos_restricted:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  gray_hat: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};
const POSTURE_CLASS_LABEL: Record<string, string> = {
  public_api: "Public API",
  tos_restricted: "ToS-restricted",
  gray_hat: "Gray-hat",
};

const TIER_TONE: Record<string, string> = {
  T1: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  T2: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  T3: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  T4: "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-300",
};

// Cumulative tier filter modes — each mode includes the tiers ≤ its
// cap. Defaulting to T1+T2 keeps analyst-grade users out of the
// gray-hat bucket unless they explicitly opt in.
type TierMode = "T1" | "T1_T2" | "T1_T2_T3" | "all";

const TIER_MODE_LABEL: Record<TierMode, string> = {
  T1: "T1 only",
  T1_T2: "T1 + T2",
  T1_T2_T3: "T1 + T2 + T3",
  all: "All tiers (incl. T4)",
};

const TIER_MODE_INCLUDES: Record<TierMode, ReadonlyArray<string>> = {
  T1: ["T1"],
  T1_T2: ["T1", "T2"],
  T1_T2_T3: ["T1", "T2", "T3"],
  all: ["T1", "T2", "T3", "T4"],
};

type CollectorRow = {
  id: string;
  name: string;
  posture: string;
  postureClass: string;
  disclosureTier: string;
  jurisdiction: string;
  flagEmoji?: string | null;
  status: string;
  description?: string;
  sourceUrl?: string | null;
  defaultRateLimitRpm?: number | null;
  defaultScheduleCron?: string | null;
  lastRunAt?: string | Date | null;
  lastSignalCount?: number | null;
  lastInsertedCount?: number | null;
  lastDuplicateCount?: number | null;
  staleEmptyRuns?: boolean;
};

function tierMatches(
  mode: TierMode,
  value: string | undefined | null,
): boolean {
  if (!value) return mode === "all";
  return TIER_MODE_INCLUDES[mode].includes(value);
}

export default function Collectors() {
  const [tab, setTab] = useState("registry");
  // Workbench is operator/analyst-facing; default to the analyst tier
  // (T1+T2+T3) so opted-in third-party sources are visible by default.
  // Operators must still explicitly switch to "All" to see T4 (gray-hat /
  // never-disclosed) sources. The strictly-public T1+T2 view is exposed
  // for client-facing screen-shares.
  const [tier, setTier] = useState<TierMode>("T1_T2_T3");

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1
            data-testid="text-page-title"
            className="text-3xl font-bold flex items-center gap-2"
          >
            <Radar className="w-7 h-7 text-primary" />
            Collector Workbench
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            The operator console for the intelligence-collector fleet.
            Each tab is a lens — Catalog for the registry, Source Health
            for run telemetry, Posture &amp; Compliance for the
            disclosure tier, and so on. Switch tabs to load that view.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Disclosure tier
          </span>
          <Select value={tier} onValueChange={(v) => setTier(v as TierMode)}>
            <SelectTrigger
              data-testid="select-tier"
              className="w-[200px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TIER_MODE_LABEL) as TierMode[]).map((m) => (
                <SelectItem key={m} value={m} data-testid={`tier-option-${m}`}>
                  {TIER_MODE_LABEL[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList
          className="flex h-auto flex-wrap justify-start gap-1"
          data-testid="tabs-workbench"
        >
          <TabsTrigger value="registry" data-testid="tab-registry">
            <ListChecks className="w-4 h-4 mr-1" /> Registry
          </TabsTrigger>
          <TabsTrigger value="catalog" data-testid="tab-catalog">
            <BookMarked className="w-4 h-4 mr-1" /> Catalog
          </TabsTrigger>
          <TabsTrigger value="health" data-testid="tab-health">
            <Heart className="w-4 h-4 mr-1" /> Source Health
          </TabsTrigger>
          <TabsTrigger value="lineage" data-testid="tab-lineage">
            <Workflow className="w-4 h-4 mr-1" /> Lineage
          </TabsTrigger>
          <TabsTrigger value="coverage" data-testid="tab-coverage">
            <MapIcon className="w-4 h-4 mr-1" /> Coverage
          </TabsTrigger>
          <TabsTrigger value="posture" data-testid="tab-posture">
            <Shield className="w-4 h-4 mr-1" /> Posture &amp; Compliance
          </TabsTrigger>
          <TabsTrigger value="cost" data-testid="tab-cost">
            <DollarSign className="w-4 h-4 mr-1" /> Cost
          </TabsTrigger>
          <TabsTrigger value="runs" data-testid="tab-runs">
            <AlertTriangle className="w-4 h-4 mr-1" /> Runs &amp; Errors
          </TabsTrigger>
        </TabsList>

        <TabsContent value="registry" className="mt-4">
          {tab === "registry" && <RegistryTab tier={tier} />}
        </TabsContent>
        <TabsContent value="catalog" className="mt-4">
          {tab === "catalog" && <CatalogTab tier={tier} />}
        </TabsContent>
        <TabsContent value="health" className="mt-4">
          {tab === "health" && <HealthTab tier={tier} />}
        </TabsContent>
        <TabsContent value="lineage" className="mt-4">
          {tab === "lineage" && <LineageTab tier={tier} />}
        </TabsContent>
        <TabsContent value="coverage" className="mt-4">
          {tab === "coverage" && <CoverageTab tier={tier} />}
        </TabsContent>
        <TabsContent value="posture" className="mt-4">
          {tab === "posture" && <PostureTab tier={tier} />}
        </TabsContent>
        <TabsContent value="cost" className="mt-4">
          {tab === "cost" && <CostTab tier={tier} />}
        </TabsContent>
        <TabsContent value="runs" className="mt-4">
          {tab === "runs" && <RunsTab tier={tier} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// -------- Tab: Registry (preserves the old card-based view + actions) ---

function RegistryTab({ tier }: { tier: TierMode }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: collectors, isLoading } = useListCollectors();
  const { data: signals } = useListMarketSignals({ limit: 25 });
  // Catalog gives us the per-tenant opt-in resolution that listCollectors
  // doesn't carry. Used here to power the inline opt-in switch.
  const { data: catalog } = useListCollectorCatalog();
  const optInByCollector = useMemo(() => {
    const m = new Map<
      string,
      { tenantOptedIn: boolean | null; tenantOptInDefault: boolean | null }
    >();
    for (const e of catalog?.entries ?? []) {
      m.set(e.id, {
        tenantOptedIn: e.tenantOptedIn ?? null,
        tenantOptInDefault: e.tenantOptInDefault ?? null,
      });
    }
    return m;
  }, [catalog]);

  const optInPatch = usePatchCollectorPosture({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["listCollectorCatalog"] });
        qc.invalidateQueries({ queryKey: ["listCollectors"] });
        qc.invalidateQueries({ queryKey: ["listDataSources"] });
        toast({ title: "Opt-in updated" });
      },
      onError: (e: Error) =>
        toast({
          title: "Opt-in update failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const runM = useRunCollector({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: resp.skipped ? "Collector skipped" : "Collector ran",
          description: resp.skipped
            ? (resp.skipReason ?? "")
            : `${resp.signalsWritten} signals · ${resp.durationMs}ms`,
        });
        qc.invalidateQueries({ queryKey: ["listCollectors"] });
        qc.invalidateQueries({ queryKey: ["listMarketSignals"] });
      },
      onError: (e: Error) =>
        toast({
          title: "Collector failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const backfillEcbM = useBackfillEcbFxRates({
    mutation: {
      onSuccess: (resp) => {
        if (resp.alreadyUpToDate) {
          toast({
            title: "FX history already up to date",
            description: `Nothing new from the ECB archive · ${resp.durationMs}ms`,
          });
        } else {
          toast({
            title: "FX history backfilled",
            description: `${resp.daysWritten} days · ${resp.signalsInserted} new, ${resp.signalsSkipped} already had · ${resp.durationMs}ms`,
          });
        }
        qc.invalidateQueries({ queryKey: ["listMarketSignals"] });
      },
      onError: (e: Error) =>
        toast({
          title: "FX backfill failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const backfillFredM = useBackfillFredEconomicIndex({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "FRED PPI history backfilled",
          description: `${resp.daysWritten} days · ${resp.signalsInserted} new, ${resp.signalsSkipped} already had · ${resp.durationMs}ms`,
        });
        qc.invalidateQueries({ queryKey: ["listMarketSignals"] });
      },
      onError: (e: Error) =>
        toast({
          title: "FRED backfill failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const filtered = useMemo<CollectorRow[]>(
    () =>
      (collectors ?? []).filter((c) =>
        tierMatches(tier, (c as CollectorRow).disclosureTier),
      ) as CollectorRow[],
    [collectors, tier],
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Registered collectors</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {!isLoading && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No collectors match the selected tier.
            </p>
          )}
          <div className="space-y-3">
            {filtered.map((c) => (
              <div
                key={c.id}
                data-testid={`collector-${c.id}`}
                className="flex items-start justify-between gap-3 p-4 rounded-md border"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{c.name}</span>
                    {c.flagEmoji && (
                      <span title={c.jurisdiction}>{c.flagEmoji}</span>
                    )}
                    <Badge className={POSTURE_CLASS_TONE[c.postureClass]}>
                      {POSTURE_CLASS_LABEL[c.postureClass] ?? c.postureClass}
                    </Badge>
                    <Badge className={TIER_TONE[c.disclosureTier]}>
                      {c.disclosureTier}
                    </Badge>
                    <Badge
                      variant={
                        c.status === "enabled"
                          ? "default"
                          : c.status === "killed"
                            ? "destructive"
                            : "outline"
                      }
                    >
                      {c.status}
                    </Badge>
                    <Badge variant="outline" className="font-normal">
                      {POSTURE_LABEL[c.posture] ?? c.posture}
                    </Badge>
                    {c.staleEmptyRuns && (
                      // The stalled-feed chip fires when the runtime
                      // has recorded 3+ consecutive successful runs
                      // that all inserted zero new rows. The
                      // collector itself is healthy, but the upstream
                      // hasn't published anything new — operators see
                      // this and know to dig into the source rather
                      // than the collector code.
                      <Badge
                        data-testid={`badge-stale-${c.id}`}
                        className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        title="Last 3 runs returned only duplicates — upstream feed may be stalled."
                      >
                        <AlertTriangle className="w-3 h-3 mr-1" />
                        No new data
                      </Badge>
                    )}
                  </div>
                  {c.description && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {c.description}
                    </p>
                  )}
                  <div className="text-xs text-muted-foreground mt-2 space-y-0.5">
                    {c.sourceUrl && (
                      <div>
                        Source:{" "}
                        <a
                          href={c.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          {c.sourceUrl}
                        </a>
                      </div>
                    )}
                    {c.defaultRateLimitRpm && (
                      <div>Rate limit: {c.defaultRateLimitRpm} rpm</div>
                    )}
                    {c.defaultScheduleCron && (
                      <div>Schedule: {c.defaultScheduleCron}</div>
                    )}
                    <div>
                      Last run: {formatDateTime(c.lastRunAt)}
                    </div>
                    {/* Explicit new-vs-duplicate split. The runtime
                        records both halves on every `fetch_succeeded`
                        audit row; surfacing both lets operators
                        distinguish a stalled feed (0 new, many
                        duplicates) from a backfill (many new) at a
                        glance. We only render this row once we have
                        a real `lastRunAt` to anchor the counts to —
                        otherwise "0 new / 0 duplicates" looks like
                        a real signal when it's actually "never ran". */}
                    {c.lastRunAt && (
                      <div data-testid={`run-counts-${c.id}`}>
                        <span
                          className={
                            (c.lastInsertedCount ?? 0) > 0
                              ? "text-emerald-700 dark:text-emerald-400 font-medium"
                              : "text-muted-foreground"
                          }
                        >
                          {c.lastInsertedCount ?? 0} new signals
                        </span>
                        {" · "}
                        <span>
                          {c.lastDuplicateCount ?? 0} duplicates skipped
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-2 items-stretch">
                  {(() => {
                    // Per-tenant opt-in lives in the Registry tab so an
                    // operator can flip it from the same place where they
                    // run the collector. The Posture & Compliance tab
                    // exposes the same control alongside contract metadata
                    // for compliance review; both call the same endpoint
                    // so the source of truth is unambiguous.
                    const o = optInByCollector.get(c.id);
                    const optedIn = o?.tenantOptedIn ?? o?.tenantOptInDefault ?? false;
                    return (
                      <label className="flex items-center justify-between gap-2 text-xs whitespace-nowrap">
                        <span className="text-muted-foreground">
                          Tenant opt-in
                        </span>
                        <Switch
                          data-testid={`registry-optin-${c.id}`}
                          checked={optedIn}
                          disabled={optInPatch.isPending}
                          onCheckedChange={(checked) =>
                            optInPatch.mutate({
                              id: c.id,
                              data: { tenantOptedIn: checked },
                            })
                          }
                        />
                      </label>
                    );
                  })()}
                  <Button
                    data-testid={`btn-run-${c.id}`}
                    size="sm"
                    variant="outline"
                    onClick={() => runM.mutate({ id: c.id })}
                    disabled={runM.isPending || c.status !== "enabled"}
                  >
                    <Play className="w-4 h-4 mr-1" />
                    Run now
                  </Button>
                  {c.id === ECB_FX_RATES_COLLECTOR_ID && (
                    <Button
                      data-testid={`btn-backfill-${c.id}`}
                      size="sm"
                      variant="outline"
                      onClick={() => backfillEcbM.mutate()}
                      disabled={
                        backfillEcbM.isPending || c.status !== "enabled"
                      }
                      title="Load 5 years of historical ECB reference rates. Idempotent: safe to re-run."
                    >
                      {backfillEcbM.isPending ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : (
                        <History className="w-4 h-4 mr-1" />
                      )}
                      Backfill history
                    </Button>
                  )}
                  {c.id === FRED_ECONOMIC_INDEX_COLLECTOR_ID && (
                    <Button
                      data-testid={`btn-backfill-${c.id}`}
                      size="sm"
                      variant="outline"
                      onClick={() => backfillFredM.mutate()}
                      disabled={
                        backfillFredM.isPending || c.status !== "enabled"
                      }
                      title="Load 5 years of historical FRED PPI observations. Idempotent: safe to re-run."
                    >
                      {backfillFredM.isPending ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : (
                        <History className="w-4 h-4 mr-1" />
                      )}
                      Backfill history
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <FxTrendChart />

      <BlsTrendChart />

      <FredTrendChart />

      <Card>
        <CardHeader>
          <CardTitle>Recent market signals</CardTitle>
        </CardHeader>
        <CardContent>
          {(signals ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No signals yet — try running a collector above.
            </p>
          )}
          {(signals ?? []).length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
                  <th className="py-2">Signal</th>
                  <th className="py-2">Scope</th>
                  <th className="py-2 text-right">Value</th>
                  <th className="py-2 text-right">Observed</th>
                </tr>
              </thead>
              <tbody>
                {(signals ?? []).map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="py-2 font-medium">{s.signalType}</td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {s.scopeMaterialCode ??
                        s.scopeCategoryId ??
                        s.scopeSupplierId ??
                        "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {s.value} {s.unit ?? ""} {s.currency ?? ""}
                    </td>
                    <td className="py-2 text-right text-xs text-muted-foreground">
                      {formatDateTime(s.observedAt)}
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

// -------- Tab: Catalog --------------------------------------------------

function CatalogTab({ tier }: { tier: TierMode }) {
  const { data, isLoading } = useListCollectorCatalog();
  const entries = useMemo(
    () =>
      (data?.entries ?? []).filter((e) =>
        tierMatches(tier, e.disclosureTier),
      ),
    [data, tier],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Source catalog</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {!isLoading && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No catalog entries match the selected tier.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {entries.map((e) => (
            <div
              key={e.id}
              data-testid={`catalog-${e.id}`}
              className="rounded-md border p-4 space-y-2"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold">{e.name}</span>
                {e.flagEmoji && <span>{e.flagEmoji}</span>}
                <Badge className={POSTURE_CLASS_TONE[e.postureClass]}>
                  {POSTURE_CLASS_LABEL[e.postureClass] ?? e.postureClass}
                </Badge>
                <Badge className={TIER_TONE[e.disclosureTier]}>
                  {e.disclosureTier}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{e.description}</p>
              <div className="text-xs space-y-1">
                <div>
                  <span className="text-muted-foreground">License:</span>{" "}
                  {e.licenseNote || "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">Cadence:</span>{" "}
                  {e.cadenceLabel}
                </div>
                <div>
                  <span className="text-muted-foreground">Output:</span>{" "}
                  {e.outputSignalTypes?.join(", ") || "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">Scope kinds:</span>{" "}
                  {e.scopeKinds?.join(", ") || "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">Retention:</span>{" "}
                  {e.retentionDays ?? "—"} days
                </div>
                <div>
                  <span className="text-muted-foreground">PII:</span>{" "}
                  {e.piiClassification}
                </div>
                {e.tosUrl && (
                  <div>
                    <span className="text-muted-foreground">ToS:</span>{" "}
                    <a
                      href={e.tosUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {e.tosUrl}
                    </a>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// -------- Tab: Source Health --------------------------------------------

function HealthTab({ tier }: { tier: TierMode }) {
  const { data: catalog } = useListCollectorCatalog();
  const { data, isLoading } = useListCollectorSourceHealth({
    lookbackHours: 168,
  });

  const tierByCollector = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of catalog?.entries ?? []) m.set(e.id, e.disclosureTier);
    return m;
  }, [catalog]);

  const entries = useMemo(
    () =>
      (data?.entries ?? []).filter((e) =>
        tierMatches(tier, tierByCollector.get(e.collectorId)),
      ),
    [data, tier, tierByCollector],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Source health (last {data?.lookbackHours ?? 168}h)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {!isLoading && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">No data yet.</p>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
              <th className="py-2">Collector</th>
              <th className="py-2 text-right">Score</th>
              <th className="py-2 text-right">Runs</th>
              <th className="py-2 text-right">Failures</th>
              <th className="py-2 text-right">Drift</th>
              <th className="py-2 text-right">Last run</th>
              <th className="py-2 text-right">Last failure</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr
                key={e.collectorId}
                data-testid={`health-${e.collectorId}`}
                className="border-t"
              >
                <td className="py-2">
                  <div className="font-medium">{e.name}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Badge variant="outline" className="font-normal">
                      {e.status}
                    </Badge>
                    {e.staleEmptyRuns && (
                      <Badge
                        data-testid={`health-empty-${e.collectorId}`}
                        className="bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-300 font-normal"
                        title={
                          e.lastNonEmptyRunAt
                            ? `Last non-empty run ${formatDateTime(e.lastNonEmptyRunAt)}; runs since landed zero rows.`
                            : "No successful run has landed any rows in this window."
                        }
                      >
                        Empty source
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="py-2 text-right tabular-nums">
                  <span
                    className={
                      e.healthScore && e.healthScore >= 90
                        ? "text-green-600"
                        : e.healthScore && e.healthScore >= 50
                          ? "text-yellow-600"
                          : "text-red-600"
                    }
                  >
                    {e.healthScore ?? "—"}
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums">{e.runs}</td>
                <td className="py-2 text-right tabular-nums">{e.failures}</td>
                <td className="py-2 text-right tabular-nums">
                  {e.schemaDriftEvents ?? 0}
                </td>
                <td className="py-2 text-right text-xs text-muted-foreground">
                  {formatDateTime(e.lastRunAt ?? null)}
                </td>
                <td className="py-2 text-right text-xs text-muted-foreground">
                  {formatDateTime(e.lastFailureAt ?? null)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// -------- Tab: Lineage --------------------------------------------------

function LineageTab({ tier }: { tier: TierMode }) {
  const { data, isLoading } = useGetCollectorLineage();

  const filteredCollectors = useMemo(
    () =>
      (data?.collectors ?? []).filter((c) =>
        tierMatches(tier, c.disclosureTier),
      ),
    [data, tier],
  );

  // Down-filter edges to only those whose source is in the filtered
  // collector set (or downstream of one). Simple two-step BFS so the
  // diagram stays consistent with the tier filter.
  const reachable = useMemo(() => {
    const ids = new Set(filteredCollectors.map((c) => c.id));
    const tables = new Set<string>();
    const marts = new Set<string>();
    const consumers = new Set<string>();
    const collectorEdges: Array<{ from: string; to: string }> = [];
    const tableEdges: Array<{ from: string; to: string }> = [];
    const martEdges: Array<{ from: string; to: string }> = [];
    for (const e of data?.edges ?? []) {
      if (e.kind === "collector_to_table" && ids.has(e.from)) {
        tables.add(e.to);
        collectorEdges.push({ from: e.from, to: e.to });
      }
    }
    for (const e of data?.edges ?? []) {
      if (e.kind === "table_to_mart" && tables.has(e.from)) {
        marts.add(e.to);
        tableEdges.push({ from: e.from, to: e.to });
      }
    }
    for (const e of data?.edges ?? []) {
      if (e.kind === "mart_to_consumer" && marts.has(e.from)) {
        consumers.add(e.to);
        martEdges.push({ from: e.from, to: e.to });
      }
    }
    return {
      tables,
      marts,
      consumers,
      collectorEdges,
      tableEdges,
      martEdges,
    };
  }, [data, filteredCollectors]);

  // Build a deterministic Mermaid `flowchart LR` source from the
  // filtered graph. We sanitise IDs (Mermaid is picky about dots and
  // dashes) and stash the human-readable label inside the node.
  const mermaidSource = useMemo(() => {
    const sanitize = (s: string) =>
      s.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
    const lines: string[] = ["flowchart LR"];
    // Class definitions for posture-class tone in the diagram.
    lines.push(
      "classDef public_api fill:#dcfce7,stroke:#15803d,color:#14532d;",
    );
    lines.push(
      "classDef tos_restricted fill:#fef9c3,stroke:#a16207,color:#713f12;",
    );
    lines.push(
      "classDef gray_hat fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d;",
    );
    lines.push(
      "classDef table fill:#e0e7ff,stroke:#4338ca,color:#1e1b4b;",
    );
    lines.push(
      "classDef mart fill:#cffafe,stroke:#0e7490,color:#083344;",
    );
    lines.push(
      "classDef consumer fill:#f5d0fe,stroke:#a21caf,color:#3b0764;",
    );

    const seen = new Set<string>();
    for (const c of filteredCollectors) {
      const id = `c_${sanitize(c.id)}`;
      if (!seen.has(id)) {
        const label = `${c.name.replace(/"/g, "'")} [${c.disclosureTier}]`;
        lines.push(`${id}["${label}"]:::${c.postureClass}`);
        seen.add(id);
      }
    }
    for (const t of reachable.tables) {
      const id = `t_${sanitize(t)}`;
      if (!seen.has(id)) {
        lines.push(`${id}[("${t.replace(/"/g, "'")}")]:::table`);
        seen.add(id);
      }
    }
    for (const m of reachable.marts) {
      const id = `m_${sanitize(m)}`;
      if (!seen.has(id)) {
        lines.push(`${id}[/"${m.replace(/"/g, "'")}"/]:::mart`);
        seen.add(id);
      }
    }
    for (const c of reachable.consumers) {
      const id = `o_${sanitize(c)}`;
      if (!seen.has(id)) {
        lines.push(`${id}(["${c.replace(/"/g, "'")}"]):::consumer`);
        seen.add(id);
      }
    }
    for (const e of reachable.collectorEdges) {
      lines.push(`c_${sanitize(e.from)} --> t_${sanitize(e.to)}`);
    }
    for (const e of reachable.tableEdges) {
      lines.push(`t_${sanitize(e.from)} --> m_${sanitize(e.to)}`);
    }
    for (const e of reachable.martEdges) {
      lines.push(`m_${sanitize(e.from)} --> o_${sanitize(e.to)}`);
    }
    return lines.join("\n");
  }, [filteredCollectors, reachable]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (filteredCollectors.length === 0) {
      containerRef.current.innerHTML = "";
      setRenderError(null);
      return;
    }
    let cancelled = false;
    setRenderError(null);
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          flowchart: { htmlLabels: true, useMaxWidth: true },
          securityLevel: "strict",
        });
        const id = `lineage-mermaid-${Math.random().toString(36).slice(2, 8)}`;
        const { svg } = await mermaid.render(id, mermaidSource);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch (err) {
        if (!cancelled) {
          setRenderError(
            err instanceof Error ? err.message : "Failed to render diagram",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mermaidSource, filteredCollectors.length]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lineage</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {!isLoading && filteredCollectors.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No collectors match the current tier filter.
          </p>
        )}
        {renderError && (
          <p
            className="text-sm text-destructive"
            data-testid="lineage-mermaid-error"
          >
            Diagram render failed: {renderError}
          </p>
        )}
        <div
          ref={containerRef}
          data-testid="lineage-mermaid"
          className="mermaid w-full overflow-auto text-sm"
        />
        {/* Hidden, machine-readable nodes — preserved so existing
            tests that key off `lineage-collector-<id>` /
            `lineage-tier-<id>` keep passing without being visually
            duplicated next to the diagram. */}
        <div className="sr-only">
          {filteredCollectors.map((c) => (
            <span
              key={c.id}
              data-testid={`lineage-collector-${c.id}`}
              data-tier={c.disclosureTier}
            >
              <span data-testid={`lineage-tier-${c.id}`}>
                {c.disclosureTier}
              </span>
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// -------- Tab: Coverage -------------------------------------------------

function CoverageTab({ tier }: { tier: TierMode }) {
  const { data, isLoading } = useGetCollectorCoverage();
  const { data: catalog } = useListCollectorCatalog();

  // Tier filter: a coverage row is "in tier" if at least one of its
  // covering collectors is in tier. We also filter the displayed
  // `coveredBy` list so the row text doesn't reveal a collector that
  // would otherwise be hidden by the active tier.
  const tierByCollector = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of catalog?.entries ?? []) m.set(e.id, e.disclosureTier);
    return m;
  }, [catalog]);
  const filteredRows = useMemo(() => {
    return (data?.rows ?? [])
      .map((r) => ({
        ...r,
        coveredBy: r.coveredBy.filter((cid) =>
          tierMatches(tier, tierByCollector.get(cid)),
        ),
      }))
      // Drop rows whose only coverers were filtered out — at the
      // tightest tier setting we'd otherwise show a "Gap" cell that
      // is misleading (the gap exists only relative to the filter).
      .filter((r) => r.coveredBy.length > 0);
  }, [data, tier, tierByCollector]);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Material coverage</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {!isLoading && filteredRows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {(data?.rows ?? []).length === 0
                ? "No material signals yet — coverage will populate after the first collector runs."
                : "No coverage rows match the current tier filter."}
            </p>
          )}
          {filteredRows.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
                  <th className="py-2">Material</th>
                  <th className="py-2 text-right">Signals</th>
                  <th className="py-2">Covered by</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => {
                  const label = data?.materials?.find(
                    (m) => m.code === r.materialCode,
                  )?.label;
                  return (
                    <tr
                      key={r.materialCode}
                      data-testid={`coverage-row-${r.materialCode}`}
                      className="border-t"
                    >
                      <td className="py-2">
                        <div className="font-mono text-xs">
                          {r.materialCode}
                        </div>
                        {label && (
                          <div className="text-xs text-muted-foreground">
                            {label}
                          </div>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {r.signalCount}
                      </td>
                      <td className="py-2 text-xs">
                        {r.coveredBy.length === 0 ? (
                          <span className="text-red-600">Gap</span>
                        ) : (
                          r.coveredBy.join(", ")
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tenant supplier jurisdictions</CardTitle>
        </CardHeader>
        <CardContent>
          {(data?.supplierCountryCounts ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No suppliers ingested yet.
            </p>
          )}
          {(data?.supplierCountryCounts ?? []).map((c) => (
            <div
              key={c.countryCode ?? "unknown"}
              className="flex items-center justify-between text-sm py-1"
            >
              <span>{c.countryCode ?? "Unspecified"}</span>
              <span className="tabular-nums">{c.supplierCount}</span>
            </div>
          ))}
          <div className="text-xs text-muted-foreground mt-3">
            Collector jurisdictions:{" "}
            {(data?.jurisdictions ?? []).join(", ") || "—"}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// -------- Tab: Posture & Compliance ------------------------------------

function PostureTab({ tier }: { tier: TierMode }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListCollectorCatalog();
  const patch = usePatchCollectorPosture({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["listCollectorCatalog"] });
        qc.invalidateQueries({ queryKey: ["listCollectors"] });
        qc.invalidateQueries({ queryKey: ["listDataSources"] });
        toast({ title: "Posture updated" });
      },
      onError: (e: Error) =>
        toast({
          title: "Posture update failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });
  const broadcast = useBroadcastCollectorPosture({
    mutation: {
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: ["listCollectorCatalog"] });
        qc.invalidateQueries({ queryKey: ["listCollectors"] });
        qc.invalidateQueries({ queryKey: ["listDataSources"] });
        toast({
          title: "Posture broadcast applied",
          description: `Updated ${result.tenantsAffected} tenant(s).`,
        });
      },
      onError: (e: Error) =>
        toast({
          title: "Broadcast failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const entries = useMemo(
    () =>
      (data?.entries ?? []).filter((e) =>
        tierMatches(tier, e.disclosureTier),
      ),
    [data, tier],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Posture &amp; compliance</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
              <th className="py-2">Collector</th>
              <th className="py-2">Posture</th>
              <th className="py-2">Tier</th>
              <th className="py-2">Jurisdiction</th>
              <th className="py-2 text-right">Retention</th>
              <th className="py-2 text-right">Tenant opt-in</th>
              <th className="py-2 text-right">Broadcast</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const optedIn =
                e.tenantOptedIn ?? e.tenantOptInDefault ?? false;
              return (
                <tr
                  key={e.id}
                  data-testid={`posture-${e.id}`}
                  className="border-t"
                >
                  <td className="py-2">
                    <div className="font-medium">{e.name}</div>
                    {e.tosUrl && (
                      <a
                        href={e.tosUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-muted-foreground underline"
                      >
                        ToS
                      </a>
                    )}
                  </td>
                  <td className="py-2">
                    <Badge className={POSTURE_CLASS_TONE[e.postureClass]}>
                      {POSTURE_CLASS_LABEL[e.postureClass] ?? e.postureClass}
                    </Badge>
                  </td>
                  <td className="py-2">
                    <Badge className={TIER_TONE[e.disclosureTier]}>
                      {e.disclosureTier}
                    </Badge>
                  </td>
                  <td className="py-2 text-xs">
                    {e.flagEmoji} {e.jurisdiction}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {e.retentionDays ?? "—"}d
                  </td>
                  <td className="py-2 text-right">
                    <Switch
                      data-testid={`posture-optin-${e.id}`}
                      checked={optedIn}
                      disabled={patch.isPending}
                      onCheckedChange={(checked) =>
                        patch.mutate({
                          id: e.id,
                          data: { tenantOptedIn: checked },
                        })
                      }
                    />
                  </td>
                  <td className="py-2 text-right">
                    <BroadcastPostureControl
                      collectorId={e.id}
                      collectorName={e.name}
                      pending={broadcast.isPending}
                      onBroadcast={(tenantOptedIn) =>
                        broadcast.mutate({
                          id: e.id,
                          data: { tenantOptedIn },
                        })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// -------- Tab: Cost ----------------------------------------------------

function CostTab({ tier }: { tier: TierMode }) {
  // Trend window — 7d defaults match the operator-favoured horizon
  // (catches a week-of-data creep) and 30d gives a longer baseline
  // for fixed-cost collectors. Keep it small and explicit; we don't
  // need a free-form picker on the workbench.
  const [lookbackDays, setLookbackDays] = useState<7 | 30>(7);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Single-window snapshot — same source/basis story as before.
  const { data, isLoading } = useGetCollectorCost({
    lookbackHours: lookbackDays * 24,
  });
  // Per-day timeseries — drives the per-row sparkline + drilldown.
  // Fetched in parallel with the snapshot so the table renders the
  // basis chip from `data` while the sparkline renders from `series`.
  const { data: series, isLoading: isSeriesLoading } =
    useGetCollectorCostTimeseries({ lookbackDays });

  const { data: catalog } = useListCollectorCatalog();
  const tierByCollector = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of catalog?.entries ?? []) m.set(e.id, e.disclosureTier);
    return m;
  }, [catalog]);
  const entries = useMemo(
    () =>
      (data?.entries ?? []).filter((e) =>
        tierMatches(tier, tierByCollector.get(e.collectorId)),
      ),
    [data, tier, tierByCollector],
  );

  // Index timeseries entries by collector id so each row can pull
  // its own sparkline / drilldown points without re-scanning.
  const seriesByCollector = useMemo(() => {
    const m = new Map<
      string,
      NonNullable<typeof series>["entries"][number]
    >();
    for (const e of series?.entries ?? []) m.set(e.collectorId, e);
    return m;
  }, [series]);

  // Source / basis label — kept in one place so the header badge and
  // the explainer paragraph never drift. The four sources collapse
  // into two operator-facing concepts: "Real" (billed dollars) vs
  // "Estimate" (derived from our own bookkeeping). The exact source
  // is shown as a sub-line so finance can audit which path paid out.
  const source = data?.source ?? "proxy";
  const sourceMeta: Record<
    string,
    { label: string; basis: "real" | "estimate"; explainer: string }
  > = {
    billing: {
      label: "GCP Billing export",
      basis: "real",
      explainer:
        "Real billed dollars from the GCP Cloud Billing export (cached 24h). Splits BigQuery query cost from Cloud Storage cost; per-collector attribution by bytes_raw share.",
    },
    information_schema: {
      label: "BigQuery INFORMATION_SCHEMA",
      basis: "real",
      explainer:
        "Real per-job billed bytes from BigQuery INFORMATION_SCHEMA.JOBS_BY_PROJECT × $5/TB on-demand pricing (cached 24h). Attribution via the collector_id job label. Set GCP_BILLING_EXPORT_TABLE for all-in dollar figures including storage.",
    },
    bigquery: {
      label: "BigQuery bytes_raw estimate",
      basis: "estimate",
      explainer:
        "On-demand-pricing estimate from collector_runs.bytes_raw × $5/TB (cached 24h). Switches to real per-job cost automatically once any collector job runs with the collector_id label, or to billing dollars when GCP_BILLING_EXPORT_TABLE is set.",
    },
    proxy: {
      label: "Audit-log proxy",
      basis: "estimate",
      explainer:
        "BigQuery cost read unavailable — falling back to an audit-log throughput proxy. Once the warehouse is configured, this tab automatically switches to real numbers.",
    },
  };
  const meta = sourceMeta[source] ?? sourceMeta["proxy"]!;
  const headerBasis = meta.basis === "real" ? "Real" : "Estimated";
  const seriesSource = series?.source ?? "proxy";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 flex-wrap">
          <span>Cost &amp; throughput</span>
          <Badge
            variant={meta.basis === "real" ? "default" : "outline"}
            className="font-normal"
            data-testid="cost-source-badge"
          >
            {headerBasis} · {meta.label}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-normal">
              Trend window
            </span>
            <Select
              value={String(lookbackDays)}
              onValueChange={(v) => {
                setLookbackDays(Number(v) === 30 ? 30 : 7);
                setExpanded(null);
              }}
            >
              <SelectTrigger
                data-testid="select-cost-window"
                className="w-[140px] h-8"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7" data-testid="cost-window-option-7">
                  Last 7 days
                </SelectItem>
                <SelectItem value="30" data-testid="cost-window-option-30">
                  Last 30 days
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        <p className="text-xs text-muted-foreground mb-3">{meta.explainer}</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
              <th className="py-2">Collector</th>
              <th className="py-2 text-right">Runs</th>
              <th className="py-2 text-right">Rows written</th>
              <th className="py-2 text-right">USD</th>
              <th className="py-2 w-[140px]">Trend ({lookbackDays}d)</th>
              <th className="py-2 text-right">Basis</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              // Per-row basis: the API stamps each entry with `costBasis`.
              // Older deployments may not have the field yet, so fall
              // back to the source-derived default rather than crashing.
              const rowBasis: "real" | "estimate" =
                e.costBasis === "real" || e.costBasis === "estimate"
                  ? e.costBasis
                  : meta.basis;
              const seriesEntry = seriesByCollector.get(e.collectorId);
              const points = seriesEntry?.points ?? [];
              const isOpen = expanded === e.collectorId;
              return (
                <Fragment key={e.collectorId}>
                  <tr
                    data-testid={`cost-${e.collectorId}`}
                    className="border-t cursor-pointer hover:bg-muted/40"
                    onClick={() =>
                      setExpanded(isOpen ? null : e.collectorId)
                    }
                  >
                    <td className="py-2">
                      <button
                        type="button"
                        className="text-left underline-offset-2 hover:underline"
                        data-testid={`cost-row-toggle-${e.collectorId}`}
                      >
                        {e.name}
                      </button>
                    </td>
                    <td className="py-2 text-right tabular-nums">{e.runs}</td>
                    <td className="py-2 text-right tabular-nums">
                      {e.rowsWritten}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      ${e.estimateUsd.toFixed(4)}
                    </td>
                    <td
                      className="py-2"
                      data-testid={`cost-spark-${e.collectorId}`}
                    >
                      <CostSparkline
                        points={points}
                        loading={isSeriesLoading}
                      />
                    </td>
                    <td className="py-2 text-right">
                      <Badge
                        variant={rowBasis === "real" ? "default" : "outline"}
                        className="font-normal"
                        data-testid={`cost-basis-${e.collectorId}`}
                      >
                        {rowBasis === "real" ? "Real" : "Estimate"}
                      </Badge>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-muted/20">
                      <td colSpan={6} className="p-4">
                        <CostDetail
                          collectorName={e.name}
                          lookbackDays={lookbackDays}
                          seriesSource={seriesSource}
                          points={points}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!isLoading && entries.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="py-4 text-sm text-muted-foreground text-center"
                >
                  No cost rows match the current tier filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// --- Cost sparkline + drilldown helpers --------------------------------

type CostTimeseriesPoint = {
  day: string;
  runs: number;
  rowsWritten: number;
  estimateUsd: number;
};

/**
 * Compact sparkline rendered inline in the Cost table. Uses the
 * canonical zero-filled `points[]` so collectors with no runs in the
 * window still draw a flat baseline rather than disappearing — that
 * baseline is itself a meaningful signal (a previously-active feed
 * went silent).
 */
function CostSparkline({
  points,
  loading,
}: {
  points: readonly CostTimeseriesPoint[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="h-8 flex items-center text-xs text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" />
      </div>
    );
  }
  if (points.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">No data</span>
    );
  }
  const max = points.reduce((m, p) => Math.max(m, p.estimateUsd), 0);
  if (max === 0) {
    // Flat-zero sparkline still rendered so the column is never empty
    // — it tells the operator the trend exists, just at $0.
    return (
      <div className="h-8 flex items-center">
        <div className="h-px w-full bg-border" />
      </div>
    );
  }
  return (
    <div className="h-8 w-full" data-testid="cost-sparkline-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={points as CostTimeseriesPoint[]}
          margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
        >
          <XAxis dataKey="day" hide />
          <YAxis hide domain={[0, "dataMax"]} />
          <RechartsTooltip
            cursor={false}
            contentStyle={{
              fontSize: "11px",
              padding: "4px 8px",
              borderRadius: 6,
            }}
            formatter={(value: number | string) => [
              `$${Number(value).toFixed(4)}`,
              "USD",
            ]}
            labelFormatter={(label: string) => label}
          />
          <Line
            type="monotone"
            dataKey="estimateUsd"
            stroke="#2563eb"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Per-collector drilldown panel — shows the full per-day breakdown
 * (date, runs, rows, USD) for the currently-expanded row. Renders
 * the same source/basis chip as the parent so the operator never
 * has to guess where a number came from.
 */
function CostDetail({
  collectorName,
  lookbackDays,
  seriesSource,
  points,
}: {
  collectorName: string;
  lookbackDays: 7 | 30;
  seriesSource: "bigquery" | "proxy";
  points: readonly CostTimeseriesPoint[];
}) {
  // Newest day first so a creep is the first thing you see.
  const ordered = useMemo(
    () => [...points].sort((a, b) => (a.day < b.day ? 1 : -1)),
    [points],
  );
  const total = ordered.reduce((acc, p) => acc + p.estimateUsd, 0);
  return (
    <div className="space-y-3" data-testid="cost-detail-panel">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm">
          <span className="font-semibold">{collectorName}</span>{" "}
          <span className="text-muted-foreground">
            · last {lookbackDays} days · ${total.toFixed(4)} total
          </span>
        </div>
        <Badge
          variant={seriesSource === "bigquery" ? "default" : "outline"}
          className="font-normal"
          data-testid="cost-detail-source"
        >
          {seriesSource === "bigquery"
            ? "BigQuery collector_runs"
            : "Audit-log proxy"}
        </Badge>
      </div>
      {ordered.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No daily activity recorded for this collector in the window.
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground uppercase tracking-wide">
              <th className="py-1">Day</th>
              <th className="py-1 text-right">Runs</th>
              <th className="py-1 text-right">Rows written</th>
              <th className="py-1 text-right">USD</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((p) => (
              <tr
                key={p.day}
                className="border-t border-border/50"
                data-testid={`cost-detail-row-${p.day}`}
              >
                <td className="py-1 font-mono">{p.day}</td>
                <td className="py-1 text-right tabular-nums">{p.runs}</td>
                <td className="py-1 text-right tabular-nums">
                  {p.rowsWritten}
                </td>
                <td className="py-1 text-right tabular-nums">
                  ${p.estimateUsd.toFixed(4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// -------- Tab: Runs & Errors -------------------------------------------

function RunsTab({ tier }: { tier: TierMode }) {
  const [onlyErrors, setOnlyErrors] = useState(false);
  const { data, isLoading } = useListCollectorRunsAndErrors({
    lookbackHours: 168,
    limit: 200,
    onlyErrors,
  });
  const { data: catalog } = useListCollectorCatalog();
  const tierByCollector = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of catalog?.entries ?? []) m.set(e.id, e.disclosureTier);
    return m;
  }, [catalog]);
  const entries = useMemo(
    () =>
      (data?.entries ?? []).filter((r) =>
        tierMatches(tier, tierByCollector.get(r.collectorId)),
      ),
    [data, tier, tierByCollector],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Recent runs &amp; errors</span>
          <label className="text-xs flex items-center gap-2 font-normal">
            <Switch
              data-testid="runs-only-errors"
              checked={onlyErrors}
              onCheckedChange={setOnlyErrors}
            />
            Only errors
          </label>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
              <th className="py-2">When</th>
              <th className="py-2">Collector</th>
              <th className="py-2">Event</th>
              <th className="py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {!isLoading && entries.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="py-4 text-sm text-muted-foreground text-center"
                >
                  No runs match the current tier filter.
                </td>
              </tr>
            )}
            {entries.map((r) => {
              const isFail =
                r.error ||
                r.event === "fetch_failed" ||
                r.event === "backfill_failed";
              return (
                <tr
                  key={r.id}
                  data-testid={`run-${r.id}`}
                  className="border-t"
                >
                  <td className="py-2 text-xs text-muted-foreground">
                    {formatDateTime(r.createdAt)}
                  </td>
                  <td className="py-2 font-mono text-xs">{r.collectorId}</td>
                  <td className="py-2">
                    <span className="inline-flex items-center gap-1">
                      {isFail ? (
                        <XCircle className="w-3 h-3 text-red-600" />
                      ) : (
                        <CheckCircle2 className="w-3 h-3 text-green-600" />
                      )}
                      {r.event}
                    </span>
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {r.error ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// -------- Broadcast posture control ------------------------------------

function BroadcastPostureControl(props: {
  collectorId: string;
  collectorName: string;
  pending: boolean;
  onBroadcast: (tenantOptedIn: boolean | null) => void;
}) {
  const { collectorId, collectorName, pending, onBroadcast } = props;
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<"opt-in" | "opt-out" | "clear">(
    "opt-out",
  );
  // Fetch the tenant breakdown only while the dialog is open. The
  // `enabled: open` gate keeps the call out of the page-load critical
  // path and refetches every time the operator re-opens the dialog,
  // so the count is always current at the moment of confirmation.
  const preview = usePreviewBroadcastCollectorPosture(collectorId, {
    query: {
      enabled: open,
      staleTime: 0,
      refetchOnWindowFocus: false,
      queryKey: getPreviewBroadcastCollectorPostureQueryKey(collectorId),
    },
  });
  const apply = () => {
    const value =
      choice === "opt-in" ? true : choice === "opt-out" ? false : null;
    onBroadcast(value);
    setOpen(false);
  };
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          data-testid={`posture-broadcast-${collectorId}`}
          disabled={pending}
        >
          Broadcast…
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Broadcast posture for {collectorName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This applies a per-tenant opt-in decision for{" "}
            <span className="font-mono">{collectorId}</span> to{" "}
            <strong>every organisation</strong> in one transaction. An
            audit row is written per tenant. There is no per-tenant
            confirmation — use carefully.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div
          className="rounded border border-border bg-muted/30 p-3 text-sm"
          data-testid={`broadcast-preview-${collectorId}`}
        >
          {preview.isPending ? (
            <span className="text-muted-foreground">
              Loading affected tenant counts…
            </span>
          ) : preview.isError || !preview.data ? (
            <span className="text-destructive">
              Could not load tenant counts.
            </span>
          ) : (
            <div className="space-y-1">
              <div>
                This will affect{" "}
                <strong
                  data-testid={`broadcast-preview-total-${collectorId}`}
                >
                  {preview.data.tenantsTotal}
                </strong>{" "}
                tenant{preview.data.tenantsTotal === 1 ? "" : "s"}.
              </div>
              <div className="text-muted-foreground">
                Currently:{" "}
                <span data-testid={`broadcast-preview-opted-in-${collectorId}`}>
                  {preview.data.currentOptedIn} opted in
                </span>
                {", "}
                <span
                  data-testid={`broadcast-preview-opted-out-${collectorId}`}
                >
                  {preview.data.currentOptedOut} opted out
                </span>
                {", "}
                <span
                  data-testid={`broadcast-preview-no-override-${collectorId}`}
                >
                  {preview.data.currentNoOverride} no override
                </span>{" "}
                (registry default ={" "}
                {preview.data.registryDefault === null
                  ? "n/a"
                  : preview.data.registryDefault
                    ? "opt-in"
                    : "opt-out"}
                ).
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`broadcast-choice-${collectorId}`}
              value="opt-in"
              checked={choice === "opt-in"}
              onChange={() => setChoice("opt-in")}
              data-testid={`broadcast-choice-opt-in-${collectorId}`}
            />
            Force opt-in for every tenant
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`broadcast-choice-${collectorId}`}
              value="opt-out"
              checked={choice === "opt-out"}
              onChange={() => setChoice("opt-out")}
              data-testid={`broadcast-choice-opt-out-${collectorId}`}
            />
            Force opt-out for every tenant
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`broadcast-choice-${collectorId}`}
              value="clear"
              checked={choice === "clear"}
              onChange={() => setChoice("clear")}
              data-testid={`broadcast-choice-clear-${collectorId}`}
            />
            Clear per-tenant overrides (fall back to default)
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={apply}
            data-testid={`broadcast-confirm-${collectorId}`}
          >
            Apply broadcast
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
