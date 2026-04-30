import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { JobQuotaExceededError } from "./jobs/queue";
import { sanitizeDbErrorMessage, errorLogContext } from "./sanitize-db-error";

/**
 * Global Express error-handling middleware.
 *
 * Express's default error handler renders the error stack into the response
 * in non-production environments, and that stack can include the failing
 * SQL statement and bound parameter values for any `pg` / Drizzle error
 * that bubbles up uncaught from a route. Task #17 sanitized the CSV import
 * paths and task #71 added a global 500 handler so every other route was
 * covered too.
 *
 * This handler additionally recognises a small set of *known typed errors*
 * thrown by route handlers and maps them to the correct 4xx status code
 * before falling back to the sanitized 500 response. Without this mapping,
 * routes that simply `throw new ZodError(...)` from a generated request
 * schema or `throw new JobQuotaExceededError(...)` would be reported to
 * clients as 500 — which is misleading (the request is the problem, not
 * the server) and pollutes operator dashboards with non-actionable noise.
 *
 * Recognised typed errors:
 *
 *   - `ZodError` (`zod`)                 → 400 with `{ error, details }`
 *     where `details` is the issues array (field paths + validation
 *     messages, no caller-supplied row data).
 *   - `JobQuotaExceededError` (jobs)     → its declared `statusCode` (429)
 *     with the configured human message.
 *
 * Everything else is treated as an unexpected failure: the full original
 * error is logged via `req.log.error` (so SQL / bound params / stack stay
 * available for debugging) and the client receives a sanitized
 * `{ error }` JSON body that never leaks SQL, parameter values,
 * `detail`/`hint` text, or a stack trace.
 *
 * The 4xx branches deliberately do *not* call `req.log.error` — a 400 from
 * a malformed client request is not an operator-actionable incident, and
 * pino-http already records the request line + final status code at info
 * level for every response.
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
    res.status(400).json({
      error: "Invalid request",
      details: err.issues,
    });
    return;
  }

  if (err instanceof JobQuotaExceededError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  req.log.error(
    { err, ...errorLogContext(err), route: req.path },
    "Unhandled route error",
  );
  res.status(500).json({ error: sanitizeDbErrorMessage(err) });
};
