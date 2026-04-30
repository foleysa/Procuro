import { Router, type IRouter } from "express";
import { db, userRolesTable, userRoleNames, type UserRoleName } from "@workspace/db";
import { and, eq, desc, isNull } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { writeAdminAudit } from "../lib/admin-audit";
import { newId } from "../lib/ids";
import { z } from "zod";

const router: IRouter = Router();

const InviteUserBody = z.object({
  email: z.string().email(),
  role: z.enum(userRoleNames),
});

const ChangeRoleBody = z.object({
  role: z.enum(userRoleNames),
});

router.get(
  "/admin/users",
  tenantMiddleware,
  requirePermission("users:manage"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const rows = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.orgId, orgId))
      .orderBy(desc(userRolesTable.createdAt));
    res.json(
      rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        email: r.email,
        role: r.role,
        grantedVia: r.grantedVia,
        grantedBy: r.grantedBy,
        createdAt: r.createdAt,
        revokedAt: r.revokedAt,
        active: r.revokedAt === null,
      })),
    );
  },
);

/**
 * Issue an invitation for a teammate. We provision a `user_roles` row
 * with the email up-front so the role is "pending" — once the invitee
 * signs into Clerk with that email, the userId field is updated by the
 * Clerk webhook (see scim.ts) or by the `/me/claim-invite` endpoint.
 *
 * For H1 we use email as the placeholder userId so the row is unique
 * and queryable; the real Clerk user id replaces it on first sign-in.
 */
router.post(
  "/admin/users/invite",
  tenantMiddleware,
  requirePermission("users:manage"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const { email, role } = InviteUserBody.parse(req.body);
    const actor = req.actorEmail ?? "system@procuro.ai";
    const placeholderId = `pending:${email}`;

    const existing = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.userId, placeholderId),
          isNull(userRolesTable.revokedAt),
        ),
      );
    if (existing.length > 0) {
      res.status(409).json({ error: "Invite already pending for this email" });
      return;
    }

    const [row] = await db
      .insert(userRolesTable)
      .values({
        id: newId("usrrole"),
        userId: placeholderId,
        orgId,
        role: role as UserRoleName,
        email,
        grantedVia: "manual",
        grantedBy: actor,
      })
      .returning();
    await writeAdminAudit({
      orgId,
      actor,
      action: "user.invite",
      targetId: row?.id ?? null,
      targetLabel: email,
      metadata: { role },
    });
    res.status(201).json({
      id: row?.id,
      email,
      role,
      pending: true,
    });
  },
);

router.patch(
  "/admin/users/:id",
  tenantMiddleware,
  requirePermission("users:manage"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params.id);
    const { role } = ChangeRoleBody.parse(req.body);
    const actor = req.actorEmail ?? "system@procuro.ai";

    const [existing] = await db
      .select()
      .from(userRolesTable)
      .where(and(eq(userRolesTable.orgId, orgId), eq(userRolesTable.id, id)));
    if (!existing) {
      res.status(404).json({ error: "User role not found" });
      return;
    }

    const [updated] = await db
      .update(userRolesTable)
      .set({ role: role as UserRoleName })
      .where(eq(userRolesTable.id, id))
      .returning();

    await writeAdminAudit({
      orgId,
      actor,
      action: "user.role_change",
      targetId: id,
      targetLabel: existing.email,
      metadata: { from: existing.role, to: role },
    });
    res.json({
      id: updated?.id,
      email: updated?.email,
      role: updated?.role,
    });
  },
);

router.delete(
  "/admin/users/:id",
  tenantMiddleware,
  requirePermission("users:manage"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params.id);
    const actor = req.actorEmail ?? "system@procuro.ai";

    const [existing] = await db
      .select()
      .from(userRolesTable)
      .where(and(eq(userRolesTable.orgId, orgId), eq(userRolesTable.id, id)));
    if (!existing) {
      res.status(404).json({ error: "User role not found" });
      return;
    }
    if (existing.revokedAt) {
      res.status(409).json({ error: "Already revoked" });
      return;
    }

    await db
      .update(userRolesTable)
      .set({ revokedAt: new Date() })
      .where(eq(userRolesTable.id, id));
    await writeAdminAudit({
      orgId,
      actor,
      action: "user.revoke",
      targetId: id,
      targetLabel: existing.email,
      metadata: { role: existing.role },
    });
    res.json({ id, revoked: true });
  },
);

export default router;
