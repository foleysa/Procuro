import {
  pgTable,
  text,
  timestamp,
  index,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

export const jobStatusValues = [
  "pending",
  "running",
  "succeeded",
  "failed",
] as const;
export type JobStatus = (typeof jobStatusValues)[number];

export const jobKindValues = [
  "ingest_csv",
  "ingest_mock_erp",
  "run_analysis_cycle",
  "run_collector",
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
  ],
);

export type JobRow = typeof jobsTable.$inferSelect;
export type InsertJobRow = typeof jobsTable.$inferInsert;
