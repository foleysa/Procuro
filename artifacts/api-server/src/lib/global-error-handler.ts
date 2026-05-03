import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { JobQuotaExceededError } from "./jobs/queue";
import { sanitizeDbErrorMessage, errorLogContext } from "./sanitize-db-error";
import { ApiError, isApiError, type ApiErrorCode } from "./api-errors";

/**
 * Global Express error-handling middleware.
 *
 * Express's default error handler renders the error stack into the
 * response in non-production environments, and that stack can include
 * the failing SQL statement and bound parameter values for any `pg` /
 * Drizzle error that bubbles up uncaught from a route. Task #17
 * sanitized the CSV import paths and task #71 added a global 500
 * handler so every other route was covered too.
 *
 * Task #297 extended the handler with a uniform error envelope:
 *
 *   { error: string, code: ApiErrorCode, details?: unknown }
 *
 * The `code` field is a stable machine-readable identifier so the
 * frontend and tests can branch on the error class without grepping the
 * human message. Recognised typed errors:
 *
 *   - `ZodError` (`zod`)                 → 400 `invalid_request`
 *   - `ApiError` and subclasses (auth,   → declared `statusCode` + `code`
 *     tenant, not-found, conflict, etc.)
 *   - `JobQuotaExceededError`            → 429 `quota_exceeded`
 *   - everything else                    → 500 `internal_error`
 *
 * The 4xx branches deliberately do *not* call `req.log.error` — a 400
 * from a malformed client request is not an operator-actionable
 * incident, and pino-http already records the request line + final
 * status code at info level for every response. Unhandled 5xx errors
 * are logged with the full original error so SQL / bound params / stack
 * stay available for debugging, while the client receives a sanitized
 * envelope that never leaks SQL, parameter values, `detail`/`hint`
 * text, or a stack trace.
 */
export const globalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // If the response is already partway out the door (e.g. a streaming
  // handler that called `res.write`), delegate to Express's default
  // handler so it can close the connection. We can't safely overwrite
  // headers or body at this point.
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ZodError) {
    sendError(res, 400, "invalid_request", "Invalid request", err.issues);
    return;
  }

  if (isApiError(err)) {
    sendError(res, err.statusCode, err.code, err.message, err.details);
    return;
  }

  if (err instanceof JobQuotaExceededError) {
    sendError(res, err.statusCode, "quota_exceeded", err.message);
    return;
  }

  req.log.error(
    { err, ...errorLogContext(err), route: req.path },
    "Unhandled route error",
  );
  sendError(res, 500, "internal_error", sanitizeDbErrorMessage(err));
};

function sendError(
  res: Parameters<ErrorRequestHandler>[2],
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): void {
  const body: Record<string, unknown> = { error: message, code };
  if (details !== undefined) body.details = details;
  res.status(status).json(body);
}

// Re-export so existing imports (`import { ApiError } from
// "./global-error-handler"`-style) work for new callers without forcing
// a separate import line. The canonical home is `./api-errors`.
export { ApiError } from "./api-errors";
