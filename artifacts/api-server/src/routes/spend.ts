import { Router, type IRouter } from "express";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { getSpendOverview } from "../lib/spend";

const router: IRouter = Router();

router.get("/spend/overview", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const data = await getSpendOverview(orgId);
  res.json(data);
});

export default router;
