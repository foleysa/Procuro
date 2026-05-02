import {
  pgTable,
  text,
  timestamp,
  numeric,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const orgsTable = pgTable(
  "orgs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    successFeePct: numeric("success_fee_pct", { precision: 5, scale: 2 })
      .notNull()
      .default("20.00"),
    /**
     * ISO 4217 reporting currency for the tenant. All `*_usd` columns elsewhere
     * are stored as USD-normalized; this column tells downstream analyzers
     * (e.g. supplier FX-exposure) which currency they should compare against
     * when checking whether a supplier's billing currency has moved.
     */
    baseCurrency: text("base_currency").notNull().default("USD"),
    settings: jsonb("settings")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type Org = typeof orgsTable.$inferSelect;
export type InsertOrg = typeof orgsTable.$inferInsert;

/**
 * Per-tenant API tokens. Bearer tokens presented by callers are sha256-hashed
 * and matched against `tokenHash`. A single org can have multiple active
 * tokens (rotation, per-environment, etc.). Token PKs are `text` like every
 * other PK in this schema.
 */
export const orgApiTokensTable = pgTable(
  "org_api_tokens",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    label: text("label").notNull().default("default"),
    tokenHash: text("token_hash").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("org_api_tokens_org_idx").on(t.orgId),
    index("org_api_tokens_hash_idx").on(t.tokenHash),
  ],
);

export type OrgApiToken = typeof orgApiTokensTable.$inferSelect;
export type InsertOrgApiToken = typeof orgApiTokensTable.$inferInsert;

/**
 * Append-only audit log for tenant-wide preference changes made via
 * `PATCH /me/settings`. Mirrors the `collector_audit_log` /
 * `supplier_audit_log` pattern: one row per changed key with the
 * old and new values, the actor email, and the change timestamp.
 *
 * The disclosure policy is the canonical example — flipping it to
 * `analyst` immediately exposes T3/T4 signals to every member of the
 * tenant, so ops needs to be able to answer "who changed this and
 * when?" without crawling DB backups. Other keys (e.g.
 * `contractRenewalAlertDays`) ride the same table.
 */
export const orgSettingsAuditLogTable = pgTable(
  "org_settings_audit_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    actorEmail: text("actor_email").notNull(),
    /** Settings key that changed, e.g. `disclosurePolicy`. */
    key: text("key").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("org_settings_audit_log_org_idx").on(t.orgId),
    index("org_settings_audit_log_created_at_idx").on(t.createdAt),
  ],
);

export type OrgSettingsAuditLogRow =
  typeof orgSettingsAuditLogTable.$inferSelect;
export type InsertOrgSettingsAuditLogRow =
  typeof orgSettingsAuditLogTable.$inferInsert;
