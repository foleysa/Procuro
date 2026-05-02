/**
 * Public, signed-out preview of the Trust Center.
 *
 * Procurement reviewers run their security review BEFORE a contract
 * is signed, so requiring a tenant invitation to read /trust gates
 * the most influential page in the deal. This route is the
 * marketing-style mirror: same composition, same disclosure-tier
 * explainer, but seeded with a fixed "demo tenant" payload from
 * `GET /api/trust/public-summary` and rendered without any auth
 * chrome (no Layout, no Clerk session required).
 *
 * It deliberately reuses the section components from the live page
 * via `components/trust/sections.tsx`, so the only differences a
 * prospect sees between this and a live tenant are:
 *  - the banner at the top calling out that the numbers are
 *    representative
 *  - the absence of cross-links to authenticated areas (Data Sources,
 *    Opportunities, Org Admin) — passed via `linkMode="public"`
 *  - the prominent "Get a live tenant" CTA (in the banner and footer)
 */

import { useEffect } from "react";
import { Link } from "wouter";
import {
  useGetTrustPublicSummary,
  type TrustSummary,
} from "@workspace/api-client-react";
import { Shield, Loader2, Sparkles, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
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

export default function TrustPublicPage() {
  const { data, isLoading, isError } = useGetTrustPublicSummary();

  // Reflect the public mode in the document title so a reviewer who
  // bookmarks the URL (or shares it with their team) sees something
  // descriptive in the tab.
  useEffect(() => {
    const previous = document.title;
    document.title = "Trust Center (preview) · Procuro";
    return () => {
      document.title = previous;
    };
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-12">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading Trust
          Center preview…
        </div>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-12">
        <div className="text-sm text-destructive">
          Couldn't load the Trust Center preview. Please try again in
          a moment.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div
        className={cn("space-y-8 max-w-5xl mx-auto p-8")}
        data-testid="trust-public-root"
      >
        <PreviewBanner />
        <Header summary={data} />

        <TenantSection summary={data} />
        <DataSourcesSection summary={data} linkMode="public" />
        <OperationalControlsSection summary={data} />
        <ProvenanceSection summary={data} linkMode="public" />
        <AuditSection summary={data} linkMode="public" />
        <IdentitySection summary={data} linkMode="public" />
        <ComplianceSection summary={data} />
        <DisclosureTierExplainer policy={data.tenant.disclosurePolicy} />

        <GetLiveTenantCta />
        <TrustFooter generatedAt={data.generatedAt} />
      </div>
    </div>
  );
}

function PreviewBanner() {
  return (
    <div
      className="rounded-lg border border-primary/30 bg-primary/5 p-4 flex flex-col sm:flex-row sm:items-center gap-3"
      data-testid="trust-public-banner"
    >
      <div className="flex items-start gap-3 flex-1">
        <Sparkles className="w-5 h-5 text-primary mt-0.5 shrink-0" />
        <div className="space-y-1">
          <div className="text-sm font-semibold flex items-center gap-2">
            Representative preview
            <Badge
              variant="outline"
              className="font-mono uppercase text-[10px]"
            >
              demo data
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            This is a public, signed-out preview of the Trust Center
            with seeded demo numbers — every figure on a real tenant
            is assembled from that tenant's live runtime state.
            Procurement reviewers can use it during a security
            questionnaire before a contract is signed.
          </p>
        </div>
      </div>
      <div className="shrink-0">
        <Button asChild size="sm" data-testid="button-trust-public-cta">
          <Link href="/sign-up">
            Get a live tenant
            <ArrowRight className="w-4 h-4 ml-1" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function Header({ summary }: { summary: TrustSummary }) {
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
          Sample posture for{" "}
          <strong>{summary.tenant.orgName}</strong> — illustrating the
          live data the in-app Trust Center surfaces for every
          customer. Snapshot generated{" "}
          {formatDateTime(summary.generatedAt)}.
        </p>
      </div>
    </div>
  );
}

function GetLiveTenantCta() {
  return (
    <div
      className="rounded-lg border bg-card p-6 flex flex-col sm:flex-row sm:items-center gap-4"
      data-testid="trust-public-cta-footer"
    >
      <div className="flex-1 space-y-1">
        <div className="text-base font-semibold">
          Want this for your own tenant?
        </div>
        <p className="text-sm text-muted-foreground">
          Spin up a Procuro workspace and your Trust Center page will
          populate with your own collector matrix, citation coverage,
          and audit posture — no manual configuration.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button asChild variant="outline" size="sm">
          <Link href="/sign-in">Sign in</Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/sign-up">
            Get a live tenant
            <ArrowRight className="w-4 h-4 ml-1" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
