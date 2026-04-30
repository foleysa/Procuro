/**
 * Client-facing /data-sources view. Lighter than /collectors — no
 * posture-class chrome, no kill switches, no operator notes. The
 * server already filters out non-opted-in and killed sources, so this
 * page just renders the projection.
 */

import { useListDataSources } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { Database, Loader2 } from "lucide-react";

const TIER_TONE: Record<string, string> = {
  T1: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  T2: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  T3: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  T4: "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-300",
};

export default function DataSources() {
  const { data, isLoading } = useListDataSources();
  const entries = data?.entries ?? [];

  return (
    <div className="p-8 space-y-6 max-w-5xl">
      <div>
        <h1
          data-testid="text-page-title"
          className="text-3xl font-bold flex items-center gap-2"
        >
          <Database className="w-7 h-7 text-primary" />
          Data Sources
        </h1>
        <p className="text-muted-foreground mt-1">
          External feeds powering your benchmarks, levers, and
          opportunity rationales. Only sources your tenant has opted
          into appear here.
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}

      {!isLoading && entries.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No data sources are currently active for your tenant.
            Contact your account team to enable additional feeds.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {entries.map((s) => (
          <Card key={s.id} data-testid={`data-source-${s.id}`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 min-w-0">
                  {s.logoUrl ? (
                    <img
                      src={s.logoUrl}
                      alt=""
                      width={20}
                      height={20}
                      className="w-5 h-5 rounded-sm object-contain bg-white border border-border shrink-0"
                      data-testid={`data-source-logo-${s.id}`}
                      onError={(e) => {
                        // Hide broken/blocked logo URLs rather than
                        // showing a broken-image icon next to a
                        // trust-critical source name.
                        (e.currentTarget as HTMLImageElement).style.display =
                          "none";
                      }}
                    />
                  ) : (
                    <Database className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  {s.flagEmoji && <span>{s.flagEmoji}</span>}
                  <span className="truncate">{s.name}</span>
                </span>
                <Badge className={TIER_TONE[s.disclosureTier]}>
                  {s.disclosureTier}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              <div className="text-muted-foreground">{s.licenseNote}</div>
              <div className="text-xs">
                <span className="text-muted-foreground">Cadence:</span>{" "}
                {s.cadenceLabel}
              </div>
              <div className="text-xs">
                <span className="text-muted-foreground">Jurisdiction:</span>{" "}
                {s.jurisdiction}
              </div>
              <div className="text-xs">
                <span className="text-muted-foreground">Last refreshed:</span>{" "}
                {formatDateTime(s.lastRefreshedAt ?? null)}
              </div>
              {s.tosUrl && (
                <div className="text-xs">
                  <a
                    href={s.tosUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Source terms of use
                  </a>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
