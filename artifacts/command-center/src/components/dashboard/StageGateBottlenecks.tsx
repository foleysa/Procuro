import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GitFork } from "lucide-react";
import { formatUsd } from "@/lib/format";
import { useGetOpportunitiesGateSummary } from "@workspace/api-client-react";

const GATE_CONFIG = [
  {
    canonicalStage: "Identified",
    label: "Identified → Awarded",
    slaHours: 72,
    ownerOfGate: "Category Manager",
  },
  {
    canonicalStage: "Awarded",
    label: "Awarded → In Contracting",
    slaHours: 120,
    ownerOfGate: "Legal / Procurement",
  },
  {
    canonicalStage: "In Contracting",
    label: "In Contracting → In Implementation",
    slaHours: 168,
    ownerOfGate: "Contract Manager",
  },
  {
    canonicalStage: "In Implementation",
    label: "In Implementation → Realized",
    slaHours: 720,
    ownerOfGate: "Finance / Business Owner",
  },
] as const;

export function StageGateBottlenecks() {
  const { data, isLoading } = useGetOpportunitiesGateSummary();

  const gateMap = new Map(
    (data?.gates ?? []).map((g) => [g.canonicalStage, g]),
  );

  return (
    <Card data-testid="stage-gate-bottlenecks">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GitFork className="w-4 h-4 text-amber-500" />
          Stage Gate Bottlenecks
        </CardTitle>
        <CardDescription>
          Per-gate pipeline health — server-aggregated count, dollars stuck,
          average cycle time, and SLA breach exposure.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-2">Loading…</div>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm"
              data-testid="table-stage-gates"
            >
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Gate</th>
                  <th className="py-2 pr-3 font-medium text-right">Count</th>
                  <th className="py-2 pr-3 font-medium text-right">$ Stuck</th>
                  <th className="py-2 pr-3 font-medium text-right">Avg Cycle</th>
                  <th className="py-2 pr-3 font-medium">Owner of Gate</th>
                  <th className="py-2 font-medium text-right">DOA SLA Breaches</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {GATE_CONFIG.map((cfg) => {
                  const row = gateMap.get(cfg.canonicalStage);
                  const count = row?.count ?? 0;
                  const valueUsd = row?.valueUsd ?? 0;
                  const avgHours = row?.avgHoursInStage ?? null;
                  const breaching = row?.breachingCount ?? 0;
                  const hasBreaches = breaching > 0;
                  const avgDays =
                    avgHours != null ? avgHours / 24 : null;

                  return (
                    <tr
                      key={cfg.canonicalStage}
                      data-testid={`gate-row-${cfg.canonicalStage.toLowerCase().replace(/\s+/g, "-")}`}
                      className={
                        hasBreaches
                          ? "bg-amber-50/60 dark:bg-amber-950/10"
                          : undefined
                      }
                    >
                      <td className="py-2.5 pr-3 align-middle">
                        <span className="font-medium text-xs">{cfg.label}</span>
                        {hasBreaches && (
                          <span className="ml-2 text-[9px] text-amber-700 dark:text-amber-400 font-semibold uppercase tracking-wide">
                            ⚠ SLA
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 align-middle text-right tabular-nums font-medium">
                        {count}
                      </td>
                      <td className="py-2.5 pr-3 align-middle text-right tabular-nums">
                        {formatUsd(valueUsd, { compact: true })}
                        <span className="ml-1 text-[9px] text-amber-700 dark:text-amber-400 font-semibold uppercase tracking-wide">
                          IDENTIFIED
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 align-middle text-right tabular-nums text-muted-foreground">
                        {avgDays === null ? "—" : `${avgDays.toFixed(0)}d avg`}
                      </td>
                      <td className="py-2.5 pr-3 align-middle text-xs text-muted-foreground">
                        {cfg.ownerOfGate}
                      </td>
                      <td className="py-2.5 align-middle text-right">
                        {hasBreaches ? (
                          <Link
                            href={`/approvals?filter=stage:${encodeURIComponent(cfg.canonicalStage)}&breach=true`}
                            data-testid={`gate-breach-link-${cfg.canonicalStage}`}
                          >
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-950/40 px-2 py-0.5 rounded cursor-pointer hover:bg-amber-200 dark:hover:bg-amber-900/40 transition-colors">
                              {breaching} breaching
                            </span>
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            0
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
