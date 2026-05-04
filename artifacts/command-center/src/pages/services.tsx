/**
 * Services workspace — three tabs that share a single page so the
 * operator's filter and search context survives tab switches.
 *
 *   - SOWs: cursor-paginated list of statements of work, with a status
 *     filter and free-text search over `sowNumber` / `title`.
 *   - Rate Cards: cursor-paginated list of negotiated rate cards, with
 *     status (derived from effective/expiry dates) and search.
 *   - Spend: trailing-12-month services-only rollup (split by contract
 *     type, top suppliers, top categories) — no pagination needed.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListSows,
  useListRateCards,
  useGetServicesSpend,
  ListSowsStatus,
  ListRateCardsStatus,
  type ListSowsParams,
  type ListRateCardsParams,
  type GetServicesSpendParams,
  type StatementOfWork,
  type RateCard,
  type ServicesSpendResponseByContractTypeItemContractType,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { formatUsd, formatPercent, formatDate } from "@/lib/format";
import {
  ArrowRight,
  Loader2,
  Wrench,
  FileSignature,
  ClipboardList,
  TrendingUp,
} from "lucide-react";

const TAB_VALUES = ["sows", "rate-cards", "spend"] as const;
type TabValue = (typeof TAB_VALUES)[number];
const isTab = (v: string | null): v is TabValue =>
  !!v && (TAB_VALUES as readonly string[]).includes(v);

function readTab(): TabValue {
  if (typeof window === "undefined") return "sows";
  const t = new URLSearchParams(window.location.search).get("tab");
  return isTab(t) ? t : "sows";
}

/**
 * `?supplier=<id>` lets external surfaces (the supplier 360 KPI cards
 * in particular) deep-link straight into a supplier-filtered view of
 * SOWs / rate cards / services spend. Returning `null` instead of an
 * empty string keeps params hashes stable.
 */
function readSupplierFilter(): string | null {
  if (typeof window === "undefined") return null;
  const s = new URLSearchParams(window.location.search).get("supplier");
  return s && s.trim() ? s.trim() : null;
}

/**
 * Tab persistence preserves the supplier filter — the operator's
 * incoming pivot context shouldn't get dropped just because they
 * hopped tabs. Same goes for any other future query params we add.
 */
function writeTab(t: TabValue) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (t === "sows") url.searchParams.delete("tab");
  else url.searchParams.set("tab", t);
  window.history.replaceState({}, "", url.toString());
}

const SOW_STATUS_OPTS = [
  { v: ListSowsStatus.active, l: "Active" },
  { v: "all", l: "All statuses" },
  { v: ListSowsStatus.draft, l: "Draft" },
  { v: ListSowsStatus.completed, l: "Completed" },
  { v: ListSowsStatus.cancelled, l: "Cancelled" },
];

const RC_STATUS_OPTS = [
  { v: "all", l: "All statuses" },
  { v: ListRateCardsStatus.active, l: "Active" },
  { v: ListRateCardsStatus.draft, l: "Draft (future-dated)" },
  { v: ListRateCardsStatus.expired, l: "Expired" },
];

const CONTRACT_TYPE_LABELS: Record<
  ServicesSpendResponseByContractTypeItemContractType,
  string
> = {
  goods: "Goods",
  t_and_m: "Time & Materials",
  fixed_price: "Fixed Price",
  milestone: "Milestone",
  retainer: "Retainer",
  outcome: "Outcome",
};

export default function ServicesPage() {
  const [tab, setTab] = useState<TabValue>(readTab);
  const [supplierId, setSupplierId] = useState<string | null>(
    readSupplierFilter,
  );
  useEffect(() => {
    const onPop = () => {
      setTab(readTab());
      setSupplierId(readSupplierFilter());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const onTabChange = (v: string) => {
    if (!isTab(v)) return;
    setTab(v);
    writeTab(v);
  };

  const clearSupplier = () => {
    setSupplierId(null);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("supplier");
    window.history.replaceState({}, "", url.toString());
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div>
        <h1
          data-testid="text-page-title"
          className="text-3xl font-bold flex items-center gap-2"
        >
          <Wrench className="w-7 h-7 text-primary" />
          Services
        </h1>
        <p className="text-muted-foreground mt-1">
          Statements of work, negotiated rate cards, and trailing-12-month
          services spend.
        </p>
      </div>

      {supplierId && (
        <div
          className="flex items-center gap-2 text-sm bg-muted/50 border rounded-md px-3 py-2"
          data-testid="filter-chip-supplier"
        >
          <span className="text-muted-foreground">Filtered to supplier:</span>
          <Link
            href={`/suppliers/${supplierId}`}
            className="font-mono text-xs text-primary hover:underline"
            data-testid="filter-chip-supplier-link"
          >
            {supplierId}
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={clearSupplier}
            data-testid="btn-clear-supplier-filter"
          >
            Clear
          </Button>
        </div>
      )}

      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList data-testid="tabs-services">
          <TabsTrigger value="sows" data-testid="tab-sows">
            <FileSignature className="w-4 h-4 mr-1" /> SOWs
          </TabsTrigger>
          <TabsTrigger value="rate-cards" data-testid="tab-rate-cards">
            <ClipboardList className="w-4 h-4 mr-1" /> Rate Cards
          </TabsTrigger>
          <TabsTrigger value="spend" data-testid="tab-services-spend">
            <TrendingUp className="w-4 h-4 mr-1" /> Services Spend
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sows" className="mt-4">
          <SowsTab supplierId={supplierId} />
        </TabsContent>

        <TabsContent value="rate-cards" className="mt-4">
          <RateCardsTab supplierId={supplierId} />
        </TabsContent>

        <TabsContent value="spend" className="mt-4">
          <SpendTab supplierId={supplierId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── SOWs Tab ────────────────────────────────────────────────────────────

function SowsTab({ supplierId }: { supplierId: string | null }) {
  const [search, setSearch] = useState("");
  // Default to active SOWs — the workflow list should show
  // currently in-flight engagements, not draft/cancelled history.
  const [status, setStatus] = useState("active");
  const [cursorStack, setCursorStack] = useState<string[]>([""]);
  const cursor = cursorStack[cursorStack.length - 1] ?? "";

  const reset = () => setCursorStack([""]);
  useEffect(() => {
    reset();
  }, [supplierId]);

  const params = useMemo<ListSowsParams>(() => {
    const p: ListSowsParams = { limit: 50 };
    if (search.trim()) p.search = search.trim();
    if (status !== "all") p.status = status as ListSowsParams["status"];
    if (supplierId) p.supplierId = supplierId;
    if (cursor) p.cursor = cursor;
    return p;
  }, [search, status, supplierId, cursor]);

  const { data, isLoading, error, isFetching } = useListSows(params);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            placeholder="Search SOW number or title…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              reset();
            }}
            data-testid="filter-sow-search"
          />
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              reset();
            }}
          >
            <SelectTrigger data-testid="filter-sow-status" aria-label="Filter by SOW status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOW_STATUS_OPTS.map((o) => (
                <SelectItem key={o.v} value={o.v}>
                  {o.l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading SOWs…
        </div>
      )}
      {error && (
        <div className="text-destructive text-sm">Failed to load SOWs.</div>
      )}

      {!isLoading && !error && (
        <>
          {(data?.items ?? []).length === 0 ? (
            <div
              className="bg-card border rounded-lg p-12 text-center text-muted-foreground"
              data-testid="empty-sows"
            >
              No SOWs match the current filters.
            </div>
          ) : (
            <Card>
              <CardContent className="p-0 divide-y">
                {(data?.items ?? []).map((s) => (
                  <SowRow key={s.id} sow={s} />
                ))}
              </CardContent>
            </Card>
          )}

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <Button
              variant="outline"
              size="sm"
              disabled={cursorStack.length <= 1 || isFetching}
              onClick={() =>
                setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
              }
              data-testid="btn-sow-prev"
            >
              ← Previous
            </Button>
            <span>
              {(data?.items ?? []).length} SOW
              {(data?.items ?? []).length === 1 ? "" : "s"} on this page
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.nextCursor || isFetching}
              onClick={() => {
                if (data?.nextCursor) {
                  setCursorStack((s) => [...s, data.nextCursor!]);
                }
              }}
              data-testid="btn-sow-next"
            >
              Next →
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function SowRow({ sow }: { sow: StatementOfWork }) {
  return (
    <Link
      href={`/sows/${sow.id}`}
      className="flex items-center gap-4 p-4 hover:bg-accent/40 transition-colors"
      data-testid={`sow-${sow.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            {sow.sowNumber}
          </span>
          <span className="truncate">{sow.title}</span>
          <SowStatusBadge status={sow.status} />
        </div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {sow.supplierName ?? "—"}
          {sow.msaContractNumber && <> · MSA {sow.msaContractNumber}</>}
        </div>
      </div>
      <div className="hidden md:block text-right tabular-nums w-32 text-sm">
        {formatUsd(sow.nteUsd, { compact: true })}
        <div className="text-xs text-muted-foreground">
          NTE · {sow.currency}
        </div>
      </div>
      <div
        className="hidden md:block text-right tabular-nums w-28 text-sm"
        data-testid={`sow-burned-${sow.id}`}
      >
        <div
          className={
            sow.burnedPct >= 0.9
              ? "text-rose-600 font-medium"
              : sow.burnedPct >= 0.75
                ? "text-amber-600 font-medium"
                : ""
          }
        >
          {Math.round(sow.burnedPct * 100)}%
        </div>
        <div className="text-xs text-muted-foreground">
          {formatUsd(sow.earnedUsd, { compact: true })} earned
        </div>
      </div>
      <div
        className="hidden md:block text-right tabular-nums w-16 text-sm"
        data-testid={`sow-co-count-${sow.id}`}
      >
        <div
          className={
            sow.changeOrderCount > 0
              ? "text-amber-600 font-medium"
              : "text-muted-foreground"
          }
        >
          {sow.changeOrderCount}
        </div>
        <div className="text-xs text-muted-foreground">COs</div>
      </div>
      <div className="text-right w-32 text-sm">
        <div className="tabular-nums">{formatDate(sow.endDate)}</div>
        <div className="text-xs text-muted-foreground">
          {sow.openMilestoneCount}/{sow.milestoneCount} open
        </div>
      </div>
      <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </Link>
  );
}

function SowStatusBadge({ status }: { status: StatementOfWork["status"] }) {
  const variant: "default" | "secondary" | "outline" | "destructive" =
    status === "active"
      ? "default"
      : status === "completed"
        ? "secondary"
        : status === "cancelled"
          ? "destructive"
          : "outline";
  return (
    <Badge
      variant={variant}
      className="capitalize text-[10px]"
      data-testid={`sow-status-${status}`}
    >
      {status}
    </Badge>
  );
}

// ─── Rate Cards Tab ──────────────────────────────────────────────────────

function RateCardsTab({ supplierId }: { supplierId: string | null }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [cursorStack, setCursorStack] = useState<string[]>([""]);
  const cursor = cursorStack[cursorStack.length - 1] ?? "";

  const reset = () => setCursorStack([""]);
  useEffect(() => {
    reset();
  }, [supplierId]);

  const params = useMemo<ListRateCardsParams>(() => {
    const p: ListRateCardsParams = { limit: 50 };
    if (search.trim()) p.search = search.trim();
    if (status !== "all") p.status = status as ListRateCardsParams["status"];
    if (supplierId) p.supplierId = supplierId;
    if (cursor) p.cursor = cursor;
    return p;
  }, [search, status, supplierId, cursor]);

  const { data, isLoading, error, isFetching } = useListRateCards(params);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            placeholder="Search rate card name…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              reset();
            }}
            data-testid="filter-rc-search"
          />
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              reset();
            }}
          >
            <SelectTrigger data-testid="filter-rc-status" aria-label="Filter by rate card status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RC_STATUS_OPTS.map((o) => (
                <SelectItem key={o.v} value={o.v}>
                  {o.l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading rate cards…
        </div>
      )}
      {error && (
        <div className="text-destructive text-sm">
          Failed to load rate cards.
        </div>
      )}

      {!isLoading && !error && (
        <>
          {(data?.items ?? []).length === 0 ? (
            <div
              className="bg-card border rounded-lg p-12 text-center text-muted-foreground"
              data-testid="empty-rate-cards"
            >
              No rate cards match the current filters.
            </div>
          ) : (
            <Card>
              <CardContent className="p-0 divide-y">
                {(data?.items ?? []).map((r) => (
                  <RateCardRow key={r.id} card={r} />
                ))}
              </CardContent>
            </Card>
          )}

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <Button
              variant="outline"
              size="sm"
              disabled={cursorStack.length <= 1 || isFetching}
              onClick={() =>
                setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
              }
              data-testid="btn-rc-prev"
            >
              ← Previous
            </Button>
            <span>
              {(data?.items ?? []).length} rate card
              {(data?.items ?? []).length === 1 ? "" : "s"} on this page
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.nextCursor || isFetching}
              onClick={() => {
                if (data?.nextCursor) {
                  setCursorStack((s) => [...s, data.nextCursor!]);
                }
              }}
              data-testid="btn-rc-next"
            >
              Next →
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function RateCardRow({ card }: { card: RateCard }) {
  return (
    <Link
      href={`/rate-cards/${card.id}`}
      className="flex items-center gap-4 p-4 hover:bg-accent/40 transition-colors"
      data-testid={`rate-card-${card.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate flex items-center gap-2">
          <span className="truncate">{card.name}</span>
          <RateCardStatusBadge status={card.status} />
        </div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {card.supplierName ?? "—"} · {card.lineCount} role
          {card.lineCount === 1 ? "" : "s"}
        </div>
      </div>
      <div className="hidden md:block text-right tabular-nums w-40 text-sm">
        <div className="text-xs text-muted-foreground">Off-card spend</div>
        <div
          className={
            card.offCardSpendUsd > 0
              ? "text-amber-600 font-medium"
              : "text-muted-foreground"
          }
        >
          {formatUsd(card.offCardSpendUsd, { compact: true })}
        </div>
      </div>
      <div className="text-right w-32 text-sm">
        <div className="tabular-nums">{formatDate(card.effectiveStart)}</div>
        <div className="text-xs text-muted-foreground">
          {card.effectiveEnd ? `→ ${formatDate(card.effectiveEnd)}` : "open-ended"}
        </div>
      </div>
      <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </Link>
  );
}

function RateCardStatusBadge({ status }: { status: RateCard["status"] }) {
  const variant: "default" | "secondary" | "outline" =
    status === "active"
      ? "default"
      : status === "expired"
        ? "outline"
        : "secondary";
  return (
    <Badge
      variant={variant}
      className="capitalize text-[10px]"
      data-testid={`rc-status-${status}`}
    >
      {status}
    </Badge>
  );
}

// ─── Services Spend Tab ──────────────────────────────────────────────────

function SpendTab({ supplierId }: { supplierId: string | null }) {
  // The trailing-12-month rollup accepts an optional supplierId so
  // every panel (total, by-contract-type, top categories) reduces to
  // the supplier the operator pivoted from. Pass `undefined` for the
  // params object when no filter is active so the cache key matches
  // the unfiltered view.
  const params = useMemo<GetServicesSpendParams | undefined>(
    () => (supplierId ? { supplierId } : undefined),
    [supplierId],
  );
  const { data, isLoading, error } = useGetServicesSpend(params);
  const [, navigate] = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading services spend rollup…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="text-destructive text-sm">
        Failed to load services spend rollup.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <div className="text-xs uppercase text-muted-foreground tracking-wide">
            Services spend (last 12 months)
          </div>
          <div
            className="text-3xl font-bold tabular-nums mt-1"
            data-testid="kpi-total-services-spend"
          >
            {formatUsd(data.totalServicesSpendUsd, { compact: true })}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            POs tied to services-shaped contracts (T&amp;M, fixed-price,
            milestone, retainer, outcome).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Spend by contract type</CardTitle>
          <CardDescription>
            How services spend splits across the commercial structures captured
            on the contract.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.byContractType.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No services spend in the last 12 months.
            </div>
          ) : (
            <div className="space-y-3">
              {data.byContractType.map((b) => {
                const pct = Math.max(0, Math.min(1, b.share));
                return (
                  <div
                    key={b.contractType}
                    data-testid={`row-contract-type-${b.contractType}`}
                  >
                    <div className="flex justify-between text-sm mb-1">
                      <span className="font-medium">
                        {CONTRACT_TYPE_LABELS[b.contractType] ?? b.contractType}
                      </span>
                      <span className="tabular-nums">
                        {formatUsd(b.spendUsd, { compact: true })} ·{" "}
                        {formatPercent(pct)}
                      </span>
                    </div>
                    <div className="h-2 bg-muted rounded">
                      <div
                        className="h-full bg-primary rounded"
                        style={{ width: `${pct * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Top services suppliers</CardTitle>
          </CardHeader>
          <CardContent>
            {data.topSuppliers.length === 0 ? (
              <div className="text-sm text-muted-foreground">No suppliers.</div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {data.topSuppliers.map((s) => (
                    <tr
                      key={s.supplierId}
                      className="border-b last:border-0 cursor-pointer hover:bg-accent/40"
                      onClick={() => navigate(`/suppliers/${s.supplierId}`)}
                      data-testid={`row-services-supplier-${s.supplierId}`}
                    >
                      <td className="py-2 font-medium">{s.supplierName}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatUsd(s.spendUsd, { compact: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top services categories</CardTitle>
          </CardHeader>
          <CardContent>
            {data.topCategories.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No categories.
              </div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {data.topCategories.map((c) => (
                    <tr
                      key={c.categoryCode}
                      className="border-b last:border-0"
                      data-testid={`row-services-category-${c.categoryCode}`}
                    >
                      <td className="py-2">
                        <div className="font-medium">{c.categoryName}</div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {c.categoryCode}
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatUsd(c.spendUsd, { compact: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
