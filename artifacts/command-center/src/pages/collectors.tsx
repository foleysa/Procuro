import { useQueryClient } from "@tanstack/react-query";
import {
  useListCollectors,
  useListMarketSignals,
  useRunCollector,
  useBackfillEcbFxRates,
  useBackfillFredEconomicIndex,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format";
import { Radar, Loader2, Play, History } from "lucide-react";

const ECB_FX_RATES_COLLECTOR_ID = "ecb-fx-rates";
const FRED_ECONOMIC_INDEX_COLLECTOR_ID = "fred-economic-index";

const POSTURE_LABEL: Record<string, string> = {
  "public-api": "Public API",
  "published-data": "Published data",
  "respect-robots-crawl": "Crawl (robots.txt respected)",
  "aggressive-crawl": "Aggressive crawl",
};

const POSTURE_TONE: Record<string, string> = {
  "public-api": "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  "published-data": "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  "respect-robots-crawl": "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  "aggressive-crawl": "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export default function Collectors() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: collectors, isLoading } = useListCollectors();
  const { data: signals } = useListMarketSignals({ limit: 25 });

  const runM = useRunCollector({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: resp.skipped ? "Collector skipped" : "Collector ran",
          description: resp.skipped
            ? resp.skipReason ?? ""
            : `${resp.signalsWritten} signals · ${resp.durationMs}ms`,
        });
        qc.invalidateQueries({ queryKey: ["listCollectors"] });
        qc.invalidateQueries({ queryKey: ["listMarketSignals"] });
      },
      onError: (e: Error) =>
        toast({ title: "Collector failed", description: String(e), variant: "destructive" }),
    },
  });

  const backfillEcbM = useBackfillEcbFxRates({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "FX history backfilled",
          description: `${resp.daysWritten} days · ${resp.signalsInserted} new, ${resp.signalsSkipped} already had · ${resp.durationMs}ms`,
        });
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

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div>
        <h1 data-testid="text-page-title" className="text-3xl font-bold flex items-center gap-2">
          <Radar className="w-7 h-7 text-primary" />
          Collector Registry
        </h1>
        <p className="text-muted-foreground mt-1">
          External intelligence sources. Each collector declares its collection posture so we
          stay on the right side of robots.txt &amp; ToS.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Registered collectors</CardTitle></CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {!isLoading && (collectors ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No collectors registered yet.</p>
          )}
          <div className="space-y-3">
            {(collectors ?? []).map((c) => (
              <div
                key={c.id}
                data-testid={`collector-${c.id}`}
                className="flex items-start justify-between gap-3 p-4 rounded-md border"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{c.name}</span>
                    <Badge className={POSTURE_TONE[c.posture]}>
                      {POSTURE_LABEL[c.posture] ?? c.posture}
                    </Badge>
                    <Badge variant={c.status === "enabled" ? "default" : c.status === "killed" ? "destructive" : "outline"}>
                      {c.status}
                    </Badge>
                  </div>
                  {c.description && (
                    <p className="text-sm text-muted-foreground mt-1">{c.description}</p>
                  )}
                  <div className="text-xs text-muted-foreground mt-2 space-y-0.5">
                    {c.sourceUrl && (
                      <div>
                        Source: <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="underline">{c.sourceUrl}</a>
                      </div>
                    )}
                    {c.defaultRateLimitRpm && <div>Rate limit: {c.defaultRateLimitRpm} rpm</div>}
                    {c.defaultScheduleCron && <div>Schedule: {c.defaultScheduleCron}</div>}
                    <div>
                      Last run: {formatDateTime(c.lastRunAt)} · last signal count: {c.lastSignalCount ?? 0}
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-2 items-stretch">
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

      <Card>
        <CardHeader><CardTitle>Recent market signals</CardTitle></CardHeader>
        <CardContent>
          {(signals ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No signals yet — try running a collector above.</p>
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
                      {s.scopeMaterialCode ?? s.scopeCategoryId ?? s.scopeSupplierId ?? "—"}
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
