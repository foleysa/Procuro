import type { Request, Response, NextFunction } from "express";
import { ApiError, ForbiddenError } from "./api-errors";

// Cross-tenant platform endpoints. Prod requires PLATFORM_ADMIN_TOKEN match;
// dev allows pass-through when the env var is unset (set it to test prod auth).
export function requirePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env["PLATFORM_ADMIN_TOKEN"];
  const presented = req.header("x-platform-admin-token");
  const isProd = process.env["NODE_ENV"] === "production";

  if (!expected) {
    if (isProd) {
      throw new ApiError(503, "internal_error", "Platform admin endpoints are disabled: PLATFORM_ADMIN_TOKEN is not configured.");
    }
    next();
    return;
  }
  if (!presented || presented !== expected) {
    throw new ForbiddenError("Platform admin token required.");
  }
  next();
}
