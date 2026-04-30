# OODA funnel substrate (admin observability v1)

This is the operator's guide to the per-tenant per-cycle funnel snapshots
introduced by task #185. It is **not** a user-facing surface in v1: the
admin observability page lives at `/admin/funnel` behind `AdminGuard`,
and the REST endpoints require the `audit:read` (tenant) or
`platform:manage` (cross-tenant) permissions.

## What gets written

For every analysis cycle that reaches `status='completed'`, the server
writes one row to `funnel_snapshots` with:

| Column | Meaning |
|---|---|
| `org_id` | Tenant the snapshot is scoped to. |
| `cycle_id`, `cycle_generation` | The cycle this snapshot describes. |
| `stages` | Object keyed by stage name (see below). Each stage has `count`, optional `by_lever`, `sample_ids`/`sample_drafts`, `capped` flag. |
| `cohorts.persisted` | Array of `{key, count}` cohort identity tuples for stage 6 (persisted opportunities). |
| `calibration` | Object keyed by `${leverId}:${window}` describing prior calibration verdicts. |
| `total_*`, `total_projected_usd` | Lifted scalars for cheap dashboards. |
| `capture_duration_ms` | Wall-clock time the writer spent. |
| `has_auto_annotation` | 1 if delta detection wrote at least one annotation against this snapshot. |

### The 10 logical stages

The writer materializes 10 logical stages; cohort stages 7/8/9 expand
into three windowed keys (7d/30d/90d) for a total of 16 stage entries:

1. `signals_collected` — pipeline ingest count, capped sample of IDs.
2. `signals_mapped_to_levers` — by-lever histogram + capped sample.
3. `signals_analyzed` — union of every analyzer's `consultedSignalIds`.
4. `drafts_produced` — pre-exclusion analyzer output.
5. `drafts_post_exclusion` — survivors of the active-exclusions filter.
6. `opps_persisted` — rows actually inserted into `opportunities`.
7. `opps_approved_{7,30,90}d` — decisions of `eventType='approve'` in window.
8. `opps_executed_{7,30,90}d` — decisions of `eventType='execute'` in window.
9. `opps_realized_{7,30,90}d` — decisions of `eventType='realize'` in window plus rolled-up realized USD.
10. `priors_updated` — count of priors mutated by this cycle, plus deltas.

Each stage carries a per-lever histogram where the lever attribution is
unambiguous and a `capped: true` flag whenever the sample list was
truncated for storage budget reasons.

### Cohort identity

Every lever defines `cohortKey(draft)` returning a stable identity tuple
that survives draft → opportunity persistence. Three Tier-2 levers
implement non-trivial keys today:

* `fx_exposure` — currency pair (e.g. `USD/EUR`).
* `spot_vs_contract` — canonical category code (e.g. `FREIGHT_TRUCKING_TL`).
* `material_index_arbitrage` — material code.

All other levers return the empty key, which collapses into a single
identity row in `cohorts.persisted`.

### Prior calibration

For every `(leverId, window∈{7d,30d,90d})` pair where the cycle has at
least 10 realized decisions in window, we compute:

* `rawMedianAbsErrorUsd` — median |raw projected − realized|.
* `rescaledMedianAbsErrorUsd` — median |projected_after_prior − realized|.
* `improvementUsd` — `raw - rescaled`.
* `verdict` — `helping` if improvement > $100, `hurting` if < −$100,
  `neutral` if within ±$100, `insufficient_evidence` if n < 10.

Verdicts give operators a fast read on whether the per-lever rescaling
priors are still pulling projections in the right direction.

## Delta detection + auto-annotations

After a snapshot is written, `detectAndAnnotateDeltas` compares each
stage count against the median of the previous 5 snapshots for the same
tenant. The annotator emits a `source='auto'`, `kind='stage_spike'` or
`stage_drop` row in `funnel_annotations` only when **both**:

* relative change ≥ 25%, **and**
* absolute change ≥ the per-stage floor (e.g. 5 drafts, 50 signals).

A 5-snapshot warmup is enforced before any auto-annotation can fire,
which is also reflected in the admin UI ("warmup N/5" badge).
Operators can post their own free-form notes against any snapshot via
`POST /api/admin/funnel/annotations` (`source='operator'`) and ack any
annotation via `PATCH .../ack`.

## Snapshot failures

`captureFunnelSnapshot` is wrapped so that a writer bug never
propagates into `runAnalysisCycle`. On failure:

1. The error class + message are upserted into
   `funnel_snapshot_failures`. Same-class errors within a 24h window
   collapse via `recurrence_count`.
2. An in-process counter (`funnel_snapshot_failures_total`) is bumped
   for `/system/metrics` scraping.
3. The cycle continues without a snapshot for that generation.

The admin observability page surfaces a banner with the unacked count
and an Ack button.

## REST surface (mounted under `/api/admin/funnel/...`)

| Method | Path | Notes |
|---|---|---|
| GET | `/snapshots?limit&offset` | Tenant snapshot list, plus warmup state. |
| GET | `/snapshots/:id` | Snapshot detail + annotations. |
| POST | `/snapshots/:id/recompute` | Re-derives stages 6–10 only. Analyzers are not re-runnable post-hoc. |
| GET | `/snapshots/:id/annotations` | List annotations for a snapshot. |
| POST | `/annotations` | Create operator annotation (body: `{snapshotId, summary, kind?, targetStage?}`). |
| PATCH | `/annotations/:id/ack` | Ack annotation. |
| GET | `/failures` | List snapshot failures + counters. |
| PATCH | `/failures/:id/ack` | Ack failure. |
| GET | `/lowest-conversion?cycles=N` | Per-lever worst-transition rollup over the last N snapshots. |
| GET | `/platform/funnel/aggregate` | **Cross-tenant** rollup; `platform:manage` required. |

All tenant routes use `requirePermission("audit:read")` and the org
context is taken from the session, never from request input.

## Admin UI

`/admin/funnel` (gated by `AdminGuard`) offers three tabs:

* **Snapshots** — list with totals, capture duration, annotation badge,
  and a detail panel showing the 10-stage table, persisted-cohort
  drill-down, calibration verdicts, and annotation stream.
* **Lowest conversion** — per-lever worst-transition view over the last
  10 snapshots.
* **Failures** — banner + table of recorded snapshot failures with Ack.

This is intentionally dense and table-first — operators are debugging
the pipeline, not browsing it.

## Known follow-ups (not built in v1)

These were dropped to keep this PR focused. They should be addressed in
order of operational impact:

1. **OpenAPI codegen** for the funnel routes. We followed the same
   precedent as `routes/admin-users.ts`, which is also hand-written.
   When converting, the generated React Query hooks should slot
   directly under the existing query keys.
2. **Backfill script** (`scripts/src/backfill-funnel-snapshots.ts`) for
   pre-existing tenants whose old completed cycles have no snapshot.
   Likely entry: walk `analysis_cycles` ordered by `(orgId, generation)`
   and call a stripped-down capture path that fills only stages 6–10.
3. **Retention job**: the `funnel_snapshots.stages` JSONB grows with
   tenant scale. Recommend a daily job that deletes snapshots older
   than 365d and runs `VACUUM` against the table.
4. **Performance budget test** asserting `capture_duration_ms < 500ms`
   p95 in CI against a seeded large tenant.
5. **Playwright e2e** of the admin surface. The repo currently uses
   `node:test`; e2e is covered by integration tests +
   `funnel-snapshot.test.ts` for now.
6. **Post-deploy behavioral verification** doc — runbook for confirming
   the writer fires within the first cycle after rollout (look for
   `funnel_snapshots` rows + a non-zero `capture_duration_ms`).

## Local debugging tips

* The writer never throws. To prove that, force a failure with a bad
  `cycle_id` and observe the `funnel_snapshot_failures` row plus the
  counter increment in `/system/metrics`.
* `cohorts.persisted` is the easiest way to see whether a lever's
  `cohortKey()` is doing what you expect — count of distinct keys in
  there should match cardinality of cohort identities you'd expect for
  the tenant.
* If calibration verdicts are stuck at `insufficient_evidence`, you
  need n ≥ 10 realized decisions in window; check `decisions` table
  for that lever.
