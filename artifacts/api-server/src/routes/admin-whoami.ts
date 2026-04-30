/**
 * `GET /api/admin/whoami` — return the resolved RBAC context for the
 * current request. Used by the command-center web UI to decide whether
 * to render the /admin sidebar entry without round-tripping a 403.
 *
 * Intentionally NOT in the OpenAPI spec: admin surface stays private
 * and the contract is small enough to consume via a hand-rolled
 * fetch wrapper in `lib/admin-client.ts`.
 */
import { Router, type IRouter } from "express";
import { tenantMiddleware } from "../lib/tenant";
import { resolveRbacContext } from "../lib/rbac";

const router: IRouter = Router();

router.get("/admin/whoami", tenantMiddleware, async (req, res) => {
  const ctx = await resolveRbacContext(req);
  res.json({
    orgId: req.orgId,
    email: ctx.email,
    roles: ctx.roles,
    viaApiKey: ctx.viaApiKey,
    authMode: req.authMode,
  });
});

export default router;
