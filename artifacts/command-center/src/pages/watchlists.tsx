import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListWatchlists,
  useCreateWatchlist,
  useDeleteWatchlist,
  useGetWatchlist,
  useAddWatchlistMember,
  useRemoveWatchlistMember,
  useListSuppliers,
  getListWatchlistsQueryKey,
  getGetWatchlistQueryKey,
  getListSuppliersQueryKey,
  type Watchlist,
  type Supplier,
} from "@workspace/api-client-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Eye,
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  Users,
  ChevronRight,
} from "lucide-react";

export default function Watchlists() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const listQ = useListWatchlists({
    query: { queryKey: getListWatchlistsQueryKey() },
  });
  const watchlists = listQ.data?.items ?? [];
  const selected = watchlists.find((w) => w.id === selectedId) ?? null;

  const createM = useCreateWatchlist({
    mutation: {
      onSuccess: (wl) => {
        qc.invalidateQueries({ queryKey: getListWatchlistsQueryKey() });
        setCreateOpen(false);
        setSelectedId(wl.id);
        toast({ title: "Watchlist created", description: wl.name });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not create watchlist",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const deleteM = useDeleteWatchlist({
    mutation: {
      onSuccess: (_, vars) => {
        qc.invalidateQueries({ queryKey: getListWatchlistsQueryKey() });
        if (selectedId === vars.id) setSelectedId(null);
        toast({ title: "Watchlist deleted" });
      },
      onError: (e: Error) =>
        toast({
          title: "Delete failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            data-testid="text-page-title"
            className="text-3xl font-bold flex items-center gap-3"
          >
            <Eye className="w-7 h-7 text-primary" />
            Watchlists
            {listQ.isFetching && (
              <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            Group suppliers or external entities together so alert rules and
            subscriptions can fire only on what matters to you.
          </p>
        </div>
        <Button
          data-testid="button-new-watchlist"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="w-4 h-4 mr-2" /> New watchlist
        </Button>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Your watchlists</CardTitle>
          </CardHeader>
          <CardContent>
            {listQ.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : watchlists.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No watchlists yet. Create one to group suppliers you care about.
              </div>
            ) : (
              <ul className="divide-y" data-testid="list-watchlists">
                {watchlists.map((w) => (
                  <li
                    key={w.id}
                    className="py-2 flex items-center gap-2"
                    data-testid={`row-watchlist-${w.id}`}
                  >
                    <button
                      type="button"
                      className={`flex-1 text-left px-2 py-1 rounded hover:bg-muted/50 ${
                        selectedId === w.id ? "bg-muted" : ""
                      }`}
                      onClick={() => setSelectedId(w.id)}
                    >
                      <div className="text-sm font-medium flex items-center gap-2">
                        {w.name}
                        <Badge variant="outline" className="text-[10px]">
                          {w.scope}
                        </Badge>
                      </div>
                      {w.description && (
                        <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                          {w.description}
                        </div>
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete watchlist "${w.name}"? Subscriptions referencing it will keep running but lose their member filter.`,
                          )
                        ) {
                          deleteM.mutate({ id: w.id });
                        }
                      }}
                      disabled={
                        deleteM.isPending && deleteM.variables?.id === w.id
                      }
                      data-testid={`button-delete-watchlist-${w.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                    </Button>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          {selected ? (
            <WatchlistDetail watchlist={selected} />
          ) : (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                <Users className="w-8 h-8 mx-auto mb-3 opacity-40" />
                Select a watchlist to view and manage its members.
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <CreateWatchlistDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        busy={createM.isPending}
        onCreate={(data) => createM.mutate({ data })}
      />
    </div>
  );
}

// ---------- Detail panel ----------

function WatchlistDetail({ watchlist }: { watchlist: Watchlist }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const detailQ = useGetWatchlist(watchlist.id, {
    query: { queryKey: getGetWatchlistQueryKey(watchlist.id) },
  });
  const suppliersQ = useListSuppliers(undefined, {
    query: { queryKey: getListSuppliersQueryKey() },
  });

  const addM = useAddWatchlistMember({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: getGetWatchlistQueryKey(watchlist.id),
        });
        toast({ title: "Member added" });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not add member",
          description: String(e),
          variant: "destructive",
        }),
    },
  });
  const removeM = useRemoveWatchlistMember({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: getGetWatchlistQueryKey(watchlist.id),
        });
        toast({ title: "Member removed" });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not remove member",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const members = detailQ.data?.members ?? [];
  const suppliers: Supplier[] = suppliersQ.data?.items ?? [];
  const supplierById = useMemo(() => {
    const m = new Map<string, Supplier>();
    for (const s of suppliers) m.set(s.id, s);
    return m;
  }, [suppliers]);

  const memberSupplierIds = new Set(
    members.map((m) => m.supplierId).filter((x): x is string => Boolean(x)),
  );
  const availableSuppliers = suppliers.filter(
    (s) => !memberSupplierIds.has(s.id),
  );

  const [pickedSupplierId, setPickedSupplierId] = useState("");
  const [entityUid, setEntityUid] = useState("");

  return (
    <Card data-testid="watchlist-detail">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="w-5 h-5" />
          {watchlist.name}
        </CardTitle>
        {watchlist.description && (
          <p className="text-sm text-muted-foreground">
            {watchlist.description}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            Add supplier
          </h3>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Select
                value={pickedSupplierId}
                onValueChange={setPickedSupplierId}
              >
                <SelectTrigger data-testid="select-add-supplier" aria-label="Add supplier to watchlist">
                  <SelectValue placeholder="Select a supplier" />
                </SelectTrigger>
                <SelectContent>
                  {availableSuppliers.length === 0 && (
                    <SelectItem value="__none__" disabled>
                      All suppliers already on this list
                    </SelectItem>
                  )}
                  {availableSuppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              data-testid="button-add-supplier"
              disabled={!pickedSupplierId || addM.isPending}
              onClick={() => {
                addM.mutate({
                  id: watchlist.id,
                  data: { supplierId: pickedSupplierId },
                });
                setPickedSupplierId("");
              }}
            >
              {addM.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
            </Button>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            Or add by external entity UID
          </h3>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                value={entityUid}
                onChange={(e) => setEntityUid(e.target.value)}
                placeholder="e.g. ofac:12345 or sec:0000320193"
                data-testid="input-entity-uid"
              />
            </div>
            <Button
              data-testid="button-add-entity"
              disabled={!entityUid.trim() || addM.isPending}
              onClick={() => {
                addM.mutate({
                  id: watchlist.id,
                  data: { entityUid: entityUid.trim() },
                });
                setEntityUid("");
              }}
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </section>

        <section>
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Members ({members.length})
          </h3>
          {detailQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : members.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No members yet. Add suppliers or entity UIDs above.
            </div>
          ) : (
            <ul className="divide-y" data-testid="list-watchlist-members">
              {members.map((m) => {
                const sup = m.supplierId
                  ? supplierById.get(m.supplierId)
                  : null;
                const label = sup
                  ? sup.name
                  : m.entityUid ?? m.supplierId ?? "?";
                return (
                  <li
                    key={m.id}
                    className="py-2 flex items-center gap-2"
                    data-testid={`row-member-${m.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {label}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {m.supplierId ? "Supplier" : "External entity"}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        removeM.mutate({
                          id: watchlist.id,
                          memberId: m.id,
                        })
                      }
                      disabled={
                        removeM.isPending &&
                        removeM.variables?.memberId === m.id
                      }
                      data-testid={`button-remove-member-${m.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

// ---------- Create dialog ----------

function CreateWatchlistDialog({
  open,
  onOpenChange,
  busy,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  busy: boolean;
  onCreate: (data: {
    name: string;
    description?: string;
    scope?: "personal" | "team";
  }) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"personal" | "team">("team");

  const reset = () => {
    setName("");
    setDescription("");
    setScope("team");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent data-testid="dialog-create-watchlist">
        <DialogHeader>
          <DialogTitle>New watchlist</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wl-name">Name</Label>
            <Input
              id="wl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Strategic semiconductor suppliers"
              data-testid="input-watchlist-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wl-desc">Description</Label>
            <Textarea
              id="wl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why this list exists, who owns it, what alerts care about it…"
              data-testid="input-watchlist-description"
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wl-scope">Scope</Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as "personal" | "team")}
            >
              <SelectTrigger
                id="wl-scope"
                data-testid="select-watchlist-scope"
                aria-label="Watchlist scope"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="team">
                  Team — visible to everyone in this org
                </SelectItem>
                <SelectItem value="personal">
                  Personal — only used by your subscriptions
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || busy}
            onClick={() =>
              onCreate({
                name: name.trim(),
                description: description.trim() || undefined,
                scope,
              })
            }
            data-testid="button-create-watchlist"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Plus className="w-4 h-4 mr-2" />
            )}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
