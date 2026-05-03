import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BookOpen, Loader2, Pencil, Plus, Trash2, X, Check } from "lucide-react";
import {
  useListMethodsAndTools,
  useCreateMethodAndTool,
  useUpdateMethodAndTool,
  useDeleteMethodAndTool,
  getListMethodsAndToolsQueryKey,
  type MethodAndTool,
  type MethodAndToolMaturity,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

const MATURITY_OPTIONS: { value: MethodAndToolMaturity; label: string }[] = [
  { value: "proven", label: "Proven" },
  { value: "emerging", label: "Emerging" },
  { value: "first_run", label: "First-Run" },
];

function maturityLabel(m: MethodAndToolMaturity): string {
  return MATURITY_OPTIONS.find((o) => o.value === m)?.label ?? m;
}

function MaturityBadge({ maturity }: { maturity: MethodAndToolMaturity }) {
  const styles: Record<MethodAndToolMaturity, string> = {
    proven:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    emerging:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    first_run:
      "bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300",
  };
  return (
    <span
      className={`inline-block text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${styles[maturity]}`}
    >
      {maturityLabel(maturity)}
    </span>
  );
}

interface FormState {
  sourcingStrategy: string;
  method: string;
  toolSystem: string;
  maturity: MethodAndToolMaturity;
}

const EMPTY_FORM: FormState = {
  sourcingStrategy: "",
  method: "",
  toolSystem: "",
  maturity: "emerging",
};

export function MethodsAndTools() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const listQ = useListMethodsAndTools();
  const items = listQ.data?.items ?? [];

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [addingNew, setAddingNew] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(EMPTY_FORM);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListMethodsAndToolsQueryKey() });

  const createM = useCreateMethodAndTool({
    mutation: {
      onSuccess: () => {
        invalidate();
        setAddingNew(false);
        setAddForm(EMPTY_FORM);
        toast({ title: "Entry added" });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not add entry",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const updateM = useUpdateMethodAndTool({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditingId(null);
        toast({ title: "Entry updated" });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not update entry",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const deleteM = useDeleteMethodAndTool({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Entry removed" });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not remove entry",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const startEdit = (entry: MethodAndTool) => {
    setEditingId(entry.id);
    setEditForm({
      sourcingStrategy: entry.sourcingStrategy,
      method: entry.method,
      toolSystem: entry.toolSystem,
      maturity: entry.maturity,
    });
  };

  const cancelEdit = () => setEditingId(null);

  const submitEdit = (id: string) => {
    if (
      !editForm.sourcingStrategy.trim() ||
      !editForm.method.trim() ||
      !editForm.toolSystem.trim()
    ) {
      toast({
        title: "All fields are required",
        variant: "destructive",
      });
      return;
    }
    updateM.mutate({ id, data: editForm });
  };

  const submitAdd = () => {
    if (
      !addForm.sourcingStrategy.trim() ||
      !addForm.method.trim() ||
      !addForm.toolSystem.trim()
    ) {
      toast({
        title: "All fields are required",
        variant: "destructive",
      });
      return;
    }
    createM.mutate({ data: addForm });
  };

  const handleDelete = (id: string, label: string) => {
    if (!window.confirm(`Remove "${label}" from the registry?`)) return;
    deleteM.mutate({ id });
  };

  return (
    <Card data-testid="methods-and-tools">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="w-4 h-4 text-muted-foreground" />
              Methods &amp; Tools Registry
            </CardTitle>
            <CardDescription>
              Canonical sourcing strategies mapped to methods, systems, and
              maturity. Edit inline as your practice matures.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="gap-1 shrink-0"
            onClick={() => {
              setAddingNew(true);
              setAddForm(EMPTY_FORM);
            }}
            disabled={addingNew}
            data-testid="btn-add-method"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {listQ.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm"
              data-testid="table-methods-tools"
            >
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Sourcing Strategy</th>
                  <th className="py-2 pr-3 font-medium">Method</th>
                  <th className="py-2 pr-3 font-medium">Tool / System</th>
                  <th className="py-2 pr-3 font-medium">Maturity</th>
                  <th className="py-2 font-medium w-24 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((entry) => {
                  const slug = entry.sourcingStrategy
                    .toLowerCase()
                    .replace(/\W+/g, "-");
                  const isEditing = editingId === entry.id;
                  if (isEditing) {
                    return (
                      <tr key={entry.id} data-testid={`methods-row-${slug}`}>
                        <td className="py-2 pr-3 align-middle">
                          <Input
                            className="h-8 text-xs"
                            value={editForm.sourcingStrategy}
                            onChange={(e) =>
                              setEditForm((f) => ({
                                ...f,
                                sourcingStrategy: e.target.value,
                              }))
                            }
                            data-testid="input-edit-strategy"
                          />
                        </td>
                        <td className="py-2 pr-3 align-middle">
                          <Input
                            className="h-8 text-xs"
                            value={editForm.method}
                            onChange={(e) =>
                              setEditForm((f) => ({
                                ...f,
                                method: e.target.value,
                              }))
                            }
                            data-testid="input-edit-method"
                          />
                        </td>
                        <td className="py-2 pr-3 align-middle">
                          <Input
                            className="h-8 text-xs"
                            value={editForm.toolSystem}
                            onChange={(e) =>
                              setEditForm((f) => ({
                                ...f,
                                toolSystem: e.target.value,
                              }))
                            }
                            data-testid="input-edit-tool"
                          />
                        </td>
                        <td className="py-2 pr-3 align-middle">
                          <Select
                            value={editForm.maturity}
                            onValueChange={(v) =>
                              setEditForm((f) => ({
                                ...f,
                                maturity: v as MethodAndToolMaturity,
                              }))
                            }
                          >
                            <SelectTrigger
                              className="h-8 text-xs"
                              data-testid="select-edit-maturity"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {MATURITY_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-2 align-middle text-right">
                          <div className="inline-flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => submitEdit(entry.id)}
                              disabled={updateM.isPending}
                              data-testid="btn-save-edit"
                            >
                              {updateM.isPending ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Check className="w-3.5 h-3.5" />
                              )}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={cancelEdit}
                              data-testid="btn-cancel-edit"
                            >
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={entry.id} data-testid={`methods-row-${slug}`}>
                      <td className="py-2 pr-3 align-middle font-medium text-xs">
                        {entry.sourcingStrategy}
                      </td>
                      <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                        {entry.method}
                      </td>
                      <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                        {entry.toolSystem}
                      </td>
                      <td className="py-2 pr-3 align-middle">
                        <MaturityBadge maturity={entry.maturity} />
                      </td>
                      <td className="py-2 align-middle text-right">
                        <div className="inline-flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => startEdit(entry)}
                            data-testid={`btn-edit-${slug}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() =>
                              handleDelete(entry.id, entry.sourcingStrategy)
                            }
                            disabled={deleteM.isPending}
                            data-testid={`btn-delete-${slug}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {addingNew && (
                  <tr data-testid="methods-row-new">
                    <td className="py-2 pr-3 align-middle">
                      <Input
                        className="h-8 text-xs"
                        placeholder="Strategy"
                        value={addForm.sourcingStrategy}
                        onChange={(e) =>
                          setAddForm((f) => ({
                            ...f,
                            sourcingStrategy: e.target.value,
                          }))
                        }
                        data-testid="input-new-strategy"
                      />
                    </td>
                    <td className="py-2 pr-3 align-middle">
                      <Input
                        className="h-8 text-xs"
                        placeholder="Method"
                        value={addForm.method}
                        onChange={(e) =>
                          setAddForm((f) => ({
                            ...f,
                            method: e.target.value,
                          }))
                        }
                        data-testid="input-new-method"
                      />
                    </td>
                    <td className="py-2 pr-3 align-middle">
                      <Input
                        className="h-8 text-xs"
                        placeholder="Tool / System"
                        value={addForm.toolSystem}
                        onChange={(e) =>
                          setAddForm((f) => ({
                            ...f,
                            toolSystem: e.target.value,
                          }))
                        }
                        data-testid="input-new-tool"
                      />
                    </td>
                    <td className="py-2 pr-3 align-middle">
                      <Select
                        value={addForm.maturity}
                        onValueChange={(v) =>
                          setAddForm((f) => ({
                            ...f,
                            maturity: v as MethodAndToolMaturity,
                          }))
                        }
                      >
                        <SelectTrigger
                          className="h-8 text-xs"
                          data-testid="select-new-maturity"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MATURITY_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="py-2 align-middle text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={submitAdd}
                          disabled={createM.isPending}
                          data-testid="btn-save-new"
                        >
                          {createM.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Check className="w-3.5 h-3.5" />
                          )}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => {
                            setAddingNew(false);
                            setAddForm(EMPTY_FORM);
                          }}
                          data-testid="btn-cancel-new"
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}
                {items.length === 0 && !addingNew && (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-6 text-center text-xs text-muted-foreground"
                    >
                      No entries yet. Click Add to create one.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
