import {
  pgTable,
  text,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import type { UserRoleName } from "./userRoles";

/**
 * Per-tenant programmatic API keys issued by Org Admins. Distinct from
 * `org_api_tokens` (legacy bearer tokens for system-to-system calls):
 * `api_keys` are user-issued, role-scoped, rotatable, and individually
 * revocable, and they record human-friendly metadata (label, creator,
 * scoped role, last-used).
 *
 * The plaintext secret is shown to the operator exactly once at creation.
 * Only the sha256 hash is stored. To enable a "key prefix" preview in the
 * UI without leaking, we also store the first 8 chars (the `proc_xxxxxxxx`
 * portion before the entropy) which is non-sensitive on its own.
 */
export const apiKeysTable = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** Visible prefix (e.g. `proc_aBcD1234`) for UI preview. */
    prefix: text("prefix").notNull(),
    /** sha256 hash of the full plaintext key. */
    tokenHash: text("token_hash").notNull(),
    /**
     * Role this key acts as when authenticating. Most keys are issued as
     * `analyst` for read-mostly automation; only an org-admin should issue
     * an `org_admin` key for full-tenant control.
     */
    scopeRole: text("scope_role").$type<UserRoleName>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    /** Optional rotation chain: the id of the key that supersedes this one. */
    rotatedFromId: text("rotated_from_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => [
    index("api_keys_org_idx").on(t.orgId),
    index("api_keys_hash_idx").on(t.tokenHash),
  ],
);

export type ApiKeyRow = typeof apiKeysTable.$inferSelect;
export type InsertApiKeyRow = typeof apiKeysTable.$inferInsert;
