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
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { newId } from "../lib/ids";
import {
  padCik,
  type SecIssuerRef,
} from "../lib/intelligence/collectors/sec-edgar";
import { normaliseCompaniesHouseNumber } from "../lib/intelligence/collectors/companies-house";
import {
  suggestForTenant,
  defaultReferenceLookups,
  type ReferenceLookups,
  type SuggesterSupplierInput,
} from "../lib/intelligence/suggest-watched-issuers";

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
 * Bulk-import payload. Same shape as the single-row request but with
 * an optional `line` so the server can echo the source CSV line number
 * back in per-row error reports.
 */
const BulkAddRowSchema = AddWatchedIssuerSchema.extend({
  line: z.number().int().min(1).optional(),
});

const BulkAddRequestSchema = z.object({
  // Cap matches the OpenAPI `maxItems`; keeps any single bulk POST
  // bounded so a tenant can't blow the express body limit or the
  // single-statement supplier-lookup query.
  items: z.array(BulkAddRowSchema).min(1).max(1000),
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

/**
 * POST /watched-issuers/bulk
 *
 * Per-row bulk import.  Each row is normalised + shape-checked with the
 * same helpers POST /watched-issuers uses, so the rules can never drift
 * out of sync between the single-row and bulk paths.  Rows are attempted
 * independently and the response always includes a per-row outcome
 * (`created` / `skipped` / `error`) keyed by the caller-supplied `line`
 * so the UI can render "Row 7: …" style feedback.
 *
 * We deliberately return 200 even when every row failed — the request
 * itself was well-formed, the body was well-typed, and the per-row
 * report is the actual deliverable.  Only top-level shape problems
 * (Zod parse, missing items array) bubble up as 400.
 */
router.post("/watched-issuers/bulk", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const parsed = BulkAddRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid bulk request", details: parsed.error.issues });
    return;
  }
  const items = parsed.data.items;

  // Pre-load valid supplierUids for this tenant in a single query so we
  // don't issue one supplier lookup per row.  Bulk imports of 50+ rows
  // would otherwise serialise into 50+ round trips just for ownership
  // checks.
  const requestedSupplierUids = Array.from(
    new Set(
      items
        .map((r) => r.supplierUid)
        .filter((s): s is string => typeof s === "string" && s.length > 0),
    ),
  );
  const validSupplierUids = new Set<string>();
  if (requestedSupplierUids.length > 0) {
    const supplierRows = await db
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.orgId, orgId),
          inArray(suppliersTable.id, requestedSupplierUids),
        ),
      );
    for (const s of supplierRows) validSupplierUids.add(s.id);
  }

  // Pre-load existing (source, identifier) pairs once so duplicate
  // detection is O(1) per row instead of one SELECT per row.  We still
  // catch the unique-violation race below so a concurrent bulk import
  // can't slip a duplicate past us.
  const existingRows = await db
    .select({
      source: watchedIssuersTable.source,
      identifier: watchedIssuersTable.identifier,
    })
    .from(watchedIssuersTable)
    .where(eq(watchedIssuersTable.orgId, orgId));
  const existing = new Set(
    existingRows.map((r) => `${r.source}:${r.identifier}`),
  );

  type ResultStatus = "created" | "skipped" | "error";
  type ResultItem = {
    line: number;
    status: ResultStatus;
    id?: string | null;
    source?: WatchedIssuerSource | null;
    identifier?: string | null;
    name?: string | null;
    error?: string | null;
  };

  const results: ResultItem[] = [];
  let createdCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Process rows sequentially so the in-memory `existing` set picks up
  // newly-created rows within the same batch (e.g. user pastes the same
  // identifier twice in one CSV — first wins, second skipped).
  for (let i = 0; i < items.length; i += 1) {
    const row = items[i]!;
    const line = row.line ?? i + 1;
    const baseResult: ResultItem = {
      line,
      status: "error",
      source: row.source,
      name: row.name,
    };

    const identifier = normaliseIdentifier(row.source, row.identifier);
    if (!identifier) {
      errorCount += 1;
      results.push({
        ...baseResult,
        error: "identifier resolved to empty after normalisation",
      });
      continue;
    }
    const shapeError = validateIdentifierShape(row.source, identifier);
    if (shapeError) {
      errorCount += 1;
      results.push({ ...baseResult, identifier, error: shapeError });
      continue;
    }

    if (row.supplierUid && !validSupplierUids.has(row.supplierUid)) {
      errorCount += 1;
      results.push({
        ...baseResult,
        identifier,
        error: "supplierUid does not belong to the active tenant",
      });
      continue;
    }

    const key = `${row.source}:${identifier}`;
    if (existing.has(key)) {
      skippedCount += 1;
      results.push({
        ...baseResult,
        status: "skipped",
        identifier,
        error: "Already on this tenant's watch list",
      });
      continue;
    }

    const id = newId("wi");
    try {
      const [inserted] = await db
        .insert(watchedIssuersTable)
        .values({
          id,
          orgId,
          source: row.source,
          identifier,
          name: row.name,
          lei: row.lei ?? null,
          ticker: row.ticker ?? null,
          supplierUid: row.supplierUid ?? null,
          notes: row.notes ?? null,
          createdBy: req.actorEmail ?? null,
        })
        .returning({ id: watchedIssuersTable.id });
      existing.add(key);
      createdCount += 1;
      results.push({
        ...baseResult,
        status: "created",
        id: inserted!.id,
        identifier,
      });
    } catch (err) {
      // A concurrent insert (or a duplicate key snuck past the in-memory
      // `existing` set because of an in-flight transaction elsewhere)
      // shows up as the unique-index violation. Treat it like a skip
      // rather than a fatal error so the rest of the batch continues.
      if (isUniqueViolation(err)) {
        skippedCount += 1;
        results.push({
          ...baseResult,
          status: "skipped",
          identifier,
          error: "Already on this tenant's watch list",
        });
        continue;
      }
      throw err;
    }
  }

  res.json({
    totalRows: items.length,
    createdCount,
    skippedCount,
    errorCount,
    results,
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

// Test seam: live HTTP by default; tests swap in canned responses.
let activeSuggestLookups: ReferenceLookups = defaultReferenceLookups;
export function setSuggestLookupsForTests(lookups: ReferenceLookups): void {
  activeSuggestLookups = lookups;
}
export function resetSuggestLookupsForTests(): void {
  activeSuggestLookups = defaultReferenceLookups;
}

/**
 * GET /watched-issuers/suggestions
 *
 * Returns ranked SEC CIK / Companies House suggestions for the active
 * tenant's suppliers. Computes live, never writes. Confirm via
 * POST /watched-issuers with `supplierUid`.
 *
 * Query params:
 *   - `supplierId` (optional, repeatable) — narrow to specific suppliers.
 *   - `limit` (optional, default 50, max 200) — supplier count cap.
 *
 * Suppliers already linked from watched_issuers are skipped, and
 * suggestions whose (source, identifier) is already on the tenant's
 * watch list are filtered out so the UI never shows a confirm that
 * would 409.
 */
router.get("/watched-issuers/suggestions", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const limitRaw = req.query["limit"];
  const limit = (() => {
    if (typeof limitRaw !== "string") return 50;
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n <= 0) return 50;
    return Math.min(n, 200);
  })();

  const supplierIdParam = req.query["supplierId"];
  const supplierIds: string[] | null = (() => {
    if (typeof supplierIdParam === "string") return [supplierIdParam];
    if (Array.isArray(supplierIdParam)) {
      return supplierIdParam.filter((x): x is string => typeof x === "string");
    }
    return null;
  })();

  // Cap supplier set so this endpoint stays within the engine's
  // per-call budget (concurrency cap × per-supplier upstream calls).
  const supplierWhere = [eq(suppliersTable.orgId, orgId)];
  if (supplierIds && supplierIds.length > 0) {
    supplierWhere.push(inArray(suppliersTable.id, supplierIds));
  }
  const supplierRows = await db
    .select({
      id: suppliersTable.id,
      name: suppliersTable.name,
      countryCode: suppliersTable.countryCode,
    })
    .from(suppliersTable)
    .where(and(...supplierWhere))
    .orderBy(asc(suppliersTable.name))
    .limit(limit);

  if (supplierRows.length === 0) {
    res.json({
      items: [],
      suppliersConsidered: 0,
      suppliersSkippedAlreadyWatched: 0,
    });
    return;
  }

  // Single batched read so the engine can dedupe in memory.
  const watchedRows = await db
    .select({
      source: watchedIssuersTable.source,
      identifier: watchedIssuersTable.identifier,
      supplierUid: watchedIssuersTable.supplierUid,
    })
    .from(watchedIssuersTable)
    .where(eq(watchedIssuersTable.orgId, orgId));
  const bySupplierUid = new Set<string>();
  const bySourceIdentifier = new Set<string>();
  for (const r of watchedRows) {
    if (r.supplierUid) bySupplierUid.add(r.supplierUid);
    bySourceIdentifier.add(`${r.source}:${r.identifier}`);
  }

  const suppliers: SuggesterSupplierInput[] = supplierRows.map((s) => ({
    id: s.id,
    name: s.name,
    countryCode: s.countryCode,
  }));

  const result = await suggestForTenant({
    suppliers,
    alreadyWatched: { bySupplierUid, bySourceIdentifier },
    lookups: activeSuggestLookups,
    ...(process.env["COMPANIES_HOUSE_API_KEY"]
      ? { companiesHouseApiKey: process.env["COMPANIES_HOUSE_API_KEY"] }
      : {}),
  });

  res.json({
    items: result.suggestions,
    suppliersConsidered: result.suppliersConsidered,
    suppliersSkippedAlreadyWatched: result.suppliersSkippedAlreadyWatched,
  });
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
