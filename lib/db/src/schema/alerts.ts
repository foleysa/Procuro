import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Tenant-scoped alerts surfaced to operators (renewal-due, FX-spike, etc.).
 *
 * Every row is uniquely identified by `dedupeKey` per `(orgId, kind)` so
 * the same trigger condition (e.g. "contract abc renewal at 90d") cannot
 * produce two rows even if the daily worker runs twice. Producers
 * INSERT ... ON CONFLICT DO NOTHING using that key.
 *
 * Severity matches the renderer's class names; `kind` is a free-form
 * string so future producers (FX, supplier health, etc.) can register
 * without a schema change. `refType`/`refId` make the row clickable
 * back to a contract / supplier / opportunity detail.
 */
export const alertSeverityValues = [
  "info",
  "warning",
  "critical",
] as const;
export type AlertSeverity = (typeof alertSeverityValues)[number];

export const alertsTable = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    severity: text("severity")
      .$type<AlertSeverity>()
      .notNull()
      .default("info"),
    title: text("title").notNull(),
    body: text("body"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    /**
     * Producer-controlled idempotency key. Combined with `(org_id, kind)`
     * via `alerts_dedupe_uq` to guarantee at-most-one row per logical
     * trigger. Renewal worker uses `renewal:${contractId}:${threshold}`.
     */
    dedupeKey: text("dedupe_key").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("alerts_org_idx").on(t.orgId),
    index("alerts_org_kind_idx").on(t.orgId, t.kind),
    index("alerts_org_ref_idx").on(t.orgId, t.refType, t.refId),
    uniqueIndex("alerts_dedupe_uq").on(t.orgId, t.kind, t.dedupeKey),
  ],
);

export type AlertRow = typeof alertsTable.$inferSelect;
export type InsertAlertRow = typeof alertsTable.$inferInsert;
