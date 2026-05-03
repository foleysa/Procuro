import React from "react";
import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowRight, Layers } from "lucide-react";
import { formatUsd, leverLabel } from "@/lib/format";
import type { Opportunity } from "@workspace/api-client-react";

interface SourcingPlaysInFlightProps {
  approvedItems: Opportunity[];
  executingItems: Opportunity[];
  loading: boolean;
}

type CanonicalStageLabel =
  | "Awarded"
  | "In Contracting"
  | "In Implementation"
  | "Identified";

function stageBadge(stage: string | null | undefined) {
  const s = stage as CanonicalStageLabel | null | undefined;
  const styles: Record<CanonicalStageLabel, string> = {
    Identified:
      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    Awarded:
      "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
    "In Contracting":
      "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
    "In Implementation":
      "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  };
  const label = s ?? "—";
  const cls = s ? (styles[s] ?? styles.Awarded) : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}`}
    >
      {label}
    </span>
  );
}

function savingsTypeBadge(type: string | null | undefined) {
  const styles: Record<string, string> = {
    Negotiated:
      "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
    Implemented:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    Realized:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    Identified:
      "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  };
  const label = type ?? "—";
  const cls = type
    ? (styles[type] ?? "bg-muted text-muted-foreground")
    : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-block text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${cls}`}
    >
      {label}
    </span>
  );
}

type PlayRow = {
  id: string;
  leverId: string;
  lever: string;
  sourcingStrategy: string | null | undefined;
  canonicalStage: string | null | undefined;
  projectedSavingsUsd: number;
  savingsType: string | null | undefined;
  isUnclassified: boolean;
  owner: string;
  href: string;
};

type LeverGroup = {
  leverId: string;
  lever: string;
  rows: PlayRow[];
  totalValue: number;
  unclassifiedCount: number;
};

const ACTIVE_CANONICAL_STAGES = new Set([
  "Awarded",
  "In Contracting",
  "In Implementation",
]);

export function SourcingPlaysInFlight({
  approvedItems,
  executingItems,
  loading,
}: SourcingPlaysInFlightProps) {
  const allItems: Opportunity[] = [...approvedItems, ...executingItems].filter(
    (o) =>
      o.canonicalStage
        ? ACTIVE_CANONICAL_STAGES.has(o.canonicalStage)
        : false,
  );

  const rows: PlayRow[] = allItems.map((o) => ({
    id: o.id,
    leverId: o.leverId,
    lever: leverLabel(o.leverId),
    sourcingStrategy: o.sourcingStrategy,
    canonicalStage: o.canonicalStage,
    projectedSavingsUsd: o.projectedSavingsUsd,
    savingsType: o.savingsType,
    isUnclassified:
      !o.sourcingStrategy || o.sourcingStrategy === "Unclassified",
    owner: o.supplierName ?? o.categoryName ?? "—",
    href: `/opportunities/${o.id}`,
  }));

  // Group by lever, each group sorted desc by value
  const leverGroupMap = new Map<string, LeverGroup>();
  for (const row of rows) {
    const existing = leverGroupMap.get(row.leverId);
    if (existing) {
      existing.rows.push(row);
      existing.totalValue += row.projectedSavingsUsd;
      if (row.isUnclassified) existing.unclassifiedCount += 1;
    } else {
      leverGroupMap.set(row.leverId, {
        leverId: row.leverId,
        lever: row.lever,
        rows: [row],
        totalValue: row.projectedSavingsUsd,
        unclassifiedCount: row.isUnclassified ? 1 : 0,
      });
    }
  }
  // Sort groups by total value desc, rows within each group also desc
  const leverGroups: LeverGroup[] = Array.from(leverGroupMap.values())
    .map((g) => ({
      ...g,
      rows: [...g.rows].sort(
        (a, b) => b.projectedSavingsUsd - a.projectedSavingsUsd,
      ),
    }))
    .sort((a, b) => b.totalValue - a.totalValue);

  const totalValue = allItems.reduce(
    (s, o) => s + o.projectedSavingsUsd,
    0,
  );
  const totalUnclassified = rows.filter((r) => r.isUnclassified).length;

  return (
    <Card data-testid="sourcing-plays-in-flight">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="w-4 h-4 text-blue-500" />
          Sourcing Plays In Flight
          {totalUnclassified > 0 && (
            <span className="ml-auto text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 px-2 py-0.5 rounded-full">
              {totalUnclassified} need strategy classification
            </span>
          )}
        </CardTitle>
        <CardDescription>
          Active plays in Awarded, In Contracting, and In Implementation —
          grouped by lever ·{" "}
          {loading
            ? "loading…"
            : `${allItems.length} plays · ${formatUsd(totalValue, { compact: true })} at stake`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-sm text-muted-foreground py-2">Loading…</div>
        ) : leverGroups.length === 0 ? (
          <div className="text-sm text-muted-foreground py-2">
            No active plays in flight. Opportunities move here once approved.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm"
              data-testid="table-sourcing-plays"
            >
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Lever / Play</th>
                  <th className="py-2 pr-3 font-medium">Sourcing Strategy</th>
                  <th className="py-2 pr-3 font-medium">Stage</th>
                  <th className="py-2 pr-3 font-medium">Owner</th>
                  <th className="py-2 pr-3 font-medium text-right">
                    $ at Stake
                  </th>
                  <th className="py-2 pr-3 font-medium">Savings Type</th>
                  <th className="py-2 font-medium sr-only">Link</th>
                </tr>
              </thead>
              <tbody>
                {leverGroups.map((group) => (
                  <React.Fragment key={group.leverId}>
                    {/* Lever group header row */}
                    <tr
                      data-testid={`lever-group-${group.leverId}`}
                      className="bg-muted/40 border-t"
                    >
                      <td
                        colSpan={5}
                        className="py-1.5 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider"
                      >
                        {group.lever}
                        <span className="ml-2 font-normal normal-case">
                          {group.rows.length} play
                          {group.rows.length !== 1 ? "s" : ""}
                        </span>
                        {group.unclassifiedCount > 0 && (
                          <span className="ml-1.5 text-amber-600 dark:text-amber-400">
                            · {group.unclassifiedCount} unclassified
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-xs font-semibold">
                        {formatUsd(group.totalValue, { compact: true })}
                      </td>
                      <td />
                    </tr>
                    {/* Individual play rows */}
                    {group.rows.slice(0, 10).map((r) => (
                      <tr
                        key={r.id}
                        data-testid={`play-row-${r.id}`}
                        className={`border-b last:border-b-0 ${
                          r.isUnclassified
                            ? "bg-amber-50/40 dark:bg-amber-950/10"
                            : undefined
                        }`}
                      >
                        <td className="py-2 pr-3 pl-4 align-middle text-xs text-muted-foreground">
                          {r.isUnclassified && (
                            <span className="mr-1 text-[9px] text-amber-700 dark:text-amber-400">
                              ⚠
                            </span>
                          )}
                          <Link href={r.href} className="hover:text-foreground">
                            {r.id.slice(0, 8)}…
                          </Link>
                        </td>
                        <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                          {r.sourcingStrategy ?? "Unclassified"}
                        </td>
                        <td className="py-2 pr-3 align-middle">
                          {stageBadge(r.canonicalStage)}
                        </td>
                        <td className="py-2 pr-3 align-middle text-xs text-muted-foreground truncate max-w-[140px]">
                          {r.owner}
                        </td>
                        <td className="py-2 pr-3 align-middle text-right tabular-nums font-medium text-xs">
                          {formatUsd(r.projectedSavingsUsd, { compact: true })}
                        </td>
                        <td className="py-2 pr-3 align-middle">
                          {savingsTypeBadge(r.savingsType)}
                        </td>
                        <td className="py-2 align-middle">
                          <Link href={r.href}>
                            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/40 hover:text-foreground" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                    {group.rows.length > 10 && (
                      <tr>
                        <td
                          colSpan={7}
                          className="py-1 pl-4 text-xs text-muted-foreground"
                        >
                          +{group.rows.length - 10} more plays in this lever
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
