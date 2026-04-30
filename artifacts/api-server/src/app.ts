import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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

export default app;
