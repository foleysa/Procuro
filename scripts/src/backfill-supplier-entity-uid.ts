/**
 * Backfill `suppliers.entity_uid` (and the matching `entity_match_type`
 * + `entity_resolved_at` audit columns) by calling the Foundation
 * entity resolver once per supplier.
 *
 * Why: the supplier-intelligence read path
 * (`GET /suppliers/:id/intelligence`) used to call `resolveEntity`
 * inline on every request AND fall back to a `scope_supplier_name`
 * ilike match — a silent miss whenever a Phase-2 collector wrote the
 * same entity under a name variant ("Foxconn" vs "Hon Hai Precision
 * Industry Co Ltd"). With the canonical `entity_uid` persisted on
 * each supplier the route can join on `metadata.entityUid` only and
 * drop the name-fallback per supplier — no more silent misses, and
 * one fewer per-request `resolveEntity` call.
 *
 * Run with:
 *   `pnpm --filter @workspace/scripts run backfill-supplier-entity-uid`
 *
 * Idempotent. Each run:
 *   - skips suppliers that already have an `entity_uid` (re-resolution
 *     is a separate concern — the operator can clear the column with
 *     a SQL `UPDATE … SET entity_uid = NULL WHERE …` to force one).
 *   - calls `resolveEntity` per supplier with whichever optional
 *     identifiers (LEI / CIK / Companies House) are stored on the row,
 *     plus the display name + country for the deterministic-name and
 *     fuzzy fallbacks inside the resolver.
 *   - writes `entity_uid`, `entity_match_type`, `entity_resolved_at`
 *     atomically per supplier so a crash mid-batch leaves a coherent
 *     subset resolved rather than half-written rows.
 *   - bounds concurrency so a large tenant doesn't fan out into
 *     thousands of simultaneous BQ + Postgres-cache writes.
 *
 * Coverage is exposed at `GET /system/entity-resolution/coverage` and
 * surfaced on the System page so operators can monitor the rollout.
 */

import {
  db,
  pool,
  suppliersTable,
} from "@workspace/db";
import {
  resolveEntity,
  type Identifiers,
  type MatchType,
} from "@workspace/intelligence";
import { and, eq, isNull } from "drizzle-orm";

const CONCURRENCY = Number.parseInt(
  process.env["BACKFILL_CONCURRENCY"] ?? "8",
  10,
);
const LIMIT = process.env["BACKFILL_LIMIT"]
  ? Number.parseInt(process.env["BACKFILL_LIMIT"], 10)
  : null;

interface BackfillStats {
  scanned: number;
  resolved: number;
  unresolved: number;
  errored: number;
  byMatchType: Record<MatchType, number>;
}

function emptyStats(): BackfillStats {
  return {
    scanned: 0,
    resolved: 0,
    unresolved: 0,
    errored: 0,
    byMatchType: {
      identifier: 0,
      deterministic_name: 0,
      fuzzy_gemini: 0,
      unresolved: 0,
    },
  };
}

function buildIdentifiers(row: {
  lei: string | null;
  cik: string | null;
  companiesHouseNumber: string | null;
}): Identifiers | undefined {
  const ids: Identifiers = {};
  if (row.lei && row.lei.trim() !== "") ids.lei = row.lei;
  if (row.cik && row.cik.trim() !== "") ids.cik = row.cik;
  if (row.companiesHouseNumber && row.companiesHouseNumber.trim() !== "") {
    ids.companies_house = row.companiesHouseNumber;
  }
  return Object.keys(ids).length > 0 ? ids : undefined;
}

async function resolveOne(
  row: {
    id: string;
    name: string;
    countryCode: string | null;
    lei: string | null;
    cik: string | null;
    companiesHouseNumber: string | null;
  },
  stats: BackfillStats,
): Promise<void> {
  const identifiers = buildIdentifiers(row);
  let entityUid: string | null = null;
  let matchType: MatchType = "unresolved";
  try {
    const r = await resolveEntity({
      name: row.name,
      ...(row.countryCode ? { country: row.countryCode } : {}),
      ...(identifiers ? { identifiers } : {}),
    });
    entityUid = r.entity_uid;
    matchType = r.match_type;
  } catch (err) {
    stats.errored += 1;
    // eslint-disable-next-line no-console
    console.warn(
      `[backfill-supplier-entity-uid] resolveEntity failed for supplier=${row.id}: ${(err as Error).message}`,
    );
    return;
  }

  // Stamp `entity_resolved_at` regardless of outcome so a future run
  // can opt to re-try only suppliers that have NEVER been attempted
  // (vs ones we tried and got `unresolved` for). The current run
  // simply scopes on `entity_uid IS NULL`, but recording the attempt
  // is cheap and gives us a knob later.
  await db
    .update(suppliersTable)
    .set({
      entityUid,
      entityMatchType: matchType,
      entityResolvedAt: new Date(),
    })
    .where(
      and(
        eq(suppliersTable.id, row.id),
        // Belt-and-braces: don't clobber a row another writer
        // populated between the SELECT and this UPDATE.
        isNull(suppliersTable.entityUid),
      ),
    );

  stats.byMatchType[matchType] += 1;
  if (entityUid !== null) {
    stats.resolved += 1;
  } else {
    stats.unresolved += 1;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i] as T);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const stats = emptyStats();

  // Stream a single SELECT of all candidate suppliers up front. The
  // suppliers table is small (low six-figures even on the largest
  // tenant in scope), so a single in-memory page is simpler than
  // keysetting through and avoids the visibility-during-update issue
  // the per-row UPDATE would create with a paginated SELECT.
  const baseQuery = db
    .select({
      id: suppliersTable.id,
      name: suppliersTable.name,
      countryCode: suppliersTable.countryCode,
      lei: suppliersTable.lei,
      cik: suppliersTable.cik,
      companiesHouseNumber: suppliersTable.companiesHouseNumber,
    })
    .from(suppliersTable)
    .where(isNull(suppliersTable.entityUid));

  const candidates = LIMIT !== null ? await baseQuery.limit(LIMIT) : await baseQuery;
  stats.scanned = candidates.length;

  // eslint-disable-next-line no-console
  console.log(
    `[backfill-supplier-entity-uid] resolving ${stats.scanned} suppliers (concurrency=${CONCURRENCY})`,
  );

  await runWithConcurrency(candidates, CONCURRENCY, (row) =>
    resolveOne(row, stats),
  );

  const elapsedMs = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(
    `[backfill-supplier-entity-uid] done in ${elapsedMs}ms — ${JSON.stringify(stats)}`,
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[backfill-supplier-entity-uid] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
