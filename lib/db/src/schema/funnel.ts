import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { analysisCyclesTable } from "./cycles";

/**
 * Per-tenant per-cycle persistent funnel snapshot powering admin
 * observability v1 (task #185). Captures the full 10-stage OODA pipeline
 * each cycle so we can audit drop-offs, prior calibration, and cohort
 * realization without rebuilding state from raw decision events.
 *
 *  Stage order (mirrors `stages` JSON keys):
 *    1. signals_collected         (Observe)
 *    2. signals_mapped_to_levers  (Orient)
 *    3. signals_analyzed          (Decide pre-rank)
 *    4. drafts_produced           (Decide post-rank, pre-exclusion)
 *    5. drafts_post_exclusion     (Decide post-exclusion)
 *    6. opps_persisted            (Act)
 *    7. opps_approved_*           (cohort 7d/30d/90d windows)
 *    8. opps_executed_*           (cohort 7d/30d/90d windows)
 *    9. opps_realized_*           (cohort 7d/30d/90d windows)
 *   10. priors_updated            (Learn)
 *
 *  Cohort identity tuple: `(lever_id, primary_entity_id, lever_specific_key)`
 *  resolved by each lever's `cohortKey()`. Persisted under `cohorts.{window}`
 *  as `[{ key, count }]` arrays so the admin UI can drill into the actual
 *  identities, not just totals.
 *
 *  Retention: snapshot rows older than the configured window (default
 *  365 days) are purged daily by the `prune_funnel_snapshots` job, which
 *  also prunes `funnel_snapshot_failures` older than its own window
 *  (default 90 days). See `lib/jobs/queue.ts` for retention helpers.
 */
export const funnelSnapshotsTable = pgTable(
  "funnel_snapshots",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    cycleId: text("cycle_id")
      .notNull()
      .references(() => analysisCyclesTable.id, { onDelete: "cascade" }),
    cycleGeneration: integer("cycle_generation").notNull(),
    /**
     * 10-stage counts. JSON-typed so the shape can grow without a
     * migration; the snapshot writer is the single producer and the
     * REST handler the single consumer, so a typed view sits in
     * `lib/ooda/funnel.ts`.
     *
     *   stages.signals_collected: { count, capped, sample_ids: string[] }
     *   stages.signals_mapped_to_levers: { count, by_lever: Record<lever, n>, sample_ids }
     *   stages.signals_analyzed: { count, by_lever, sample_ids }
     *   stages.drafts_produced: { count, by_lever, sample_drafts }
     *   stages.drafts_post_exclusion: { count, dropped_by_exclusion, by_lever, sample_drafts }
     *   stages.opps_persisted: { count, by_lever, total_projected_usd, sample_ids }
     *   stages.opps_approved_7d / _30d / _90d: { count, by_lever, sample_ids }
     *   stages.opps_executed_7d / _30d / _90d: { count, by_lever, sample_ids }
     *   stages.opps_realized_7d / _30d / _90d: { count, by_lever, total_realized_usd, sample_ids }
     *   stages.priors_updated: { count, by_lever, deltas }
     */
    stages: jsonb("stages")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /**
     * Cohort identity drill-down per (window). Each entry is
     * `{ window: '7d'|'30d'|'90d', key: '<lever>:<primaryEntity>:<leverKey>', count }`.
     * Captured at snapshot time and bounded by the per-stage caps; admins
     * use this to see WHO the realized cohort was, not just how many.
     */
    cohorts: jsonb("cohorts")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /**
     * Per-lever calibration metrics computed on the trailing 30d/90d
     * realized cohort:
     *   { '<lever>': {
     *       window: '30d'|'90d',
     *       n: number,
     *       rawMedianAbsErrorUsd: number,
     *       rescaledMedianAbsErrorUsd: number,
     *       improvementUsd: number,             // raw - rescaled
     *       verdict: 'helping'|'hurting'|'neutral'|'insufficient_evidence',
     *     } }
     * Verdict is gated on n >= 10. helping when improvement > $100 in
     * the buyer's favor; hurting when improvement < -$100; neutral
     * otherwise.
     */
    calibration: jsonb("calibration")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Cycle-level totals lifted up so trend queries don't need to read `stages`. */
    totalDraftsProduced: integer("total_drafts_produced").notNull().default(0),
    totalDraftsPostExclusion: integer("total_drafts_post_exclusion")
      .notNull()
      .default(0),
    totalOppsPersisted: integer("total_opps_persisted").notNull().default(0),
    totalProjectedUsd: numeric("total_projected_usd", {
      precision: 18,
      scale: 2,
    })
      .notNull()
      .default("0"),
    /** Wall-clock duration of the snapshot capture itself (ms). */
    captureDurationMs: integer("capture_duration_ms").notNull().default(0),
    /** Set when a behavioural delta detector fires (so admin can filter). */
    hasAutoAnnotation: integer("has_auto_annotation").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("funnel_snapshots_cycle_uq").on(t.cycleId),
    index("funnel_snapshots_org_idx").on(t.orgId, t.cycleGeneration),
    index("funnel_snapshots_created_at_idx").on(t.orgId, t.createdAt),
  ],
);

export type FunnelSnapshotRow = typeof funnelSnapshotsTable.$inferSelect;
export type InsertFunnelSnapshotRow =
  typeof funnelSnapshotsTable.$inferInsert;

export const funnelAnnotationSourceValues = ["auto", "operator"] as const;
export type FunnelAnnotationSource =
  (typeof funnelAnnotationSourceValues)[number];

export const funnelAnnotationKindValues = [
  "stage_drop",
  "stage_spike",
  "calibration_change",
  "cohort_anomaly",
  "operator_note",
] as const;
export type FunnelAnnotationKind =
  (typeof funnelAnnotationKindValues)[number];

/**
 * Annotations attached to a snapshot. Two streams:
 *   - `auto`: emitted by the delta detector after a snapshot persists.
 *     Gated on warmup (>= 5 prior cycles) and a dual-threshold
 *     (>= 25% relative AND per-stage absolute floor).
 *   - `operator`: free-form notes from a platform / org admin.
 *
 * Acked annotations are still visible but filtered out of the
 * "needs review" admin badge counter.
 */
export const funnelAnnotationsTable = pgTable(
  "funnel_annotations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => funnelSnapshotsTable.id, { onDelete: "cascade" }),
    source: text("source").$type<FunnelAnnotationSource>().notNull(),
    kind: text("kind").$type<FunnelAnnotationKind>().notNull(),
    /** The stage / lever / cohort the annotation pertains to. */
    targetStage: text("target_stage"),
    targetLeverId: text("target_lever_id"),
    targetCohortWindow: text("target_cohort_window"),
    /** Human-readable, rendered in the admin UI. */
    summary: text("summary").notNull(),
    /** Full structured payload (deltas, ratios, sample ids). */
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdBy: text("created_by"),
    ackedBy: text("acked_by"),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("funnel_annotations_snapshot_idx").on(t.snapshotId),
    index("funnel_annotations_org_idx").on(t.orgId, t.createdAt),
    index("funnel_annotations_unacked_idx").on(t.orgId, t.ackedAt),
  ],
);

export type FunnelAnnotationRow = typeof funnelAnnotationsTable.$inferSelect;
export type InsertFunnelAnnotationRow =
  typeof funnelAnnotationsTable.$inferInsert;

/**
 * Records every snapshot capture failure so a snapshot bug never silently
 * blinds the admin surface. `recurrenceCount` is incremented (not a new
 * row) when the same `(org_id, error_class)` recurs within 24h, keeping
 * the admin failure feed bounded.
 */
export const funnelSnapshotFailuresTable = pgTable(
  "funnel_snapshot_failures",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    /** Cycle that was running when capture failed. */
    cycleId: text("cycle_id").notNull(),
    cycleGeneration: integer("cycle_generation").notNull(),
    /**
     * Coarse-grained class (e.g. `MissingTable`, `Timeout`, `OOM`). Used
     * for the recurrence rollup so a flapping bug doesn't spam the feed.
     */
    errorClass: text("error_class").notNull(),
    errorMessage: text("error_message").notNull(),
    stack: text("stack"),
    /** Optional structured context (which stage was being captured, etc). */
    context: jsonb("context")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    recurrenceCount: integer("recurrence_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ackedBy: text("acked_by"),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (t) => [
    index("funnel_failures_org_idx").on(t.orgId, t.lastSeenAt),
    index("funnel_failures_class_idx").on(t.orgId, t.errorClass),
  ],
);

export type FunnelSnapshotFailureRow =
  typeof funnelSnapshotFailuresTable.$inferSelect;
export type InsertFunnelSnapshotFailureRow =
  typeof funnelSnapshotFailuresTable.$inferInsert;

/** Cohort window discriminator — single source of truth. */
export const COHORT_WINDOWS = ["7d", "30d", "90d"] as const;
export type CohortWindow = (typeof COHORT_WINDOWS)[number];
