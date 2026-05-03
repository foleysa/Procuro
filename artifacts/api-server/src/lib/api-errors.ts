/**
 * Stable typed errors for the API server.
 *
 * Route handlers throw one of these (or a `ZodError` from a generated
 * request schema) and the global error handler in
 * `global-error-handler.ts` maps the class to a stable HTTP status code
 * and a uniform JSON envelope:
 *
 *   { error: string, code: string, details?: unknown }
 *
 * Until task #297 introduced this module, every route did its own
 * ad-hoc `res.status(401).json({ error: "..." })` call, which made it
 * very easy for a handler to leak a 500 with raw error text on a
 * condition that should obviously have been a 4xx (e.g. "tenant not
 * found"). Centralising the mapping fixes the inconsistency and gives
 * tests a single place to assert against.
 */

export type ApiErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "tenant_mismatch"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "db_constraint"
  | "quota_exceeded"
  | "internal_error";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class InvalidRequestError extends ApiError {
  constructor(message = "Invalid request", details?: unknown) {
    super(400, "invalid_request", message, details);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Authentication required") {
    super(401, "unauthorized", message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden", details?: unknown) {
    super(403, "forbidden", message, details);
  }
}

/**
 * Tenant boundary violation — the caller is authenticated but is asking
 * about a resource they don't own. Distinct from `ForbiddenError` so
 * cross-tenant probes are easy to grep for in the logs.
 */
export class TenantMismatchError extends ApiError {
  constructor(message = "Resource belongs to a different tenant") {
    super(403, "tenant_mismatch", message);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
  }
}

export class ConflictError extends ApiError {
  constructor(message = "Conflict", details?: unknown) {
    super(409, "conflict", message, details);
  }
}

/**
 * Semantic / business-rule violation (HTTP 422). The request was
 * syntactically valid (so it would not be a `ZodError` / 400) and the
 * target resource exists (so it would not be a `NotFoundError` / 404),
 * but the requested state transition violates a domain invariant.
 *
 * Used by, e.g., the realize endpoint when the opportunity is missing a
 * Finance-grade baseline (`baseline_value` / `baseline_method = 'N/A — Soft'`).
 */
export class UnprocessableEntityError extends ApiError {
  constructor(message = "Unprocessable entity", details?: unknown) {
    super(422, "unprocessable", message, details);
  }
}

/**
 * Postgres returned a constraint violation that we know about (FK,
 * unique, NOT NULL, check). Routes that catch a `pg` error and want to
 * surface a friendly 4xx instead of a 500 should re-throw this.
 */
export class DBConstraintError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(409, "db_constraint", message, details);
  }
}

/**
 * Type guard used by the global error handler so it can recognise our
 * own typed errors even when a route wraps them in `cause`.
 */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
