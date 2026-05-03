import { Router, type IRouter } from "express";
import { db, orgsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { NotFoundError } from "../lib/api-errors";
import { writeAdminAudit } from "../lib/admin-audit";
import { z } from "zod";

const router: IRouter = Router();

/**
 * Per-tenant SSO configuration. Clerk hosts the actual SAML/OIDC IdP
 * connections (managed via the Clerk Auth pane in Replit), so this
 * endpoint stores only the tenant-specific metadata operators want to
 * surface in the admin UI: domains the SSO covers, the Clerk-side
 * connection IDs we expect, and a free-form notes field for the
 * onboarding handoff.
 *
 * Stored under `orgs.settings.sso` so we don't need a dedicated table
 * for what is effectively a small JSON blob per tenant.
 */
const SsoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  protocol: z.enum(["saml", "oidc"]).default("saml"),
  idpName: z.string().max(80).default("okta"),
  emailDomains: z.array(z.string().min(3).max(120)).max(20).default([]),
  clerkConnectionId: z.string().max(120).nullable().optional(),
  metadataUrl: z.string().url().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  scimEnabled: z.boolean().default(false),
});
export type SsoConfig = z.infer<typeof SsoConfigSchema>;

const DEFAULT_SSO: SsoConfig = {
  enabled: false,
  protocol: "saml",
  idpName: "okta",
  emailDomains: [],
  clerkConnectionId: null,
  metadataUrl: null,
  notes: null,
  scimEnabled: false,
};

export function readSsoConfig(settings: unknown): SsoConfig {
  if (!settings || typeof settings !== "object") return DEFAULT_SSO;
  const raw = (settings as Record<string, unknown>)["sso"];
  if (!raw) return DEFAULT_SSO;
  const parsed = SsoConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SSO;
}

router.get(
  "/admin/sso",
  tenantMiddleware,
  requirePermission("settings:write"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const [org] = await db
      .select({ settings: orgsTable.settings })
      .from(orgsTable)
      .where(eq(orgsTable.id, orgId));
    if (!org) {
      throw new NotFoundError("Org not found");
    }
    res.json(readSsoConfig(org.settings));
  },
);

router.put(
  "/admin/sso",
  tenantMiddleware,
  requirePermission("settings:write"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const body = SsoConfigSchema.parse(req.body);
    const actor = req.actorEmail ?? "system@procuro.ai";

    const [current] = await db
      .select()
      .from(orgsTable)
      .where(eq(orgsTable.id, orgId));
    if (!current) {
      throw new NotFoundError("Org not found");
    }
    const next = { ...(current.settings ?? {}) } as Record<string, unknown>;
    next["sso"] = body;
    await db
      .update(orgsTable)
      .set({ settings: next })
      .where(eq(orgsTable.id, orgId));

    await writeAdminAudit({
      orgId,
      actor,
      action: "sso.config_update",
      targetId: orgId,
      targetLabel: current.name,
      metadata: { enabled: body.enabled, protocol: body.protocol },
    });

    res.json(body);
  },
);

export default router;
