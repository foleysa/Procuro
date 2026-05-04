import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const a11yImpactValues = [
  "critical",
  "serious",
  "moderate",
  "minor",
] as const;
export type A11yImpact = (typeof a11yImpactValues)[number];

export const a11yScanResultsTable = pgTable(
  "a11y_scan_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    route: text("route").notNull(),
    routeName: text("route_name").notNull(),
    totalViolations: integer("total_violations").notNull(),
    criticalCount: integer("critical_count").notNull().default(0),
    seriousCount: integer("serious_count").notNull().default(0),
    moderateCount: integer("moderate_count").notNull().default(0),
    minorCount: integer("minor_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    baselinedCount: integer("baselined_count").notNull().default(0),
    totalNodes: integer("total_nodes").notNull().default(0),
    violations: jsonb("violations")
      .$type<
        Array<{
          id: string;
          impact: string;
          description: string;
          helpUrl: string;
          nodeCount: number;
        }>
      >()
      .notNull()
      .default([]),
  },
  (t) => [
    index("a11y_scan_run_id_idx").on(t.runId),
    index("a11y_scan_scanned_at_idx").on(t.scannedAt.desc()),
    index("a11y_scan_route_time_idx").on(t.route, t.scannedAt.desc()),
  ],
);

export type A11yScanResultRow = typeof a11yScanResultsTable.$inferSelect;
export type InsertA11yScanResultRow = typeof a11yScanResultsTable.$inferInsert;
