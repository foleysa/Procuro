/**
 * Customer-facing Trust Center. The single page a procurement team's
 * compliance reviewer should be able to deep-link from a security
 * questionnaire — every section is tenant-scoped and assembled from
 * live system state via `GET /api/trust/summary`. Add `?print=1` to
 * the URL for a chrome-less, print-ready rendering (the wrapping
 * Layout is suppressed at the App.tsx level when the flag is set).
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

import { Link } from "wouter";
import {
  useGetTrustSummary,
  type TrustSummary,
  type TrustCollectorSummary,
  type TrustComplianceAttestationsItem,
  type InsightSource,
} from "@workspace/api-client-react";
import {
  Shield,
  ShieldCheck,
  Loader2,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  AlertTriangle,
  Printer,
  Mail,
  ExternalLink,
  KeyRound,
  Database,
  FileWarning,
  RefreshCcw,
  Lock,
  ScrollText,
  Fingerprint,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatPercent } from "@/lib/format";
import { usePolicy } from "@/lib/use-policy";
import { InsightCitations } from "@/components/insight-citations";
import { cn } from "@/lib/utils";

const TIER_TONE: Record<string, string> = {
  T1: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20",
  T2: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20",
  T3: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20",
  T4: "bg-muted text-muted-foreground border-border",
};

const TIER_TITLE: Record<string, string> = {
  T1: "T1 — Public, attributable",
  T2: "T2 — Public-API derivative, attributable",
  T3: "T3 — Quality-scored only",
  T4: "T4 — Inference, no provenance shown",
};

const TIER_BLURB: Record<string, string> = {
  T1: "Government filings, regulator disclosures, official APIs we can name and link directly.",
  T2: "Aggregations of T1 data (e.g. our entity-resolved overlays). Sources still attributable.",
  T3: "Sources whose ToS forbid republishing — we surface a confidence score, not the link.",
  T4: "Model-derived inference with no upstream citation. Used only when the tenant policy permits.",
};

export default function TrustPage() {
  const { data, isLoading, isError, refetch, isFetching } =
    useGetTrustSummary();
  const policy = usePolicy();
  const isPrint = isPrintMode();

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
      />

      <TenantSection summary={data} />
      <DataSourcesSection summary={data} />
      <OperationalControlsSection summary={data} />
      <ProvenanceSection summary={data} />
      <AuditSection summary={data} />
      <IdentitySection summary={data} />
      <ComplianceSection summary={data} />
      <DisclosureTierExplainer policy={policy} />

      <Footer generatedAt={data.generatedAt} />
    </div>
  );
}

function isPrintMode(): boolean {
  if (typeof window === "undefined") return false;
  const sp = new URLSearchParams(window.location.search);
  return sp.get("print") === "1";
}

function Header({
  summary,
  onRefresh,
  isFetching,
  isPrint,
}: {
  summary: TrustSummary;
  onRefresh: () => void;
  isFetching: boolean;
  isPrint: boolean;
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
        </div>
      )}
    </div>
  );
}

function TenantSection({ summary }: { summary: TrustSummary }) {
  const policy = summary.tenant.disclosurePolicy;
  return (
    <Card data-testid="trust-section-tenant">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="w-5 h-5 text-primary" /> Tenant context
        </CardTitle>
      </CardHeader>
      <CardContent className="grid sm:grid-cols-2 gap-6 text-sm">
        <KV label="Organization">{summary.tenant.orgName}</KV>
        <KV label="Org ID">
          <code className="text-xs">{summary.tenant.orgId}</code>
        </KV>
        <KV label="Active disclosure policy">
          <Badge variant="outline" className="font-mono uppercase">
            {policy}
          </Badge>
          <span className="ml-2 text-xs text-muted-foreground">
            {policyBlurb(policy)}
          </span>
        </KV>
      </CardContent>
    </Card>
  );
}

function policyBlurb(policy: string): string {
  if (policy === "conservative")
    return "Only T1/T2 sources are surfaced; T3/T4 are silently filtered.";
  if (policy === "analyst")
    return "All tiers shown including T4 inference, with appropriate labelling.";
  return "T1/T2 fully cited; T3 shown with quality score; T4 hidden.";
}

function DataSourcesSection({ summary }: { summary: TrustSummary }) {
  const ds = summary.dataSources;
  return (
    <Card data-testid="trust-section-data-sources">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="w-5 h-5 text-primary" /> Live data sources
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
          <Stat label="Enabled" value={ds.enabledCount} />
          <Stat label="Total visible" value={ds.totalCount} />
          <Stat label="T1" value={ds.byTier.T1} tone="T1" />
          <Stat label="T2" value={ds.byTier.T2} tone="T2" />
          <Stat label="T3" value={ds.byTier.T3} tone="T3" />
          <Stat label="T4" value={ds.byTier.T4} tone="T4" />
        </div>

        <p className="text-xs text-muted-foreground">
          Filtered to collectors your tenant has opted into. Killed
          collectors stay listed so you can see what was disabled
          platform-wide. Cross-link:{" "}
          <Link
            href="/data-sources"
            className="text-primary underline-offset-2 hover:underline"
            data-testid="link-trust-to-data-sources"
          >
            Data Sources
          </Link>
          .
        </p>

        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Posture</TableHead>
                <TableHead>Jurisdiction</TableHead>
                <TableHead>Retention</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ds.collectors.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    No collectors visible to this tenant yet.
                  </TableCell>
                </TableRow>
              )}
              {ds.collectors.map((c) => (
                <CollectorRow key={c.id} c={c} />
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function CollectorRow({ c }: { c: TrustCollectorSummary }) {
  return (
    <TableRow data-testid={`trust-collector-row-${c.id}`}>
      <TableCell className="font-medium">
        <div>{c.name}</div>
        <div className="text-[11px] font-mono text-muted-foreground">
          {c.id}
        </div>
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={cn("font-mono", TIER_TONE[c.disclosureTier])}
        >
          {c.disclosureTier}
        </Badge>
      </TableCell>
      <TableCell className="text-xs">
        <span className="font-mono">{c.postureClass}</span>
        <div className="text-muted-foreground">{c.posture}</div>
      </TableCell>
      <TableCell className="text-xs font-mono">{c.jurisdiction ?? "—"}</TableCell>
      <TableCell className="text-xs">
        {c.retentionDays != null ? `${c.retentionDays} d` : "—"}
      </TableCell>
      <TableCell>
        <StatusPill status={c.status} />
      </TableCell>
    </TableRow>
  );
}

function StatusPill({
  status,
}: {
  status: TrustCollectorSummary["status"];
}) {
  if (status === "killed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-300">
        <CircleSlash className="w-3 h-3" /> Killed
      </span>
    );
  }
  if (status === "enabled") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="w-3 h-3" /> Enabled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <CircleDashed className="w-3 h-3" /> Disabled
    </span>
  );
}

function OperationalControlsSection({ summary }: { summary: TrustSummary }) {
  const oc = summary.operationalControls;
  return (
    <Card data-testid="trust-section-operational">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" /> Operational controls
        </CardTitle>
      </CardHeader>
      <CardContent className="grid lg:grid-cols-3 gap-6">
        <div>
          <h3 className="text-sm font-semibold mb-2">Kill switch</h3>
          <p className="text-xs text-muted-foreground mb-2">
            Platform staff can disable any data source globally; killed
            sources are removed from your live feeds within seconds.
          </p>
          <div
            className="text-2xl font-bold"
            data-testid="trust-killed-count"
          >
            {oc.killSwitch.killedCount}
          </div>
          <div className="text-xs text-muted-foreground">
            currently killed
          </div>
          {oc.killSwitch.killedCollectors.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {oc.killSwitch.killedCollectors.slice(0, 5).map((k) => (
                <li key={k.id} className="flex items-center gap-1">
                  <CircleSlash className="w-3 h-3 text-red-500" /> {k.name}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Schema drift</h3>
          <p className="text-xs text-muted-foreground mb-2">
            We detect upstream feed shape changes and quarantine
            affected signals automatically.
          </p>
          <div
            className="text-2xl font-bold"
            data-testid="trust-drift-count"
          >
            {oc.schemaDrift.recentEventCount}
          </div>
          <div className="text-xs text-muted-foreground">
            events in the last 30 days
          </div>
          {oc.schemaDrift.recentEvents.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {oc.schemaDrift.recentEvents.slice(0, 4).map((e) => (
                <li key={e.id} className="flex items-start gap-1">
                  <FileWarning className="w-3 h-3 mt-0.5 text-amber-500 shrink-0" />
                  <span>
                    <span className="font-mono">{e.collectorId}</span>{" "}
                    — {e.message}{" "}
                    <span className="text-muted-foreground">
                      ({e.occurrences}× · {formatDateTime(e.createdAt)})
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Retry budgets</h3>
          <p className="text-xs text-muted-foreground mb-2">
            Per-job-kind ceiling on retries — bounds blast radius if an
            upstream goes haywire.
          </p>
          <ul className="space-y-1 text-xs">
            {oc.retryBudgets.map((r) => (
              <li
                key={r.kind}
                className="flex items-center justify-between gap-2"
                data-testid={`trust-retry-${r.kind}`}
              >
                <span className="font-mono truncate">{r.kind}</span>
                <span className="tabular-nums">
                  {r.maxAttempts}
                  {r.isOverride && (
                    <span className="ml-1 text-muted-foreground">
                      (default {r.defaultMaxAttempts})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function ProvenanceSection({ summary }: { summary: TrustSummary }) {
  const p = summary.provenance;
  const tone =
    p.coveragePct >= 0.8
      ? "text-emerald-700 dark:text-emerald-300"
      : p.coveragePct >= 0.5
        ? "text-amber-700 dark:text-amber-300"
        : "text-red-700 dark:text-red-300";
  return (
    <Card data-testid="trust-section-provenance">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="w-5 h-5 text-primary" /> Provenance &
          citations
        </CardTitle>
      </CardHeader>
      <CardContent className="grid sm:grid-cols-4 gap-6 text-sm">
        <Stat label="Opportunities" value={p.opportunitiesTotal} />
        <Stat
          label="With citations"
          value={p.opportunitiesWithCitations}
        />
        <Stat label="Unverified" value={p.opportunitiesUnverified} />
        <div>
          <div className="text-xs text-muted-foreground">Coverage</div>
          <div
            className={cn("text-2xl font-bold", tone)}
            data-testid="trust-coverage-pct"
          >
            {formatPercent(p.coveragePct)}
          </div>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-4">
          An opportunity is "verified" when at least one source
          descriptor is attached. T3/T4 sources still count for
          coverage even if the renderer hides them per the tenant's{" "}
          <code>{summary.tenant.disclosurePolicy}</code> policy. Open{" "}
          <Link
            href="/opportunities"
            className="text-primary underline-offset-2 hover:underline"
            data-testid="link-trust-to-opportunities"
          >
            Opportunities
          </Link>{" "}
          to inspect specific citations.
        </p>
      </CardContent>
    </Card>
  );
}

function AuditSection({ summary }: { summary: TrustSummary }) {
  const a = summary.audit;
  return (
    <Card data-testid="trust-section-audit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="w-5 h-5 text-primary" /> Audit & retention
        </CardTitle>
      </CardHeader>
      <CardContent className="grid sm:grid-cols-3 gap-6 text-sm">
        <Stat label="Retention" value={`${a.retentionDays} days`} />
        <Stat label="Events (30d)" value={a.eventCount30d} />
        <KV label="Last admin event">
          {a.lastEventAt ? formatDateTime(a.lastEventAt) : "—"}
        </KV>
        <p className="text-xs text-muted-foreground sm:col-span-3">
          Append-only admin audit log. Exportable as{" "}
          {a.exportFormats.join(", ")}; SIEM webhook delivery is on
          the H2 roadmap. Org admins can browse and export from{" "}
          <Link
            href="/admin"
            className="text-primary underline-offset-2 hover:underline"
            data-testid="link-trust-to-admin"
          >
            Org Admin
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

function IdentitySection({ summary }: { summary: TrustSummary }) {
  const i = summary.identity;
  return (
    <Card data-testid="trust-section-identity">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-primary" /> Identity & access
        </CardTitle>
      </CardHeader>
      <CardContent className="grid lg:grid-cols-2 gap-6 text-sm">
        <div className="space-y-2">
          <KV label="SSO">
            {i.sso.enabled ? (
              <span className="text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                {i.sso.idpName} ({i.sso.protocol?.toUpperCase()})
              </span>
            ) : (
              <span className="text-muted-foreground inline-flex items-center gap-1">
                <CircleDashed className="w-3 h-3" /> Not configured
              </span>
            )}
          </KV>
          <KV label="SCIM provisioning">
            {i.scimEnabled ? (
              <span className="text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Enabled
              </span>
            ) : (
              <span className="text-muted-foreground inline-flex items-center gap-1">
                <CircleDashed className="w-3 h-3" /> Disabled
              </span>
            )}
          </KV>
          {i.sso.enabled && (i.sso.emailDomains?.length ?? 0) > 0 && (
            <KV label="SSO domains">
              <div className="flex flex-wrap gap-1">
                {(i.sso.emailDomains ?? []).map((d) => (
                  <Badge key={d} variant="outline" className="font-mono text-[11px]">
                    {d}
                  </Badge>
                ))}
              </div>
            </KV>
          )}
          <p className="text-xs text-muted-foreground pt-2">
            Org admins manage SSO, SCIM, users, and API keys from{" "}
            <Link
              href="/admin"
              className="text-primary underline-offset-2 hover:underline"
            >
              Org Admin
            </Link>
            . Bearer API keys are SHA-256 hashed at rest.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Role catalogue</h3>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Permissions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {i.roles.map((r) => (
                  <TableRow
                    key={r.role}
                    data-testid={`trust-role-${r.role}`}
                  >
                    <TableCell className="font-mono text-xs">
                      {r.role}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.permissions.length === 0
                        ? "—"
                        : r.permissions.join(", ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ComplianceSection({ summary }: { summary: TrustSummary }) {
  const c = summary.compliance;
  return (
    <Card data-testid="trust-section-compliance">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" /> Compliance
          posture
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid sm:grid-cols-2 gap-3">
          {c.attestations.map((a) => (
            <AttestationCard key={a.name} attestation={a} />
          ))}
        </div>

        <div className="grid sm:grid-cols-3 gap-4 pt-2 border-t border-border/60">
          <DocLink
            label="DPA"
            url={c.dpaUrl}
            fallback="Available on request"
          />
          <DocLink
            label="Sub-processors"
            url={c.subProcessorsUrl}
            fallback="Available on request"
          />
          <div>
            <div className="text-xs text-muted-foreground">
              Security contact
            </div>
            <a
              href={`mailto:${c.securityContact.email}`}
              className="inline-flex items-center gap-1 text-primary hover:underline"
              data-testid="link-trust-security-contact"
            >
              <Mail className="w-3 h-3" />
              {c.securityContact.email}
            </a>
            {c.securityContact.pgpKeyUrl && (
              <a
                href={c.securityContact.pgpKeyUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="block text-xs text-muted-foreground hover:underline mt-1"
              >
                PGP key
                <ExternalLink className="w-3 h-3 inline ml-1" />
              </a>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AttestationCard({
  attestation,
}: {
  attestation: TrustComplianceAttestationsItem;
}) {
  const tone: Record<string, string> = {
    attested:
      "border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-200",
    in_progress:
      "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-200",
    planned: "border-border bg-muted/30 text-foreground",
    not_applicable:
      "border-border bg-muted/20 text-muted-foreground",
  };
  const Icon =
    attestation.status === "attested"
      ? CheckCircle2
      : attestation.status === "in_progress"
        ? AlertTriangle
        : attestation.status === "planned"
          ? CircleDashed
          : CircleSlash;
  return (
    <div
      className={cn("rounded-md border p-3", tone[attestation.status])}
      data-testid={`trust-attestation-${attestation.name.replace(/\s+/g, "-").toLowerCase()}`}
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="w-4 h-4" />
        {attestation.name}
      </div>
      <div className="text-[11px] uppercase tracking-wide font-mono mt-1 opacity-70">
        {attestation.status.replace("_", " ")}
      </div>
      {attestation.detail && (
        <p className="text-xs mt-2 opacity-90">{attestation.detail}</p>
      )}
      {attestation.asOf && (
        <p className="text-[11px] mt-1 opacity-70">
          As of {formatDateTime(attestation.asOf)}
        </p>
      )}
    </div>
  );
}

function DocLink({
  label,
  url,
  fallback,
}: {
  label: string;
  url: string | null | undefined;
  fallback: string;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          View document
          <ExternalLink className="w-3 h-3" />
        </a>
      ) : (
        <div className="text-sm text-muted-foreground">{fallback}</div>
      )}
    </div>
  );
}

function DisclosureTierExplainer({ policy }: { policy: string }) {
  // One synthetic source per tier, used to demonstrate exactly how the
  // citation renderer would treat each tier under the tenant's
  // current disclosure policy.
  const samples: Record<string, InsightSource> = {
    T1: {
      collectorId: "sec-edgar",
      collectorName: "SEC EDGAR",
      sourceUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany",
      observedAt: new Date().toISOString(),
      contract: {
        postureClass: "public_api",
        disclosureTier: "T1",
        jurisdiction: "US",
        retentionDays: 365,
        tenantOptInDefault: true,
      },
    },
    T2: {
      collectorId: "gleif-lei",
      collectorName: "GLEIF LEI",
      sourceUrl: "https://api.gleif.org/api/v1/lei-records",
      observedAt: new Date().toISOString(),
      contract: {
        postureClass: "public_api",
        disclosureTier: "T2",
        jurisdiction: "GLOBAL",
        retentionDays: 1095,
        tenantOptInDefault: true,
      },
    },
    T3: {
      collectorId: "tos-restricted-feed",
      collectorName: "ToS-restricted feed (sample)",
      sourceUrl: "https://example.com/sample-feed",
      observedAt: new Date().toISOString(),
      contract: {
        postureClass: "tos_restricted",
        disclosureTier: "T3",
        jurisdiction: "GLOBAL",
        retentionDays: 90,
        tenantOptInDefault: false,
      },
    },
    T4: {
      collectorId: "model-inference",
      collectorName: "Internal model inference (sample)",
      sourceUrl: "https://example.com/model",
      observedAt: new Date().toISOString(),
      contract: {
        postureClass: "tos_restricted",
        disclosureTier: "T4",
        jurisdiction: "GLOBAL",
        retentionDays: 30,
        tenantOptInDefault: false,
      },
    },
  };
  return (
    <Card data-testid="trust-section-tier-explainer">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" /> Disclosure tiers
          explained
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="text-xs text-muted-foreground">
          Every signal in Procuro carries a tier (T1–T4). Your active
          policy is{" "}
          <Badge variant="outline" className="font-mono uppercase">
            {policy}
          </Badge>
          . The samples below show exactly how the citation renderer
          would surface a source from each tier under that policy.
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          {(["T1", "T2", "T3", "T4"] as const).map((tier) => (
            <div
              key={tier}
              className="rounded-md border p-3 space-y-2"
              data-testid={`trust-tier-explainer-${tier}`}
            >
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn("font-mono", TIER_TONE[tier])}
                >
                  {tier}
                </Badge>
                <span className="text-sm font-semibold">
                  {TIER_TITLE[tier]}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {TIER_BLURB[tier]}
              </p>
              <InsightCitations
                sources={[samples[tier]!]}
                policy={
                  policy === "conservative" ||
                  policy === "standard" ||
                  policy === "analyst"
                    ? policy
                    : "standard"
                }
                aggregateConfidence={0.78}
                variant="card"
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Footer({ generatedAt }: { generatedAt: string }) {
  return (
    <div className="border-t border-border/60 pt-4 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
      <span>
        Snapshot: {formatDateTime(generatedAt)}. Every figure is
        live — no nightly batch.
      </span>
      <span>
        Procuro Trust Center · v1
      </span>
    </div>
  );
}

function KV({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-center flex-wrap gap-1">
        {children}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "T1" | "T2" | "T3" | "T4";
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {tone && (
          <Badge
            variant="outline"
            className={cn("font-mono text-[10px]", TIER_TONE[tone])}
          >
            {tone}
          </Badge>
        )}
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
