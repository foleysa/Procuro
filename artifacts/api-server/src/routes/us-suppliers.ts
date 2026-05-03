/**
 * Tenant-scoped watched-US-supplier admin endpoints.
 *
 * Drives the EPA ECHO and DOL OSHA collectors. Both only meaningfully
 * cover US-regulated facilities, so the watch list is the subset of
 * the tenant's `suppliers` rows whose `countryCode` is `US`/`USA`.
 *
 *   GET    /us-suppliers           — list this tenant's US suppliers
 *   POST   /us-suppliers           — add one US supplier
 *   DELETE /us-suppliers/:id       — remove one US supplier
 *
 * Uniqueness is `(orgId, normalizedName)` — re-posting the same name
 * for the active tenant returns 409. Rows added here are stamped
 * `sourceSystem = 'admin'` and `countryCode = 'US'` so the collectors
 * pick them up on the next scheduled tick.
 */
import { Router, type IRouter } from "express";
import { db, suppliersTable } from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { newId } from "../lib/ids";
import {
  US_SUPPLIER_SEED_SOURCE,
  normalizeUsSupplierName,
} from "../lib/intelligence/collectors/us-suppliers-seed";

const router: IRouter = Router();

const US_COUNTRY_CODES = ["US", "USA"] as const;
/**
 * Sources this admin surface owns. Restricting list/delete to these
 * keeps `suppliers` rows that originated in CSV ingest, ERP sync, or
 * any other canonical lifecycle out of the watchlist UI — admins must
 * not be able to cascade-delete contracts/POs by clicking a trash icon
 * here.
 */
const WATCHLIST_SOURCES = ["admin", US_SUPPLIER_SEED_SOURCE] as const;

const AddUsSupplierSchema = z.object({
  name: z.string().min(1).max(200),
});

const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

router.get("/us-suppliers", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const rows = await db
    .select({
      id: suppliersTable.id,
      name: suppliersTable.name,
      normalizedName: suppliersTable.normalizedName,
      countryCode: suppliersTable.countryCode,
      sourceSystem: suppliersTable.sourceSystem,
      createdAt: suppliersTable.createdAt,
    })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.orgId, orgId),
        inArray(suppliersTable.countryCode, [...US_COUNTRY_CODES]),
        inArray(suppliersTable.sourceSystem, [...WATCHLIST_SOURCES]),
      ),
    )
    .orderBy(asc(suppliersTable.name));
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      normalizedName: r.normalizedName,
      countryCode: r.countryCode,
      sourceSystem: r.sourceSystem,
      createdAt: r.createdAt,
    })),
  });
});

router.post("/us-suppliers", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const data = AddUsSupplierSchema.parse(req.body);
  const name = data.name.trim();
  const normalizedName = normalizeUsSupplierName(name);
  if (!normalizedName) {
    res.status(400).json({ error: "name resolved to empty after normalisation" });
    return;
  }

  const [existing] = await db
    .select({ id: suppliersTable.id })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.orgId, orgId),
        eq(suppliersTable.normalizedName, normalizedName),
      ),
    )
    .limit(1);
  if (existing) {
    res.status(409).json({
      error: "Supplier with that name is already on this tenant's list",
      id: existing.id,
    });
    return;
  }

  const id = newId("sup");
  try {
    const [row] = await db
      .insert(suppliersTable)
      .values({
        id,
        orgId,
        name,
        normalizedName,
        countryCode: "US",
        sourceSystem: "admin",
        sourceExternalId: `admin_${id}`,
      })
      .returning({
        id: suppliersTable.id,
        name: suppliersTable.name,
        normalizedName: suppliersTable.normalizedName,
        countryCode: suppliersTable.countryCode,
        sourceSystem: suppliersTable.sourceSystem,
        createdAt: suppliersTable.createdAt,
      });
    res.status(201).json(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      res
        .status(409)
        .json({ error: "Supplier with that name is already on this tenant's list" });
      return;
    }
    throw err;
  }
});

router.delete("/us-suppliers/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const result = await db
    .delete(suppliersTable)
    .where(
      and(
        eq(suppliersTable.id, id),
        eq(suppliersTable.orgId, orgId),
        // Only US watchlist rows can be removed via this endpoint —
        // canonical supplier master rows (CSV ingest, ERP sync, etc.)
        // have their own lifecycle and may cascade to contracts/POs,
        // so they must NOT be deletable from a watchlist UI.
        inArray(suppliersTable.countryCode, [...US_COUNTRY_CODES]),
        inArray(suppliersTable.sourceSystem, [...WATCHLIST_SOURCES]),
      ),
    )
    .returning({ id: suppliersTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "US supplier not found" });
    return;
  }
  res.status(204).end();
});

export default router;
