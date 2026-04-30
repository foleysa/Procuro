import { Router, type IRouter } from "express";
import {
  db,
  collectorsTable,
  collectorTenantOptInsTable,
  marketSignalSchemaDriftTable,
  jobKindSettingsTable,
  adminAuditLogTable,
  opportunitiesTable,
  orgsTable,
  type JobKind,
} from "@workspace/db";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import {
  getCollector,
  listRegisteredCollectorIds,
} from "../lib/intelligence/runtime";
import { resolvePostureClass } from "../lib/intelligence/workbench-helpers";
import { readDisclosurePolicy } from "../lib/disclosure-policy";
import { readSsoConfig } from "./admin-sso";
import { rolePermissions } from "../lib/rbac";
import { userRoleNames } from "@workspace/db";
import {
  MAX_ATTEMPTS_BY_KIND,
} from "../lib/jobs/queue";

const router: IRouter = Router();

/**
 * Configurable job kinds whose retry budget is operator-tunable. Mirrors
 * the list in `routes/jobs.ts` — kept in sync there because that file
 * is where operators configure overrides; the Trust Center surface
 * only displays them.
 */
const CONFIGURABLE_JOB_KINDS: readonly JobKind[] = [
  "ingest_csv",
  "ingest_mock_erp",
  "run_analysis_cycle",
  "run_collector",
  "sync_erp_connection",
];

/**
 * Audit-log retention surfaced to the trust page. Matches the platform's
 * H1 default; can be raised per-tenant in H2 once tiered retention
 * lands. Env-overridable so a paying tenant can be told the truth on
 * day one without a code change.
 */
const AUDIT_RETENTION_DAYS = (() => {
  const raw = process.env["TRUST_AUDIT_RETENTION_DAYS"];
  if (!raw) return 365;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 365;
})();

/**
 * Static security contact. Surfaced in the page so a reviewer can
 * report a vulnerability without a sales call. Env-overridable so a
 * GTM operator can rotate the address without redeploying.
 */
const SECURITY_CONTACT_EMAIL =
  process.env["TRUST_SECURITY_CONTACT"] ?? "security@procuro.ai";
const SECURITY_PGP_URL = process.env["TRUST_SECURITY_PGP_URL"] ?? null;

/**
 * Compliance-attestation roadmap. Driven by env so GTM can flip a
 * status to `attested` the day the SOC 2 report lands without waiting
 * for a deploy of new copy. The shape mirrors `TrustComplianceAttestation`
 * in the OpenAPI spec.
 *
 * Phase 1 ships honest defaults: SOC 2 Type II in progress, the rest
 * planned. H2.7 (per the roadmap referenced in task #121) will flip
 * SOC 2 to `attested`.
 */
type AttestationStatus = "in_progress" | "attested" | "planned" | "not_applicable";
interface ComplianceAttestation {
  name: string;
  status: AttestationStatus;
  detail: string | null;
  asOf: string | null;
}

function defaultAttestations(): ComplianceAttestation[] {
  return [
    {
      name: "SOC 2 Type II",
      status: "in_progress",
      detail:
        "Controls audited; Type I report in review. Type II observation window opens on completion.",
      asOf: null,
    },
    {
      name: "ISO 27001",
      status: "planned",
      detail: "Targeted alongside SOC 2 Type II.",
      asOf: null,
    },
    {
      name: "GDPR readiness",
      status: "in_progress",
      detail:
        "Sub-processor list maintained; DSAR workflow in design (separate roadmap item).",
      asOf: null,
    },
    {
      name: "HIPAA",
      status: "not_applicable",
      detail: "Procuro processes procurement-financial data, not PHI.",
      asOf: null,
    },
  ];
}

router.get(
  "/trust/summary",
  tenantMiddleware,
  requirePermission("read"),
  async (req, res) => {
    const orgId = requireOrgId(req);

    // 1) Active org context (name + disclosure policy).
    const [org] = await db
      .select()
      .from(orgsTable)
      .where(eq(orgsTable.id, orgId));
    if (!org) {
      res.status(404).json({ error: "Org not found" });
      return;
    }
    const disclosurePolicy = readDisclosurePolicy(org.settings);

    // 2) Resolve the per-tenant collector opt-in matrix and merge with
    //    the platform registry. Mirrors the resolution rule used in
    //    GET /collectors so the Trust page never disagrees with the
    //    Collector Workbench about what is enabled for *this* tenant.
    const optInRows = await db
      .select({
        collectorId: collectorTenantOptInsTable.collectorId,
        optedIn: collectorTenantOptInsTable.optedIn,
      })
      .from(collectorTenantOptInsTable)
      .where(eq(collectorTenantOptInsTable.orgId, orgId));
    const tenantOptIns = new Map(
      optInRows.map((r) => [r.collectorId, r.optedIn === 1] as const),
    );

    const dbCollectors = await db.select().from(collectorsTable);
    const dbById = new Map(dbCollectors.map((c) => [c.id, c] as const));

    interface TrustCollectorRow {
      id: string;
      name: string;
      posture: "public-api" | "published-data" | "respect-robots-crawl" | "aggressive-crawl";
      postureClass: "public_api" | "tos_restricted" | "gray_hat";
      disclosureTier: "T1" | "T2" | "T3" | "T4";
      status: "enabled" | "disabled" | "killed";
      killSwitch: boolean;
      jurisdiction: string;
      retentionDays: number | null;
      tenantOptedIn: boolean | null;
    }
    const collectorSummaries: TrustCollectorRow[] = [];
    const seen = new Set<string>();

    const resolveOptIn = (
      id: string,
      defaultOptIn: boolean | null,
    ): boolean | null =>
      tenantOptIns.has(id) ? (tenantOptIns.get(id) ?? defaultOptIn) : defaultOptIn;

    for (const dbRow of dbCollectors) {
      const reg = getCollector(dbRow.id);
      const tenantOptInDefault = reg?.tenantOptInDefault ?? null;
      const tenantOptedIn = resolveOptIn(dbRow.id, tenantOptInDefault);
      // Hide collectors a tenant has explicitly opted out of so the
      // page never claims "we collect this on your behalf" when we
      // don't.
      if (tenantOptedIn === false) continue;
      seen.add(dbRow.id);
      collectorSummaries.push({
        id: dbRow.id,
        name: dbRow.name,
        posture: dbRow.posture,
        postureClass: reg ? resolvePostureClass(reg) : "tos_restricted",
        disclosureTier: reg?.disclosureTier ?? "T1",
        status:
          dbRow.killSwitch === 1
            ? "killed"
            : dbRow.status === "approved"
              ? "enabled"
              : "disabled",
        killSwitch: dbRow.killSwitch === 1,
        jurisdiction: reg?.jurisdiction ?? "GLOBAL",
        retentionDays: reg?.retentionDays ?? null,
        tenantOptedIn,
      });
    }
    // Include registry-only collectors (registered in code but not yet
    // persisted) so the page reflects the full intent of the platform.
    for (const id of listRegisteredCollectorIds()) {
      if (seen.has(id)) continue;
      const reg = getCollector(id)!;
      const tenantOptInDefault = reg.tenantOptInDefault ?? null;
      const tenantOptedIn = resolveOptIn(id, tenantOptInDefault);
      if (tenantOptedIn === false) continue;
      collectorSummaries.push({
        id,
        name: reg.name,
        posture: reg.posture,
        postureClass: resolvePostureClass(reg),
        disclosureTier: reg.disclosureTier ?? "T1",
        status: "disabled",
        killSwitch: false,
        jurisdiction: reg.jurisdiction ?? "GLOBAL",
        retentionDays: reg.retentionDays ?? null,
        tenantOptedIn,
      });
    }

    const enabledCollectors = collectorSummaries.filter(
      (c) => c.status === "enabled",
    );
    const byTier = { T1: 0, T2: 0, T3: 0, T4: 0 };
    for (const c of enabledCollectors) byTier[c.disclosureTier] += 1;

    const killedCollectors = collectorSummaries
      .filter((c) => c.status === "killed")
      .map((c) => ({ id: c.id, name: c.name }));

    // 3) Recent schema drift events (platform-wide; the drift table is
    //    not tenant-scoped because the upstream feed shape is the
    //    same for everyone).
    const driftCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [{ cnt: driftCnt = 0 } = { cnt: 0 }] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(marketSignalSchemaDriftTable)
      .where(gte(marketSignalSchemaDriftTable.createdAt, driftCutoff));
    const driftRows = await db
      .select()
      .from(marketSignalSchemaDriftTable)
      .where(gte(marketSignalSchemaDriftTable.createdAt, driftCutoff))
      .orderBy(desc(marketSignalSchemaDriftTable.createdAt))
      .limit(10);

    // 4) Effective per-kind retry budgets for the active tenant.
    const overrideRows = await db
      .select()
      .from(jobKindSettingsTable)
      .where(eq(jobKindSettingsTable.orgId, orgId));
    const overrideByKind = new Map(
      overrideRows.map((r) => [r.kind, r] as const),
    );
    const retryBudgets = CONFIGURABLE_JOB_KINDS.map((kind) => {
      const override = overrideByKind.get(kind);
      const def = MAX_ATTEMPTS_BY_KIND[kind] ?? 3;
      return {
        kind,
        maxAttempts: override?.maxAttempts ?? def,
        defaultMaxAttempts: def,
        isOverride: override !== undefined,
      };
    });

    // 5) Audit-log volume (last 30 days) and last event timestamp.
    const auditCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [auditCountRow] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, orgId),
          gte(adminAuditLogTable.createdAt, auditCutoff),
        ),
      );
    const [lastAuditRow] = await db
      .select({ createdAt: adminAuditLogTable.createdAt })
      .from(adminAuditLogTable)
      .where(eq(adminAuditLogTable.orgId, orgId))
      .orderBy(desc(adminAuditLogTable.createdAt))
      .limit(1);

    // 6) Citation-verification coverage. An opportunity is "verified"
    //    when its `inputs.sources` JSON array has at least one entry.
    //    SQL-side counted via JSON path for the active tenant only.
    const [oppTotalRow] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.orgId, orgId));
    const [oppVerifiedRow] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(opportunitiesTable)
      .where(
        and(
          eq(opportunitiesTable.orgId, orgId),
          sql`jsonb_typeof(${opportunitiesTable.inputs} -> 'sources') = 'array'`,
          sql`jsonb_array_length(${opportunitiesTable.inputs} -> 'sources') > 0`,
        ),
      );
    const oppTotal = Number(oppTotalRow?.cnt ?? 0);
    const oppVerified = Number(oppVerifiedRow?.cnt ?? 0);
    const coveragePct = oppTotal > 0 ? oppVerified / oppTotal : 0;

    // 7) Identity & access — surface the SSO config (without the
    //    free-form notes / metadata URL: those are admin-only
    //    operational details, not public posture).
    const sso = readSsoConfig(org.settings);
    const roleCatalogue = userRoleNames.map((role) => ({
      role,
      permissions: [...rolePermissions(role)],
    }));

    res.json({
      generatedAt: new Date().toISOString(),
      tenant: {
        orgId: org.id,
        orgName: org.name,
        disclosurePolicy,
      },
      dataSources: {
        enabledCount: enabledCollectors.length,
        totalCount: collectorSummaries.length,
        byTier,
        collectors: collectorSummaries,
      },
      operationalControls: {
        killSwitch: {
          killedCount: killedCollectors.length,
          killedCollectors,
        },
        schemaDrift: {
          recentEventCount: Number(driftCnt),
          recentEvents: driftRows.map((r) => ({
            id: r.id,
            collectorId: r.collectorId,
            fieldPath: r.fieldPath,
            message: r.message,
            occurrences: r.occurrences,
            createdAt: r.createdAt,
          })),
        },
        retryBudgets,
      },
      provenance: {
        opportunitiesTotal: oppTotal,
        opportunitiesWithCitations: oppVerified,
        opportunitiesUnverified: Math.max(0, oppTotal - oppVerified),
        coveragePct,
      },
      audit: {
        retentionDays: AUDIT_RETENTION_DAYS,
        eventCount30d: Number(auditCountRow?.cnt ?? 0),
        lastEventAt: lastAuditRow?.createdAt ?? null,
        exportFormats: ["csv"],
      },
      identity: {
        sso: {
          enabled: sso.enabled,
          protocol: sso.enabled ? sso.protocol : null,
          idpName: sso.enabled ? sso.idpName : null,
          emailDomains: sso.emailDomains,
        },
        scimEnabled: sso.scimEnabled,
        roles: roleCatalogue,
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

    req.log.info(
      {
        orgId,
        enabledCollectors: enabledCollectors.length,
        oppTotal,
        oppVerified,
      },
      "Served trust summary",
    );
  },
);

export default router;
