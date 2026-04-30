/**
 * Foundation entity-resolver bridge for collectors.
 *
 * Each public-API collector that knows the canonical identifier of its
 * subject (CIK for SEC EDGAR, LEI for GLEIF / OpenSanctions, Companies
 * House number for the UK collector, ...) should call
 * `resolveDraftEntity` per draft to:
 *
 *   1. Look the entity up in the Foundation `entities` table (BQ) so
 *      we land the SAME `entity_uid` other collectors and lever
 *      analyzers will see for the same business.
 *   2. Fall back to a deterministic identifier-keyed UID
 *      (`ent_<kind>_<value>`) when BQ is unavailable — same scheme the
 *      Foundation resolver uses when it has to synthesize.
 *   3. Cache the resolution in Postgres so subsequent collector runs in
 *      the same process don't re-hit BQ.
 *
 * Wrapping the resolver here (rather than calling `resolveEntity`
 * inline in every collector) keeps the per-collector code small,
 * centralises the failure-isolation policy (resolver errors must NEVER
 * fail a collector — we drop back to the synthetic UID and log), and
 * gives us one place to add batching / parallelism later.
 */

import {
  resolveEntity,
  deterministicUidFromIdentifier,
  type IdentifierKind,
  type Identifiers,
} from "@workspace/intelligence";

import { logger } from "../../logger";

export interface ResolveDraftEntityArgs {
  /** Display name — used for fuzzy + deterministic-name fallback. */
  name: string;
  /** ISO-3166-alpha-2 jurisdiction (e.g. "US", "GB"). Optional. */
  country?: string;
  /** Identifiers in priority order: lei > cik > companies_house > ... */
  identifiers?: Identifiers;
  /** Collector id, for the log message on resolver failure. */
  collectorId: string;
}

/**
 * Resolve an entity for a collector draft.
 *
 * Returns:
 *   - The resolver's `entity_uid` when it succeeds (BQ hit or
 *     deterministic-name match).
 *   - A deterministic `ent_<kind>_<value>` UID when the resolver
 *     returns `unresolved` but at least one identifier is present.
 *   - `null` when no identifier is present and the resolver couldn't
 *     match by name — caller should leave `entityUid` unset.
 *
 * Never throws; resolver failures are logged at warn level and
 * downgraded to the synthetic / null path.
 */
export async function resolveDraftEntity(
  args: ResolveDraftEntityArgs,
): Promise<string | null> {
  const { collectorId, name, country, identifiers } = args;
  try {
    const r = await resolveEntity({
      name,
      ...(country ? { country } : {}),
      ...(identifiers ? { identifiers } : {}),
    });
    if (r.entity_uid) return r.entity_uid;
  } catch (err) {
    logger.warn(
      { collectorId, err: (err as Error).message },
      "resolveEntity failed; falling back to deterministic UID",
    );
  }
  // Synthetic fallback — first identifier wins, in resolver priority
  // order. Matches `deterministicUidFromIdentifier` exactly so a later
  // BQ-backed run produces the same UID.
  if (identifiers) {
    const order: IdentifierKind[] = [
      "lei",
      "cik",
      "companies_house",
      "ein",
      "uei",
      "ticker",
    ];
    for (const k of order) {
      const v = identifiers[k];
      if (v && v.trim() !== "") {
        return deterministicUidFromIdentifier(k, v);
      }
    }
  }
  return null;
}

/**
 * Convenience wrapper: resolve N drafts in parallel with a small
 * concurrency cap so a large batch (e.g. all GLEIF records on a backfill)
 * doesn't open thousands of simultaneous BQ queries.
 */
export async function resolveDraftEntities(
  inputs: ResolveDraftEntityArgs[],
  opts: { concurrency?: number } = {},
): Promise<Array<string | null>> {
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const out: Array<string | null> = new Array(inputs.length).fill(null);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= inputs.length) return;
      out[i] = await resolveDraftEntity(inputs[i]!);
    }
  }
  const workers: Promise<void>[] = [];
  const n = Math.min(concurrency, inputs.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}
