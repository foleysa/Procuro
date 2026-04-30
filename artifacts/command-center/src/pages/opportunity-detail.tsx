import { useParams, Link, useLocation } from "wouter";
import { useState } from "react";
import {
  useGetOpportunity,
  useApproveOpportunity,
  useRejectOpportunity,
  useExecuteOpportunity,
  useRealizeOpportunity,
  RejectionReasonCode,
  getGetOpportunityQueryKey,
  getListOpportunitiesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  formatUsd,
  formatPercent,
  formatDateTime,
  leverLabel,
  REJECTION_REASON_LABELS,
} from "@/lib/format";
import {
  ArrowLeft,
  Check,
  X,
  Play,
  DollarSign,
  Loader2,
  FileText,
} from "lucide-react";
import { StatusBadge } from "./opportunities";
import { InsightCitations } from "@/components/insight-citations";
import { usePolicy } from "@/lib/use-policy";
import type { TenantPolicy } from "@workspace/intelligence/contracts";
import type { InsightSource, OpportunityDetail } from "@workspace/api-client-react";
import { TrendingDown, TrendingUp, MinusCircle } from "lucide-react";

export default function OpportunityDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: opp, isLoading } = useGetOpportunity(id);
  const policy = usePolicy();
  const [rejectReason, setRejectReason] = useState<RejectionReasonCode>(
    RejectionReasonCode.savings_overstated,
  );
  const [rejectNote, setRejectNote] = useState("");
  const [realizedAmount, setRealizedAmount] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetOpportunityQueryKey(id) });
    qc.invalidateQueries({ queryKey: getListOpportunitiesQueryKey() });
    qc.invalidateQueries({ queryKey: ["listCycles"] });
    qc.invalidateQueries({ queryKey: ["getBillingSummary"] });
  };

  const approveM = useApproveOpportunity({
    mutation: {
      onSuccess: () => {
        toast({ title: "Approved" });
        invalidate();
      },
      onError: (e: Error) => toast({ title: "Approve failed", description: String(e), variant: "destructive" }),
    },
  });
  const rejectM = useRejectOpportunity({
    mutation: {
      onSuccess: () => {
        toast({ title: "Rejected — feedback recorded" });
        invalidate();
      },
      onError: (e: Error) => toast({ title: "Reject failed", description: String(e), variant: "destructive" }),
    },
  });
  const execM = useExecuteOpportunity({
    mutation: {
      onSuccess: () => {
        toast({ title: "Marked executing" });
        invalidate();
      },
      onError: (e: Error) => toast({ title: "Execute failed", description: String(e), variant: "destructive" }),
    },
  });
  const realizeM = useRealizeOpportunity({
    mutation: {
      onSuccess: () => {
        toast({ title: "Savings realized" });
        invalidate();
      },
      onError: (e: Error) => toast({ title: "Realize failed", description: String(e), variant: "destructive" }),
    },
  });

  if (isLoading || !opp) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading…
      </div>
    );
  }

  const status = opp.status;

  return (
    <div className="p-8 space-y-6 max-w-5xl">
      <Button variant="ghost" size="sm" onClick={() => navigate("/opportunities")}>
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back
      </Button>

      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">{opp.title}</h1>
          <StatusBadge status={status} />
        </div>
        <p className="text-muted-foreground mt-1">
          {leverLabel(opp.leverId)} · Tier {opp.tier} · cycle {opp.cycleId.slice(-8)}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="Projected" value={formatUsd(opp.projectedSavingsUsd, { compact: true })} />
        <Kpi label="Raw projected" value={formatUsd(opp.rawProjectedSavingsUsd, { compact: true })} />
        <Kpi label="Confidence" value={formatPercent(opp.confidence)} />
        <Kpi
          label="Realized"
          value={opp.realizedSavingsUsd ? formatUsd(opp.realizedSavingsUsd, { compact: true }) : "—"}
        />
      </div>

      <Card>
        <CardHeader><CardTitle>Rationale</CardTitle></CardHeader>
        <CardContent className="text-sm whitespace-pre-line space-y-3">
          <div>{opp.rationale}</div>
          <InsightCitations
            sources={opp.sources}
            policy={policy}
            aggregateConfidence={opp.confidence}
          />
        </CardContent>
      </Card>

      <CpiPushbackBlock opp={opp} policy={policy} />

      <Card>
        <CardHeader><CardTitle>Recommended action</CardTitle></CardHeader>
        <CardContent className="text-sm whitespace-pre-line">{opp.recommendedAction}</CardContent>
      </Card>

      {opp.supplierName && (
        <div className="text-sm text-muted-foreground">
          <strong>Supplier:</strong> {opp.supplierName}
          {opp.categoryName && <> · <strong>Category:</strong> {opp.categoryName}</>}
        </div>
      )}

      {/*
        Cross-link to the contract this opportunity was derived from.
        The lever runner stores the contract id on `inputs.contractId`
        for tier-2 contract levers (renegotiate, etc.) — when that key
        is present, surface a one-click jump to the contract detail.
      */}
      {typeof opp.inputs?.contractId === "string" && (
        <Link
          href={`/contracts/${opp.inputs.contractId}`}
          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
          data-testid="link-source-contract"
        >
          <FileText className="w-4 h-4" />
          Open source contract
        </Link>
      )}

      {(opp.approvedAt || opp.rejectedAt || opp.executingAt || opp.realizedAt) && (
        <Card>
          <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div>Created: {formatDateTime(opp.createdAt)}</div>
            {opp.approvedAt && <div>Approved: {formatDateTime(opp.approvedAt)}</div>}
            {opp.executingAt && <div>Executing: {formatDateTime(opp.executingAt)}</div>}
            {opp.realizedAt && <div>Realized: {formatDateTime(opp.realizedAt)}</div>}
            {opp.rejectedAt && (
              <div>
                Rejected: {formatDateTime(opp.rejectedAt)}
                {opp.rejectedReasonCode && (
                  <span className="text-muted-foreground"> — {REJECTION_REASON_LABELS[opp.rejectedReasonCode] ?? opp.rejectedReasonCode}</span>
                )}
                {opp.rejectedReasonText && <div className="text-xs italic mt-1">"{opp.rejectedReasonText}"</div>}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {status === "proposed" && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader><CardTitle className="text-green-700">Approve</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-3">
                Move into execution and signal Procuro to act.
              </p>
              <Button
                data-testid="btn-approve"
                onClick={() => approveM.mutate({ id, data: {} })}
                disabled={approveM.isPending}
                className="w-full"
              >
                <Check className="w-4 h-4 mr-2" />
                Approve opportunity
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-destructive">Reject</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label>Reason</Label>
                <Select
                  value={rejectReason}
                  onValueChange={(v) => setRejectReason(v as RejectionReasonCode)}
                >
                  <SelectTrigger data-testid="select-reject-reason">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(RejectionReasonCode).map((code) => (
                      <SelectItem key={code} value={code}>
                        {REJECTION_REASON_LABELS[code] ?? code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Textarea
                  data-testid="input-reject-note"
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value)}
                  rows={2}
                />
              </div>
              <Button
                data-testid="btn-reject"
                variant="destructive"
                className="w-full"
                onClick={() =>
                  rejectM.mutate({
                    id,
                    data: { reasonCode: rejectReason, reasonText: rejectNote || undefined },
                  })
                }
                disabled={rejectM.isPending}
              >
                <X className="w-4 h-4 mr-2" />
                Reject opportunity
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {status === "approved" && (
        <Card>
          <CardHeader><CardTitle>Mark as executing</CardTitle></CardHeader>
          <CardContent>
            <Button
              data-testid="btn-execute"
              onClick={() => execM.mutate({ id })}
              disabled={execM.isPending}
            >
              <Play className="w-4 h-4 mr-2" />
              Move to executing
            </Button>
          </CardContent>
        </Card>
      )}

      {status === "executing" && (
        <Card>
          <CardHeader><CardTitle>Realize savings</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Label>Realized amount (USD)</Label>
            <Input
              data-testid="input-realized"
              type="number"
              value={realizedAmount}
              onChange={(e) => setRealizedAmount(e.target.value)}
              placeholder={String(Math.round(opp.projectedSavingsUsd))}
            />
            <Button
              data-testid="btn-realize"
              onClick={() =>
                realizeM.mutate({
                  id,
                  data: {
                    realizedSavingsUsd: Number(realizedAmount) || opp.projectedSavingsUsd,
                  },
                })
              }
              disabled={realizeM.isPending}
            >
              <DollarSign className="w-4 h-4 mr-2" />
              Mark realized
            </Button>
          </CardContent>
        </Card>
      )}

      <Link
        href="/opportunities"
        className="text-sm text-primary hover:underline inline-block"
      >
        ← Back to opportunities feed
      </Link>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">
        {label}
      </div>
      <div className="text-xl font-bold mt-1 tabular-nums">{value}</div>
    </div>
  );
}

/**
 * Shape of `inputs.cpiPushback` persisted by the
 * contract_renegotiation_trigger lever. Mirrors `CpiPushbackContext`
 * server-side; we re-declare narrowly here because `inputs` is typed
 * as an opaque JSON map by the OpenAPI contract.
 */
interface PersistedCpiPushback {
  cpiScopeCode: string;
  cpiMovePct: number;
  supplierAskPct: number;
  spreadPct: number;
  verdict: "support" | "pushback" | "cpi_decline";
  summary: string;
  lookbackDays: number;
  source?: InsightSource | null;
}

function isPersistedCpiPushback(v: unknown): v is PersistedCpiPushback {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.cpiScopeCode === "string" &&
    typeof o.cpiMovePct === "number" &&
    typeof o.supplierAskPct === "number" &&
    typeof o.spreadPct === "number" &&
    typeof o.summary === "string" &&
    typeof o.lookbackDays === "number" &&
    (o.verdict === "support" ||
      o.verdict === "pushback" ||
      o.verdict === "cpi_decline")
  );
}

const VERDICT_LABEL: Record<PersistedCpiPushback["verdict"], string> = {
  support: "CPI supports the ask",
  pushback: "Pushback defensible",
  cpi_decline: "CPI declined — strong pushback",
};

export function CpiPushbackBlock({
  opp,
  policy,
}: {
  opp: OpportunityDetail;
  policy: TenantPolicy;
}) {
  // Only contract_renegotiation_trigger persists cpiPushback today,
  // but we don't gate by leverId — the input shape is the contract.
  const raw = opp.inputs?.cpiPushback;
  if (!isPersistedCpiPushback(raw)) return null;

  const Icon =
    raw.verdict === "cpi_decline"
      ? TrendingDown
      : raw.verdict === "pushback"
        ? MinusCircle
        : TrendingUp;
  const tone =
    raw.verdict === "support"
      ? "text-muted-foreground"
      : raw.verdict === "cpi_decline"
        ? "text-emerald-700"
        : "text-amber-700";

  // Citation: the lever already pushed `raw.source` into `opp.sources`,
  // but render it inline here too so the CPI numbers carry their own
  // disclosure-tier provenance directly under the figures.
  const cpiSources = raw.source ? [raw.source] : [];

  const fmtPct = (n: number) =>
    `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

  return (
    <Card data-testid="card-cpi-pushback">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className={`w-5 h-5 ${tone}`} />
          CPI pushback —{" "}
          <span data-testid="text-cpi-scope-code">{raw.cpiScopeCode}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Kpi
            label="CPI move"
            value={fmtPct(raw.cpiMovePct)}
          />
          <Kpi
            label="Supplier ask"
            value={fmtPct(raw.supplierAskPct)}
          />
          <Kpi
            label="Spread"
            value={fmtPct(raw.spreadPct)}
          />
          <Kpi
            label="Lookback"
            value={`${raw.lookbackDays}d`}
          />
        </div>
        <div
          className={`text-sm font-medium ${tone}`}
          data-testid="text-cpi-verdict"
          data-verdict={raw.verdict}
        >
          {VERDICT_LABEL[raw.verdict]}
        </div>
        <div
          className="text-sm whitespace-pre-line"
          data-testid="text-cpi-summary"
        >
          {raw.summary}
        </div>
        {cpiSources.length > 0 && (
          <InsightCitations sources={cpiSources} policy={policy} />
        )}
      </CardContent>
    </Card>
  );
}
