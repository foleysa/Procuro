import {
  db,
  pool,
  unmappedCategoryQueueTable,
  synonymRegistryTable,
  normalizeCategoryString,
  type SynonymScope,
  type UnmappedCategoryQueueRow,
} from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { newId } from "../../ids";
import { logger } from "../../logger";

/**
 * Layer B / C / D: unmapped queue management.
 *
 * Layer B (`enqueueUnmapped`) is the autonomous fallback path — every
 * tenant string the resolver fails to match in Layer A is recorded
 * here so an operator (Layer C: `resolveQueueEntry`) can later
 * promote it into the synonym registry. Layer D (machine learning
 * suggestions) is a future addition — this module's contract supports
 * it via the existing `synonym_source = 'auto'` value reserved in the
 * schema.
 */

/**
 * Idempotently record a tenant string that failed Layer A resolution.
 *
 * If an open queue entry already exists for `(orgId, normalized)`, we
 * bump `lastSeenAt` and accumulate `spendTrailing90dUsd` instead of
 * inserting a new row. Resolved rows are not touched — when a
 * previously-resolved string re-appears, it gets queued anew so
 * operators see it surface again (this happens if the synonym
 * mapping is later revoked).
 */
export async function enqueueUnmapped(args: {
  orgId: string;
  tenantString: string;
  spendUsd?: number;
}): Promise<UnmappedCategoryQueueRow> {
  const normalized = normalizeCategoryString(args.tenantString);
  const spend = args.spendUsd ?? 0;
  const id = newId("uncq");

  const [row] = await db
    .insert(unmappedCategoryQueueTable)
    .values({
      id,
      orgId: args.orgId,
      tenantString: args.tenantString,
      normalized,
      spendTrailing90dUsd: spend.toFixed(2),
    })
    .onConflictDoUpdate({
      target: [
        unmappedCategoryQueueTable.orgId,
        unmappedCategoryQueueTable.normalized,
      ],
      // Match the partial unique index predicate so PG knows we're
      // upserting against the open-row index, not a non-existent
      // unconditional one.
      targetWhere: sql`${unmappedCategoryQueueTable.resolvedAt} IS NULL`,
      set: {
        lastSeenAt: sql`now()`,
        spendTrailing90dUsd: sql`${unmappedCategoryQueueTable.spendTrailing90dUsd} + ${spend.toFixed(2)}::numeric`,
      },
    })
    .returning();

  return row!;
}

/**
 * List open queue entries for an org, highest-spend first.
 */
export async function listOpenQueue(
  orgId: string,
  limit = 100,
): Promise<UnmappedCategoryQueueRow[]> {
  return db
    .select()
    .from(unmappedCategoryQueueTable)
    .where(
      and(
        eq(unmappedCategoryQueueTable.orgId, orgId),
        isNull(unmappedCategoryQueueTable.resolvedAt),
      ),
    )
    .orderBy(desc(unmappedCategoryQueueTable.spendTrailing90dUsd))
    .limit(limit);
}

export interface QueueSummary {
  /** Number of open (unresolved) queue entries. */
  openCount: number;
  /** ISO timestamp of the oldest still-open entry, or null. */
  oldestOpenAt: string | null;
  /** Sum of `spend_trailing_90d_usd` across open entries. */
  unmappedSpendUsd: number;
}

export async function summarizeQueue(orgId: string): Promise<QueueSummary> {
  const { rows } = await pool.query<{
    open_count: string;
    oldest_open_at: Date | null;
    unmapped_spend_usd: string | null;
  }>(
    `SELECT
       count(*)::text                              AS open_count,
       min(first_seen_at)                          AS oldest_open_at,
       coalesce(sum(spend_trailing_90d_usd), 0)::text AS unmapped_spend_usd
     FROM unmapped_category_queue
     WHERE org_id = $1
       AND resolved_at IS NULL`,
    [orgId],
  );
  const r = rows[0]!;
  return {
    openCount: Number(r.open_count),
    oldestOpenAt: r.oldest_open_at ? r.oldest_open_at.toISOString() : null,
    unmappedSpendUsd: Number(r.unmapped_spend_usd ?? 0),
  };
}

export interface ResolveCollision {
  kind: "collision";
  existing: {
    registryId: string;
    canonicalCode: string;
    scope: SynonymScope;
    orgId: string | null;
  };
}

export interface ResolveSuccess {
  kind: "ok";
  registryId: string;
  reCategorizedOpportunityCount: number;
  /** What the operator's resolution actually did when a collision was
   *  detected — `null` on the no-collision happy path. */
  collisionDecision: ResolveDecision | null;
}

export type ResolveResult = ResolveCollision | ResolveSuccess;

/**
 * Operator's choice when a collision is reported on a first attempt.
 *
 *  - `accept_existing`: the existing mapping is correct; close the
 *    queue entry pointing at the existing canonical code, no new
 *    registry row is appended.
 *  - `force_override`: the existing mapping is wrong; append a new
 *    registry row at the SAME scope. Because registry is append-only
 *    and reads take the highest `created_at`, this supersedes the
 *    existing row without losing audit history.
 *  - `escalate_to_global`: the queued string was filed at
 *    `tenant_scoped` but the operator wants a global mapping; we
 *    append a `global` row that doesn't collide with the tenant row,
 *    so both coexist (tenant takes precedence per scope-resolution
 *    order). Only legal when the original request scope was
 *    `tenant_scoped`.
 *  - `narrow_to_tenant`: mirror image — original request was
 *    `global`, operator decides this should be tenant-scoped instead.
 */
export type ResolveDecision =
  | "accept_existing"
  | "force_override"
  | "escalate_to_global"
  | "narrow_to_tenant";

/**
 * Layer C: an operator maps a queued tenant string to a canonical code.
 *
 * Behavior contract:
 *   - Collision detection runs FIRST. If a synonym already exists at
 *     the requested scope for this `(scope, normalized)` key, return
 *     `{ kind: 'collision', existing }` without writing anything. The
 *     caller (admin UI) decides whether to delete-and-rewrite or
 *     escalate.
 *   - Otherwise, append a new `synonym_registry` row (registry is
 *     append-only — UPDATEs would lose audit history) and mark the
 *     queue entry resolved.
 *   - **Forward-only routing**: previously-persisted opportunities
 *     KEEP their original `mapped_via` and cohort assignment. We only
 *     bump `re_categorized_after_persistence` on already-existing
 *     opportunities tagged with the matching org+category as an
 *     audit hint — no data is rewritten. The count of those flagged
 *     opportunities is returned for operator visibility.
 */
export async function resolveQueueEntry(args: {
  queueId: string;
  canonicalCode: string;
  scope: SynonymScope;
  resolvedBy: string;
  /**
   * Operator's choice when a collision was previously reported.
   * `undefined` means "first attempt — surface a collision if one
   * exists". Pass an explicit `ResolveDecision` from the admin UI's
   * collision modal to commit one of the resolution paths.
   */
  decision?: ResolveDecision;
  /**
   * Authorization gate (task #213 round-7): only platform admins may
   * create or supersede `scope='global'` synonym rows, because a
   * global mapping affects EVERY tenant. Org admins resolving their
   * own queue can only write `tenant_scoped` rows, and may not
   * `force_override` a global row from beneath them. The route layer
   * sets this from the caller's RBAC context.
   */
  callerCanWriteGlobal: boolean;
}): Promise<ResolveResult> {
  const {
    queueId,
    canonicalCode,
    scope,
    resolvedBy,
    decision,
    callerCanWriteGlobal,
  } = args;
  if (scope === "global" && !callerCanWriteGlobal) {
    throw new Error(
      "forbidden: writing global synonym rows requires platform admin",
    );
  }

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(unmappedCategoryQueueTable)
      .where(eq(unmappedCategoryQueueTable.id, queueId))
      .limit(1);

    if (!entry) {
      throw new Error(`queue entry ${queueId} not found`);
    }
    if (entry.resolvedAt) {
      throw new Error(`queue entry ${queueId} already resolved`);
    }

    // Collision check spans BOTH scopes — a tenant-scoped resolution
    // that silently shadows a conflicting global mapping (or vice
    // versa) is exactly the class of mis-routing this surface is
    // designed to prevent. Only ACTIVE (non-superseded) rows count —
    // historical rows from prior force_overrides are audit-only and
    // must not block a new mapping.
    //
    // We prefer the SAME-SCOPE collision if both exist (it's the more
    // direct conflict the operator is creating), but we still surface
    // a cross-scope conflict so the operator can pick
    // narrow_to_tenant / escalate_to_global as appropriate.
    const collisions = await tx
      .select({
        registryId: synonymRegistryTable.id,
        canonicalCode: synonymRegistryTable.canonicalCode,
        scope: synonymRegistryTable.scope,
        orgId: synonymRegistryTable.orgId,
      })
      .from(synonymRegistryTable)
      .where(
        and(
          eq(synonymRegistryTable.normalized, entry.normalized),
          isNull(synonymRegistryTable.supersededAt),
          // tenant_scoped collisions only count for THIS org;
          // global collisions match regardless of org_id (always null
          // by schema).
          sql`(
            (${synonymRegistryTable.scope} = 'global'
             AND ${synonymRegistryTable.orgId} IS NULL)
            OR
            (${synonymRegistryTable.scope} = 'tenant_scoped'
             AND ${synonymRegistryTable.orgId} = ${entry.orgId})
          )`,
        ),
      );

    const sameScope = collisions.find((c) => c.scope === scope) ?? null;
    const crossScope = collisions.find((c) => c.scope !== scope) ?? null;
    const existing = sameScope ?? crossScope;

    // First-attempt path: surface the collision so the operator can
    // pick a resolution decision in the admin UI, instead of silently
    // overwriting (or silently doing nothing).
    if (existing && !decision) {
      return {
        kind: "collision" as const,
        existing,
      };
    }

    // ── Apply the operator's collision decision ──────────────────────
    let writtenRegistryId: string | null = null;
    let resolvedCanonicalCode = canonicalCode;
    let resolvedScopeForEntry: SynonymScope = scope;

    if (existing && decision === "accept_existing") {
      // Use the existing mapping; do NOT append a new registry row.
      // The queue entry just gets closed against the existing
      // canonical code/scope so the auditor can see the operator
      // confirmed it.
      resolvedCanonicalCode = existing.canonicalCode;
      resolvedScopeForEntry = existing.scope;
    } else if (existing && decision === "escalate_to_global") {
      // Original request was tenant_scoped but operator wants a global
      // mapping. Disallow if user is trying to escalate from a global
      // scope (no-op; that's a force_override at global level).
      if (scope !== "tenant_scoped") {
        throw new Error(
          "escalate_to_global requires the original request to be tenant_scoped",
        );
      }
      if (!callerCanWriteGlobal) {
        throw new Error(
          "forbidden: escalate_to_global requires platform admin",
        );
      }
      writtenRegistryId = newId("syn");
      await tx.insert(synonymRegistryTable).values({
        id: writtenRegistryId,
        tenantString: entry.tenantString,
        normalized: entry.normalized,
        canonicalCode,
        scope: "global",
        orgId: null,
        createdBy: resolvedBy,
        source: "operator",
      });
      resolvedScopeForEntry = "global";
    } else if (existing && decision === "narrow_to_tenant") {
      if (scope !== "global") {
        throw new Error(
          "narrow_to_tenant requires the original request to be global",
        );
      }
      writtenRegistryId = newId("syn");
      await tx.insert(synonymRegistryTable).values({
        id: writtenRegistryId,
        tenantString: entry.tenantString,
        normalized: entry.normalized,
        canonicalCode,
        scope: "tenant_scoped",
        orgId: entry.orgId,
        createdBy: resolvedBy,
        source: "operator",
      });
      resolvedScopeForEntry = "tenant_scoped";
    } else if (existing && decision === "force_override") {
      // Append-only contract: stamp the prior row's `superseded_at`
      // and insert a brand-new active row at the same scope. The old
      // row is preserved as historical audit trail; the new row wins
      // because the partial unique indexes filter superseded rows out
      // and the synonym resolver also requires `superseded_at IS NULL`.
      //
      // Authorization: a tenant-scoped caller MUST NOT supersede a
      // global row — that would silently mutate routing for every
      // other tenant. We require the existing row's scope ALSO to be
      // permitted under the caller's authority.
      if (existing.scope === "global" && !callerCanWriteGlobal) {
        throw new Error(
          "forbidden: force_override of a global synonym requires platform admin",
        );
      }
      writtenRegistryId = newId("syn");
      await tx
        .update(synonymRegistryTable)
        .set({
          supersededAt: sql`now()`,
          supersededByRegistryId: writtenRegistryId,
        })
        .where(eq(synonymRegistryTable.id, existing.registryId));
      await tx.insert(synonymRegistryTable).values({
        id: writtenRegistryId,
        tenantString: entry.tenantString,
        normalized: entry.normalized,
        canonicalCode,
        scope,
        orgId: scope === "tenant_scoped" ? entry.orgId : null,
        createdBy: resolvedBy,
        source: "operator",
      });
    } else {
      // No collision: append a fresh registry row at the requested
      // scope. The synonym resolver picks the highest `created_at`
      // row so tenant_scoped rows naturally supersede older global
      // ones for the same org.
      writtenRegistryId = newId("syn");
      await tx.insert(synonymRegistryTable).values({
        id: writtenRegistryId,
        tenantString: entry.tenantString,
        normalized: entry.normalized,
        canonicalCode,
        scope,
        orgId: scope === "tenant_scoped" ? entry.orgId : null,
        createdBy: resolvedBy,
        source: "operator",
      });
    }

    await tx
      .update(unmappedCategoryQueueTable)
      .set({
        resolvedAt: sql`now()`,
        resolvedBy,
        resolvedToCanonicalCode: resolvedCanonicalCode,
        resolvedScope: resolvedScopeForEntry,
      })
      .where(eq(unmappedCategoryQueueTable.id, queueId));

    // Audit-flag previously-persisted opportunities for THIS org that
    // originated from the SAME tenant-supplied category string as this
    // queue entry. We match on `source_tenant_category_string`
    // provenance — NOT category code — because unmapped opps point to
    // a placeholder category, not the eventually-resolved canonical
    // code, so a code-based match would silently miss every historical
    // row this resolution is supposed to surface.
    //
    // We do NOT rewrite mapped_via or category_id — purely an audit
    // signal so operators can trace which historical rows came from a
    // since-resolved category string.
    const flagged = await tx.execute(sql`
      UPDATE opportunities AS o
         SET re_categorized_after_persistence = 1
       WHERE o.org_id = ${entry.orgId}
         AND o.source_tenant_category_string = ${entry.tenantString}
         AND o.mapped_via = 'unmapped_default'
         AND o.re_categorized_after_persistence = 0
    `);

    const reCategorizedOpportunityCount = Number(
      (flagged as unknown as { rowCount: number | null }).rowCount ?? 0,
    );

    const collisionDecision: ResolveDecision | null = existing
      ? (decision ?? "force_override")
      : null;

    logger.info(
      {
        queueId,
        canonicalCode: resolvedCanonicalCode,
        scope: resolvedScopeForEntry,
        registryId: writtenRegistryId,
        reCategorizedOpportunityCount,
        collisionDecision,
      },
      "Resolved unmapped category queue entry",
    );

    return {
      kind: "ok" as const,
      // When `accept_existing`, the existing registry row is the
      // semantically correct ID to surface back to the operator.
      registryId: writtenRegistryId ?? existing!.registryId,
      reCategorizedOpportunityCount,
      collisionDecision,
    };
  });
}

/**
 * Helper used by cycle.ts to count rows that were created against an
 * org BEFORE today's mapping changes — exposed so analyzers don't need
 * to hand-roll the predicate.
 */
export async function countOpportunitiesByMappedVia(
  orgId: string,
): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ mapped_via: string | null; n: string }>(
    `SELECT mapped_via, count(*)::text AS n
       FROM opportunities
      WHERE org_id = $1
      GROUP BY mapped_via`,
    [orgId],
  );
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.mapped_via ?? "null"] = Number(r.n);
  }
  return out;
}
