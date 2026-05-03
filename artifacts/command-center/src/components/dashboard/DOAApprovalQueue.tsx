import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";
import { formatUsd } from "@/lib/format";
import { useGetOpportunitiesDoaSummary } from "@workspace/api-client-react";

const DOA_TIER_CONFIG = [
  {
    tier: 4,
    label: "Tier 4 — Standard",
    threshold: "< $250K",
    approverRole: "Manager",
    slaHours: 168,
    slaLabel: "168 h",
  },
  {
    tier: 3,
    label: "Tier 3 — Significant",
    threshold: "$250K – $1M",
    approverRole: "VP",
    slaHours: 72,
    slaLabel: "72 h",
  },
  {
    tier: 2,
    label: "Tier 2 — Major",
    threshold: "$1M – $5M",
    approverRole: "C-Suite",
    slaHours: 48,
    slaLabel: "48 h",
  },
  {
    tier: 1,
    label: "Tier 1 — Strategic",
    threshold: "> $5M",
    approverRole: "Board",
    slaHours: 24,
    slaLabel: "24 h",
  },
] as const;

export function DOAApprovalQueue() {
  const { data, isLoading } = useGetOpportunitiesDoaSummary();

  const tierMap = new Map(
    (data?.tiers ?? []).map((t) => [t.doaTier, t]),
  );

  return (
    <Card data-testid="doa-approval-queue">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="w-4 h-4 text-blue-500" />
          DOA Approval Queue
        </CardTitle>
        <CardDescription>
          Approval workload by delegation tier — server-aggregated across all
          open opportunities, not limited by pagination. Click a "Breaching SLA"
          cell to open the filtered opportunity list.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-2">Loading…</div>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm"
              data-testid="table-doa-queue"
            >
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">DOA Tier</th>
                  <th className="py-2 pr-3 font-medium">Approver Role</th>
                  <th className="py-2 pr-3 font-medium">Threshold</th>
                  <th className="py-2 pr-3 font-medium text-right">SLA</th>
                  <th className="py-2 pr-3 font-medium text-right">In Queue</th>
                  <th className="py-2 pr-3 font-medium text-right">
                    Breaching SLA
                  </th>
                  <th className="py-2 font-medium text-right">$ at Stake</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {DOA_TIER_CONFIG.map((cfg) => {
                  const row = tierMap.get(cfg.tier);
                  const inQueue = row?.inQueue ?? 0;
                  const breaching = row?.breachingCount ?? 0;
                  const atStake = row?.valueUsd ?? 0;
                  const hasBreaches = breaching > 0;
                  return (
                    <tr
                      key={cfg.tier}
                      data-testid={`doa-row-tier-${cfg.tier}`}
                      className={
                        hasBreaches
                          ? "bg-amber-50/60 dark:bg-amber-950/10"
                          : undefined
                      }
                    >
                      <td className="py-2.5 pr-3 align-middle">
                        <span className="font-medium text-xs">{cfg.label}</span>
                      </td>
                      <td className="py-2.5 pr-3 align-middle text-xs text-muted-foreground">
                        {cfg.approverRole}
                      </td>
                      <td className="py-2.5 pr-3 align-middle text-xs text-muted-foreground tabular-nums">
                        {cfg.threshold}
                      </td>
                      <td className="py-2.5 pr-3 align-middle text-right text-xs text-muted-foreground tabular-nums">
                        {cfg.slaLabel}
                      </td>
                      <td className="py-2.5 pr-3 align-middle text-right tabular-nums font-medium">
                        {inQueue}
                      </td>
                      <td className="py-2.5 pr-3 align-middle text-right">
                        {hasBreaches ? (
                          <Link
                            href={`/approvals?filter=doa_tier:${cfg.tier}&breach=true`}
                            data-testid={`doa-breach-link-tier-${cfg.tier}`}
                          >
                            <span className="inline-flex items-center text-xs font-semibold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-950/40 px-2 py-0.5 rounded cursor-pointer hover:bg-amber-200 dark:hover:bg-amber-900/40 transition-colors">
                              {breaching} breaching
                            </span>
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            0
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 align-middle text-right tabular-nums">
                        {atStake > 0 ? (
                          <span className="font-medium">
                            {formatUsd(atStake, { compact: true })}
                            <span className="ml-1 text-[9px] text-blue-700 dark:text-blue-400 font-semibold uppercase tracking-wide">
                              IDENTIFIED
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
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
