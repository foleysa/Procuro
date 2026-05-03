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
  // Trust Center engagement telemetry — emitted on every
  // /api/trust/summary fetch (with 5-minute per-actor dedup) so
  // operators can see when a tenant is actively sharing posture
  // with auditors / prospects without bloating the audit log.
  "trust.view",
  // In-product signal from the AdminGuard friendly empty state
  // (#207). Emitted when a signed-in non-admin user lands on the
  // Engine page (or other admin-gated routes) and is shown the
  // "request access" empty state. Deduped per-actor per-day so
  // refreshing or revisiting the page doesn't drown the signal.
  // Surfaced on the Org Admin page as a callout listing teammates
  // who keep hitting locked admin pages.
  "engine.access_denied",
  // Opportunity decisions (task #272 — close the audit gap that left
  // approve/reject/snooze invisible to external auditors). One audit
  // row per action; bulk endpoints emit a single row covering the
  // whole batch with the affected ids in metadata to keep the log
  // tractable when an operator approves hundreds of rows in one click.
  "opportunity.approve",
  "opportunity.reject",
  "opportunity.bulk_approve",
  "opportunity.bulk_reject",
  "opportunity.bulk_snooze",
  "opportunity.bulk_unsnooze",
  "opportunity.classify",
  // Per-tenant retry-budget overrides (System / Jobs page). Both the
  // upsert and the clear paths emit so an auditor can reconstruct who
  // raised the budget for a particular kind and when it was reverted.
  "jobs.retry_budget_update",
  "jobs.retry_budget_clear",
  // ERP integration lifecycle. Connect/disconnect are the
  // compliance-relevant events ("you started/stopped sending data
  // upstream"); update covers credential rotation and pause/resume.
  "integration.connect",
  "integration.update",
  "integration.disconnect",
  // Taxonomy synonym resolution from the Routing admin page. Operator
  // mappings persist tenant-wide (or globally for platform admins) so
  // every resolve event must land in the audit log.
  "taxonomy.synonym_resolve",
  // Audit-log tamper-evidence — emitted whenever someone attempts a
  // PATCH or DELETE against /api/admin/audit/:id. The endpoint always
  // refuses the mutation (audit log is append-only); this row is the
  // observable evidence that the probe happened. UAT v2 D-19.
  "audit.mutation_attempt_blocked",
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];
