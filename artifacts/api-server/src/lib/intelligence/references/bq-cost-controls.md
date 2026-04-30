# BigQuery cost controls

The `market_signals_warehouse` dataset is the only BQ surface this
project writes to. The controls below are how we keep its cost shape
predictable.

## Configuration

`@workspace/intelligence` reads its config from environment variables
(see `lib/intelligence/src/config.ts`):

| Variable                          | Default                        | Notes                                         |
| --------------------------------- | ------------------------------ | --------------------------------------------- |
| `INTELLIGENCE_GCP_PROJECT_ID`     | (required to enable BQ)        | Returns `null` config when unset → no-op.     |
| `INTELLIGENCE_BQ_DATASET`         | `market_signals_warehouse`     | Lives in the configured project.              |
| `INTELLIGENCE_BQ_LOCATION`        | `US`                           | Single-region for predictable egress.         |
| `INTELLIGENCE_GCS_RAW_BUCKET`     | (required to enable GCS)       | Used by `landRawPayload`.                     |
| `INTELLIGENCE_BQ_MAX_BYTES_BILLED`| `10000000000` (10 GB)          | Per-query cap; queries that exceed it fail.   |
| `INTELLIGENCE_BQ_DEFAULT_TABLE_TTL_MS` | `7776000000` (90 days)    | Default expiry on new ad-hoc tables.          |

When either GCP project or bucket is unset, the foundation runs in
"local mode": every BQ/GCS call is a typed no-op, the legacy
Postgres-only flow is unaffected.

## Maximum bytes billed

Every query issued from `@workspace/intelligence/bq` sets
`maximumBytesBilled` to `INTELLIGENCE_BQ_MAX_BYTES_BILLED`. This is the
single most important guardrail: a runaway scan caps out at the
configured ceiling instead of running away with the bill.

The default is 10 GB per query. Tighten this in production by setting
the env var lower for the api-server's service account, or higher for
the analyst-facing dashboard if it routinely needs full-table scans.

## Partitioning + clustering

`market_signals` is `PARTITION BY DATE(ingested_at)` and
`CLUSTER BY signal_type, scope_material_code, collector_id`. This is
deliberate:

- Most queries filter on the latest ingest day or a small window — the
  partition prune is the dominant cost reduction.
- Within a partition, the dominant filter is by `signal_type` and a
  scope column, so clustering by those keeps blocks tight.

`collector_runs` is `PARTITION BY DATE(started_at)` and
`CLUSTER BY collector_id, status` for the same reason.

## MERGE idempotency

`mergeMarketSignals` keys on `stable_signal_key` and `system_to IS NULL`
so re-running the same payload produces zero merges (no row matches the
"value differs" branch and no row matches the "not present" branch).
This means re-issuing yesterday's collection — whether by accident, by
the replay CLI, or by a backfill job — costs only the scan to discover
"nothing to do".

## Raw-payload landing

GCS objects live at
`gs://<bucket>/<collectorId>/<YYYY/MM/DD>/<runId>.<ext>`. The date
prefix is what makes lifecycle rules cheap to express: hot for the
first 90 days, then nearline, then deletion at 365 days unless the
object carries a `legal_hold` metadata key. Lifecycle rules are
configured at the bucket level (out of band) — the api-server never
writes a lifecycle policy.

`landRawPayload` is best-effort and never fails the run: if GCS is
unreachable, Postgres is still committed and the next run will simply
re-land the payload.

## What we do _not_ do

- We do not stream into `market_signals` directly — the MERGE path is
  the only writer, so cost shape is set by query bytes (cheap) instead
  of streaming-insert pricing.
- We do not query without a partition filter from production code. If
  you need a full-table scan for analyst work, do it from the dashboard
  with an explicit override, not from a collector.
- We do not store PII on `market_signals`. Source URLs and supplier
  names are public-disclosure metadata; resolved entity ids live in
  `entities` and join through `entity_uid_nullable`.
