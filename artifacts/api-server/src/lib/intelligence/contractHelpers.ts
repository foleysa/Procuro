/**
 * Shared building blocks for collector contracts.
 *
 * Each collector declares its own `signalSchema` (so the metadata block
 * can be enforced per source) and its own `stableSignalKey` (so the
 * runtime can MERGE re-runs idempotently). This module provides the
 * base draft schema and a default key builder so collectors only have
 * to spell out the parts that are actually source-specific.
 */

import { z } from "zod";
import { computeStableSignalKey } from "@workspace/intelligence";
import type { MarketSignalDraft } from "./collector";

/**
 * Zod schema covering every field on `MarketSignalDraft` *except*
 * `metadata`, which a collector overrides with its own object schema by
 * passing it to `buildSignalDraftSchema(metadataSchema)`.
 */
const baseDraftShape = {
  signalType: z.string().min(1),
  scopeCategoryCode: z.string().optional(),
  scopeSku: z.string().optional(),
  scopeMaterialCode: z.string().optional(),
  scopeSupplierName: z.string().optional(),
  scopeLaneKey: z.string().optional(),
  value: z.number().finite(),
  unit: z.string().min(1),
  currency: z.string().length(3).optional(),
  observedAt: z.union([z.date(), z.string().datetime()]),
  sourceUrl: z.string().url(),
  confidence: z.number().min(0).max(1).optional(),
  entityUid: z.string().min(1).nullable().optional(),
} as const;

/**
 * Build a Zod schema for a `MarketSignalDraft` whose `metadata` field
 * matches the collector-supplied `metadataSchema`. Pass `z.record(...)`
 * for collectors that don't constrain metadata yet.
 */
export function buildSignalDraftSchema<M extends z.ZodTypeAny>(
  metadataSchema: M,
) {
  return z.object({
    ...baseDraftShape,
    metadata: metadataSchema,
  });
}

/** Convenience: a permissive draft schema (any object metadata). */
export const looseSignalDraftSchema = buildSignalDraftSchema(
  z.record(z.string(), z.unknown()),
);

/**
 * Default `stableSignalKey` implementation: hash the natural-key columns
 * the same way the Postgres unique index does. Collectors should use
 * this unless they have a documented reason to deviate (e.g. they need
 * to incorporate a series id that lives only in `metadata`).
 */
export function defaultStableSignalKey(
  collectorId: string,
  draft: MarketSignalDraft,
): string {
  return computeStableSignalKey({
    collectorId,
    signalType: draft.signalType,
    scopeCategoryCode: draft.scopeCategoryCode ?? null,
    scopeSku: draft.scopeSku ?? null,
    scopeMaterialCode: draft.scopeMaterialCode ?? null,
    scopeSupplierName: draft.scopeSupplierName ?? null,
    scopeLaneKey: draft.scopeLaneKey ?? null,
    observedAt: draft.observedAt,
  });
}
