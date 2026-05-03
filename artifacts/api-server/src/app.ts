import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import { globalErrorHandler } from "./lib/global-error-handler";
import { assertDevTenantHeaderSafe } from "./lib/auth";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

// Fail fast at module load if the dev-tenant impersonation header is
// enabled outside of a development environment. See
// `assertDevTenantHeaderSafe` for rationale (UAT v2 Blocker D-15).
assertDevTenantHeaderSafe();

const app: Express = express();

// Clerk Frontend API proxy MUST be mounted before any body parser; it
// streams raw bytes and intercepts only `/api/__clerk/*`.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(
  pinoHttp({
    logger,
    // Honour an inbound `x-request-id` (so callers can correlate across
    // services) and otherwise let pino-http generate one. Echoing it
    // back on the response makes the id visible in the browser
    // network tab and the canonical "everything that happened for
    // request X" lookup documented in HARDENING.md.
    genReqId(req, res) {
      const inbound = req.headers["x-request-id"];
      const id =
        typeof inbound === "string" && inbound.trim() !== ""
          ? inbound
          : `req_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
      res.setHeader("x-request-id", id);
      return id;
    },
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
  // Also accept SCIM 2.0 content type — RFC 7644 §3.1 mandates
  // `application/scim+json`. Okta and Azure AD both send it.
  return express.json({
    limit,
    type: ["application/json", "application/scim+json"],
  })(req, res, next);
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
