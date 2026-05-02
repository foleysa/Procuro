/**
 * Customer-facing Trust Center. The single page a procurement team's
 * compliance reviewer should be able to deep-link from a security
 * questionnaire — every section is tenant-scoped and assembled from
 * live system state via `GET /api/trust/summary`. Add `?print=1` to
 * the URL for a chrome-less, print-ready rendering (the wrapping
 * Layout is suppressed at the App.tsx level when the flag is set).
 *
 * The presentational components live in `components/trust/sections.tsx`
 * so the public, signed-out preview at `/trust/public` renders the
 * same composition with seeded demo data — see `pages/trust-public.tsx`.
 *
 * Composition mirrors task #121:
 *  - Tenant context (org name + active disclosure policy)
 *  - Live data sources (count by tier, full collector matrix)
 *  - Operational controls (kill switch, schema drift, retry budgets)
 *  - Provenance (citation-coverage % for opportunities)
 *  - Audit (retention, recent volume, last event)
 *  - Identity & access (SSO/SCIM + role catalogue)
 *  - Compliance (attestations, DPA/sub-processor links, security contact)
 *  - Disclosure-tier explainer (T1–T4 with sample InsightCitations)
 */

import { useState } from "react";
import {
  useGetTrustSummary,
  getGetTrustSummaryPdfUrl,
  getTrustSummaryPdf,
  type TrustSummary,
} from "@workspace/api-client-react";
import {
  Shield,
  Loader2,
  Printer,
  Download,
  RefreshCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { usePolicy } from "@/lib/use-policy";
import { cn } from "@/lib/utils";
import {
  TenantSection,
  DataSourcesSection,
  OperationalControlsSection,
  ProvenanceSection,
  AuditSection,
  IdentitySection,
  ComplianceSection,
  DisclosureTierExplainer,
  TrustFooter,
} from "@/components/trust/sections";

export default function TrustPage() {
  const { data, isLoading, isError, refetch, isFetching } =
    useGetTrustSummary();
  const policy = usePolicy();
  const isPrint = isPrintMode();
  const [isDownloading, setIsDownloading] = useState(false);

  const handleDownloadPdf = async () => {
    if (!data || isDownloading) return;
    setIsDownloading(true);
    try {
      const blob = await getTrustSummaryPdf();
      const datePart = data.generatedAt.slice(0, 10);
      const slug = sanitizeSlug(data.tenant.orgId);
      const filename = `procuro-trust-${slug}-${datePart}.pdf`;
      triggerBlobDownload(blob, filename);
    } catch (err) {
      // Surface to the user but don't crash the page.
      console.error("Failed to download Trust Center PDF", err);
      // Last-resort fallback: open the URL directly so the browser
      // can stream the response itself.
      window.open(getGetTrustSummaryPdfUrl(), "_blank", "noopener,noreferrer");
    } finally {
      setIsDownloading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-12 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading trust posture…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-12 text-sm text-destructive">
        Couldn't load the Trust Center. Try refreshing — the API may
        still be initializing.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "space-y-8 max-w-5xl",
        isPrint ? "p-8 print:p-0" : "p-8",
      )}
      data-testid="trust-root"
      data-print={isPrint ? "1" : "0"}
    >
      <Header
        summary={data}
        onRefresh={() => void refetch()}
        isFetching={isFetching}
        isPrint={isPrint}
        onDownloadPdf={() => void handleDownloadPdf()}
        isDownloading={isDownloading}
      />

      <TenantSection summary={data} />
      <DataSourcesSection summary={data} />
      <OperationalControlsSection summary={data} />
      <ProvenanceSection summary={data} />
      <AuditSection summary={data} />
      <IdentitySection summary={data} />
      <ComplianceSection summary={data} />
      <DisclosureTierExplainer policy={policy} />

      <TrustFooter generatedAt={data.generatedAt} />
    </div>
  );
}

function isPrintMode(): boolean {
  if (typeof window === "undefined") return false;
  const sp = new URLSearchParams(window.location.search);
  return sp.get("print") === "1";
}

/**
 * Mirrors the server-side filename sanitizer in `routes/trust.ts` so
 * the downloaded file always lands with a safe, predictable name even
 * when the org ID contains characters the OS would refuse.
 */
function sanitizeSlug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "tenant";
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revocation so Safari has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Header({
  summary,
  onRefresh,
  isFetching,
  isPrint,
  onDownloadPdf,
  isDownloading,
}: {
  summary: TrustSummary;
  onRefresh: () => void;
  isFetching: boolean;
  isPrint: boolean;
  onDownloadPdf: () => void;
  isDownloading: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1
          data-testid="text-page-title"
          className="text-3xl font-bold flex items-center gap-3"
        >
          <Shield className="w-7 h-7 text-primary" />
          Trust Center
        </h1>
        <p className="text-muted-foreground mt-1">
          Live posture for <strong>{summary.tenant.orgName}</strong> —
          assembled from this tenant's runtime state, not a marketing
          page. Snapshot generated{" "}
          {formatDateTime(summary.generatedAt)}.
        </p>
      </div>
      {!isPrint && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            data-testid="button-refresh-trust"
          >
            <RefreshCcw
              className={cn("w-4 h-4 mr-2", isFetching && "animate-spin")}
            />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const url = new URL(window.location.href);
              url.searchParams.set("print", "1");
              window.open(url.toString(), "_blank", "noopener,noreferrer");
            }}
            data-testid="button-print-trust"
          >
            <Printer className="w-4 h-4 mr-2" /> Printable view
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onDownloadPdf}
            disabled={isDownloading}
            data-testid="button-download-trust-pdf"
          >
            {isDownloading ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Download className="w-4 h-4 mr-2" />
            )}
            {isDownloading ? "Generating…" : "Download PDF"}
          </Button>
        </div>
      )}
    </div>
  );
}
