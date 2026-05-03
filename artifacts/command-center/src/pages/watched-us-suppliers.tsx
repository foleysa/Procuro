/**
 * Watched US Suppliers — admin page for the tenant-curated list of US
 * suppliers polled by the EPA ECHO and DOL OSHA collectors.
 *
 * The page is intentionally minimal: a single table with an
 * inline-add form and a per-row remove button. Fresh installs are
 * auto-seeded server-side (`us_supplier_seed`) so the table is never
 * empty on day one.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUsSuppliers,
  useAddUsSupplier,
  useRemoveUsSupplier,
  getListUsSuppliersQueryKey,
  type UsSupplier,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format";
import { Flag, Loader2, Plus, Trash2 } from "lucide-react";

function sourceBadge(s: string): { label: string; tone: string } {
  if (s === "us_supplier_seed") {
    return { label: "Starter seed", tone: "bg-amber-50 text-amber-700 border-amber-200" };
  }
  if (s === "admin") {
    return { label: "Added by admin", tone: "bg-blue-50 text-blue-700 border-blue-200" };
  }
  return { label: s, tone: "bg-slate-50 text-slate-700 border-slate-200" };
}

export default function WatchedUsSuppliers() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");

  const { data, isLoading } = useListUsSuppliers();
  const items: UsSupplier[] = useMemo(() => data?.items ?? [], [data]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListUsSuppliersQueryKey() });

  const addMutation = useAddUsSupplier({
    mutation: {
      onSuccess: () => {
        setName("");
        toast({ title: "US supplier added" });
        void invalidate();
      },
      onError: (err: unknown) => {
        const e = err as { status?: number; data?: { error?: string } };
        toast({
          variant: "destructive",
          title: e.status === 409 ? "Already on the list" : "Couldn't add supplier",
          description: e.data?.error,
        });
      },
    },
  });

  const removeMutation = useRemoveUsSupplier({
    mutation: {
      onSuccess: () => {
        toast({ title: "Removed" });
        void invalidate();
      },
      onError: (err: unknown) => {
        const e = err as { data?: { error?: string } };
        toast({
          variant: "destructive",
          title: "Couldn't remove supplier",
          description: e.data?.error,
        });
      },
    },
  });

  const onAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    addMutation.mutate({ data: { name: trimmed } });
  };

  return (
    <div className="p-6 md:p-8 space-y-6">
      <div className="flex items-start gap-3">
        <Flag className="h-6 w-6 text-blue-600 mt-1" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Watched US Suppliers
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl mt-1">
            Suppliers on this list are polled by the EPA ECHO and DOL OSHA
            collectors so environmental enforcement and workplace-safety
            inspections show up on the Supplier Risk timeline. Fresh
            workspaces are seeded with well-known US public companies so
            the timeline isn&rsquo;t empty on day one — replace them with
            your own as you go.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a US supplier</CardTitle>
          <CardDescription>
            Use the supplier&rsquo;s legal display name — that&rsquo;s the
            string the EPA and OSHA endpoints search against.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col sm:flex-row gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onAdd();
            }}
          >
            <Input
              placeholder="e.g. Acme Manufacturing Corp."
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              aria-label="Supplier name"
            />
            <Button
              type="submit"
              disabled={addMutation.isPending || name.trim().length === 0}
            >
              {addMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            On the watch list{" "}
            <span className="text-muted-foreground font-normal">
              ({items.length})
            </span>
          </CardTitle>
          <CardDescription>
            Removing a row stops both collectors from polling it on the next
            scheduled tick.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6">
              No US suppliers yet. Add one above to start populating the
              supplier-risk timeline.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const badge = sourceBadge(item.sourceSystem);
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={badge.tone}>
                          {badge.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(item.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            removeMutation.mutate({ id: item.id })
                          }
                          disabled={
                            removeMutation.isPending &&
                            removeMutation.variables?.id === item.id
                          }
                          aria-label={`Remove ${item.name}`}
                        >
                          {removeMutation.isPending &&
                          removeMutation.variables?.id === item.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4 text-rose-600" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
