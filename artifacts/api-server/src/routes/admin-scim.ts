import { Router, type IRouter } from "express";
import {
  db,
  scimGroupsTable,
  scimGroupMembersTable,
  userRolesTable,
  userRoleNames,
  type UserRoleName,
} from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { ApiError, NotFoundError } from "../lib/api-errors";
import { writeAdminAudit } from "../lib/admin-audit";
import { newId } from "../lib/ids";
import { z } from "zod";

const router: IRouter = Router();

/**
 * Admin endpoints for inspecting SCIM-pushed groups and configuring
 * the group → role mapping. The SCIM bridge itself (in scim.ts)
 * accepts pushes from the IdP; this surface is what the operator
 * uses in the SSO tab to decide which IdP group grants which role.
 *
 * Changing a mapping has an immediate side-effect: every existing
 * membership row is re-evaluated and a fresh `user_roles` grant is
 * minted (or revoked) so the new mapping takes hold without waiting
 * for the next IdP sync.
 */

const RoleMappingBody = z.object({
  roleMapping: z
    .enum(userRoleNames)
    .nullable()
    .refine(
      (r) => r === null || r !== "platform_admin",
      "Cannot grant platform_admin via SCIM group",
    ),
});

router.get(
  "/admin/scim/groups",
  tenantMiddleware,
  requirePermission("settings:write"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const groups = await db
      .select()
      .from(scimGroupsTable)
      .where(
        and(eq(scimGroupsTable.orgId, orgId), isNull(scimGroupsTable.deletedAt)),
      );
    const out = await Promise.all(
      groups.map(async (g) => {
        const members = await db
          .select()
          .from(scimGroupMembersTable)
          .where(eq(scimGroupMembersTable.groupId, g.id));
        return {
          id: g.id,
          displayName: g.displayName,
          externalId: g.externalId,
          roleMapping: g.roleMapping,
          memberCount: members.length,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
        };
      }),
    );
    res.json(out);
  },
);

router.put(
  "/admin/scim/groups/:id/role-mapping",
  tenantMiddleware,
  requirePermission("settings:write"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const id = String(req.params.id);
    const { roleMapping } = RoleMappingBody.parse(req.body);
    const actor = req.actorEmail ?? "system@procuro.ai";
    const [group] = await db
      .select()
      .from(scimGroupsTable)
      .where(
        and(eq(scimGroupsTable.orgId, orgId), eq(scimGroupsTable.id, id)),
      );
    if (!group || group.deletedAt) {
      throw new NotFoundError("SCIM group not found");
    }
    const previous = group.roleMapping;
    const [updated] = await db
      .update(scimGroupsTable)
      .set({ roleMapping: roleMapping as UserRoleName | null })
      .where(eq(scimGroupsTable.id, id))
      .returning();
    if (!updated) {
      throw new ApiError(500, "internal_error", "Update failed");
    }

    // Re-project memberships against the new mapping. We revoke any
    // grant created under the OLD mapping (it was minted for a role
    // the operator no longer wants), then mint fresh grants under the
    // new one. We keep the membership rows themselves intact — only
    // the user_roles grants change — so removing the mapping leaves
    // memberships visible in the admin UI for re-mapping later.
    const members = await db
      .select()
      .from(scimGroupMembersTable)
      .where(eq(scimGroupMembersTable.groupId, id));
    for (const m of members) {
      // Revoke previous grant — STRICTLY only if the row is owned by
      // THIS group (matching grantedVia + grantedBy). Without the
      // ownership check we'd revoke a manual or other-source grant
      // when the operator changes the mapping (authorisation
      // integrity bug; see scim.ts:revokeGroupMembership).
      if (m.grantedUserRoleId) {
        await db
          .update(userRolesTable)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(userRolesTable.id, m.grantedUserRoleId),
              eq(userRolesTable.grantedVia, "scim-group"),
              eq(userRolesTable.grantedBy, `scim-group:${id}`),
              isNull(userRolesTable.revokedAt),
            ),
          );
      }
      // Mint replacement (if mapping is non-null and target user
      // exists in the tenant AND is not suspended).
      let nextGrantId: string | null = null;
      if (roleMapping) {
        // The membership ref can be either a Procuro user_roles.id
        // (returned from POST /Users) or the IdP externalId we
        // stored as user_roles.user_id — accept either for symmetry
        // with the SCIM bridge's own resolver.
        const targetRows = await db
          .select()
          .from(userRolesTable)
          .where(
            and(
              eq(userRolesTable.orgId, orgId),
              sql`(${userRolesTable.id} = ${m.userRef} OR ${userRolesTable.userId} = ${m.userRef})`,
            ),
          );
        const targetCanonical = targetRows[0];
        const targetSuspended =
          targetRows.length > 0 &&
          !targetRows.some(
            (r) => r.grantedVia !== "scim-group" && r.revokedAt === null,
          );
        if (targetCanonical && !targetSuspended) {
          // Mirror scim.ts ownership logic:
          //   1) reuse own active row, 2) reactivate own revoked row,
          //   3) leave foreign active row alone (null), 4) insert.
          const [activeOwned] = await db
            .select()
            .from(userRolesTable)
            .where(
              and(
                eq(userRolesTable.orgId, orgId),
                eq(userRolesTable.userId, targetCanonical.userId),
                eq(userRolesTable.role, roleMapping as UserRoleName),
                eq(userRolesTable.grantedVia, "scim-group"),
                eq(userRolesTable.grantedBy, `scim-group:${id}`),
                isNull(userRolesTable.revokedAt),
              ),
            )
            .limit(1);
          if (activeOwned) {
            nextGrantId = activeOwned.id;
          } else {
            const [revokedOwned] = await db
              .select()
              .from(userRolesTable)
              .where(
                and(
                  eq(userRolesTable.orgId, orgId),
                  eq(userRolesTable.userId, targetCanonical.userId),
                  eq(userRolesTable.role, roleMapping as UserRoleName),
                  eq(userRolesTable.grantedVia, "scim-group"),
                  eq(userRolesTable.grantedBy, `scim-group:${id}`),
                ),
              )
              .orderBy(desc(userRolesTable.createdAt))
              .limit(1);
            if (revokedOwned) {
              await db
                .update(userRolesTable)
                .set({ revokedAt: null })
                .where(eq(userRolesTable.id, revokedOwned.id));
              nextGrantId = revokedOwned.id;
            } else {
              const [activeForeign] = await db
                .select()
                .from(userRolesTable)
                .where(
                  and(
                    eq(userRolesTable.orgId, orgId),
                    eq(userRolesTable.userId, targetCanonical.userId),
                    eq(userRolesTable.role, roleMapping as UserRoleName),
                    isNull(userRolesTable.revokedAt),
                  ),
                )
                .limit(1);
              if (activeForeign) {
                // Foreign grant — don't claim.
                nextGrantId = null;
              } else {
                const [granted] = await db
                  .insert(userRolesTable)
                  .values({
                    id: newId("usrrole"),
                    userId: targetCanonical.userId,
                    orgId,
                    role: roleMapping as UserRoleName,
                    email: targetCanonical.email,
                    grantedVia: "scim-group",
                    grantedBy: `scim-group:${id}`,
                  })
                  .returning();
                nextGrantId = granted?.id ?? null;
              }
            }
          }
        }
      }
      await db
        .update(scimGroupMembersTable)
        .set({ grantedUserRoleId: nextGrantId })
        .where(eq(scimGroupMembersTable.id, m.id));
    }

    await writeAdminAudit({
      orgId,
      actor,
      action: "scim.group_role_mapping_change",
      targetId: id,
      targetLabel: group.displayName,
      metadata: { from: previous, to: roleMapping, memberCount: members.length },
    });
    res.json({
      id: updated.id,
      displayName: updated.displayName,
      roleMapping: updated.roleMapping,
    });
  },
);

export default router;
