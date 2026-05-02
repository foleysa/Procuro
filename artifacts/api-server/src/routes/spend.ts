import { Router, type IRouter } from "express";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import {
  getSpendOverview,
  getSpendByBand,
  type SpendSegment,
} from "../lib/spend";

const router: IRouter = Router();

function parseSegment(raw: unknown): SpendSegment {
  if (raw === "goods" || raw === "services" || raw === "all") return raw;
  return "all";
}

router.get("/spend/overview", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const segment = parseSegment(req.query.segment);
  const data = await getSpendOverview(orgId, segment);
  res.json(data);
});

router.get("/spend/by-band", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const data = await getSpendByBand(orgId);
  res.json(data);
});

export default router;
