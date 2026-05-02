import { Router, type IRouter } from "express";
import { and, eq, gte } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission, rolePermissions } from "../lib/rbac";
import { userRoleNames, type JobKind, db, adminAuditLogTable } from "@workspace/db";
import { MAX_ATTEMPTS_BY_KIND } from "../lib/jobs/queue";
import {
  buildTrustSummary,
  serializeTrustSummary,
  OrgNotFoundError,
  CONFIGURABLE_JOB_KINDS,
  defaultAttestations,
  AUDIT_RETENTION_DAYS,
  SECURITY_CONTACT_EMAIL,
  SECURITY_PGP_URL,
} from "../lib/trust/summary";
import { renderTrustSummaryPdf } from "../lib/trust/pdf";
import { writeAdminAudit } from "../lib/admin-audit";

/**
 * Window for collapsing repeated `trust.view` events from the same
 * actor. A reviewer reloading the page or a polling integration would
 * otherwise drown out the signal — by skipping any duplicate view
 * inside this window we keep the audit-log table small while still
 * capturing every meaningful "someone looked at our posture" event.
 */
const TRUST_VIEW_DEDUPE_MS = 5 * 60 * 1000;

const router: IRouter = Router();

router.get(
  "/trust/summary",
  tenantMiddleware,
  requirePermission("read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    let summary;
    try {
      summary = await buildTrustSummary(orgId);
    } catch (err) {
      if (err instanceof OrgNotFoundError) {
        res.status(404).json({ error: "Org not found" });
        return;
      }
      throw err;
    }

    // Record a `trust.view` event so Org Admin can show how often the
    // page is fetched. Skip if the same actor already logged a view
    // within the dedupe window — keeps the audit log uncluttered when
    // a reviewer is rapidly refreshing or a polling integration hits
    // this endpoint repeatedly.
    const actor = req.actorEmail ?? "system@procuro.ai";
    try {
      const dedupeCutoff = new Date(Date.now() - TRUST_VIEW_DEDUPE_MS);
      const [recent] = await db
        .select({ id: adminAuditLogTable.id })
        .from(adminAuditLogTable)
        .where(
          and(
            eq(adminAuditLogTable.orgId, orgId),
            eq(adminAuditLogTable.action, "trust.view"),
            eq(adminAuditLogTable.actor, actor),
            gte(adminAuditLogTable.createdAt, dedupeCutoff),
          ),
        )
        .limit(1);
      if (!recent) {
        await writeAdminAudit({
          orgId,
          actor,
          action: "trust.view",
          targetId: orgId,
          targetLabel: summary.tenant.orgName,
          metadata: { authMode: req.authMode ?? "unknown" },
        });
      }
    } catch (err) {
      // Audit-write failures must never break the trust response.
      req.log.warn({ err, orgId, actor }, "Failed to record trust.view audit");
    }

    res.json(serializeTrustSummary(summary));

    req.log.info(
      {
        orgId,
        enabledCollectors: summary.dataSources.enabledCount,
        oppTotal: summary.provenance.opportunitiesTotal,
        oppVerified: summary.provenance.opportunitiesWithCitations,
      },
      "Served trust summary",
    );
  },
);

/**
 * Public, signed-out preview of the Trust Center. Returns a fixed
 * "demo tenant" payload that mirrors the live `/trust/summary` shape
 * so the same React components can render both views.
 *
 * Why this is hand-rolled fixture data (rather than a real tenant
 * query): we never want to leak any real tenant's collector matrix,
 * drift history, or audit volume to an unauthenticated viewer; and the
 * URL is meant to be handed out during a security questionnaire before
 * a contract is signed, so the numbers should look representative of a
 * typical mid-sized customer rather than whatever tenant happens to be
 * sorted first in the orgs table. The compliance attestation roadmap
 * matches the live `defaultAttestations()` output so a prospect sees
 * identical posture either way.
 *
 * Mounted intentionally WITHOUT `tenantMiddleware` and WITHOUT a
 * permission gate — anyone can hit it.
 */
const DEMO_GENERATED_AT_TICK_MS = 60 * 1000; // bucket to a stable minute
function publicGeneratedAt(): string {
  const now = Date.now();
  return new Date(now - (now % DEMO_GENERATED_AT_TICK_MS)).toISOString();
}

router.get("/trust/public-summary", (_req, res) => {
  const generatedAt = publicGeneratedAt();
  res.json({
    generatedAt,
    tenant: {
      orgId: "demo-acme",
      orgName: "Acme Corporation (sample tenant)",
      disclosurePolicy: "standard",
    },
    dataSources: {
      enabledCount: 7,
      totalCount: 9,
      byTier: { T1: 4, T2: 2, T3: 1, T4: 0 },
      collectors: [
        {
          id: "sec-edgar",
          name: "SEC EDGAR",
          posture: "public-api",
          postureClass: "public_api",
          disclosureTier: "T1",
          status: "enabled",
          killSwitch: false,
          jurisdiction: "US",
          retentionDays: 365,
          tenantOptedIn: true,
        },
        {
          id: "gleif-lei",
          name: "GLEIF LEI",
          posture: "public-api",
          postureClass: "public_api",
          disclosureTier: "T2",
          status: "enabled",
          killSwitch: false,
          jurisdiction: "GLOBAL",
          retentionDays: 1095,
          tenantOptedIn: true,
        },
        {
          id: "uk-companies-house",
          name: "UK Companies House",
          posture: "public-api",
          postureClass: "public_api",
          disclosureTier: "T1",
          status: "enabled",
          killSwitch: false,
          jurisdiction: "UK",
          retentionDays: 365,
          tenantOptedIn: true,
        },
        {
          id: "eu-vies",
          name: "EU VIES VAT",
          posture: "public-api",
          postureClass: "public_api",
          disclosureTier: "T1",
          status: "enabled",
          killSwitch: false,
          jurisdiction: "EU",
          retentionDays: 180,
          tenantOptedIn: true,
        },
        {
          id: "ofac-sdn",
          name: "OFAC SDN list",
          posture: "published-data",
          postureClass: "public_api",
          disclosureTier: "T1",
          status: "enabled",
          killSwitch: false,
          jurisdiction: "US",
          retentionDays: 365,
          tenantOptedIn: true,
        },
        {
          id: "supplier-overlay",
          name: "Procuro entity overlay",
          posture: "published-data",
          postureClass: "public_api",
          disclosureTier: "T2",
          status: "enabled",
          killSwitch: false,
          jurisdiction: "GLOBAL",
          retentionDays: 365,
          tenantOptedIn: true,
        },
        {
          id: "industry-feed-sample",
          name: "Industry analyst feed",
          posture: "respect-robots-crawl",
          postureClass: "tos_restricted",
          disclosureTier: "T3",
          status: "enabled",
          killSwitch: false,
          jurisdiction: "GLOBAL",
          retentionDays: 90,
          tenantOptedIn: true,
        },
        {
          id: "deprecated-feed",
          name: "Legacy market feed",
          posture: "public-api",
          postureClass: "public_api",
          disclosureTier: "T2",
          status: "killed",
          killSwitch: true,
          jurisdiction: "GLOBAL",
          retentionDays: 90,
          tenantOptedIn: true,
        },
        {
          id: "model-inference-sample",
          name: "Internal inference (T4)",
          posture: "respect-robots-crawl",
          postureClass: "tos_restricted",
          disclosureTier: "T4",
          status: "disabled",
          killSwitch: false,
          jurisdiction: "GLOBAL",
          retentionDays: 30,
          tenantOptedIn: false,
        },
      ],
    },
    operationalControls: {
      killSwitch: {
        killedCount: 1,
        killedCollectors: [
          { id: "deprecated-feed", name: "Legacy market feed" },
        ],
      },
      schemaDrift: {
        recentEventCount: 2,
        recentEvents: [
          {
            id: "drift-sample-1",
            collectorId: "sec-edgar",
            fieldPath: "$.filing.formType",
            message:
              "Upstream renamed `formType` to `form_type`; collector quarantined and remapped.",
            occurrences: 4,
            createdAt: new Date(
              Date.now() - 6 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          },
          {
            id: "drift-sample-2",
            collectorId: "uk-companies-house",
            fieldPath: "$.address.country",
            message:
              "New ISO-3166 alias appeared in upstream payload; safelist updated.",
            occurrences: 1,
            createdAt: new Date(
              Date.now() - 18 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          },
        ],
      },
      retryBudgets: CONFIGURABLE_JOB_KINDS.map((kind) => ({
        kind,
        maxAttempts: MAX_ATTEMPTS_BY_KIND[kind] ?? 3,
        defaultMaxAttempts: MAX_ATTEMPTS_BY_KIND[kind] ?? 3,
        isOverride: false,
      })),
    },
    provenance: {
      opportunitiesTotal: 142,
      opportunitiesWithCitations: 121,
      opportunitiesUnverified: 21,
      coveragePct: 121 / 142,
    },
    audit: {
      retentionDays: AUDIT_RETENTION_DAYS,
      eventCount30d: 386,
      lastEventAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      exportFormats: ["csv"],
    },
    identity: {
      sso: {
        enabled: true,
        protocol: "saml",
        idpName: "Okta (sample)",
        emailDomains: ["acme.example.com"],
      },
      scimEnabled: true,
      roles: userRoleNames.map((role) => ({
        role,
        permissions: [...rolePermissions(role)],
      })),
    },
    compliance: {
      attestations: defaultAttestations(),
      dpaUrl: process.env["TRUST_DPA_URL"] ?? null,
      subProcessorsUrl: process.env["TRUST_SUBPROCESSORS_URL"] ?? null,
      securityContact: {
        email: SECURITY_CONTACT_EMAIL,
        pgpKeyUrl: SECURITY_PGP_URL,
      },
    },
  });
});

/**
 * Server-side PDF render of the Trust Center for procurement reviewers
 * who need to attach a deliverable to a sourcing ticket.
 *
 * The PDF is built directly from the same `buildTrustSummary` payload
 * the in-app page renders, so the two surfaces can never disagree.
 * pdfkit (already a dependency for Defense Pack PDFs) is used in
 * preference to a headless browser to keep the runtime dependency
 * surface small.
 *
 * Filename pattern: `procuro-trust-{org-slug}-{yyyy-mm-dd}.pdf`.
 */
router.get(
  "/trust/summary.pdf",
  tenantMiddleware,
  requirePermission("read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    let summary;
    try {
      summary = await buildTrustSummary(orgId);
    } catch (err) {
      if (err instanceof OrgNotFoundError) {
        res.status(404).json({ error: "Org not found" });
        return;
      }
      throw err;
    }

    const pdf = await renderTrustSummaryPdf(summary);
    const datePart = summary.generatedAt.slice(0, 10);
    const slugPart = sanitizeFilenamePart(
      summary.tenant.orgSlug || summary.tenant.orgId,
    );
    const filename = `procuro-trust-${slugPart}-${datePart}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader("Content-Length", String(pdf.length));
    res.end(pdf);

    req.log.info(
      { orgId, filename, bytes: pdf.length },
      "Served trust summary PDF",
    );
  },
);

/**
 * Strip anything that would be hostile in a `Content-Disposition`
 * filename or a downloaded file on disk. Keeps lower-case alphanumerics
 * and `-`/`_`; collapses repeats; falls back to "tenant" if the result
 * is empty.
 */
function sanitizeFilenamePart(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "tenant";
}

export default router;
