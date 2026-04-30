import type { Request, Response, NextFunction, RequestHandler } from "express";
import { db, orgsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  extractBearerToken,
  resolveOrgFromToken,
  isProduction,
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
  const actorEmail = req.header("x-actor-email") ?? "system@procuro.ai";
  req.actorEmail = actorEmail;

  const bearer = extractBearerToken(req);
  const headerOrgId = req.header("x-org-id");
  // SECURE-BY-DEFAULT: dev fallback requires explicit positive opt-in and
  // a non-production env. Missing/typo NODE_ENV will NOT enable the bypass.
  const devHeaderAllowed =
    !isProduction() && process.env["ALLOW_DEV_TENANT_HEADER"] === "true";

  if (bearer) {
    const tokenOrgId = await resolveOrgFromToken(bearer);
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
    req.authMode = "token";
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
