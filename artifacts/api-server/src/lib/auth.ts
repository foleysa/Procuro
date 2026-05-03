import crypto from "node:crypto";
import type { Request } from "express";
import { db, orgApiTokensTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

export function hashToken(plain: string): string {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}

export function generateToken(): { plain: string; hash: string } {
  const plain = `proc_${crypto.randomBytes(24).toString("base64url")}`;
  return { plain, hash: hashToken(plain) };
}

export function extractBearerToken(req: Request): string | null {
  const h = req.header("authorization") ?? req.header("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m && m[1] ? m[1].trim() : null;
}

const tokenCache = new Map<string, { orgId: string; expiresAt: number }>();
const TTL_MS = 30_000;

export async function resolveOrgFromToken(
  plainToken: string,
): Promise<string | null> {
  const tokenHash = hashToken(plainToken);
  const cached = tokenCache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) return cached.orgId;
  const [row] = await db
    .select({ orgId: orgApiTokensTable.orgId })
    .from(orgApiTokensTable)
    .where(
      and(
        eq(orgApiTokensTable.tokenHash, tokenHash),
        isNull(orgApiTokensTable.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  tokenCache.set(tokenHash, { orgId: row.orgId, expiresAt: Date.now() + TTL_MS });
  return row.orgId;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Refuse to start the process if `ALLOW_DEV_TENANT_HEADER=true` is set
 * outside of a development environment. The dev-tenant header bypass
 * lets any caller declare themselves a `platform_admin` in any tenant
 * — strictly intentional in `NODE_ENV=development` for the local
 * smoke flow, catastrophic anywhere else (UAT v2 Blocker D-15, May
 * 2026). We require an explicit positive `NODE_ENV=development`;
 * unset / typo / "test" / "staging" / "production" all crash so the
 * misconfiguration is impossible to ship past CI.
 */
export function assertDevTenantHeaderSafe(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    env["ALLOW_DEV_TENANT_HEADER"] === "true" &&
    env["NODE_ENV"] !== "development"
  ) {
    throw new Error(
      "FATAL: ALLOW_DEV_TENANT_HEADER=true is only permitted when " +
        `NODE_ENV=development. Refusing to start with NODE_ENV=${
          env["NODE_ENV"] ?? "(unset)"
        }.`,
    );
  }
}
