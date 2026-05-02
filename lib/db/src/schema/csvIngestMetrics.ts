import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Per-upload throughput sample for the streaming CSV ingest path
 * (`POST /ingest/csv-stream`). One row written per successful upload
 * captures the entity, parsed/inserted row counts, wall-clock duration,
 * and bytes processed so the System page can chart real-customer
 * throughput trends without scraping logs.
 *
 * The `ingest_csv` job records (multi-entity bulk path) hold aggregate
 * counts only — there is no per-entity breakdown there. This table
 * therefore exists to expose per-entity rows/sec drift over time for
 * the streaming path that real operators use today.
 *
 * Cross-tenant by design: cleared down by the same retention policy as
 * `jobs` (30 day rolling window is enforced by `pruneOldCsvIngestMetrics`).
 */
export const csvIngestMetricsTable = pgTable(
  "csv_ingest_metrics",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    entity: text("entity").notNull(),
    rowsParsed: integer("rows_parsed").notNull().default(0),
    rowsInserted: integer("rows_inserted").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    bytesProcessed: integer("bytes_processed").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("csv_ingest_metrics_created_at_idx").on(t.createdAt),
    index("csv_ingest_metrics_entity_created_at_idx").on(
      t.entity,
      t.createdAt,
    ),
    index("csv_ingest_metrics_org_idx").on(t.orgId),
  ],
);

export type CsvIngestMetricRow = typeof csvIngestMetricsTable.$inferSelect;
export type InsertCsvIngestMetricRow =
  typeof csvIngestMetricsTable.$inferInsert;
