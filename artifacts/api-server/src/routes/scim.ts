import { Router, type IRouter, type Request, type Response } from "express";
import { db, userRolesTable, orgsTable, type UserRoleName } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { writeAdminAudit } from "../lib/admin-audit";
import { newId } from "../lib/ids";
import crypto from "node:crypto";

const router: IRouter = Router();

/**
 * SCIM 2.0 (RFC 7644) bridge endpoints.
 *
 * Clerk handles full SAML/OIDC SSO and bridges most SCIM operations
 * already (Clerk Organizations + custom roles), but some IdPs (Okta,
 * Azure AD, OneLogin) push SCIM provisioning events directly. This
 * surface accepts those pushes, mirrors them into our `user_roles`
 * table, and emits an `admin_audit_log` row so an auditor can prove
 * an offboarded user lost access in real time.
 *
 * AUTHENTICATION: SCIM endpoints use a per-tenant bearer token. We
 * accept the same `Authorization: Bearer <token>` shape the rest of
 * the API uses; the `tenantMiddleware` would resolve it to the
 * tenant org. To keep SCIM completely independent from the admin UI
 * (Okta typically only sends a single token), we resolve the org by
 * sha256-matching the token against `api_keys` with scopeRole
 * `org_admin` and require the URL to include `/scim/v2/orgs/:orgId/...`.
 *
 * FOR H1: this is a working scaffold sufficient to pass an Okta
 * provisioning test. Schema validation is light; production hardening
 * (full $ref / patchOp parsing) lands with the SOC 2 / Trust Center
 * follow-up.
 */

interface ScimUserBody {
  userName?: string;
  emails?: Array<{ value?: string; primary?: boolean }>;
  active?: boolean;
  externalId?: string;
  name?: { givenName?: string; familyName?: string };
}

function jsonScimError(
  res: Response,
  status: number,
  detail: string,
): void {
  res
    .status(status)
    .json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail,
      status: String(status),
    });
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
    return true;
  }
  // Cross-check against an `api_keys` row with org_admin scope so each
  // tenant can issue its own SCIM bearer. We re-import the helpers to
  // avoid a circular dep with `auth.ts`.
  const { db: dbImpl, apiKeysTable } = await import("@workspace/db");
  const { hashToken } = await import("../lib/auth");
  const tokenHash = hashToken(token);
  const [row] = await dbImpl
    .select({ orgId: apiKeysTable.orgId, scopeRole: apiKeysTable.scopeRole })
    .from(apiKeysTable)
    .where(
      and(
        eq(apiKeysTable.tokenHash, tokenHash),
        isNull(apiKeysTable.revokedAt),
      ),
    )
    .limit(1);
  return Boolean(
    row && row.orgId === expectedOrgId && row.scopeRole === "org_admin",
  );
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

router.get("/scim/v2/orgs/:orgId/ServiceProviderConfig", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  res.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://docs.procuro.ai/scim",
    patch: { supported: false },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: false, maxResults: 100 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Authenticate with an org-admin scoped API key",
      },
    ],
  });
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
    jsonScimError(res, 400, "userName / emails required");
    return;
  }
  const externalId = body.externalId ?? `scim:${email}`;

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
    })
    .returning();
  await writeAdminAudit({
    orgId,
    actor: "scim-bridge",
    action: "scim.user_provision",
    targetId: row?.id ?? null,
    targetLabel: email,
    metadata: { externalId, role },
  });

  res.status(201).json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: row?.id,
    externalId,
    userName: email,
    active: body.active ?? true,
    emails: [{ value: email, primary: true }],
    meta: {
      resourceType: "User",
      created: row?.createdAt,
      lastModified: row?.createdAt,
    },
  });
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
    .where(
      and(eq(userRolesTable.orgId, orgId), eq(userRolesTable.id, userId)),
    );
  if (!existing) {
    jsonScimError(res, 404, "User not found");
    return;
  }
  await db
    .update(userRolesTable)
    .set({ revokedAt: new Date() })
    .where(eq(userRolesTable.id, userId));
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

router.get("/scim/v2/orgs/:orgId/Users", async (req, res) => {
  const orgId = String(req.params.orgId);
  if (!(await authenticateScim(req, orgId))) {
    jsonScimError(res, 401, "Unauthorized");
    return;
  }
  const rows = await db
    .select()
    .from(userRolesTable)
    .where(
      and(eq(userRolesTable.orgId, orgId), isNull(userRolesTable.revokedAt)),
    );
  res.json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: rows.length,
    Resources: rows.map((r) => ({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: r.id,
      externalId: r.userId,
      userName: r.email,
      active: true,
      emails: [{ value: r.email, primary: true }],
    })),
  });
});

export default router;
