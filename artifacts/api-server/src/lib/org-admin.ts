import type { Request, Response, NextFunction } from "express";
import { isProduction } from "./auth";
import { ApiError, ForbiddenError } from "./api-errors";

/**
 * Tenant-scoped admin gating, used by management endpoints that should
 * only be reachable by an "Org Admin" actor — currently the
 * Integrations CRUD/sync routes. The platform does not yet have a
 * per-user role model, so we mirror the `requirePlatformAdmin`
 * pattern: a shared-secret header (`x-org-admin-token`) checked
 * against `ORG_ADMIN_TOKEN`.
 *
 * Behaviour:
 *
 * - **Production**: `ORG_ADMIN_TOKEN` MUST be configured. If it is
 *   absent the route returns 503 (configuration error) so a missing
 *   secret never quietly opens up tenant-admin endpoints.
 * - **Dev/test (`NODE_ENV !== "production"`)**: when the env var is
 *   unset the middleware passes through, matching the existing
 *   developer ergonomics for tenantMiddleware. Once the env var is
 *   set, the token must match — letting a developer test the prod
 *   gating locally.
 *
 * The middleware assumes `tenantMiddleware` ran first so
 * `req.orgId` is already populated; the token only proves "the caller
 * is allowed to administer this tenant", not which tenant they
 * belong to.
 */
export function requireOrgAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env["ORG_ADMIN_TOKEN"];
  const presented = req.header("x-org-admin-token");

  if (!expected) {
    if (isProduction()) {
      throw new ApiError(503, "internal_error", "Org admin endpoints are disabled: ORG_ADMIN_TOKEN is not configured.");
    }
    next();
    return;
  }
  if (!presented || presented !== expected) {
    throw new ForbiddenError("Org admin token required.");
  }
  next();
}
