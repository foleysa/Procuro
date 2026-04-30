import {
  pgTable,
  text,
  timestamp,
  integer,
  primaryKey,
} from "drizzle-orm/pg-core";
import { jobKindValues, type JobKind } from "./jobs";
import { orgsTable } from "./orgs";

/**
 * Per-tenant, per-kind retry-budget overrides.
 *
 * Operators can edit these from the System / Jobs page when an upstream
 * dependency for *their* tenant goes flaky and needs a longer (or
 * shorter) auto-retry budget than the in-code default. The composite
 * primary key `(org_id, kind)` ensures there is at most one override
 * per kind per org, and — crucially — that one tenant cannot affect
 * another tenant's retry behaviour.
 *
 * When no row exists for a given `(orgId, kind)`, the worker falls
 * back to `MAX_ATTEMPTS_BY_KIND` (defined in
 * `artifacts/api-server/src/lib/jobs/queue.ts`). Internal/system jobs
 * enqueued without an `orgId` (e.g. `prune_jobs`) always use the
 * in-code default since they have no tenant scope to look up against.
 */
export const jobKindSettingsTable = pgTable(
  "job_kind_settings",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    kind: text("kind").$type<JobKind>().notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /**
     * Email/identifier of the operator who last edited this override.
     * Captured from `req.actorEmail` (the resolved tenant actor) on the
     * write that produced the row. Surfaced in the System page so an
     * operator looking at a custom retry budget can see *who* made the
     * call to deviate from the default — important on a shared admin
     * surface where multiple humans can tune retries.
     */
    lastChangedBy: text("last_changed_by"),
    /**
     * Wall-clock timestamp of the most recent override write. Mirrors
     * `updatedAt` for now (drizzle's `$onUpdate` only fires on `.update`,
     * not on conflict-do-update upserts), but is set explicitly by the
     * route so the audit value is always accurate even when the row was
     * inserted via the upsert path.
     */
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.kind] }),
  }),
);

export type JobKindSettingRow = typeof jobKindSettingsTable.$inferSelect;
export type InsertJobKindSettingRow = typeof jobKindSettingsTable.$inferInsert;

export { jobKindValues };
