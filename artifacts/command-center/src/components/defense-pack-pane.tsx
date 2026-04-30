import { useMemo, useState } from "react";
import {
  useListDefensePacks,
  useCreateDefensePack,
  useGetDefensePack,
  useSubmitDefensePackFeedback,
  useListSuppliers,
  getListDefensePacksQueryKey,
  getGetDefensePackQueryKey,
  type DefensePack,
  type DefensePackSummary,
  type DefensePackPosition,
  type DefensePackLength,
  type CreateDefensePackRequest,
  type DefensePackEvidenceSnapshotItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Link2,
  Loader2,
  Shield,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";

const POSITION_LABELS: Record<DefensePackPosition, string> = {
  defend_against_increase: "Defend against increase",
  attack_for_decrease: "Attack for decrease",
  justify_index_relink: "Justify index relink",
};

const LENGTH_LABELS: Record<DefensePackLength, string> = {
  exec_one_pager: "Exec one-pager",
  three_page_brief: "3-page brief",
  full_pack: "Full pack",
};

export function DefensePackPane() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const { toast } = useToast();

  return (
    <div className="grid gap-4 lg:grid-cols-[480px_1fr]">
      <div className="space-y-4">
        <BuilderCard
          onCreated={(id) => {
            setActiveId(id);
            toast({ title: "Defense Pack generated", description: id });
          }}
        />
        <RecentPacksCard activeId={activeId} onSelect={setActiveId} />
      </div>
      <div>
        {activeId ? (
          <PackDetailCard packId={activeId} />
        ) : (
          <Card data-testid="card-defense-pack-empty">
            <CardContent className="py-16 text-center text-sm text-muted-foreground">
              <Shield className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
              Generate or pick a Defense Pack to see the memo and the
              frozen Evidence Room snapshot.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// Builder
// =====================================================================

function BuilderCard({ onCreated }: { onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: suppliersData } = useListSuppliers({ limit: 200 });
  const suppliers = suppliersData?.items ?? [];

  const [supplierId, setSupplierId] = useState("");
  const [scopeMode, setScopeMode] = useState<"material" | "category" | "line">(
    "material",
  );
  const [scopeValue, setScopeValue] = useState("");
  const [contractId, setContractId] = useState("");
  const [position, setPosition] =
    useState<DefensePackPosition>("defend_against_increase");
  const [length, setLength] = useState<DefensePackLength>("three_page_brief");
  const [note, setNote] = useState("");

  const supplier = useMemo(
    () => suppliers.find((s) => s.id === supplierId),
    [suppliers, supplierId],
  );

  const create = useCreateDefensePack({
    mutation: {
      onSuccess: async (pack) => {
        await queryClient.invalidateQueries({
          queryKey: getListDefensePacksQueryKey(),
        });
        onCreated(pack.id);
      },
      onError: (err: Error) => {
        toast({
          title: "Generation failed",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const canSubmit =
    supplier !== undefined &&
    !!scopeValue.trim() &&
    (scopeMode !== "line" || contractId.trim().length > 0) &&
    !create.isPending;

  const onSubmit = () => {
    if (!supplier) return;
    const target: CreateDefensePackRequest["target"] = {
      supplierId: supplier.id,
      supplierName: supplier.name,
    };
    if (scopeMode === "material") {
      target.materialCode = scopeValue.trim();
    } else if (scopeMode === "category") {
      target.categoryCode = scopeValue.trim();
    } else {
      target.contractId = contractId.trim();
      target.lineItem = scopeValue.trim();
    }
    create.mutate({
      data: {
        target,
        position,
        length,
        positionNote: note.trim() || undefined,
      },
    });
  };

  return (
    <Card data-testid="card-defense-pack-builder">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" /> Defense Pack Builder
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Supplier
          </label>
          <Select value={supplierId} onValueChange={setSupplierId}>
            <SelectTrigger data-testid="select-defense-supplier">
              <SelectValue placeholder="Pick a supplier" />
            </SelectTrigger>
            <SelectContent>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Scope
            </label>
            <Select
              value={scopeMode}
              onValueChange={(v) =>
                setScopeMode(v as "material" | "category" | "line")
              }
            >
              <SelectTrigger data-testid="select-defense-scope-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="material">Material code</SelectItem>
                <SelectItem value="category">Category code</SelectItem>
                <SelectItem value="line">Contract line</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              {scopeMode === "line" ? "Line item" : "Code"}
            </label>
            <Input
              value={scopeValue}
              onChange={(e) => setScopeValue(e.target.value)}
              placeholder={
                scopeMode === "material"
                  ? "STEEL_HRC"
                  : scopeMode === "category"
                    ? "DIRECT_METALS"
                    : "L7-2026"
              }
              data-testid="input-defense-scope"
            />
          </div>
        </div>
        {scopeMode === "line" && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Contract ID
            </label>
            <Input
              value={contractId}
              onChange={(e) => setContractId(e.target.value)}
              placeholder="ctr_..."
              data-testid="input-defense-contract"
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Position
            </label>
            <Select
              value={position}
              onValueChange={(v) => setPosition(v as DefensePackPosition)}
            >
              <SelectTrigger data-testid="select-defense-position">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(POSITION_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Length
            </label>
            <Select
              value={length}
              onValueChange={(v) => setLength(v as DefensePackLength)}
            >
              <SelectTrigger data-testid="select-defense-length">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(LENGTH_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Position note (optional)
          </label>
          <Textarea
            rows={3}
            placeholder="Supplier proposed 8% increase effective Q1, citing steel cost. We want to keep flat through year-end…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="textarea-defense-note"
          />
        </div>
        <Button
          className="w-full"
          onClick={onSubmit}
          disabled={!canSubmit}
          data-testid="button-defense-generate"
        >
          {create.isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-2" />
              Generate Defense Pack
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

// =====================================================================
// Recent
// =====================================================================

function RecentPacksCard({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const { data, isLoading } = useListDefensePacks({ limit: 25 });
  const items = data?.items ?? [];
  return (
    <Card data-testid="card-defense-pack-recent">
      <CardHeader>
        <CardTitle className="text-sm">Recent packs</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {isLoading && <Skeleton className="h-16 w-full" />}
        {!isLoading && items.length === 0 && (
          <p className="text-xs text-muted-foreground py-4">
            No Defense Packs yet — generate your first one above.
          </p>
        )}
        {items.map((it) => (
          <RecentRow
            key={it.id}
            pack={it}
            active={it.id === activeId}
            onSelect={() => onSelect(it.id)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function RecentRow({
  pack,
  active,
  onSelect,
}: {
  pack: DefensePackSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`row-defense-pack-${pack.id}`}
      className={`w-full text-left rounded-md border px-3 py-2 hover:bg-muted/40 transition-colors ${
        active ? "border-primary/60 bg-muted/30" : "border-transparent"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium truncate">
          {pack.target.supplierName}
        </div>
        <StatusPill status={pack.status} />
      </div>
      <div className="text-[11px] text-muted-foreground flex items-center gap-2">
        <span>{POSITION_LABELS[pack.position as DefensePackPosition]}</span>
        <span>·</span>
        <span>{formatDateTime(pack.createdAt)}</span>
      </div>
    </button>
  );
}

function StatusPill({ status }: { status: string }) {
  if (status === "ready") {
    return (
      <Badge variant="outline" className="text-[10px]">
        <CheckCircle2 className="w-3 h-3 mr-1" />
        Ready
      </Badge>
    );
  }
  if (status === "insufficient_evidence") {
    return (
      <Badge variant="outline" className="text-[10px] text-amber-700">
        <AlertTriangle className="w-3 h-3 mr-1" />
        Insufficient
      </Badge>
    );
  }
  if (status === "generating") {
    return (
      <Badge variant="outline" className="text-[10px]">
        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
        Generating
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-destructive">
      {status}
    </Badge>
  );
}

// =====================================================================
// Detail
// =====================================================================

function PackDetailCard({ packId }: { packId: string }) {
  const { data, isLoading } = useGetDefensePack(packId, {
    query: { queryKey: getGetDefensePackQueryKey(packId) },
  });
  const { toast } = useToast();

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12">
          <Skeleton className="h-8 w-1/2 mb-4" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <CardContent className="py-12 text-sm text-muted-foreground text-center">
          Pack not found.
        </CardContent>
      </Card>
    );
  }
  const pack = data;
  const permalink = `${window.location.origin}/fusion?tab=defense&pack=${pack.id}`;

  const downloadPdf = async () => {
    const url = `/api/defense-packs/${pack.id}/pdf`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `defense-pack-${pack.id}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(permalink);
      toast({ title: "Permalink copied", description: permalink });
    } catch (err) {
      toast({
        title: "Copy failed",
        description: String(err),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4">
      <Card data-testid={`card-defense-pack-${pack.id}`}>
        <CardHeader>
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-primary" />
                {pack.target.supplierName}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {POSITION_LABELS[pack.position as DefensePackPosition]} ·{" "}
                {LENGTH_LABELS[pack.length as DefensePackLength]} ·{" "}
                {pack.target.materialCode ??
                  pack.target.categoryCode ??
                  pack.target.lineItem ??
                  "—"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={copyLink}
                data-testid="button-defense-copy-link"
              >
                <Link2 className="w-4 h-4 mr-1" /> Permalink
              </Button>
              <Button
                size="sm"
                onClick={downloadPdf}
                disabled={pack.status !== "ready"}
                data-testid="button-defense-download-pdf"
              >
                <Download className="w-4 h-4 mr-1" /> PDF
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-3 text-[11px] text-muted-foreground">
            <Badge variant="outline">policy: {pack.disclosurePolicy}</Badge>
            <Badge variant="outline">model: {pack.model ?? "n/a"}</Badge>
            <Badge variant="outline">
              {pack.verifiedClaimCount ?? 0} verified citation
              {(pack.verifiedClaimCount ?? 0) === 1 ? "" : "s"}
            </Badge>
            <Badge variant="outline">
              {pack.evidencePoolSize ?? pack.evidenceSnapshot.length} evidence
              row
              {(pack.evidencePoolSize ?? pack.evidenceSnapshot.length) === 1
                ? ""
                : "s"}
            </Badge>
            {pack.estimatedCostUsd != null && (
              <Badge variant="outline">
                ~${pack.estimatedCostUsd.toFixed(4)}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {pack.status === "insufficient_evidence" && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="w-4 h-4" /> Insufficient verifiable
                evidence
              </div>
              <p className="mt-1 text-xs">{pack.statusReason}</p>
            </div>
          )}
          {pack.sections.map((s) => (
            <SectionBlock
              key={s.key}
              section={s}
              evidence={pack.evidenceSnapshot}
            />
          ))}
        </CardContent>
      </Card>
      {pack.status === "ready" && <FeedbackCard packId={pack.id} />}
      <EvidenceRoomCard pack={pack} />
    </div>
  );
}

function SectionBlock({
  section,
  evidence,
}: {
  section: DefensePack["sections"][number];
  evidence: DefensePackEvidenceSnapshotItem[];
}) {
  return (
    <div data-testid={`section-defense-${section.key}`}>
      <h3 className="text-sm font-semibold mb-1">{section.title}</h3>
      <p className="text-sm leading-relaxed whitespace-pre-line">
        {section.narrative}
      </p>
      {section.claims.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {section.claims.map((claim, i) => {
            const ev = evidence.find((e) => e.signalId === claim.signalId);
            return (
              <li
                key={`${section.key}-${i}`}
                className="text-xs flex items-start gap-2"
              >
                <span className="text-muted-foreground">•</span>
                <span className="flex-1">{claim.text}</span>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide rounded bg-muted px-1.5 py-0.5 hover:bg-muted/70"
                      data-testid={`citation-${section.key}-${i}`}
                    >
                      {ev?.tier ?? "?"} cite
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 text-xs">
                    {ev ? (
                      <div className="space-y-1">
                        <div className="font-medium">{ev.collectorName}</div>
                        <div className="text-muted-foreground">
                          {ev.signalType} ·{" "}
                          {new Date(ev.observedAt).toISOString().slice(0, 10)} ·{" "}
                          {ev.tier}
                        </div>
                        <div>
                          {claim.valueQuoted}
                          <span className="text-muted-foreground">
                            {"  "}(snapshot: {ev.value} {ev.unit})
                          </span>
                        </div>
                        {ev.sourceUrl && (
                          <a
                            href={ev.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary underline break-all"
                          >
                            {ev.sourceUrl}
                          </a>
                        )}
                      </div>
                    ) : (
                      <div className="text-muted-foreground">
                        Source not in snapshot.
                      </div>
                    )}
                  </HoverCardContent>
                </HoverCard>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FeedbackCard({ packId }: { packId: string }) {
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);
  const submit = useSubmitDefensePackFeedback({
    mutation: {
      onSuccess: () => {
        setSubmitted(true);
        toast({ title: "Thanks — feedback recorded" });
      },
      onError: (err: Error) =>
        toast({
          title: "Feedback failed",
          description: err.message,
          variant: "destructive",
        }),
    },
  });

  if (submitted) {
    return (
      <Card>
        <CardContent className="py-3 text-xs text-muted-foreground">
          Feedback recorded — thanks. The Learn loop will use it to backtest the
          memo's lift.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-defense-feedback">
      <CardHeader>
        <CardTitle className="text-sm">Did this help?</CardTitle>
      </CardHeader>
      <CardContent className="flex gap-2 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            submit.mutate({
              id: packId,
              data: { used: "yes", outcomeCategory: "supplier_held_price" },
            })
          }
          data-testid="button-defense-feedback-yes"
        >
          <ThumbsUp className="w-4 h-4 mr-1" /> Used in negotiation
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => submit.mutate({ id: packId, data: { used: "no" } })}
          data-testid="button-defense-feedback-no"
        >
          <ThumbsDown className="w-4 h-4 mr-1" /> Skipped
        </Button>
      </CardContent>
    </Card>
  );
}

function EvidenceRoomCard({ pack }: { pack: DefensePack }) {
  const { toast } = useToast();
  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(pack.evidenceSnapshot, null, 2),
      );
      toast({ title: "Evidence snapshot copied as JSON" });
    } catch (err) {
      toast({
        title: "Copy failed",
        description: String(err),
        variant: "destructive",
      });
    }
  };
  return (
    <Card data-testid="card-defense-evidence-room">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="w-4 h-4" /> Evidence Room (frozen)
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={copyJson}>
            <Copy className="w-4 h-4 mr-1" /> Copy JSON
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {pack.evidenceSnapshot.length === 0 ? (
          <p className="text-xs text-muted-foreground">No evidence captured.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2">Source</th>
                  <th className="py-1 pr-2">Type</th>
                  <th className="py-1 pr-2">Tier</th>
                  <th className="py-1 pr-2 text-right">Value</th>
                  <th className="py-1 pr-2">Observed</th>
                  <th className="py-1 pr-2">Link</th>
                </tr>
              </thead>
              <tbody>
                {pack.evidenceSnapshot.map((e) => (
                  <tr key={e.signalId} className="border-t">
                    <td className="py-1 pr-2">{e.collectorName}</td>
                    <td className="py-1 pr-2">{e.signalType}</td>
                    <td className="py-1 pr-2">{e.tier}</td>
                    <td className="py-1 pr-2 text-right">
                      {e.value} {e.unit}
                    </td>
                    <td className="py-1 pr-2">
                      {new Date(e.observedAt).toISOString().slice(0, 10)}
                    </td>
                    <td className="py-1 pr-2">
                      {e.sourceUrl ? (
                        <a
                          href={e.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline break-all"
                        >
                          link
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
