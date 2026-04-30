/**
 * Contracts list + renewal-calendar surface.
 *
 * Two views share the same query params (status / supplier / category /
 * currency / owner / search) so toggling between "list" and "calendar"
 * never drops the operator's filter context — only the layout changes.
 *
 * The list uses the API's cursor-based pagination (sorted
 * end_date ASC, id ASC). Cursors are server-issued opaque strings; we
 * just keep a small stack of "previous" cursors so the operator can
 * walk back without us having to invert the order.
 *
 * The calendar shows the next 12 months of `endDate`s on a month grid.
 * Cells are colour-coded by `derivedStatus` (active / expiring /
 * expired) so a quick scan reveals where the renewal pressure clusters.
 * Calendar mode pulls a wider page (limit 200) without pagination —
 * 12 months × ~handful of contracts is well inside that ceiling for
 * typical mid-market spend.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  useListContracts,
  ListContractsStatus,
  ListContractsMissing,
  type Contract,
  type ListContractsParams,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatUsd, formatDate } from "@/lib/format";
import {
  Loader2,
  FileText,
  ArrowRight,
  CalendarDays,
  List as ListIcon,
  Bell,
  AlertCircle,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_OPTS = [
  { v: "all", l: "All statuses" },
  { v: ListContractsStatus.expiring, l: "Expiring soon" },
  { v: ListContractsStatus.active, l: "Active" },
  { v: ListContractsStatus.pending, l: "Pending" },
  { v: ListContractsStatus.expired, l: "Expired" },
  { v: ListContractsStatus.cancelled, l: "Cancelled" },
];

/**
 * `?missing=<field>` deep-link contract — used by the data-readiness
 * card so its "Fix this" links land on exactly the contracts that
 * triggered each blocker. Mapped to short labels for the inline banner;
 * unknown values fall through and the page renders unfiltered.
 *
 * Note: `end_date` is intentionally absent — the column is `NOT NULL`
 * in the schema, so a missing-end-date filter could never match. The
 * matching readiness rule deep-links to /contracts unfiltered instead.
 */
const MISSING_LABELS: Record<ListContractsMissing, string> = {
  annual_baseline_usd: "Annual baseline",
  owner: "Owner",
  reference_index: "Reference index",
};

function readMissingParam(search: string): ListContractsMissing | null {
  const v = new URLSearchParams(search).get("missing");
  return v && v in MISSING_LABELS ? (v as ListContractsMissing) : null;
}

type ViewMode = "list" | "calendar";

/**
 * Wouter `useLocation` only models the pathname; `?view=…` lives in
 * `window.location.search`. We re-read the search string on every
 * wouter location change (which fires whenever a `<Link>` triggers
 * `pushState`) and on `popstate` (browser back/forward), so the
 * list↔calendar toggle stays in sync without bringing in a full
 * router upgrade.
 */
function useQueryParam(name: string, locationKey: string): string | null {
  const read = () =>
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get(name);
  const [value, setValue] = useState<string | null>(read);
  useEffect(() => {
    setValue(read());
    const onPop = () => setValue(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [name, locationKey]);
  return value;
}

export default function Contracts() {
  const [location] = useLocation();
  const view: ViewMode =
    useQueryParam("view", location) === "calendar" ? "calendar" : "list";

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [currencyFilter, setCurrencyFilter] = useState<string>("");
  const [ownerFilter, setOwnerFilter] = useState<string>("");

  // Re-read the `?missing=` deep-link param on every wouter location
  // change. Used by the data-readiness card so its "Fix this" links land
  // on exactly the contracts missing the field the blocker measured.
  const searchString = useSearch();
  const missing = readMissingParam(searchString);

  // Cursor stack: each push is the cursor that yielded the *next* page,
  // so to go back we pop the current cursor and use the one underneath.
  // The empty-string sentinel means "first page (no cursor)".
  const [cursorStack, setCursorStack] = useState<string[]>([""]);
  const currentCursor = cursorStack[cursorStack.length - 1] ?? "";

  const params = useMemo<ListContractsParams>(() => {
    const p: ListContractsParams = {
      limit: view === "calendar" ? 200 : 50,
    };
    if (search.trim()) p.search = search.trim();
    if (statusFilter !== "all") {
      p.status = statusFilter as ListContractsParams["status"];
    }
    if (currencyFilter.trim()) p.currency = currencyFilter.trim().toUpperCase();
    if (ownerFilter.trim()) p.owner = ownerFilter.trim();
    if (missing) p.missing = missing;
    if (view !== "calendar" && currentCursor) p.cursor = currentCursor;
    return p;
  }, [
    search,
    statusFilter,
    currencyFilter,
    ownerFilter,
    missing,
    currentCursor,
    view,
  ]);

  const { data, isLoading, error, isFetching } = useListContracts(params);

  // Reset pagination whenever filters change so the operator never sees
  // a "page 3" of a freshly narrowed result set.
  const resetPagination = () => setCursorStack([""]);

  // Reset pagination when the deep-link filter changes too (the user
  // could navigate from `?missing=owner` to `?missing=end_date` via the
  // dashboard card without ever touching the in-page filters).
  useEffect(() => {
    resetPagination();
  }, [missing]);

  // Clearing the deep-link filter strips just the `missing` param so any
  // unrelated query state (e.g. `view=calendar`) survives the reset.
  const clearMissing = () => {
    const sp = new URLSearchParams(window.location.search);
    sp.delete("missing");
    const next = sp.toString();
    const path = `${window.location.pathname}${next ? `?${next}` : ""}`;
    window.history.pushState({}, "", path);
    // wouter's useSearch only re-renders on `popstate`; pushState alone
    // won't notify it.
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1
            data-testid="text-page-title"
            className="text-3xl font-bold flex items-center gap-2"
          >
            <FileText className="w-7 h-7 text-primary" />
            Contracts
          </h1>
          <p className="text-muted-foreground mt-1">
            Renewal pipeline, supplier coverage, and inline edit history.
          </p>
        </div>

        <div
          className="inline-flex rounded-md border bg-card overflow-hidden"
          data-testid="view-toggle"
        >
          <Link
            href="/contracts"
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm",
              view === "list"
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent",
            )}
            data-testid="view-list"
          >
            <ListIcon className="w-4 h-4" />
            List
          </Link>
          <Link
            href="/contracts?view=calendar"
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm border-l",
              view === "calendar"
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent",
            )}
            data-testid="view-calendar"
          >
            <CalendarDays className="w-4 h-4" />
            Calendar
          </Link>
        </div>
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
                Showing contracts missing: {MISSING_LABELS[missing]}
              </span>
              <p className="text-xs text-muted-foreground mt-0.5">
                Linked from the data-readiness card. Open a contract to fill the
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

      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-4 gap-3">
          <Input
            placeholder="Search number or title…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPagination();
            }}
            data-testid="filter-search"
          />
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              resetPagination();
            }}
          >
            <SelectTrigger data-testid="filter-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTS.map((o) => (
                <SelectItem key={o.v} value={o.v}>
                  {o.l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Currency (USD, EUR…)"
            value={currencyFilter}
            onChange={(e) => {
              setCurrencyFilter(e.target.value);
              resetPagination();
            }}
            data-testid="filter-currency"
            maxLength={3}
          />
          <Input
            placeholder="Owner contains…"
            value={ownerFilter}
            onChange={(e) => {
              setOwnerFilter(e.target.value);
              resetPagination();
            }}
            data-testid="filter-owner"
          />
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading contracts…
        </div>
      )}

      {error && (
        <div className="text-destructive" data-testid="error">
          Failed to load contracts.
        </div>
      )}

      {!isLoading && !error && view === "list" && (
        <ListView
          items={data?.items ?? []}
          isFetching={isFetching}
          nextCursor={data?.nextCursor ?? null}
          canGoBack={cursorStack.length > 1}
          onNext={() => {
            if (data?.nextCursor) {
              setCursorStack((s) => [...s, data.nextCursor!]);
            }
          }}
          onBack={() => {
            setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
          }}
        />
      )}

      {!isLoading && !error && view === "calendar" && (
        <CalendarView items={data?.items ?? []} />
      )}
    </div>
  );
}

// ─── List view ───────────────────────────────────────────────────────────

function ListView({
  items,
  isFetching,
  nextCursor,
  canGoBack,
  onNext,
  onBack,
}: {
  items: Contract[];
  isFetching: boolean;
  nextCursor: string | null;
  canGoBack: boolean;
  onNext: () => void;
  onBack: () => void;
}) {
  if (items.length === 0) {
    return (
      <div
        className="bg-card border rounded-lg p-12 text-center text-muted-foreground"
        data-testid="empty-state"
      >
        No contracts match the current filters.
      </div>
    );
  }
  return (
    <>
      <Card>
        <CardContent className="p-0 divide-y">
          {items.map((c) => (
            <ContractRow key={c.id} contract={c} />
          ))}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <Button
          variant="outline"
          size="sm"
          disabled={!canGoBack || isFetching}
          onClick={onBack}
          data-testid="btn-prev-page"
        >
          ← Previous
        </Button>
        <span>
          {items.length} contract{items.length === 1 ? "" : "s"} on this page
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!nextCursor || isFetching}
          onClick={onNext}
          data-testid="btn-next-page"
        >
          Next →
        </Button>
      </div>
    </>
  );
}

function ContractRow({ contract }: { contract: Contract }) {
  return (
    <Link
      href={`/contracts/${contract.id}`}
      data-testid={`contract-${contract.id}`}
      className="flex items-center gap-4 p-4 hover:bg-accent/40 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            {contract.contractNumber}
          </span>
          <span className="truncate">{contract.title}</span>
          {contract.renewalAlertedThresholds.length > 0 && (
            <Bell
              className="w-3.5 h-3.5 text-amber-500 shrink-0"
              data-testid="renewal-bell"
            />
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {contract.supplierName ?? "—"}
          {contract.categoryName && <> · {contract.categoryName}</>}
          {contract.owner && <> · Owner: {contract.owner}</>}
        </div>
      </div>

      <div className="hidden md:block text-right tabular-nums w-32 text-sm">
        {contract.annualBaselineUsd != null
          ? formatUsd(contract.annualBaselineUsd, { compact: true })
          : "—"}
        <div className="text-xs text-muted-foreground">
          {contract.billingCurrency ?? ""}
        </div>
      </div>

      <div className="text-right w-36">
        <div className="text-sm tabular-nums">{formatDate(contract.endDate)}</div>
        <DerivedStatusBadge
          status={contract.derivedStatus}
          daysToExpiry={contract.daysToExpiry ?? null}
        />
      </div>

      <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </Link>
  );
}

export function DerivedStatusBadge({
  status,
  daysToExpiry,
}: {
  status: Contract["derivedStatus"];
  daysToExpiry: number | null;
}) {
  const variant: "default" | "secondary" | "outline" | "destructive" =
    status === "expired"
      ? "destructive"
      : status === "expiring"
        ? "secondary"
        : status === "cancelled"
          ? "outline"
          : "default";
  const label =
    status === "expiring" && daysToExpiry != null
      ? `Expiring · ${daysToExpiry}d`
      : status === "expired" && daysToExpiry != null
        ? `Expired · ${Math.abs(daysToExpiry)}d ago`
        : status;
  return (
    <Badge
      variant={variant}
      className="capitalize text-[10px] mt-0.5"
      data-testid={`derived-status-${status}`}
    >
      {label}
    </Badge>
  );
}

// ─── Calendar view ───────────────────────────────────────────────────────

function CalendarView({ items }: { items: Contract[] }) {
  // Bucket every contract by its end-date month-key so each month cell
  // renders its own short list. Keeping the grid to the next 12 months
  // matches what we'd send a renewal alert for at any sensible threshold
  // (default 90d) and stays visually scannable.
  const months = useMemo(() => {
    const now = new Date();
    const out: { key: string; label: string; items: Contract[] }[] = [];
    for (let i = 0; i < 12; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      out.push({
        key,
        label: d.toLocaleDateString(undefined, {
          month: "short",
          year: "numeric",
        }),
        items: [],
      });
    }
    const idx = new Map(out.map((m) => [m.key, m]));
    for (const c of items) {
      const ed = new Date(c.endDate);
      if (Number.isNaN(ed.getTime())) continue;
      const key = `${ed.getFullYear()}-${String(ed.getMonth() + 1).padStart(2, "0")}`;
      idx.get(key)?.items.push(c);
    }
    for (const m of out) {
      m.items.sort(
        (a, b) =>
          new Date(a.endDate).getTime() - new Date(b.endDate).getTime(),
      );
    }
    return out;
  }, [items]);

  const totalInWindow = months.reduce((s, m) => s + m.items.length, 0);

  return (
    <Card data-testid="calendar-view">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Renewal calendar — next 12 months</span>
          <span className="text-sm font-normal text-muted-foreground">
            {totalInWindow} renewal{totalInWindow === 1 ? "" : "s"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {months.map((m) => (
            <div
              key={m.key}
              data-testid={`month-${m.key}`}
              className={cn(
                "rounded-md border p-3 min-h-[120px] flex flex-col gap-2",
                m.items.length === 0
                  ? "bg-muted/30 text-muted-foreground"
                  : "bg-card",
              )}
            >
              <div className="text-xs font-semibold uppercase tracking-wide flex items-center justify-between">
                <span>{m.label}</span>
                {m.items.length > 0 && (
                  <Badge variant="secondary" className="text-[10px]">
                    {m.items.length}
                  </Badge>
                )}
              </div>
              <ul className="space-y-1 text-xs">
                {m.items.slice(0, 5).map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/contracts/${c.id}`}
                      className={cn(
                        "block truncate rounded px-1.5 py-1 hover:underline",
                        c.derivedStatus === "expiring" &&
                          "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                        c.derivedStatus === "expired" &&
                          "bg-destructive/10 text-destructive",
                        c.derivedStatus === "active" &&
                          "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                      )}
                      data-testid={`cal-contract-${c.id}`}
                      title={`${c.contractNumber} — ${c.supplierName ?? ""}`}
                    >
                      <span className="font-mono mr-1">
                        {new Date(c.endDate).getDate()}
                      </span>
                      {c.title}
                    </Link>
                  </li>
                ))}
                {m.items.length > 5 && (
                  <li className="text-[10px] text-muted-foreground italic">
                    + {m.items.length - 5} more
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
