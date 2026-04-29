import {
  pgTable,
  text,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

export const agentStatusValues = ["active", "paused", "retired"] as const;
export type AgentStatusValue = (typeof agentStatusValues)[number];

export const agentsTable = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull(),
    kpiDefinition: text("kpi_definition").notNull(),
    status: text("status").$type<AgentStatusValue>().notNull().default("active"),
    ratePerOutcomeUsd: numeric("rate_per_outcome_usd", {
      precision: 14,
      scale: 2,
    })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("agents_org_idx").on(t.orgId)],
);

export type AgentRow = typeof agentsTable.$inferSelect;
export type InsertAgentRow = typeof agentsTable.$inferInsert;
