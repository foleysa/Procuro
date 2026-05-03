import {
  pgTable,
  text,
  varchar,
  integer,
  real,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgsTable } from "./orgs";

/**
 * Bands routing model + 4-layer category resolution (task #213).
 *
 * Two truth tables (`category_bands`, `lever_bands`) join on `band` to
 * give every category an ordered set of applicable levers — and every
 * lever an ordered set of applicable categories — without each new
 * lever or category having to re-derive applicability ad-hoc. The
 * materialized view `v_category_lever_mappings` is the read-side join.
 *
 * The 4-layer resolution (`synonym_registry` + `unmapped_category_queue`)
 * deterministically maps tenant-supplied category strings onto canonical
 * codes:
 *   Layer A: exact synonym match (tenant-scoped → global precedence)
 *   Layer B: queue + Fragmented fallback (provenance preserved via
 *            `opportunities.mapped_via = 'unmapped_default'`)
 *   Layer C: operator resolution from the admin queue
 *   Layer D: learning structure (`synonym_source = 'auto'` reserved
 *            for v2 fuzzy/ML matching)
 *
 * These tables sit ALONGSIDE `CANONICAL_*_CODES` in
 * `scope-taxonomy.ts` — they don't replace them. Material/category
 * codes remain the join key for signals; bands are the routing layer
 * above them.
 */

/** Six bands (single source of truth for routing). */
export const bandValues = [
  "indexable",
  "concentrated",
  "fragmented",
  "subscription",
  "capital",
  "services",
] as const;
export type Band = (typeof bandValues)[number];

/** Source of a `category_bands` / `lever_bands` row. */
export const mappingSourceValues = ["seed", "learned", "manual"] as const;
export type MappingSource = (typeof mappingSourceValues)[number];

/** Scope of a `synonym_registry` entry. */
export const synonymScopeValues = ["global", "tenant_scoped"] as const;
export type SynonymScope = (typeof synonymScopeValues)[number];

/**
 * Source of a `synonym_registry` entry.
 *
 *   `seed`     — populated from the bootstrap seed.
 *   `operator` — resolved from the admin queue by an operator.
 *   `auto`     — reserved for v2 (fuzzy / ML auto-discovery). The
 *                Layer A resolver only honors `seed` and `operator`
 *                rows in v1 to keep deterministic matching.
 */
export const synonymSourceValues = ["seed", "operator", "auto"] as const;
export type SynonymSource = (typeof synonymSourceValues)[number];

/**
 * Canonical procurement code → band assignments.
 *
 * One canonical code can sit in multiple bands; the `confidenceWeight`
 * scales the lever's relevance for that pairing in calibration math
 * downstream. The materialized view joins this table with `lever_bands`
 * on `band`.
 */
export const categoryBandsTable = pgTable(
  "category_bands",
  {
    id: text("id").primaryKey(),
    categoryCode: varchar("category_code", { length: 64 }).notNull(),
    band: varchar("band", { length: 32 }).$type<Band>().notNull(),
    confidenceWeight: real("confidence_weight").notNull().default(1.0),
    source: varchar("source", { length: 16 })
      .$type<MappingSource>()
      .notNull()
      .default("seed"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("category_bands_code_band_uq").on(t.categoryCode, t.band),
    index("category_bands_code_idx").on(t.categoryCode),
    index("category_bands_band_idx").on(t.band),
  ],
);

export type CategoryBandRow = typeof categoryBandsTable.$inferSelect;
export type InsertCategoryBandRow = typeof categoryBandsTable.$inferInsert;

/**
 * Lever → band assignments.
 *
 * `fitRank` orders levers within a band: 1 = primary fit, 2 = fallback
 * fit (the routing helpers in v1 only read `fit_rank=1` rows; the
 * `fit_rank=2` rows ship with data populated correctly so the fallback
 * surface is one helper change away when calibration shows it earns
 * its place).
 */
export const leverBandsTable = pgTable(
  "lever_bands",
  {
    id: text("id").primaryKey(),
    leverId: varchar("lever_id", { length: 64 }).notNull(),
    band: varchar("band", { length: 32 }).$type<Band>().notNull(),
    fitRank: integer("fit_rank").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("lever_bands_lever_band_uq").on(t.leverId, t.band),
    index("lever_bands_lever_idx").on(t.leverId),
    index("lever_bands_band_idx").on(t.band),
  ],
);

export type LeverBandRow = typeof leverBandsTable.$inferSelect;
export type InsertLeverBandRow = typeof leverBandsTable.$inferInsert;

/**
 * Append-only synonym registry mapping tenant-supplied category strings
 * to canonical codes.
 *
 * `normalized` is the case-folded / whitespace-collapsed form used for
 * lookup (always derived from `tenantString` via `normalizeCategoryString`).
 *
 * Two scopes:
 *   - `global`         — universal mapping; `orgId` is NULL.
 *   - `tenant_scoped`  — opt-in override for one org; `orgId` required.
 *
 * The unique indexes are partial AND filter on `superseded_at IS NULL`:
 * exactly one ACTIVE global mapping per `normalized` string, and at
 * most one ACTIVE tenant-scoped mapping per `(orgId, normalized)`.
 * Re-mapping an already-mapped string is done by inserting a NEW row
 * and stamping the old row's `superseded_at` — never via UPDATE of the
 * canonical_code. The append-only history (rows with `superseded_at IS
 * NOT NULL`) is the audit trail. Reads filter on `superseded_at IS NULL`
 * via the synonym resolver.
 */
export const synonymRegistryTable = pgTable(
  "synonym_registry",
  {
    id: text("id").primaryKey(),
    tenantString: text("tenant_string").notNull(),
    normalized: text("normalized").notNull(),
    canonicalCode: varchar("canonical_code", { length: 64 }).notNull(),
    scope: varchar("scope", { length: 16 })
      .$type<SynonymScope>()
      .notNull(),
    /** Required when scope = 'tenant_scoped', NULL when scope = 'global'. */
    orgId: text("org_id").references(() => orgsTable.id, {
      onDelete: "cascade",
    }),
    createdBy: text("created_by"),
    source: varchar("source", { length: 16 })
      .$type<SynonymSource>()
      .notNull()
      .default("operator"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * NULL = currently-active mapping. NON-NULL = retired by a later
     * append (force_override). The partial unique indexes filter
     * superseded rows out so multiple retired mappings can co-exist.
     */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    /** ID of the row that retired this one (NULL when active). */
    supersededByRegistryId: text("superseded_by_registry_id"),
  },
  (t) => [
    uniqueIndex("synonym_registry_global_uq")
      .on(t.normalized)
      .where(sql`${t.scope} = 'global' AND ${t.supersededAt} IS NULL`),
    uniqueIndex("synonym_registry_tenant_uq")
      .on(t.orgId, t.normalized)
      .where(sql`${t.scope} = 'tenant_scoped' AND ${t.supersededAt} IS NULL`),
    index("synonym_registry_normalized_idx").on(t.normalized),
    index("synonym_registry_canonical_idx").on(t.canonicalCode),
    index("synonym_registry_active_idx")
      .on(t.normalized)
      .where(sql`${t.supersededAt} IS NULL`),
    // GIN trigram index for fuzzy suggestions in the routing layer.
    // Requires the `pg_trgm` extension, which is bootstrapped at API
    // server startup (`bootstrapTrigramSuggestions`). Declared here so
    // drizzle-kit knows about it and does not try to drop it on sync.
    index("synonym_registry_normalized_trgm_idx").using(
      "gin",
      t.normalized.op("gin_trgm_ops"),
    ),
  ],
);

export type SynonymRegistryRow = typeof synonymRegistryTable.$inferSelect;
export type InsertSynonymRegistryRow =
  typeof synonymRegistryTable.$inferInsert;

/**
 * Queue of unmapped tenant category strings awaiting operator resolution.
 *
 * The resolver enqueues idempotently on `(orgId, normalized)` while
 * `resolvedAt IS NULL`; once resolved the row stays around as audit
 * (the unique partial index lets a *new* unmapped occurrence of the
 * same string re-enqueue if the synonym ever gets revoked).
 */
export const unmappedCategoryQueueTable = pgTable(
  "unmapped_category_queue",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    tenantString: text("tenant_string").notNull(),
    normalized: text("normalized").notNull(),
    spendTrailing90dUsd: numeric("spend_trailing_90d_usd", {
      precision: 18,
      scale: 2,
    })
      .notNull()
      .default("0"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolvedToCanonicalCode: varchar("resolved_to_canonical_code", {
      length: 64,
    }),
    resolvedScope: varchar("resolved_scope", { length: 16 })
      .$type<SynonymScope>(),
  },
  (t) => [
    uniqueIndex("unmapped_queue_open_uq")
      .on(t.orgId, t.normalized)
      .where(sql`${t.resolvedAt} IS NULL`),
    index("unmapped_queue_org_open_idx")
      .on(t.orgId, t.spendTrailing90dUsd)
      .where(sql`${t.resolvedAt} IS NULL`),
    index("unmapped_queue_first_seen_idx").on(t.firstSeenAt),
    // GIN trigram index for fuzzy suggestions in the routing layer.
    // Requires the `pg_trgm` extension, which is bootstrapped at API
    // server startup (`bootstrapTrigramSuggestions`). Declared here so
    // drizzle-kit knows about it and does not try to drop it on sync.
    index("unmapped_queue_normalized_trgm_idx").using(
      "gin",
      t.normalized.op("gin_trgm_ops"),
    ),
  ],
);

export type UnmappedCategoryQueueRow =
  typeof unmappedCategoryQueueTable.$inferSelect;
export type InsertUnmappedCategoryQueueRow =
  typeof unmappedCategoryQueueTable.$inferInsert;

/**
 * Provenance tag stamped on `opportunities.mapped_via` so the
 * calibration job can exclude opportunities routed via the Layer-B
 * fallback (`unmapped_default`) from per-lever scoring — without that
 * filter, unrouted strings would contaminate the prior.
 */
export const mappedViaValues = [
  "synonym_global",
  "synonym_tenant_scoped",
  "unmapped_default",
] as const;
export type MappedVia = (typeof mappedViaValues)[number];

/**
 * Normalize a tenant-supplied category string into its lookup key.
 *
 *   1. Trim leading/trailing whitespace.
 *   2. Collapse internal whitespace runs (incl. unicode whitespace) to
 *      a single ASCII space.
 *   3. Lowercase using locale-independent rules.
 *
 * The function is deterministic and pure so the same tenant string
 * always maps to the same `normalized` value across server, seed, and
 * test code.
 */
export function normalizeCategoryString(input: string): string {
  return input
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
