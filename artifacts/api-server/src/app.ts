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
const SKIP_BODY = "/api/ingest/csv-stream/";
app.use((req, res, next) => {
  if (req.path.startsWith(SKIP_BODY)) return next();
  return express.json({ limit: "100mb" })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith(SKIP_BODY)) return next();
  return express.urlencoded({ extended: true, limit: "100mb" })(req, res, next);
});

app.use("/api", router);

export default app;
