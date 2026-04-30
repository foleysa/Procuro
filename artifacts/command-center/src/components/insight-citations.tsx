import { useMemo } from "react";
import { ExternalLink, Shield } from "lucide-react";
import {
  renderInsight,
  type Citation,
  type RenderedInsight,
} from "@workspace/intelligence/tier";
import type {
  SignalSource,
  TenantPolicy,
} from "@workspace/intelligence/contracts";
import type { InsightSource } from "@workspace/api-client-react";
import { cn } from "../lib/utils";

interface InsightCitationsProps {
  /** Sources persisted on the opportunity / cycle by the API server. */
  sources: readonly InsightSource[] | undefined | null;
  /** Tenant disclosure policy — call `usePolicy()` once and pass it. */
  policy: TenantPolicy;
  /**
   * Optional aggregate confidence — used by the renderer to label T3
   * citations with a numeric quality hint when source attribution is
   * hidden by the tenant's policy.
   */
  aggregateConfidence?: number;
  /** Layout variant. `compact` is meant for inline footers. */
  variant?: "card" | "compact";
  className?: string;
}

/**
 * Render the disclosure-tier citation block for an insight (an
 * opportunity, a cycle, etc.). Wraps `renderInsight()` from
 * `@workspace/intelligence/tier`, which decides — based on the
 * tenant's policy and each source's tier — what is safe to show.
 *
 * If the renderer says the insight has no visible citations under the
 * current policy, the component renders nothing. This keeps the UI
 * silent when a tenant on `conservative` would otherwise see no T1/T2
 * sources to cite.
 */
export function InsightCitations({
  sources,
  policy,
  aggregateConfidence,
  variant = "card",
  className,
}: InsightCitationsProps) {
  const rendered = useMemo<RenderedInsight>(() => {
    const signalSources = (sources ?? []).map(toSignalSource);
    return renderInsight({
      sources: signalSources,
      policy,
      aggregateConfidence,
    });
  }, [sources, policy, aggregateConfidence]);

  if (!rendered.visible || rendered.citations.length === 0) {
    return null;
  }

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground",
          className,
        )}
        data-testid="insight-citations-compact"
      >
        <Shield className="w-3 h-3" />
        <span>{rendered.label}:</span>
        {rendered.citations.map((c, i) => (
          <CitationChip key={citationKey(c, i)} citation={c} />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border border-border/60 bg-muted/30 p-3 space-y-2",
        className,
      )}
      data-testid="insight-citations-card"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Shield className="w-3.5 h-3.5" />
        <span>{rendered.label}</span>
      </div>
      <ul className="space-y-1">
        {rendered.citations.map((c, i) => (
          <li
            key={citationKey(c, i)}
            className="flex items-center gap-2 text-xs"
            data-testid="insight-citation"
            data-tier={c.tier}
          >
            <TierBadge tier={c.tier} />
            <CitationLabel citation={c} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CitationChip({ citation }: { citation: Citation }) {
  return (
    <span className="inline-flex items-center gap-1" data-tier={citation.tier}>
      <TierBadge tier={citation.tier} compact />
      <CitationLabel citation={citation} />
    </span>
  );
}

function CitationLabel({ citation }: { citation: Citation }) {
  if (citation.url) {
    return (
      <a
        href={citation.url}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 hover:underline"
      >
        {citation.label}
        <ExternalLink className="w-3 h-3" />
      </a>
    );
  }
  return <span>{citation.label}</span>;
}

function TierBadge({
  tier,
  compact = false,
}: {
  tier: Citation["tier"];
  compact?: boolean;
}) {
  const styles: Record<Citation["tier"], string> = {
    T1: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20",
    T2: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20",
    T3: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20",
    T4: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded border font-mono uppercase tracking-tight",
        compact ? "px-1 text-[10px] leading-4" : "px-1.5 py-0.5 text-[10px]",
        styles[tier],
      )}
    >
      {tier}
    </span>
  );
}

function toSignalSource(s: InsightSource): SignalSource {
  return {
    collectorId: s.collectorId,
    collectorName: s.collectorName,
    sourceUrl: s.sourceUrl,
    observedAt: new Date(s.observedAt),
    contract: s.contract,
  };
}

function citationKey(c: Citation, i: number): string {
  return `${c.tier}:${c.label}:${c.url ?? ""}:${i}`;
}
