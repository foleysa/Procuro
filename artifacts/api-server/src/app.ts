import express, {
  type Express,
  type ErrorRequestHandler,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  sanitizeDbErrorMessage,
  errorLogContext,
} from "./lib/sanitize-db-error";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Skip body parsers for the streaming CSV ingest path so it can read the raw req.
const SKIP_BODY = "/api/ingest/csv-stream";
// Ingest endpoints accept larger payloads than the default but are still capped
// to prevent a single tenant from forcing unbounded memory and CPU use on the
// shared API process. All other routes get a tighter 1 MB limit.
const INGEST_PATHS = ["/api/ingest/csv", "/api/ingest/mock-erp"];
const INGEST_BODY_LIMIT = "5mb";
const DEFAULT_BODY_LIMIT = "1mb";
app.use((req, res, next) => {
  if (req.path.startsWith(SKIP_BODY)) return next();
  const limit = INGEST_PATHS.some((p) => req.path.startsWith(p))
    ? INGEST_BODY_LIMIT
    : DEFAULT_BODY_LIMIT;
  return express.json({ limit })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith(SKIP_BODY)) return next();
  const limit = INGEST_PATHS.some((p) => req.path.startsWith(p))
    ? INGEST_BODY_LIMIT
    : DEFAULT_BODY_LIMIT;
  return express.urlencoded({ extended: true, limit })(req, res, next);
});

app.use("/api", router);

/**
 * Global error-handling middleware.
 *
 * Express's default error handler renders the error stack into the response
 * in non-production environments, and that stack can include the failing
 * SQL statement and bound parameter values for any `pg` / Drizzle error
 * that bubbles up uncaught from a route. Task #17 sanitized the CSV import
 * paths but every other route (suppliers, opportunities, jobs, market
 * signals, ...) still relied on Express's default — meaning the same data
 * leak applied project-wide.
 *
 * This middleware catches anything a route forwards to `next(err)` (or, for
 * async route handlers in Express 5, anything they reject with) and:
 *   1. logs the full original error server-side via `req.log.error` so
 *      operators retain SQL / bound params / stack for debugging, and
 *   2. returns a sanitized `{ error }` JSON body to the client containing
 *      only a short, identifier-level summary — never SQL, parameter
 *      values, `detail`/`hint` text, or a stack trace.
 */
const globalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // If the response is already partway out the door (e.g. a streaming
  // handler that called `res.write`), delegate to Express's default
  // handler so it can close the connection. We can't safely overwrite
  // headers or body at this point.
  if (res.headersSent) {
    next(err);
    return;
  }
  req.log.error(
    { err, ...errorLogContext(err), route: req.path },
    "Unhandled route error",
  );
  res.status(500).json({ error: sanitizeDbErrorMessage(err) });
};
app.use(globalErrorHandler);

export default app;
