/**
 * Contract detail screen.
 *
 * Layout (top-to-bottom):
 *   1. Header — number, title, supplier, derived status, key dates.
 *   2. Inline edit form — owner / internalNotes / renewalTargetDate /
 *      renewalTargetAction. PATCH writes audit-log rows server-side
 *      (one per changed field), so we surface those rows lower down.
 *   3. Linked opportunities — anything in the opportunities feed whose
 *      `inputs.contractId` matches.
 *   4. FX-exposure card — `FxTrendChart` filtered to the contract's
 *      billing-currency pair (EUR/{cur} or USD/{cur}). Hidden when the
 *      contract is billed in USD because there's no pair to plot.
 *   5. PPI / market-signals card — non-FX category-scoped signals
 *      returned alongside the detail (`marketSignals`).
 *   6. Citations — disclosure-policy-aware via `<InsightCitations/>`.
 *   7. Items — contracted SKUs and tier pricing.
 *   8. Activity timeline — server-supplied audit log entries, newest
 *      first.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetContract,
  usePatchContract,
  getGetContractQueryKey,
  getListContractsQueryKey,
  type ContractItem,
  type ContractLinkedOpportunity,
  type ContractAuditEntry,
  type ContractChildSow,
  type ContractContractType,
  type MarketSignal,
} from "@workspace/api-client-react";
import {
  ArrowLeft,
  Loader2,
  FileText,
  Save,
  Calendar,
  Bell,
  AlertTriangle,
  Activity as ActivityIcon,
  TrendingUp,
  Wrench,
  FileSignature,
  ArrowRight,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { formatUsd, formatDate, formatDateTime, leverLabel } from "@/lib/format";
import { FxTrendChart } from "@/components/fx-trend-chart";
import { BlsTrendChart } from "@/components/bls-trend-chart";
import { InsightCitations } from "@/components/insight-citations";
import { usePolicy } from "@/lib/use-policy";
import { DerivedStatusBadge } from "./contracts";

export default function ContractDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const policy = usePolicy();

  const { data: contract, isLoading, error } = useGetContract(id);
  const patchM = usePatchContract({
    mutation: {
      onSuccess: (resp) => {
        toast({ title: "Contract updated" });
        // Server returns the full ContractDetail — seed the cache so
        // the audit timeline reflects the new entries immediately.
        qc.setQueryData(getGetContractQueryKey(id), resp);
        qc.invalidateQueries({ queryKey: getListContractsQueryKey() });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not save changes",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  // Local edit state seeded from the server response. We keep it
  // controlled so we can render an obvious "dirty" indicator and only
  // ship changed fields up to PATCH.
  const [owner, setOwner] = useState("");
  const [notes, setNotes] = useState("");
  const [targetAction, setTargetAction] = useState("");
  const [targetDate, setTargetDate] = useState("");

  useEffect(() => {
    if (!contract) return;
    setOwner(contract.owner ?? "");
    setNotes(contract.internalNotes ?? "");
    setTargetAction(contract.renewalTargetAction ?? "");
    setTargetDate(
      contract.renewalTargetDate
        ? contract.renewalTargetDate.slice(0, 10)
        : "",
    );
  }, [contract]);

  // All hooks must run on every render (rules-of-hooks). The contract
  // body / signal split below is computed even when `contract` is
  // undefined so the hook order stays stable across the loading /
  // loaded transitions; the early returns below only short-circuit the
  // *render*, not the hook calls.
  const fxSignals = useMemo(
    () =>
      (contract?.marketSignals ?? []).filter((s) => s.signalType === "fx_rate"),
    [contract],
  );
  const otherSignals = useMemo(
    () =>
      (contract?.marketSignals ?? []).filter((s) => s.signalType !== "fx_rate"),
    [contract],
  );
  const fxPair = useMemo(
    () => pickFxPair(contract?.billingCurrency, fxSignals),
    [contract?.billingCurrency, fxSignals],
  );

  if (isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading contract…
      </div>
    );
  }
  if (error || !contract) {
    return (
      <div className="p-8 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/contracts")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to contracts
        </Button>
        <Card>
          <CardContent className="pt-6 text-destructive flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Could not load this contract.
          </CardContent>
        </Card>
      </div>
    );
  }

  const dirty =
    (owner.trim() || null) !== (contract.owner ?? null) ||
    (notes || null) !== (contract.internalNotes ?? null) ||
    (targetAction.trim() || null) !== (contract.renewalTargetAction ?? null) ||
    isoDateChanged(targetDate, contract.renewalTargetDate ?? null);

  const onSave = () => {
    const data: {
      owner?: string | null;
      internalNotes?: string | null;
      renewalTargetAction?: string | null;
      renewalTargetDate?: string | null;
    } = {};
    if ((owner.trim() || null) !== (contract.owner ?? null)) {
      data.owner = owner.trim() || null;
    }
    if ((notes || null) !== (contract.internalNotes ?? null)) {
      data.internalNotes = notes || null;
    }
    if ((targetAction.trim() || null) !== (contract.renewalTargetAction ?? null)) {
      data.renewalTargetAction = targetAction.trim() || null;
    }
    if (isoDateChanged(targetDate, contract.renewalTargetDate ?? null)) {
      data.renewalTargetDate = targetDate
        ? new Date(`${targetDate}T00:00:00Z`).toISOString()
        : null;
    }
    if (Object.keys(data).length === 0) return;
    patchM.mutate({ id, data });
  };

  return (
    <div className="p-8 space-y-6 max-w-5xl">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate("/contracts")}
        data-testid="btn-back"
      >
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to contracts
      </Button>

      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <FileText className="w-6 h-6 text-primary" />
          <h1 data-testid="text-page-title" className="text-2xl font-bold">
            {contract.title}
          </h1>
          <DerivedStatusBadge
            status={contract.derivedStatus}
            daysToExpiry={contract.daysToExpiry ?? null}
          />
          {contract.renewalAlertedThresholds.length > 0 && (
            <Badge
              variant="outline"
              className="gap-1 text-amber-600 border-amber-500/40"
              data-testid="renewal-alerted-badge"
            >
              <Bell className="w-3 h-3" />
              Alerted at{" "}
              {contract.renewalAlertedThresholds
                .slice()
                .sort((a, b) => b - a)
                .map((d) => `${d}d`)
                .join(", ")}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          <span className="font-mono">{contract.contractNumber}</span> ·{" "}
          {contract.supplierName ?? "—"}
          {contract.categoryName && <> · {contract.categoryName}</>}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="Start" value={formatDate(contract.startDate)} />
        <Kpi label="End" value={formatDate(contract.endDate)} />
        <Kpi
          label="Annual baseline"
          value={
            contract.annualBaselineUsd != null
              ? formatUsd(contract.annualBaselineUsd, { compact: true })
              : "—"
          }
          sub={contract.billingCurrency ?? undefined}
        />
        <Kpi
          label="Payment terms"
          value={
            contract.paymentTermsDays != null
              ? `${contract.paymentTermsDays}d`
              : "—"
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Renewal & ownership</CardTitle>
          <CardDescription>
            Inline edits are recorded on the activity timeline below. Empty a
            field to clear it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="owner">Owner</Label>
            <Input
              id="owner"
              data-testid="input-owner"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="e.g. alex@example.com"
              maxLength={200}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="renewal-target-date">Renewal target date</Label>
            <Input
              id="renewal-target-date"
              type="date"
              data-testid="input-renewal-target-date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="renewal-target-action">Renewal action</Label>
            <Input
              id="renewal-target-action"
              data-testid="input-renewal-target-action"
              value={targetAction}
              onChange={(e) => setTargetAction(e.target.value)}
              placeholder="e.g. Renegotiate at 5% reduction"
              maxLength={1000}
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="internal-notes">Internal notes</Label>
            <Textarea
              id="internal-notes"
              data-testid="input-internal-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              maxLength={5000}
              placeholder="Negotiation context, escalation paths, hidden risks…"
            />
          </div>
          <div className="md:col-span-2 flex items-center gap-3">
            <Button
              data-testid="btn-save"
              disabled={!dirty || patchM.isPending}
              onClick={onSave}
            >
              {patchM.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save changes
            </Button>
            {dirty && (
              <span className="text-xs text-muted-foreground">
                Unsaved changes
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {isServicesContract(contract.contractType) && (
        <ServicesContractCard
          contractType={contract.contractType}
          serviceLevelTerms={contract.serviceLevelTerms}
          acceptanceCriteria={contract.acceptanceCriteria}
          msaParentId={contract.msaParentId}
        />
      )}

      {contract.childSows && contract.childSows.length > 0 && (
        <ChildSowsCard sows={contract.childSows} />
      )}

      {contract.linkedOpportunities.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Linked opportunities</CardTitle>
            <CardDescription>
              Opportunities that referenced this contract as their input.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {contract.linkedOpportunities.map((opp) => (
              <LinkedOpportunityRow key={opp.id} opp={opp} />
            ))}
          </CardContent>
        </Card>
      )}

      {fxPair && (
        <FxTrendChart
          pairs={[fxPair]}
          title={`FX exposure — ${fxPair}`}
          description={`Daily ECB reference rates for the contract's billing currency. Movement here is an early indicator that the ${contract.billingCurrency ?? "billing"} side of this contract is drifting against your USD baseline.`}
          emptyStateHint="Backfill FX history from the Collector Workbench to populate this chart."
        />
      )}

      {contract.cpiScopeCode && (
        <BlsTrendChart
          series={[
            {
              label: cpiSeriesLabel(contract.cpiScopeCode),
              categoryCode: contract.cpiScopeCode,
            },
          ]}
          title={`CPI pushback — ${cpiSeriesLabel(contract.cpiScopeCode)}`}
          description={`Monthly BLS CPI sub-index for ${cpiSeriesLabel(contract.cpiScopeCode)}. When this supplier asks for a price increase, compare the ask to the matching CPI move to push back on anything that runs ahead of the index.`}
          emptyStateHint="Run the BLS Economic Index collector from the Collector Workbench to seed the CPI sub-series."
        />
      )}

      {otherSignals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5" />
              Market signals
            </CardTitle>
            <CardDescription>
              Category-scoped PPI / index observations relevant to this
              contract.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="text-sm space-y-1">
              {otherSignals.slice(0, 8).map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 border-b last:border-b-0 py-1.5"
                >
                  <span className="text-muted-foreground">
                    {s.signalType.replace(/_/g, " ")}
                  </span>
                  <span className="tabular-nums">
                    {s.value.toFixed(2)}
                    {s.unit ? ` ${s.unit}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(s.observedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {contract.sources.length > 0 && (
        <InsightCitations sources={contract.sources} policy={policy} />
      )}

      {contract.items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Contracted items ({contract.items.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left p-3">SKU</th>
                  <th className="text-right p-3">Unit price (USD)</th>
                  <th className="text-left p-3">Tier breaks</th>
                </tr>
              </thead>
              <tbody>
                {contract.items.map((it) => (
                  <ItemRow key={it.id} item={it} />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ActivityIcon className="w-5 h-5" />
            Activity
          </CardTitle>
          <CardDescription>
            Inline edits and renewal-alert events for this contract, newest
            first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {contract.auditLog.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No edits yet. Save the form above to start the timeline.
            </p>
          ) : (
            <ol className="space-y-2 text-sm">
              {contract.auditLog.map((e) => (
                <AuditRow key={e.id} entry={e} />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">
        {label}
      </div>
      <div className="text-xl font-bold mt-1 tabular-nums">{value}</div>
      {sub && (
        <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
      )}
    </div>
  );
}

function LinkedOpportunityRow({ opp }: { opp: ContractLinkedOpportunity }) {
  return (
    <Link
      href={`/opportunities/${opp.id}`}
      className="flex items-center justify-between p-3 rounded-md border hover:bg-accent/40 transition-colors"
      data-testid={`linked-opp-${opp.id}`}
    >
      <div className="min-w-0">
        <div className="font-medium truncate">{opp.title}</div>
        <div className="text-xs text-muted-foreground">
          {leverLabel(opp.leverId)} · {opp.status}
        </div>
      </div>
      <div className="text-right tabular-nums text-sm font-semibold ml-3 shrink-0">
        {formatUsd(opp.projectedSavingsUsd, { compact: true })}
      </div>
    </Link>
  );
}

function ItemRow({ item }: { item: ContractItem }) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="p-3 font-mono text-xs">{item.sku}</td>
      <td className="p-3 text-right tabular-nums">
        {formatUsd(item.contractedUnitPriceUsd)}
      </td>
      <td className="p-3 text-xs text-muted-foreground">
        {item.tiers && item.tiers.length > 0
          ? item.tiers
              .map(
                (t) =>
                  `≥${t.minQty} → ${formatUsd(t.unitPriceUsd, { compact: true })}`,
              )
              .join(" · ")
          : "—"}
      </td>
    </tr>
  );
}

function AuditRow({ entry }: { entry: ContractAuditEntry }) {
  return (
    <li
      className="border-l-2 border-border pl-3 py-1"
      data-testid={`audit-${entry.id}`}
    >
      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <Calendar className="w-3 h-3" />
        {formatDateTime(entry.createdAt)} · {entry.actorEmail}
      </div>
      <div className="text-sm">
        Changed <span className="font-medium">{entry.field}</span>{" "}
        <span className="text-muted-foreground">
          {fmtAuditValue(entry.oldValue)} → {fmtAuditValue(entry.newValue)}
        </span>
      </div>
    </li>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const CONTRACT_TYPE_LABELS: Record<ContractContractType, string> = {
  goods: "Goods",
  t_and_m: "Time & Materials",
  fixed_price: "Fixed Price",
  milestone: "Milestone",
  retainer: "Retainer",
  outcome: "Outcome",
};

function isServicesContract(t: ContractContractType | undefined): boolean {
  return t != null && t !== "goods";
}

function ServicesContractCard({
  contractType,
  serviceLevelTerms,
  acceptanceCriteria,
  msaParentId,
}: {
  contractType: ContractContractType | undefined;
  serviceLevelTerms: unknown;
  acceptanceCriteria: string | null | undefined;
  msaParentId: string | null | undefined;
}) {
  const slaText = formatSlaTerms(serviceLevelTerms);
  return (
    <Card data-testid="card-services-contract">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="w-5 h-5" />
          Services terms
        </CardTitle>
        <CardDescription>
          Commercial structure and SLA / acceptance criteria specific to the
          services side of this agreement.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-xs uppercase text-muted-foreground tracking-wide">
              Contract type
            </div>
            <div
              className="font-medium mt-1"
              data-testid="services-contract-type"
            >
              {contractType
                ? CONTRACT_TYPE_LABELS[contractType] ?? contractType
                : "—"}
            </div>
          </div>
          {msaParentId && (
            <div>
              <div className="text-xs uppercase text-muted-foreground tracking-wide">
                Master agreement
              </div>
              <Link
                href={`/contracts/${msaParentId}`}
                className="font-medium mt-1 text-primary hover:underline inline-flex items-center gap-1"
                data-testid="link-msa-parent"
              >
                Open parent MSA →
              </Link>
            </div>
          )}
        </div>
        {slaText && (
          <div>
            <div className="text-xs uppercase text-muted-foreground tracking-wide">
              Service level terms
            </div>
            <pre
              className="text-xs bg-muted/40 rounded p-3 mt-1 whitespace-pre-wrap break-words"
              data-testid="services-sla"
            >
              {slaText}
            </pre>
          </div>
        )}
        {acceptanceCriteria && (
          <div>
            <div className="text-xs uppercase text-muted-foreground tracking-wide">
              Acceptance criteria
            </div>
            <p
              className="mt-1 whitespace-pre-wrap"
              data-testid="services-acceptance"
            >
              {acceptanceCriteria}
            </p>
          </div>
        )}
        {!slaText && !acceptanceCriteria && (
          <p className="text-xs text-muted-foreground italic">
            No SLA terms or acceptance criteria recorded yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function formatSlaTerms(terms: unknown): string | null {
  if (terms == null) return null;
  if (typeof terms === "string") return terms.trim() || null;
  try {
    return JSON.stringify(terms, null, 2);
  } catch {
    return null;
  }
}

function ChildSowsCard({ sows }: { sows: ContractChildSow[] }) {
  const totalCommitted = sows.reduce((s, x) => s + x.totalValueUsd, 0);
  const openMilestones = sows.reduce((s, x) => s + x.openMilestoneCount, 0);
  return (
    <Card data-testid="card-child-sows">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSignature className="w-5 h-5" />
          Statements of work ({sows.length})
        </CardTitle>
        <CardDescription>
          {formatUsd(totalCommitted, { compact: true })} committed across these
          SOWs · {openMilestones} open milestone
          {openMilestones === 1 ? "" : "s"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0 divide-y">
        {sows.map((s) => (
          <Link
            key={s.id}
            href={`/sows/${s.id}`}
            className="flex items-center gap-4 p-3 hover:bg-accent/40 transition-colors"
            data-testid={`child-sow-${s.id}`}
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {s.sowNumber}
                </span>
                <span className="truncate">{s.title}</span>
                <Badge
                  variant={
                    s.status === "active"
                      ? "default"
                      : s.status === "completed"
                        ? "secondary"
                        : s.status === "cancelled"
                          ? "destructive"
                          : "outline"
                  }
                  className="capitalize text-[10px]"
                >
                  {s.status}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {formatDate(s.startDate ?? null)} →{" "}
                {formatDate(s.endDate ?? null)} · {s.openMilestoneCount}/
                {s.milestoneCount} open milestones
              </div>
            </div>
            <div className="text-right tabular-nums text-sm font-semibold w-28 shrink-0">
              {formatUsd(s.totalValueUsd, { compact: true })}
            </div>
            <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

function fmtAuditValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") {
    if (v.length > 60) return `"${v.slice(0, 57)}…"`;
    return `"${v}"`;
  }
  return JSON.stringify(v);
}

function isoDateChanged(localYmd: string, currentIso: string | null): boolean {
  const currentYmd = currentIso ? currentIso.slice(0, 10) : "";
  return localYmd !== currentYmd;
}

/**
 * Pretty-print a canonical BLS CPI scope code (`FOOD_AT_HOME`,
 * `ENERGY`, …) into a chart-friendly label. Used by the CPI pushback
 * trend chart on contract / supplier detail screens.
 */
function cpiSeriesLabel(scopeCode: string): string {
  return `CPI: ${scopeCode
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ")}`;
}

/**
 * Pick the FX pair to chart for this contract:
 *   - If the billing currency is missing or USD, return null
 *     (no meaningful pair to plot).
 *   - Prefer EUR/{cur} when the API returned ECB-native rows.
 *   - Otherwise fall back to USD/{cur} if those rows are present.
 */
function pickFxPair(
  billingCurrency: string | null | undefined,
  fxSignals: MarketSignal[],
): string | null {
  const cur = billingCurrency?.toUpperCase();
  if (!cur || cur === "USD") return null;
  const pairs = new Set(
    fxSignals
      .map((s) => s.scopeMaterialCode?.toUpperCase())
      .filter((p): p is string => Boolean(p)),
  );
  const eurPair = `EUR/${cur}`;
  const usdPair = `USD/${cur}`;
  if (pairs.has(eurPair)) return eurPair;
  if (pairs.has(usdPair)) return usdPair;
  // No data yet — still render the chart against EUR/{cur} so the chart
  // shows its own "no data" empty state with the backfill hint.
  return eurPair;
}
