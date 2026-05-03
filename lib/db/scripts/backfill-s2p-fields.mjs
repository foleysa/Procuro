#!/usr/bin/env node
/**
 * Backfill script: S2P canonical vocabulary fields (Task #284)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES
 * ─────────────────────────────────────────────────────────────────────────
 * 1. Populates the ten new S2P columns on every `opportunities` row where
 *    `canonical_stage IS NULL` (idempotent — already-backfilled rows are
 *    untouched).
 * 2. Seeds one row per affected opportunity into `opportunity_stage_history`
 *    with transition_reason = 'BACKFILL' (idempotent via the per-opportunity
 *    CHECK below).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BACKFILL MAPPING  (reviewer sign-off required before merge)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   platform_status → canonical_stage          savings_type
 *   ────────────────────────────────────────────────────────────────────
 *   proposed        → Identified               Identified
 *   approved        → Awarded                  Negotiated
 *   executing       → In Implementation        Implemented
 *   realized        → Realized                 Realized
 *   rejected        → Closed-No Action         Identified  (*)
 *   expired         → Closed-No Action         Identified  (*)
 *
 *   (*) savings_type = 'Identified' because the prior stage cannot be
 *       reconstructed without stage history that did not exist before this
 *       migration. Going forward, opportunity_stage_history records the
 *       actual prior stage on every transition.
 *
 *   ALL backfilled rows also receive:
 *     savings_classification      = 'Hard'              (conservative default)
 *     classification_needs_review = true                (operator review required)
 *     baseline_method             = 'Internal Estimate' (conservative default)
 *     baseline_value              = NULL
 *     baseline_source             = 'BACKFILL — needs review'
 *     sourcing_strategy           = COALESCE(existing, 'Unclassified')
 *     stage_entered_at            = COALESCE(created_at, now())
 *     doa_tier                    = derived from projected_savings_usd:
 *                                     >= 5,000,000 → 1  (Board)
 *                                     >= 1,000,000 → 2  (C-Suite)
 *                                     >=   250,000 → 3  (VP)
 *                                     <    250,000 → 4  (Manager)
 *
 *   GATING NOTE: No aggregate labeled "Hard Savings" may include records
 *   where classification_needs_review = true until Category Manager review
 *   is complete. This is a hard gate, not a recommendation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ACCEPTANCE QUERIES (run after script to verify)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   -- 1. No null canonical fields
 *   SELECT count(*) FROM opportunities WHERE canonical_stage IS NULL;        -- expect 0
 *   SELECT count(*) FROM opportunities WHERE savings_type IS NULL;           -- expect 0
 *   SELECT count(*) FROM opportunities WHERE savings_classification IS NULL; -- expect 0
 *   SELECT count(*) FROM opportunities WHERE doa_tier IS NULL;               -- expect 0
 *   SELECT count(*) FROM opportunities WHERE sourcing_strategy IS NULL;      -- expect 0
 *
 *   -- 2. Backfill flag set correctly
 *   SELECT count(*) FROM opportunities WHERE classification_needs_review = true;
 *   -- expect: equal to total opportunity count at time of migration
 *
 *   -- 3. History seed rows created
 *   SELECT count(*) FROM opportunity_stage_history WHERE transition_reason = 'BACKFILL';
 *   -- expect: equal to total opportunity count
 *
 * ─────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────
 *   node lib/db/scripts/backfill-s2p-fields.mjs
 *   pnpm --filter @workspace/db run backfill-s2p
 *
 * Requires DATABASE_URL env var.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg.default ?? pg;

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("[backfill-s2p] ERROR: DATABASE_URL is not set.\n");
  process.exit(1);
}

const client = new Client({ connectionString: url });

async function run() {
  await client.connect();

  process.stderr.write("[backfill-s2p] Starting S2P field backfill…\n");

  // ─────────────────────────────────────────────────────────────────────
  // Step 1: Populate the ten new columns on opportunities.
  //
  // Only touches rows where canonical_stage IS NULL → fully idempotent.
  // DOA tier thresholds mirror DOA_TIERS in lib/db/src/doa-config.ts:
  //   Tier 1: >= 5,000,000 (Board)
  //   Tier 2: >= 1,000,000 (C-Suite)
  //   Tier 3: >= 250,000   (VP)
  //   Tier 4: < 250,000    (Manager)
  // ─────────────────────────────────────────────────────────────────────
  const updateResult = await client.query(`
    UPDATE opportunities
    SET
      canonical_stage = CASE status
        WHEN 'proposed'  THEN 'Identified'
        WHEN 'approved'  THEN 'Awarded'
        WHEN 'executing' THEN 'In Implementation'
        WHEN 'realized'  THEN 'Realized'
        WHEN 'rejected'  THEN 'Closed-No Action'
        WHEN 'expired'   THEN 'Closed-No Action'
        ELSE                  'Identified'
      END,
      savings_type = CASE status
        WHEN 'proposed'  THEN 'Identified'
        WHEN 'approved'  THEN 'Negotiated'
        WHEN 'executing' THEN 'Implemented'
        WHEN 'realized'  THEN 'Realized'
        WHEN 'rejected'  THEN 'Identified'
        WHEN 'expired'   THEN 'Identified'
        ELSE                  'Identified'
      END,
      savings_classification      = 'Hard',
      classification_needs_review = true,
      baseline_method             = 'Internal Estimate',
      baseline_value              = NULL,
      baseline_source             = 'BACKFILL — needs review',
      sourcing_strategy           = COALESCE(sourcing_strategy, 'Unclassified'),
      stage_entered_at            = COALESCE(stage_entered_at, created_at, now()),
      doa_tier = CASE
        WHEN projected_savings_usd::numeric >= 5000000 THEN 1
        WHEN projected_savings_usd::numeric >= 1000000 THEN 2
        WHEN projected_savings_usd::numeric >=  250000 THEN 3
        ELSE                                                4
      END
    WHERE canonical_stage IS NULL
    RETURNING
      id,
      org_id,
      canonical_stage,
      stage_entered_at
  `);

  const backfilledRows = updateResult.rows;
  const backfilledCount = backfilledRows.length;
  process.stderr.write(
    `[backfill-s2p] Step 1: Backfilled ${backfilledCount} opportunity row(s).\n`,
  );

  if (backfilledCount === 0) {
    process.stderr.write(
      "[backfill-s2p] Nothing to seed in stage history (all rows already backfilled).\n",
    );
    return;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 2: Seed one history row per backfilled opportunity.
  //
  // Skips any opportunity that already has a 'BACKFILL' history row so
  // re-runs of this script are idempotent even if Step 1 found 0 rows
  // to update but Step 2 was not yet seeded.
  // ─────────────────────────────────────────────────────────────────────

  // Fetch already-seeded ids to avoid duplicates on re-run.
  const existingResult = await client.query(
    `SELECT opportunity_id
     FROM opportunity_stage_history
     WHERE transition_reason = 'BACKFILL'
       AND opportunity_id = ANY($1::text[])`,
    [backfilledRows.map((r) => r.id)],
  );
  const alreadySeeded = new Set(existingResult.rows.map((r) => r.opportunity_id));

  const historyRows = backfilledRows
    .filter((r) => !alreadySeeded.has(r.id))
    .map((r) => ({
      id: randomUUID(),
      opportunity_id: r.id,
      org_id: r.org_id,
      from_stage: null,
      to_stage: r.canonical_stage,
      transitioned_at: r.stage_entered_at ?? new Date().toISOString(),
      transitioned_by_user_id: null,
      transition_reason: "BACKFILL",
      notes:
        "Seed row written by backfill-s2p-fields.mjs (Task #284). " +
        "from_stage=NULL because no stage history existed before this migration.",
    }));

  if (historyRows.length === 0) {
    process.stderr.write(
      "[backfill-s2p] Step 2: All history seed rows already present.\n",
    );
    return;
  }

  // Batch-insert in chunks of 500 to avoid huge parameter lists.
  const CHUNK = 500;
  let seededCount = 0;
  for (let i = 0; i < historyRows.length; i += CHUNK) {
    const chunk = historyRows.slice(i, i + CHUNK);
    const values = chunk.map((_, j) => {
      const base = j * 9;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    });
    const params = chunk.flatMap((r) => [
      r.id,
      r.opportunity_id,
      r.org_id,
      r.from_stage,
      r.to_stage,
      r.transitioned_at,
      r.transitioned_by_user_id,
      r.transition_reason,
      r.notes,
    ]);
    await client.query(
      `INSERT INTO opportunity_stage_history
         (id, opportunity_id, org_id, from_stage, to_stage,
          transitioned_at, transitioned_by_user_id, transition_reason, notes)
       VALUES ${values.join(", ")}
       ON CONFLICT DO NOTHING`,
      params,
    );
    seededCount += chunk.length;
  }

  process.stderr.write(
    `[backfill-s2p] Step 2: Seeded ${seededCount} history row(s).\n`,
  );
  process.stderr.write("[backfill-s2p] Done.\n");
}

run()
  .catch((err) => {
    process.stderr.write(`[backfill-s2p] FATAL: ${err}\n`);
    process.exit(1);
  })
  .finally(() => {
    client.end().catch(() => {});
  });
