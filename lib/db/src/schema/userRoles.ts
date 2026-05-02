import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgsTable } from "./orgs";

/**
 * Fixed role catalogue. Custom per-tenant roles are explicitly out of scope
 * for the H1 RBAC ship — see `.local/tasks/task-119.md`. Order matters here
 * only for documentation; permission gating is keyed by role name.
 *
 * - `platform_admin`  — Procuro staff. Cross-tenant; can manage collectors,
 *                       backfills, and any tenant on request.
 * - `org_admin`       — Tenant admin. Manages users, SSO, API keys, settings.
 * - `approver`        — Can approve / reject / execute opportunities and
 *                       transition cycle state.
 * - `analyst`         — Can suggest, view all data, run analyses, but cannot
 *                       transition opportunities.
 * - `read_only`       — Sees everything, mutates nothing. Default for
 *                       observers (executive sponsors, auditors with
 *                       compliance scope).
 * - `auditor`         — Read-only PLUS access to the admin audit log and
 *                       decision history. Cannot approve.
 */
export const userRoleNames = [
  "platform_admin",
  "org_admin",
  "approver",
  "analyst",
  "read_only",
  "auditor",
] as const;
export type UserRoleName = (typeof userRoleNames)[number];

/**
 * Many-to-many user × org × role association. A single Clerk user can be
 * a member of multiple orgs (multi-tenant Clerk orgs) and may carry a
 * different role in each. The `userId` is the Clerk user id (string;
 * the `users` table is already keyed off that pattern).
 */
export const userRolesTable = pgTable(
  "user_roles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    role: text("role").$type<UserRoleName>().notNull(),
    /** Email at the time the role was granted; persists for audit even if
     *  the user is later deleted from Clerk. */
    email: text("email").notNull(),
    /** Source of the grant — `manual` (admin UI invite), `scim` (SCIM
     *  provisioning), `bootstrap` (auto-migration), `clerk` (Clerk org
     *  membership webhook). */
    grantedVia: text("granted_via").notNull().default("manual"),
    grantedBy: text("granted_by").notNull().default("system@procuro.ai"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("user_roles_org_idx").on(t.orgId),
    index("user_roles_user_idx").on(t.userId),
    // PARTIAL unique index: at most one ACTIVE (non-revoked) row per
    // (user, org, role). Revoked rows are kept for audit and may
    // coexist with an active row of the same triple — required so a
    // user can be removed and re-added to a SCIM-mapped group
    // without colliding on the audit-history trail.
    uniqueIndex("user_roles_unique_active_idx")
      .on(t.userId, t.orgId, t.role)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

export type UserRoleRow = typeof userRolesTable.$inferSelect;
export type InsertUserRoleRow = typeof userRolesTable.$inferInsert;
