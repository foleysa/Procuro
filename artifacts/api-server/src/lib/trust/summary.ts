/**
 * Tenant-scoped Trust Center summary builder.
 *
 * Extracted from `routes/trust.ts` so both the JSON endpoint
 * (`GET /trust/summary`) and the PDF endpoint
 * (`GET /trust/summary.pdf`) share the exact same payload — a
 * reviewer who downloads the PDF gets the same numbers the in-app
 * page just rendered, with no risk of divergence between two
 * parallel implementations.
 */

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
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  getCollector,
  listRegisteredCollectorIds,
} from "../intelligence/runtime";
import { resolvePostureClass } from "../intelligence/workbench-helpers";
import { readDisclosurePolicy } from "../disclosure-policy";
import { readSsoConfig } from "../../routes/admin-sso";
import { rolePermissions } from "../rbac";
import { userRoleNames } from "@workspace/db";
import { MAX_ATTEMPTS_BY_KIND } from "../jobs/queue";

/**
 * Configurable job kinds whose retry budget is operator-tunable.
 * Mirrors the list in `routes/jobs.ts` — kept in sync there because
 * that file is where operators configure overrides; the Trust Center
 * surface only displays them.
 */
export const CONFIGURABLE_JOB_KINDS: readonly JobKind[] = [
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
export const AUDIT_RETENTION_DAYS = (() => {
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
export const SECURITY_CONTACT_EMAIL =
  process.env["TRUST_SECURITY_CONTACT"] ?? "security@procuro.ai";
export const SECURITY_PGP_URL = process.env["TRUST_SECURITY_PGP_URL"] ?? null;

type AttestationStatus =
  | "in_progress"
  | "attested"
  | "planned"
  | "not_applicable";

export interface ComplianceAttestation {
  name: string;
  status: AttestationStatus;
  detail: string | null;
  asOf: string | null;
}

export function defaultAttestations(): ComplianceAttestation[] {
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

export interface TrustCollectorRow {
  id: string;
  name: string;
  posture:
    | "public-api"
    | "published-data"
    | "respect-robots-crawl"
    | "aggressive-crawl";
  postureClass: "public_api" | "tos_restricted" | "gray_hat";
  disclosureTier: "T1" | "T2" | "T3" | "T4";
  status: "enabled" | "disabled" | "killed";
  killSwitch: boolean;
  jurisdiction: string;
  retentionDays: number | null;
  tenantOptedIn: boolean | null;
}

export interface TrustSummaryPayload {
  generatedAt: string;
  tenant: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    disclosurePolicy: string;
  };
  dataSources: {
    enabledCount: number;
    totalCount: number;
    byTier: { T1: number; T2: number; T3: number; T4: number };
    collectors: TrustCollectorRow[];
  };
  operationalControls: {
    killSwitch: {
      killedCount: number;
      killedCollectors: { id: string; name: string }[];
    };
    schemaDrift: {
      recentEventCount: number;
      recentEvents: {
        id: string;
        collectorId: string;
        fieldPath: string | null;
        message: string;
        occurrences: number;
        createdAt: Date;
      }[];
    };
    retryBudgets: {
      kind: JobKind;
      maxAttempts: number;
      defaultMaxAttempts: number;
      isOverride: boolean;
    }[];
  };
  provenance: {
    opportunitiesTotal: number;
    opportunitiesWithCitations: number;
    opportunitiesUnverified: number;
    coveragePct: number;
  };
  audit: {
    retentionDays: number;
    eventCount30d: number;
    lastEventAt: Date | null;
    exportFormats: string[];
  };
  identity: {
    sso: {
      enabled: boolean;
      protocol: string | null;
      idpName: string | null;
      emailDomains: string[];
    };
    scimEnabled: boolean;
    roles: { role: string; permissions: string[] }[];
  };
  compliance: {
    attestations: ComplianceAttestation[];
    dpaUrl: string | null;
    subProcessorsUrl: string | null;
    securityContact: { email: string; pgpKeyUrl: string | null };
  };
}

export class OrgNotFoundError extends Error {
  constructor(public readonly orgId: string) {
    super(`Org not found: ${orgId}`);
  }
}

export async function buildTrustSummary(
  orgId: string,
): Promise<TrustSummaryPayload> {
  // 1) Active org context (name + disclosure policy).
  const [org] = await db
    .select()
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId));
  if (!org) {
    throw new OrgNotFoundError(orgId);
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

  // 3) Recent schema drift events.
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

  // 6) Citation-verification coverage.
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

  // 7) Identity & access.
  const sso = readSsoConfig(org.settings);
  const roleCatalogue = userRoleNames.map((role) => ({
    role,
    permissions: [...rolePermissions(role)],
  }));

  return {
    generatedAt: new Date().toISOString(),
    tenant: {
      orgId: org.id,
      orgName: org.name,
      orgSlug: org.slug,
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
  };
}

/**
 * For the JSON wire format: the response carries `lastEventAt` and
 * schema-drift `createdAt` as ISO strings; pdfkit/JSON.stringify do
 * the right thing for `Date` instances but the API contract pins the
 * serialized strings explicitly.
 */
export function serializeTrustSummary(
  summary: TrustSummaryPayload,
): Record<string, unknown> {
  return {
    ...summary,
    operationalControls: {
      ...summary.operationalControls,
      schemaDrift: {
        ...summary.operationalControls.schemaDrift,
        recentEvents: summary.operationalControls.schemaDrift.recentEvents.map(
          (e) => ({
            ...e,
            createdAt:
              e.createdAt instanceof Date
                ? e.createdAt.toISOString()
                : e.createdAt,
          }),
        ),
      },
    },
    audit: {
      ...summary.audit,
      lastEventAt:
        summary.audit.lastEventAt instanceof Date
          ? summary.audit.lastEventAt.toISOString()
          : summary.audit.lastEventAt,
    },
  };
}
