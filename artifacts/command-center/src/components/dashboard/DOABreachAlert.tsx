import { Link } from "wouter";
import { AlertOctagon, ArrowRight } from "lucide-react";
import { useGetOpportunitiesDoaSummary } from "@workspace/api-client-react";

const URGENT_TIERS = [
  { tier: 1, label: "Tier 1 — Strategic", slaLabel: "24 h", approver: "Board" },
  { tier: 2, label: "Tier 2 — Major", slaLabel: "48 h", approver: "C-Suite" },
] as const;

export function DOABreachAlert() {
  const { data } = useGetOpportunitiesDoaSummary({
    query: { refetchInterval: 30_000 },
  });

  const tierMap = new Map((data?.tiers ?? []).map((t) => [t.doaTier, t]));
  const breaches = URGENT_TIERS.map((cfg) => {
    const row = tierMap.get(cfg.tier);
    return {
      ...cfg,
      breaching: row?.breachingCount ?? 0,
    };
  }).filter((b) => b.breaching > 0);

  if (breaches.length === 0) return null;

  const total = breaches.reduce((sum, b) => sum + b.breaching, 0);

  return (
    <div
      data-testid="doa-breach-alert"
      role="alert"
      className="sticky top-0 z-30 -mx-6 lg:-mx-8 px-6 lg:px-8 py-3 border-y border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40 shadow-sm"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between max-w-[1600px]">
        <div className="flex items-start gap-3 min-w-0">
          <AlertOctagon
            className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-red-900 dark:text-red-100">
              {total} high-tier approval{total === 1 ? "" : "s"} breaching DOA
              SLA
            </p>
            <p className="text-xs text-red-800/90 dark:text-red-200/90 mt-0.5">
              {breaches
                .map(
                  (b) =>
                    `${b.breaching} ${b.label} (${b.approver}, ${b.slaLabel})`,
                )
                .join(" · ")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {breaches.map((b) => (
            <Link
              key={b.tier}
              href={`/approvals?filter=doa_tier:${b.tier}&breach=true`}
              data-testid={`doa-breach-alert-link-tier-${b.tier}`}
              className="inline-flex items-center gap-1 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
            >
              Review Tier {b.tier} ({b.breaching})
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
