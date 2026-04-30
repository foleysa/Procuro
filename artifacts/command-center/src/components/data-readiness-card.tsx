import { Link } from "wouter";
import {
  useGetReadiness,
  getGetReadinessQueryKey,
  type LeverReadiness,
  type ReadinessBlocker,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowRight, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

/**
 * Dashboard "Data readiness" widget.
 *
 * Shows the rolled-up readiness score and the top per-lever gaps with a
 * deep-link to the page that fixes each gap. The card is *persistent*:
 * even at 100% it stays mounted and renders a green "all good" state so
 * the user always has an at-a-glance signal that the data is healthy.
 */
export function DataReadinessCard({ basePath = "" }: { basePath?: string }) {
  const { data, isLoading } = useGetReadiness({
    query: {
      queryKey: getGetReadinessQueryKey(),
      refetchOnMount: true,
      staleTime: 30_000,
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base font-semibold">
            Data readiness
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
          Checking your data&hellip;
        </CardContent>
      </Card>
    );
  }
  if (!data) return null;

  // Sort the levers worst-first so the most urgent fix surfaces.
  const ranked = [...data.levers].sort((a, b) => a.score - b.score);
  const worst = ranked.slice(0, 3);
  const allGood = data.overallScore >= 95 && ranked[0]?.score === 100;

  return (
    <Card data-testid="data-readiness-card">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base font-semibold">
            Data readiness
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {data.hasIngestedData
              ? "Lever-by-lever check of the fields each play needs."
              : "No data yet — load the sample dataset or import yours to begin."}
          </p>
        </div>
        <Badge variant={allGood ? "default" : "secondary"} className="text-base px-3">
          {data.overallScore}%
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={data.overallScore} className="h-2" />
        {!data.hasIngestedData ? (
          <Button asChild size="sm">
            <Link href="/onboarding">
              Open setup wizard <ArrowRight className="h-3 w-3 ml-1" />
            </Link>
          </Button>
        ) : allGood ? (
          <div className="text-sm flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="h-4 w-4" /> Every lever has the data it
            needs.
          </div>
        ) : (
          <ul className="space-y-3" data-testid="readiness-lever-list">
            {worst.map((lev) => (
              <LeverRow key={lev.leverId} lever={lev} basePath={basePath} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function LeverRow({
  lever,
  basePath,
}: {
  lever: LeverReadiness;
  basePath: string;
}) {
  const top = lever.blockers[0];
  return (
    <li className="border-l-2 pl-3 py-1 border-amber-300">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{lever.label}</span>
        <Badge variant="outline" className="font-mono text-xs">
          {lever.score}%
        </Badge>
      </div>
      {top ? <BlockerRow blocker={top} basePath={basePath} /> : null}
    </li>
  );
}

function BlockerRow({
  blocker,
  basePath,
}: {
  blocker: ReadinessBlocker;
  basePath: string;
}) {
  const fixHref = blocker.fixUrl
    ? blocker.fixUrl.startsWith(basePath)
      ? blocker.fixUrl.slice(basePath.length) || "/"
      : blocker.fixUrl
    : null;
  return (
    <div className="text-xs text-muted-foreground mt-1 flex items-start gap-2">
      <AlertCircle className="h-3 w-3 mt-0.5 text-amber-500" />
      <div className="flex-1">
        <span>{blocker.message}</span>{" "}
        {blocker.totalCount > 0 ? (
          <span className="font-mono">
            ({blocker.missingCount}/{blocker.totalCount} rows missing
            {blocker.field ? ` ${blocker.field}` : ""})
          </span>
        ) : null}
        {fixHref ? (
          <>
            {" "}
            <Link
              href={fixHref}
              className="text-primary underline-offset-2 hover:underline"
            >
              Fix this
            </Link>
          </>
        ) : null}
      </div>
    </div>
  );
}
