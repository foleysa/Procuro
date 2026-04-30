import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCycles,
  useListLearnedPriors,
  useGetCycle,
  useRunNextCycle,
  getGetCycleQueryKey,
  type LearnedPrior,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { formatUsd, formatDateTime, leverLabel } from "@/lib/format";
import { Activity, Play, Loader2, Eye, Compass, GitBranch, Zap, GraduationCap, Radar } from "lucide-react";
import { InsightCitations } from "@/components/insight-citations";
import { usePolicy } from "@/lib/use-policy";

export default function Ooda() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: cycles, isLoading } = useListCycles();
  const { data: priors } = useListLearnedPriors();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sortedCycles = (cycles ?? []).slice().sort(
    (a, b) => b.generation - a.generation,
  );
  const activeCycle = sortedCycles.find((c) => c.id === selectedId) ?? sortedCycles[0];

  const runM = useRunNextCycle({
    mutation: {
      onSuccess: (resp) => {
        if ("jobId" in resp) {
          toast({
            title: "Cycle queued",
            description: `Job ${resp.jobId} is processing in the background.`,
          });
        } else {
          toast({
            title: `Cycle generation ${resp.generation} complete`,
            description: `${resp.opportunitiesCreated} new opportunities · ${formatUsd(resp.totalProjectedUsd, { compact: true })} projected`,
          });
        }
        qc.invalidateQueries({ queryKey: ["listCycles"] });
        qc.invalidateQueries({ queryKey: ["listOpportunities"] });
        qc.invalidateQueries({ queryKey: ["listLearnedPriors"] });
      },
      onError: (e: Error) =>
        toast({ title: "Cycle failed", description: String(e), variant: "destructive" }),
    },
  });

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex justify-between items-end gap-4 flex-wrap">
        <div>
          <h1 data-testid="text-page-title" className="text-3xl font-bold flex items-center gap-2">
            <Activity className="w-7 h-7 text-primary" />
            OODA Wheel
          </h1>
          <p className="text-muted-foreground mt-1">
            Observe → Orient → Decide → Act → Learn. Every cycle bakes the previous outcomes into priors.
          </p>
        </div>
        <Button
          data-testid="btn-run-cycle"
          onClick={() => runM.mutate({})}
          disabled={runM.isPending}
          size="lg"
        >
          {runM.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Play className="w-4 h-4 mr-2" />
          )}
          Run next cycle
        </Button>
      </div>

      <OodaWheel />

      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Cycle history</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            )}
            {!isLoading && sortedCycles.length === 0 && (
              <p className="text-muted-foreground text-sm">No cycles yet. Click "Run next cycle".</p>
            )}
            <div className="space-y-1.5">
              {sortedCycles.map((c) => (
                <button
                  key={c.id}
                  data-testid={`cycle-${c.generation}`}
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full flex items-center justify-between p-3 rounded-md border text-left text-sm transition-colors ${
                    activeCycle?.id === c.id
                      ? "bg-accent border-primary"
                      : "hover:bg-accent/40"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">Gen {c.generation}</Badge>
                    <div>
                      <div className="font-medium">
                        {c.opportunitiesCreated} opps ·{" "}
                        {formatUsd(c.totalProjectedUsd, { compact: true })}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDateTime(c.startedAt)} · {c.status}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <CycleDetailCard cycleId={activeCycle?.id} />
      </div>

      <PriorsTable priors={priors ?? []} />
    </div>
  );
}

function OodaWheel() {
  const stages = [
    { id: "observe", label: "Observe", icon: Eye, desc: "Snapshot all spend, contracts, payments." },
    { id: "orient", label: "Orient", icon: Compass, desc: "Apply per‑tenant learned priors." },
    { id: "decide", label: "Decide", icon: GitBranch, desc: "Rank by expected value × confidence." },
    { id: "act", label: "Act", icon: Zap, desc: "Write opportunities & flag for human approval." },
    { id: "learn", label: "Learn", icon: GraduationCap, desc: "Update priors from realized outcomes." },
  ];
  return (
    <div className="bg-card border rounded-lg p-6">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        {stages.map((s, i) => {
          const Icon = s.icon;
          return (
            <div
              key={s.id}
              data-testid={`ooda-stage-${s.id}`}
              className="relative bg-muted/40 rounded-md p-4 border-l-4 border-primary"
            >
              <div className="absolute top-2 right-2 text-xs text-muted-foreground tabular-nums">
                {i + 1}
              </div>
              <Icon className="w-6 h-6 text-primary mb-2" />
              <div className="font-semibold text-sm">{s.label}</div>
              <div className="text-xs text-muted-foreground mt-1 leading-snug">{s.desc}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CycleDetailCard({ cycleId }: { cycleId?: string }) {
  const { data: detail, isLoading } = useGetCycle(cycleId ?? "skip", {
    query: {
      enabled: !!cycleId,
      queryKey: getGetCycleQueryKey(cycleId ?? "skip"),
    },
  });
  const policy = usePolicy();

  if (!cycleId) {
    return (
      <Card>
        <CardHeader><CardTitle>Cycle detail</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Select a cycle on the left.</p></CardContent>
      </Card>
    );
  }

  if (isLoading || !detail) {
    return (
      <Card>
        <CardHeader><CardTitle>Cycle detail</CardTitle></CardHeader>
        <CardContent><Loader2 className="w-4 h-4 animate-spin" /></CardContent>
      </Card>
    );
  }

  const learn = detail.learnPayload as
    | { priorDeltas?: Array<{ leverId: string; prevProjectionMultiplier: number; newProjectionMultiplier: number; rationale?: string }> }
    | undefined;
  const observe = detail.observePayload as
    | {
        snapshot?: {
          suppliers?: number;
          purchaseOrders?: number;
          poLines?: number;
          invoices?: number;
          payments?: number;
          shipments?: number;
          activeContracts?: number;
        };
        outcomeEventsSincePrev?: number;
      }
    | undefined;
  const snap = observe?.snapshot;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cycle Gen {detail.generation} · detail</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {snap && (
          <div>
            <div className="font-semibold mb-1 flex items-center gap-2"><Eye className="w-4 h-4" /> Observe snapshot</div>
            <div className="text-muted-foreground text-xs">
              {(snap.suppliers ?? 0).toLocaleString()} suppliers ·{" "}
              {(snap.purchaseOrders ?? 0).toLocaleString()} POs ·{" "}
              {(snap.poLines ?? 0).toLocaleString()} PO lines ·{" "}
              {(snap.invoices ?? 0).toLocaleString()} invoices ·{" "}
              {(snap.payments ?? 0).toLocaleString()} payments ·{" "}
              {(snap.activeContracts ?? 0).toLocaleString()} active contracts
              {observe?.outcomeEventsSincePrev != null &&
                ` · ${observe.outcomeEventsSincePrev} outcomes since prev cycle`}
            </div>
          </div>
        )}
        <div>
          <div className="font-semibold mb-1 flex items-center gap-2"><Zap className="w-4 h-4" /> Act</div>
          <div className="text-muted-foreground">
            {detail.opportunitiesCreated} opportunities · {formatUsd(detail.totalProjectedUsd, { compact: true })} projected
          </div>
        </div>
        {detail.sources && detail.sources.length > 0 && (
          <InsightCitations
            sources={detail.sources}
            policy={policy}
            variant="card"
          />
        )}
        <div className="flex flex-wrap gap-3 text-xs">
          <Link
            href="/fusion"
            data-testid="link-fusion"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <Radar className="w-3.5 h-3.5" />
            Open Intelligence Fusion Center →
          </Link>
          <Link
            href={`/fusion?tab=events&cycleId=${encodeURIComponent(cycleId)}`}
            data-testid="link-fusion-cycle-events"
            className="inline-flex items-center gap-1 text-primary hover:underline"
            title="Open the war-room event stream filtered to this cycle's window"
          >
            <Radar className="w-3.5 h-3.5" />
            View war-room events for this cycle →
          </Link>
        </div>
        {learn?.priorDeltas && learn.priorDeltas.length > 0 && (
          <div>
            <div className="font-semibold mb-1 flex items-center gap-2"><GraduationCap className="w-4 h-4" /> Learn — prior deltas</div>
            <div className="space-y-1.5">
              {learn.priorDeltas.slice(0, 6).map((d, i) => {
                const arrow = d.newProjectionMultiplier > d.prevProjectionMultiplier ? "↑" : d.newProjectionMultiplier < d.prevProjectionMultiplier ? "↓" : "→";
                const dir = d.newProjectionMultiplier > d.prevProjectionMultiplier ? "text-green-600" : d.newProjectionMultiplier < d.prevProjectionMultiplier ? "text-destructive" : "text-muted-foreground";
                return (
                  <div key={i} className="flex justify-between gap-3 text-xs border-b pb-1">
                    <span className="font-medium">{leverLabel(d.leverId)}</span>
                    <span className={`tabular-nums ${dir}`}>
                      {d.prevProjectionMultiplier.toFixed(2)} {arrow} {d.newProjectionMultiplier.toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PriorsTable({ priors }: { priors: LearnedPrior[] }) {
  if (priors.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Learned priors</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No priors yet — they'll populate after the first cycle.</p>
        </CardContent>
      </Card>
    );
  }
  const sorted = priors.slice().sort(
    (a, b) => b.confidenceWeight - a.confidenceWeight,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Learned priors (per‑tenant)</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
              <th className="py-2">Lever</th>
              <th className="py-2 text-right">Projection ×</th>
              <th className="py-2 text-right">Confidence</th>
              <th className="py-2 text-right">Approvals</th>
              <th className="py-2 text-right">Rejections</th>
              <th className="py-2 text-right">Realized</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.leverId} className="border-t">
                <td className="py-2 font-medium">{leverLabel(p.leverId)}</td>
                <td className="py-2 text-right tabular-nums">{p.projectionMultiplier.toFixed(2)}</td>
                <td className="py-2 text-right tabular-nums">{p.confidenceWeight.toFixed(2)}</td>
                <td className="py-2 text-right tabular-nums">{p.approvalCount}</td>
                <td className="py-2 text-right tabular-nums">{p.rejectionCount}</td>
                <td className="py-2 text-right tabular-nums">{p.realizationCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
