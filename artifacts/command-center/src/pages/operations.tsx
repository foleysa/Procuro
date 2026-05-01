import { Link } from "wouter";
import { useGetOperationsHealth } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Radar,
  Server,
  Database,
  Plug,
  AlertOctagon,
  ArrowRight,
} from "lucide-react";

/**
 * Operations Health — admin landing for the Operations group (#199, step 5).
 *
 * Composes the fail-soft `/api/operations/health` aggregator into five
 * tiles that each link to the deeper page. Funnel-snapshot failures
 * (a substrate output, see docs/command-center-ia.md) are placed here
 * because admins triaging "is my data flowing" need to see when the
 * snapshot pipeline itself is dropping cycles.
 */
export default function Operations() {
  const { data, isLoading, isError } = useGetOperationsHealth();

  if (isLoading) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Loading operations health…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold mb-2">Operations Health</h1>
        <p className="text-sm text-destructive">
          Could not load operations health.
        </p>
      </div>
    );
  }

  const itemBy = (kind: string) =>
    data.items.find((i) => i.kind === kind);

  const collectors = itemBy("collectors.summary");
  const jobs = itemBy("jobs.summary");
  const dataSources = itemBy("data_sources.summary");
  const integrations = itemBy("integrations.summary");
  const failures = itemBy("funnel.failures");

  const errFor = (source: string) =>
    data.errors.find((e) => e.source === source)?.error;

  return (
    <div className="p-8 space-y-6" data-testid="operations-page">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Operations Health</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Is your data flowing? Five surfaces, one rollup.
          </p>
        </div>
        {data.partial && (
          <Badge variant="outline" data-testid="operations-partial-badge">
            Partial — {data.errors.length} source(s) unavailable
          </Badge>
        )}
      </div>

      {failures &&
        (failures.payload as { unacked?: number }).unacked !== undefined &&
        ((failures.payload as { unacked: number }).unacked > 0 ||
          errFor("funnelSnapshotFailures")) && (
          <Card
            data-testid="operations-failure-banner"
            className="border-destructive/40 bg-destructive/5"
          >
            <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-2">
              <AlertOctagon className="w-4 h-4 text-destructive" />
              <CardTitle className="text-sm font-medium">
                Snapshot pipeline reported failures
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-foreground">
                {(failures.payload as { unacked: number }).unacked} unacked
                failure(s) in the last 24h. The substrate is still capturing
                snapshots but at least one cycle did not complete.
              </p>
              <Link
                href="/engine"
                className="mt-2 inline-flex items-center gap-1 text-xs text-foreground hover:underline"
              >
                Review on the Engine page <ArrowRight className="w-3 h-3" />
              </Link>
              {errFor("funnelSnapshotFailures") && (
                <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                  Source unavailable: {errFor("funnelSnapshotFailures")}
                </p>
              )}
            </CardContent>
          </Card>
        )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <HealthCard
          title="Collectors"
          icon={Radar}
          href="/collectors"
          error={errFor("listCollectors")}
          testId="operations-card-collectors"
        >
          {collectors ? (
            <>
              <p className="text-3xl font-bold tabular-nums">
                {(collectors.payload as { approved?: number }).approved ?? 0}
                <span className="text-sm font-normal text-muted-foreground">
                  {" / "}
                  {(collectors.payload as { total?: number }).total ?? 0}
                </span>
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Approved &middot;{" "}
                {(collectors.payload as { killed?: number }).killed ?? 0} killed
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No collectors data.
            </p>
          )}
        </HealthCard>

        <HealthCard
          title="Jobs (24h)"
          icon={Server}
          href="/system"
          error={errFor("listJobs")}
          testId="operations-card-jobs"
        >
          {jobs ? (
            <>
              {(() => {
                const byStatus = (jobs.payload as { byStatus?: Record<string, number> })
                  .byStatus ?? {};
                const failed = byStatus["failed"] ?? 0;
                const succeeded = byStatus["succeeded"] ?? 0;
                return (
                  <>
                    <p className="text-3xl font-bold tabular-nums">
                      {failed}
                      <span className="text-sm font-normal text-muted-foreground">
                        {" failed"}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {succeeded} succeeded &middot; {byStatus["pending"] ?? 0}{" "}
                      pending
                    </p>
                  </>
                );
              })()}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No jobs data.</p>
          )}
        </HealthCard>

        <HealthCard
          title="Data Sources"
          icon={Database}
          href="/data-sources"
          error={errFor("listDataSources")}
          testId="operations-card-data-sources"
        >
          {dataSources ? (
            <>
              {(() => {
                const byAdapter = (dataSources.payload as { byAdapter?: Record<string, Record<string, number>> })
                  .byAdapter ?? {};
                const adapters = Object.keys(byAdapter);
                const unhealthy =
                  (dataSources.payload as { unhealthy?: number }).unhealthy ?? 0;
                return (
                  <>
                    <p className="text-3xl font-bold tabular-nums">
                      {adapters.length}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Adapter(s) configured &middot; {unhealthy} unhealthy
                    </p>
                  </>
                );
              })()}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No data-source data.
            </p>
          )}
        </HealthCard>

        <HealthCard
          title="Integrations"
          icon={Plug}
          href="/integrations"
          error={errFor("listIntegrations")}
          testId="operations-card-integrations"
        >
          {integrations ? (
            <p className="text-3xl font-bold tabular-nums">
              {(integrations.payload as { configured?: number }).configured ?? 0}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No integrations data.
            </p>
          )}
        </HealthCard>
      </div>
    </div>
  );
}

interface HealthCardProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  error: string | undefined;
  testId: string;
  children: React.ReactNode;
}

function HealthCard({
  title,
  icon: Icon,
  href,
  error,
  testId,
  children,
}: HealthCardProps) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <Link
          href={href}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          Open <ArrowRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {children}
        {error && (
          <p
            data-testid={`${testId}-error`}
            className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1"
          >
            Source unavailable: {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
