import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListErpAdapters,
  useListErpConnections,
  useCreateErpConnection,
  useDeleteErpConnection,
  useUpdateErpConnection,
  useSyncErpConnection,
  useTestErpConnection,
  useListErpConnectionRuns,
  getListErpConnectionsQueryKey,
  getListErpConnectionRunsQueryKey,
  type ErpConnection,
  type ErpAdapterDescriptor,
  type ErpConnectionRun,
} from "@workspace/api-client-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { TruncatedError } from "@/components/truncated-error";
import {
  Plug,
  Plus,
  Play,
  Pause,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  ShieldCheck,
  KeyRound,
  ChevronDown,
  ChevronRight,
  History,
} from "lucide-react";

function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/**
 * Cadence presets surfaced in the per-connection dropdown. Values are
 * minutes and must stay inside the route's [5, 10080] guard rail. The
 * defaults span "tight" (15 min) through "weekly catch-up" (24 h) —
 * common operator choices for ERP→data-platform sync feeds — and
 * default to 2 hours to match the schema-level default.
 */
const SYNC_INTERVAL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 15, label: "Every 15 min" },
  { value: 30, label: "Every 30 min" },
  { value: 60, label: "Every 1 hour" },
  { value: 120, label: "Every 2 hours" },
  { value: 360, label: "Every 6 hours" },
  { value: 720, label: "Every 12 hours" },
  { value: 1440, label: "Every 24 hours" },
];

function describeInterval(minutes: number): string {
  const match = SYNC_INTERVAL_OPTIONS.find((o) => o.value === minutes);
  if (match) return match.label;
  if (minutes < 60) return `Every ${minutes} min`;
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} min`;
}

function statusVariant(
  status: ErpConnection["status"],
): "default" | "destructive" | "secondary" {
  if (status === "active") return "default";
  if (status === "error") return "destructive";
  return "secondary";
}

function runStatusVariant(
  status: ErpConnectionRun["status"],
): "default" | "destructive" | "secondary" {
  if (status === "succeeded") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

/**
 * Renders a duration as a compact human-readable string. Most ERP syncs
 * complete in seconds-to-minutes, so we drop the millisecond precision
 * (irrelevant for ops triage) and switch to minutes once we cross 60 s.
 */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * Shapes the per-entity counts map into a stable display order. Coupa's
 * five canonical entities are surfaced first; any extras (a future
 * adapter or a renamed entity) trail in alphabetical order so the row
 * stays predictable for screenshot-style ops sharing.
 */
const ENTITY_DISPLAY_ORDER: readonly string[] = [
  "suppliers",
  "contracts",
  "purchase_orders",
  "invoices",
  "payments",
];

function orderedEntities(
  records: Record<string, number>,
  dropped: Record<string, number>,
): string[] {
  const all = new Set<string>([
    ...Object.keys(records ?? {}),
    ...Object.keys(dropped ?? {}),
  ]);
  const ordered: string[] = [];
  for (const k of ENTITY_DISPLAY_ORDER) {
    if (all.delete(k)) ordered.push(k);
  }
  ordered.push(...Array.from(all).sort());
  return ordered;
}

interface RunsPanelProps {
  connectionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function RunsPanel({
  connectionId,
  open,
  onOpenChange,
}: RunsPanelProps) {
  // Only fetch when the panel is open. The route is fast (10-row
  // ORDER BY query, indexed) but there's no value in pinging it for
  // collapsed rows.
  const runsParams = { limit: 10 } as const;
  const runsQuery = useListErpConnectionRuns(connectionId, runsParams, {
    query: {
      queryKey: getListErpConnectionRunsQueryKey(connectionId, runsParams),
      enabled: open,
    },
  });
  const runs = runsQuery.data?.runs ?? [];

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="mt-3">
      <CollapsibleTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          data-testid={`btn-toggle-runs-${connectionId}`}
        >
          {open ? (
            <ChevronDown className="w-3 h-3 mr-1" />
          ) : (
            <ChevronRight className="w-3 h-3 mr-1" />
          )}
          <History className="w-3 h-3 mr-1" />
          Recent runs
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className="mt-2"
        data-testid={`runs-panel-${connectionId}`}
      >
        {runsQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading run history…</p>
        ) : runsQuery.isError ? (
          <Alert variant="destructive">
            <AlertTitle className="text-xs">
              Could not load run history
            </AlertTitle>
            <AlertDescription>
              <TruncatedError
                message={runsQuery.error?.message ?? "Unknown error"}
              />
            </AlertDescription>
          </Alert>
        ) : runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No runs yet. Trigger a sync to populate this history.
          </p>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => {
              const entities = orderedEntities(
                run.recordsByEntity,
                run.droppedByEntity,
              );
              const totalDropped = Object.values(
                run.droppedByEntity ?? {},
              ).reduce((a, b) => a + (b ?? 0), 0);
              return (
                <div
                  key={run.id}
                  className="rounded border bg-muted/30 p-3 space-y-1.5"
                  data-testid={`run-row-${run.id}`}
                >
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <Badge variant={runStatusVariant(run.status)}>
                      {run.status}
                    </Badge>
                    <span className="text-muted-foreground">
                      {fmtTime(run.startedAt)}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">
                      {fmtDuration(run.durationMs)}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">
                      {run.recordsProcessed.toLocaleString()} rows
                    </span>
                    {totalDropped > 0 ? (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-destructive">
                          {totalDropped.toLocaleString()} dropped
                        </span>
                      </>
                    ) : null}
                  </div>
                  {entities.length > 0 ? (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground font-mono">
                      {entities.map((entity) => {
                        const ingested = run.recordsByEntity?.[entity] ?? 0;
                        const dropped = run.droppedByEntity?.[entity] ?? 0;
                        return (
                          <span
                            key={entity}
                            data-testid={`run-entity-${run.id}-${entity}`}
                          >
                            {entity}: {ingested.toLocaleString()}
                            {dropped > 0 ? (
                              <span className="text-destructive">
                                {" "}
                                (−{dropped.toLocaleString()})
                              </span>
                            ) : null}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  {run.error ? (
                    <div className="text-[11px] text-destructive break-words">
                      <TruncatedError message={run.error} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

interface NewConnectionForm {
  label: string;
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  pageSize: string;
}

const EMPTY_FORM: NewConnectionForm = {
  label: "",
  instanceUrl: "",
  clientId: "",
  clientSecret: "",
  pageSize: "200",
};

export default function Integrations() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [adminToken, setAdminToken] = useState<string>(
    () => localStorage.getItem("orgAdminToken") ?? "",
  );

  const adaptersQuery = useListErpAdapters();
  const connectionsQuery = useListErpConnections();

  const createMut = useCreateErpConnection();
  const deleteMut = useDeleteErpConnection();
  const updateMut = useUpdateErpConnection();
  const syncMut = useSyncErpConnection();
  const testMut = useTestErpConnection();

  const [form, setForm] = useState<NewConnectionForm>(EMPTY_FORM);
  const [showAdd, setShowAdd] = useState(false);
  const [testResult, setTestResult] = useState<
    | { ok: true }
    | { ok: false; error: string }
    | null
  >(null);
  // Track which per-connection runs panels are expanded. Keeping this in
  // a Set (rather than per-row local state) lets the parent invalidate
  // queries on Sync without forcing the panel to remount.
  const [openRuns, setOpenRuns] = useState<Set<string>>(() => new Set());
  const setRunsOpen = (id: string, open: boolean): void =>
    setOpenRuns((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const adapters = adaptersQuery.data?.adapters ?? [];
  const connections = connectionsQuery.data?.connections ?? [];

  const invalidateConnections = () =>
    queryClient.invalidateQueries({
      queryKey: getListErpConnectionsQueryKey(),
    });

  function saveAdminToken(): void {
    if (adminToken) localStorage.setItem("orgAdminToken", adminToken);
    else localStorage.removeItem("orgAdminToken");
    toast({
      title: "Org Admin token saved",
      description: adminToken
        ? "Admin requests will now include this token."
        : "Admin token cleared.",
    });
    void adaptersQuery.refetch();
    void connectionsQuery.refetch();
  }

  async function onTest(): Promise<void> {
    setTestResult(null);
    try {
      const res = await testMut.mutateAsync({
        data: {
          adapterKey: "coupa",
          credentials: {
            clientId: form.clientId,
            clientSecret: form.clientSecret,
          },
          settings: {
            instanceUrl: form.instanceUrl,
            ...(form.pageSize
              ? { pageSize: Number(form.pageSize) }
              : {}),
          },
        },
      });
      setTestResult(res.ok ? { ok: true } : { ok: false, error: res.error ?? "" });
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    }
  }

  async function onCreate(): Promise<void> {
    try {
      await createMut.mutateAsync({
        data: {
          label: form.label,
          adapterKey: "coupa",
          credentials: {
            clientId: form.clientId,
            clientSecret: form.clientSecret,
          },
          settings: {
            instanceUrl: form.instanceUrl,
            ...(form.pageSize
              ? { pageSize: Number(form.pageSize) }
              : {}),
          },
        },
      });
      toast({ title: "Connection created" });
      setForm(EMPTY_FORM);
      setShowAdd(false);
      setTestResult(null);
      await invalidateConnections();
    } catch (e) {
      toast({
        title: "Could not create connection",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  }

  async function onSync(c: ErpConnection): Promise<void> {
    try {
      await syncMut.mutateAsync({ id: c.id });
      toast({
        title: "Sync queued",
        description: `Syncing ${c.label}…`,
      });
      await invalidateConnections();
      // Sync runs are produced asynchronously by the worker, so the
      // request that just queued the job won't see a new row yet.
      // Invalidate so the next refetch (manual or background) pulls
      // any history rows created by the worker.
      await queryClient.invalidateQueries({
        queryKey: getListErpConnectionRunsQueryKey(c.id),
      });
    } catch (e) {
      toast({
        title: "Could not start sync",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  }

  async function onChangeInterval(
    c: ErpConnection,
    minutes: number,
  ): Promise<void> {
    try {
      await updateMut.mutateAsync({
        id: c.id,
        data: { syncIntervalMinutes: minutes },
      });
      toast({
        title: "Sync cadence updated",
        description: `${c.label} will sync ${describeInterval(minutes).toLowerCase()}.`,
      });
      await invalidateConnections();
    } catch (e) {
      toast({
        title: "Could not update cadence",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  }

  async function onTogglePause(c: ErpConnection): Promise<void> {
    const next: ErpConnection["status"] =
      c.status === "paused" ? "active" : "paused";
    try {
      await updateMut.mutateAsync({ id: c.id, data: { status: next } });
      toast({
        title: next === "paused" ? "Connection paused" : "Connection resumed",
      });
      await invalidateConnections();
    } catch (e) {
      toast({
        title: "Could not update connection",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  }

  async function onDelete(c: ErpConnection): Promise<void> {
    if (
      !confirm(
        `Delete connection "${c.label}"? Encrypted credentials and watermarks will be removed. Historical sync data is retained.`,
      )
    ) {
      return;
    }
    try {
      await deleteMut.mutateAsync({ id: c.id });
      toast({ title: "Connection deleted" });
      await invalidateConnections();
    } catch (e) {
      toast({
        title: "Could not delete connection",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  }

  const adminQueryFailed =
    adaptersQuery.isError || connectionsQuery.isError;

  return (
    <div className="p-8 space-y-6 max-w-6xl mx-auto" data-testid="page-integrations">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Plug className="w-6 h-6" /> Integrations
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Connect source-of-truth systems (ERP, P2P) to ingest spend
            data. Credentials are encrypted at rest with AES-GCM.
            Org-Admin gated.
          </p>
        </div>
        {!showAdd ? (
          <Button onClick={() => setShowAdd(true)} data-testid="btn-add-connection">
            <Plus className="w-4 h-4 mr-2" /> Add Coupa connection
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="w-4 h-4" /> Org Admin token
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            In production, the API server requires an{" "}
            <code className="text-[11px] bg-muted px-1 rounded">
              x-org-admin-token
            </code>{" "}
            header for these routes. Paste your tenant's token here; it is
            kept in this browser only and attached to all integration
            requests.
          </p>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="paste org-admin token"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              data-testid="input-org-admin-token"
            />
            <Button
              variant="secondary"
              onClick={saveAdminToken}
              data-testid="btn-save-admin-token"
            >
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {adminQueryFailed ? (
        <Alert variant="destructive">
          <AlertTitle>Cannot load integrations</AlertTitle>
          <AlertDescription>
            <TruncatedError
              message={
                (adaptersQuery.error ?? connectionsQuery.error)?.message ??
                "Unknown error. Check your Org Admin token above."
              }
            />
          </AlertDescription>
        </Alert>
      ) : null}

      {adapters.length > 0 ? (
        <div
          className="grid gap-3 md:grid-cols-2 lg:grid-cols-3"
          data-testid="adapter-cards"
        >
          {adapters.map((adapter: ErpAdapterDescriptor) => (
            <Card key={adapter.key} data-testid={`adapter-card-${adapter.key}`}>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                  <ShieldCheck className="w-4 h-4" /> {adapter.label}
                  <Badge variant="outline" className="ml-2">
                    {adapter.disclosureTier}
                  </Badge>
                  <Badge variant="outline">{adapter.jurisdiction}</Badge>
                  <Badge variant="outline">
                    Retention {adapter.retentionDays}d
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {adapter.description}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {showAdd ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New Coupa connection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="label">Label</Label>
                <Input
                  id="label"
                  placeholder="Acme Coupa Production"
                  value={form.label}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, label: e.target.value }))
                  }
                  data-testid="input-label"
                />
              </div>
              <div>
                <Label htmlFor="instanceUrl">Instance URL</Label>
                <Input
                  id="instanceUrl"
                  placeholder="https://acme.coupahost.com"
                  value={form.instanceUrl}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, instanceUrl: e.target.value }))
                  }
                  data-testid="input-instance-url"
                />
              </div>
              <div>
                <Label htmlFor="clientId">Client ID</Label>
                <Input
                  id="clientId"
                  value={form.clientId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, clientId: e.target.value }))
                  }
                  data-testid="input-client-id"
                />
              </div>
              <div>
                <Label htmlFor="clientSecret">Client Secret</Label>
                <Input
                  id="clientSecret"
                  type="password"
                  value={form.clientSecret}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, clientSecret: e.target.value }))
                  }
                  data-testid="input-client-secret"
                />
              </div>
              <div>
                <Label htmlFor="pageSize">Page size</Label>
                <Input
                  id="pageSize"
                  type="number"
                  min={1}
                  max={1000}
                  value={form.pageSize}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, pageSize: e.target.value }))
                  }
                />
              </div>
            </div>

            {testResult ? (
              testResult.ok ? (
                <Alert>
                  <CheckCircle2 className="w-4 h-4" />
                  <AlertTitle>Credentials accepted</AlertTitle>
                  <AlertDescription>
                    OAuth2 token exchange succeeded.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive">
                  <XCircle className="w-4 h-4" />
                  <AlertTitle>Test failed</AlertTitle>
                  <AlertDescription>
                    <TruncatedError message={testResult.error} />
                  </AlertDescription>
                </Alert>
              )
            ) : null}

            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={onTest}
                disabled={
                  testMut.isPending ||
                  !form.instanceUrl ||
                  !form.clientId ||
                  !form.clientSecret
                }
                data-testid="btn-test-connection"
              >
                {testMut.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : null}
                Test connection
              </Button>
              <Button
                onClick={onCreate}
                disabled={
                  createMut.isPending ||
                  !form.label ||
                  !form.instanceUrl ||
                  !form.clientId ||
                  !form.clientSecret
                }
                data-testid="btn-save-connection"
              >
                {createMut.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : null}
                Save
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowAdd(false);
                  setForm(EMPTY_FORM);
                  setTestResult(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connections</CardTitle>
        </CardHeader>
        <CardContent>
          {connectionsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No connections yet. Add one above to start syncing data from
              your ERP.
            </p>
          ) : (
            <div className="space-y-3">
              {connections.map((c) => (
                <div
                  key={c.id}
                  className="flex items-start justify-between gap-4 border rounded-md p-4"
                  data-testid={`row-connection-${c.id}`}
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.label}</span>
                      <Badge variant="outline">{c.adapterKey}</Badge>
                      <Badge variant={statusVariant(c.status)}>
                        {c.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Last sync: {fmtTime(c.lastSyncedAt)} · Next scheduled:{" "}
                      {c.status === "paused" ? (
                        <span className="italic">paused</span>
                      ) : (
                        fmtTime(c.nextScheduledSyncAt)
                      )}{" "}
                      · Created {fmtTime(c.createdAt)}
                    </p>
                    <div
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                      data-testid={`cadence-row-${c.id}`}
                    >
                      <span>Sync cadence:</span>
                      <Select
                        value={String(c.syncIntervalMinutes)}
                        onValueChange={(v) =>
                          void onChangeInterval(c, Number(v))
                        }
                        disabled={updateMut.isPending}
                      >
                        <SelectTrigger
                          className="h-7 w-[180px] text-xs"
                          data-testid={`select-cadence-${c.id}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SYNC_INTERVAL_OPTIONS.map((opt) => (
                            <SelectItem
                              key={opt.value}
                              value={String(opt.value)}
                            >
                              {opt.label}
                            </SelectItem>
                          ))}
                          {SYNC_INTERVAL_OPTIONS.find(
                            (o) => o.value === c.syncIntervalMinutes,
                          ) ? null : (
                            <SelectItem value={String(c.syncIntervalMinutes)}>
                              {describeInterval(c.syncIntervalMinutes)}
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Credential fields:{" "}
                      <code className="bg-muted px-1 rounded text-[11px]">
                        {c.credentialFields.join(", ") || "—"}
                      </code>
                    </p>
                    {Object.keys(c.watermarks ?? {}).length > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Watermarks:{" "}
                        {Object.entries(c.watermarks)
                          .map(([k, v]) => `${k}=${v.slice(0, 19)}Z`)
                          .join(", ")}
                      </p>
                    ) : null}
                    {c.lastError ? (
                      <Alert variant="destructive" className="mt-2">
                        <AlertTitle className="text-xs">
                          Last sync error
                        </AlertTitle>
                        <AlertDescription>
                          <TruncatedError message={c.lastError} />
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    <RunsPanel
                      connectionId={c.id}
                      open={openRuns.has(c.id)}
                      onOpenChange={(open) => setRunsOpen(c.id, open)}
                    />
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onSync(c)}
                      disabled={c.status === "paused" || syncMut.isPending}
                      data-testid={`btn-sync-${c.id}`}
                    >
                      <RefreshCw className="w-4 h-4 mr-1" /> Sync now
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onTogglePause(c)}
                      disabled={updateMut.isPending}
                    >
                      {c.status === "paused" ? (
                        <>
                          <Play className="w-4 h-4 mr-1" /> Resume
                        </>
                      ) : (
                        <>
                          <Pause className="w-4 h-4 mr-1" /> Pause
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDelete(c)}
                      disabled={deleteMut.isPending}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
