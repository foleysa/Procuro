import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { usersTable } from "./users";
import { suppliersTable } from "./suppliers";
import { contractsTable } from "./contracts";
import { opportunitiesTable } from "./opportunities";

/**
 * Alerts subsystem (#117).
 *
 * One alert row is the durable record of a "tell me when X happens"
 * trigger. Alerts move through a small lifecycle:
 *
 *   open → acknowledged → resolved
 *           ↓
 *         snoozed (until snoozedUntil) → open
 *
 * Every state change is logged in `alertEventsTable` so the detail
 * drawer can render an audit trail.
 *
 * `payload` is a free-form JSON blob owned by the alert source. By
 * convention it carries:
 *   - `sources`: InsightSource[] (matches the disclosure-tier renderer
 *     consumed by the existing `insight-citations` component)
 *   - any source-specific fields (sanctions list name, GDELT goldstein
 *     score, hazards alert level, etc.)
 *
 * `dedupeKey` lets the producer collapse repeat triggers (e.g. the same
 * sanctions hit observed across three OFAC re-runs) into a single
 * persistent alert with a bumped `occurrences` counter.
 */
export const alertSeverityValues = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type AlertSeverity = (typeof alertSeverityValues)[number];

/**
 * Provenance / category of the trigger. New sources can be added freely
 * — the inbox UI groups by this and the subscription matrix lets users
 * subscribe per source.
 */
export const alertSourceValues = [
  "sanctions",
  "corporate_filing",
  "disruption_event",
  "natural_hazard",
  "risk_screening",
  "operational_job_failed",
  "operational_collector_stale",
  "operational_collector_never_run",
  /**
   * The issuer-driven collectors (`sec-edgar`, `companies-house`)
   * resolve their poll list from one of three sources — `override`,
   * tenant-curated `watched_issuers` rows, or the built-in seed list.
   * A flip between these sources is silently load-bearing: a tenant
   * adding their first watched issuer drops the seed list, and
   * accidentally deleting every row brings it back. The on-call needs
   * to know which direction the flip happened in to triage. See the
   * "Issuer-list resolution" section of
   * `collectors-public-apis.md` for the runbook.
   */
  "operational_collector_issuer_list_flip",
  "operational_high_confidence_opportunity",
  "rule_match",
  "manual",
] as const;
export type AlertSource = (typeof alertSourceValues)[number];

export const alertStateValues = [
  "open",
  "acknowledged",
  "snoozed",
  "resolved",
] as const;
export type AlertState = (typeof alertStateValues)[number];

export const alertsTable = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    severity: text("severity").$type<AlertSeverity>().notNull(),
    source: text("source").$type<AlertSource>().notNull(),
    /** Producer-defined sub-kind (e.g. "ofac_sdn_match", "gdelt_disruption"). */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    /**
     * Stable de-dup key. When a producer re-emits a trigger, a row with
     * a matching `(org_id, dedupe_key)` is bumped (`occurrences++`,
     * `lastSeenAt = now`) instead of inserting a new row. Producers
     * that don't supply a key always create a fresh alert.
     */
    dedupeKey: text("dedupe_key"),
    occurrences: integer("occurrences").notNull().default(1),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Resolved canonical entity uid (from entities BQ table) when known. */
    entityUid: text("entity_uid"),
    supplierId: text("supplier_id").references(() => suppliersTable.id, {
      onDelete: "set null",
    }),
    contractId: text("contract_id").references(() => contractsTable.id, {
      onDelete: "set null",
    }),
    opportunityId: text("opportunity_id").references(
      () => opportunitiesTable.id,
      { onDelete: "set null" },
    ),
    state: text("state")
      .$type<AlertState>()
      .notNull()
      .default("open"),
    assignedToUserId: text("assigned_to_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    /**
     * Has the delivery worker fanned this alert out to subscribers yet?
     * We bump this once the `deliver_alerts` job has enqueued one
     * `alertDeliveriesTable` row per matching subscription. Subsequent
     * re-emissions of the same `(org_id, dedupe_key)` do not re-fan
     * out — that would spam users on bursty re-runs.
     */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /**
     * Has the escalation worker already escalated this alert? Same
     * idempotency reason as `deliveredAt` — we never escalate twice.
     */
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("alerts_org_idx").on(t.orgId),
    index("alerts_state_idx").on(t.orgId, t.state),
    index("alerts_severity_idx").on(t.orgId, t.severity),
    index("alerts_source_idx").on(t.orgId, t.source),
    index("alerts_supplier_idx").on(t.supplierId),
    index("alerts_entity_uid_idx").on(t.entityUid),
    index("alerts_created_at_idx").on(t.createdAt),
    /**
     * Dedupe uniqueness: at most one alert per (org, dedupe_key). Rows
     * without a dedupeKey are exempt because two NULLs are not equal in
     * Postgres' default uniqueness semantics, which is exactly the
     * "always insert" behaviour producers without a key want.
     */
    uniqueIndex("alerts_dedupe_uq").on(t.orgId, t.dedupeKey),
  ],
);

export type AlertRow = typeof alertsTable.$inferSelect;
export type InsertAlertRow = typeof alertsTable.$inferInsert;

/** Audit log of every state transition / comment on an alert. */
export const alertEventTypeValues = [
  "created",
  "occurrence",
  "acknowledged",
  "snoozed",
  "resolved",
  "reopened",
  "assigned",
  "comment",
  "delivered",
  "escalated",
  "delivery_failed",
] as const;
export type AlertEventType = (typeof alertEventTypeValues)[number];

export const alertEventsTable = pgTable(
  "alert_events",
  {
    id: text("id").primaryKey(),
    alertId: text("alert_id")
      .notNull()
      .references(() => alertsTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").$type<AlertEventType>().notNull(),
    actor: text("actor"),
    note: text("note"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("alert_events_alert_idx").on(t.alertId),
    index("alert_events_created_at_idx").on(t.createdAt),
  ],
);

export type AlertEventRow = typeof alertEventsTable.$inferSelect;
export type InsertAlertEventRow = typeof alertEventsTable.$inferInsert;

/**
 * Notification channels. One row = one configured destination (an
 * email address book entry, a webhook URL, a Slack workspace, …).
 *
 * `config` carries channel-kind-specific fields:
 *   - email: { to: string }
 *   - webhook: { url: string, signingSecret: string, contentType?: string }
 *   - slack: { webhookUrl: string } (stub; H2.6)
 *   - teams: { webhookUrl: string } (stub; H2.6)
 */
export const alertChannelKindValues = [
  "email",
  "webhook",
  "slack",
  "teams",
] as const;
export type AlertChannelKind = (typeof alertChannelKindValues)[number];

export const alertChannelsTable = pgTable(
  "alert_channels",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AlertChannelKind>().notNull(),
    name: text("name").notNull(),
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("alert_channels_org_idx").on(t.orgId)],
);

export type AlertChannelRow = typeof alertChannelsTable.$inferSelect;
export type InsertAlertChannelRow = typeof alertChannelsTable.$inferInsert;

/**
 * Per-user subscription preferences. When an alert is created, the
 * delivery worker selects every (enabled) subscription whose:
 *   - severity threshold ≤ alert severity
 *   - sources (NULL = all) includes the alert source
 *   - watchlist (NULL = all) matches via supplier or entity_uid
 * and enqueues one delivery row per (subscription, channel).
 */
export const alertDigestModeValues = ["realtime", "daily"] as const;
export type AlertDigestMode = (typeof alertDigestModeValues)[number];

export const alertSubscriptionsTable = pgTable(
  "alert_subscriptions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => alertChannelsTable.id, { onDelete: "cascade" }),
    severityThreshold: text("severity_threshold")
      .$type<AlertSeverity>()
      .notNull()
      .default("medium"),
    /** Allowed sources; NULL = any source. */
    sources: jsonb("sources").$type<AlertSource[] | null>().default(null),
    /** Optional watchlist filter (only deliver when alert hits a member). */
    watchlistId: text("watchlist_id"),
    digest: text("digest")
      .$type<AlertDigestMode>()
      .notNull()
      .default("realtime"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("alert_subscriptions_org_idx").on(t.orgId),
    index("alert_subscriptions_user_idx").on(t.userId),
    index("alert_subscriptions_channel_idx").on(t.channelId),
  ],
);

export type AlertSubscriptionRow = typeof alertSubscriptionsTable.$inferSelect;
export type InsertAlertSubscriptionRow =
  typeof alertSubscriptionsTable.$inferInsert;

/** Saved supplier groups. Owned by a user (personal) or NULL (team). */
export const watchlistScopeValues = ["personal", "team"] as const;
export type WatchlistScope = (typeof watchlistScopeValues)[number];

export const watchlistsTable = pgTable(
  "watchlists",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    /** NULL when scope='team'. */
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    scope: text("scope").$type<WatchlistScope>().notNull().default("personal"),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("watchlists_org_idx").on(t.orgId),
    index("watchlists_user_idx").on(t.userId),
  ],
);

export type WatchlistRow = typeof watchlistsTable.$inferSelect;
export type InsertWatchlistRow = typeof watchlistsTable.$inferInsert;

/**
 * A watchlist member is identified by EITHER a tenant supplier_id
 * (operational, joins to local data) OR an entity_uid (canonical
 * upstream identifier, useful for "watch a supplier we don't onboard
 * yet" scenarios). At least one of the two must be set; both may be
 * set when the supplier has been resolved to a canonical entity.
 *
 * Empty string is the sentinel for "unset" — both columns are NOT
 * NULL so we can include them in a uniqueness constraint without
 * tripping over Postgres' NULL ≠ NULL semantics that would otherwise
 * silently allow duplicates.
 */
export const watchlistMembersTable = pgTable(
  "watchlist_members",
  {
    id: text("id").primaryKey(),
    watchlistId: text("watchlist_id")
      .notNull()
      .references(() => watchlistsTable.id, { onDelete: "cascade" }),
    /** Tenant supplier id; "" sentinel when unset. */
    supplierId: text("supplier_id").notNull().default(""),
    /** Canonical entity uid; "" sentinel when unset. */
    entityUid: text("entity_uid").notNull().default(""),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("watchlist_members_uq").on(
      t.watchlistId,
      t.supplierId,
      t.entityUid,
    ),
    index("watchlist_members_supplier_idx").on(t.supplierId),
    index("watchlist_members_entity_uid_idx").on(t.entityUid),
  ],
);

export type WatchlistMemberRow = typeof watchlistMembersTable.$inferSelect;
export type InsertWatchlistMemberRow =
  typeof watchlistMembersTable.$inferInsert;

/**
 * Alert rules. A rule is a tenant-defined trigger that synthesises an
 * alert from an upstream signal. The MVP supports a small condition DSL
 * stored in `condition`:
 *
 *   {
 *     "anyOfSources": ["sanctions", "natural_hazard"],
 *     "minSeverity": "high",          // optional severity gate
 *     "supplierIds": ["sup_..."],     // optional explicit supplier list
 *     "watchlistId": "wl_..."         // optional watchlist filter
 *   }
 *
 * Rules are evaluated by the alert producer (collector fan-out, ops
 * synthesizer) BEFORE persisting — a rule that doesn't match is a
 * no-op, a rule that matches contributes its `severity` (overriding
 * the producer's default) and tags the alert with `source = rule_match`.
 */
export const alertRulesTable = pgTable(
  "alert_rules",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    severity: text("severity").$type<AlertSeverity>().notNull().default("medium"),
    condition: jsonb("condition")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    watchlistId: text("watchlist_id").references(() => watchlistsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("alert_rules_org_idx").on(t.orgId)],
);

export type AlertRuleRow = typeof alertRulesTable.$inferSelect;
export type InsertAlertRuleRow = typeof alertRulesTable.$inferInsert;

/**
 * Escalation policies. After `unackedHours` an alert at severity
 * ≥ `severityAtLeast` that is still in `state='open'` is escalated to
 * `escalateToUserId` via `channelId` (and an `alertEvents` row is
 * appended). Each alert is escalated at most once.
 */
export const escalationPoliciesTable = pgTable(
  "escalation_policies",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    severityAtLeast: text("severity_at_least")
      .$type<AlertSeverity>()
      .notNull()
      .default("high"),
    /**
     * Numeric hours threshold. Stored as integer hours so the worker can
     * compute `now() - first_seen_at >= interval 'N hour'` without any
     * sub-hour precision games. Operators that want minutes can
     * configure 1h and call it a day.
     */
    unackedHours: integer("unacked_hours").notNull().default(4),
    escalateToUserId: text("escalate_to_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    channelId: text("channel_id").references(() => alertChannelsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("escalation_policies_org_idx").on(t.orgId)],
);

export type EscalationPolicyRow = typeof escalationPoliciesTable.$inferSelect;
export type InsertEscalationPolicyRow =
  typeof escalationPoliciesTable.$inferInsert;

/**
 * Per-(alert, subscription, channel) delivery attempt. The delivery
 * worker reads outstanding alerts, computes matching subscriptions,
 * inserts one row per channel here in `pending` state, then drains
 * rows by invoking the channel adapter. Idempotency: at most one row
 * per `(alert_id, subscription_id, channel_id)` so a re-run of the
 * worker doesn't double-send.
 */
export const alertDeliveryStateValues = [
  "pending",
  "sent",
  "failed",
  "skipped",
] as const;
export type AlertDeliveryState = (typeof alertDeliveryStateValues)[number];

export const alertDeliveriesTable = pgTable(
  "alert_deliveries",
  {
    id: text("id").primaryKey(),
    alertId: text("alert_id")
      .notNull()
      .references(() => alertsTable.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => alertSubscriptionsTable.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => alertChannelsTable.id, { onDelete: "cascade" }),
    state: text("state")
      .$type<AlertDeliveryState>()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("alert_deliveries_uq").on(
      t.alertId,
      t.subscriptionId,
      t.channelId,
    ),
    index("alert_deliveries_state_idx").on(t.state),
    index("alert_deliveries_alert_idx").on(t.alertId),
  ],
);

export type AlertDeliveryRow = typeof alertDeliveriesTable.$inferSelect;
export type InsertAlertDeliveryRow = typeof alertDeliveriesTable.$inferInsert;
