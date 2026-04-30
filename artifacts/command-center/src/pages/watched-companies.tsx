/**
 * Watched Companies — admin page for the tenant-curated list of corporate
 * filers the SEC EDGAR and UK Companies House collectors poll on this
 * tenant's behalf. The endpoints already exist (see
 * `routes/watched-issuers.ts`); this page is the self-serve UI so admins
 * no longer have to call the API by hand.
 *
 * Two tabs (one per source) keep the picker simple: each row in a tab
 * uses the same identifier shape (CIK vs Companies House number), so
 * the form fields and validation hints can be source-specific without
 * a polymorphic single-form mess.
 *
 * Empty-state copy mirrors the collector's behaviour: when no tenant
 * has any rows for a source, the collector falls back to its built-in
 * default list, so admins know the curation is opt-in, not required.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListWatchedIssuers,
  useAddWatchedIssuer,
  useRemoveWatchedIssuer,
  useListSuppliers,
  getListWatchedIssuersQueryKey,
  type WatchedIssuer,
  type WatchedIssuerSource,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format";
import {
  Eye,
  Loader2,
  Plus,
  Trash2,
  Building2,
  Landmark,
} from "lucide-react";

type SourceMeta = {
  value: WatchedIssuerSource;
  label: string;
  identifierLabel: string;
  identifierPlaceholder: string;
  identifierHint: string;
  emptyHint: string;
};

const SOURCES: ReadonlyArray<SourceMeta> = [
  {
    value: "sec_edgar",
    label: "SEC EDGAR",
    identifierLabel: "CIK",
    identifierPlaceholder: "e.g. 320193 or 0000320193",
    identifierHint:
      "SEC Central Index Key. Numeric only — we'll zero-pad to 10 digits on save.",
    emptyHint:
      "No SEC filers on your watch list. We'll fall back to the built-in default list of issuers until you add your own.",
  },
  {
    value: "companies_house",
    label: "Companies House",
    identifierLabel: "Company number",
    identifierPlaceholder: "e.g. 02099887 or SC123456",
    identifierHint:
      "UK Companies House number. Either 8 digits or a 2-letter prefix (SC / NI / OC…) followed by 6 digits.",
    emptyHint:
      "No UK filers on your watch list. We'll fall back to the built-in default list of UK companies until you add your own.",
  },
];

export default function WatchedCompanies() {
  const [tab, setTab] = useState<WatchedIssuerSource>("sec_edgar");
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<WatchedIssuer | null>(
    null,
  );

  const activeMeta = SOURCES.find((s) => s.value === tab) ?? SOURCES[0]!;

  return (
    <div className="p-8 space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            data-testid="text-page-title"
            className="text-3xl font-bold flex items-center gap-2"
          >
            <Eye className="w-7 h-7 text-primary" />
            Watched Companies
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Curate which corporate filers we poll on your behalf. Each row
            tells the SEC EDGAR or UK Companies House collector to fetch
            filings for one company so we can attach them to your suppliers.
          </p>
        </div>
        <Button
          data-testid="button-add-watched"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="w-4 h-4 mr-1" />
          Add company
        </Button>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as WatchedIssuerSource)}
      >
        <TabsList>
          {SOURCES.map((s) => (
            <TabsTrigger
              key={s.value}
              value={s.value}
              data-testid={`tab-${s.value}`}
            >
              {s.value === "sec_edgar" ? (
                <Landmark className="w-4 h-4 mr-1" />
              ) : (
                <Building2 className="w-4 h-4 mr-1" />
              )}
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {SOURCES.map((s) => (
          <TabsContent key={s.value} value={s.value} className="space-y-4">
            <SourceTable
              source={s}
              onDelete={(row) => setPendingDelete(row)}
            />
          </TabsContent>
        ))}
      </Tabs>

      <AddWatchedDialog
        open={addOpen}
        defaultSource={tab}
        onOpenChange={(open) => setAddOpen(open)}
        onAdded={(source) => {
          setTab(source);
          setAddOpen(false);
        }}
      />

      <DeleteWatchedDialog
        row={pendingDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

function SourceTable({
  source,
  onDelete,
}: {
  source: SourceMeta;
  onDelete: (row: WatchedIssuer) => void;
}) {
  const { data, isLoading, error } = useListWatchedIssuers({
    source: source.value,
  });

  const rows = data?.items ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{source.label}</CardTitle>
        <CardDescription>{source.identifierHint}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Loading watch list…
          </div>
        ) : error ? (
          <div
            data-testid={`error-${source.value}`}
            className="text-sm text-red-700 dark:text-red-400 py-4"
          >
            Could not load watch list: {String(error)}
          </div>
        ) : rows.length === 0 ? (
          <div
            data-testid={`empty-${source.value}`}
            className="text-sm text-muted-foreground py-6 text-center"
          >
            {source.emptyHint}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                  <th className="py-2 pr-4 font-medium">Company</th>
                  <th className="py-2 pr-4 font-medium">
                    {source.identifierLabel}
                  </th>
                  <th className="py-2 pr-4 font-medium">Linked supplier</th>
                  <th className="py-2 pr-4 font-medium">Added</th>
                  <th className="py-2 pr-4 font-medium text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    data-testid={`row-watched-${row.id}`}
                    className="border-b last:border-b-0"
                  >
                    <td className="py-3 pr-4">
                      <div className="font-medium">{row.name}</div>
                      {row.ticker || row.lei ? (
                        <div className="flex gap-1 mt-1">
                          {row.ticker ? (
                            <Badge variant="outline" className="text-xs">
                              {row.ticker}
                            </Badge>
                          ) : null}
                          {row.lei ? (
                            <Badge variant="outline" className="text-xs">
                              LEI {row.lei}
                            </Badge>
                          ) : null}
                        </div>
                      ) : null}
                      {row.notes ? (
                        <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {row.notes}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs">
                      {row.identifier}
                    </td>
                    <td className="py-3 pr-4 text-xs">
                      {row.supplierUid ? (
                        <span className="font-mono">{row.supplierUid}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                      {row.createdBy ? (
                        <div className="text-[10px]">by {row.createdBy}</div>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`button-remove-${row.id}`}
                        onClick={() => onDelete(row)}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        Remove
                      </Button>
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

function AddWatchedDialog({
  open,
  defaultSource,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  defaultSource: WatchedIssuerSource;
  onOpenChange: (open: boolean) => void;
  onAdded: (source: WatchedIssuerSource) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [source, setSource] = useState<WatchedIssuerSource>(defaultSource);
  const [identifier, setIdentifier] = useState("");
  const [name, setName] = useState("");
  const [supplierUid, setSupplierUid] = useState<string>("");
  const [ticker, setTicker] = useState("");
  const [lei, setLei] = useState("");
  const [notes, setNotes] = useState("");
  const [supplierSearch, setSupplierSearch] = useState("");

  // Reset form when the dialog opens — keeps stale values from one
  // session bleeding into the next.
  const reset = () => {
    setSource(defaultSource);
    setIdentifier("");
    setName("");
    setSupplierUid("");
    setTicker("");
    setLei("");
    setNotes("");
    setSupplierSearch("");
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  // Sync the source select with the active tab whenever the dialog
  // opens — `useState(defaultSource)` only initialises once, so if the
  // user switches tabs and THEN opens the dialog the initial value would
  // be stale otherwise.
  useEffect(() => {
    if (open) setSource(defaultSource);
  }, [open, defaultSource]);

  const meta = SOURCES.find((s) => s.value === source) ?? SOURCES[0]!;

  // Suppliers list for the optional link picker. Cap at 50 — the search
  // box narrows the cursor server-side so a tenant with thousands of
  // suppliers can still find the right one. We only mount the request
  // when the dialog is open to keep the watched-companies page itself
  // light.
  const supplierParams = supplierSearch
    ? { search: supplierSearch, limit: 50 }
    : { limit: 50 };
  const { data: suppliersData, isLoading: suppliersLoading } =
    useListSuppliers(open ? supplierParams : undefined, {
      query: {
        enabled: open,
        queryKey: ["watched-companies-supplier-picker", open, supplierParams],
      },
    });
  const suppliers = suppliersData?.items ?? [];

  const addM = useAddWatchedIssuer({
    mutation: {
      onSuccess: (row) => {
        toast({
          title: "Company added",
          description: `${row.name} is now on your ${meta.label} watch list.`,
        });
        // Invalidate every variant of the list query (the per-source
        // tab uses one filter, the "all" view uses another) so both
        // tabs re-fetch immediately after a save.
        qc.invalidateQueries({ queryKey: ["/api/watched-issuers"] });
        // Future-proof against orval renaming the URL key by also
        // invalidating the canonical no-args key.
        qc.invalidateQueries({ queryKey: getListWatchedIssuersQueryKey() });
        onAdded(row.source);
      },
      onError: (e: Error) => {
        toast({
          title: "Could not add company",
          description: extractErrorMessage(e),
          variant: "destructive",
        });
      },
    },
  });

  const canSubmit =
    identifier.trim().length > 0 && name.trim().length > 0 && !addM.isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    addM.mutate({
      data: {
        source,
        identifier: identifier.trim(),
        name: name.trim(),
        ...(supplierUid ? { supplierUid } : {}),
        ...(ticker.trim() ? { ticker: ticker.trim() } : {}),
        ...(lei.trim() ? { lei: lei.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-xl"
        data-testid="dialog-add-watched"
      >
        <DialogHeader>
          <DialogTitle>Add a company to your watch list</DialogTitle>
          <DialogDescription>
            We'll start polling this company's filings on the next
            collector run. You can link it to a supplier so the signals
            attach directly to that supplier card.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="source">Source</Label>
            <Select
              value={source}
              onValueChange={(v) => setSource(v as WatchedIssuerSource)}
            >
              <SelectTrigger id="source" data-testid="select-source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="identifier">{meta.identifierLabel}</Label>
            <Input
              id="identifier"
              data-testid="input-identifier"
              placeholder={meta.identifierPlaceholder}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {meta.identifierHint}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="name">Company name</Label>
            <Input
              id="name"
              data-testid="input-name"
              placeholder="e.g. Apple Inc."
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="supplier">Linked supplier (optional)</Label>
            <Input
              id="supplier-search"
              data-testid="input-supplier-search"
              placeholder="Search suppliers…"
              value={supplierSearch}
              onChange={(e) => setSupplierSearch(e.target.value)}
              className="mb-2"
            />
            <Select
              value={supplierUid || "__none__"}
              onValueChange={(v) =>
                setSupplierUid(v === "__none__" ? "" : v)
              }
            >
              <SelectTrigger id="supplier" data-testid="select-supplier">
                <SelectValue placeholder="No supplier link" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No supplier link</SelectItem>
                {suppliersLoading ? (
                  <SelectItem value="__loading__" disabled>
                    Loading…
                  </SelectItem>
                ) : (
                  suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Linking is optional but recommended — it lets filings show
              up directly on the supplier page.
            </p>
          </div>

          {source === "sec_edgar" ? (
            <div className="space-y-1.5">
              <Label htmlFor="ticker">Ticker (optional)</Label>
              <Input
                id="ticker"
                data-testid="input-ticker"
                placeholder="e.g. AAPL"
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="lei">LEI (optional)</Label>
            <Input
              id="lei"
              data-testid="input-lei"
              placeholder="20-char Legal Entity Identifier"
              value={lei}
              onChange={(e) => setLei(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea
              id="notes"
              data-testid="input-notes"
              placeholder="Why are you watching this company?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={addM.isPending}
          >
            Cancel
          </Button>
          <Button
            data-testid="button-submit-add"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {addM.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Adding…
              </>
            ) : (
              <>
                <Plus className="w-4 h-4 mr-1" />
                Add company
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteWatchedDialog({
  row,
  onClose,
}: {
  row: WatchedIssuer | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const removeM = useRemoveWatchedIssuer({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Company removed",
          description: row
            ? `${row.name} is no longer on your watch list.`
            : undefined,
        });
        qc.invalidateQueries({ queryKey: ["/api/watched-issuers"] });
        qc.invalidateQueries({ queryKey: getListWatchedIssuersQueryKey() });
        onClose();
      },
      onError: (e: Error) => {
        toast({
          title: "Could not remove",
          description: extractErrorMessage(e),
          variant: "destructive",
        });
      },
    },
  });

  return (
    <AlertDialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent data-testid="dialog-remove-watched">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove from watch list?</AlertDialogTitle>
          <AlertDialogDescription>
            {row
              ? `We'll stop polling ${row.name} (${row.identifier}). Existing signals already collected stay in your history.`
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removeM.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="button-confirm-remove"
            onClick={(e) => {
              e.preventDefault();
              if (row) removeM.mutate({ id: row.id });
            }}
            disabled={removeM.isPending}
          >
            {removeM.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Removing…
              </>
            ) : (
              <>
                <Trash2 className="w-4 h-4 mr-1" />
                Remove
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The orval `customFetch` wrapper throws plain `Error` whose message is
 * the JSON body. We want to show the human-readable `error` field if
 * present, falling back to the raw string.
 */
function extractErrorMessage(e: Error): string {
  const msg = e.message ?? String(e);
  try {
    const parsed = JSON.parse(msg);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    /* not JSON — fall through */
  }
  return msg;
}

