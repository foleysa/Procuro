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
 * Tenant-wide settings consolidated for the Org Admin UI. Wraps fields
 * that historically lived on `/system` (retry budgets), `/me/settings`
 * (disclosure policy), and the contracts task (renewal alert threshold).
 *
 * The disclosure policy edit lives here in addition to `/me/settings`
 * so admins can manage everything in one place; the legacy endpoint
 * stays for back-compat.
 */
const TenantSettingsSchema = z.object({
  successFeePct: z.number().min(0).max(100).optional(),
  baseCurrency: z.string().min(3).max(8).optional(),
  disclosurePolicy: z
    .enum(["conservative", "standard", "analyst"])
    .optional(),
  contractRenewalAlertDays: z.number().int().min(0).max(365).optional(),
  retentionDefaultDays: z.number().int().min(30).max(3650).optional(),
});
export type TenantSettings = z.infer<typeof TenantSettingsSchema>;

function readSettings(org: typeof orgsTable.$inferSelect): TenantSettings {
  const s = (org.settings ?? {}) as Record<string, unknown>;
  return {
    successFeePct: Number(org.successFeePct),
    baseCurrency: org.baseCurrency,
    disclosurePolicy:
      typeof s["disclosurePolicy"] === "string" &&
      ["conservative", "standard", "analyst"].includes(
        s["disclosurePolicy"] as string,
      )
        ? (s["disclosurePolicy"] as TenantSettings["disclosurePolicy"])
        : "standard",
    contractRenewalAlertDays:
      typeof s["contractRenewalAlertDays"] === "number"
        ? (s["contractRenewalAlertDays"] as number)
        : 60,
    retentionDefaultDays:
      typeof s["retentionDefaultDays"] === "number"
        ? (s["retentionDefaultDays"] as number)
        : 365,
  };
}

router.get(
  "/admin/tenant-settings",
  tenantMiddleware,
  requirePermission("settings:write"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const [org] = await db.select().from(orgsTable).where(eq(orgsTable.id, orgId));
    if (!org) {
      throw new NotFoundError("Org not found");
    }
    res.json(readSettings(org));
  },
);

router.put(
  "/admin/tenant-settings",
  tenantMiddleware,
  requirePermission("settings:write"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const body = TenantSettingsSchema.parse(req.body);
    const actor = req.actorEmail ?? "system@procuro.ai";

    const [current] = await db
      .select()
      .from(orgsTable)
      .where(eq(orgsTable.id, orgId));
    if (!current) {
      throw new NotFoundError("Org not found");
    }

    const nextSettings: Record<string, unknown> = {
      ...(current.settings ?? {}),
    };
    if (body.disclosurePolicy !== undefined)
      nextSettings["disclosurePolicy"] = body.disclosurePolicy;
    if (body.contractRenewalAlertDays !== undefined)
      nextSettings["contractRenewalAlertDays"] = body.contractRenewalAlertDays;
    if (body.retentionDefaultDays !== undefined)
      nextSettings["retentionDefaultDays"] = body.retentionDefaultDays;

    const update: Partial<typeof orgsTable.$inferInsert> = {
      settings: nextSettings,
    };
    if (body.successFeePct !== undefined) {
      update.successFeePct = body.successFeePct.toFixed(2);
    }
    if (body.baseCurrency !== undefined) {
      update.baseCurrency = body.baseCurrency.toUpperCase();
    }

    const [updated] = await db
      .update(orgsTable)
      .set(update)
      .where(eq(orgsTable.id, orgId))
      .returning();

    await writeAdminAudit({
      orgId,
      actor,
      action: "tenant.settings_update",
      targetId: orgId,
      targetLabel: current.name,
      metadata: body as Record<string, unknown>,
    });

    res.json(readSettings(updated!));
  },
);

export default router;
