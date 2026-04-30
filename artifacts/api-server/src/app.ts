import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import { globalErrorHandler } from "./lib/global-error-handler";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

// Clerk Frontend API proxy MUST be mounted before any body parser; it
// streams raw bytes and intercepts only `/api/__clerk/*`.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

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

// Resolve the publishable key from the request host so the same server
// can serve multiple Clerk custom domains. clerkMiddleware adds session
// claims to req.auth without rejecting unauthenticated requests — RBAC
// gating is the role of `requirePermission` later in the pipeline.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env["CLERK_PUBLISHABLE_KEY"],
    ),
  })),
);

app.use("/api", router);

app.use(globalErrorHandler);

export default app;
