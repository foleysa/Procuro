import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Data integrity audit log (Task #314 — CFO Insurance).
 *
 * One row per assertion per run. Written by both the in-process job
 * handler (`data_integrity_check`, scheduled every 15min) and the
 * standalone `pnpm data-integrity` runner. Existence of a recent
 * `passed=false` row drives Slack alert synthesis.
 *
 * Indexes are tuned for the two read patterns:
 *   - "what is the latest run?" (`run_at DESC`)
 *   - "show me the trend for assertion X" (`assertion_name, run_at DESC`)
 *   - "any active failures?" (partial index `WHERE passed = false`)
 *
 * The table is append-only — there is no update path. Trim with a
 * future retention job if it grows unbounded; eleven assertions × four
 * runs/hour ≈ 1k rows/day, which is comfortable for the foreseeable
 * future.
 */
export const triggeredByValues = [
  "scheduled",
  "post_migration",
  "manual",
] as const;
export type DataIntegrityTriggeredBy = (typeof triggeredByValues)[number];

export const assertionFamilyValues = [
  "aggregate",
  "savings_type",
  "stage_history",
  "gating",
] as const;
export type AssertionFamily = (typeof assertionFamilyValues)[number];

export const dataIntegrityAuditLogTable = pgTable(
  "data_integrity_audit_log",
  {
    id: text("id").primaryKey(),
    runAt: timestamp("run_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Stable assertion identifier (e.g. `hard_savings_aggregate_excludes_review_flagged`). */
    assertionName: text("assertion_name").notNull(),
    family: text("family").$type<AssertionFamily>().notNull(),
    passed: boolean("passed").notNull(),
    /** Structured actual values returned by the SQL probe. */
    actual: jsonb("actual")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Human-readable expected condition. */
    expected: text("expected").notNull(),
    /** Human-readable result message (used in Slack alert body). */
    message: text("message").notNull(),
    triggeredBy: text("triggered_by")
      .$type<DataIntegrityTriggeredBy>()
      .notNull()
      .default("scheduled"),
  },
  (t) => [
    index("data_integrity_run_at_idx").on(t.runAt.desc()),
    index("data_integrity_assertion_run_idx").on(
      t.assertionName,
      t.runAt.desc(),
    ),
    // Fast lookup of currently-failing assertions; partial so the
    // index stays tiny in the (hopefully) common case where every
    // assertion is passing.
    index("data_integrity_failures_idx")
      .on(t.assertionName, t.runAt.desc())
      .where(sql`passed = false`),
  ],
);

export type DataIntegrityAuditLogRow =
  typeof dataIntegrityAuditLogTable.$inferSelect;
export type InsertDataIntegrityAuditLogRow =
  typeof dataIntegrityAuditLogTable.$inferInsert;
