import { Router, type IRouter } from "express";
import { db, orgsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import {
  extractBearerToken,
  resolveOrgFromToken,
  isProduction,
} from "../lib/auth";
import { UnauthorizedError } from "../lib/api-errors";
import { readDisclosurePolicy } from "../lib/disclosure-policy";

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
      throw new UnauthorizedError("Invalid API token");
    }
    const [row] = await db
      .select({
        id: orgsTable.id,
        name: orgsTable.name,
        slug: orgsTable.slug,
        successFeePct: orgsTable.successFeePct,
        settings: orgsTable.settings,
        createdAt: orgsTable.createdAt,
      })
      .from(orgsTable)
      .where(eq(orgsTable.id, orgId));
    res.json(row ? [serializeOrg(row)] : []);
    return;
  }

  const devHeaderAllowed =
    !isProduction() && process.env["ALLOW_DEV_TENANT_HEADER"] !== "false";
  if (!devHeaderAllowed) {
    throw new UnauthorizedError("Bearer token required");
  }

  const rows = await db
    .select({
      id: orgsTable.id,
      name: orgsTable.name,
      slug: orgsTable.slug,
      successFeePct: orgsTable.successFeePct,
      settings: orgsTable.settings,
      createdAt: orgsTable.createdAt,
    })
    .from(orgsTable)
    .orderBy(asc(orgsTable.name));

  res.json(rows.map(serializeOrg));
});

/**
 * Serialise an org row into the wire shape declared in
 * `lib/api-spec/openapi.yaml` (`Org`). The `disclosurePolicy` is not a
 * dedicated column — it lives inside `orgs.settings` JSONB and is
 * resolved through the same default-applying helper that `/me` uses,
 * so every consumer of `Org` sees a consistent value.
 */
function serializeOrg(row: {
  id: string;
  name: string;
  slug: string;
  successFeePct: string | number;
  settings: unknown;
  createdAt: Date;
}) {
  const settings = (row.settings ?? null) as
    | Record<string, unknown>
    | null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    successFeePct: Number(row.successFeePct),
    disclosurePolicy: readDisclosurePolicy(settings),
    createdAt: row.createdAt,
  };
}

export default router;
