import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Maturity ratings for an entry in the Methods & Tools registry.
 *
 * - `proven`     — used in production, repeatable, well-understood.
 * - `emerging`   — in active rollout, evidence of value, still maturing.
 * - `first_run`  — pilot / first-time use; results not yet generalised.
 *
 * Stored as the snake_case enum value; the API and UI render the
 * Title-Case label ("Proven" / "Emerging" / "First-Run").
 */
export const methodsAndToolsMaturityValues = [
  "proven",
  "emerging",
  "first_run",
] as const;
export type MethodsAndToolsMaturity =
  (typeof methodsAndToolsMaturityValues)[number];

/**
 * Tenant-scoped Methods & Tools registry — the editable canonical
 * mapping of sourcing strategy → method → tool/system → maturity that
 * the dashboard's reference card surfaces. Replaces the previously
 * hard-coded list inside `MethodsAndTools.tsx` (Task #291) so operators
 * can add new entries, update existing ones, and progress maturity
 * ratings as their procurement practice matures.
 *
 * Uniqueness is `(orgId, sourcingStrategy)` — a tenant cannot have two
 * rows for the same sourcing-strategy label. Two tenants can
 * independently keep their own registries.
 */
export const methodsAndToolsTable = pgTable(
  "methods_and_tools",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    sourcingStrategy: text("sourcing_strategy").notNull(),
    method: text("method").notNull(),
    toolSystem: text("tool_system").notNull(),
    maturity: text("maturity")
      .$type<MethodsAndToolsMaturity>()
      .notNull()
      .default("emerging"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("methods_and_tools_strategy_uq").on(t.orgId, t.sourcingStrategy),
    index("methods_and_tools_org_idx").on(t.orgId),
  ],
);

export type MethodsAndToolsRow = typeof methodsAndToolsTable.$inferSelect;
export type InsertMethodsAndToolsRow = typeof methodsAndToolsTable.$inferInsert;
