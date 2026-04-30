import type { Request, Response, NextFunction, RequestHandler } from "express";
import { db, orgsTable, userRolesTable, apiKeysTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import {
  extractBearerToken,
  resolveOrgFromToken,
  isProduction,
  hashToken,
} from "./auth";

const orgCache = new Map<string, { id: string; expiresAt: number }>();
const TTL_MS = 30_000;

async function resolveOrgId(orgIdHeader: string): Promise<string | null> {
  const cached = orgCache.get(orgIdHeader);
  if (cached && cached.expiresAt > Date.now()) return cached.id;
  const [row] = await db
    .select({ id: orgsTable.id })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgIdHeader))
    .limit(1);
  if (!row) return null;
  orgCache.set(orgIdHeader, { id: row.id, expiresAt: Date.now() + TTL_MS });
  return row.id;
}

/**
 * Hard tenant isolation.
 *
 * Authorization order:
 *  1. `Authorization: Bearer <token>` — sha256-hashed and matched against
 *     `org_api_tokens.token_hash`. The bound `org_id` becomes the tenant
 *     scope. If `x-org-id` is also present, it MUST match the bound org or
 *     the request is rejected with 403 (prevents header confusion).
 *  2. (dev only) `x-org-id` header alone — accepted ONLY when the explicit
 *     positive opt-in `ALLOW_DEV_TENANT_HEADER=true` is set AND
 *     `NODE_ENV !== "production"`. Both must hold; absence/typo of
 *     `NODE_ENV` cannot accidentally enable the bypass.
 *  3. (dev only, same gate) Fallback to first seeded org when no auth
 *     context is supplied. Useful for the local UI smoke flow.
 *
 * In production, or when the dev flag is not explicitly opted in, requests
 * without a valid bearer token are rejected with 401.
 */
export const tenantMiddleware: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const bearer = extractBearerToken(req);
  const headerOrgId = req.header("x-org-id");
  // SECURE-BY-DEFAULT: dev fallback requires explicit positive opt-in and
  // a non-production env. Missing/typo NODE_ENV will NOT enable the bypass.
  const devHeaderAllowed =
    !isProduction() && process.env["ALLOW_DEV_TENANT_HEADER"] === "true";

  if (bearer) {
    // Try the new tenant-scoped API keys table first; fall back to the
    // legacy org_api_tokens for system-to-system callers.
    const tokenHash = hashToken(bearer);
    const [apiKey] = await db
      .select({
        orgId: apiKeysTable.orgId,
        scopeRole: apiKeysTable.scopeRole,
        label: apiKeysTable.label,
      })
      .from(apiKeysTable)
      .where(
        and(
          eq(apiKeysTable.tokenHash, tokenHash),
          isNull(apiKeysTable.revokedAt),
        ),
      )
      .limit(1);
    let tokenOrgId: string | null = apiKey?.orgId ?? null;
    let mode: NonNullable<Request["authMode"]> = "api-key";
    let actor = `apikey:${apiKey?.label ?? "unknown"}@procuro.ai`;
    if (!tokenOrgId) {
      tokenOrgId = await resolveOrgFromToken(bearer);
      mode = "token";
      actor = "system@procuro.ai";
    }
    if (!tokenOrgId) {
      res.status(401).json({ error: "Invalid API token" });
      return;
    }
    if (headerOrgId && headerOrgId !== tokenOrgId) {
      res
        .status(403)
        .json({ error: "Token is not authorized for the requested tenant" });
      return;
    }
    req.orgId = tokenOrgId;
    req.authMode = mode;
    req.actorEmail = actor;
    next();
    return;
  }

  // Clerk session — once `clerkMiddleware` has populated req.auth, look
  // up the active tenant via the `x-org-id` header (or fall back to the
  // user's first org membership). We never trust a Clerk session for an
  // org the user has no role in.
  let clerkUserId: string | null = null;
  let clerkEmail: string | undefined;
  try {
    const auth = getAuth(req);
    clerkUserId = auth?.userId ?? null;
    const claims = auth?.sessionClaims as Record<string, unknown> | undefined;
    const e = claims?.["email"];
    if (typeof e === "string") clerkEmail = e;
  } catch {
    // clerkMiddleware not mounted — treat as unauthenticated.
  }

  if (clerkUserId) {
    let resolvedOrg: string | null = null;
    if (headerOrgId) {
      const [row] = await db
        .select({ orgId: userRolesTable.orgId, email: userRolesTable.email })
        .from(userRolesTable)
        .where(
          and(
            eq(userRolesTable.userId, clerkUserId),
            eq(userRolesTable.orgId, headerOrgId),
            isNull(userRolesTable.revokedAt),
          ),
        )
        .limit(1);
      if (row) {
        resolvedOrg = row.orgId;
        clerkEmail = clerkEmail ?? row.email;
      }
    } else {
      const [row] = await db
        .select({ orgId: userRolesTable.orgId, email: userRolesTable.email })
        .from(userRolesTable)
        .where(
          and(
            eq(userRolesTable.userId, clerkUserId),
            isNull(userRolesTable.revokedAt),
          ),
        )
        .limit(1);
      if (row) {
        resolvedOrg = row.orgId;
        clerkEmail = clerkEmail ?? row.email;
      }
    }
    if (!resolvedOrg) {
      res.status(403).json({ error: "User is not a member of any tenant" });
      return;
    }
    req.orgId = resolvedOrg;
    req.authMode = "clerk";
    req.clerkUserId = clerkUserId;
    req.actorEmail = clerkEmail ?? `${clerkUserId}@clerk.local`;
    next();
    return;
  }

  if (headerOrgId) {
    if (!devHeaderAllowed) {
      res.status(401).json({ error: "Bearer token required" });
      return;
    }
    const resolved = await resolveOrgId(headerOrgId);
    if (!resolved) {
      res.status(403).json({ error: "Unknown tenant" });
      return;
    }
    req.orgId = resolved;
    req.authMode = "dev-header";
    req.actorEmail = "system@procuro.ai";
    next();
    return;
  }

  if (devHeaderAllowed) {
    const [first] = await db
      .select({ id: orgsTable.id })
      .from(orgsTable)
      .orderBy(orgsTable.createdAt)
      .limit(1);
    if (first) {
      req.orgId = first.id;
      req.authMode = "dev-fallback";
      req.actorEmail = "system@procuro.ai";
      next();
      return;
    }
  }

  res.status(401).json({ error: "Authorization required" });
};

export function requireOrgId(req: Request): string {
  if (!req.orgId) {
    throw new Error("Tenant scope missing — middleware not applied");
  }
  return req.orgId;
}
