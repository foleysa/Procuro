/**
 * Tenant-scoped watched-issuers admin endpoints.
 *
 * Each row is a (org, source, identifier) tuple that names one company
 * the tenant wants the corporate-filing collectors (SEC EDGAR,
 * Companies House) to poll on their behalf. This replaces the
 * previously hard-coded `SEC_EDGAR_DEFAULT_ISSUERS` /
 * `COMPANIES_HOUSE_DEFAULT_NUMBERS` arrays — the collectors now read
 * the de-duplicated union of every tenant's watch list, so we only
 * spend the upstream rate budget on issuers somebody actually procures
 * from.
 *
 *   GET    /watched-issuers              — list this tenant's rows
 *   POST   /watched-issuers              — add one row
 *   DELETE /watched-issuers/:id          — remove one row (must belong
 *                                          to the active tenant)
 *
 * Uniqueness is `(orgId, source, identifier)`; re-posting the same
 * identifier returns 409. We do NOT require platform-admin here —
 * curating your own poll list is a normal tenant operation, the same
 * shape as managing your supplier master.
 */
import { Router, type IRouter } from "express";
import {
  db,
  watchedIssuersTable,
  watchedIssuerSourceValues,
  suppliersTable,
  type WatchedIssuerSource,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { newId } from "../lib/ids";
import {
  padCik,
  type SecIssuerRef,
} from "../lib/intelligence/collectors/sec-edgar";
import { normaliseCompaniesHouseNumber } from "../lib/intelligence/collectors/companies-house";

const router: IRouter = Router();

const SourceSchema = z.enum(watchedIssuerSourceValues);

const AddWatchedIssuerSchema = z.object({
  source: SourceSchema,
  /**
   * Source-native identifier. We normalise on the way in:
   *   - sec_edgar:        zero-padded to 10 digits (CIK)
   *   - companies_house:  zero-padded to 8 digits (numeric only) or
   *                       upper-cased (Scottish/NI prefixed numbers)
   */
  identifier: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  lei: z.string().min(1).max(40).optional(),
  ticker: z.string().min(1).max(20).optional(),
  supplierUid: z.string().min(1).max(80).optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * Return the canonical identifier for this source.  Centralised so the
 * uniqueness index can't be tricked by "320193" vs "0000320193".
 */
function normaliseIdentifier(
  source: WatchedIssuerSource,
  identifier: string,
): string {
  if (source === "sec_edgar") return padCik(identifier);
  return normaliseCompaniesHouseNumber(identifier);
}

/**
 * Source-specific shape check applied AFTER normalisation.  This stops
 * obviously broken inputs (a non-numeric "CIK", a UK company number with
 * the wrong length) from making it into the registry where they'd just
 * generate failed upstream fetches every collector tick.  Returns an
 * error message string on failure, or null if the identifier looks
 * plausible for the source.
 */
function validateIdentifierShape(
  source: WatchedIssuerSource,
  identifier: string,
): string | null {
  if (source === "sec_edgar") {
    // padCik() always returns 10 chars, but a non-numeric input pads to
    // "0000000000" which represents CIK 0 — EDGAR has no such filer.
    if (!/^\d{10}$/.test(identifier)) {
      return "SEC EDGAR identifier (CIK) must be numeric";
    }
    if (identifier === "0000000000") {
      return "SEC EDGAR identifier (CIK) must be non-zero";
    }
    return null;
  }
  // companies_house: 8 chars, either all-digit or a 2-letter prefix
  // (SC, NI, OC, SO, NC, NL, R0, AC, etc. — keep the check structural
  // rather than enumerating every Companies House prefix) followed by
  // 6 digits.  The normaliser already upper-cased the prefix.
  if (!/^([A-Z]{2}\d{6}|\d{8})$/.test(identifier)) {
    return "Companies House number must be 8 digits or a 2-letter prefix followed by 6 digits";
  }
  return null;
}

/**
 * Postgres unique-violation SQLSTATE.  drizzle-orm propagates the raw
 * pg error, so we can detect a race-lost INSERT (two requests for the
 * same identifier hitting the unique index simultaneously) and turn it
 * into the same 409 the pre-check returns.
 */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

router.get("/watched-issuers", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const sourceParam = req.query["source"];
  const where = [eq(watchedIssuersTable.orgId, orgId)];
  if (typeof sourceParam === "string") {
    const parsed = SourceSchema.safeParse(sourceParam);
    if (!parsed.success) {
      res.status(400).json({
        error: `source must be one of ${watchedIssuerSourceValues.join(", ")}`,
      });
      return;
    }
    where.push(eq(watchedIssuersTable.source, parsed.data));
  }
  const rows = await db
    .select()
    .from(watchedIssuersTable)
    .where(and(...where))
    .orderBy(asc(watchedIssuersTable.source), asc(watchedIssuersTable.name));
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      source: r.source,
      identifier: r.identifier,
      name: r.name,
      lei: r.lei,
      ticker: r.ticker,
      supplierUid: r.supplierUid,
      notes: r.notes,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
    })),
  });
});

router.post("/watched-issuers", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const data = AddWatchedIssuerSchema.parse(req.body);
  const identifier = normaliseIdentifier(data.source, data.identifier);
  if (!identifier) {
    res.status(400).json({ error: "identifier resolved to empty after normalisation" });
    return;
  }
  const shapeError = validateIdentifierShape(data.source, identifier);
  if (shapeError) {
    res.status(400).json({ error: shapeError });
    return;
  }

  // Validate supplierUid (if provided) belongs to this tenant — otherwise
  // we'd let one tenant attach an issuer to another tenant's supplier.
  if (data.supplierUid) {
    const [supplier] = await db
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.id, data.supplierUid),
          eq(suppliersTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!supplier) {
      res.status(400).json({ error: "supplierUid does not belong to the active tenant" });
      return;
    }
  }

  const [existing] = await db
    .select({ id: watchedIssuersTable.id })
    .from(watchedIssuersTable)
    .where(
      and(
        eq(watchedIssuersTable.orgId, orgId),
        eq(watchedIssuersTable.source, data.source),
        eq(watchedIssuersTable.identifier, identifier),
      ),
    )
    .limit(1);
  if (existing) {
    res.status(409).json({
      error: "Issuer already on this tenant's watch list",
      id: existing.id,
    });
    return;
  }

  const id = newId("wi");
  let row: typeof watchedIssuersTable.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(watchedIssuersTable)
      .values({
        id,
        orgId,
        source: data.source,
        identifier,
        name: data.name,
        lei: data.lei ?? null,
        ticker: data.ticker ?? null,
        supplierUid: data.supplierUid ?? null,
        notes: data.notes ?? null,
        createdBy: req.actorEmail ?? null,
      })
      .returning();
  } catch (err) {
    // Race-safe duplicate handling: the pre-check SELECT can be raced
    // by a concurrent INSERT, in which case the unique index on
    // (orgId, source, identifier) catches it.  Map that to the same
    // 409 the pre-check returns instead of leaking a 500.
    if (isUniqueViolation(err)) {
      const [conflict] = await db
        .select({ id: watchedIssuersTable.id })
        .from(watchedIssuersTable)
        .where(
          and(
            eq(watchedIssuersTable.orgId, orgId),
            eq(watchedIssuersTable.source, data.source),
            eq(watchedIssuersTable.identifier, identifier),
          ),
        )
        .limit(1);
      res.status(409).json({
        error: "Issuer already on this tenant's watch list",
        ...(conflict ? { id: conflict.id } : {}),
      });
      return;
    }
    throw err;
  }
  res.status(201).json({
    id: row!.id,
    source: row!.source,
    identifier: row!.identifier,
    name: row!.name,
    lei: row!.lei,
    ticker: row!.ticker,
    supplierUid: row!.supplierUid,
    notes: row!.notes,
    createdAt: row!.createdAt,
    createdBy: row!.createdBy,
  });
});

router.delete("/watched-issuers/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const result = await db
    .delete(watchedIssuersTable)
    .where(
      and(
        eq(watchedIssuersTable.id, id),
        // Tenant scoping is enforced in the WHERE: a tenant can never
        // delete another tenant's row even by guessing the id.
        eq(watchedIssuersTable.orgId, orgId),
      ),
    )
    .returning({ id: watchedIssuersTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Watched issuer not found" });
    return;
  }
  res.status(204).end();
});

/**
 * Convenience helper for tests / future internal callers — turn one
 * row into the `SecIssuerRef` shape the SEC collector consumes. Kept
 * here so the shape only has one canonical mapping.
 */
export function watchedRowToSecIssuer(row: {
  identifier: string;
  name: string;
  lei: string | null;
  ticker: string | null;
}): SecIssuerRef {
  return {
    cik: row.identifier,
    name: row.name,
    ...(row.lei ? { lei: row.lei } : {}),
    ...(row.ticker ? { ticker: row.ticker } : {}),
  };
}

export default router;
