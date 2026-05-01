import { db, synonymRegistryTable } from "@workspace/db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  normalizeCategoryString,
  type SynonymScope,
  type MappedVia,
} from "@workspace/db";

/**
 * Layer A resolution: lookup a tenant-supplied category string against
 * the synonym registry.
 *
 * Precedence (highest first):
 *   1. tenant-scoped synonym for `orgId`
 *   2. global synonym
 *
 * Only `seed` and `operator` rows are honored in v1; `auto` rows
 * (reserved for v2 ML/fuzzy matching) are ignored to keep matching
 * deterministic. Returns `null` if no synonym matches — callers should
 * then enqueue the string and fall back to the Fragmented band.
 *
 * Append-only contract: rows with `superseded_at IS NOT NULL` are
 * historical/audit-only and excluded from resolution. Re-mapping
 * (force_override) inserts a new row and stamps the prior row's
 * `superseded_at`, never UPDATEs the canonical_code in place.
 */
export async function resolveSynonym(
  orgId: string,
  tenantString: string,
): Promise<{
  canonicalCode: string;
  scope: SynonymScope;
  mappedVia: MappedVia;
} | null> {
  const normalized = normalizeCategoryString(tenantString);
  // Order by `createdAt DESC` as a defensive secondary tiebreaker:
  // the partial unique indexes guarantee at most one ACTIVE row per
  // (scope, [orgId,] normalized), but races during a force_override
  // could briefly leave two, and newest-active should win.
  const rows = await db
    .select({
      canonicalCode: synonymRegistryTable.canonicalCode,
      scope: synonymRegistryTable.scope,
      orgId: synonymRegistryTable.orgId,
    })
    .from(synonymRegistryTable)
    .where(
      and(
        eq(synonymRegistryTable.normalized, normalized),
        isNull(synonymRegistryTable.supersededAt),
        sql`${synonymRegistryTable.source} IN ('seed', 'operator')`,
        or(
          and(
            eq(synonymRegistryTable.scope, "tenant_scoped"),
            eq(synonymRegistryTable.orgId, orgId),
          ),
          and(
            eq(synonymRegistryTable.scope, "global"),
            isNull(synonymRegistryTable.orgId),
          ),
        ),
      ),
    )
    .orderBy(desc(synonymRegistryTable.createdAt));

  if (rows.length === 0) return null;

  // Tenant-scoped wins over global if both are present (and within a
  // scope, the most-recently-created row wins via the ORDER BY above).
  const tenantHit = rows.find((r) => r.scope === "tenant_scoped");
  const pick = tenantHit ?? rows[0]!;
  return {
    canonicalCode: pick.canonicalCode,
    scope: pick.scope,
    mappedVia:
      pick.scope === "tenant_scoped" ? "synonym_tenant_scoped" : "synonym_global",
  };
}
