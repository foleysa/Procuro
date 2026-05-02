import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  integer,
  numeric,
  boolean,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Defense Pack target descriptor — what is the buyer defending or
 * attacking. The user picks a supplier and at least one of:
 * `contractId` + `lineItem`, `categoryCode`, or `materialCode`. The
 * combination is captured verbatim on every generated pack so the
 * Evidence Room replay can re-derive the evidence pool deterministically.
 */
export interface DefensePackTarget {
  supplierId: string;
  supplierName: string;
  contractId?: string;
  lineItem?: string;
  categoryCode?: string;
  materialCode?: string;
}

export const defensePackPositionValues = [
  "defend_against_increase",
  "attack_for_decrease",
  "justify_index_relink",
] as const;
export type DefensePackPosition = (typeof defensePackPositionValues)[number];

export const defensePackLengthValues = [
  "exec_one_pager",
  "three_page_brief",
  "full_pack",
] as const;
export type DefensePackLength = (typeof defensePackLengthValues)[number];

export const defensePackStatusValues = [
  "generating",
  "ready",
  "insufficient_evidence",
  "failed",
] as const;
export type DefensePackStatus = (typeof defensePackStatusValues)[number];

/**
 * One claim in the generated memo. Every claim must be backed by a
 * citation referencing a `signalId` from the frozen evidence snapshot.
 * Claims that fail verification are dropped before render.
 */
export interface DefensePackClaim {
  /** Free-text claim sentence emitted by the LLM. */
  text: string;
  /** signalId from the evidence snapshot — verified to exist + match. */
  signalId: string;
  /** Quoted value from the LLM, verified against the signal's value. */
  valueQuoted: string;
}

/**
 * One section of the memo. Renders as a labeled block in the UI / PDF.
 */
export interface DefensePackSection {
  key:
    | "position"
    | "market_context"
    | "cost_drivers"
    | "comparable_benchmarks"
    | "recommended_counter_position"
    | "walk_away_considerations"
    | "proprietary_signal_context";
  title: string;
  /** Narrative paragraph (may reference claims by index inline). */
  narrative: string;
  /**
   * Verified claims for this section. Empty for the
   * `proprietary_signal_context` section (T3 narrative-only) and the
   * `position` section (the user's own input, no citations).
   */
  claims: DefensePackClaim[];
}

/**
 * Every signal we pulled into the evidence pool, frozen at generation
 * time. The Evidence Room view replays this list verbatim, even after
 * the live signals move.
 */
export interface DefensePackEvidenceSnapshotItem {
  signalId: string;
  collectorId: string;
  collectorName: string;
  signalType: string;
  /** Disclosure tier at the time of generation. */
  tier: "T1" | "T2" | "T3" | "T4";
  scope: {
    materialCode?: string | null;
    categoryCode?: string | null;
    supplierName?: string | null;
    laneKey?: string | null;
    sku?: string | null;
  };
  value: number;
  unit: string;
  currency: string;
  observedAt: string;
  sourceUrl: string;
  posture: string;
}

/**
 * Generated procurement memo defending or attacking a price using
 * verifiable T1/T2 evidence (and a single T3 narrative paragraph if
 * tenant policy permits). Frozen snapshot — the cited signals + their
 * values at generation time are persisted so the Evidence Room replay
 * matches what the buyer took into the negotiation.
 *
 * Stored in Postgres rather than BigQuery to keep parity with the rest
 * of the canonical procurement schema; the `evidenceSnapshot` JSONB
 * column carries the per-signal facts the LLM cited.
 */
export const defensePacksTable = pgTable(
  "defense_packs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),

    target: jsonb("target").$type<DefensePackTarget>().notNull(),
    position: text("position").$type<DefensePackPosition>().notNull(),
    length: text("length").$type<DefensePackLength>().notNull(),

    status: text("status")
      .$type<DefensePackStatus>()
      .notNull()
      .default("generating"),
    /**
     * Set when `status='insufficient_evidence'` or `'failed'`. The
     * client renders this verbatim so the operator knows what went
     * wrong (e.g. "no T1/T2 PPI signals in the last 365 days for
     * material code STEEL_HRC").
     */
    statusReason: text("status_reason"),

    /**
     * Sections of the memo, in render order. Empty array until the
     * pack transitions out of `generating`.
     */
    sections: jsonb("sections")
      .$type<DefensePackSection[]>()
      .notNull()
      .default([]),

    /**
     * The frozen evidence pool. Captured at generation time so the
     * Evidence Room view always reflects what the buyer cited, even
     * after live signals move.
     */
    evidenceSnapshot: jsonb("evidence_snapshot")
      .$type<DefensePackEvidenceSnapshotItem[]>()
      .notNull()
      .default([]),

    /** Disclosure policy at generation time. T3 paragraph included iff != conservative. */
    disclosurePolicy: text("disclosure_policy").notNull().default("standard"),

    /** Gemini model + version actually called. */
    model: text("model"),
    /** Prompt + completion token counts. */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** Estimated USD spend, rounded to 5dp. */
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 5 }),

    /** Triggered-by user email, captured from req.actorEmail. */
    generatedBy: text("generated_by").notNull(),

    /** Permalink token. Same as id; surfaced via `/defense-packs/:id`. */
    permalink: text("permalink").notNull(),

    /** When generation finished (success OR insufficient_evidence). */
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * Set to true by the nightly `defense_pack_staleness_scan` when the
     * median absolute drift between this pack's frozen
     * `evidence_snapshot` values and the current `market_signals` for
     * the same signal stream exceeds the configured threshold (default
     * 5%). The pack itself is intentionally NOT mutated — defensibility
     * requires the memo stay frozen — but the UI surfaces the flag with
     * a "Regenerate" CTA so the buyer knows to recompute before walking
     * back into a negotiation.
     */
    stale: boolean("stale").notNull().default(false),
    /** First time this pack was flagged stale (cleared on regenerate). */
    staleSinceAt: timestamp("stale_since_at", { withTimezone: true }),
    /**
     * Diagnostic blob explaining why the pack was flagged: the
     * threshold used, the per-signal drifts that exceeded it, the
     * median drift across the whole snapshot, and when the scan ran.
     * Surfaced verbatim under the recent-packs row's tooltip so an
     * operator can answer "why is this stale?" without digging
     * through logs.
     */
    stalenessReason: jsonb("staleness_reason").$type<DefensePackStaleness>(),
  },
  (t) => [
    index("defense_packs_org_idx").on(t.orgId),
    index("defense_packs_org_created_idx").on(t.orgId, t.createdAt),
    index("defense_packs_status_idx").on(t.status),
    index("defense_packs_stale_idx").on(t.stale),
  ],
);

/**
 * Per-signal drift detected by the staleness scan.
 */
export interface DefensePackStaleSignalDrift {
  /** signalId from the frozen snapshot row. */
  signalId: string;
  collectorId: string;
  signalType: string;
  /** Value persisted in the snapshot at generation time. */
  citedValue: number;
  /** Most recent matching `market_signals.value` at scan time. */
  currentValue: number;
  /**
   * Signed percentage change as a decimal: `(current - cited) / |cited|`.
   * E.g. `0.07` means the live market index has risen 7% above what
   * the memo cited. Used both to threshold the staleness flag and to
   * render direction in the UI.
   */
  pctChange: number;
  /** ISO timestamp of the live market_signals row that was compared. */
  currentObservedAt: string;
}

/**
 * Diagnostic surfaced on `defense_packs.stalenessReason`. Captures the
 * snapshot of *why* a pack was flagged so operators don't have to
 * cross-reference logs to explain a "Regenerate" badge to a buyer.
 */
export interface DefensePackStaleness {
  /** Drift threshold that tripped the flag, as a decimal (0.05 = 5%). */
  threshold: number;
  /** When the staleness scan made this determination. */
  detectedAt: string;
  /** Median absolute pctChange across all comparable snapshot rows. */
  medianAbsDriftPct: number;
  /** How many snapshot rows we were able to compare against live data. */
  comparedSignalCount: number;
  /** Per-signal drifts that individually exceeded the threshold. */
  drifts: DefensePackStaleSignalDrift[];
}

export type DefensePackRow = typeof defensePacksTable.$inferSelect;
export type InsertDefensePackRow = typeof defensePacksTable.$inferInsert;

export const defensePackOutcomeUsedValues = ["yes", "no", "unknown"] as const;
export type DefensePackOutcomeUsed =
  (typeof defensePackOutcomeUsedValues)[number];

export const defensePackOutcomeCategoryValues = [
  "supplier_held_price",
  "supplier_reduced_price",
  "deferred",
  "deal_lost",
  "other",
] as const;
export type DefensePackOutcomeCategory =
  (typeof defensePackOutcomeCategoryValues)[number];

/**
 * Per-pack feedback affordance for the Learn loop. Buyers report
 * whether the pack was used in a real negotiation and what the outcome
 * was so a future backtesting harness can compute lift.
 */
export const defensePackOutcomesTable = pgTable(
  "defense_pack_outcomes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    packId: text("pack_id")
      .notNull()
      .references(() => defensePacksTable.id, { onDelete: "cascade" }),
    used: text("used").$type<DefensePackOutcomeUsed>().notNull(),
    outcomeCategory: text(
      "outcome_category",
    ).$type<DefensePackOutcomeCategory>(),
    comment: text("comment"),
    submittedBy: text("submitted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("defense_pack_outcomes_pack_idx").on(t.packId),
    index("defense_pack_outcomes_org_idx").on(t.orgId),
  ],
);

export type DefensePackOutcomeRow =
  typeof defensePackOutcomesTable.$inferSelect;
export type InsertDefensePackOutcomeRow =
  typeof defensePackOutcomesTable.$inferInsert;
