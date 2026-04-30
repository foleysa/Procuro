import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListSuppliers,
  type ListSuppliersParams,
  type Supplier,
} from "@workspace/api-client-react";
import {
  Building2,
  Loader2,
  Search,
  Star,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Supplier directory + entry point into the Supplier 360 detail page.
 * Mirrors the contracts list pagination model: cursor stack so going
 * "back" doesn't refetch from the start, search box debounce-free
 * (the index on `(org_id, normalized_name)` is fast enough for live
 * keystrokes at the row counts we expect), and a uniform table view
 * per row clickable through to /suppliers/:id.
 */
export default function Suppliers() {
  const [search, setSearch] = useState("");
  const [cursorStack, setCursorStack] = useState<string[]>([""]);
  const currentCursor = cursorStack[cursorStack.length - 1] ?? "";

  const params = useMemo<ListSuppliersParams>(() => {
    const p: ListSuppliersParams = { limit: 50 };
    if (search.trim()) p.search = search.trim();
    if (currentCursor) p.cursor = currentCursor;
    return p;
  }, [search, currentCursor]);

  // Reset pagination whenever filters change so the user never lands
  // on a "page 3" of a freshly narrowed list.
  useEffect(() => {
    setCursorStack([""]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const { data, isLoading, isFetching, error } = useListSuppliers(params);

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
        <CardContent>
          <Input
            placeholder="Search suppliers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-supplier-search"
            className="max-w-md"
          />
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
          ) : !data || data.items.length === 0 ? (
            <div
              className="text-muted-foreground py-8 text-center"
              data-testid="text-empty"
            >
              No suppliers match.
            </div>
          ) : (
            <Table data-testid="table-suppliers">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Billing currency</TableHead>
                  <TableHead>Payment terms</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((s) => (
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
  return (
    <TableRow data-testid={`row-supplier-${s.id}`}>
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
      <TableCell className="text-sm tabular-nums">
        {s.billingCurrency ?? <span className="text-muted-foreground">—</span>}
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
