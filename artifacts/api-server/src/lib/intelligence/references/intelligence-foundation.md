# Intelligence foundation

This page describes the analytical foundation that sits behind every
collector-driven insight in the platform: the BigQuery sidecar, the GCS
raw-payload landing zone, the collector contract, the entity resolver,
and the disclosure-tier renderer.

The whole subsystem is **gated**: when GCP credentials aren't present,
every BQ/GCS call is a typed no-op and the legacy Postgres-only path
keeps working. This is what lets a workstation or CI run all of the
existing tests without touching Google Cloud.

## Module map

```
@workspace/intelligence
├── config           # env-driven IntelligenceConfig (returns null when unset)
├── contracts        # PostureClass / DisclosureTier / CollectorContract zod
├── bq               # lazy BigQuery client + DDLs + mergeMarketSignals + recordCollectorRun
├── gcs              # lazy GCS client + landRawPayload + listRawPayloads
├── entities         # entity resolver v0 (identifier → name+country → fuzzy)
├── tier             # disclosure-tier renderer (RenderedInsight)
└── signalKey        # computeStableSignalKey(parts) — sha-1 of natural identity
```

The api-server consumes these via `@workspace/intelligence` and wires
them into the collector runtime under
`artifacts/api-server/src/lib/intelligence/`. The legacy Postgres path
(insert into `marketSignalsTable`) is the system of record; BQ/GCS is a
sidecar that gives us:

- a bitemporal warehouse for time-travel queries (`valid_*` + `system_*`)
- raw payloads we can re-parse without re-fetching upstream
- a per-source contract the runtime + UI can rely on
- a single-source entity identity scheme for cross-collector joins

## Collector contract

Every collector exports the seven contract fields (see
`artifacts/api-server/src/lib/intelligence/collector.ts`):

| Field                | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `postureClass`       | Legal posture: `public_api`, `tos_restricted`, or `gray_hat`.            |
| `disclosureTier`     | How much we may attribute the source: `T1` … `T4`.                      |
| `jurisdiction`       | ISO 3166-1 alpha-2 country code, or `GLOBAL`.                           |
| `retentionDays`      | GCS lifecycle window for raw payloads.                                  |
| `tenantOptInDefault` | When `false`, tenants must opt in before signals from this source land. |
| `signalSchema`       | Per-collector Zod schema covering the `metadata` object (drift catcher).|
| `stableSignalKey()`  | Returns the natural-key hash used to MERGE bitemporal rows in BQ.       |

`registerCollector` validates the first five via `collectorContractSchema`
and refuses a half-declared collector at boot. The runtime asserts
`signalSchema` on every parsed draft and drops drafts that fail
(emitting a `marketSignalSchemaDriftTable` row per failure, capped per
run so a totally-broken upstream can't blow up the table).

`stableSignalKey()` is provided by `defaultStableSignalKey` for the
common case (natural-key columns + observedAt). A collector overrides it
when the natural identity lives in `metadata` (e.g. a series id that
isn't on the column list).

## Dual-write flow (`runCollector`)

1. Either `collectWithRaw()` returns drafts + upstream payload bytes, **or**
   the runtime falls back to `collect()` and synthesizes a parsed-drafts
   JSON snapshot for landing. Either way, every run produces at least
   one raw payload entry.
2. Each raw payload is landed to GCS at
   `gs://<bucket>/<collectorId>/<YYYY/MM/DD>/<runId>.<ext>` (no-op when
   GCP isn't configured).
3. Drafts are validated with `signalSchema`. Failures land in
   `marketSignalSchemaDriftTable` (cap 50/run) and the bad draft is
   dropped.
4. Valid drafts are inserted into Postgres
   (`insertSignalsWithDedupe`) — system of record.
5. Same drafts are mapped to `BqMarketSignalRow` and MERGEd into
   BigQuery using `stable_signal_key` as the merge key. The MERGE is a
   two-statement bitemporal supersession (UPDATE to close the prior
   open row when the value changed, INSERT to open a replacement row
   when no open matching-value row exists). Identical re-runs are
   idempotent against both stores.
6. A `collector_runs` row is appended in BQ with status, drift counts,
   bytes raw, and the GCS pointer (best-effort; failures only logged).

### Why two BQ statements instead of MERGE?

A single BigQuery MERGE only fires one branch per source row, so the
"value changed" case (which needs both an UPDATE to close the old row
and an INSERT to open the new one) cannot be expressed as one
statement. We issue:

1. UPDATE to set `system_to = ingested_at` on every open row whose
   `value` differs from the incoming observation.
2. INSERT for every incoming observation that does not already have an
   open matching-value row.

Both statements key on `stable_signal_key`. Re-running the same payload
yields zero updates (no value mismatch) and zero inserts (every key has
an open matching-value row already), so the operation is idempotent.

## Entity resolver v0

`resolveEntity({ name, country?, identifiers? })` walks three tiers:

1. **Identifier match** (LEI / CIK / EIN / Companies House / UEI /
   ticker) — confidence 0.99. Always returns a deterministic
   `entity_uid` even without BQ via `deterministicUidFromIdentifier`.
2. **Deterministic name + country** against the BQ `entities` table —
   confidence 0.85. No-op when BQ isn't configured.
3. **Fuzzy fallback** — pulls a small candidate pool from BQ
   (token-overlap on the normalised name) and asks
   `gemini-2.5-flash` (via the Replit AI Integrations proxy) to pick
   the best match in JSON mode. The model's reported confidence is
   floored at 0.6 (rejects below) and capped at 0.75 so a fuzzy match
   never outranks deterministic name (0.85) or identifier (0.99). Hits
   are cached. The path no-ops cleanly to `unresolved` when either BQ
   or the Gemini env vars (`AI_INTEGRATIONS_GEMINI_BASE_URL`,
   `AI_INTEGRATIONS_GEMINI_API_KEY`) are absent — workstation and CI
   runs without GCP keep working.

Resolutions are cached in `entityResolutionCacheTable` (Postgres) keyed
on `buildCacheKey(args)`. The cache is the hot read path for lever
analyzers calling `resolveEntity` repeatedly during a cycle — they hit
Postgres, not BQ or Gemini.

## Database migrations

The new Postgres tables (`entityResolutionCacheTable`,
`marketSignalSchemaDriftTable`, the schema additions on
`marketSignalsTable`) are picked up by the project's standard
schema-push flow:

```bash
pnpm --filter @workspace/db run push
# or, if the diff would drop a column you didn't touch:
pnpm --filter @workspace/db run push-force
```

This repo deliberately does not maintain hand-written SQL migration
files — `drizzle-kit push` is the single migration mechanism for every
table in the project, and the new intelligence tables follow that
convention. After pulling the foundation patch, run `push` once and
the new tables (plus the new columns on `market_signals`) appear.

## Disclosure-tier renderer

`renderInsight({ sources, policy, aggregateConfidence })` produces a
`RenderedInsight` with citations filtered for the tenant's policy:

- `conservative` — only T1 + T2 surface; insight is invisible if no T1/T2
  source backs it.
- `standard` — T1 + T2 + T3 surface.
- `analyst` — every tier surfaces with a `ProvenanceTrail` for audit.

T1 keeps the source URL; T2 emits a generic category label keyed on
posture + jurisdiction; T3 emits a posture-class label + numeric
confidence; T4 never surfaces (except as provenance for `analyst`).

## Replay CLI

`pnpm --filter @workspace/scripts run replay-collector --collector <id>
--from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]` walks the GCS landing
zone and re-MERGEs into BigQuery using the collector's registered
re-parser. Postgres is intentionally not replayed (the live collector
already owns the dedupe-by-natural-key contract). The replay CLI is the
mechanism that lets us fix a parser bug and re-issue corrected rows
without re-fetching upstream.

The CLI ships with a generic re-parser (`snapshotReparser`) registered
for all six foundation collectors (`fred-economic-index`,
`ecb-fx-rates`, `bls-economic-index`, `eia-energy`,
`world-bank-pink-sheet`, `published-commodity-index`). It deserialises
the runtime's auto-landed parsed-drafts JSON snapshot and rebuilds
`BqMarketSignalRow` inputs deterministically. Collectors that later
override `collectWithRaw` to land byte-faithful upstream payloads can
register a custom re-parser alongside the generic one — the registry
is keyed on `collectorId`.
