/**
 * `GET /api/admin/whoami` — return the resolved RBAC context for the
 * current request. Used by the command-center web UI to decide whether
 * to render the /admin sidebar entry without round-tripping a 403.
 *
 * Documented under the `admin` tag in `lib/api-spec/openapi.yaml`;
 * the command-center consumes it via the orval-generated
 * `useGetAdminWhoami` hook from `@workspace/api-client-react`.
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
