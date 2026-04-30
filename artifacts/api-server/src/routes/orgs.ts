import { Router, type IRouter } from "express";
import { db, orgsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import {
  extractBearerToken,
  resolveOrgFromToken,
  isProduction,
} from "../lib/auth";

const router: IRouter = Router();

/**
 * Returns the orgs the caller is authorized to see.
 *
 * - Bearer token → returns just the bound org.
 * - Dev mode (no production, no bearer) → returns all seeded orgs so the
 *   command-center org switcher works locally.
 * - Production with no bearer → 401.
 */
router.get("/orgs", async (req, res) => {
  const bearer = extractBearerToken(req);

  if (bearer) {
    const orgId = await resolveOrgFromToken(bearer);
    if (!orgId) {
      res.status(401).json({ error: "Invalid API token" });
      return;
    }
    const [row] = await db
      .select({
        id: orgsTable.id,
        name: orgsTable.name,
        slug: orgsTable.slug,
        successFeePct: orgsTable.successFeePct,
        createdAt: orgsTable.createdAt,
      })
      .from(orgsTable)
      .where(eq(orgsTable.id, orgId));
    res.json(row ? [{ ...row, successFeePct: Number(row.successFeePct) }] : []);
    return;
  }

  const devHeaderAllowed =
    !isProduction() && process.env["ALLOW_DEV_TENANT_HEADER"] !== "false";
  if (!devHeaderAllowed) {
    res.status(401).json({ error: "Bearer token required" });
    return;
  }

  const rows = await db
    .select({
      id: orgsTable.id,
      name: orgsTable.name,
      slug: orgsTable.slug,
      successFeePct: orgsTable.successFeePct,
      createdAt: orgsTable.createdAt,
    })
    .from(orgsTable)
    .orderBy(asc(orgsTable.name));

  res.json(
    rows.map((r) => ({
      ...r,
      successFeePct: Number(r.successFeePct),
    })),
  );
});

export default router;
