import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSuppliers,
  useOverrideSupplierBillingCurrency,
  getListSuppliersQueryKey,
  getGetSupplierQueryKey,
  getGetSupplierIntelligenceQueryKey,
  BillingCurrencyConfidence,
  type ListSuppliersParams,
  type Supplier,
  type BillingCurrencySource,
  type BillingCurrencyConfidence as BillingCurrencyConfidenceType,
} from "@workspace/api-client-react";
import {
  Building2,
  Loader2,
  Search,
  Star,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  X,
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  Pencil,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isValidCurrencyShape } from "@/lib/currencies";
import { cn } from "@/lib/utils";

/**
 * `?missing=<field>` deep-link contract — kept narrow on purpose so the
 * data-readiness card and this page agree on what each value means and
 * unknown values are silently dropped instead of returning an unfiltered
 * page that looks like the filter "did nothing".
 */
const MISSING_FIELDS = {
  billing_currency: "Billing currency",
  payment_terms_days: "Payment terms",
} as const;
type MissingField = keyof typeof MISSING_FIELDS;

function readMissingParam(search: string): MissingField | null {
  const v = new URLSearchParams(search).get("missing");
  return v && v in MISSING_FIELDS ? (v as MissingField) : null;
}

// Server-backed `?confidence=<level>` filter; spans pagination so the
// per-page client-side sort doesn't miss low rows on page 2+.
const CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
type ConfidenceFilter = (typeof CONFIDENCE_VALUES)[number];

function readConfidenceParam(search: string): ConfidenceFilter | null {
  const v = new URLSearchParams(search).get("confidence");
  return v && (CONFIDENCE_VALUES as readonly string[]).includes(v)
    ? (v as ConfidenceFilter)
    : null;
}

// Server-backed boolean toggle filters. `?strategic=true` and
// `?preferred=true` narrow the directory to those flags. We only
// accept "true"/"false"; any other value is ignored so reload of a
// hand-edited URL never silently mis-filters.
function readBoolParam(search: string, key: string): boolean | null {
  const v = new URLSearchParams(search).get(key);
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

// `?currency=` filters by ISO 4217 billing currency. Loose 3-letter
// shape check on read so nonsense values don't make it into the API
// call (server also rejects them, but keeping the FE in lockstep
// avoids a wasted round-trip).
function readCurrencyParam(search: string): string | null {
  const v = new URLSearchParams(search).get("currency")?.trim().toUpperCase();
  return v && /^[A-Z]{3}$/.test(v) ? v : null;
}

function readTagParam(search: string): string | null {
  const v = new URLSearchParams(search).get("tag")?.trim();
  return v ? v : null;
}

// Mirrors the source labels used by the Supplier 360 BillingCurrencyCard.
const BILLING_SOURCE_LABEL: Record<BillingCurrencySource, string> = {
  provided: "From supplier feed",
  country: "Auto-detected from country",
  country_dollarized: "Country (dollarized)",
  invoice_iso: "Auto-detected from invoice ISO code",
  invoice_symbol: "Auto-detected from invoice symbol",
  backfill_invoice: "Auto-detected from PO line text",
  manual_override: "Manually overridden",
};

// Sort rank for the Confidence column. Low first when ascending.
function confidenceRank(c: BillingCurrencyConfidenceType | null | undefined): number {
  if (c === "low") return 0;
  if (c === "medium") return 1;
  if (c === "high") return 2;
  return 3;
}

function confidenceBadgeVariant(
  c: BillingCurrencyConfidenceType,
): "default" | "secondary" | "destructive" {
  if (c === "high") return "default";
  if (c === "medium") return "secondary";
  return "destructive";
}

type SortDir = "none" | "asc" | "desc";

// Supplier directory. Doubles as the ingest review screen: surfaces
// billing-currency confidence + source per row and supports inline
// override.
export default function Suppliers() {
  const [search, setSearch] = useState("");
  const [cursorStack, setCursorStack] = useState<string[]>([""]);
  const [sortDir, setSortDir] = useState<SortDir>("none");
  const currentCursor = cursorStack[cursorStack.length - 1] ?? "";

  // Re-read the `?missing=` and `?confidence=` deep-link params on every
  // wouter location change. `?missing=` is used by the data-readiness
  // card; `?confidence=` is the in-page low-confidence quick filter
  // (toggled from the table footer) and is also wired through to the
  // server so it spans pagination.
  const searchString = useSearch();
  const [location, setLocation] = useLocation();
  const missing = readMissingParam(searchString);
  const confidenceFilter = readConfidenceParam(searchString);
  const strategicFilter = readBoolParam(searchString, "strategic");
  const preferredFilter = readBoolParam(searchString, "preferred");
  const currencyFilter = readCurrencyParam(searchString);
  const tagFilter = readTagParam(searchString);

  const params = useMemo<ListSuppliersParams>(() => {
    const p: ListSuppliersParams = { limit: 50 };
    if (search.trim()) p.search = search.trim();
    if (missing) p.missing = missing;
    if (confidenceFilter) p.confidence = confidenceFilter;
    if (strategicFilter !== null) p.strategic = strategicFilter;
    if (preferredFilter !== null) p.preferred = preferredFilter;
    if (currencyFilter) p.currency = currencyFilter;
    if (tagFilter) p.tag = tagFilter;
    if (currentCursor) p.cursor = currentCursor;
    return p;
  }, [
    search,
    missing,
    confidenceFilter,
    strategicFilter,
    preferredFilter,
    currencyFilter,
    tagFilter,
    currentCursor,
  ]);

  // Reset pagination whenever filters change so the user never lands
  // on a "page 3" of a freshly narrowed list.
  useEffect(() => {
    setCursorStack([""]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    search,
    missing,
    confidenceFilter,
    strategicFilter,
    preferredFilter,
    currencyFilter,
    tagFilter,
  ]);

  const setUrlParam = (key: string, value: string | null) => {
    const sp = new URLSearchParams(searchString);
    if (value === null) sp.delete(key);
    else sp.set(key, value);
    const next = sp.toString();
    const pathname = location.split("?")[0] ?? location;
    setLocation(`${pathname}${next ? `?${next}` : ""}`, { replace: true });
  };

  const clearMissing = () => setUrlParam("missing", null);
  const toggleLowConfidence = () =>
    setUrlParam("confidence", confidenceFilter === "low" ? null : "low");
  const clearConfidence = () => setUrlParam("confidence", null);
  const toggleStrategic = () =>
    setUrlParam("strategic", strategicFilter === true ? null : "true");
  const togglePreferred = () =>
    setUrlParam("preferred", preferredFilter === true ? null : "true");
  const setCurrencyFilter = (v: string) => {
    const trimmed = v.trim().toUpperCase();
    setUrlParam("currency", trimmed ? trimmed : null);
  };
  const setTagFilter = (v: string) => {
    const trimmed = v.trim();
    setUrlParam("tag", trimmed ? trimmed : null);
  };
  const clearAllFilters = () => {
    const sp = new URLSearchParams(searchString);
    [
      "strategic",
      "preferred",
      "currency",
      "tag",
      "confidence",
      "missing",
    ].forEach((k) => sp.delete(k));
    const next = sp.toString();
    const pathname = location.split("?")[0] ?? location;
    setLocation(`${pathname}${next ? `?${next}` : ""}`, { replace: true });
  };

  const hasActiveFilter =
    strategicFilter !== null ||
    preferredFilter !== null ||
    currencyFilter !== null ||
    tagFilter !== null ||
    confidenceFilter !== null ||
    missing !== null;

  // Cycle: none → asc (low first, the triage default) → desc → none.
  // Limited to the rows on the current page; the cross-page case is
  // covered by the `?confidence=low` quick filter.
  const toggleSort = () => {
    setSortDir((d) => (d === "none" ? "asc" : d === "asc" ? "desc" : "none"));
  };

  const { data, isLoading, isFetching, error } = useListSuppliers(params);

  const sortedItems = useMemo(() => {
    if (!data?.items || sortDir === "none") return data?.items ?? [];
    const sign = sortDir === "asc" ? 1 : -1;
    return [...data.items].sort(
      (a, b) =>
        sign *
        (confidenceRank(a.billingCurrencyConfidence ?? null) -
          confidenceRank(b.billingCurrencyConfidence ?? null)),
    );
  }, [data?.items, sortDir]);

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div>
        <h1
          data-testid="text-page-title"
          className="text-3xl font-bold flex items-center gap-2"
        >
          <Building2 className="w-7 h-7 text-primary" />
          Suppliers
        </h1>
        <p className="text-muted-foreground mt-1">
          Strategic, preferred, and tail vendors. Click any row to open
          the Supplier 360 page.
        </p>
      </div>

      {missing && (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 flex items-center justify-between gap-3"
          data-testid={`missing-banner-${missing}`}
        >
          <div className="flex items-start gap-2 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
            <div>
              <span className="font-medium">
                Showing suppliers missing: {MISSING_FIELDS[missing]}
              </span>
              <p className="text-xs text-muted-foreground mt-0.5">
                Linked from the data-readiness card. Open a supplier to fill the
                missing field, or clear the filter to see everyone.
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearMissing}
            data-testid="btn-clear-missing"
          >
            <X className="w-3 h-3 mr-1" />
            Clear filter
          </Button>
        </div>
      )}

      {confidenceFilter && (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 flex items-center justify-between gap-3"
          data-testid={`confidence-banner-${confidenceFilter}`}
        >
          <div className="flex items-start gap-2 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
            <div>
              <span className="font-medium">
                Showing only {confidenceFilter}-confidence billing-currency detections
              </span>
              <p className="text-xs text-muted-foreground mt-0.5">
                These are the rows the auto-detector is least sure about. Use the
                inline override on a row to confirm or change the currency.
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearConfidence}
            data-testid="btn-clear-confidence"
          >
            <X className="w-3 h-3 mr-1" />
            Clear filter
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="w-5 h-5" />
            Search
          </CardTitle>
          <CardDescription>
            Match against supplier name (case-insensitive).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="Search suppliers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-supplier-search"
            className="max-w-md"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={strategicFilter === true ? "default" : "outline"}
              size="sm"
              onClick={toggleStrategic}
              data-testid="btn-toggle-strategic"
              aria-pressed={strategicFilter === true}
            >
              <Star className="w-3 h-3 mr-1" />
              Strategic only
            </Button>
            <Button
              variant={preferredFilter === true ? "default" : "outline"}
              size="sm"
              onClick={togglePreferred}
              data-testid="btn-toggle-preferred"
              aria-pressed={preferredFilter === true}
            >
              <ShieldCheck className="w-3 h-3 mr-1" />
              Preferred only
            </Button>
            <CurrencyFilterControl
              value={currencyFilter}
              onChange={setCurrencyFilter}
            />
            <TagFilterControl
              value={tagFilter}
              suppliers={data?.items ?? []}
              onChange={setTagFilter}
            />
            <Button
              variant={confidenceFilter === "low" ? "default" : "outline"}
              size="sm"
              onClick={toggleLowConfidence}
              data-testid="btn-toggle-low-confidence"
              aria-pressed={confidenceFilter === "low"}
            >
              <AlertCircle className="w-3 h-3 mr-1" />
              {confidenceFilter === "low"
                ? "Showing low-confidence only"
                : "Show low-confidence detections only"}
            </Button>
            {hasActiveFilter ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearAllFilters}
                data-testid="btn-clear-all-filters"
              >
                <X className="w-3 h-3 mr-1" />
                Clear all filters
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading suppliers…
            </div>
          ) : error ? (
            <div className="text-destructive py-4" data-testid="text-error">
              Failed to load suppliers.
            </div>
          ) : !data || sortedItems.length === 0 ? (
            // Distinguish "the deep-link readiness filter has nothing left
            // to fix" from a generic empty result. Only treat as the
            // celebratory case when the only active filter is the
            // `?missing=` deep-link — a typed search or in-page confidence
            // toggle could equally explain the empty rows and the operator
            // would be misled by the success copy.
            missing &&
            !search.trim() &&
            !confidenceFilter &&
            strategicFilter === null &&
            preferredFilter === null &&
            !currencyFilter &&
            !tagFilter ? (
              <div
                className="py-8 text-center space-y-1"
                data-testid="text-empty-missing-resolved"
                data-missing={missing}
              >
                <CheckCircle2 className="w-6 h-6 text-emerald-600 mx-auto" />
                <div className="font-medium">
                  No suppliers are missing{" "}
                  {MISSING_FIELDS[missing].toLowerCase()} — nothing to fix.
                </div>
                <div className="text-xs text-muted-foreground">
                  Nice work. Clear the filter to see everyone.
                </div>
              </div>
            ) : (
              <div
                className="text-muted-foreground py-8 text-center"
                data-testid="text-empty"
              >
                No suppliers match.
              </div>
            )
          ) : (
            <Table data-testid="table-suppliers">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Billing currency</TableHead>
                  <TableHead
                    aria-sort={
                      sortDir === "asc"
                        ? "ascending"
                        : sortDir === "desc"
                          ? "descending"
                          : "none"
                    }
                  >
                    <button
                      type="button"
                      onClick={toggleSort}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      data-testid="btn-sort-confidence"
                      aria-label={`Sort by confidence (${sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : "unsorted"})`}
                    >
                      Confidence
                      {sortDir === "asc" ? (
                        <ArrowUp className="w-3 h-3" />
                      ) : sortDir === "desc" ? (
                        <ArrowDown className="w-3 h-3" />
                      ) : (
                        <ArrowUpDown className="w-3 h-3 opacity-50" />
                      )}
                    </button>
                  </TableHead>
                  <TableHead>Payment terms</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedItems.map((s) => (
                  <SupplierRow key={s.id} s={s} />
                ))}
              </TableBody>
            </Table>
          )}

          <div className="flex items-center justify-between mt-4">
            <div className="text-xs text-muted-foreground">
              {isFetching ? "Refreshing…" : ""}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cursorStack.length <= 1}
                onClick={() =>
                  setCursorStack((s) => s.slice(0, Math.max(1, s.length - 1)))
                }
                data-testid="btn-prev-page"
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!data?.nextCursor}
                onClick={() =>
                  data?.nextCursor &&
                  setCursorStack((s) => [...s, data.nextCursor!])
                }
                data-testid="btn-next-page"
              >
                Next
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SupplierRow({ s }: { s: Supplier }) {
  const isLow = s.billingCurrencyConfidence === BillingCurrencyConfidence.low;
  return (
    <TableRow
      data-testid={`row-supplier-${s.id}`}
      data-confidence={s.billingCurrencyConfidence ?? "none"}
      className={cn(
        isLow && "bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100/70 dark:hover:bg-amber-950/40",
      )}
    >
      <TableCell>
        <Link
          href={`/suppliers/${s.id}`}
          className="font-medium text-primary hover:underline"
          data-testid={`link-supplier-${s.id}`}
        >
          {s.name}
        </Link>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {s.countryCode ?? "—"}
      </TableCell>
      <TableCell className="text-sm">
        <BillingCurrencyCell s={s} />
      </TableCell>
      <TableCell>
        {s.billingCurrencyConfidence ? (
          <Badge
            variant={confidenceBadgeVariant(s.billingCurrencyConfidence)}
            className="text-[10px]"
            data-testid={`badge-confidence-${s.id}`}
            data-confidence={s.billingCurrencyConfidence}
          >
            {s.billingCurrencyConfidence}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-sm tabular-nums">
        {s.paymentTermsDays ?? <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {(s.tags ?? []).slice(0, 4).map((t) => (
            <Badge key={t} variant="outline" className="text-[10px]">
              {t}
            </Badge>
          ))}
          {(s.tags?.length ?? 0) > 4 ? (
            <span className="text-xs text-muted-foreground">
              +{(s.tags?.length ?? 0) - 4}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          {s.isStrategic ? (
            <Badge variant="default" className="text-[10px]">
              <Star className="w-3 h-3 mr-1" />
              Strategic
            </Badge>
          ) : null}
          {s.isPreferred ? (
            <Badge variant="secondary" className="text-[10px]">
              <ShieldCheck className="w-3 h-3 mr-1" />
              Preferred
            </Badge>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Row cell: currency code + source label + inline override popover.
 */
function BillingCurrencyCell({ s }: { s: Supplier }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(s.billingCurrency ?? "");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const mutation = useOverrideSupplierBillingCurrency({
    mutation: {
      onSuccess: () => {
        // Invalidate every list-suppliers page (including filter
        // permutations) plus the detail caches for THIS supplier so
        // the Supplier 360 page reflects the override too.
        void queryClient.invalidateQueries({
          queryKey: getListSuppliersQueryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: getGetSupplierQueryKey(s.id),
        });
        void queryClient.invalidateQueries({
          queryKey: getGetSupplierIntelligenceQueryKey(s.id),
        });
        setErrMsg(null);
        setOpen(false);
      },
      onError: (err: unknown) => {
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to override billing currency";
        setErrMsg(msg);
      },
    },
  });

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!isValidCurrencyShape(trimmed)) {
      setErrMsg("Enter a 3-letter ISO 4217 currency code (e.g. USD, EUR, JPY).");
      return;
    }
    setErrMsg(null);
    mutation.mutate({
      id: s.id,
      data: { billingCurrency: trimmed.toUpperCase() },
    });
  };

  return (
    <div className="flex items-start gap-2">
      <div className="flex flex-col">
        <span
          className="font-mono tabular-nums"
          data-testid={`text-currency-${s.id}`}
        >
          {s.billingCurrency ?? (
            <span className="text-muted-foreground">—</span>
          )}
        </span>
        {s.billingCurrencySource ? (
          <span
            className="text-[10px] text-muted-foreground"
            data-testid={`text-source-${s.id}`}
            data-source={s.billingCurrencySource}
          >
            {BILLING_SOURCE_LABEL[s.billingCurrencySource]}
          </span>
        ) : null}
      </div>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setDraft(s.billingCurrency ?? "");
            setErrMsg(null);
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            data-testid={`btn-override-${s.id}`}
            aria-label="Override billing currency"
          >
            <Pencil className="w-3 h-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72" align="start">
          <form
            onSubmit={handleSave}
            className="space-y-3"
            data-testid={`form-override-${s.id}`}
          >
            <div className="space-y-1">
              <label
                htmlFor={`input-override-${s.id}`}
                className="text-xs font-medium"
              >
                Override billing currency
              </label>
              <p className="text-[11px] text-muted-foreground">
                Saving stamps the row as a manual override and stops future
                ingests from clobbering it.
              </p>
            </div>
            <Input
              id={`input-override-${s.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              placeholder="USD"
              maxLength={3}
              disabled={mutation.isPending}
              autoComplete="off"
              data-testid={`input-override-${s.id}`}
              className="font-mono uppercase"
            />
            {errMsg ? (
              <p
                className="text-xs text-destructive"
                data-testid={`text-override-error-${s.id}`}
              >
                {errMsg}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
                disabled={mutation.isPending}
                data-testid={`btn-override-cancel-${s.id}`}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={mutation.isPending || !draft.trim()}
                data-testid={`btn-override-save-${s.id}`}
              >
                {mutation.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Currency filter: free-form 3-letter ISO 4217 input. We commit on
 * blur or Enter so the URL param doesn't churn (and the server doesn't
 * fire a request) on every keystroke. Invalid shapes are dropped on
 * commit so the input never lands the page in a "no results because
 * the URL param is garbage" state.
 */
function CurrencyFilterControl({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);
  const commit = () => {
    const trimmed = draft.trim().toUpperCase();
    if (trimmed && !/^[A-Z]{3}$/.test(trimmed)) {
      // Reset to current applied value on invalid input.
      setDraft(value ?? "");
      return;
    }
    onChange(trimmed);
  };
  return (
    <div className="flex items-center gap-1">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder="Currency (e.g. EUR)"
        maxLength={3}
        className="h-9 w-36 font-mono uppercase"
        data-testid="input-filter-currency"
        aria-label="Filter by billing currency"
      />
    </div>
  );
}

/**
 * Tag filter: a Select pre-populated with tags seen on the current
 * page plus a free-form fallback for tags that haven't surfaced yet.
 * The "All tags" sentinel maps to clearing the filter.
 */
function TagFilterControl({
  value,
  suppliers,
  onChange,
}: {
  value: string | null;
  suppliers: Supplier[];
  onChange: (v: string) => void;
}) {
  const ALL = "__all__";
  const knownTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of suppliers) for (const t of s.tags ?? []) set.add(t);
    if (value) set.add(value);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [suppliers, value]);

  return (
    <Select
      value={value ?? ALL}
      onValueChange={(v) => onChange(v === ALL ? "" : v)}
    >
      <SelectTrigger
        className="h-9 w-44"
        data-testid="select-filter-tag"
        aria-label="Filter by tag"
      >
        <SelectValue placeholder="All tags" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL} data-testid="select-tag-all">
          All tags
        </SelectItem>
        {knownTags.map((t) => (
          <SelectItem key={t} value={t} data-testid={`select-tag-${t}`}>
            {t}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
