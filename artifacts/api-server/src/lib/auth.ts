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
