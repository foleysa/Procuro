import { Router, type IRouter } from "express";
import { db, apiKeysTable, userRoleNames, type UserRoleName } from "@workspace/db";
import { and, eq, desc, isNull } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { writeAdminAudit } from "../lib/admin-audit";
import { newId } from "../lib/ids";
import { generateToken } from "../lib/auth";
import { z } from "zod";

const router: IRouter = Router();

const CreateKeyBody = z.object({
  label: z.string().min(1).max(120),
  scopeRole: z
    .enum(userRoleNames)
    .refine(
      (r) => r !== "platform_admin",
      "Cannot scope tenant API keys to platform_admin",
    ),
});

router.get(
  "/admin/api-keys",
  tenantMiddleware,
  requirePermission("api_keys:manage"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const rows = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.orgId, orgId))
      .orderBy(desc(apiKeysTable.createdAt));
    res.json(
      rows.map((r) => ({
        id: r.id,
        label: r.label,
        prefix: r.prefix,
        scopeRole: r.scopeRole,
        createdAt: r.createdAt,
        createdBy: r.createdBy,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
        rotatedFromId: r.rotatedFromId,
      })),
    );
  },
);

router.post(
  "/admin/api-keys",
  tenantMiddleware,
  requirePermission("api_keys:manage"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const { label, scopeRole } = CreateKeyBody.parse(req.body);
    const actor = req.actorEmail ?? "system@procuro.ai";

    const { plain, hash } = generateToken();
    const prefix = plain.slice(0, 12);

    const [row] = await db
      .insert(apiKeysTable)
      .values({
        id: newId("ak"),
        orgId,
        label,
        prefix,
        tokenHash: hash,
        scopeRole: scopeRole as UserRoleName,
        createdBy: actor,
      })
      .returning();

    await writeAdminAudit({
      orgId,
      actor,
      action: "api_key.create",
      targetId: row?.id ?? null,
      targetLabel: label,
      metadata: { scopeRole, prefix },
    });

    res.status(201).json({
      id: row?.id,
      label,
      prefix,
      scopeRole,
      // PLAIN secret is returned EXACTLY ONCE. The UI must show it
      // immediately and warn the operator they cannot retrieve it again.
      secret: plain,
    });
  },
);

router.post(
  "/admin/api-keys/:id/rotate",
  tenantMiddleware,
  requirePermission("api_keys:manage"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params.id);
    const actor = req.actorEmail ?? "system@procuro.ai";

    const [existing] = await db
      .select()
      .from(apiKeysTable)
      .where(and(eq(apiKeysTable.orgId, orgId), eq(apiKeysTable.id, id)));
    if (!existing) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    if (existing.revokedAt) {
      res.status(409).json({ error: "Cannot rotate a revoked key" });
      return;
    }

    // Issue replacement, then revoke the old one.
    const { plain, hash } = generateToken();
    const prefix = plain.slice(0, 12);
    const [replacement] = await db
      .insert(apiKeysTable)
      .values({
        id: newId("ak"),
        orgId,
        label: existing.label,
        prefix,
        tokenHash: hash,
        scopeRole: existing.scopeRole,
        createdBy: actor,
        rotatedFromId: existing.id,
      })
      .returning();
    await db
      .update(apiKeysTable)
      .set({ revokedAt: new Date(), revokedBy: actor })
      .where(eq(apiKeysTable.id, id));

    await writeAdminAudit({
      orgId,
      actor,
      action: "api_key.rotate",
      targetId: replacement?.id ?? null,
      targetLabel: existing.label,
      metadata: { from: id, to: replacement?.id, scopeRole: existing.scopeRole },
    });

    res.status(201).json({
      id: replacement?.id,
      label: existing.label,
      prefix,
      scopeRole: existing.scopeRole,
      secret: plain,
      rotatedFromId: id,
    });
  },
);

router.delete(
  "/admin/api-keys/:id",
  tenantMiddleware,
  requirePermission("api_keys:manage"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params.id);
    const actor = req.actorEmail ?? "system@procuro.ai";

    const [existing] = await db
      .select()
      .from(apiKeysTable)
      .where(and(eq(apiKeysTable.orgId, orgId), eq(apiKeysTable.id, id)));
    if (!existing) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    if (existing.revokedAt) {
      res.status(409).json({ error: "Already revoked" });
      return;
    }
    await db
      .update(apiKeysTable)
      .set({ revokedAt: new Date(), revokedBy: actor })
      .where(eq(apiKeysTable.id, id));
    await writeAdminAudit({
      orgId,
      actor,
      action: "api_key.revoke",
      targetId: id,
      targetLabel: existing.label,
      metadata: { scopeRole: existing.scopeRole },
    });
    res.json({ id, revoked: true });
  },
);

export default router;
