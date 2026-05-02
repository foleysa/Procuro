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

import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListWatchedIssuers,
  useListWatchedIssuerSuggestions,
  useAddWatchedIssuer,
  useRemoveWatchedIssuer,
  useBulkAddWatchedIssuers,
  useListSuppliers,
  getListWatchedIssuersQueryKey,
  getListWatchedIssuerSuggestionsQueryKey,
  type WatchedIssuer,
  type WatchedIssuerSource,
  type BulkAddWatchedIssuerRow,
  type BulkAddWatchedIssuerResultItem,
  type BulkAddWatchedIssuersResponse,
  type WatchedIssuerSuggestion,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format";
import {
  Eye,
  Loader2,
  Plus,
  Trash2,
  Building2,
  Landmark,
  Upload,
  AlertCircle,
  CheckCircle2,
  SkipForward,
  Copy,
  Sparkles,
  Check,
  Info,
  RefreshCw,
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

/**
 * Confidence tiers mirror the engine's CONFIDENCE_EXACT / _STRONG / _WEAK
 * thresholds in `suggest-watched-issuers.ts`. We bucket the float here
 * so the badge copy stays in sync with the engine without having to
 * hardcode a numeric scale in user-facing strings.
 */
type ConfidenceTier = {
  label: "Exact" | "Strong" | "Needs review";
  description: string;
  badgeClass: string;
};

function tierFor(confidence: number): ConfidenceTier {
  if (confidence >= 0.95) {
    return {
      label: "Exact",
      description:
        "Normalised name matched exactly after stripping legal suffixes — high-confidence auto-confirm.",
      badgeClass:
        "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900",
    };
  }
  if (confidence >= 0.75) {
    return {
      label: "Strong",
      description:
        "Multiple significant tokens overlap — confirm to add to your watch list.",
      badgeClass:
        "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200 border-blue-200 dark:border-blue-900",
    };
  }
  return {
    label: "Needs review",
    description:
      "Single weak token overlap — double-check the company name before confirming.",
    badgeClass:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200 border-amber-200 dark:border-amber-900",
  };
}

function viaLabel(via: WatchedIssuerSuggestion["via"]): string {
  switch (via) {
    case "sec":
      return "SEC EDGAR ticker index";
    case "gleif":
      return "GLEIF (LEI confirmed)";
    case "companies_house":
      return "Companies House search";
  }
}

function sourceLabel(source: WatchedIssuerSource): string {
  return SOURCES.find((s) => s.value === source)?.label ?? source;
}

export default function WatchedCompanies() {
  const [tab, setTab] = useState<WatchedIssuerSource>("sec_edgar");
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
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
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            data-testid="button-import-csv"
            onClick={() => setImportOpen(true)}
          >
            <Upload className="w-4 h-4 mr-1" />
            Import CSV
          </Button>
          <Button
            data-testid="button-add-watched"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="w-4 h-4 mr-1" />
            Add company
          </Button>
        </div>
      </div>

      <SuggestionsSection
        onConfirmedSwitchTab={(source) => setTab(source)}
      />

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

      <ImportCsvDialog
        open={importOpen}
        defaultSource={activeMeta.value}
        onOpenChange={setImportOpen}
        onImported={(source) => {
          if (source) setTab(source);
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
 * Suggested watched-issuer matches for tenant suppliers.
 *
 * The engine joins each supplier against SEC EDGAR / GLEIF / Companies
 * House and returns ranked candidates with a confidence score and a
 * human reason. We bucket the float into three tiers (Exact / Strong /
 * Needs review) so admins can audit before clicking Confirm — that
 * payoff is the whole point of this surface.
 *
 * Suggestions are grouped by supplier so an admin who has 12 suppliers
 * with matches doesn't have to scan a flat list looking for which row
 * belongs to whom. Within a supplier we keep the engine's confidence-
 * descending order — the most likely match is at the top.
 *
 * Confirming a row POSTs through the existing `useAddWatchedIssuer`
 * hook (the same one the manual Add dialog uses), then invalidates
 * both the watch-list and the suggestions queries so the row hops
 * straight from the suggestions list into the per-source watch table.
 */
function SuggestionsSection({
  onConfirmedSwitchTab,
}: {
  onConfirmedSwitchTab: (source: WatchedIssuerSource) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, error, refetch, isRefetching } =
    useListWatchedIssuerSuggestions(undefined, {
      query: {
        queryKey: getListWatchedIssuerSuggestionsQueryKey(),
        // Suggestions hit upstream APIs (SEC, GLEIF, optionally Companies
        // House) so they're slow and expensive — never refetch on focus.
        // Admins can hit "Refresh" if they want a re-run after a CSV import.
        refetchOnWindowFocus: false,
        staleTime: 5 * 60_000,
      },
    });

  // Track the row currently being POSTed. While any confirm is in
  // flight every Confirm button is disabled — both the row that's
  // posting (so an admin can't double-click it into a 409) and every
  // other row (so two near-simultaneous confirms can't race the
  // refetch and briefly show stale state).
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const addM = useAddWatchedIssuer({
    mutation: {
      onSuccess: (row) => {
        toast({
          title: "Watched issuer confirmed",
          description: `${row.name} is now on your ${sourceLabel(row.source)} watch list.`,
        });
        // Both the watch-list table AND the suggestions list need to
        // refresh: the new row should appear in the table and disappear
        // from the suggestions (the engine drops `(source, identifier)`
        // already on the watch list).
        qc.invalidateQueries({ queryKey: ["/api/watched-issuers"] });
        qc.invalidateQueries({ queryKey: getListWatchedIssuersQueryKey() });
        qc.invalidateQueries({
          queryKey: getListWatchedIssuerSuggestionsQueryKey(),
        });
        // Hop the visible tab to the source we just confirmed so the
        // admin can immediately see the new row.
        onConfirmedSwitchTab(row.source);
      },
      onError: (e: Error) => {
        toast({
          title: "Could not confirm suggestion",
          description: extractErrorMessage(e),
          variant: "destructive",
        });
      },
      onSettled: () => setPendingKey(null),
    },
  });

  // Group suggestions by supplier — easier to scan than a flat list when
  // a tenant has matches across many suppliers. Order of suppliers
  // mirrors the order they first appear in the engine response (which
  // is itself confidence-sorted), so the most "interesting" supplier
  // floats to the top.
  const grouped = useMemo(() => {
    const items = data?.items ?? [];
    const order: string[] = [];
    const map = new Map<
      string,
      { supplierName: string; rows: WatchedIssuerSuggestion[] }
    >();
    for (const s of items) {
      const existing = map.get(s.supplierUid);
      if (existing) {
        existing.rows.push(s);
      } else {
        map.set(s.supplierUid, { supplierName: s.supplierName, rows: [s] });
        order.push(s.supplierUid);
      }
    }
    return order.map((uid) => ({
      supplierUid: uid,
      supplierName: map.get(uid)!.supplierName,
      rows: map.get(uid)!.rows,
    }));
  }, [data]);

  const handleConfirm = (s: WatchedIssuerSuggestion) => {
    if (pendingKey) return;
    setPendingKey(s.key);
    addM.mutate({
      data: {
        source: s.source,
        identifier: s.identifier,
        name: s.name,
        supplierUid: s.supplierUid,
        ...(s.ticker ? { ticker: s.ticker } : {}),
        ...(s.lei ? { lei: s.lei } : {}),
      },
    });
  };

  return (
    <Card data-testid="card-watched-suggestions">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              Suggested matches for your suppliers
            </CardTitle>
            <CardDescription>
              We cross-checked your supplier list against SEC EDGAR, GLEIF,
              and (where applicable) UK Companies House. Confirm a row to
              add it to your watch list — we'll start polling its filings
              on the next collector run.
            </CardDescription>
          </div>
          <Button
            data-testid="button-refresh-suggestions"
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading || isRefetching}
          >
            {isRefetching ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
            )}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div
            data-testid="loading-suggestions"
            className="flex items-center text-sm text-muted-foreground py-4"
          >
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Looking for matches…
          </div>
        ) : error ? (
          <div
            data-testid="error-suggestions"
            className="text-sm text-red-700 dark:text-red-400 py-4"
          >
            Could not load suggestions: {extractErrorMessage(error as Error)}
          </div>
        ) : grouped.length === 0 ? (
          <div
            data-testid="empty-suggestions"
            className="text-sm text-muted-foreground py-6 text-center"
          >
            No new matches right now.{" "}
            {data && data.suppliersConsidered > 0
              ? `Checked ${data.suppliersConsidered} supplier${data.suppliersConsidered === 1 ? "" : "s"}`
              : "Add suppliers to your master list and we'll surface filer matches here"}
            {data && data.suppliersSkippedAlreadyWatched > 0
              ? ` (${data.suppliersSkippedAlreadyWatched} already curated).`
              : "."}
          </div>
        ) : (
          <div className="space-y-5">
            {grouped.map((group) => (
              <div
                key={group.supplierUid}
                data-testid={`suggestion-group-${group.supplierUid}`}
                className="space-y-2"
              >
                <div className="flex items-baseline gap-2">
                  <div className="text-sm font-semibold">
                    {group.supplierName}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {group.supplierUid}
                  </div>
                </div>
                <div className="border rounded-md divide-y">
                  {group.rows.map((s) => (
                    <SuggestionRow
                      key={s.key}
                      suggestion={s}
                      onConfirm={handleConfirm}
                      pending={pendingKey === s.key}
                      anyPending={pendingKey !== null}
                    />
                  ))}
                </div>
              </div>
            ))}
            {data && data.suppliersSkippedAlreadyWatched > 0 ? (
              <div
                data-testid="suggestions-footer-summary"
                className="text-xs text-muted-foreground pt-2 border-t"
              >
                {data.suppliersSkippedAlreadyWatched} supplier
                {data.suppliersSkippedAlreadyWatched === 1 ? "" : "s"} skipped —
                already linked to a watched issuer.
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SuggestionRow({
  suggestion,
  onConfirm,
  pending,
  anyPending,
}: {
  suggestion: WatchedIssuerSuggestion;
  onConfirm: (s: WatchedIssuerSuggestion) => void;
  pending: boolean;
  anyPending: boolean;
}) {
  const tier = tierFor(suggestion.confidence);
  const sourceMeta =
    SOURCES.find((s) => s.value === suggestion.source) ?? SOURCES[0]!;
  const sourceIcon =
    suggestion.source === "sec_edgar" ? (
      <Landmark className="w-3.5 h-3.5" />
    ) : (
      <Building2 className="w-3.5 h-3.5" />
    );

  return (
    <div
      data-testid={`suggestion-row-${suggestion.key}`}
      className="flex items-start gap-3 p-3"
    >
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={`text-xs gap-1 ${tier.badgeClass}`}
            data-testid={`badge-confidence-${suggestion.key}`}
            data-tier={tier.label}
          >
            {tier.label === "Exact" ? <Check className="w-3 h-3" /> : null}
            {tier.label}
          </Badge>
          <Badge variant="secondary" className="text-xs gap-1">
            {sourceIcon}
            {sourceMeta.label}
          </Badge>
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid={`button-why-${suggestion.key}`}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                aria-label="Why we suggested this"
              >
                <Info className="w-3.5 h-3.5" />
                Why?
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              className="max-w-xs text-left"
              data-testid={`tooltip-why-${suggestion.key}`}
            >
              <div className="space-y-1">
                <div className="font-semibold">{tier.label} match</div>
                <div>{suggestion.matchReason}</div>
                <div className="opacity-80">
                  Source: {viaLabel(suggestion.via)}
                </div>
                <div className="opacity-80">{tier.description}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="text-sm font-medium">{suggestion.name}</div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">
            {sourceMeta.identifierLabel}: {suggestion.identifier}
          </span>
          {suggestion.ticker ? (
            <Badge variant="outline" className="text-[10px]">
              {suggestion.ticker}
            </Badge>
          ) : null}
          {suggestion.lei ? (
            <Badge variant="outline" className="text-[10px]">
              LEI {suggestion.lei}
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="shrink-0">
        <Button
          size="sm"
          data-testid={`button-confirm-${suggestion.key}`}
          onClick={() => onConfirm(suggestion)}
          // Lock the row that's confirming AND every other row while a
          // mutation is in flight — prevents an admin from racing two
          // confirms which would briefly show stale rows.
          disabled={pending || anyPending}
        >
          {pending ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              Confirming…
            </>
          ) : (
            <>
              <Check className="w-3.5 h-3.5 mr-1" />
              Confirm
            </>
          )}
        </Button>
      </div>
    </div>
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

/**
 * Columns we accept in the upload. `source`, `identifier`, and `name` are
 * required; everything else is forwarded as-is to the bulk endpoint where
 * the existing zod schema enforces length and shape.
 */
const CSV_COLUMNS = [
  "source",
  "identifier",
  "name",
  "supplierUid",
  "ticker",
  "lei",
  "notes",
] as const;

const REQUIRED_CSV_COLUMNS: ReadonlyArray<(typeof CSV_COLUMNS)[number]> = [
  "source",
  "identifier",
  "name",
];

const CSV_EXAMPLE = `source,identifier,name,supplierUid,ticker,lei,notes
sec_edgar,320193,Apple Inc.,,AAPL,HWUPKR0MPOU8FGXBT394,Watch quarterly 10-Qs
sec_edgar,789019,Microsoft Corp.,sup_msft,MSFT,,
companies_house,02099887,BP P.L.C.,,,,
companies_house,SC123456,Example Scottish Co.,,,,`;

type ParsedCsvRow = {
  /** 1-based source line in the CSV file (header counts as line 1). */
  line: number;
  data: Record<string, string>;
};

type CsvParseError = {
  line: number;
  message: string;
};

type CsvParseResult = {
  rows: BulkAddWatchedIssuerRow[];
  errors: CsvParseError[];
  totalRows: number;
};

/**
 * Validate one parsed CSV row against the bulk-import contract. Returns
 * either a `BulkAddWatchedIssuerRow` ready to ship, or an error message.
 *
 * We deliberately keep the client-side checks coarse — the server is
 * still the source of truth (it normalises CIKs, runs shape checks,
 * looks up suppliers). The frontend is just here to catch the obvious
 * "you forgot the source column" / "we don't recognise sec_edgar_us"
 * problems before sending.
 */
function rowToBulkPayload(
  raw: ParsedCsvRow,
): { ok: true; row: BulkAddWatchedIssuerRow } | { ok: false; message: string } {
  const data = raw.data;
  for (const col of REQUIRED_CSV_COLUMNS) {
    const v = data[col]?.trim();
    if (!v) {
      return { ok: false, message: `Missing required column "${col}"` };
    }
  }
  const source = data["source"]!.trim();
  if (source !== "sec_edgar" && source !== "companies_house") {
    return {
      ok: false,
      message: `Unknown source "${source}". Expected "sec_edgar" or "companies_house".`,
    };
  }
  const optional = (col: string): string | undefined => {
    const v = data[col]?.trim();
    return v && v.length > 0 ? v : undefined;
  };
  const row: BulkAddWatchedIssuerRow = {
    line: raw.line,
    source: source as WatchedIssuerSource,
    identifier: data["identifier"]!.trim(),
    name: data["name"]!.trim(),
  };
  const supplierUid = optional("supplierUid");
  if (supplierUid) row.supplierUid = supplierUid;
  const ticker = optional("ticker");
  if (ticker) row.ticker = ticker;
  const lei = optional("lei");
  if (lei) row.lei = lei;
  const notes = optional("notes");
  if (notes) row.notes = notes;
  return { ok: true, row };
}

/**
 * Parse the file with papaparse, then map each data row through
 * `rowToBulkPayload`. We keep the line numbers honest so the per-row
 * error report (both client- and server-side) lines up with what the
 * admin sees in their spreadsheet.
 */
function parseCsv(text: string): CsvParseResult {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  const errors: CsvParseError[] = [];
  for (const e of result.errors) {
    // PapaParse rows are 0-based and exclude the header row, so add 2
    // to land on the 1-based file line the admin sees.
    const line = typeof e.row === "number" ? e.row + 2 : 1;
    errors.push({ line, message: e.message });
  }

  const headerFields = result.meta.fields ?? [];
  const missingHeaders = REQUIRED_CSV_COLUMNS.filter(
    (c) => !headerFields.includes(c),
  );
  if (missingHeaders.length > 0) {
    errors.push({
      line: 1,
      message: `CSV is missing required column(s): ${missingHeaders.join(", ")}. Expected header row with at least: ${REQUIRED_CSV_COLUMNS.join(",")}`,
    });
    return { rows: [], errors, totalRows: 0 };
  }

  const rows: BulkAddWatchedIssuerRow[] = [];
  result.data.forEach((data, i) => {
    const line = i + 2; // +1 for 1-indexed, +1 for header row
    const parsed = rowToBulkPayload({ line, data });
    if (parsed.ok) {
      rows.push(parsed.row);
    } else {
      errors.push({ line, message: parsed.message });
    }
  });

  return { rows, errors, totalRows: result.data.length };
}

function ImportCsvDialog({
  open,
  defaultSource,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  defaultSource: WatchedIssuerSource;
  onOpenChange: (open: boolean) => void;
  onImported: (source: WatchedIssuerSource | null) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsedRows, setParsedRows] = useState<BulkAddWatchedIssuerRow[]>([]);
  const [parseErrors, setParseErrors] = useState<CsvParseError[]>([]);
  const [response, setResponse] =
    useState<BulkAddWatchedIssuersResponse | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  // Reset every piece of dialog state whenever the dialog closes —
  // re-opening should give the admin a fresh slate, not a stale
  // success report from the previous import.
  const reset = () => {
    setFileName(null);
    setParsedRows([]);
    setParseErrors([]);
    setResponse(null);
    setReadError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  // The bulk endpoint returns 200 with per-row results even when every
  // row failed (so we can render a proper report) — `onSuccess` is
  // therefore the right hook for ALL outcomes, and we only ever hit
  // `onError` for genuine 4xx/5xx (e.g. body too large).
  const bulkM = useBulkAddWatchedIssuers({
    mutation: {
      onSuccess: (data) => {
        setResponse(data);
        // Refresh both the per-source tabs and the all-sources list so
        // the new rows show up immediately when the admin closes the
        // dialog.
        qc.invalidateQueries({ queryKey: ["/api/watched-issuers"] });
        qc.invalidateQueries({ queryKey: getListWatchedIssuersQueryKey() });
        if (data.createdCount > 0) {
          toast({
            title: `Imported ${data.createdCount} ${
              data.createdCount === 1 ? "company" : "companies"
            }`,
            description:
              data.errorCount > 0 || data.skippedCount > 0
                ? `${data.skippedCount} skipped, ${data.errorCount} failed — see the report below.`
                : "All rows added to your watch list.",
          });
          // Switch to the tab that received rows so the admin sees the
          // newly imported entries. If both sources got rows, prefer the
          // first created row's source.
          const created = data.results.find((r) => r.status === "created");
          onImported(
            (created?.source as WatchedIssuerSource | undefined) ?? null,
          );
        } else {
          toast({
            title: "Nothing imported",
            description: `${data.skippedCount} skipped, ${data.errorCount} failed — see the report below.`,
            variant: "destructive",
          });
        }
      },
      onError: (e: Error) => {
        toast({
          title: "Import failed",
          description: extractErrorMessage(e),
          variant: "destructive",
        });
      },
    },
  });

  const handleFileSelect = async (file: File) => {
    setReadError(null);
    setResponse(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      setParsedRows(parsed.rows);
      setParseErrors(parsed.errors);
    } catch (err) {
      setParsedRows([]);
      setParseErrors([]);
      setReadError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSubmit = () => {
    if (parsedRows.length === 0) return;
    bulkM.mutate({ data: { items: parsedRows } });
  };

  const handleCopyExample = async () => {
    try {
      await navigator.clipboard.writeText(CSV_EXAMPLE);
      toast({ title: "Example copied to clipboard" });
    } catch {
      toast({
        title: "Could not copy",
        description: "Your browser blocked clipboard access.",
        variant: "destructive",
      });
    }
  };

  const canSubmit = parsedRows.length > 0 && !bulkM.isPending && !response;

  // Combined error list for the "fix me" panel — includes both
  // client-side parse errors and server-side per-row errors. Server
  // results win when both are present (server has more context).
  const serverErrors = useMemo<BulkAddWatchedIssuerResultItem[]>(
    () =>
      (response?.results ?? []).filter(
        (r) => r.status === "error" || r.status === "skipped",
      ),
    [response],
  );

  // Hint the admin which source the active tab is on without forcing
  // them to use it — every CSV row carries its own `source` column.
  const sourceLabel =
    SOURCES.find((s) => s.value === defaultSource)?.label ?? defaultSource;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-3xl max-h-[90vh] overflow-y-auto"
        data-testid="dialog-import-csv"
      >
        <DialogHeader>
          <DialogTitle>Import companies from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV with one company per row. Each row's{" "}
            <code className="text-xs">source</code> column controls which
            collector picks it up — you can mix SEC EDGAR and Companies
            House rows in a single file. Currently viewing{" "}
            <strong>{sourceLabel}</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Example panel — always visible so admins can grab the
              header row without a docs page. */}
          <div className="rounded-md border bg-muted/40 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Example (copy-paste into your spreadsheet)
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCopyExample}
                data-testid="button-copy-example"
              >
                <Copy className="w-3.5 h-3.5 mr-1" />
                Copy
              </Button>
            </div>
            <pre
              data-testid="text-csv-example"
              className="text-[11px] font-mono whitespace-pre-wrap leading-snug overflow-x-auto"
            >
              {CSV_EXAMPLE}
            </pre>
            <p className="text-xs text-muted-foreground mt-2">
              Required columns: <code>source</code>, <code>identifier</code>,{" "}
              <code>name</code>. Optional:{" "}
              <code>supplierUid, ticker, lei, notes</code>. <code>source</code>{" "}
              must be either <code>sec_edgar</code> or{" "}
              <code>companies_house</code>.
            </p>
          </div>

          {/* File picker */}
          <div className="space-y-1.5">
            <Label htmlFor="csv-file">CSV file</Label>
            <Input
              id="csv-file"
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              data-testid="input-csv-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFileSelect(f);
              }}
              disabled={bulkM.isPending}
            />
            {fileName ? (
              <p className="text-xs text-muted-foreground">
                Selected: <span className="font-mono">{fileName}</span>
                {parsedRows.length > 0 ? (
                  <>
                    {" "}
                    — {parsedRows.length} valid{" "}
                    {parsedRows.length === 1 ? "row" : "rows"} ready to import
                    {parseErrors.length > 0 ? (
                      <>
                        {", "}
                        <span className="text-amber-600 dark:text-amber-400">
                          {parseErrors.length} parse{" "}
                          {parseErrors.length === 1 ? "error" : "errors"}
                        </span>
                      </>
                    ) : null}
                  </>
                ) : null}
              </p>
            ) : null}
            {readError ? (
              <p
                data-testid="text-read-error"
                className="text-xs text-red-600 dark:text-red-400"
              >
                Could not read file: {readError}
              </p>
            ) : null}
          </div>

          {/* Pre-flight client-side parse errors */}
          {parseErrors.length > 0 ? (
            <div
              data-testid="panel-parse-errors"
              className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">
                <AlertCircle className="w-4 h-4" />
                {parseErrors.length}{" "}
                {parseErrors.length === 1 ? "row" : "rows"} skipped before
                upload
              </div>
              <ul className="text-xs space-y-1 max-h-40 overflow-y-auto">
                {parseErrors.map((e, idx) => (
                  <li
                    key={`${e.line}-${idx}`}
                    className="font-mono"
                    data-testid={`parse-error-${e.line}`}
                  >
                    <span className="text-amber-700 dark:text-amber-400">
                      Line {e.line}:
                    </span>{" "}
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Server-side per-row report */}
          {response ? (
            <div
              data-testid="panel-import-results"
              className="rounded-md border p-3 space-y-3"
            >
              <div className="flex items-center gap-3 text-sm">
                <Badge
                  variant="outline"
                  className="text-green-700 dark:text-green-400"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                  {response.createdCount} created
                </Badge>
                <Badge variant="outline" className="text-muted-foreground">
                  <SkipForward className="w-3.5 h-3.5 mr-1" />
                  {response.skippedCount} skipped
                </Badge>
                <Badge
                  variant="outline"
                  className="text-red-700 dark:text-red-400"
                >
                  <AlertCircle className="w-3.5 h-3.5 mr-1" />
                  {response.errorCount} failed
                </Badge>
                <span className="text-xs text-muted-foreground ml-auto">
                  {response.totalRows} total
                </span>
              </div>
              {serverErrors.length > 0 ? (
                <div className="border-t pt-2">
                  <p className="text-xs font-medium mb-1">
                    Rows that need your attention:
                  </p>
                  <ul className="text-xs space-y-1 max-h-60 overflow-y-auto">
                    {serverErrors.map((r, idx) => (
                      <li
                        key={`${r.line}-${idx}`}
                        className="font-mono"
                        data-testid={`result-error-${r.line}`}
                      >
                        <span
                          className={
                            r.status === "skipped"
                              ? "text-muted-foreground"
                              : "text-red-700 dark:text-red-400"
                          }
                        >
                          Line {r.line} ({r.status}):
                        </span>{" "}
                        {r.identifier ? (
                          <span className="text-muted-foreground">
                            [{r.identifier}]{" "}
                          </span>
                        ) : null}
                        {r.error ?? "(no detail)"}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={bulkM.isPending}
            data-testid="button-import-close"
          >
            {response ? "Close" : "Cancel"}
          </Button>
          {!response ? (
            <Button
              onClick={handleSubmit}
              disabled={!canSubmit}
              data-testid="button-import-submit"
            >
              {bulkM.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Importing…
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-1" />
                  Import {parsedRows.length}{" "}
                  {parsedRows.length === 1 ? "row" : "rows"}
                </>
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

