import {
  pgTable,
  text,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Data Factory Day 0 — metering + Layer C public-signal labels.
 *
 * LoE = Procuro only. These tables do NOT store tenant spend, FSA
 * client files, or multi-tenant benchmark scores. `org_id` on the
 * usage log is the *caller* (who hit the API), not a data subject.
 */

export const dataFactoryReleaseStatuses = ["beta"] as const;
export type DataFactoryReleaseStatus =
  (typeof dataFactoryReleaseStatuses)[number];

export const dataFactoryLayerCPhases = ["decide", "learn"] as const;
export type DataFactoryLayerCPhase =
  (typeof dataFactoryLayerCPhases)[number];

/**
 * Authenticated read metering for the public Layer A API spine.
 *
 * Honest beta hook — not a billing product, not GA quota enforcement.
 * One row per packaged-dataset (or catalog) read. Failures to write
 * must not invent usage.
 */
export const dataFactoryUsageLogTable = pgTable(
  "data_factory_usage_log",
  {
    id: text("id").primaryKey(),
    /**
     * Caller tenant if the request authenticated via an org API key
     * or Clerk session. Null when the caller is not tenant-bound.
     * This is metering identity, not ingested client data.
     */
    orgId: text("org_id").references(() => orgsTable.id, {
      onDelete: "set null",
    }),
    actor: text("actor").notNull(),
    route: text("route").notNull(),
    packageId: text("package_id"),
    sourceId: text("source_id"),
    statusCode: text("status_code").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("data_factory_usage_org_idx").on(t.orgId),
    index("data_factory_usage_created_at_idx").on(t.createdAt),
    index("data_factory_usage_package_idx").on(t.packageId),
  ],
);

export type DataFactoryUsageLogRow =
  typeof dataFactoryUsageLogTable.$inferSelect;
export type InsertDataFactoryUsageLogRow =
  typeof dataFactoryUsageLogTable.$inferInsert;

/**
 * Layer C labels attached to PUBLIC Layer A signals (later moat).
 *
 * Aligns with Pulse Decide/Learn enums (PR #30). No tenant stake
 * dollars, no FSA engagement ids, no peer percentiles.
 */
export const dataFactoryLayerCLabelsTable = pgTable(
  "data_factory_layer_c_labels",
  {
    id: text("id").primaryKey(),
    /** Public Layer A signal / catalog record id — never a tenant spend row. */
    publicSignalId: text("public_signal_id").notNull(),
    packageId: text("package_id"),
    phase: text("phase").$type<DataFactoryLayerCPhase>().notNull(),
    decideAction: text("decide_action"),
    learnOutcome: text("learn_outcome"),
    ownerRole: text("owner_role"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("data_factory_layer_c_signal_idx").on(t.publicSignalId),
    index("data_factory_layer_c_phase_idx").on(t.phase),
  ],
);

export type DataFactoryLayerCLabelRow =
  typeof dataFactoryLayerCLabelsTable.$inferSelect;
export type InsertDataFactoryLayerCLabelRow =
  typeof dataFactoryLayerCLabelsTable.$inferInsert;
