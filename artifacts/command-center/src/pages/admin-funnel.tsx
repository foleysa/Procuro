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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  /**
   * Provenance discriminator. `live` snapshots came from a real cycle
   * and carry full stage 1–5 detail. `backfill` rows were
   * reconstructed post-hoc from persisted opportunities only — stages
   * 1–5 are zeroed by construction. The list view badges these
   * distinctly so a real "0 signals" cycle can't be confused with a
   * backfilled gap-filler. Defaults to `live` for older API responses
   * that pre-date this field.
   */
  source?: "live" | "backfill";
  createdAt: string;
}

interface SnapshotListResp {
  snapshots: SnapshotListRow[];
  warmupComplete: boolean;
  totalSnapshotCount: number;
  retention: {
    snapshotsOlderThanMs: number;
    failuresOlderThanMs: number;
  };
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
        /**
         * Canonical category code OR `_all` for the per-lever rollup
         * (task #218). Older snapshots from before #218 may omit this
         * field — UI guards default to `_all` so the legacy per-lever
         * "Prior calibration" table still renders one row per lever.
         */
        categoryCode?: string;
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

/**
 * Snapshot retention countdown (task #200).
 *
 * Computes when a snapshot row will be auto-pruned by the daily sweep,
 * derived from `createdAt + retention.snapshotsOlderThanMs`. Returns
 * `null` if retention config is unavailable. Negative `daysRemaining`
 * means the row is already past its cutoff and will be pruned on the
 * next sweep.
 */
function computeRetentionCountdown(
  createdAt: string,
  snapshotsOlderThanMs: number | undefined,
): { daysRemaining: number; expiresAt: Date; nearCutoff: boolean } | null {
  if (!snapshotsOlderThanMs || !isFinite(snapshotsOlderThanMs)) return null;
  const created = new Date(createdAt).getTime();
  if (!isFinite(created)) return null;
  const expiresAt = new Date(created + snapshotsOlderThanMs);
  const msRemaining = expiresAt.getTime() - Date.now();
  const daysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));
  return {
    daysRemaining,
    expiresAt,
    nearCutoff: daysRemaining <= 30,
  };
}

function RetentionCountdownBadge({
  createdAt,
  snapshotsOlderThanMs,
  testId,
}: {
  createdAt: string;
  snapshotsOlderThanMs: number | undefined;
  testId?: string;
}) {
  const c = computeRetentionCountdown(createdAt, snapshotsOlderThanMs);
  if (!c) return <span className="text-muted-foreground">—</span>;
  const label =
    c.daysRemaining <= 0
      ? "expired"
      : c.daysRemaining === 1
        ? "expires in 1 day"
        : `expires in ${c.daysRemaining} days`;
  return (
    <Badge
      variant={c.nearCutoff ? "destructive" : "outline"}
      className="font-sans text-[10px] uppercase tracking-wide"
      data-testid={testId}
      title={`Auto-pruned on or after ${c.expiresAt.toLocaleString()}`}
    >
      {label}
    </Badge>
  );
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
          {data?.retention && (
            <span
              className="ml-2 text-xs text-muted-foreground"
              data-testid="text-funnel-retention"
            >
              Retention:{" "}
              {Math.round(
                data.retention.snapshotsOlderThanMs / (24 * 60 * 60 * 1000),
              )}
              d snapshots ·{" "}
              {Math.round(
                data.retention.failuresOlderThanMs / (24 * 60 * 60 * 1000),
              )}
              d failures (auto-pruned daily).
            </span>
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
                <TableHead>Retention</TableHead>
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
                  <TableCell className="font-mono">
                    <span>#{s.cycleGeneration}</span>
                    {s.source === "backfill" && (
                      <Badge
                        variant="outline"
                        className="ml-2 font-sans text-[10px] uppercase tracking-wide"
                        data-testid={`badge-backfilled-${s.cycleGeneration}`}
                        title="Reconstructed post-hoc from persisted opportunities; stages 1–5 are zeroed and excluded from delta-detection baselines."
                      >
                        backfilled
                      </Badge>
                    )}
                  </TableCell>
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
                    <RetentionCountdownBadge
                      createdAt={s.createdAt}
                      snapshotsOlderThanMs={data.retention?.snapshotsOlderThanMs}
                      testId={`badge-retention-${s.cycleGeneration}`}
                    />
                  </TableCell>
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
  // Reuse the cached snapshot list query so this panel can surface the
  // same retention countdown without a duplicate fetch (task #200). The
  // detail endpoint doesn't return retention config, but the list one
  // does and is already hydrated when this panel opens. `enabled: false`
  // ensures we strictly read whatever the parent SnapshotsTab placed in
  // the cache instead of triggering our own refetch.
  const { data: listData } = useQuery({
    queryKey: ["funnel", "snapshots"],
    queryFn: () =>
      fetchJson<SnapshotListResp>("/api/admin/funnel/snapshots?limit=50"),
    enabled: false,
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
            <span className="ml-2 inline-flex items-center align-middle">
              <RetentionCountdownBadge
                createdAt={snapshot.createdAt}
                snapshotsOlderThanMs={
                  listData?.retention?.snapshotsOlderThanMs
                }
                testId={`badge-retention-detail-${snapshot.cycleGeneration}`}
              />
            </span>
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
          <CardTitle>Prior calibration (per-lever rollup)</CardTitle>
          <CardDescription>
            Median absolute error of (projected − realized) USD per lever &amp;
            window. Verdict gates on n ≥ 10 and a $100 swing. Per task
            #218 the per-(lever, category) breakdown lives in the tier
            matrix card below — this row is the across-categories rollup.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(() => {
            // Filter to the `_all` rollup so this table preserves its
            // historical per-lever surface even though calibration now
            // also stores per-(lever, category) buckets. Older snapshots
            // (pre-#218) omit `categoryCode` entirely; treat those as
            // rollup rows so legacy data still renders.
            const rollupRows = Object.values(snapshot.calibration).filter(
              (c) => !c.categoryCode || c.categoryCode === "_all",
            );
            if (rollupRows.length === 0) {
              return (
                <div className="text-sm text-muted-foreground">
                  Insufficient realized history — no calibration verdict
                  yet.
                </div>
              );
            }
            return (
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
                  {rollupRows.map((c) => (
                    <TableRow key={`${c.leverId}:${c.window}`}>
                      <TableCell className="font-mono text-xs">
                        {c.leverId}
                      </TableCell>
                      <TableCell>{c.window}</TableCell>
                      <TableCell>{c.n}</TableCell>
                      <TableCell>{fmtUsd(c.rawMedianAbsErrorUsd)}</TableCell>
                      <TableCell>
                        {fmtUsd(c.rescaledMedianAbsErrorUsd)}
                      </TableCell>
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
            );
          })()}
        </CardContent>
      </Card>

      <TierMatrixCard />

      <TierAutoApplyCard />

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

// ───────────────────────── Tier matrix (task #218) ──────────────────

interface TierMatrixCell {
  leverId: string;
  categoryCode: string;
  n: number;
  improvementUsd: number | null;
  rawMedianAbsErrorUsd: number | null;
  rescaledMedianAbsErrorUsd: number | null;
  verdict: string;
  tier: "tier_a" | "tier_b" | "tier_c_or_d" | "insufficient_data";
}

interface TierMatrixDriver extends TierMatrixCell {
  sampleSharePct: number | null;
  disagreesWithRollup: boolean;
}

interface TierMatrixRollup extends TierMatrixCell {
  drivers?: TierMatrixDriver[];
}

interface TierMatrixResp {
  snapshot: {
    id: string;
    cycleGeneration: number;
    createdAt: string;
  } | null;
  window: "30d" | "90d";
  levers: string[];
  categories: string[];
  cells: TierMatrixCell[];
  rollups: TierMatrixRollup[];
}

function tierBadgeVariant(
  tier: TierMatrixCell["tier"],
): "default" | "destructive" | "secondary" | "outline" {
  switch (tier) {
    case "tier_a":
      return "default";
    case "tier_c_or_d":
      return "destructive";
    case "tier_b":
      return "secondary";
    case "insufficient_data":
    default:
      return "outline";
  }
}

function tierLabel(tier: TierMatrixCell["tier"]): string {
  switch (tier) {
    case "tier_a":
      return "Tier A";
    case "tier_b":
      return "Tier B";
    case "tier_c_or_d":
      return "Tier C/D";
    case "insufficient_data":
    default:
      return "n<10";
  }
}

function TierMatrixCard() {
  const [window, setWindow] = useState<"30d" | "90d">("90d");
  const [openRollup, setOpenRollup] = useState<TierMatrixRollup | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["funnel", "tier-matrix", window],
    queryFn: () =>
      fetchJson<TierMatrixResp>(
        `/api/admin/funnel/tier-matrix?window=${window}`,
      ),
  });

  const cellMap = new Map<string, TierMatrixCell>();
  if (data) {
    for (const c of data.cells) {
      cellMap.set(`${c.leverId}\u0000${c.categoryCode}`, c);
    }
  }

  return (
    <Card data-testid="card-tier-matrix">
      <CardHeader>
        <CardTitle>Per-(category, lever) tier matrix</CardTitle>
        <CardDescription>
          Tenant-specific tier suggestions derived from the latest
          snapshot's calibration block (task #218). Tier A: priors
          help &gt;$100 in the buyer's favor. Tier B: priors neutral
          (±$100). Tier C/D: priors hurt &gt;$100. Cells with n &lt; 10
          render greyed out — gating identical to the per-lever
          verdict.
          <span className="ml-2">
            <Select
              value={window}
              onValueChange={(v) => setWindow(v as "30d" | "90d")}
            >
              <SelectTrigger
                className="inline-flex h-7 w-[110px]"
                data-testid="select-tier-matrix-window"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30d">30d window</SelectItem>
                <SelectItem value="90d">90d window</SelectItem>
              </SelectContent>
            </Select>
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <div>Loading…</div>}
        {data && !data.snapshot && (
          <div className="text-sm text-muted-foreground">
            No snapshot yet for this tenant — tier suggestions will
            appear once an analysis cycle has produced calibration data.
          </div>
        )}
        {data &&
          data.snapshot &&
          data.cells.length === 0 &&
          data.rollups.length === 0 && (
            <div className="text-sm text-muted-foreground">
              Latest snapshot's calibration block contains no entries
              for the {data.window} window.
            </div>
          )}
        {data &&
          data.snapshot &&
          (data.cells.length > 0 || data.rollups.length > 0) && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-medium">
                    Lever ↓ / Category →
                  </TableHead>
                  <TableHead className="text-xs italic">_all rollup</TableHead>
                  {data.categories.map((cat) => (
                    <TableHead key={cat} className="font-mono text-xs">
                      {cat}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.levers.map((leverId) => {
                  const rollup = data.rollups.find(
                    (r) => r.leverId === leverId,
                  );
                  const hasDisagreement =
                    rollup?.drivers?.some((d) => d.disagreesWithRollup) ??
                    false;
                  return (
                    <TableRow
                      key={leverId}
                      data-testid={`row-tier-matrix-${leverId}`}
                    >
                      <TableCell className="font-mono text-xs font-medium">
                        {leverId}
                      </TableCell>
                      <TableCell>
                        {rollup ? (
                          <button
                            type="button"
                            className="text-left hover-elevate active-elevate-2 rounded p-1 -m-1"
                            onClick={() => setOpenRollup(rollup)}
                            data-testid={`button-rollup-drivers-${leverId}`}
                            title="View per-category drivers"
                          >
                            <TierCell cell={rollup} />
                            {hasDisagreement && (
                              <div
                                className="mt-0.5 text-[10px] font-medium text-amber-600"
                                data-testid={`indicator-disagreement-${leverId}`}
                              >
                                ⚠ driver disagrees
                              </div>
                            )}
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      {data.categories.map((cat) => {
                        const cell = cellMap.get(`${leverId}\u0000${cat}`);
                        return (
                          <TableCell key={cat}>
                            {cell ? (
                              <TierCell cell={cell} />
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                —
                              </span>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
      </CardContent>
      <TierDriverDialog
        rollup={openRollup}
        onClose={() => setOpenRollup(null)}
      />
    </Card>
  );
}

function TierDriverDialog({
  rollup,
  onClose,
}: {
  rollup: TierMatrixRollup | null;
  onClose: () => void;
}) {
  const drivers = rollup?.drivers ?? [];
  return (
    <Dialog open={rollup != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-2xl"
        data-testid="dialog-tier-drivers"
      >
        <DialogHeader>
          <DialogTitle>
            Drivers for{" "}
            <span className="font-mono text-sm">{rollup?.leverId}</span>{" "}
            <Badge
              variant={
                rollup ? tierBadgeVariant(rollup.tier) : "outline"
              }
              className="ml-1"
            >
              {rollup ? tierLabel(rollup.tier) : ""}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            Top {drivers.length} categories by sample count contributing
            to the <span className="font-mono">_all</span> rollup
            (n={rollup?.n ?? 0}, verdict {rollup?.verdict ?? "—"}).
            Categories whose decisive verdict disagrees with the rollup
            are flagged so you can act on the outlier instead of the
            aggregate.
          </DialogDescription>
        </DialogHeader>
        {drivers.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No per-category cells fed this rollup — all samples for this
            lever lack a resolved category.
          </div>
        ) : (
          <Table data-testid="table-tier-drivers">
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">n</TableHead>
                <TableHead className="text-right">Sample share</TableHead>
                <TableHead className="text-right">Δ improvement</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Verdict</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drivers.map((d) => (
                <TableRow
                  key={d.categoryCode}
                  data-testid={`row-driver-${d.categoryCode}`}
                  className={
                    d.disagreesWithRollup
                      ? "bg-amber-50 dark:bg-amber-950/30"
                      : undefined
                  }
                >
                  <TableCell className="font-mono text-xs">
                    {d.categoryCode}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.n}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.sampleSharePct != null
                      ? `${d.sampleSharePct.toFixed(1)}%`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.improvementUsd != null
                      ? fmtUsd(d.improvementUsd)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={tierBadgeVariant(d.tier)}>
                      {tierLabel(d.tier)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {d.verdict}
                    {d.disagreesWithRollup && (
                      <span
                        className="ml-1 font-medium text-amber-600"
                        data-testid={`indicator-driver-disagrees-${d.categoryCode}`}
                        title={`Disagrees with rollup verdict (${rollup?.verdict})`}
                      >
                        ⚠
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            data-testid="button-close-tier-drivers"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TierAutoApplyResp {
  mode: "advisory" | "auto";
  defaultMode: "advisory" | "auto";
  isOverride: boolean;
  lastChangedAt: string | null;
  lastChangedBy: string | null;
}

function TierAutoApplyCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["funnel", "tier-auto-apply"],
    queryFn: () =>
      fetchJson<TierAutoApplyResp>("/api/admin/funnel/tier-auto-apply"),
  });
  const setMode = useMutation({
    mutationFn: (mode: "advisory" | "auto") =>
      fetchJson<TierAutoApplyResp>("/api/admin/funnel/tier-auto-apply", {
        method: "PUT",
        body: JSON.stringify({ mode }),
      }),
    onSuccess: (next) => {
      qc.setQueryData(["funnel", "tier-auto-apply"], next);
      toast({
        title:
          next.mode === "auto"
            ? "Tier auto-apply enabled"
            : "Tier auto-apply set to advisory",
      });
    },
    onError: (err: unknown) => {
      toast({
        title: "Failed to update tier auto-apply",
        description: (err as Error).message,
        variant: "destructive",
      });
    },
  });
  return (
    <Card data-testid="card-tier-auto-apply">
      <CardHeader>
        <CardTitle>Tier auto-apply</CardTitle>
        <CardDescription>
          Auto-update per-(category, lever) prior strengths from the
          tier matrix. <strong>Advisory</strong> only surfaces tier
          suggestions in the matrix above. <strong>Auto</strong> lets
          the OODA cycle suppress priors for Tier C/D cells (and
          re-enable them when a category climbs back to Tier A/B),
          with a 2-cycle hysteresis so a single bad cycle can't flip
          a stable bucket.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <div>Loading…</div>}
        {data && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Badge
                variant={data.mode === "auto" ? "default" : "secondary"}
                data-testid="badge-tier-auto-apply-mode"
              >
                {data.mode === "auto" ? "Auto" : "Advisory"}
              </Badge>
              <Button
                size="sm"
                variant={data.mode === "auto" ? "outline" : "default"}
                onClick={() =>
                  setMode.mutate(data.mode === "auto" ? "advisory" : "auto")
                }
                disabled={setMode.isPending}
                data-testid={
                  data.mode === "auto"
                    ? "button-tier-auto-apply-disable"
                    : "button-tier-auto-apply-enable"
                }
              >
                {data.mode === "auto"
                  ? "Switch to advisory"
                  : "Enable auto-apply"}
              </Button>
              {!data.isOverride && (
                <span className="text-xs text-muted-foreground">
                  default ({data.defaultMode})
                </span>
              )}
            </div>
            {data.lastChangedBy && (
              <div className="text-xs text-muted-foreground">
                Last changed by{" "}
                <span className="font-mono">{data.lastChangedBy}</span>
                {data.lastChangedAt && <> at {fmtTime(data.lastChangedAt)}</>}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TierCell({ cell }: { cell: TierMatrixCell }) {
  const greyed = cell.tier === "insufficient_data";
  return (
    <div
      className={greyed ? "opacity-50" : undefined}
      data-testid={`cell-tier-${cell.leverId}-${cell.categoryCode}`}
    >
      <Badge variant={tierBadgeVariant(cell.tier)}>{tierLabel(cell.tier)}</Badge>
      <div className="mt-1 text-[10px] text-muted-foreground">
        n={cell.n}
        {cell.improvementUsd != null && (
          <> · Δ{fmtUsd(cell.improvementUsd)}</>
        )}
      </div>
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
          <TabsTrigger value="routing" data-testid="tab-routing">
            Routing
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
        <TabsContent value="routing" className="space-y-4">
          <MappingDataHealthCard />
          <RoutingQueueTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ───────────────────────── Routing tab (task #213) ────────────────────

interface MappingDataHealthResp {
  // Spec-required top-level fields (task #213).
  unmappedQueueDepth: number;
  oldestUnmappedAgeDays: number;
  unmappedSpendPct: number;
  queue: {
    openCount: number;
    oldestOpenAt: string | null;
    unmappedSpendUsd: number;
  };
  opportunities: {
    total: number;
    byMappedVia: Record<string, number>;
    unmappedDefaultPct: number;
    mappedSpendUsd: number;
  };
  materializedView: {
    ok: boolean;
    expectedRowCount: number;
    viewRowCount: number;
    drift: number;
    recoveredByRefresh: boolean;
    checkedAt: string;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
    driftSamples: Array<{
      side: "expected_only" | "view_only";
      categoryCode: string;
      leverId: string;
      band: string;
    }>;
  };
}

function MappingDataHealthCard() {
  const { data, isLoading } = useQuery({
    queryKey: ["routing", "mapping-data-health"],
    queryFn: () =>
      fetchJson<MappingDataHealthResp>(
        "/api/admin/funnel/mapping-data-health",
      ),
    refetchInterval: 30_000,
  });
  if (isLoading || !data) {
    return (
      <Card data-testid="card-mapping-data-health">
        <CardHeader>
          <CardTitle>Mapping data health</CardTitle>
        </CardHeader>
        <CardContent>Loading…</CardContent>
      </Card>
    );
  }
  const oldestAgeRounded = Math.round(data.oldestUnmappedAgeDays);
  return (
    <Card data-testid="card-mapping-data-health">
      <CardHeader>
        <CardTitle>Mapping data health</CardTitle>
        <CardDescription>
          Routing queue depth, oldest open age, and share of trailing-90d
          spend that is still unmapped.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground">Unmapped queue depth</div>
            <div
              className="text-2xl font-semibold"
              data-testid="stat-queue-depth"
            >
              {data.unmappedQueueDepth}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">
              Oldest unmapped age
            </div>
            <div
              className="text-2xl font-semibold"
              data-testid="stat-queue-oldest"
            >
              {data.unmappedQueueDepth > 0 ? `${oldestAgeRounded}d` : "—"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">
              Unmapped spend share (90d)
            </div>
            <div
              className="text-2xl font-semibold"
              data-testid="stat-queue-spend"
            >
              {(data.unmappedSpendPct * 100).toFixed(1)}%
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">
              `unmapped_default` opps
            </div>
            <div
              className="text-2xl font-semibold"
              data-testid="stat-unmapped-pct"
            >
              {(data.opportunities.unmappedDefaultPct * 100).toFixed(1)}%
            </div>
          </div>
        </div>
        <div className="mt-4 space-y-2 text-xs text-muted-foreground">
          <div>
            Materialized view:{" "}
            <Badge
              variant={data.materializedView.ok ? "default" : "destructive"}
              data-testid="badge-view-health"
            >
              {data.materializedView.ok
                ? data.materializedView.recoveredByRefresh
                  ? "recovered"
                  : "ok"
                : "drift"}
            </Badge>{" "}
            ({data.materializedView.viewRowCount}/
            {data.materializedView.expectedRowCount} rows)
            {data.materializedView.consecutiveFailures > 0 && (
              <span data-testid="stat-consecutive-failures">
                {" · "}
                {data.materializedView.consecutiveFailures} consecutive failures
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4">
            <span data-testid="stat-last-success">
              Last success:{" "}
              {data.materializedView.lastSuccessAt
                ? fmtTime(data.materializedView.lastSuccessAt)
                : "—"}
            </span>
            <span data-testid="stat-last-failure">
              Last failure:{" "}
              {data.materializedView.lastFailureAt
                ? fmtTime(data.materializedView.lastFailureAt)
                : "—"}
            </span>
          </div>
          {data.materializedView.driftSamples.length > 0 && (
            <details data-testid="details-drift-samples">
              <summary className="cursor-pointer">
                Drift samples ({data.materializedView.driftSamples.length})
              </summary>
              <ul className="mt-1 space-y-0.5 font-mono">
                {data.materializedView.driftSamples
                  .slice(0, 25)
                  .map((s, idx) => (
                    <li key={`${s.side}-${s.categoryCode}-${s.leverId}-${idx}`}>
                      <span
                        className={
                          s.side === "expected_only"
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-rose-700 dark:text-rose-400"
                        }
                      >
                        [{s.side}]
                      </span>{" "}
                      {s.categoryCode} → {s.leverId} ({s.band})
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

type SuggestionReason =
  | "tenant_synonym"
  | "global_synonym"
  | "cross_tenant_synonym"
  | "canonical_code_match";

interface RoutingSuggestion {
  canonicalCode: string;
  /** 0..1 trigram similarity (with optional cross-tenant boost). */
  confidence: number;
  reason: SuggestionReason;
}

interface QueueEntry {
  id: string;
  orgId: string;
  tenantString: string;
  normalized: string;
  spendTrailing90dUsd: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * Layer D: top-3 suggested canonical codes for this tenant string,
   * ranked at request time by trigram similarity against existing
   * synonyms (own tenant, other tenants, global) plus the canonical
   * code spelling. Empty when nothing crossed the similarity floor;
   * absent on legacy responses (treat as empty).
   */
  suggestions?: RoutingSuggestion[];
}
interface QueueResp { entries: QueueEntry[]; }
interface CanonicalCodesResp { codes: string[]; }

type ResolveDecision =
  | "accept_existing"
  | "force_override"
  | "escalate_to_global"
  | "narrow_to_tenant";

interface CollisionState {
  queueId: string;
  tenantString: string;
  requested: { canonicalCode: string; scope: "global" | "tenant_scoped" };
  existing: {
    registryId: string;
    canonicalCode: string;
    scope: "global" | "tenant_scoped";
    orgId: string | null;
  };
}

export function RoutingQueueTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const queue = useQuery({
    queryKey: ["routing", "queue"],
    queryFn: () => fetchJson<QueueResp>("/api/admin/routing/queue?limit=200"),
  });
  const codes = useQuery({
    queryKey: ["routing", "canonical-codes"],
    queryFn: () =>
      fetchJson<CanonicalCodesResp>("/api/admin/routing/canonical-codes"),
  });
  const [picks, setPicks] = useState<
    Record<string, { code: string; scope: "global" | "tenant_scoped" }>
  >({});
  const [collision, setCollision] = useState<CollisionState | null>(null);

  // Single mutation handles both first-attempt and decision-followup
  // calls; the difference is whether `decision` is set in the body.
  const resolveMut = useMutation({
    mutationFn: async (args: {
      id: string;
      canonicalCode: string;
      scope: "global" | "tenant_scoped";
      decision?: ResolveDecision;
      tenantString: string;
    }) => {
      const res = await fetch(`/api/admin/routing/queue/${args.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonicalCode: args.canonicalCode,
          scope: args.scope,
          ...(args.decision ? { decision: args.decision } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        return {
          collision: true as const,
          body,
          requestedArgs: args,
        };
      }
      if (!res.ok) {
        throw new Error(body?.error ?? `${res.status}`);
      }
      return { collision: false as const, body };
    },
    onSuccess: (result) => {
      if (result.collision) {
        // Surface the collision modal so the operator can pick a
        // resolution path. The follow-up call repeats the resolve
        // request with `decision` set.
        setCollision({
          queueId: result.requestedArgs.id,
          tenantString: result.requestedArgs.tenantString,
          requested: {
            canonicalCode: result.requestedArgs.canonicalCode,
            scope: result.requestedArgs.scope,
          },
          existing: result.body.existing,
        });
        return;
      }
      setCollision(null);
      toast({
        title: "Mapped",
        description: `Audit-flagged ${result.body?.reCategorizedOpportunityCount ?? 0} historical opportunities.`,
      });
      void qc.invalidateQueries({ queryKey: ["routing"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Resolve failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  function decideCollision(decision: ResolveDecision) {
    if (!collision) return;
    resolveMut.mutate({
      id: collision.queueId,
      canonicalCode: collision.requested.canonicalCode,
      scope: collision.requested.scope,
      decision,
      tenantString: collision.tenantString,
    });
  }

  if (queue.isLoading || codes.isLoading) return <div>Loading…</div>;

  return (
    <Card data-testid="card-routing-queue">
      <CardHeader>
        <CardTitle>Unmapped categories</CardTitle>
        <CardDescription>
          Tenant-supplied category strings that didn't match any synonym.
          Mapping a string adds a synonym registry row going forward; existing
          opportunities are not rewritten — they're audit-flagged for
          traceability.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tenant string</TableHead>
              <TableHead>Suggestions</TableHead>
              <TableHead>90d spend</TableHead>
              <TableHead>First seen</TableHead>
              <TableHead>Map to</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(queue.data?.entries ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  Queue is empty.
                </TableCell>
              </TableRow>
            )}
            {(queue.data?.entries ?? []).map((e) => {
              const pick = picks[e.id] ?? { code: "", scope: "global" as const };
              return (
                <TableRow key={e.id} data-testid={`row-queue-${e.id}`}>
                  <TableCell className="font-mono text-xs">
                    {e.tenantString}
                  </TableCell>
                  <TableCell>
                    <SuggestionsCell
                      suggestions={e.suggestions ?? []}
                      onAccept={(s) =>
                        resolveMut.mutate({
                          id: e.id,
                          canonicalCode: s.canonicalCode,
                          scope: pick.scope,
                          tenantString: e.tenantString,
                        })
                      }
                      isPending={resolveMut.isPending}
                      queueId={e.id}
                    />
                  </TableCell>
                  <TableCell>{fmtUsd(e.spendTrailing90dUsd)}</TableCell>
                  <TableCell>{fmtTime(e.firstSeenAt)}</TableCell>
                  <TableCell>
                    <Select
                      value={pick.code}
                      onValueChange={(v) =>
                        setPicks((p) => ({
                          ...p,
                          [e.id]: { ...pick, code: v },
                        }))
                      }
                    >
                      <SelectTrigger
                        className="w-56"
                        data-testid={`select-code-${e.id}`}
                      >
                        <SelectValue placeholder="Pick canonical code" />
                      </SelectTrigger>
                      <SelectContent>
                        {(codes.data?.codes ?? []).map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={pick.scope}
                      onValueChange={(v) =>
                        setPicks((p) => ({
                          ...p,
                          [e.id]: {
                            ...pick,
                            scope: v as "global" | "tenant_scoped",
                          },
                        }))
                      }
                    >
                      <SelectTrigger
                        className="w-36"
                        data-testid={`select-scope-${e.id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="global">global</SelectItem>
                        <SelectItem value="tenant_scoped">
                          tenant-scoped
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      disabled={!pick.code || resolveMut.isPending}
                      onClick={() =>
                        resolveMut.mutate({
                          id: e.id,
                          canonicalCode: pick.code,
                          scope: pick.scope,
                          tenantString: e.tenantString,
                        })
                      }
                      data-testid={`btn-resolve-${e.id}`}
                    >
                      Map
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
      <CollisionDialog
        state={collision}
        onClose={() => setCollision(null)}
        onDecide={decideCollision}
        isPending={resolveMut.isPending}
      />
    </Card>
  );
}

/**
 * Inline display of Layer-D suggestions for one queue entry.
 *
 * Renders up to three pills, each labeled with the canonical code,
 * a confidence percentage, and the source-of-evidence reason. Clicking
 * a pill kicks off the same `resolveMut` flow the manual dropdown
 * uses — including the same collision-detection round trip — so the
 * server-side write path is identical regardless of how the operator
 * picked the code.
 */
function SuggestionsCell(props: {
  suggestions: RoutingSuggestion[];
  onAccept: (s: RoutingSuggestion) => void;
  isPending: boolean;
  queueId: string;
}) {
  const { suggestions, onAccept, isPending, queueId } = props;
  if (suggestions.length === 0) {
    return (
      <span
        className="text-xs text-muted-foreground"
        data-testid={`suggestions-empty-${queueId}`}
      >
        —
      </span>
    );
  }
  // Map each evidence reason to a short, low-noise label so operators
  // can tell a strong cross-tenant operator-vouched match apart from a
  // weak code-spelling guess at a glance.
  const reasonLabel: Record<SuggestionReason, string> = {
    tenant_synonym: "your tenant",
    cross_tenant_synonym: "other tenants",
    global_synonym: "global",
    canonical_code_match: "code spelling",
  };
  return (
    <div
      className="flex flex-wrap gap-1"
      data-testid={`suggestions-${queueId}`}
    >
      {suggestions.map((s) => {
        const pct = Math.round(s.confidence * 100);
        const variant: "default" | "secondary" | "outline" =
          pct >= 75 ? "default" : pct >= 50 ? "secondary" : "outline";
        return (
          <Button
            key={`${s.canonicalCode}:${s.reason}`}
            size="sm"
            variant="outline"
            className="h-auto px-2 py-1 text-xs"
            disabled={isPending}
            onClick={() => onAccept(s)}
            data-testid={`btn-suggestion-${queueId}-${s.canonicalCode}`}
            title={`${pct}% similarity via ${reasonLabel[s.reason]}`}
          >
            <span className="font-mono">{s.canonicalCode}</span>
            <Badge
              variant={variant}
              className="ml-1.5 px-1 py-0 text-[10px] font-sans"
            >
              {pct}%
            </Badge>
            <span className="ml-1 text-muted-foreground">
              · {reasonLabel[s.reason]}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

function CollisionDialog(props: {
  state: CollisionState | null;
  onClose: () => void;
  onDecide: (decision: ResolveDecision) => void;
  isPending: boolean;
}) {
  const { state, onClose, onDecide, isPending } = props;
  if (!state) return null;
  const { existing, requested, tenantString } = state;
  // Branch the available actions on the relationship between the
  // requested scope and the existing scope. Cross-scope decisions
  // (escalate / narrow) are only legal in their respective directions.
  const showEscalate = requested.scope === "tenant_scoped";
  const showNarrow = requested.scope === "global";
  return (
    <Dialog
      open={Boolean(state)}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        className="max-w-lg"
        data-testid="dialog-routing-collision"
      >
        <DialogHeader>
          <DialogTitle>Synonym already exists</DialogTitle>
          <DialogDescription>
            “{tenantString}” already maps at the {existing.scope} scope to{" "}
            <span className="font-mono">{existing.canonicalCode}</span>. Pick
            how you want to resolve this conflict — the registry is
            append-only, so no history is lost.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2 text-sm">
          <div>
            <span className="text-muted-foreground">You requested:</span>{" "}
            <span className="font-mono">{requested.canonicalCode}</span> at{" "}
            <span className="font-mono">{requested.scope}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Currently mapped:</span>{" "}
            <span className="font-mono">{existing.canonicalCode}</span> at{" "}
            <span className="font-mono">{existing.scope}</span>
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
          <Button
            variant="outline"
            onClick={() => onDecide("accept_existing")}
            disabled={isPending}
            data-testid="btn-collision-accept-existing"
          >
            Accept existing mapping ({existing.canonicalCode})
          </Button>
          <Button
            variant="destructive"
            onClick={() => onDecide("force_override")}
            disabled={isPending}
            data-testid="btn-collision-force-override"
          >
            Override at the same scope
          </Button>
          {showEscalate && (
            <Button
              variant="secondary"
              onClick={() => onDecide("escalate_to_global")}
              disabled={isPending}
              data-testid="btn-collision-escalate-global"
            >
              Add as global mapping (keep tenant row)
            </Button>
          )}
          {showNarrow && (
            <Button
              variant="secondary"
              onClick={() => onDecide("narrow_to_tenant")}
              disabled={isPending}
              data-testid="btn-collision-narrow-tenant"
            >
              Add as tenant-scoped mapping (keep global row)
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={isPending}
            data-testid="btn-collision-cancel"
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
