import type { Request, RequestHandler } from "express";
import { db, userRolesTable, apiKeysTable, type UserRoleName } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { hashToken, extractBearerToken } from "./auth";
import { getAuth } from "@clerk/express";

/**
 * ============================================================================
 * Permission matrix — keep in sync with `.local/tasks/task-119.md` § Roles.
 * ============================================================================
 *
 * Six fixed roles, no per-tenant custom roles in H1.
 *
 *  | role            | can read | can mutate own-tenant data | can approve | admin UI | platform routes |
 *  | --------------- | -------- | -------------------------- | ----------- | -------- | --------------- |
 *  | platform_admin  | yes      | yes (any tenant)           | yes         | yes      | yes             |
 *  | org_admin       | yes      | yes                        | yes         | yes      | no              |
 *  | approver        | yes      | yes (op. transitions)      | yes         | no       | no              |
 *  | analyst         | yes      | yes (suggest / ingest)     | no          | no       | no              |
 *  | read_only       | yes      | no                         | no          | no       | no              |
 *  | auditor         | yes + audit log | no                  | no          | audit log only | no       |
 *
 * Permission tokens are deliberately verb-noun strings rather than
 * arbitrary booleans so the policy is greppable and so a reviewer can
 * read a route handler and immediately know what surface it protects.
 *
 *  - "read"            — every authenticated role.
 *  - "ingest:write"    — analyst, approver, org_admin, platform_admin.
 *  - "opp:approve"     — approver, org_admin, platform_admin.
 *  - "opp:execute"     — approver, org_admin, platform_admin.
 *  - "opp:realize"     — approver, org_admin, platform_admin.
 *  - "settings:write"  — org_admin, platform_admin.
 *  - "users:manage"    — org_admin, platform_admin.
 *  - "api_keys:manage" — org_admin, platform_admin.
 *  - "audit:read"      — org_admin, platform_admin, auditor.
 *  - "platform:manage" — platform_admin.
 *
 * The permission table below is the single source of truth.
 */
export type Permission =
  | "read"
  | "ingest:write"
  | "opp:approve"
  | "opp:execute"
  | "opp:realize"
  | "settings:write"
  | "users:manage"
  | "api_keys:manage"
  | "audit:read"
  | "platform:manage";

const PERMISSIONS_BY_ROLE: Record<UserRoleName, ReadonlyArray<Permission>> = {
  platform_admin: [
    "read",
    "ingest:write",
    "opp:approve",
    "opp:execute",
    "opp:realize",
    "settings:write",
    "users:manage",
    "api_keys:manage",
    "audit:read",
    "platform:manage",
  ],
  org_admin: [
    "read",
    "ingest:write",
    "opp:approve",
    "opp:execute",
    "opp:realize",
    "settings:write",
    "users:manage",
    "api_keys:manage",
    "audit:read",
  ],
  approver: ["read", "ingest:write", "opp:approve", "opp:execute", "opp:realize"],
  analyst: ["read", "ingest:write"],
  read_only: ["read"],
  auditor: ["read", "audit:read"],
};

export function rolePermissions(role: UserRoleName): ReadonlyArray<Permission> {
  return PERMISSIONS_BY_ROLE[role] ?? [];
}

export function roleHasPermission(
  role: UserRoleName,
  perm: Permission,
): boolean {
  return PERMISSIONS_BY_ROLE[role]?.includes(perm) ?? false;
}

/**
 * Active role(s) attached to the request by `tenantMiddleware` (or the
 * test fixtures). A request can hold multiple roles in two cases:
 *  - SCIM/manual roles map a user to several roles in the same org.
 *  - Platform admins implicitly inherit every other role.
 */
export interface RbacContext {
  userId: string | null;
  email: string;
  roles: UserRoleName[];
  /** True iff the request is acting through a long-lived API key. */
  viaApiKey: boolean;
}

/**
 * Resolve the caller's effective roles in the active tenant.
 *
 * Precedence:
 *  1. `Authorization: Bearer <api_key>` — `api_keys.scope_role` is the
 *     single role the request acts as (no inheritance from the issuer).
 *  2. Clerk session — look up `user_roles` rows for `(clerk_user_id,
 *     orgId)` that are not revoked. An empty result means the user is not
 *     a member of the tenant; the caller decides whether to 403 or 404.
 *  3. Dev fallback — when the tenant middleware admitted the request via
 *     the dev header / first-seeded-org path, grant `platform_admin` so
 *     local development isn't gated by RBAC.
 *
 * The result is cached on `req.rbac` so subsequent permission checks on
 * the same request are free.
 */
export async function resolveRbacContext(
  req: Request,
): Promise<RbacContext> {
  if (req.rbac) return req.rbac;

  const orgId = req.orgId;
  if (!orgId) {
    const ctx: RbacContext = {
      userId: null,
      email: req.actorEmail ?? "anonymous",
      roles: [],
      viaApiKey: false,
    };
    req.rbac = ctx;
    return ctx;
  }

  // 1. API key path
  const bearer = extractBearerToken(req);
  if (bearer) {
    const tokenHash = hashToken(bearer);
    const [apiKey] = await db
      .select({
        scopeRole: apiKeysTable.scopeRole,
        orgId: apiKeysTable.orgId,
      })
      .from(apiKeysTable)
      .where(
        and(
          eq(apiKeysTable.tokenHash, tokenHash),
          isNull(apiKeysTable.revokedAt),
        ),
      )
      .limit(1);
    if (apiKey && apiKey.orgId === orgId) {
      const ctx: RbacContext = {
        userId: null,
        email: req.actorEmail ?? "system@procuro.ai",
        roles: [apiKey.scopeRole],
        viaApiKey: true,
      };
      req.rbac = ctx;
      // Best-effort last-used timestamp; failures are not fatal.
      db.update(apiKeysTable)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeysTable.tokenHash, tokenHash))
        .catch(() => undefined);
      return ctx;
    }
    // Bearer present but not found in api_keys — this is a legacy
    // org_api_tokens bearer. The legacy token table has no role column
    // and these are per-tenant credentials with no platform authority.
    // Grant the minimum viable scope (analyst) so ingest integrations
    // continue to work without receiving platform_admin privileges.
    const ctx: RbacContext = {
      userId: null,
      email: req.actorEmail ?? "system@procuro.ai",
      roles: ["analyst"],
      viaApiKey: true,
    };
    req.rbac = ctx;
    return ctx;
  }

  // 2. Clerk session
  let clerkUserId: string | null = null;
  let clerkEmail: string | undefined;
  try {
    const auth = getAuth(req);
    clerkUserId = auth?.userId ?? null;
    const claims = auth?.sessionClaims as
      | Record<string, unknown>
      | undefined;
    if (claims) {
      const e = claims["email"];
      if (typeof e === "string") clerkEmail = e;
    }
  } catch {
    // Clerk middleware not mounted — treat as no session.
  }

  if (clerkUserId) {
    const rows = await db
      .select({ role: userRolesTable.role, email: userRolesTable.email })
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.userId, clerkUserId),
          eq(userRolesTable.orgId, orgId),
          isNull(userRolesTable.revokedAt),
        ),
      );
    const roles = rows.map((r) => r.role);
    const ctx: RbacContext = {
      userId: clerkUserId,
      email: clerkEmail ?? rows[0]?.email ?? req.actorEmail ?? "unknown@procuro.ai",
      roles,
      viaApiKey: false,
    };
    req.rbac = ctx;
    return ctx;
  }

  // 3. Dev fallback — tenant middleware admitted us via dev-header /
  //    dev-fallback. Grant platform_admin to keep local DX unchanged.
  if (req.authMode === "dev-header" || req.authMode === "dev-fallback") {
    const ctx: RbacContext = {
      userId: null,
      email: req.actorEmail ?? "system@procuro.ai",
      roles: ["platform_admin"],
      viaApiKey: false,
    };
    req.rbac = ctx;
    return ctx;
  }

  const ctx: RbacContext = {
    userId: null,
    email: req.actorEmail ?? "anonymous",
    roles: [],
    viaApiKey: false,
  };
  req.rbac = ctx;
  return ctx;
}

/**
 * Express middleware factory: deny the request unless the resolved RBAC
 * context grants ALL of the named permissions. Always run AFTER
 * `tenantMiddleware` so `req.orgId` is available.
 *
 * 401 when no role is resolvable (no session + no API key);
 * 403 when at least one role is resolved but none satisfies the rule.
 */
export function requirePermission(...required: Permission[]): RequestHandler {
  return async (req, res, next) => {
    try {
      const ctx = await resolveRbacContext(req);
      if (ctx.roles.length === 0) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const ok = required.every((p) =>
        ctx.roles.some((r) => roleHasPermission(r, p)),
      );
      if (!ok) {
        res.status(403).json({
          error: "Forbidden",
          required,
          have: ctx.roles,
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Sugar: gate by role membership rather than an enumerated permission.
 * Useful for the admin UI routes which require an exact role rather
 * than a granular capability.
 */
export function requireRole(...allowed: UserRoleName[]): RequestHandler {
  return async (req, res, next) => {
    try {
      const ctx = await resolveRbacContext(req);
      if (ctx.roles.length === 0) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const ok = ctx.roles.some((r) => allowed.includes(r));
      if (!ok) {
        res
          .status(403)
          .json({ error: "Forbidden", allowed, have: ctx.roles });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
