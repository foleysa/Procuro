import {
  pgTable,
  text,
  timestamp,
  jsonb,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

export const onboardingWizardSteps = [
  "welcome",
  "bring_data",
  "map_categories",
  "invite_team",
  "configure_settings",
  "run_first_cycle",
  "completed",
] as const;
export type OnboardingWizardStep = (typeof onboardingWizardSteps)[number];

export interface CompletedStepEntry {
  step: OnboardingWizardStep;
  completedAt: string;
}

export const onboardingStateTable = pgTable(
  "onboarding_state",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    userEmail: text("user_email").notNull(),
    currentStep: text("current_step")
      .$type<OnboardingWizardStep>()
      .notNull()
      .default("welcome"),
    completedSteps: jsonb("completed_steps")
      .$type<CompletedStepEntry[]>()
      .notNull()
      .default([]),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userEmail] }),
    index("onboarding_state_org_idx").on(t.orgId),
  ],
);

export type OnboardingStateRow = typeof onboardingStateTable.$inferSelect;
export type InsertOnboardingStateRow =
  typeof onboardingStateTable.$inferInsert;
