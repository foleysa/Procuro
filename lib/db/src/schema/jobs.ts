import {
  pgTable,
  text,
  timestamp,
  index,
  jsonb,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

export const jobStatusValues = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof jobStatusValues)[number];

export const jobKindValues = [
  "ingest_csv",
  "ingest_mock_erp",
  "run_analysis_cycle",
  "analysis_cycle_fanout",
  "run_collector",
  "sync_erp_connection",
  "prune_jobs",
  "prune_funnel_snapshots",
  // Cross-tenant funnel-snapshot backfill (task #195). Walks every
  // completed cycle for either one tenant (payload.orgId) or all
  // tenants (no payload) and writes a snapshot for each cycle that
  // doesn't already have one. Used to be inline in
  // `POST /platform/funnel/backfill`; routed through the queue so
  // an established workspace's thousands of historical cycles do
  // not block (and time out) the request.
  "backfill_funnel_snapshots",
  "renewal_alert_scan",
  "deliver_alerts",
  "escalate_alerts",
  "synthesize_operational_alerts",
  // Auto-expires stale `proposed` opportunities (task #219). Walks
  // every tenant; flips rows older than `OPPORTUNITY_TTL_DAYS` (or
  // unrefreshed for `OPPORTUNITY_QUIET_CYCLES` cycles) to `expired`
  // so the pending-approvals queue stops growing forever.
  "expire_stale_opportunities",
  // Hourly housekeeping (task #228): clears stale `snoozed_until`
  // values whose deadline has already passed and writes a synthetic
  // `unsnooze` decision (actor='system') per affected row so audit
  // queries / reporting ("how many rows are currently snoozed?")
  // stay accurate. Display has always honoured the deadline via the
  // `snoozed_until <= now()` SQL filter; this job clears the column
  // itself so the data matches what the UI shows.
  "clear_expired_snoozes",
  "routing_health_check",
  // Nightly scan that compares each ready Defense Pack's frozen
  // `evidence_snapshot` against the current `market_signals` and flips
  // the per-pack `stale` flag when median cited drift exceeds the
  // configured threshold. The pack itself is never mutated; only the
  // staleness columns flip so the UI can surface a "Regenerate" CTA.
  "defense_pack_staleness_scan",
  // Data integrity assertions (task #314 — CFO Insurance). Runs the
  // eleven SQL reconciliation checks defined in
  // `tests/data-integrity/assertions.ts` against the live DB every
  // 15 minutes, persists every result to `data_integrity_audit_log`,
  // and raises an `operational_data_integrity_failed` alert per
  // failing assertion (deduped per assertion-name per UTC day).
  "data_integrity_check",
] as const;
export type JobKind = (typeof jobKindValues)[number];

/** Postgres-backed job queue (Phase 1). Pluggable; per-tenant rate limits. */
export const jobsTable = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").references(() => orgsTable.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").$type<JobKind>().notNull(),
    status: text("status").$type<JobStatus>().notNull().default("pending"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    result: jsonb("result")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    progress: integer("progress").notNull().default(0),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    /**
     * Maximum attempts (claims) before the job is permanently marked
     * `failed`. Defaults to 3 — a fresh enqueue counts as attempt #1, so
     * the worker will retry up to two more times on transient errors.
     */
    maxAttempts: integer("max_attempts").notNull().default(3),
    /**
     * Earliest time at which the worker is allowed to claim this job.
     * Used to implement exponential backoff: on a transient failure the
     * worker resets `status` back to `pending` and sets `scheduled_for`
     * to a future time. NULL means "ready immediately" (the common case
     * for freshly enqueued jobs).
     */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_org_idx").on(t.orgId),
    index("jobs_status_idx").on(t.status),
    index("jobs_kind_idx").on(t.kind),
    index("jobs_enqueued_at_idx").on(t.enqueuedAt),
    // Supports the periodic prune query
    // (`WHERE status = ? AND completed_at < ?`).
    index("jobs_status_completed_at_idx").on(t.status, t.completedAt),
    // Supports the worker's claim query, which filters pending jobs whose
    // `scheduled_for` has arrived (auto-retry backoff scheduling).
    index("jobs_scheduled_for_idx").on(t.scheduledFor),
  ],
);

export type JobRow = typeof jobsTable.$inferSelect;
export type InsertJobRow = typeof jobsTable.$inferInsert;
