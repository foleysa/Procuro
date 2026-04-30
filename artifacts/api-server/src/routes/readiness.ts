import { Router, type IRouter } from "express";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { computeReadiness } from "../lib/readiness";

const router: IRouter = Router();

/**
 * `GET /api/readiness` — runs the data-readiness rules engine for the
 * active tenant. Public to any authenticated reader (the FE always
 * shows this on the dashboard, regardless of whether the actor has
 * mutate permissions). Defense in depth: the underlying queries are
 * already tenant-scoped via `requireOrgId`.
 */
router.get("/readiness", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const basePath = req.header("x-base-path") ?? "/";
  const result = await computeReadiness({ orgId, basePath });
  res.json(result);
});

export default router;
