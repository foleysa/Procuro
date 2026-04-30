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
