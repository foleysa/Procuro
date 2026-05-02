import { db, adminAuditLogTable } from "@workspace/db";
import { newId } from "./ids";

/**
 * Append-only writer for the tenant admin audit log. Surface a single
 * helper here so route handlers cannot accidentally vary the action
 * spelling (e.g. `api_key.created` vs `api_key.create`) — keep the
 * vocabulary controlled in one file.
 */
export async function writeAdminAudit(args: {
  orgId: string;
  actor: string;
  action: AdminAuditAction;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(adminAuditLogTable).values({
    id: newId("aud"),
    orgId: args.orgId,
    actor: args.actor,
    action: args.action,
    targetId: args.targetId ?? null,
    targetLabel: args.targetLabel ?? null,
    metadata: args.metadata ?? {},
  });
}

export const ADMIN_AUDIT_ACTIONS = [
  "user.invite",
  "user.role_change",
  "user.revoke",
  "api_key.create",
  "api_key.rotate",
  "api_key.revoke",
  "sso.config_update",
  "tenant.settings_update",
  "scim.user_provision",
  "scim.user_deprovision",
  "scim.user_update",
  "scim.user_reactivate",
  "scim.group_create",
  "scim.group_update",
  "scim.group_delete",
  "scim.group_member_add",
  "scim.group_member_remove",
  "scim.group_role_mapping_change",
  // Onboarding wizard telemetry — emitted on every state transition
  // (start / advance / dismiss / complete) and on sample-data
  // install/remove. CS uses these to monitor wizard drop-off.
  "onboarding.step_started",
  "onboarding.step_completed",
  "onboarding.step_skipped",
  "onboarding.dismissed",
  "onboarding.completed",
  "onboarding.sample_data_installed",
  "onboarding.sample_data_removed",
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];
