import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgsTable } from "./orgs";
import type { UserRoleName } from "./userRoles";

/**
 * SCIM Groups pushed by an external IdP (Okta, Azure AD, OneLogin, …).
 *
 * A SCIM group is *just metadata* — its real effect is the role
 * mapping. When `roleMapping` is set and a user is added to this
 * group via the SCIM PATCH/PUT flow, we mint a `user_roles` row with
 * `role = roleMapping`, `grantedVia = "scim-group"`, and
 * `grantedBy = "scim-group:<groupId>"`. Removing the user from the
 * group revokes that specific row (idempotent — we keep the audit
 * trail intact).
 *
 * `displayName` is the IdP-side name (e.g. `procuro-approvers`); the
 * mapping is configured by an org admin in the SSO tab. Until a
 * mapping is set, the group is a no-op (membership pushes are stored
 * as audit log entries but no role is granted).
 */
export const scimGroupsTable = pgTable(
  "scim_groups",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    /** SCIM `displayName` — typically the IdP group name. */
    displayName: text("display_name").notNull(),
    /** SCIM `externalId` — the IdP's stable group id. Optional but
     *  unique per tenant when supplied. */
    externalId: text("external_id"),
    /**
     * Role granted to every member of this group. `null` means the
     * group is recognised but membership has no side effect (useful
     * during initial setup before the admin chooses a mapping).
     */
    roleMapping: text("role_mapping").$type<UserRoleName | null>(),
    /** Free-form metadata (e.g. last sync timestamp from the IdP). */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("scim_groups_org_idx").on(t.orgId),
    // PARTIAL unique indexes: uniqueness applies only to live
    // (non-soft-deleted) groups. This lets an IdP recreate a group
    // that was previously deleted (common Okta retry behaviour)
    // without the insert blowing up on the underlying constraint.
    uniqueIndex("scim_groups_org_external_id_idx")
      .on(t.orgId, t.externalId)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex("scim_groups_org_display_name_idx")
      .on(t.orgId, t.displayName)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export type ScimGroupRow = typeof scimGroupsTable.$inferSelect;
export type InsertScimGroupRow = typeof scimGroupsTable.$inferInsert;

/**
 * Membership join table: which `user_roles` rows were created because
 * a SCIM group included that user. We track the *granted* user_role id
 * (not just the userId) so we can revoke exactly one role grant on
 * removal even if the user has multiple roles in the org.
 *
 * `userRef` is the SCIM "value" of the member object — usually the
 * `user_roles.id` (our stable Procuro user id) or the IdP externalId.
 * We accept both and resolve at PATCH time.
 */
export const scimGroupMembersTable = pgTable(
  "scim_group_members",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => scimGroupsTable.id, { onDelete: "cascade" }),
    /** Original member.value from the SCIM payload — keep as-is for
     *  round-tripping back to the IdP. */
    userRef: text("user_ref").notNull(),
    /** `user_roles.id` of the SCIM-derived role grant. Nullable when
     *  the group has no mapping yet. */
    grantedUserRoleId: text("granted_user_role_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("scim_group_members_group_idx").on(t.groupId),
    uniqueIndex("scim_group_members_unique_idx").on(t.groupId, t.userRef),
  ],
);

export type ScimGroupMemberRow = typeof scimGroupMembersTable.$inferSelect;
export type InsertScimGroupMemberRow =
  typeof scimGroupMembersTable.$inferInsert;
