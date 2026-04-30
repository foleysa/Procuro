import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

export const userRoles = ["admin", "buyer", "approver", "viewer"] as const;
export type UserRole = (typeof userRoles)[number];

export const usersTable = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role").$type<UserRole>().notNull().default("buyer"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("users_org_idx").on(t.orgId), index("users_email_idx").on(t.email)],
);

export type UserRow = typeof usersTable.$inferSelect;
export type InsertUserRow = typeof usersTable.$inferInsert;
