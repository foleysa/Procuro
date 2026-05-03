/**
 * Tenant-scoped Methods & Tools registry CRUD.
 *
 * Replaces the previously hard-coded list inside the dashboard's
 * `MethodsAndTools.tsx` (Task #291) so operators can add new entries,
 * update existing ones, and progress maturity ratings as their
 * procurement practice matures.
 *
 *   GET    /methods-and-tools         — list this tenant's rows
 *   POST   /methods-and-tools         — add one row
 *   PATCH  /methods-and-tools/:id     — partial update
 *   DELETE /methods-and-tools/:id     — remove one row
 *
 * Uniqueness is `(orgId, sourcingStrategy)`; a tenant cannot have two
 * rows for the same strategy label. On the GET path, an empty registry
 * is auto-seeded with a starter set so a fresh tenant's dashboard
 * never renders empty (mirrors the same pattern used by the
 * us-suppliers route).
 */
import { Router, type IRouter } from "express";
import {
  db,
  methodsAndToolsTable,
  methodsAndToolsMaturityValues,
  type MethodsAndToolsMaturity,
  type MethodsAndToolsRow,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { newId } from "../lib/ids";
import { InvalidRequestError, NotFoundError, ConflictError } from "../lib/api-errors";

const router: IRouter = Router();

const MaturitySchema = z.enum(methodsAndToolsMaturityValues);

const CreateSchema = z.object({
  sourcingStrategy: z.string().trim().min(1).max(200),
  method: z.string().trim().min(1).max(500),
  toolSystem: z.string().trim().min(1).max(500),
  maturity: MaturitySchema,
});

const UpdateSchema = z
  .object({
    sourcingStrategy: z.string().trim().min(1).max(200).optional(),
    method: z.string().trim().min(1).max(500).optional(),
    toolSystem: z.string().trim().min(1).max(500).optional(),
    maturity: MaturitySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(err: unknown): boolean {
  // drizzle wraps the underlying pg error in `_DrizzleQueryError`, so
  // walk the `cause` chain to find the pg-side `code`.
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i += 1) {
    if (
      typeof cur === "object" &&
      cur !== null &&
      "code" in cur &&
      (cur as { code?: unknown }).code === PG_UNIQUE_VIOLATION
    ) {
      return true;
    }
    cur =
      typeof cur === "object" && cur !== null && "cause" in cur
        ? (cur as { cause?: unknown }).cause
        : null;
  }
  return false;
}

function mapRow(r: MethodsAndToolsRow) {
  return {
    id: r.id,
    sourcingStrategy: r.sourcingStrategy,
    method: r.method,
    toolSystem: r.toolSystem,
    maturity: r.maturity,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Default registry, seeded on first read for tenants with zero rows.
 * Mirrors the original hard-coded list that lived in the dashboard
 * component so existing tenants see no visible change after migration.
 */
const SEED_ROWS: ReadonlyArray<{
  sourcingStrategy: string;
  method: string;
  toolSystem: string;
  maturity: MethodsAndToolsMaturity;
}> = [
  {
    sourcingStrategy: "Competitive RFP",
    method: "Multi-supplier bid process",
    toolSystem: "Sourcing platform / e-auction",
    maturity: "proven",
  },
  {
    sourcingStrategy: "Single-to-Dual Source",
    method: "Supply base risk mitigation",
    toolSystem: "Supplier qualification / Spend analytics",
    maturity: "proven",
  },
  {
    sourcingStrategy: "Should-Cost Challenge",
    method: "Bottom-up cost model vs. supplier quote",
    toolSystem: "Should-cost model / TCO tool",
    maturity: "emerging",
  },
  {
    sourcingStrategy: "Tiered Pricing Audit",
    method: "Rebate & volume-tier reconciliation",
    toolSystem: "Contract management / Invoice analytics",
    maturity: "proven",
  },
  {
    sourcingStrategy: "Invoice-to-Contract Reconciliation",
    method: "Automated PO/invoice/contract match",
    toolSystem: "AP automation / Contract analytics",
    maturity: "proven",
  },
  {
    sourcingStrategy: "Catalog Enforcement",
    method: "Maverick spend channel management",
    toolSystem: "P2P system / Guided buying",
    maturity: "proven",
  },
  {
    sourcingStrategy: "Negotiated Renewal",
    method: "Pre-expiry renegotiation playbook",
    toolSystem: "CLM / Renewal calendar",
    maturity: "emerging",
  },
];

async function seedDefaults(orgId: string): Promise<void> {
  // Race-safe: rely on the unique index `(orgId, sourcingStrategy)` to
  // ignore conflicts when two requests seed in parallel.
  const values = SEED_ROWS.map((r) => ({
    id: newId("mt"),
    orgId,
    sourcingStrategy: r.sourcingStrategy,
    method: r.method,
    toolSystem: r.toolSystem,
    maturity: r.maturity,
  }));
  try {
    await db.insert(methodsAndToolsTable).values(values).onConflictDoNothing();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

router.get("/methods-and-tools", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  let rows = await db
    .select()
    .from(methodsAndToolsTable)
    .where(eq(methodsAndToolsTable.orgId, orgId))
    .orderBy(asc(methodsAndToolsTable.createdAt));
  if (rows.length === 0) {
    await seedDefaults(orgId);
    rows = await db
      .select()
      .from(methodsAndToolsTable)
      .where(eq(methodsAndToolsTable.orgId, orgId))
      .orderBy(asc(methodsAndToolsTable.createdAt));
  }
  res.json({ items: rows.map(mapRow) });
});

router.post("/methods-and-tools", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new InvalidRequestError("Invalid payload", parsed.error.issues);
  }
  const data = parsed.data;
  try {
    const [row] = await db
      .insert(methodsAndToolsTable)
      .values({
        id: newId("mt"),
        orgId,
        sourcingStrategy: data.sourcingStrategy,
        method: data.method,
        toolSystem: data.toolSystem,
        maturity: data.maturity,
      })
      .returning();
    res.status(201).json(mapRow(row!));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("Sourcing strategy already exists for this tenant");
    }
    throw err;
  }
});

router.patch("/methods-and-tools/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new InvalidRequestError("Invalid payload", parsed.error.issues);
  }
  const patch: Partial<{
    sourcingStrategy: string;
    method: string;
    toolSystem: string;
    maturity: MethodsAndToolsMaturity;
  }> = {};
  if (parsed.data.sourcingStrategy !== undefined)
    patch.sourcingStrategy = parsed.data.sourcingStrategy;
  if (parsed.data.method !== undefined) patch.method = parsed.data.method;
  if (parsed.data.toolSystem !== undefined) patch.toolSystem = parsed.data.toolSystem;
  if (parsed.data.maturity !== undefined) patch.maturity = parsed.data.maturity;

  try {
    const [row] = await db
      .update(methodsAndToolsTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(methodsAndToolsTable.id, id),
          eq(methodsAndToolsTable.orgId, orgId),
        ),
      )
      .returning();
    if (!row) {
      throw new NotFoundError("Methods & Tools row not found");
    }
    res.json(mapRow(row));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("Sourcing strategy already exists for this tenant");
    }
    throw err;
  }
});

router.delete("/methods-and-tools/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const result = await db
    .delete(methodsAndToolsTable)
    .where(
      and(
        eq(methodsAndToolsTable.id, id),
        eq(methodsAndToolsTable.orgId, orgId),
      ),
    )
    .returning({ id: methodsAndToolsTable.id });
  if (result.length === 0) {
    throw new NotFoundError("Methods & Tools row not found");
  }
  res.status(204).end();
});

export default router;
