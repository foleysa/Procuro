import { Router, type IRouter } from "express";
import { db, orgsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { GetMeResponse } from "@workspace/api-zod";
import { readDisclosurePolicy } from "../lib/disclosure-policy";

const router: IRouter = Router();

router.get("/me", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const [org] = await db.select().from(orgsTable).where(eq(orgsTable.id, orgId));
  if (!org) {
    res.status(404).json({ error: "Org not found" });
    return;
  }
  const data = GetMeResponse.parse({
    org: {
      id: org.id,
      slug: org.slug,
      name: org.name,
      successFeePct: Number(org.successFeePct),
      disclosurePolicy: readDisclosurePolicy(org.settings),
      createdAt: org.createdAt,
    },
    actorEmail: req.actorEmail ?? "system@procuro.ai",
  });
  res.json(data);
});

export default router;
