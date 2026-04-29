import { Router, type IRouter } from "express";
import { db, orgsTable } from "@workspace/db";
import { asc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/orgs", async (_req, res) => {
  const rows = await db
    .select({
      id: orgsTable.id,
      name: orgsTable.name,
      slug: orgsTable.slug,
    })
    .from(orgsTable)
    .orderBy(asc(orgsTable.name));

  res.json(rows);
});

export default router;
