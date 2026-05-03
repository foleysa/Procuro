import { Router, type IRouter } from "express";
import {
  db,
  orgsTable,
  orgSettingsAuditLogTable,
  type UserRow,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { NotFoundError } from "../lib/api-errors";
import { GetMeResponse, PatchMeSettingsBody } from "@workspace/api-zod";
import { readDisclosurePolicy } from "../lib/disclosure-policy";
import { readRenewalAlertDays } from "../lib/contract-settings";
import { readHealthThresholds } from "../lib/health-thresholds";
import { getOrCreateUserByEmail } from "../lib/users";
import { newId } from "../lib/ids";
import { writeAdminAudit } from "../lib/admin-audit";

const router: IRouter = Router();

/**
 * Build the `MeResponse` wire shape from a fresh `orgs` row. Centralised
 * so `GET /me` and `PATCH /me/settings` can't drift on the disclosure
 * policy default or any other derived field.
 */
function serializeMe(
  org: typeof orgsTable.$inferSelect,
  actorEmail: string | undefined,
  user: UserRow,
) {
  return GetMeResponse.parse({
    org: {
      id: org.id,
      slug: org.slug,
      name: org.name,
      successFeePct: Number(org.successFeePct),
      disclosurePolicy: readDisclosurePolicy(org.settings),
      contractRenewalAlertDays: readRenewalAlertDays(org.settings),
      healthThresholds: readHealthThresholds(org.settings),
      createdAt: org.createdAt,
    },
    actorEmail: actorEmail ?? "system@procuro.ai",
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
}

router.get("/me", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const [org] = await db.select().from(orgsTable).where(eq(orgsTable.id, orgId));
  if (!org) {
    throw new NotFoundError("Org not found");
  }
  const user = await getOrCreateUserByEmail(
    orgId,
    req.actorEmail ?? "system@procuro.ai",
  );
  res.json(serializeMe(org, req.actorEmail, user));
});

/**
 * Settings keys we audit on `PATCH /me/settings`. Listed explicitly so
 * the audit-log writer stays in lockstep with the validated request
 * body — a future schema addition (e.g. a third tenant-wide knob) must
 * extend this list to start being recorded.
 */
const AUDITED_SETTINGS_KEYS = [
  "disclosurePolicy",
  "contractRenewalAlertDays",
  "healthThresholds",
] as const;
type AuditedSettingsKey = (typeof AUDITED_SETTINGS_KEYS)[number];

/**
 * Update tenant-wide preferences stored in `orgs.settings` JSONB.
 *
 * The handler performs a *merge* on top of the existing settings object
 * so that other keys (e.g. FX-exposure thresholds) are preserved when an
 * admin only changes the disclosure policy. Validation is delegated to
 * the generated `PatchMeSettingsBody` Zod schema; the global error
 * handler turns any `ZodError` into the standard
 * `400 { error, details }` response without per-route wiring.
 *
 * Every key whose stored value actually changes is appended to
 * `org_settings_audit_log` with the actor email and the previous + new
 * value, mirroring the per-field pattern used by `supplier_audit_log` /
 * `contract_audit_log`. The disclosure policy in particular flips a
 * tenant-wide compliance switch (T3/T4 signals visible to every
 * member), so the audit trail is non-optional.
 */
router.patch("/me/settings", tenantMiddleware, requirePermission("settings:write"), async (req, res) => {
  const orgId = requireOrgId(req);
  const body = PatchMeSettingsBody.parse(req.body);

  const [current] = await db
    .select()
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId));
  if (!current) {
    throw new NotFoundError("Org not found");
  }

  const currentSettings = (current.settings ?? {}) as Record<string, unknown>;
  const nextSettings: Record<string, unknown> = { ...currentSettings };
  // Capture the (key, old, new) tuples *before* writing, derived from
  // the validated body so unknown keys can't sneak in. We use the
  // resolved-with-default value for `disclosurePolicy` on the "old"
  // side because callers see the resolved value via `GET /me`; storing
  // the raw `undefined` would be confusing in the history UI.
  const changes: Array<{
    key: AuditedSettingsKey;
    oldValue: unknown;
    newValue: unknown;
  }> = [];

  if (body.disclosurePolicy !== undefined) {
    const oldValue = readDisclosurePolicy(currentSettings);
    const newValue = body.disclosurePolicy;
    nextSettings["disclosurePolicy"] = newValue;
    if (oldValue !== newValue) {
      changes.push({ key: "disclosurePolicy", oldValue, newValue });
    }
  }
  if (body.contractRenewalAlertDays !== undefined) {
    // Schema already constrains this to a 1..365 integer; the worker
    // and `readRenewalAlertDays` re-clamp defensively anyway.
    const oldValue = readRenewalAlertDays(currentSettings);
    const newValue = body.contractRenewalAlertDays;
    nextSettings["contractRenewalAlertDays"] = newValue;
    if (oldValue !== newValue) {
      changes.push({ key: "contractRenewalAlertDays", oldValue, newValue });
    }
  }
  if (body.healthThresholds !== undefined) {
    // Resolve the *current* (defaults-applied) values so the audit
    // entry shows what the operator was actually living with, then
    // overlay only the keys the request specified — matching the
    // partial-update contract on `HealthThresholdsUpdate`.
    const oldValue = readHealthThresholds(currentSettings);
    const newValue = {
      ...oldValue,
      ...(body.healthThresholds.minSignalsPerDay !== undefined
        ? { minSignalsPerDay: body.healthThresholds.minSignalsPerDay }
        : {}),
      ...(body.healthThresholds.maxStaleCollectors !== undefined
        ? { maxStaleCollectors: body.healthThresholds.maxStaleCollectors }
        : {}),
      ...(body.healthThresholds.maxQueuedJobs !== undefined
        ? { maxQueuedJobs: body.healthThresholds.maxQueuedJobs }
        : {}),
    };
    nextSettings["healthThresholds"] = newValue;
    const drift =
      oldValue.minSignalsPerDay !== newValue.minSignalsPerDay ||
      oldValue.maxStaleCollectors !== newValue.maxStaleCollectors ||
      oldValue.maxQueuedJobs !== newValue.maxQueuedJobs;
    if (drift) {
      changes.push({ key: "healthThresholds", oldValue, newValue });
    }
  }

  const actor = req.actorEmail ?? "system@procuro.ai";

  // Single transaction so the settings UPDATE and its audit rows land
  // atomically — never want a half-applied change with no audit row,
  // or an audit row claiming a change that the UPDATE rolled back.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(orgsTable)
      .set({ settings: nextSettings })
      .where(eq(orgsTable.id, orgId))
      .returning();
    if (!row) return null;
    if (changes.length > 0) {
      await tx.insert(orgSettingsAuditLogTable).values(
        changes.map((c) => ({
          id: newId("oset_aud"),
          orgId,
          actorEmail: actor,
          key: c.key,
          oldValue: c.oldValue as never,
          newValue: c.newValue as never,
        })),
      );
    }
    return row;
  });

  if (!updated) {
    // Row vanished between SELECT and UPDATE — extremely unlikely with
    // a single-org PK update, but surface a stable error rather than
    // returning a stale serialisation.
    throw new NotFoundError("Org not found");
  }

  if (changes.length > 0) {
    req.log.info(
      {
        orgId,
        actor,
        keys: changes.map((c) => c.key),
      },
      "me.settings.patch",
    );
    // Mirror the per-key change set into the cross-cutting admin audit
    // log so the auditor view in the Org Admin UI surfaces the
    // disclosure-policy switch alongside SSO / SCIM / API-key events
    // (task #272). The detailed per-field history continues to live in
    // org_settings_audit_log; this is a single summary row.
    try {
      await writeAdminAudit({
        orgId,
        actor,
        action: "tenant.settings_update",
        targetId: orgId,
        targetLabel: updated.name,
        metadata: {
          changes: changes.map((c) => ({
            key: c.key,
            oldValue: c.oldValue,
            newValue: c.newValue,
          })),
        },
      });
    } catch (err) {
      req.log.warn({ err }, "Failed to write admin audit row");
    }
  }

  const user = await getOrCreateUserByEmail(orgId, actor);
  res.json(serializeMe(updated, req.actorEmail, user));
});

/**
 * Recent changes to `orgs.settings` for the active tenant. Returned in
 * reverse-chronological order so the Settings page can render a
 * compact "Last changed by …" history without a follow-up sort. Read
 * permission is implicit in tenant membership — every member of the
 * org is allowed to see who flipped a tenant-wide preference (the
 * mutation itself remains gated on `settings:write`).
 */
router.get("/me/settings/audit", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const rawLimit = Number.parseInt(String(req.query["limit"] ?? "10"), 10);
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : 10, 1),
    100,
  );
  const rows = await db
    .select()
    .from(orgSettingsAuditLogTable)
    .where(and(eq(orgSettingsAuditLogTable.orgId, orgId)))
    .orderBy(desc(orgSettingsAuditLogTable.createdAt))
    .limit(limit);
  res.json(
    rows.map((r) => ({
      id: r.id,
      key: r.key,
      actorEmail: r.actorEmail,
      oldValue: r.oldValue,
      newValue: r.newValue,
      createdAt: r.createdAt,
    })),
  );
});

export default router;
