import {
  pgTable,
  text,
  timestamp,
  numeric,
  index,
  jsonb,
  uniqueIndex,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgsTable } from "./orgs";

export const collectionPostureValues = [
  "public-api",
  "published-data",
  "respect-robots-crawl",
  "aggressive-crawl",
] as const;
export type CollectionPosture = (typeof collectionPostureValues)[number];

export const collectorRegistryStatusValues = [
  "draft",
  "approved",
  "killed",
  "rejected",
] as const;
export type CollectorRegistryStatus =
  (typeof collectorRegistryStatusValues)[number];

/**
 * Platform-wide collector registry. One row per registered intelligence source.
 * `aggressive-crawl` collectors must remain `status='draft'` (or 'rejected')
 * unless explicit per-source approval is recorded.
 */
export const collectorsTable = pgTable(
  "collectors",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Human-readable description of the source */
    description: text("description").notNull(),
    /** Posture tier — gate determines what runtime is allowed */
    posture: text("posture").$type<CollectionPosture>().notNull(),
    /** Approval gate: only 'approved' collectors can run */
    status: text("status")
      .$type<CollectorRegistryStatus>()
      .notNull()
      .default("draft"),
    /** Owner team / point of contact */
    owner: text("owner").notNull(),
    /** Reference URL of the source */
    sourceUrl: text("source_url").notNull(),
    /** Rate-limit policy (requests per minute / per host) */
    rateLimitRpm: integer("rate_limit_rpm").notNull().default(10),
    /** Runtime kill switch — when true, runtime refuses to fetch */
    killSwitch: integer("kill_switch").notNull().default(0),
    /** Cron-like schedule (cron expression or null) */
    scheduleCron: text("schedule_cron"),
    /** Approval audit trail */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Notes (legal review, posture rationale, etc.) */
    notes: text("notes"),
    /**
     * Per-collector trust priors. Updated by the OODA loop in Phase 5c+ from
     * how well this collector's signals predicted realized savings.
     */
    trustWeight: numeric("trust_weight", { precision: 5, scale: 4 })
      .notNull()
      .default("0.5000"),
    /** Auto-flag for admin review when trust_weight degrades chronically */
    needsReview: integer("needs_review").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("collectors_id_uq").on(t.id),
    index("collectors_status_idx").on(t.status),
    index("collectors_posture_idx").on(t.posture),
  ],
);

export type CollectorRow = typeof collectorsTable.$inferSelect;
export type InsertCollectorRow = typeof collectorsTable.$inferInsert;

/** Audit log for every collector fetch attempt (success or failure). */
export const collectorAuditLogTable = pgTable(
  "collector_audit_log",
  {
    id: text("id").primaryKey(),
    collectorId: text("collector_id")
      .notNull()
      .references(() => collectorsTable.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    targetUrl: text("target_url"),
    statusCode: integer("status_code"),
    error: text("error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("collector_audit_collector_idx").on(t.collectorId),
    index("collector_audit_created_at_idx").on(t.createdAt),
  ],
);

export type CollectorAuditLogRow = typeof collectorAuditLogTable.$inferSelect;
export type InsertCollectorAuditLogRow =
  typeof collectorAuditLogTable.$inferInsert;

/** Signal-type taxonomy. */
export const marketSignalTypes = [
  "commodity_index",
  "freight_rate",
  "supplier_price_list",
  "marketplace_price",
  "public_bid_award",
  "customs_trade",
  "supplier_financial",
  "supplier_risk_news",
  "services_rate_card",
  "economic_index",
  "fx_rate",
] as const;
export type MarketSignalType = (typeof marketSignalTypes)[number];

/**
 * Canonical MarketSignal stream from external `IntelligenceCollector`s.
 * orgId NULL = platform-wide signal usable by any tenant.
 */
export const marketSignalsTable = pgTable(
  "market_signals",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").references(() => orgsTable.id, {
      onDelete: "cascade",
    }),
    collectorId: text("collector_id")
      .notNull()
      .references(() => collectorsTable.id, { onDelete: "cascade" }),
    signalType: text("signal_type").$type<MarketSignalType>().notNull(),
    /**
     * Scope keys: at least one of category_code / sku / material_code /
     * supplier_name / lane_key applies.
     */
    scopeCategoryCode: text("scope_category_code"),
    scopeSku: text("scope_sku"),
    scopeMaterialCode: text("scope_material_code"),
    scopeSupplierName: text("scope_supplier_name"),
    scopeLaneKey: text("scope_lane_key"),
    value: numeric("value", { precision: 18, scale: 6 }).notNull(),
    unit: text("unit").notNull(),
    currency: text("currency").notNull().default("USD"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceUrl: text("source_url").notNull(),
    posture: text("posture").$type<CollectionPosture>().notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 })
      .notNull()
      .default("0.7000"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => [
    index("market_signals_org_idx").on(t.orgId),
    index("market_signals_collector_idx").on(t.collectorId),
    index("market_signals_type_idx").on(t.signalType),
    index("market_signals_observed_at_idx").on(t.observedAt),
    index("market_signals_material_idx").on(t.scopeMaterialCode),
    index("market_signals_lane_idx").on(t.scopeLaneKey),
    /**
     * Natural-key uniqueness. A given collector should not produce two rows
     * with the same scope + observation time on repeat runs — a re-run of a
     * collector that sees the same upstream observation must be a no-op.
     *
     * Most signals only fill ONE of the `scope_*` columns and leave the
     * rest NULL. By default Postgres treats every NULL pair as distinct,
     * which would make the index useless for those rows. We can't use
     * `NULLS NOT DISTINCT` (Postgres 15+ syntax not yet exposed by this
     * drizzle-orm version), so we wrap each nullable scope column in
     * `COALESCE(col, '')` — distinct empty-string sentinel — so two rows
     * with NULL in the same column collide as expected.
     */
    uniqueIndex("market_signals_natural_key_uq").on(
      t.collectorId,
      t.signalType,
      sql`COALESCE(${t.scopeCategoryCode}, '')`,
      sql`COALESCE(${t.scopeSku}, '')`,
      sql`COALESCE(${t.scopeMaterialCode}, '')`,
      sql`COALESCE(${t.scopeSupplierName}, '')`,
      sql`COALESCE(${t.scopeLaneKey}, '')`,
      t.observedAt,
    ),
  ],
);

export type MarketSignalRow = typeof marketSignalsTable.$inferSelect;
export type InsertMarketSignalRow = typeof marketSignalsTable.$inferInsert;
