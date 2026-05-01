import { Link } from "wouter";
import { useGetTodayFeed } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  Sparkles,
  CheckSquare,
  Activity,
  ArrowRight,
} from "lucide-react";

/**
 * Today — operator landing page (#199, step 4 path b).
 *
 * Renders the fail-soft `/api/today/feed` aggregator into a four-card
 * triage view: alerts, proposed opportunities (= approvals queue),
 * recently failed jobs, and a system-health pointer. Per-source errors
 * surface as muted ribbons inside each card so the operator can see
 * exactly what is or isn't loaded.
 */
export default function Today() {
  const { data, isLoading, isError } = useGetTodayFeed();

  if (isLoading) {
    return (
      <div className="p-8 text-sm text-muted-foreground">Loading today's feed…</div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold mb-2">Today</h1>
        <p className="text-sm text-destructive">
          Could not load today's feed. The aggregator is up but returned an
          unexpected response.
        </p>
      </div>
    );
  }

  const itemBy = (kind: string) =>
    data.items.find((i) => i.kind === kind);

  const alerts = itemBy("alerts.summary");
  const opps = itemBy("opportunities.proposed");
  const jobs = itemBy("jobs.failed");
  const approvals = itemBy("approvals.pending");

  const errFor = (source: string) =>
    data.errors.find((e) => e.source === source)?.error;

  return (
    <div className="p-8 space-y-6" data-testid="today-page">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today</h1>
          <p className="text-sm text-muted-foreground mt-1">
            What needs your attention this morning. One screen, four buckets.
          </p>
        </div>
        {data.partial && (
          <Badge variant="outline" data-testid="today-partial-badge">
            Partial — {data.errors.length} source(s) unavailable
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TriageCard
          title="Alerts"
          icon={AlertTriangle}
          severity={alerts?.severity ?? "info"}
          href="/alerts"
          error={errFor("getAlertsSummary")}
          testId="today-card-alerts"
        >
          {alerts ? (
            <>
              <p className="text-3xl font-bold tabular-nums">
                {(alerts.payload as { openCriticalOrHigh?: number })
                  .openCriticalOrHigh ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Open critical / high alerts —{" "}
                {(alerts.payload as { openTotal?: number }).openTotal ?? 0}{" "}
                open total
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No alerts data.</p>
          )}
        </TriageCard>

        <TriageCard
          title="Proposed opportunities"
          icon={Sparkles}
          severity={opps?.severity ?? "info"}
          href="/opportunities"
          error={errFor("listOpportunities")}
          testId="today-card-opportunities"
        >
          {opps ? (
            <>
              <p className="text-3xl font-bold tabular-nums">
                {(opps.payload as { count?: number }).count ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Top by projected savings
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No opportunity data.
            </p>
          )}
        </TriageCard>

        <TriageCard
          title="Pending approvals"
          icon={CheckSquare}
          severity={approvals?.severity ?? "info"}
          href="/approvals"
          error={errFor("approvalsPending")}
          testId="today-card-approvals"
        >
          {approvals ? (
            <p className="text-3xl font-bold tabular-nums">
              {(approvals.payload as { pending?: number }).pending ?? 0}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No approvals data.
            </p>
          )}
        </TriageCard>

        <TriageCard
          title="Operations health"
          icon={Activity}
          severity={jobs?.severity ?? "info"}
          href="/operations"
          error={errFor("listJobs")}
          testId="today-card-jobs"
        >
          {jobs ? (
            <>
              <p className="text-3xl font-bold tabular-nums">
                {(jobs.payload as { count?: number }).count ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Failed jobs in the last 24h
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No job data.</p>
          )}
        </TriageCard>
      </div>
    </div>
  );
}

interface TriageCardProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  severity: "info" | "warn" | "error";
  href: string;
  error: string | undefined;
  testId: string;
  children: React.ReactNode;
}

function TriageCard({
  title,
  icon: Icon,
  severity,
  href,
  error,
  testId,
  children,
}: TriageCardProps) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Icon
            className={
              severity === "error"
                ? "w-4 h-4 text-destructive"
                : severity === "warn"
                  ? "w-4 h-4 text-amber-600"
                  : "w-4 h-4 text-muted-foreground"
            }
          />
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
