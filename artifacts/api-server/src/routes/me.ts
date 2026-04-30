import { Router, type IRouter } from "express";
import { db, orgsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { GetMeResponse, PatchMeSettingsBody } from "@workspace/api-zod";
import { readDisclosurePolicy } from "../lib/disclosure-policy";

const router: IRouter = Router();

/**
 * Build the `MeResponse` wire shape from a fresh `orgs` row. Centralised
 * so `GET /me` and `PATCH /me/settings` can't drift on the disclosure
 * policy default or any other derived field.
 */
function serializeMe(
  org: typeof orgsTable.$inferSelect,
  actorEmail: string | undefined,
) {
  return GetMeResponse.parse({
    org: {
      id: org.id,
      slug: org.slug,
      name: org.name,
      successFeePct: Number(org.successFeePct),
      disclosurePolicy: readDisclosurePolicy(org.settings),
      createdAt: org.createdAt,
    },
    actorEmail: actorEmail ?? "system@procuro.ai",
  });
}

router.get("/me", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const [org] = await db.select().from(orgsTable).where(eq(orgsTable.id, orgId));
  if (!org) {
    res.status(404).json({ error: "Org not found" });
    return;
  }
  res.json(serializeMe(org, req.actorEmail));
});

/**
 * Update tenant-wide preferences stored in `orgs.settings` JSONB.
 *
 * The handler performs a *merge* on top of the existing settings object
 * so that other keys (e.g. FX-exposure thresholds) are preserved when an
 * admin only changes the disclosure policy. Validation is delegated to
 * the generated `PatchMeSettingsBody` Zod schema; the global error
 * handler turns any `ZodError` into the standard
 * `400 { error, details }` response without per-route wiring.
 */
router.patch("/me/settings", tenantMiddleware, requirePermission("settings:write"), async (req, res) => {
  const orgId = requireOrgId(req);
  const body = PatchMeSettingsBody.parse(req.body);

  const [current] = await db
    .select()
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId));
  if (!current) {
    res.status(404).json({ error: "Org not found" });
    return;
  }

  const nextSettings: Record<string, unknown> = {
    ...(current.settings ?? {}),
  };
  if (body.disclosurePolicy !== undefined) {
    nextSettings["disclosurePolicy"] = body.disclosurePolicy;
  }

  const [updated] = await db
    .update(orgsTable)
    .set({ settings: nextSettings })
    .where(eq(orgsTable.id, orgId))
    .returning();
  if (!updated) {
    // Row vanished between SELECT and UPDATE — extremely unlikely with
    // a single-org PK update, but surface a stable error rather than
    // returning a stale serialisation.
    res.status(404).json({ error: "Org not found" });
    return;
  }

  res.json(serializeMe(updated, req.actorEmail));
});

export default router;
