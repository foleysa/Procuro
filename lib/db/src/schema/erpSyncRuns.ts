import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { erpConnectionsTable } from "./erpConnections";

/**
 * Per-run audit log for `sync_erp_connection` job executions. One row
 * is written each time the worker finishes (or fails) a sync for a
 * given `erp_connections` row, capturing:
 *
 *   - wall-clock timing (started_at / finished_at / duration_ms)
 *   - per-entity rows ingested (`recordsByEntity`) and pages fetched
 *     (`pagesByEntity`) — pulled straight off `connector.fetchAll`
 *   - per-entity dropped/skipped counts (`droppedByEntity`) so a
 *     partial-success run is auditable without parsing job result JSON
 *   - terminal status (`succeeded` | `failed` | `skipped`) and the
 *     error message on failure
 *
 * The `erp_connections` row only retains the *latest* `lastSyncedAt`
 * and `lastError`; this table is the historical view that lets the
 * Integrations page render "last 10 runs" and lets operators audit
 * data freshness over time without scraping the `jobs` table.
 *
 * Cross-tenant by design: scoped via `orgId`. Rows cascade-delete with
 * the parent connection so removing a connection cleans its history.
 */
export const erpSyncRunStatusValues = [
  "succeeded",
  "failed",
  "skipped",
] as const;
export type ErpSyncRunStatus = (typeof erpSyncRunStatusValues)[number];

/**
 * Per-entity integer counter map. Keys are `ErpEntity` strings
 * (`"suppliers"`, `"contracts"`, `"purchase_orders"`, `"invoices"`,
 * `"payments"`); values are non-negative ingestion counts. Stored as
 * `jsonb` because the connector contract treats the entity list as
 * open-ended and we don't want a schema migration every time a new
 * entity ships.
 */
export type ErpEntityCounts = Record<string, number>;

export const erpSyncRunsTable = pgTable(
  "erp_sync_runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => erpConnectionsTable.id, { onDelete: "cascade" }),
    /**
     * The `jobs.id` that produced this run. Nullable so the row can
     * still be written if the job row was pruned by the housekeeping
     * sweep before the run row was looked at.
     */
    jobId: text("job_id"),
    status: text("status").$type<ErpSyncRunStatus>().notNull(),
    /** Wall-clock time the worker began the sync. */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Wall-clock time the worker finished or errored out. */
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    /** finishedAt − startedAt, denormalised for cheap sort/filter. */
    durationMs: integer("duration_ms").notNull().default(0),
    recordsByEntity: jsonb("records_by_entity")
      .$type<ErpEntityCounts>()
      .notNull()
      .default({}),
    pagesByEntity: jsonb("pages_by_entity")
      .$type<ErpEntityCounts>()
      .notNull()
      .default({}),
    droppedByEntity: jsonb("dropped_by_entity")
      .$type<ErpEntityCounts>()
      .notNull()
      .default({}),
    /** Total rows the writer reported as successfully processed. */
    recordsProcessed: integer("records_processed").notNull().default(0),
    /** Total rows the writer reported as intentionally skipped. */
    recordsSkipped: integer("records_skipped").notNull().default(0),
    /** Error message on failure (truncated to keep the row bounded). */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Supports the per-connection "recent runs" query —
    // `WHERE connection_id = ? ORDER BY started_at DESC LIMIT N`.
    index("erp_sync_runs_connection_started_idx").on(
      t.connectionId,
      t.startedAt,
    ),
    index("erp_sync_runs_org_idx").on(t.orgId),
  ],
);

export type ErpSyncRunRow = typeof erpSyncRunsTable.$inferSelect;
export type InsertErpSyncRunRow = typeof erpSyncRunsTable.$inferInsert;
