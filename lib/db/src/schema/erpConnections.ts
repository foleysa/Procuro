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
 * Per-tenant ERP/source-system connections that the platform syncs
 * structured procurement data from (suppliers, contracts, POs, invoices,
 * payments). Distinct from market-intel `collectors` (which fetch
 * external market signals) and the `csv` ingest path (which just lands
 * a one-off file).
 *
 * Credentials are AES-GCM encrypted at rest using
 * `ERP_CREDENTIAL_ENCRYPTION_KEY` (see `lib/erp/crypto.ts`); no plain
 * secrets ever land in this table. The encrypted payload includes the
 * IV+tag so a decrypt of any single row is self-contained.
 *
 * Watermarks live alongside the connection so each adapter can ask
 * "what's my last successful per-entity sync timestamp?" and request
 * only changed rows on the next pass.
 */
export const erpConnectionStatusValues = [
  "active",
  "paused",
  "error",
] as const;
export type ErpConnectionStatus = (typeof erpConnectionStatusValues)[number];

/**
 * Stable adapter keys. Each entry maps to an `ErpConnector`
 * implementation registered at boot. The set is closed at the schema
 * level so a typo in the API never produces a row that no adapter can
 * service.
 */
export const erpAdapterKeyValues = ["coupa"] as const;
export type ErpAdapterKey = (typeof erpAdapterKeyValues)[number];

/**
 * Per-entity high-watermark map. Each key is an entity name the
 * connector returns (e.g. "suppliers", "contracts", "purchase_orders",
 * "invoices", "payments") and the value is an ISO-8601 timestamp the
 * next incremental pass should pass back to the upstream as `since`.
 */
export type ErpWatermarks = Record<string, string>;

export const erpConnectionsTable = pgTable(
  "erp_connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    /** Operator-facing label (e.g. "Coupa Production"). */
    label: text("label").notNull(),
    /** Adapter key — must match a registered `ErpConnector.key`. */
    adapterKey: text("adapter_key").$type<ErpAdapterKey>().notNull(),
    status: text("status")
      .$type<ErpConnectionStatus>()
      .notNull()
      .default("active"),
    /**
     * AES-256-GCM ciphertext of the JSON-encoded credentials object.
     * Layout: `iv(12 bytes).ciphertext.authTag(16 bytes)` base64-encoded.
     * Decrypted shape is adapter-specific (see e.g.
     * `CoupaCredentials`).
     */
    credentialsCipher: text("credentials_cipher").notNull(),
    /**
     * Non-secret connection settings (e.g. base URL, scope hint, page
     * size override). Stored in the clear so an operator inspecting the
     * row can see what's wired up without a decrypt key.
     */
    settings: jsonb("settings")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    watermarks: jsonb("watermarks")
      .$type<ErpWatermarks>()
      .notNull()
      .default({}),
    /** Last sync that ended with a non-error result. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** Most recent error string surfaced by the worker, if any. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("erp_connections_org_idx").on(t.orgId),
    // (org, label) is the operator-visible identity for editing /
    // re-using a connection from the UI; keep it unique so the form
    // can rely on label for diff/upsert.
    uniqueIndex("erp_connections_org_label_uidx").on(t.orgId, t.label),
  ],
);

export type ErpConnectionRow = typeof erpConnectionsTable.$inferSelect;
export type InsertErpConnectionRow = typeof erpConnectionsTable.$inferInsert;
