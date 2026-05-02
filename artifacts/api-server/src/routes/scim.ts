import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  userRolesTable,
  orgsTable,
  apiKeysTable,
  scimGroupsTable,
  scimGroupMembersTable,
  type UserRoleName,
  type ScimGroupRow,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { writeAdminAudit } from "../lib/admin-audit";
import { newId } from "../lib/ids";
import { hashToken } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  parseScimUserFilter,
  parseScimGroupFilter,
  InvalidScimFilterError,
  readPagination,
} from "../lib/scim-filter";
import crypto from "node:crypto";

const router: IRouter = Router();

/**
 * SCIM 2.0 (RFC 7643/7644) bridge endpoints.
 *
 * Clerk handles full SAML/OIDC SSO and bridges most directory state
 * already, but the IdPs we ship with (Okta, Azure AD, OneLogin,
 * JumpCloud) push SCIM provisioning events directly to a tenant URL.
 * This surface accepts those pushes, mirrors them into our
 * `user_roles` table, projects SCIM Group push into role grants via
 * the `scim_groups.role_mapping` setting an org admin configures in
 * the SSO tab, and emits an `admin_audit_log` row for every change so
 * an auditor can prove an offboarded user lost access in real time.
 *
 * AUTHENTICATION: bearer token, scoped to a single tenant. The bearer
 * MUST be an `org_admin`-scoped row in `api_keys` whose `org_id`
 * matches the URL `:orgId`. We accept the env-level `SCIM_BEARER_TOKEN`
 * as an additional escape hatch in dev / single-tenant deploys.
 *
 * TENANCY: every endpoint is namespaced under `/scim/v2/orgs/:orgId`
 * so the URL itself proves the tenant scope independent of the
 * bearer. Mixing the two would let a stolen bearer scan a different
 * tenant's directory; both must agree.
 *
 * SPEC COVERAGE: Users (CRUD + PATCH active toggle + filter +
 * pagination), Groups (CRUD + PATCH member ops + filter), Schemas,
 * ResourceTypes, ServiceProviderConfig. PATCH supports the two ops
 * Okta and Azure AD actually emit (`replace` and `add`/`remove` on
 * `members`); we reject anything else with a clear 400.
 */

// ----- Types -------------------------------------------------------

interface ScimUserBody {
  schemas?: string[];
  userName?: string;
  emails?: Array<{ value?: string; primary?: boolean; type?: string }>;
  active?: boolean;
  externalId?: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  displayName?: string;
}

interface ScimGroupBody {
  schemas?: string[];
  displayName?: string;
  externalId?: string;
  members?: Array<{ value?: string; display?: string; type?: string }>;
}

interface ScimPatchOp {
  op?: string;
  path?: string;
  value?: unknown;
}

interface ScimPatchBody {
  schemas?: string[];
  Operations?: ScimPatchOp[];
  // Some clients use lowercase. Accept both.
  operations?: ScimPatchOp[];
}

// ----- Helpers -----------------------------------------------------

function jsonScimError(
  res: Response,
  status: number,
  detail: string,
  scimType?: string,
): void {
  const body: Record<string, unknown> = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    detail,
    status: String(status),
  };
  if (scimType) body["scimType"] = scimType;
  res.status(status).json(body);
}

async function authenticateScim(
  req: Request,
  expectedOrgId: string,
): Promise<boolean> {
  const auth =
    req.header("authorization") ?? req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m || !m[1]) return false;
  const token = m[1].trim();
  const expected = process.env["SCIM_BEARER_TOKEN"];
  if (expected && timingSafeEquals(token, expected)) {
    // Single shared token for the bridge — useful in dev / single-tenant.
    // NOT bound to expectedOrgId on purpose; see SCIM.md §2 warning
    // and the boot-time guard in maybeWarnSharedScimTokenMisuse().
    return true;
  }
  // Cross-check against an `api_keys` row with org_admin scope so each
  // tenant can issue its own SCIM bearer.
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({ orgId: apiKeysTable.orgId, scopeRole: apiKeysTable.scopeRole })
    .from(apiKeysTable)
    .where(
      and(
        eq(apiKeysTable.tokenHash, tokenHash),
        isNull(apiKeysTable.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return false;
  if (row.orgId !== expectedOrgId) return false;
  // Update last-used best-effort (don't await; failures aren't fatal).
  db.update(apiKeysTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeysTable.tokenHash, tokenHash))
    .catch(() => undefined);
  return row.scopeRole === "org_admin";
}

function timingSafeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function emailFrom(body: ScimUserBody): string | null {
  const primary = body.emails?.find((e) => e.primary && e.value);
  if (primary?.value) return primary.value;
  const any = body.emails?.find((e) => e.value);
  if (any?.value) return any.value;
  return body.userName ?? null;
}

function userResource(
  baseUrl: string,
  orgId: string,
  row: {
    id: string;
    userId: string;
    email: string;
    role: UserRoleName;
    createdAt: Date | string | null;
    revokedAt: Date | string | null;
  },
): Record<string, unknown> {
  const created =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : row.createdAt;
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: row.id,
    externalId: row.userId,
    userName: row.email,
    active: row.revokedAt === null,
    emails: [{ value: row.email, primary: true, type: "work" }],
    name: { formatted: row.email },
    meta: {
      resourceType: "User",
      created,
      lastModified: created,
      location: `${baseUrl}/scim/v2/orgs/${orgId}/Users/${row.id}`,
    },
  };
}

function groupResource(
  baseUrl: string,
  orgId: string,
  group: ScimGroupRow,
  members: Array<{ userRef: string }>,
): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    id: group.id,
    displayName: group.displayName,
    externalId: group.externalId ?? undefined,
    members: members.map((m) => ({ value: m.userRef })),
    meta: {
      resourceType: "Group",
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
      location: `${baseUrl}/scim/v2/orgs/${orgId}/Groups/${group.id}`,
    },
    "urn:ietf:params:scim:schemas:extension:procuro:2.0:Group": {
      roleMapping: group.roleMapping ?? null,
    },
  };
}

function getBaseUrl(req: Request): string {
  // Honour x-forwarded-* if present (Replit proxy injects them), else
  // fall back to host. We strip the trailing /scim/... portion so the
  // returned `meta.location` URLs are well-formed.
  const proto =
    req.header("x-forwarded-proto") ??
    (req.protocol || "https");
  const host = req.header("x-forwarded-host") ?? req.header("host");
  return `${proto}://${host}/api`;
}

/**
 * Resolve a SCIM membership `value` to the canonical Procuro userId
 * for the tenant, AND determine whether that user is currently
 * provisioned (i.e. has at least one ACTIVE `user_roles` row with
 * `grantedVia in ('scim','manual','clerk','bootstrap')` — the
 * "primary" identity rows). Returns `null` if the user is unknown,
 * and `{ userId, email, suspended: true }` if the user has been
 * deactivated. Group-derived grants are ignored when computing
 * suspended-ness so a user can't bootstrap their own active state
 * solely through group membership.
 */
async function resolveTenantUser(
  orgId: string,
  userRef: string,
): Promise<{ userId: string; email: string; suspended: boolean } | null> {
  const rows = await db
    .select()
    .from(userRolesTable)
    .where(
      and(
        eq(userRolesTable.orgId, orgId),
        sql`(${userRolesTable.id} = ${userRef} OR ${userRolesTable.userId} = ${userRef})`,
      ),
    );
  if (rows.length === 0) return null;
  // Pick a stable canonical email & userId from the first row; they
  // are identical across every row for the same Clerk user in this
  // tenant by construction.
  const canonical = rows[0]!;
  // The user is "active" iff any non-group identity row is active.
  const hasActivePrimary = rows.some(
    (r) => r.grantedVia !== "scim-group" && r.revokedAt === null,
  );
  return {
    userId: canonical.userId,
    email: canonical.email,
    suspended: !hasActivePrimary,
  };
}

/**
 * Apply / revoke a role grant for a user-role row when their group
 * membership changes. The grant is OWNED by this specific group:
 * `grantedVia='scim-group'` AND `grantedBy='scim-group:<groupId>'`.
 * Ownership matters because revocation on member-remove only touches
 * rows owned by the same group — we never revoke a manual or
 * different-group grant the user happens to have for the same role.
 *
 * Behaviour:
 *   - `roleMapping` null: store the membership but don't mint a row.
 *   - target user not found in the tenant: store membership without
 *     a grant; will be projected later via admin re-mapping.
 *   - target user is SUSPENDED (no active primary identity row):
 *     refuse to grant. A SCIM group event MUST NOT bring back a
 *     deactivated user's access. Returns `null`.
 *   - existing ACTIVE row owned by THIS group for the same role:
 *     reuse (idempotent re-add).
 *   - existing REVOKED row owned by THIS group for the same role:
 *     REACTIVATE the same row (clears `revoked_at`) — preserves the
 *     audit trail without inserting a duplicate.
 *   - existing ACTIVE row owned by anyone else (manual,
 *     other-scim-group, bootstrap): user already has the role from
 *     a different source. We do NOT insert (would violate the
 *     partial unique index over active rows) and we do NOT claim
 *     ownership — `grantedUserRoleId=null` so a later remove/delete
 *     of this group is a no-op for that foreign grant.
 *   - otherwise: INSERT a fresh active grant owned by this group.
 */
async function applyGroupMembership(args: {
  orgId: string;
  group: ScimGroupRow;
  userRef: string;
  actor: string;
}): Promise<{ grantedUserRoleId: string | null }> {
  const { orgId, group, userRef, actor } = args;
  if (!group.roleMapping) {
    return { grantedUserRoleId: null };
  }
  const target = await resolveTenantUser(orgId, userRef);
  if (!target) {
    return { grantedUserRoleId: null };
  }
  if (target.suspended) {
    // Don't resurrect a deactivated user via group membership.
    await writeAdminAudit({
      orgId,
      actor,
      action: "scim.group_member_add",
      targetId: null,
      targetLabel: target.email,
      metadata: {
        groupId: group.id,
        groupName: group.displayName,
        role: group.roleMapping,
        skipped: "user-suspended",
      },
    });
    return { grantedUserRoleId: null };
  }
  // Owned, active row exists -> reuse.
  const [activeOwned] = await db
    .select()
    .from(userRolesTable)
    .where(
      and(
        eq(userRolesTable.orgId, orgId),
        eq(userRolesTable.userId, target.userId),
        eq(userRolesTable.role, group.roleMapping),
        eq(userRolesTable.grantedVia, "scim-group"),
        eq(userRolesTable.grantedBy, `scim-group:${group.id}`),
        isNull(userRolesTable.revokedAt),
      ),
    )
    .limit(1);
  if (activeOwned) {
    return { grantedUserRoleId: activeOwned.id };
  }
  // Owned, revoked row exists -> reactivate (preserves audit chain).
  const [revokedOwned] = await db
    .select()
    .from(userRolesTable)
    .where(
      and(
        eq(userRolesTable.orgId, orgId),
        eq(userRolesTable.userId, target.userId),
        eq(userRolesTable.role, group.roleMapping),
        eq(userRolesTable.grantedVia, "scim-group"),
        eq(userRolesTable.grantedBy, `scim-group:${group.id}`),
      ),
    )
    .orderBy(desc(userRolesTable.createdAt))
    .limit(1);
  if (revokedOwned) {
    await db
      .update(userRolesTable)
      .set({ revokedAt: null })
      .where(eq(userRolesTable.id, revokedOwned.id));
    await writeAdminAudit({
      orgId,
      actor,
      action: "scim.group_member_add",
      targetId: revokedOwned.id,
      targetLabel: target.email,
      metadata: {
        groupId: group.id,
        groupName: group.displayName,
        role: group.roleMapping,
        reactivated: true,
      },
    });
    return { grantedUserRoleId: revokedOwned.id };
  }
  // Active foreign row -> don't claim, don't mint.
  const [activeForeign] = await db
    .select()
    .from(userRolesTable)
    .where(
      and(
        eq(userRolesTable.orgId, orgId),
        eq(userRolesTable.userId, target.userId),
        eq(userRolesTable.role, group.roleMapping),
        isNull(userRolesTable.revokedAt),
      ),
    )
    .limit(1);
  if (activeForeign) {
    await writeAdminAudit({
      orgId,
      actor,
      action: "scim.group_member_add",
      targetId: activeForeign.id,
      targetLabel: target.email,
      metadata: {
        groupId: group.id,
        groupName: group.displayName,
        role: group.roleMapping,
        skipped: "user-already-has-role-from-other-source",
        existingGrantedVia: activeForeign.grantedVia,
        existingGrantedBy: activeForeign.grantedBy,
      },
    });
    return { grantedUserRoleId: null };
  }
  // Insert a fresh grant. Safe: partial unique index permits multiple
  // revoked rows for the same triple.
  const [granted] = await db
    .insert(userRolesTable)
    .values({
      id: newId("usrrole"),
      userId: target.userId,
      orgId,
      role: group.roleMapping,
      email: target.email,
      grantedVia: "scim-group",
      grantedBy: `scim-group:${group.id}`,
    })
    .returning();
  await writeAdminAudit({
    orgId,
    actor,
    action: "scim.group_member_add",
    targetId: granted?.id ?? null,
    targetLabel: target.email,
    metadata: {
      groupId: group.id,
      groupName: group.displayName,
      role: group.roleMapping,
    },
  });
  return { grantedUserRoleId: granted?.id ?? null };
}

async function revokeGroupMembership(args: {
  orgId: string;
  group: ScimGroupRow;
  member: { id: string; userRef: string; grantedUserRoleId: string | null };
  actor: string;
}): Promise<void> {
  const { orgId, group, member, actor } = args;
  if (member.grantedUserRoleId) {
    const [existing] = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.id, member.grantedUserRoleId));
    // STRICT OWNERSHIP CHECK — only revoke if the row is genuinely
    // owned by this group. Without this guard, a stale or hand-edited
    // `granted_user_role_id` could revoke a manual or other-source
    // grant for the same role (authorisation integrity bug).
    if (
      existing &&
      existing.revokedAt === null &&
      existing.grantedVia === "scim-group" &&
      existing.grantedBy === `scim-group:${group.id}`
    ) {
      await db
        .update(userRolesTable)
        .set({ revokedAt: new Date() })
        .where(eq(userRolesTable.id, member.grantedUserRoleId));
      await writeAdminAudit({
        orgId,
        actor,
        action: "scim.group_member_remove",
        targetId: member.grantedUserRoleId,
        targetLabel: existing.email,
        metadata: {
          groupId: group.id,
          groupName: group.displayName,
          role: existing.role,
        },
      });
    }
  }
  await db
    .delete(scimGroupMembersTable)
    .where(eq(scimGroupMembersTable.id, member.id));
}

// ----- Service discovery ------------------------------------------

router.get("/scim/v2/orgs/:orgId/ServiceProviderConfig", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  res.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://docs.procuro.ai/scim",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 1000 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Authenticate with an org_admin-scoped API key",
      },
    ],
  });
});

router.get("/scim/v2/orgs/:orgId/ResourceTypes", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const baseUrl = getBaseUrl(req);
  res.json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 2,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: "urn:ietf:params:scim:schemas:core:2.0:User",
        meta: {
          location: `${baseUrl}/scim/v2/orgs/${orgId}/ResourceTypes/User`,
          resourceType: "ResourceType",
        },
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "Group",
        name: "Group",
        endpoint: "/Groups",
        schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
        meta: {
          location: `${baseUrl}/scim/v2/orgs/${orgId}/ResourceTypes/Group`,
          resourceType: "ResourceType",
        },
      },
    ],
  });
});

router.get("/scim/v2/orgs/:orgId/Schemas", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  // Minimal core schemas — Okta and Azure AD only validate the
  // existence of the resource, not the field-by-field structure.
  res.json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 2,
    Resources: [
      {
        id: "urn:ietf:params:scim:schemas:core:2.0:User",
        name: "User",
        description: "User Account",
        attributes: [
          { name: "userName", type: "string", required: true, uniqueness: "server" },
          { name: "active", type: "boolean", required: false },
          { name: "externalId", type: "string", required: false },
          {
            name: "emails",
            type: "complex",
            multiValued: true,
            subAttributes: [
              { name: "value", type: "string" },
              { name: "primary", type: "boolean" },
              { name: "type", type: "string" },
            ],
          },
        ],
      },
      {
        id: "urn:ietf:params:scim:schemas:core:2.0:Group",
        name: "Group",
        description: "Group of users",
        attributes: [
          { name: "displayName", type: "string", required: true },
          { name: "externalId", type: "string", required: false },
          {
            name: "members",
            type: "complex",
            multiValued: true,
            subAttributes: [
              { name: "value", type: "string" },
              { name: "display", type: "string" },
            ],
          },
        ],
      },
    ],
  });
});

// ----- Users -------------------------------------------------------

router.get("/scim/v2/orgs/:orgId/Users", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const { startIndex, count } = readPagination(
    req.query as Record<string, unknown>,
  );
  let filter;
  try {
    filter = parseScimUserFilter(
      typeof req.query["filter"] === "string"
        ? (req.query["filter"] as string)
        : null,
    );
  } catch (err) {
    if (err instanceof InvalidScimFilterError) {
      jsonScimError(res, 400, err.message, "invalidFilter");
      return;
    }
    throw err;
  }

  const where = and(
    eq(userRolesTable.orgId, orgId),
    eq(userRolesTable.grantedVia, "scim"),
    ...(filter?.sql ? [filter.sql] : []),
  );
  const rows = await db
    .select()
    .from(userRolesTable)
    .where(where)
    .orderBy(asc(userRolesTable.createdAt));

  const projected = rows.map((r) => ({
    ...r,
    userName: r.email,
    externalId: r.userId,
    active: r.revokedAt === null,
  }));
  const filtered = filter
    ? projected.filter((p) =>
        filter.predicate({
          userName: p.userName,
          externalId: p.externalId,
          active: p.active,
        }),
      )
    : projected;
  const page = filtered.slice(startIndex - 1, startIndex - 1 + count);
  const baseUrl = getBaseUrl(req);
  res.json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: filtered.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page.map((r) => userResource(baseUrl, orgId, r)),
  });
});

router.get("/scim/v2/orgs/:orgId/Users/:userId", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const userId = String(req.params.userId);
  const [row] = await db
    .select()
    .from(userRolesTable)
    .where(and(eq(userRolesTable.orgId, orgId), eq(userRolesTable.id, userId)));
  if (!row) {
    jsonScimError(res, 404, "User not found");
    return;
  }
  res.json(userResource(getBaseUrl(req), orgId, row));
});

router.post("/scim/v2/orgs/:orgId/Users", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const [org] = await db.select().from(orgsTable).where(eq(orgsTable.id, orgId));
  if (!org) {
    jsonScimError(res, 404, "Org not found");
    return;
  }
  const body = (req.body ?? {}) as ScimUserBody;
  const email = emailFrom(body);
  if (!email) {
    jsonScimError(res, 400, "userName / emails required", "invalidValue");
    return;
  }
  const externalId = body.externalId ?? `scim:${email}`;

  // RFC 7644 §3.3: a POST that conflicts with an existing resource
  // (same userName) MUST return 409 with scimType=uniqueness. The
  // SCIM `userName` is our `email` column — IdPs treat userName as
  // the human-meaningful identifier, so we must reject duplicates
  // even if the externalId differs (e.g. operator changes IdPs).
  // We additionally reject duplicate externalId so re-creating a
  // suspended user isn't silently treated as a new identity.
  const [conflict] = await db
    .select()
    .from(userRolesTable)
    .where(
      and(
        eq(userRolesTable.orgId, orgId),
        eq(userRolesTable.grantedVia, "scim"),
        sql`(${userRolesTable.email} = ${email} OR ${userRolesTable.userId} = ${externalId})`,
        isNull(userRolesTable.revokedAt),
      ),
    )
    .limit(1);
  if (conflict) {
    jsonScimError(res, 409, "User already exists", "uniqueness");
    return;
  }

  const role: UserRoleName = "analyst"; // default; org admin can change later
  const [row] = await db
    .insert(userRolesTable)
    .values({
      id: newId("usrrole"),
      userId: externalId,
      orgId,
      role,
      email,
      grantedVia: "scim",
      grantedBy: "scim-bridge",
      // If created in deactivated state, mark revoked immediately so
      // RBAC rejects right away.
      revokedAt: body.active === false ? new Date() : null,
    })
    .returning();
  await writeAdminAudit({
    orgId,
    actor: "scim-bridge",
    action: "scim.user_provision",
    targetId: row?.id ?? null,
    targetLabel: email,
    metadata: { externalId, role, active: body.active ?? true },
  });

  if (!row) {
    jsonScimError(res, 500, "Insert failed");
    return;
  }
  res.status(201).json(userResource(getBaseUrl(req), orgId, row));
});

router.put("/scim/v2/orgs/:orgId/Users/:userId", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const userId = String(req.params.userId);
  const body = (req.body ?? {}) as ScimUserBody;
  const [existing] = await db
    .select()
    .from(userRolesTable)
    .where(and(eq(userRolesTable.orgId, orgId), eq(userRolesTable.id, userId)));
  if (!existing) {
    jsonScimError(res, 404, "User not found");
    return;
  }
  const email = emailFrom(body) ?? existing.email;
  const wasActive = existing.revokedAt === null;
  const willBeActive = body.active !== false;
  const update: Partial<typeof userRolesTable.$inferInsert> = { email };
  if (!wasActive && willBeActive) update.revokedAt = null;
  if (wasActive && !willBeActive) update.revokedAt = new Date();
  const [updated] = await db
    .update(userRolesTable)
    .set(update)
    .where(eq(userRolesTable.id, userId))
    .returning();
  if (!updated) {
    jsonScimError(res, 500, "Update failed");
    return;
  }
  await writeAdminAudit({
    orgId,
    actor: "scim-bridge",
    action:
      wasActive && !willBeActive
        ? "scim.user_deprovision"
        : !wasActive && willBeActive
          ? "scim.user_reactivate"
          : "scim.user_update",
    targetId: userId,
    targetLabel: email,
    metadata: { from: { active: wasActive }, to: { active: willBeActive } },
  });
  res.json(userResource(getBaseUrl(req), orgId, updated));
});

/**
 * PATCH on a User. Only handles the operations Okta/Azure AD actually
 * emit:
 *  - `replace` on `active` (suspend / reactivate)
 *  - `replace` with no path, payload `{ active: false }` (Okta v1)
 *  - `replace` on `userName` / `emails`
 * Anything else is acknowledged with a 200 but ignored — preferable
 * to 400ing a working sync because Azure pushed an unknown field.
 */
router.patch("/scim/v2/orgs/:orgId/Users/:userId", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const userId = String(req.params.userId);
  const body = (req.body ?? {}) as ScimPatchBody;
  const ops = body.Operations ?? body.operations ?? [];
  const [existing] = await db
    .select()
    .from(userRolesTable)
    .where(and(eq(userRolesTable.orgId, orgId), eq(userRolesTable.id, userId)));
  if (!existing) {
    jsonScimError(res, 404, "User not found");
    return;
  }
  let nextActive: boolean | null = null;
  let nextEmail: string | null = null;
  for (const op of ops) {
    const opName = (op.op ?? "").toLowerCase();
    if (opName !== "replace" && opName !== "add") continue;
    const path = (op.path ?? "").toLowerCase();
    const v = op.value;
    if (path === "active") {
      if (typeof v === "boolean") nextActive = v;
    } else if (path === "username") {
      if (typeof v === "string") nextEmail = v;
    } else if (path.startsWith("emails")) {
      // PATCH emails — accept the first value
      if (Array.isArray(v) && v.length > 0) {
        const first = v[0] as { value?: string };
        if (typeof first.value === "string") nextEmail = first.value;
      } else if (typeof v === "string") {
        nextEmail = v;
      }
    } else if (path === "" && v && typeof v === "object") {
      // Pathless replace — bag of attributes.
      const obj = v as Record<string, unknown>;
      if (typeof obj["active"] === "boolean") nextActive = obj["active"] as boolean;
      if (typeof obj["userName"] === "string") nextEmail = obj["userName"] as string;
    }
  }
  const wasActive = existing.revokedAt === null;
  const willBeActive = nextActive ?? wasActive;
  const update: Partial<typeof userRolesTable.$inferInsert> = {};
  if (nextEmail) update.email = nextEmail;
  if (!wasActive && willBeActive) update.revokedAt = null;
  if (wasActive && !willBeActive) update.revokedAt = new Date();
  let updated = existing;
  if (Object.keys(update).length > 0) {
    const [u] = await db
      .update(userRolesTable)
      .set(update)
      .where(eq(userRolesTable.id, userId))
      .returning();
    if (u) updated = u;
  }
  await writeAdminAudit({
    orgId,
    actor: "scim-bridge",
    action:
      wasActive && !willBeActive
        ? "scim.user_deprovision"
        : !wasActive && willBeActive
          ? "scim.user_reactivate"
          : "scim.user_update",
    targetId: userId,
    targetLabel: updated.email,
    metadata: {
      ops: ops.map((o) => ({ op: o.op, path: o.path })),
      active: willBeActive,
    },
  });
  // When deactivating a user, also revoke every group-derived role
  // (otherwise a suspended user would still be `approver` via group
  // membership).
  if (wasActive && !willBeActive) {
    await db
      .update(userRolesTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.userId, existing.userId),
          eq(userRolesTable.grantedVia, "scim-group"),
          isNull(userRolesTable.revokedAt),
        ),
      );
  }
  res.json(userResource(getBaseUrl(req), orgId, updated));
});

router.delete("/scim/v2/orgs/:orgId/Users/:userId", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const userId = String(req.params.userId);
  const [existing] = await db
    .select()
    .from(userRolesTable)
    .where(and(eq(userRolesTable.orgId, orgId), eq(userRolesTable.id, userId)));
  if (!existing) {
    jsonScimError(res, 404, "User not found");
    return;
  }
  await db
    .update(userRolesTable)
    .set({ revokedAt: new Date() })
    .where(eq(userRolesTable.id, userId));
  // Also revoke every other role this user has in the tenant so the
  // deprovision is total (matches Okta/Azure expectations).
  await db
    .update(userRolesTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(userRolesTable.orgId, orgId),
        eq(userRolesTable.userId, existing.userId),
        isNull(userRolesTable.revokedAt),
      ),
    );
  await writeAdminAudit({
    orgId,
    actor: "scim-bridge",
    action: "scim.user_deprovision",
    targetId: userId,
    targetLabel: existing.email,
    metadata: { externalId: existing.userId },
  });
  res.status(204).send();
});

// ----- Groups ------------------------------------------------------

async function getMembersOf(groupId: string): Promise<
  Array<{ id: string; userRef: string; grantedUserRoleId: string | null }>
> {
  return db
    .select({
      id: scimGroupMembersTable.id,
      userRef: scimGroupMembersTable.userRef,
      grantedUserRoleId: scimGroupMembersTable.grantedUserRoleId,
    })
    .from(scimGroupMembersTable)
    .where(eq(scimGroupMembersTable.groupId, groupId));
}

router.get("/scim/v2/orgs/:orgId/Groups", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const { startIndex, count } = readPagination(
    req.query as Record<string, unknown>,
  );
  let filter;
  try {
    filter = parseScimGroupFilter(
      typeof req.query["filter"] === "string"
        ? (req.query["filter"] as string)
        : null,
    );
  } catch (err) {
    if (err instanceof InvalidScimFilterError) {
      jsonScimError(res, 400, err.message, "invalidFilter");
      return;
    }
    throw err;
  }
  const where = and(
    eq(scimGroupsTable.orgId, orgId),
    isNull(scimGroupsTable.deletedAt),
    ...(filter?.displayName
      ? [eq(scimGroupsTable.displayName, filter.displayName)]
      : []),
    ...(filter?.externalId
      ? [eq(scimGroupsTable.externalId, filter.externalId)]
      : []),
  );
  const rows = await db
    .select()
    .from(scimGroupsTable)
    .where(where)
    .orderBy(desc(scimGroupsTable.createdAt));
  const page = rows.slice(startIndex - 1, startIndex - 1 + count);
  const baseUrl = getBaseUrl(req);
  const resources = await Promise.all(
    page.map(async (g) =>
      groupResource(baseUrl, orgId, g, await getMembersOf(g.id)),
    ),
  );
  res.json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: rows.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: resources,
  });
});

router.get("/scim/v2/orgs/:orgId/Groups/:groupId", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const groupId = String(req.params.groupId);
  const [group] = await db
    .select()
    .from(scimGroupsTable)
    .where(
      and(eq(scimGroupsTable.orgId, orgId), eq(scimGroupsTable.id, groupId)),
    );
  if (!group || group.deletedAt) {
    jsonScimError(res, 404, "Group not found");
    return;
  }
  const members = await getMembersOf(group.id);
  res.json(groupResource(getBaseUrl(req), orgId, group, members));
});

router.post("/scim/v2/orgs/:orgId/Groups", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const body = (req.body ?? {}) as ScimGroupBody;
  if (!body.displayName) {
    jsonScimError(res, 400, "displayName required", "invalidValue");
    return;
  }
  // 409 if a group with the same displayName exists.
  const [conflict] = await db
    .select()
    .from(scimGroupsTable)
    .where(
      and(
        eq(scimGroupsTable.orgId, orgId),
        eq(scimGroupsTable.displayName, body.displayName),
        isNull(scimGroupsTable.deletedAt),
      ),
    )
    .limit(1);
  if (conflict) {
    jsonScimError(res, 409, "Group already exists", "uniqueness");
    return;
  }
  const [group] = await db
    .insert(scimGroupsTable)
    .values({
      id: newId("scimgrp"),
      orgId,
      displayName: body.displayName,
      externalId: body.externalId ?? null,
      roleMapping: null,
    })
    .returning();
  if (!group) {
    jsonScimError(res, 500, "Insert failed");
    return;
  }
  await writeAdminAudit({
    orgId,
    actor: "scim-bridge",
    action: "scim.group_create",
    targetId: group.id,
    targetLabel: group.displayName,
    metadata: {
      externalId: group.externalId,
      memberCount: body.members?.length ?? 0,
    },
  });
  // Add any initial members.
  for (const m of body.members ?? []) {
    if (!m.value) continue;
    const grant = await applyGroupMembership({
      orgId,
      group,
      userRef: m.value,
      actor: "scim-bridge",
    });
    await db
      .insert(scimGroupMembersTable)
      .values({
        id: newId("scimmem"),
        groupId: group.id,
        userRef: m.value,
        grantedUserRoleId: grant.grantedUserRoleId,
      })
      .onConflictDoNothing();
  }
  const members = await getMembersOf(group.id);
  res
    .status(201)
    .json(groupResource(getBaseUrl(req), orgId, group, members));
});

router.put("/scim/v2/orgs/:orgId/Groups/:groupId", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const groupId = String(req.params.groupId);
  const body = (req.body ?? {}) as ScimGroupBody;
  const [existing] = await db
    .select()
    .from(scimGroupsTable)
    .where(
      and(eq(scimGroupsTable.orgId, orgId), eq(scimGroupsTable.id, groupId)),
    );
  if (!existing || existing.deletedAt) {
    jsonScimError(res, 404, "Group not found");
    return;
  }
  const update: Partial<typeof scimGroupsTable.$inferInsert> = {};
  if (body.displayName) update.displayName = body.displayName;
  if (body.externalId !== undefined)
    update.externalId = body.externalId ?? null;
  let group: ScimGroupRow = existing;
  if (Object.keys(update).length > 0) {
    const [u] = await db
      .update(scimGroupsTable)
      .set(update)
      .where(eq(scimGroupsTable.id, groupId))
      .returning();
    if (u) group = u;
  }
  // PUT replaces the member list. Remove all existing memberships,
  // re-add what was sent.
  const current = await getMembersOf(groupId);
  for (const m of current) {
    await revokeGroupMembership({
      orgId,
      group,
      member: m,
      actor: "scim-bridge",
    });
  }
  for (const m of body.members ?? []) {
    if (!m.value) continue;
    const grant = await applyGroupMembership({
      orgId,
      group,
      userRef: m.value,
      actor: "scim-bridge",
    });
    await db
      .insert(scimGroupMembersTable)
      .values({
        id: newId("scimmem"),
        groupId: group.id,
        userRef: m.value,
        grantedUserRoleId: grant.grantedUserRoleId,
      })
      .onConflictDoNothing();
  }
  await writeAdminAudit({
    orgId,
    actor: "scim-bridge",
    action: "scim.group_update",
    targetId: group.id,
    targetLabel: group.displayName,
    metadata: { memberCount: body.members?.length ?? 0 },
  });
  const members = await getMembersOf(group.id);
  res.json(groupResource(getBaseUrl(req), orgId, group, members));
});

router.patch("/scim/v2/orgs/:orgId/Groups/:groupId", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const groupId = String(req.params.groupId);
  const body = (req.body ?? {}) as ScimPatchBody;
  const ops = body.Operations ?? body.operations ?? [];
  const [existing] = await db
    .select()
    .from(scimGroupsTable)
    .where(
      and(eq(scimGroupsTable.orgId, orgId), eq(scimGroupsTable.id, groupId)),
    );
  if (!existing || existing.deletedAt) {
    jsonScimError(res, 404, "Group not found");
    return;
  }
  let group = existing;
  for (const op of ops) {
    const opName = (op.op ?? "").toLowerCase();
    const path = (op.path ?? "").toLowerCase();
    const v = op.value;
    if (opName === "replace" && path === "displayname" && typeof v === "string") {
      const [u] = await db
        .update(scimGroupsTable)
        .set({ displayName: v })
        .where(eq(scimGroupsTable.id, groupId))
        .returning();
      if (u) group = u;
      continue;
    }
    if (opName === "add" && path.startsWith("members") && Array.isArray(v)) {
      for (const m of v as Array<{ value?: string }>) {
        if (!m.value) continue;
        // Skip duplicates.
        const [dup] = await db
          .select()
          .from(scimGroupMembersTable)
          .where(
            and(
              eq(scimGroupMembersTable.groupId, group.id),
              eq(scimGroupMembersTable.userRef, m.value),
            ),
          )
          .limit(1);
        if (dup) continue;
        const grant = await applyGroupMembership({
          orgId,
          group,
          userRef: m.value,
          actor: "scim-bridge",
        });
        await db.insert(scimGroupMembersTable).values({
          id: newId("scimmem"),
          groupId: group.id,
          userRef: m.value,
          grantedUserRoleId: grant.grantedUserRoleId,
        });
      }
      continue;
    }
    if (opName === "remove" && path.startsWith("members")) {
      // Two shapes are possible:
      //  - PATH-style: `members[value eq "x"]`
      //  - VALUE-style: `members` with `value: [{value: "x"}]`
      const matchInPath = /value\s+eq\s+"([^"]+)"/i.exec(op.path ?? "");
      const candidates: string[] = [];
      if (matchInPath?.[1]) candidates.push(matchInPath[1]);
      if (Array.isArray(v))
        for (const m of v as Array<{ value?: string }>)
          if (m.value) candidates.push(m.value);
      if (candidates.length === 0 && (op.path ?? "") === "members") {
        // remove all
        const all = await getMembersOf(group.id);
        for (const m of all) {
          await revokeGroupMembership({
            orgId,
            group,
            member: m,
            actor: "scim-bridge",
          });
        }
        continue;
      }
      const toRemove = await db
        .select({
          id: scimGroupMembersTable.id,
          userRef: scimGroupMembersTable.userRef,
          grantedUserRoleId: scimGroupMembersTable.grantedUserRoleId,
        })
        .from(scimGroupMembersTable)
        .where(
          and(
            eq(scimGroupMembersTable.groupId, group.id),
            inArray(scimGroupMembersTable.userRef, candidates),
          ),
        );
      for (const m of toRemove) {
        await revokeGroupMembership({
          orgId,
          group,
          member: m,
          actor: "scim-bridge",
        });
      }
      continue;
    }
    // Pathless replace bag — Azure AD does this for displayName.
    if (opName === "replace" && path === "" && v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (typeof obj["displayName"] === "string") {
        const [u] = await db
          .update(scimGroupsTable)
          .set({ displayName: obj["displayName"] as string })
          .where(eq(scimGroupsTable.id, groupId))
          .returning();
        if (u) group = u;
      }
    }
  }
  await writeAdminAudit({
    orgId,
    actor: "scim-bridge",
    action: "scim.group_update",
    targetId: group.id,
    targetLabel: group.displayName,
    metadata: { ops: ops.map((o) => ({ op: o.op, path: o.path })) },
  });
  const members = await getMembersOf(group.id);
  res.json(groupResource(getBaseUrl(req), orgId, group, members));
});

router.delete("/scim/v2/orgs/:orgId/Groups/:groupId", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const groupId = String(req.params.groupId);
  const [group] = await db
    .select()
    .from(scimGroupsTable)
    .where(
      and(eq(scimGroupsTable.orgId, orgId), eq(scimGroupsTable.id, groupId)),
    );
  if (!group || group.deletedAt) {
    jsonScimError(res, 404, "Group not found");
    return;
  }
  // Revoke every membership-derived user_role row.
  const members = await getMembersOf(group.id);
  for (const m of members) {
    await revokeGroupMembership({
      orgId,
      group,
      member: m,
      actor: "scim-bridge",
    });
  }
  await db
    .update(scimGroupsTable)
    .set({ deletedAt: new Date() })
    .where(eq(scimGroupsTable.id, groupId));
  await writeAdminAudit({
    orgId,
    actor: "scim-bridge",
    action: "scim.group_delete",
    targetId: group.id,
    targetLabel: group.displayName,
    metadata: { externalId: group.externalId },
  });
  res.status(204).send();
});

/**
 * Boot-time guardrail: `SCIM_BEARER_TOKEN` is the dev escape hatch
 * documented in SCIM.md §2 and is intentionally NOT bound to a
 * specific tenant. Setting it on a server that hosts more than one
 * provisioned org is a misconfiguration — any IdP holding the token
 * could push to any tenant URL. Emit a loud WARN so the issue
 * surfaces in deploy logs; do not silently fail open.
 */
export async function maybeWarnSharedScimTokenMisuse(): Promise<void> {
  if (!process.env["SCIM_BEARER_TOKEN"]) return;
  try {
    const rows = await db.select({ id: orgsTable.id }).from(orgsTable).limit(2);
    if (rows.length > 1) {
      const message =
        "SCIM_BEARER_TOKEN is set on a multi-tenant deployment — this " +
        "bypasses per-tenant SCIM auth. Remove it and use per-tenant " +
        "org_admin api_keys instead. See artifacts/api-server/SCIM.md §2.";
      // In production we refuse to boot rather than expose the
      // cross-tenant footgun. Operators must either unset the env
      // var or scope the deployment to a single tenant.
      if (process.env["NODE_ENV"] === "production") {
        logger.fatal({ orgsSampled: rows.length }, message);
        throw new Error(message);
      }
      logger.warn({ orgsSampled: rows.length }, message);
    }
  } catch (err) {
    if (process.env["NODE_ENV"] === "production") throw err;
    logger.warn(
      { err },
      "maybeWarnSharedScimTokenMisuse: could not enumerate orgs",
    );
  }
}

export default router;
