/**
 * Engine Health endpoint (task #296).
 *
 * Per-tenant read-only rollup of the same telemetry the Command Center
 * dashboard's `SystemHealthStrip` previously computed client-side.
 * The strip used to fire and dedupe an `engine_stalled` alert directly
 * from React on every mount, which raced across browser tabs and could
 * queue concurrent inserts before dedupe took effect. The alert is now
 * fired from the `synthesize_operational_alerts` scheduled job; this
 * endpoint exists so the client can read the canonical engine-health
 * status without writing to the alerts table.
 */
import { Router, type IRouter, type Request } from "express";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { computeEngineHealthForOrg } from "../lib/alerts/engine-health";

const router: IRouter = Router();

router.get(
  "/engine-health",
  tenantMiddleware,
  async (req: Request, res) => {
    const orgId = requireOrgId(req);
    const health = await computeEngineHealthForOrg(orgId);
    res.json(health);
  },
);

export default router;
