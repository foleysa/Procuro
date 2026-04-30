import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { contractsTable } from "./contracts";

/**
 * Append-only audit log for inline edits applied to a contract.
 *
 * Every PATCH /contracts/:id writes one row per changed field with the
 * old and new values, the actor email, and the change timestamp. The
 * detail page renders these in a tab so reviewers can answer "who set
 * the renewal target action and when?" without crawling DB backups.
 */
export const contractAuditLogTable = pgTable(
  "contract_audit_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    contractId: text("contract_id")
      .notNull()
      .references(() => contractsTable.id, { onDelete: "cascade" }),
    actorEmail: text("actor_email").notNull(),
    field: text("field").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("contract_audit_log_contract_idx").on(t.contractId),
    index("contract_audit_log_org_idx").on(t.orgId),
  ],
);

export type ContractAuditLogRow = typeof contractAuditLogTable.$inferSelect;
export type InsertContractAuditLogRow =
  typeof contractAuditLogTable.$inferInsert;
