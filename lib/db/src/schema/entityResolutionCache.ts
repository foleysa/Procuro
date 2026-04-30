import {
  pgTable,
  text,
  timestamp,
  numeric,
  uniqueIndex,
  index,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";

/**
 * Postgres hot-path cache for entity-resolution lookups.
 *
 * The canonical entity catalogue lives in BigQuery (`entities` table) so
 * the warehouse can join market signals to resolved entities at scale,
 * but lever analyzers calling `resolveEntity` repeatedly inside an OODA
 * cycle need single-digit-millisecond latency. This table is a write-
 * through cache:
 *   - on cache hit, the resolver returns immediately with the cached
 *     entity_uid, confidence, and match_type
 *   - on cache miss, the resolver does the BQ / Gemini round trip and
 *     UPSERTs the result here.
 *
 * `queryKey` is the canonical form built by `buildCacheKey` in
 * `@workspace/intelligence/entities` — for identifier-keyed queries it
 * is `id:<kind>:<value>`, for name+country queries it is
 * `name:<country>:<normalised_name>`. Identical queries always hit the
 * same row.
 */
export const entityResolutionCacheTable = pgTable(
  "entity_resolution_cache",
  {
    id: text("id").primaryKey(),
    queryKey: text("query_key").notNull(),
    entityUid: text("entity_uid").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 })
      .notNull()
      .default("0.0000"),
    matchType: text("match_type").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("entity_resolution_cache_query_key_uq").on(t.queryKey),
    index("entity_resolution_cache_entity_uid_idx").on(t.entityUid),
    index("entity_resolution_cache_resolved_at_idx").on(t.resolvedAt),
  ],
);

export type EntityResolutionCacheRow =
  typeof entityResolutionCacheTable.$inferSelect;
export type InsertEntityResolutionCacheRow =
  typeof entityResolutionCacheTable.$inferInsert;

/**
 * Per-collector schema-drift events. The runtime emits one row whenever
 * a collector's parsed signal fails the collector's declared Zod schema
 * — these are the early warning of an upstream feed shape change. The
 * Collector workbench surfaces recent drift events; persistent drift
 * trips a follow-up alert.
 */
export const marketSignalSchemaDriftTable = pgTable(
  "market_signal_schema_drift",
  {
    id: text("id").primaryKey(),
    collectorId: text("collector_id").notNull(),
    runId: text("run_id"),
    /** Which Zod path failed (e.g. "metadata.seriesId"). */
    fieldPath: text("field_path"),
    /** Zod-style code: "invalid_type", "too_small", etc. */
    errorCode: text("error_code"),
    message: text("message").notNull(),
    /** Number of drafts in the run that triggered this drift. */
    occurrences: integer("occurrences").notNull().default(1),
    sample: jsonb("sample").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("market_signal_schema_drift_collector_idx").on(t.collectorId),
    index("market_signal_schema_drift_created_at_idx").on(t.createdAt),
  ],
);

export type MarketSignalSchemaDriftRow =
  typeof marketSignalSchemaDriftTable.$inferSelect;
export type InsertMarketSignalSchemaDriftRow =
  typeof marketSignalSchemaDriftTable.$inferInsert;
