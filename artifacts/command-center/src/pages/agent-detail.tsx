import { useParams, Link } from "wouter";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAgent,
  useUpdateAgent,
  useListOutcomeClaims,
  getGetAgentQueryKey,
  getListAgentsQueryKey,
  getListOutcomeClaimsQueryKey,
  getGetLedgerSummaryQueryKey,
  getGetValueByAgentQueryKey,
  type AgentStatus,
} from "@workspace/api-client-react";
import { ArrowLeft, Pencil, CheckCircle2, XCircle, FileText, Banknote, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { toast } from "sonner";
import { formatUsd, statusBadgeVariant } from "@/lib/format";

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const agentId = params.id;
  const queryClient = useQueryClient();

  const { data: agent, isLoading } = useGetAgent(agentId, {
    query: {
      enabled: !!agentId,
      queryKey: getGetAgentQueryKey(agentId),
    },
  });

  const claimsParams = { agentId, limit: 25, offset: 0 };
  const { data: claims, isLoading: claimsLoading } = useListOutcomeClaims(
    claimsParams,
    { query: { queryKey: getListOutcomeClaimsQueryKey(claimsParams), enabled: !!agentId } },
  );

  const { mutate: updateAgent } = useUpdateAgent({
    mutation: {
      onSuccess: () => {
        toast.success("Agent updated");
        queryClient.invalidateQueries({ queryKey: getGetAgentQueryKey(agentId) });
        queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
      },
      onError: () => toast.error("Could not update agent"),
    },
  });

  if (isLoading) {
    return (
      <div className="p-8 max-w-7xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <Link href="/agents" className="text-sm text-muted-foreground hover:underline">
          ← Back to agents
        </Link>
        <p className="mt-6 text-muted-foreground">Agent not found.</p>
      </div>
    );
  }

  const isPaused = agent.status === "paused";

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <Link
        href="/agents"
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ArrowLeft className="h-3 w-3" /> Back to agents
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight font-mono">
              {agent.name}
            </h1>
            <Badge variant={statusBadgeVariant(agent.status)}>
              {agent.status}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 max-w-2xl">{agent.role}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="active-toggle"
              checked={!isPaused && agent.status !== "retired"}
              onCheckedChange={(checked) => {
                updateAgent({
                  agentId: agent.id,
                  data: { status: (checked ? "active" : "paused") as AgentStatus },
                });
              }}
            />
            <Label htmlFor="active-toggle" className="text-sm">
              Active
            </Label>
          </div>
          <EditAgentDialog
            agent={agent}
            onSaved={() => {
              queryClient.invalidateQueries({ queryKey: getGetAgentQueryKey(agentId) });
              queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
              queryClient.invalidateQueries({ queryKey: getGetLedgerSummaryQueryKey() });
              queryClient.invalidateQueries({ queryKey: getGetValueByAgentQueryKey() });
            }}
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">KPI definition</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed">{agent.kpiDefinition}</p>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Layers}
          label="Lifetime claims"
          value={String(
            agent.lifetimeClaimsByStatus.claimed +
              agent.lifetimeClaimsByStatus.verified +
              agent.lifetimeClaimsByStatus.denied +
              agent.lifetimeClaimsByStatus.invoiced,
          )}
          sub={`${agent.lifetimeClaimsByStatus.claimed} pending review`}
        />
        <StatCard
          icon={CheckCircle2}
          label="Verified outcomes"
          value={String(
            agent.lifetimeClaimsByStatus.verified +
              agent.lifetimeClaimsByStatus.invoiced,
          )}
          sub={`${agent.lifetimeClaimsByStatus.invoiced} invoiced`}
        />
        <StatCard
          icon={FileText}
          label="Verified value"
          value={formatUsd(agent.lifetimeVerifiedValueUsd, { compact: true })}
          sub="Underlying business value"
        />
        <StatCard
          icon={Banknote}
          label="Lifetime billable"
          value={formatUsd(agent.lifetimeBillableUsd, { compact: true })}
          sub={`@ ${formatUsd(agent.ratePerOutcomeUsd)} / outcome`}
          highlight
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent claims</CardTitle>
          <CardDescription>
            Latest outcomes claimed by this agent
          </CardDescription>
        </CardHeader>
        <CardContent>
          {claimsLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : !claims || claims.items.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No claims yet from this agent.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Claimed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {claims.items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium max-w-md">
                      <Link
                        href={`/ledger?claim=${c.id}`}
                        className="hover:underline"
                      >
                        {c.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {c.claimType}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatUsd(c.estimatedValueUsd)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(c.status)}>
                        {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {format(new Date(c.claimedAt), "MMM d, h:mm a")}
                    </TableCell>
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

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  highlight,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <Card className={highlight ? "border-primary/40" : ""}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </CardTitle>
        <Icon className={`h-4 w-4 ${highlight ? "text-primary" : "text-muted-foreground"}`} />
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-semibold ${highlight ? "text-primary" : ""}`}>
          {value}
        </div>
        <p className="text-xs text-muted-foreground mt-1">{sub}</p>
      </CardContent>
    </Card>
  );
}

function EditAgentDialog({
  agent,
  onSaved,
}: {
  agent: { id: string; name: string; role: string; kpiDefinition: string; ratePerOutcomeUsd: number };
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [kpi, setKpi] = useState(agent.kpiDefinition);
  const [rate, setRate] = useState(String(agent.ratePerOutcomeUsd));

  const { mutate, isPending } = useUpdateAgent({
    mutation: {
      onSuccess: () => {
        toast.success("Agent updated");
        onSaved();
        setOpen(false);
      },
      onError: () => toast.error("Could not update agent"),
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="h-3 w-3 mr-2" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit agent</DialogTitle>
          <DialogDescription>Update role, KPI, or per-outcome rate.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Textarea value={role} onChange={(e) => setRole(e.target.value)} rows={2} />
          </div>
          <div className="space-y-2">
            <Label>KPI</Label>
            <Textarea value={kpi} onChange={(e) => setKpi(e.target.value)} rows={2} />
          </div>
          <div className="space-y-2">
            <Label>Rate per outcome (USD)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={isPending}
            onClick={() =>
              mutate({
                agentId: agent.id,
                data: {
                  name,
                  role,
                  kpiDefinition: kpi,
                  ratePerOutcomeUsd: Number(rate),
                },
              })
            }
          >
            {isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
