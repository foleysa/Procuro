import {
  pgTable,
  text,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Tenant-scoped admin action log. Distinct from `collector_audit_log`
 * (cross-tenant collector lifecycle) and `decisions` (opportunity-level
 * approve/reject trail). This is the auditor-visible record of every
 * admin/RBAC mutation: invites, role changes, API key issue/rotate/revoke,
 * tenant-settings changes, SSO config changes, SCIM events.
 *
 * Tail-readable: rows are append-only and indexed by `(orgId, createdAt)`.
 * Filtering by `actor` or `action` (e.g. CSV export filtered to
 * `api_key.revoke`) is supported by the secondary indexes below.
 */
export const adminAuditLogTable = pgTable(
  "admin_audit_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    /** Email of the human / system who performed the action. */
    actor: text("actor").notNull(),
    /**
     * Coarse-grained classifier so the UI can group + filter without
     * pattern-matching on free-text. New values are explicitly allowed —
     * keep the enum-like list documented but do not gate it server-side
     * because this is forward-only.
     *
     * Examples:
     *   user.invite | user.role_change | user.revoke
     *   api_key.create | api_key.rotate | api_key.revoke
     *   sso.config_update
     *   tenant.settings_update
     *   scim.user_provision | scim.user_deprovision
     */
    action: text("action").notNull(),
    /** Optional id of the object the action targeted. */
    targetId: text("target_id"),
    /** Human-friendly label for the target. */
    targetLabel: text("target_label"),
    /** Free-form structured detail. Kept small (< 4KB ideally). */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("admin_audit_log_org_idx").on(t.orgId),
    index("admin_audit_log_action_idx").on(t.action),
    index("admin_audit_log_actor_idx").on(t.actor),
  ],
);

export type AdminAuditLogRow = typeof adminAuditLogTable.$inferSelect;
export type InsertAdminAuditLogRow = typeof adminAuditLogTable.$inferInsert;
