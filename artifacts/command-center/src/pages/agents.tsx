import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAgents,
  useCreateAgent,
  getListAgentsQueryKey,
  getGetLedgerSummaryQueryKey,
  getGetValueByAgentQueryKey,
  AgentStatus,
  type ListAgentsParams,
  type Agent,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { formatUsd, statusBadgeVariant } from "@/lib/format";

export default function AgentsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const params: ListAgentsParams | undefined =
    statusFilter === "all"
      ? undefined
      : { status: statusFilter as AgentStatus };

  const {
    data: agents,
    isLoading,
  } = useListAgents(params, {
    query: { queryKey: getListAgentsQueryKey(params) },
  });

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Procurement Agents
          </h1>
          <p className="text-muted-foreground mt-1">
            Your roster of automated workers and the outcomes they're paid for.
          </p>
        </div>
        <RegisterAgentDialog />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>All agents</CardTitle>
            <CardDescription>
              {agents ? `${agents.length} agents` : "Loading roster..."}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="status-filter" className="text-xs text-muted-foreground">
              Status
            </Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger id="status-filter" className="w-36">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="retired">Retired</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : !agents || agents.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No agents yet. Register your first agent to start tracking outcomes.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>KPI</TableHead>
                  <TableHead className="text-right">Rate / outcome</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent: Agent, idx: number) => (
                  <motion.tr
                    key={agent.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.03 }}
                    className="border-b transition-colors hover:bg-muted/40 cursor-pointer"
                    onClick={() => {
                      window.history.pushState({}, "", `${import.meta.env.BASE_URL}agents/${agent.id}`);
                      window.dispatchEvent(new PopStateEvent("popstate"));
                    }}
                  >
                    <TableCell className="font-medium font-mono text-sm">
                      <Link
                        href={`/agents/${agent.id}`}
                        className="hover:underline"
                      >
                        {agent.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-md">
                      <div className="line-clamp-2">{agent.role}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-md">
                      <div className="line-clamp-2">{agent.kpiDefinition}</div>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatUsd(agent.ratePerOutcomeUsd)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(agent.status)}>
                        {agent.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                  </motion.tr>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RegisterAgentDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [kpiDefinition, setKpiDefinition] = useState("");
  const [ratePerOutcomeUsd, setRate] = useState("0");
  const [status, setStatus] = useState<AgentStatus>("active");

  const queryClient = useQueryClient();
  const { mutate, isPending } = useCreateAgent({
    mutation: {
      onSuccess: () => {
        toast.success(`Agent "${name}" registered`);
        queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        queryClient.invalidateQueries({
          queryKey: getGetLedgerSummaryQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getGetValueByAgentQueryKey(),
        });
        setOpen(false);
        setName("");
        setRole("");
        setKpiDefinition("");
        setRate("0");
        setStatus("active");
      },
      onError: (err) => {
        toast.error("Could not register agent", { description: String(err) });
      },
    },
  });

  const valid = useMemo(
    () =>
      name.trim().length > 0 &&
      role.trim().length > 0 &&
      kpiDefinition.trim().length > 0 &&
      Number(ratePerOutcomeUsd) >= 0,
    [name, role, kpiDefinition, ratePerOutcomeUsd],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Register agent
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Register a new agent</DialogTitle>
          <DialogDescription>
            Define how this worker is measured and what each verified outcome
            costs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="name">Agent name</Label>
            <Input
              id="name"
              placeholder="exception_resolver"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <Textarea
              id="role"
              placeholder="One-sentence job description"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="kpi">KPI definition</Label>
            <Textarea
              id="kpi"
              placeholder="What exactly counts as a verified outcome?"
              value={kpiDefinition}
              onChange={(e) => setKpiDefinition(e.target.value)}
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="rate">Rate per outcome (USD)</Label>
              <Input
                id="rate"
                type="number"
                min="0"
                step="0.01"
                value={ratePerOutcomeUsd}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as AgentStatus)}
              >
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="retired">Retired</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || isPending}
            onClick={() =>
              mutate({
                data: {
                  name: name.trim(),
                  role: role.trim(),
                  kpiDefinition: kpiDefinition.trim(),
                  ratePerOutcomeUsd: Number(ratePerOutcomeUsd),
                  status,
                },
              })
            }
          >
            {isPending ? "Registering..." : "Register agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
