import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { suppliersTable } from "./suppliers";

/**
 * Append-only audit log for inline edits applied to a supplier.
 *
 * Mirrors `contract_audit_log` (see contracts skill for the same pattern):
 * every PATCH /suppliers/:id writes one row per changed field with the old
 * and new values, the actor email, and the change timestamp. The
 * Supplier 360 page renders these in the Activity tab so reviewers can
 * answer "who flipped this supplier to strategic, when, and why?"
 * without crawling DB backups.
 */
export const supplierAuditLogTable = pgTable(
  "supplier_audit_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "cascade" }),
    actorEmail: text("actor_email").notNull(),
    field: text("field").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("supplier_audit_log_supplier_idx").on(t.supplierId),
    index("supplier_audit_log_org_idx").on(t.orgId),
  ],
);

export type SupplierAuditLogRow = typeof supplierAuditLogTable.$inferSelect;
export type InsertSupplierAuditLogRow =
  typeof supplierAuditLogTable.$inferInsert;
