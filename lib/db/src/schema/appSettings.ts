import {
  pgTable,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Cross-tenant key/value settings store for system-scoped knobs that
 * Platform Admins can tune at runtime without redeploying.
 *
 * Each row is keyed by a small string identifier (`job_prune_schedule`,
 * etc.) and stores its config as a JSONB blob so future settings can
 * grow new fields without a migration. The schedulers in
 * `lib/jobs/queue.ts` read these rows at startup and on update so a
 * change persists across server restarts.
 *
 * Cross-tenant by design — no `org_id` column. Writes go through
 * platform-admin-gated routes; reads are open to any backend caller.
 *
 * Audit fields:
 *   - `lastChangedBy` records the operator email for the most recent
 *     write (so a platform admin reviewing the System page can see
 *     who tuned the value).
 *   - `lastChangedAt` is set explicitly by the route on every write,
 *     mirroring `updatedAt` but reliable through the `ON CONFLICT
 *     DO UPDATE` upsert path that drizzle's `$onUpdate` does not
 *     observe.
 */
export const appSettingsTable = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  lastChangedBy: text("last_changed_by"),
  lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
});

export type AppSettingRow = typeof appSettingsTable.$inferSelect;
export type InsertAppSettingRow = typeof appSettingsTable.$inferInsert;

/** Stable key for the periodic `prune_jobs` cleanup schedule. */
export const APP_SETTING_KEY_JOB_PRUNE_SCHEDULE = "job_prune_schedule" as const;
