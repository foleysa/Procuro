# Data Integrity Tests (Task #314 — CFO Insurance)

SQL-level assertions that verify the dashboard's dollar figures
reconcile against the underlying records, that savings tags are
internally consistent, and that the #284 hard gates (Hard Savings
excludes review-flagged records, Realized requires a baseline) are
being honoured in production.

These run on three triggers:

1. **Scheduled** — every 15 minutes via the `data_integrity_check`
   job kind. Started from `artifacts/api-server/src/index.ts`.
2. **Post-migration / manual** — `pnpm --filter @workspace/scripts run
   data-integrity` (a thin shim around the same harness that exits
   non-zero on any failure).
3. **Application code** — anything that wants to ad-hoc reconcile a
   subset can `import { runAssertions, ALL_ASSERTIONS }` directly.

## The eleven assertions

| # | Family         | Name                                                                | What it catches |
|---|----------------|---------------------------------------------------------------------|-----------------|
| 1 | aggregate      | `realized_savings_matches_record_sum`                               | Dashboard total drifts from the record-level Realized sum. |
| 2 | aggregate      | `pipeline_value_decomposition_intact`                               | Pipeline value partitioned by classification doesn't sum to total. |
| 3 | aggregate      | `lever_totals_sum_to_aggregate`                                     | Per-lever rollup drops or double-counts a lever. |
| 4 | aggregate      | `funnel_counts_match_records`                                       | `funnel_snapshots.total_opps_persisted` disagrees with the live cycle. |
| 5 | savings_type   | `no_null_savings_types_or_classifications`                          | A canonical-staged opportunity is missing its #284 tags. |
| 6 | savings_type   | `savings_type_consistent_with_canonical_stage`                      | `savings_type` and `canonical_stage` disagree on an active record. |
| 7 | savings_type   | `realized_records_have_baseline_value_or_soft_marker`               | A Realized record can't answer "saved against what?". |
| 8 | stage_history  | `stage_history_latest_row_matches_current_canonical_stage`          | The latest history row doesn't match the parent's stage. |
| 9 | stage_history  | `every_opportunity_has_at_least_one_history_row`                    | A canonical-staged opportunity has no history rows. |
| 10| gating         | `hard_savings_aggregate_excludes_classification_needs_review`       | **THE CFO TEST.** Review-flagged Hard rows are eligible for the dashboard. |
| 11| gating         | `dashboard_does_not_count_realized_records_missing_baseline`        | A Realized record without a baseline is contributing to a total. |

## Schema adaptations

The original ticket text references columns and tables that don't
exist in this codebase (`award_value`, `is_addressable`,
`dashboard_aggregates`, `lever_performance`,
`dashboard_funnel_counts`). The implementation adapts to the actual
schema:

* Identified-pipeline value uses `projected_savings_usd`; Realized
  uses `realized_savings_usd`. There is no separate `award_value`
  column.
* Pipeline decomposition partitions by `savings_classification`
  (Hard / Cost Avoidance / Soft) rather than `is_addressable` —
  every classification value contributes, and the parts must sum to
  the whole.
* Aggregate comparisons re-aggregate the same scope twice and check
  internal consistency, since there is no materialised
  `dashboard_aggregates` table to compare against. When/if that table
  lands, swap the second CTE in assertion #1 for a SELECT against it.
* Funnel-count reconciliation reads `funnel_snapshots` (the closest
  dashboard-facing surface) rather than a non-existent
  `dashboard_funnel_counts` table.
* Where #284 columns are still nullable for legacy rows, the WHERE
  clauses scope to `canonical_stage IS NOT NULL` so pre-#284 backfill
  gaps don't pollute results. New rows are still required to be fully
  tagged.

## Running locally

```bash
# Default: against the dev DB the api-server uses.
pnpm --filter @workspace/scripts run data-integrity

# Against a different DB (useful for staging from a workstation):
DATA_INTEGRITY_DATABASE_URL=postgres://… \
  pnpm --filter @workspace/scripts run data-integrity

# Tag the audit row as post-migration:
pnpm --filter @workspace/scripts run data-integrity -- --post-migration
```

Exit code is `0` if every assertion passes, `1` otherwise.

## Audit log

Every run writes one row per assertion into
`data_integrity_audit_log` (`id`, `run_at`, `assertion_name`,
`family`, `passed`, `actual` JSONB, `expected`, `message`,
`triggered_by`). Indexes:

* `(run_at DESC)` — "what is the latest run?"
* `(assertion_name, run_at DESC)` — "show me the trend for X"
* `(assertion_name, run_at DESC) WHERE passed = false` — partial
  index for fast active-failure lookups.

## Alerts

Failing assertions raised by the scheduled in-process job (NOT the
standalone runner — that would double-fire) flow through the existing
`createAlert` pipeline with:

* `source = 'operational_data_integrity_failed'`
* `kind = <assertion name>`
* `severity = critical` for the gating family, `high` otherwise
* `dedupeKey = data_integrity:<assertion>:<utc-day>` so a persistent
  failure rolls up into one Slack thread per day instead of spamming
  every 15 minutes.

The same Slack channel adapter that delivers `operational_job_failed`
alerts handles these — no separate routing config needed.

## Tuning

| Env var                        | Default     | Effect |
|--------------------------------|-------------|--------|
| `DATA_INTEGRITY_INTERVAL_MS`   | `900000`    | Scheduler tick interval. |
| `DATA_INTEGRITY_DATABASE_URL`  | unset       | Override `DATABASE_URL` for the standalone runner only. |
