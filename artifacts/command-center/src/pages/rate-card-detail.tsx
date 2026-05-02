/**
 * Rate card detail — header KPIs, role/seniority lines with market
 * benchmark colour bands, and the most recent off-card time entries
 * (the leakage indicator).
 */
import { Link, useLocation, useParams } from "wouter";
import {
  useGetRateCard,
  type RateCardLine,
  type RateCardOffCardEntry,
  type RateCardOffCardPoLine,
  type RateCardOffCardInvoice,
  type RateCardLineGridGroup,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  ClipboardList,
  Building2,
  FileText,
  Lightbulb,
} from "lucide-react";
import { formatUsd, formatDate } from "@/lib/format";

const BAND_PILL: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-800",
  yellow: "bg-amber-100 text-amber-800",
  orange: "bg-orange-100 text-orange-800",
  red: "bg-rose-100 text-rose-800",
};

const GRID_BAND_BG: Record<string, string> = {
  green: "bg-emerald-50 hover:bg-emerald-100",
  yellow: "bg-amber-50 hover:bg-amber-100",
  orange: "bg-orange-50 hover:bg-orange-100",
  red: "bg-rose-50 hover:bg-rose-100",
};

export default function RateCardDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const [, navigate] = useLocation();
  const { data, isLoading, error } = useGetRateCard(id);

  if (isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading rate card…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-8 space-y-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/services?tab=rate-cards")}
          data-testid="btn-back"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to rate cards
        </Button>
        <Card>
          <CardContent className="pt-6 text-destructive flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Could not load this rate card.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6 max-w-6xl">
      <Link
        href="/services?tab=rate-cards"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        data-testid="link-back-to-rate-cards"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to rate cards
      </Link>

      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <ClipboardList className="w-6 h-6 text-primary" />
          <h1 data-testid="text-page-title" className="text-2xl font-bold">
            {data.name}
          </h1>
          <Badge
            variant={
              data.status === "active"
                ? "default"
                : data.status === "expired"
                  ? "outline"
                  : "secondary"
            }
            className="capitalize"
            data-testid={`rc-status-${data.status}`}
          >
            {data.status}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          {data.supplierId && data.supplierName && (
            <Link
              href={`/suppliers/${data.supplierId}`}
              className="hover:underline inline-flex items-center gap-1"
              data-testid="link-rc-supplier"
            >
              <Building2 className="w-3 h-3" />
              {data.supplierName}
            </Link>
          )}
          {data.msaContractId && (
            <>
              {" · "}
              <Link
                href={`/contracts/${data.msaContractId}`}
                className="hover:underline inline-flex items-center gap-1"
                data-testid="link-rc-msa"
              >
                <FileText className="w-3 h-3" />
                MSA contract
              </Link>
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Kpi label="Effective from" value={formatDate(data.effectiveStart)} />
        <Kpi
          label="Effective to"
          value={data.effectiveEnd ? formatDate(data.effectiveEnd) : "Open-ended"}
        />
        <Kpi label="Lines" value={data.lineCount.toLocaleString()} />
        <Kpi
          label="Off-card time (12 mo.)"
          value={formatUsd(data.offCardSpendUsd, { compact: true })}
          sub={
            data.offCardSpendUsd > 0
              ? "Hours billed off-card"
              : "No off-card hours"
          }
        />
        <Kpi
          label="PO mismatch (12 mo.)"
          value={formatUsd(data.offCardPoMismatchUsd, { compact: true })}
          sub={
            data.offCardPoMismatchUsd > 0
              ? "POs above max card rate"
              : "No PO leakage"
          }
        />
        <Kpi
          label="Invoice off-card (12 mo.)"
          value={formatUsd(data.offCardInvoiceUsd, { compact: true })}
          sub={
            data.offCardInvoiceUsd > 0
              ? "Invoiced direct against PO"
              : "No invoice leakage"
          }
        />
      </div>

      {data.linesByRole && data.linesByRole.length > 0 && (
        <Card data-testid="card-rate-grid">
          <CardHeader>
            <CardTitle>Rate ladder · role × seniority</CardTitle>
            <CardDescription>
              Pivoted view of every rate on this card. Cell colour mirrors the
              market benchmark band: green ≤ p50, yellow p50–p75, orange
              p75–p90, red &gt; p90.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 overflow-auto">
            <RateGrid groups={data.linesByRole} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Rate lines</CardTitle>
          <CardDescription>
            Colour bands compare the unit rate against the most recent OEWS
            wage benchmark for the role: green ≤ p50, yellow p50–p75, orange
            p75–p90, red &gt; p90.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.lines.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No rate lines recorded for this card.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left p-3">Role</th>
                  <th className="text-left p-3">Seniority</th>
                  <th className="text-right p-3">Unit rate</th>
                  <th className="text-left p-3 w-32">Benchmark</th>
                  <th className="text-right p-3">p50 / p75 / p90</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <RateLineRow key={l.id} line={l} currency={data.currency} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {data.linkedOpportunities && data.linkedOpportunities.length > 0 && (
        <Card data-testid="card-rc-linked-opps">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-amber-500" />
              Linked opportunities
            </CardTitle>
            <CardDescription>
              Open OODA opportunities flagged against this rate card —
              typically by the services rate-card benchmark lever.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left p-3">Title</th>
                  <th className="text-left p-3">Lever</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Projected savings</th>
                  <th className="text-right p-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.linkedOpportunities.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b last:border-b-0"
                    data-testid={`linked-opp-${o.id}`}
                  >
                    <td className="p-3">
                      <Link
                        href={`/opportunities/${o.id}`}
                        className="font-medium hover:underline"
                      >
                        {o.title}
                      </Link>
                    </td>
                    <td className="p-3 text-xs font-mono text-muted-foreground">
                      {o.leverId}
                    </td>
                    <td className="p-3 text-xs capitalize">{o.status}</td>
                    <td className="p-3 text-right tabular-nums">
                      {formatUsd(o.projectedSavingsUsd, { compact: true })}
                    </td>
                    <td className="p-3 text-right tabular-nums text-xs text-muted-foreground">
                      {formatDate(o.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-off-card-time">
        <CardHeader>
          <CardTitle>Off-card time entries</CardTitle>
          <CardDescription>
            Time entries posted against this rate card whose role/seniority
            didn&rsquo;t match any line on the card. Each row is a leak —
            click into the SOW to see the booking context.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.recentOffCardEntries.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No off-card entries in the last 12 months.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left p-3">Date</th>
                  <th className="text-left p-3">Role</th>
                  <th className="text-right p-3">Hours</th>
                  <th className="text-right p-3">Bill rate</th>
                  <th className="text-right p-3">Amount</th>
                  <th className="text-left p-3">SOW</th>
                </tr>
              </thead>
              <tbody>
                {data.recentOffCardEntries.map((e) => (
                  <OffCardRow key={e.id} entry={e} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-off-card-po">
        <CardHeader>
          <CardTitle>Off-card PO lines</CardTitle>
          <CardDescription>
            Services-class purchase-order lines booked against the parent
            MSA whose unit price exceeds the highest hourly rate on this
            card — services spend that bypassed the rate ladder entirely.
            Each row links to the originating PO and supplier.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.recentOffCardPoLines.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No PO leakage in the last 12 months.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left p-3">Date</th>
                  <th className="text-left p-3">PO</th>
                  <th className="text-left p-3">Supplier</th>
                  <th className="text-left p-3">Description</th>
                  <th className="text-right p-3">Unit price</th>
                  <th className="text-right p-3">Extended</th>
                </tr>
              </thead>
              <tbody>
                {data.recentOffCardPoLines.map((p) => (
                  <OffCardPoRow key={p.poLineId} line={p} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-off-card-invoices">
        <CardHeader>
          <CardTitle>Off-card invoices</CardTitle>
          <CardDescription>
            Invoices billed against POs on the parent MSA contract over the
            past 12 months. Each row links to the originating PO and supplier.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.recentOffCardInvoices.length === 0 ? (
            <div
              className="p-6 text-sm text-muted-foreground"
              data-testid="empty-off-card-invoices"
            >
              No invoice leakage in the last 12 months.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left p-3">Date</th>
                  <th className="text-left p-3">Invoice</th>
                  <th className="text-left p-3">PO</th>
                  <th className="text-left p-3">Supplier</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.recentOffCardInvoices.map((inv) => (
                  <OffCardInvoiceRow key={inv.invoiceId} invoice={inv} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OffCardInvoiceRow({ invoice }: { invoice: RateCardOffCardInvoice }) {
  return (
    <tr
      className="border-b last:border-b-0"
      data-testid={`off-card-invoice-row-${invoice.invoiceId}`}
    >
      <td className="p-3 text-xs text-muted-foreground tabular-nums">
        {invoice.invoiceDate ?? "—"}
      </td>
      <td className="p-3 text-xs font-mono">
        {invoice.invoiceNumber ?? invoice.invoiceId.slice(0, 10)}
      </td>
      <td className="p-3 text-xs">
        {invoice.poId ? (
          <Link
            href={`/pos/${invoice.poId}`}
            className="font-mono hover:underline text-primary"
          >
            {invoice.poNumber ?? invoice.poId.slice(0, 10)}
          </Link>
        ) : (
          "—"
        )}
      </td>
      <td className="p-3 text-xs">
        {invoice.supplierId && invoice.supplierName ? (
          <Link
            href={`/suppliers/${invoice.supplierId}`}
            className="hover:underline"
          >
            {invoice.supplierName}
          </Link>
        ) : (
          invoice.supplierName ?? "—"
        )}
      </td>
      <td className="p-3 text-xs capitalize text-muted-foreground">
        {invoice.status ?? "—"}
      </td>
      <td className="p-3 text-right tabular-nums font-medium">
        {formatUsd(invoice.amountUsd, { compact: true })}
      </td>
    </tr>
  );
}

function OffCardPoRow({ line }: { line: RateCardOffCardPoLine }) {
  return (
    <tr
      className="border-b last:border-b-0"
      data-testid={`off-card-po-row-${line.poLineId}`}
    >
      <td className="p-3 text-xs text-muted-foreground tabular-nums">
        {line.orderDate ?? "—"}
      </td>
      <td className="p-3 text-xs">
        <Link
          href={`/pos/${line.poId}`}
          className="font-mono hover:underline text-primary"
          data-testid={`off-card-po-link-${line.poLineId}`}
        >
          {line.poNumber ?? line.poId.slice(0, 10)}
        </Link>
      </td>
      <td className="p-3 text-xs">
        {line.supplierId && line.supplierName ? (
          <Link
            href={`/suppliers/${line.supplierId}`}
            className="hover:underline"
          >
            {line.supplierName}
          </Link>
        ) : (
          line.supplierName ?? "—"
        )}
      </td>
      <td className="p-3 text-xs text-muted-foreground max-w-xs truncate">
        {line.description ?? line.categoryName ?? "—"}
      </td>
      <td className="p-3 text-right tabular-nums text-xs">
        {line.unitPriceUsd != null ? formatUsd(line.unitPriceUsd) : "—"}
        {line.cardMaxHourlyUsd != null && (
          <span className="text-[10px] text-muted-foreground ml-1">
            / max {formatUsd(line.cardMaxHourlyUsd)}
          </span>
        )}
      </td>
      <td className="p-3 text-right tabular-nums font-medium">
        {formatUsd(line.extendedUsd, { compact: true })}
      </td>
    </tr>
  );
}

function RateGrid({
  groups,
}: {
  groups: RateCardLineGridGroup[];
}) {
  // Compute the union of seniority labels across roles so the pivot
  // is rectangular. Preserves first-seen order so the most common
  // seniority ladder reads naturally.
  const seniorityOrder: (string | null)[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const c of g.cells) {
      const key = c.seniority ?? "__none";
      if (!seen.has(key)) {
        seen.add(key);
        seniorityOrder.push(c.seniority ?? null);
      }
    }
  }
  return (
    <table className="w-full text-sm" data-testid="rate-grid">
      <thead className="text-xs text-muted-foreground border-b">
        <tr>
          <th className="text-left p-3 font-medium">Role</th>
          {seniorityOrder.map((s, i) => (
            <th
              key={`hdr-${s ?? "none"}-${i}`}
              className="text-right p-3 font-medium capitalize"
            >
              {s ?? "—"}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => {
          const byKey = new Map<string, (typeof g.cells)[number]>();
          for (const c of g.cells) {
            byKey.set(c.seniority ?? "__none", c);
          }
          return (
            <tr
              key={g.role}
              className="border-b last:border-b-0"
              data-testid={`rate-grid-row-${g.role}`}
            >
              <td className="p-3 font-medium">{g.role}</td>
              {seniorityOrder.map((s, i) => {
                const key = s ?? "__none";
                const cell = byKey.get(key);
                if (!cell) {
                  return (
                    <td
                      key={`empty-${g.role}-${key}-${i}`}
                      className="p-3 text-right text-xs text-muted-foreground"
                    >
                      —
                    </td>
                  );
                }
                const bg = cell.band ? GRID_BAND_BG[cell.band] : "";
                return (
                  <td
                    key={cell.lineId}
                    className={`p-3 text-right tabular-nums ${bg}`}
                    data-testid={`rate-grid-cell-${cell.lineId}`}
                  >
                    {formatUsd(cell.unitRateUsd)}
                    <span className="text-[10px] text-muted-foreground ml-1">
                      / {cell.unit}
                    </span>
                    {(cell.geography || cell.billingModel) && (
                      <div className="text-[10px] text-muted-foreground mt-0.5 capitalize">
                        {[cell.geography, cell.billingModel?.replace(/_/g, " ")]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RateLineRow({
  line,
  currency,
}: {
  line: RateCardLine;
  currency: string;
}) {
  const b = line.marketBenchmark ?? null;
  return (
    <tr
      className="border-b last:border-b-0"
      data-testid={`rate-line-${line.id}`}
    >
      <td className="p-3 font-medium">{line.role}</td>
      <td className="p-3 text-muted-foreground capitalize">
        {line.seniority ?? "—"}
      </td>
      <td className="p-3 text-right tabular-nums">
        {formatUsd(line.unitRateUsd)}
        <span className="text-xs text-muted-foreground ml-1">
          / {line.unit}
        </span>
        {line.currency && line.currency !== "USD" && (
          <div className="text-[10px] text-muted-foreground">
            {line.unitRate.toFixed(2)} {line.currency ?? currency}
          </div>
        )}
      </td>
      <td className="p-3">
        {b ? (
          <span
            className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium uppercase ${BAND_PILL[b.band] ?? ""}`}
            data-testid={`benchmark-${line.id}`}
            title={`Source: ${b.source}${b.observedAt ? ` · ${formatDate(b.observedAt)}` : ""}`}
          >
            {b.band}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="p-3 text-right tabular-nums text-xs text-muted-foreground">
        {b
          ? `${b.p50Usd != null ? formatUsd(b.p50Usd) : "—"} / ${b.p75Usd != null ? formatUsd(b.p75Usd) : "—"} / ${b.p90Usd != null ? formatUsd(b.p90Usd) : "—"}`
          : "—"}
      </td>
    </tr>
  );
}

function OffCardRow({ entry }: { entry: RateCardOffCardEntry }) {
  return (
    <tr
      className="border-b last:border-b-0"
      data-testid={`off-card-${entry.id}`}
    >
      <td className="p-3 tabular-nums text-xs">{formatDate(entry.workDate)}</td>
      <td className="p-3">
        <div className="font-medium">{entry.role}</div>
        {entry.seniority && (
          <div className="text-xs text-muted-foreground capitalize">
            {entry.seniority}
          </div>
        )}
      </td>
      <td className="p-3 text-right tabular-nums">{entry.hours.toFixed(1)}</td>
      <td className="p-3 text-right tabular-nums">
        {entry.unitRateUsd != null ? formatUsd(entry.unitRateUsd) : "—"}
      </td>
      <td className="p-3 text-right tabular-nums">
        {formatUsd(entry.billedAmountUsd, { compact: true })}
      </td>
      <td className="p-3 text-xs">
        {entry.sowId && entry.sowNumber ? (
          <Link
            href={`/sows/${entry.sowId}`}
            className="text-primary hover:underline font-mono"
          >
            {entry.sowNumber}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">
        {label}
      </div>
      <div className="text-xl font-bold mt-1 tabular-nums">{value}</div>
      {sub && (
        <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
      )}
    </div>
  );
}
