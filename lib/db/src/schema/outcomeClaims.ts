import {
  pgTable,
  text,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { agentsTable } from "./agents";

export const claimStatusValues = [
  "claimed",
  "verified",
  "denied",
  "invoiced",
] as const;
export type ClaimStatusValue = (typeof claimStatusValues)[number];

export const outcomeClaimsTable = pgTable(
  "outcome_claims",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "restrict" }),
    claimType: text("claim_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    evidenceUrl: text("evidence_url"),
    evidenceLabel: text("evidence_label"),
    estimatedValueUsd: numeric("estimated_value_usd", {
      precision: 14,
      scale: 2,
    })
      .notNull()
      .default("0"),
    status: text("status").$type<ClaimStatusValue>().notNull().default("claimed"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    denialReason: text("denial_reason"),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("claims_org_idx").on(t.orgId),
    index("claims_agent_idx").on(t.agentId),
    index("claims_status_idx").on(t.status),
    index("claims_claimed_at_idx").on(t.claimedAt),
  ],
);

export type OutcomeClaimRow = typeof outcomeClaimsTable.$inferSelect;
export type InsertOutcomeClaimRow = typeof outcomeClaimsTable.$inferInsert;

export const claimEventTypes = [
  "claimed",
  "verified",
  "denied",
  "invoiced",
] as const;
export type ClaimEventType = (typeof claimEventTypes)[number];

export const claimEventsTable = pgTable(
  "claim_events",
  {
    id: text("id").primaryKey(),
    claimId: text("claim_id")
      .notNull()
      .references(() => outcomeClaimsTable.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").$type<ClaimEventType>().notNull(),
    actor: text("actor").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("claim_events_claim_idx").on(t.claimId),
    index("claim_events_org_idx").on(t.orgId),
    index("claim_events_created_at_idx").on(t.createdAt),
  ],
);

export type ClaimEventRow = typeof claimEventsTable.$inferSelect;
export type InsertClaimEventRow = typeof claimEventsTable.$inferInsert;
