import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAgents,
  useListOutcomeClaims,
  useGetOutcomeClaim,
  useVerifyOutcomeClaim,
  useDenyOutcomeClaim,
  getListAgentsQueryKey,
  getListOutcomeClaimsQueryKey,
  getGetOutcomeClaimQueryKey,
  getGetLedgerSummaryQueryKey,
  getGetRecentActivityQueryKey,
  getGetValueByAgentQueryKey,
  getGetValueOverTimeQueryKey,
  type ListOutcomeClaimsParams,
  type ClaimStatus,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Separator } from "@/components/ui/separator";
import {
  CheckCircle2,
  XCircle,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Filter,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { formatUsd, statusBadgeVariant } from "@/lib/format";

const PAGE_SIZE = 20;

export default function LedgerPage() {
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);
  const [denyTarget, setDenyTarget] = useState<string | null>(null);

  const { data: agents } = useListAgents(undefined, {
    query: { queryKey: getListAgentsQueryKey() },
  });

  const params = useMemo<ListOutcomeClaimsParams>(() => {
    const p: ListOutcomeClaimsParams = { limit: PAGE_SIZE, offset };
    if (agentFilter !== "all") p.agentId = agentFilter;
    if (statusFilter !== "all") p.status = statusFilter as ClaimStatus;
    if (fromDate) p.from = new Date(fromDate).toISOString();
    if (toDate) {
      const d = new Date(toDate);
      d.setHours(23, 59, 59, 999);
      p.to = d.toISOString();
    }
    return p;
  }, [agentFilter, statusFilter, fromDate, toDate, offset]);

  const { data, isLoading } = useListOutcomeClaims(params, {
    query: { queryKey: getListOutcomeClaimsQueryKey(params) },
  });

  const queryClient = useQueryClient();
  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/outcome-claims"] });
    queryClient.invalidateQueries({ queryKey: getGetLedgerSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetRecentActivityQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetValueByAgentQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetValueOverTimeQueryKey() });
    if (activeClaimId) {
      queryClient.invalidateQueries({
        queryKey: getGetOutcomeClaimQueryKey(activeClaimId),
      });
    }
  };

  const { mutate: verifyMutate, isPending: verifyPending } =
    useVerifyOutcomeClaim({
      mutation: {
        onSuccess: () => {
          toast.success("Claim verified");
          invalidateAll();
        },
        onError: (e) =>
          toast.error("Could not verify", { description: String(e) }),
      },
    });

  const { mutate: denyMutate, isPending: denyPending } = useDenyOutcomeClaim({
    mutation: {
      onSuccess: () => {
        toast.success("Claim denied");
        setDenyTarget(null);
        invalidateAll();
      },
      onError: (e) =>
        toast.error("Could not deny", { description: String(e) }),
    },
  });

  const total = data?.total ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Outcome Ledger
        </h1>
        <p className="text-muted-foreground mt-1">
          Every outcome an agent has claimed credit for. Verify or deny before
          it becomes billable.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle>Claims</CardTitle>
              <CardDescription>
                {isLoading
                  ? "Loading..."
                  : total === 0
                  ? "No claims match your filters"
                  : `Showing ${pageStart}–${pageEnd} of ${total}`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Filter className="h-3 w-3 text-muted-foreground" />
              <Select
                value={agentFilter}
                onValueChange={(v) => {
                  setAgentFilter(v);
                  setOffset(0);
                }}
              >
                <SelectTrigger className="w-44 h-9">
                  <SelectValue placeholder="Agent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All agents</SelectItem>
                  {agents?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setOffset(0);
                }}
              >
                <SelectTrigger className="w-32 h-9">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="claimed">Claimed</SelectItem>
                  <SelectItem value="verified">Verified</SelectItem>
                  <SelectItem value="denied">Denied</SelectItem>
                  <SelectItem value="invoiced">Invoiced</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setFromDate(e.target.value);
                  setOffset(0);
                }}
                className="w-36 h-9"
                placeholder="From"
              />
              <Input
                type="date"
                value={toDate}
                onChange={(e) => {
                  setToDate(e.target.value);
                  setOffset(0);
                }}
                className="w-36 h-9"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No claims found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Claim</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Claimed</TableHead>
                  <TableHead className="text-right w-[180px]">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((c, idx) => (
                  <motion.tr
                    key={c.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.02 }}
                    className="border-b transition-colors hover:bg-muted/40 cursor-pointer"
                    onClick={() => setActiveClaimId(c.id)}
                  >
                    <TableCell className="font-mono text-sm">
                      {c.agentName}
                    </TableCell>
                    <TableCell className="max-w-md">
                      <div className="font-medium text-sm">{c.title}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {c.claimType}
                        {c.evidenceUrl && (
                          <a
                            href={c.evidenceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            <ExternalLink className="h-3 w-3" />
                            {c.evidenceLabel ?? "evidence"}
                          </a>
                        )}
                      </div>
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
                      {formatDistanceToNow(new Date(c.claimedAt), {
                        addSuffix: true,
                      })}
                    </TableCell>
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.status === "claimed" ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="default"
                            disabled={verifyPending}
                            onClick={() =>
                              verifyMutate({ claimId: c.id, data: {} })
                            }
                          >
                            <CheckCircle2 className="h-3 w-3 mr-1" /> Verify
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={denyPending}
                            onClick={() => setDenyTarget(c.id)}
                          >
                            <XCircle className="h-3 w-3 mr-1" /> Deny
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setActiveClaimId(c.id)}
                        >
                          View <ChevronsRight className="h-3 w-3 ml-1" />
                        </Button>
                      )}
                    </TableCell>
                  </motion.tr>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between px-6 pb-4 text-sm text-muted-foreground">
            <div>
              Page {Math.floor(offset / PAGE_SIZE) + 1} of{" "}
              {Math.ceil(total / PAGE_SIZE)}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft className="h-3 w-3 mr-1" /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      <ClaimDrawer
        claimId={activeClaimId}
        open={!!activeClaimId}
        onClose={() => setActiveClaimId(null)}
        onVerify={(id) => verifyMutate({ claimId: id, data: {} })}
        onDeny={(id) => setDenyTarget(id)}
      />

      <DenyDialog
        claimId={denyTarget}
        onClose={() => setDenyTarget(null)}
        onSubmit={(id, reason) =>
          denyMutate({ claimId: id, data: { reason } })
        }
        pending={denyPending}
      />
    </div>
  );
}

function ClaimDrawer({
  claimId,
  open,
  onClose,
  onVerify,
  onDeny,
}: {
  claimId: string | null;
  open: boolean;
  onClose: () => void;
  onVerify: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const { data: claim, isLoading } = useGetOutcomeClaim(claimId ?? "", {
    query: {
      enabled: !!claimId,
      queryKey: getGetOutcomeClaimQueryKey(claimId ?? ""),
    },
  });

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg overflow-y-auto">
        {isLoading || !claim ? (
          <div className="space-y-3 mt-8">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <Badge variant={statusBadgeVariant(claim.status)}>
                  {claim.status}
                </Badge>
                <span className="text-xs text-muted-foreground font-mono">
                  {claim.claimType}
                </span>
              </div>
              <SheetTitle className="text-xl leading-tight">
                {claim.title}
              </SheetTitle>
              <SheetDescription>
                Claimed by{" "}
                <span className="font-mono text-foreground">
                  {claim.agentName}
                </span>{" "}
                · {format(new Date(claim.claimedAt), "MMM d, yyyy 'at' h:mm a")}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-6 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    Estimated value
                  </div>
                  <div className="text-2xl font-semibold font-mono mt-1">
                    {formatUsd(claim.estimatedValueUsd)}
                  </div>
                </div>
                {claim.evidenceUrl && (
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">
                      Evidence
                    </div>
                    <a
                      href={claim.evidenceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline inline-flex items-center gap-1 mt-2"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {claim.evidenceLabel ?? "View evidence"}
                    </a>
                  </div>
                )}
              </div>

              {claim.description && (
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                    Description
                  </div>
                  <p className="text-sm leading-relaxed">{claim.description}</p>
                </div>
              )}

              {claim.denialReason && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <div className="text-xs font-semibold text-destructive uppercase tracking-wide mb-1">
                    Denial reason
                  </div>
                  <p className="text-sm leading-relaxed">
                    {claim.denialReason}
                  </p>
                </div>
              )}

              <Separator />

              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide mb-3">
                  Event history
                </div>
                <ol className="space-y-3">
                  {claim.events.map((e, idx) => (
                    <li key={e.id} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <div
                          className={`w-2 h-2 rounded-full mt-1.5 ${
                            e.eventType === "verified"
                              ? "bg-primary"
                              : e.eventType === "denied"
                              ? "bg-destructive"
                              : e.eventType === "invoiced"
                              ? "bg-secondary"
                              : "bg-muted-foreground"
                          }`}
                        />
                        {idx < claim.events.length - 1 && (
                          <div className="w-px flex-1 bg-border mt-1" />
                        )}
                      </div>
                      <div className="flex-1 pb-3">
                        <div className="text-sm">
                          <span className="font-medium capitalize">
                            {e.eventType}
                          </span>{" "}
                          by{" "}
                          <span className="font-mono text-xs">{e.actor}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {format(new Date(e.createdAt), "MMM d, yyyy h:mm a")}
                        </div>
                        {e.reason && (
                          <div className="text-xs text-muted-foreground mt-1 italic">
                            "{e.reason}"
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              {claim.status === "claimed" && (
                <div className="flex gap-2 pt-2">
                  <Button
                    className="flex-1"
                    onClick={() => onVerify(claim.id)}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-2" /> Verify outcome
                  </Button>
                  <Button
                    className="flex-1"
                    variant="outline"
                    onClick={() => onDeny(claim.id)}
                  >
                    <XCircle className="h-4 w-4 mr-2" /> Deny
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DenyDialog({
  claimId,
  onClose,
  onSubmit,
  pending,
}: {
  claimId: string | null;
  onClose: () => void;
  onSubmit: (id: string, reason: string) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");

  return (
    <Dialog
      open={!!claimId}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setReason("");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deny outcome claim</DialogTitle>
          <DialogDescription>
            The agent will not be paid for this outcome. Capture the reason —
            it'll be appended to the claim's audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason">Reason</Label>
          <Textarea
            id="reason"
            placeholder="e.g. Evidence does not match the KPI definition. Recurring error from same playbook this week."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending || reason.trim().length < 3}
            onClick={() => {
              if (claimId) onSubmit(claimId, reason.trim());
              setReason("");
            }}
          >
            {pending ? "Denying..." : "Deny claim"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
