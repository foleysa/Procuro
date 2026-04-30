/**
 * Admin observability surface for the OODA funnel substrate (task #185).
 *
 * NOT user-facing in v1: routed under /admin/funnel and gated by the
 * same AdminGuard as /admin. Dense, table-first design — this is for
 * platform / org admins debugging the pipeline, not buyers.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

interface SnapshotListRow {
  id: string;
  cycleId: string;
  cycleGeneration: number;
  totalDraftsProduced: number;
  totalDraftsPostExclusion: number;
  totalOppsPersisted: number;
  totalProjectedUsd: string;
  captureDurationMs: number;
  hasAutoAnnotation: number;
  createdAt: string;
}

interface SnapshotListResp {
  snapshots: SnapshotListRow[];
  warmupComplete: boolean;
  totalSnapshotCount: number;
}

interface StagePayload {
  count: number;
  capped?: boolean;
  by_lever?: Record<string, number>;
  total_projected_usd?: number;
  total_realized_usd?: number;
  dropped_by_exclusion?: number;
}

interface SnapshotDetail {
  snapshot: {
    id: string;
    cycleId: string;
    cycleGeneration: number;
    stages: Record<string, StagePayload>;
    cohorts: Record<string, Array<{ key: string; count: number }>>;
    calibration: Record<
      string,
      {
        leverId: string;
        window: string;
        n: number;
        rawMedianAbsErrorUsd: number;
        rescaledMedianAbsErrorUsd: number;
        improvementUsd: number;
        verdict: string;
      }
    >;
    captureDurationMs: number;
    createdAt: string;
  };
  annotations: Array<{
    id: string;
    source: "auto" | "operator";
    kind: string;
    targetStage: string | null;
    summary: string;
    createdAt: string;
    ackedAt: string | null;
  }>;
}

interface FailureRow {
  id: string;
  cycleId: string;
  cycleGeneration: number;
  errorClass: string;
  errorMessage: string;
  recurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  ackedAt: string | null;
}

const STAGE_ORDER = [
  "signals_collected",
  "signals_mapped_to_levers",
  "signals_analyzed",
  "drafts_produced",
  "drafts_post_exclusion",
  "opps_persisted",
  "opps_approved_7d",
  "opps_approved_30d",
  "opps_approved_90d",
  "opps_executed_7d",
  "opps_executed_30d",
  "opps_executed_90d",
  "opps_realized_7d",
  "opps_realized_30d",
  "opps_realized_90d",
  "priors_updated",
] as const;

const STAGE_LABELS: Record<string, string> = {
  signals_collected: "1. Signals collected",
  signals_mapped_to_levers: "2. Signals mapped to levers",
  signals_analyzed: "3. Signals analyzed",
  drafts_produced: "4. Drafts produced",
  drafts_post_exclusion: "5. Drafts post-exclusion",
  opps_persisted: "6. Opps persisted",
  opps_approved_7d: "7a. Approved (7d cohort)",
  opps_approved_30d: "7b. Approved (30d cohort)",
  opps_approved_90d: "7c. Approved (90d cohort)",
  opps_executed_7d: "8a. Executed (7d cohort)",
  opps_executed_30d: "8b. Executed (30d cohort)",
  opps_executed_90d: "8c. Executed (90d cohort)",
  opps_realized_7d: "9a. Realized (7d cohort)",
  opps_realized_30d: "9b. Realized (30d cohort)",
  opps_realized_90d: "9c. Realized (90d cohort)",
  priors_updated: "10. Priors updated",
};

function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}
function fmtUsd(n: number | string | undefined): string {
  if (n == null) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!isFinite(v)) return "—";
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

// ───────────────────────── Snapshots tab ─────────────────────────────

function SnapshotsTab({
  selected,
  setSelected,
}: {
  selected: string | null;
  setSelected: (id: string | null) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["funnel", "snapshots"],
    queryFn: () =>
      fetchJson<SnapshotListResp>("/api/admin/funnel/snapshots?limit=50"),
  });

  return (
    <Card data-testid="card-snapshots">
      <CardHeader>
        <CardTitle>Per-cycle snapshots</CardTitle>
        <CardDescription>
          Persistent snapshots; one row per OODA cycle.
          {data && (
            <Badge
              variant={data.warmupComplete ? "default" : "secondary"}
              className="ml-2"
            >
              {data.warmupComplete
                ? "delta-detection active"
                : `warmup ${data.totalSnapshotCount}/5`}
            </Badge>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <div>Loading…</div>}
        {data && data.snapshots.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No snapshots yet. The next analysis cycle will write one.
          </div>
        )}
        {data && data.snapshots.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cycle</TableHead>
                <TableHead>Drafts</TableHead>
                <TableHead>Post-Excl.</TableHead>
                <TableHead>Persisted</TableHead>
                <TableHead>Projected</TableHead>
                <TableHead>Capture</TableHead>
                <TableHead>Annotated</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.snapshots.map((s) => (
                <TableRow
                  key={s.id}
                  data-testid={`row-snapshot-${s.cycleGeneration}`}
                  data-state={selected === s.id ? "selected" : undefined}
                >
                  <TableCell className="font-mono">#{s.cycleGeneration}</TableCell>
                  <TableCell>{s.totalDraftsProduced}</TableCell>
                  <TableCell>{s.totalDraftsPostExclusion}</TableCell>
                  <TableCell>{s.totalOppsPersisted}</TableCell>
                  <TableCell>{fmtUsd(s.totalProjectedUsd)}</TableCell>
                  <TableCell>{s.captureDurationMs}ms</TableCell>
                  <TableCell>
                    {s.hasAutoAnnotation ? (
                      <Badge variant="destructive">auto</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{fmtTime(s.createdAt)}</TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelected(s.id)}
                      data-testid={`button-view-snapshot-${s.cycleGeneration}`}
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SnapshotDetailPanel({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["funnel", "snapshot", id],
    queryFn: () =>
      fetchJson<SnapshotDetail>(`/api/admin/funnel/snapshots/${id}`),
  });
  if (isLoading) return <div>Loading…</div>;
  if (!data) return null;
  const { snapshot, annotations } = data;
  return (
    <div className="space-y-4">
      <Card data-testid="card-stage-table">
        <CardHeader>
          <CardTitle>10-stage funnel — cycle #{snapshot.cycleGeneration}</CardTitle>
          <CardDescription>
            {fmtTime(snapshot.createdAt)} · captured in{" "}
            {snapshot.captureDurationMs}ms
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stage</TableHead>
                <TableHead>Count</TableHead>
                <TableHead>By lever</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {STAGE_ORDER.map((key) => {
                const stage = snapshot.stages[key];
                if (!stage) return null;
                const notes: string[] = [];
                if (stage.capped) notes.push("capped sample");
                if (stage.dropped_by_exclusion != null)
                  notes.push(`${stage.dropped_by_exclusion} dropped`);
                if (stage.total_projected_usd != null)
                  notes.push(`projected ${fmtUsd(stage.total_projected_usd)}`);
                if (stage.total_realized_usd != null)
                  notes.push(`realized ${fmtUsd(stage.total_realized_usd)}`);
                return (
                  <TableRow key={key} data-testid={`row-stage-${key}`}>
                    <TableCell className="font-medium">
                      {STAGE_LABELS[key] ?? key}
                    </TableCell>
                    <TableCell className="font-mono">{stage.count}</TableCell>
                    <TableCell className="text-xs">
                      {stage.by_lever
                        ? Object.entries(stage.by_lever)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(", ") || "—"
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {notes.join(" · ") || "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card data-testid="card-cohort-table">
        <CardHeader>
          <CardTitle>Cohort identity drill-down (persisted)</CardTitle>
          <CardDescription>
            Identity tuple = lever:primaryEntity:leverKey
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(snapshot.cohorts["persisted"] ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground">No persisted cohorts.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Identity key</TableHead>
                  <TableHead>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(snapshot.cohorts["persisted"] ?? []).slice(0, 25).map((c) => (
                  <TableRow key={c.key}>
                    <TableCell className="font-mono text-xs">{c.key}</TableCell>
                    <TableCell>{c.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-calibration-table">
        <CardHeader>
          <CardTitle>Prior calibration</CardTitle>
          <CardDescription>
            Median absolute error of (projected − realized) USD per lever &amp;
            window. Verdict gates on n ≥ 10 and a $100 swing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {Object.keys(snapshot.calibration).length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Insufficient realized history — no calibration verdict yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lever</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead>n</TableHead>
                  <TableHead>Raw MAE</TableHead>
                  <TableHead>Rescaled MAE</TableHead>
                  <TableHead>Improvement</TableHead>
                  <TableHead>Verdict</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.values(snapshot.calibration).map((c) => (
                  <TableRow key={`${c.leverId}:${c.window}`}>
                    <TableCell className="font-mono text-xs">{c.leverId}</TableCell>
                    <TableCell>{c.window}</TableCell>
                    <TableCell>{c.n}</TableCell>
                    <TableCell>{fmtUsd(c.rawMedianAbsErrorUsd)}</TableCell>
                    <TableCell>{fmtUsd(c.rescaledMedianAbsErrorUsd)}</TableCell>
                    <TableCell>{fmtUsd(c.improvementUsd)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.verdict === "helping"
                            ? "default"
                            : c.verdict === "hurting"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {c.verdict}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-annotations">
        <CardHeader>
          <CardTitle>Annotations</CardTitle>
          <CardDescription>
            Auto-deltas + operator notes on this snapshot.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {annotations.length === 0 ? (
            <div className="text-sm text-muted-foreground">No annotations.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Acked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {annotations.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Badge
                        variant={a.source === "auto" ? "destructive" : "secondary"}
                      >
                        {a.source}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{a.kind}</TableCell>
                    <TableCell className="text-xs font-mono">
                      {a.targetStage ?? "—"}
                    </TableCell>
                    <TableCell>{a.summary}</TableCell>
                    <TableCell className="text-xs">{fmtTime(a.createdAt)}</TableCell>
                    <TableCell className="text-xs">{fmtTime(a.ackedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ───────────────────────── Failures tab ──────────────────────────────

function FailuresTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["funnel", "failures"],
    queryFn: () =>
      fetchJson<{ failures: FailureRow[]; counters: Record<string, number> }>(
        "/api/admin/funnel/failures",
      ),
  });
  const ackM = useMutation({
    mutationFn: (id: string) =>
      fetchJson<unknown>(`/api/admin/funnel/failures/${id}/ack`, {
        method: "PATCH",
      }),
    onSuccess: () => {
      toast({ title: "Failure acked" });
      qc.invalidateQueries({ queryKey: ["funnel", "failures"] });
    },
  });
  const failures = data?.failures ?? [];
  const unacked = failures.filter((f) => !f.ackedAt);
  return (
    <Card data-testid="card-failures">
      <CardHeader>
        <CardTitle>Snapshot failures</CardTitle>
        <CardDescription>
          Snapshot bugs are recorded here so they can&apos;t silently blind
          observability. Recurrence counts collapse the same error within
          24h.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {unacked.length > 0 && (
          <div
            className="mb-3 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="banner-failures"
          >
            {unacked.length} unacked snapshot failure(s).
          </div>
        )}
        {isLoading && <div>Loading…</div>}
        {!isLoading && failures.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No snapshot failures recorded.
          </div>
        )}
        {failures.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cycle #</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Recurrences</TableHead>
                <TableHead>First seen</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failures.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="font-mono">#{f.cycleGeneration}</TableCell>
                  <TableCell>
                    <Badge variant="destructive">{f.errorClass}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs max-w-md truncate">
                    {f.errorMessage}
                  </TableCell>
                  <TableCell>{f.recurrenceCount}</TableCell>
                  <TableCell className="text-xs">{fmtTime(f.firstSeenAt)}</TableCell>
                  <TableCell className="text-xs">{fmtTime(f.lastSeenAt)}</TableCell>
                  <TableCell>
                    {f.ackedAt ? (
                      <span className="text-xs text-muted-foreground">
                        acked
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => ackM.mutate(f.id)}
                        disabled={ackM.isPending}
                      >
                        Ack
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────── Lowest-conversion tab ───────────────────────

interface LowestConvRow {
  leverId: string;
  stages: {
    drafts: number;
    postEx: number;
    persisted: number;
    approved30: number;
    realized30: number;
  };
  worstTransition: string | null;
  worstRate: number | null;
}

function LowestConversionTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["funnel", "lowest-conversion"],
    queryFn: () =>
      fetchJson<{ rows: LowestConvRow[]; cyclesAnalyzed: number }>(
        "/api/admin/funnel/lowest-conversion?cycles=10",
      ),
  });
  return (
    <Card data-testid="card-lowest-conversion">
      <CardHeader>
        <CardTitle>Lowest-conversion levers</CardTitle>
        <CardDescription>
          Identifies the worst transition for each lever over the last
          {data ? ` ${data.cyclesAnalyzed}` : ""} cycles.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <div>Loading…</div>}
        {data && data.rows.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No lever activity in window.
          </div>
        )}
        {data && data.rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lever</TableHead>
                <TableHead>Drafts</TableHead>
                <TableHead>Post-Excl.</TableHead>
                <TableHead>Persisted</TableHead>
                <TableHead>Approved 30d</TableHead>
                <TableHead>Realized 30d</TableHead>
                <TableHead>Worst transition</TableHead>
                <TableHead>Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={r.leverId} data-testid={`row-lever-${r.leverId}`}>
                  <TableCell className="font-mono text-xs">{r.leverId}</TableCell>
                  <TableCell>{r.stages.drafts}</TableCell>
                  <TableCell>{r.stages.postEx}</TableCell>
                  <TableCell>{r.stages.persisted}</TableCell>
                  <TableCell>{r.stages.approved30}</TableCell>
                  <TableCell>{r.stages.realized30}</TableCell>
                  <TableCell className="text-xs">
                    {r.worstTransition ?? "—"}
                  </TableCell>
                  <TableCell>
                    {r.worstRate != null
                      ? `${(r.worstRate * 100).toFixed(0)}%`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────────── Page ──────────────────────────────────

export default function AdminFunnelPage() {
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(
    null,
  );

  return (
    <div className="p-6 space-y-6" data-testid="page-admin-funnel">
      <div>
        <h1 className="text-2xl font-bold mb-1">Funnel observability</h1>
        <p className="text-muted-foreground text-sm">
          Per-cycle 10-stage snapshots, cohort drill-down, prior calibration,
          and snapshot-failure tracking. Tenant-scoped.
        </p>
      </div>
      <Tabs defaultValue="snapshots">
        <TabsList>
          <TabsTrigger value="snapshots" data-testid="tab-snapshots">
            Snapshots
          </TabsTrigger>
          <TabsTrigger value="lowest" data-testid="tab-lowest">
            Lowest conversion
          </TabsTrigger>
          <TabsTrigger value="failures" data-testid="tab-failures">
            Failures
          </TabsTrigger>
        </TabsList>
        <TabsContent value="snapshots" className="space-y-4">
          <SnapshotsTab
            selected={selectedSnapshotId}
            setSelected={setSelectedSnapshotId}
          />
          {selectedSnapshotId && (
            <SnapshotDetailPanel id={selectedSnapshotId} />
          )}
        </TabsContent>
        <TabsContent value="lowest">
          <LowestConversionTab />
        </TabsContent>
        <TabsContent value="failures">
          <FailuresTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
