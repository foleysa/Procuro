# Procuro — Procurement‑as‑a‑Service

## Overview

pnpm monorepo delivering a **Procurement RaaS MVP**: connect to client ERPs, run a deterministic OODA loop over their spend, surface Tier‑1 procurement opportunities, and bill on realized savings. Designed for F500 scale and full multi‑tenancy.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js**: 24 — **TypeScript**: 5.9 (strict)
- **API**: Express 5
- **DB**: PostgreSQL + Drizzle ORM (all PKs are `text`, already pushed — never change)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API contract**: OpenAPI 3 → Orval (React Query hooks + Zod schemas)
- **Frontend**: React 18 + Vite + wouter + shadcn/ui + Tailwind v4

## Key Commands

- `pnpm run typecheck` — full monorepo typecheck
- `pnpm --filter @workspace/api-spec run codegen` — regen API hooks from OpenAPI
- `pnpm --filter @workspace/db run push-force` — push DB schema (dev only)
- `pnpm --filter @workspace/scripts run seed` — re‑seed both demo tenants
- Workflows: `artifacts/api-server: API Server`, `artifacts/command-center: web`

## Architecture

### `lib/db` — canonical procurement schema
Multi‑tenant: every domain row carries `tenant_id`, `source_system`, `source_external_id`, `source_synced_at`. Tables: `orgs`, `users`, `suppliers`, `categories`, `items`, `contracts` (+ `contract_items` tiers + index linkage), `purchase_orders`, `po_lines` (direct/indirect/service), `invoices`, `payments`, `shipments`, `raw_material_usage`, `opportunities`, `decisions` (with structured `rejection_reason_code`), `realized_savings`, `analysis_cycles`, `learned_priors`, `market_signals`, `collectors`, `collector_audit_log`, `jobs`. Every PK is `text`.

### `lib/source-adapters` — ingestion abstraction
- `SourceAdapter` interface (full sync, incremental sync, single upsert, deletion, cursor pagination).
- CSV adapter (Phase 2). Mock ERP adapter (Phase 4).
- `IntelligenceCollector` interface + `MarketSignal` shape + `CollectionPosture` enum (`public-api`, `published-data`, `respect-robots-crawl`, `aggressive-crawl`).
- `publishedCommodityIndexCollector` registered out‑of‑the‑box.
- `blsEconomicIndexCollector` (BLS PPI commodity sub‑series + ECI headline series → `economic_index` signals) registered out‑of‑the‑box. Posture `public-api`, daily schedule. Reads optional `BLS_API_KEY` env var; falls back to the unauthenticated tier (smaller daily quota) with an audit‑log warning when unset.

### `lib/analyzers` — Tier‑1 lever analyzers (shipped)
1. `sku_price_benchmark`
2. `maverick_spend`
3. `contract_leakage`
4. `duplicate_payment`
5. `missed_volume_threshold`
6. `payment_term_extension`
7. `tail_spend_rationalization`

Tier‑2 starters (`supplier_consolidation`, `contract_renegotiation_trigger`) wired into the OODA cycle. Each analyzer emits typed `Opportunity` rows with rationale + supporting refs.

### `lib/ooda` — cycle runner
`runAnalysisCycle(tenantId)` executes Observe → Orient (apply learned priors) → Decide (rank by EV × confidence) → Act (write opportunities) → Learn (update priors from prior‑cycle outcomes). Each step's payload is persisted on `analysis_cycles`. Generation counter increments per cycle. Calibration tracked via per‑lever `projection_multiplier` and `confidence_weight` in `learned_priors`.

### `lib/job-runner` — Postgres‑backed job queue
- `jobs` table acts as queue.
- Worker loop polls and dispatches by `kind`: `run_analysis_cycle`, `ingest_csv`, `ingest_mock_erp`, `run_collector`, `seed_demo`.
- Per‑tenant rate limiting.

### `artifacts/api-server` — Express API
- Tenant middleware: `x-org-id` header validated against `orgs` (dev fallback to seeded SCIS org).
- Routers: `health`, `orgs`, `me`, `spend`, `suppliers`, `opportunities`, `cycles`, `collectors`, `market-signals`, `jobs`, `ingest`, `billing`.
- All endpoints filter by `orgId`; cross‑tenant access is impossible by design.
- Augments `Express.Request` with `orgId` / `actorEmail` via `src/types.d.ts`.

### `artifacts/command-center` — operator UI
React + Vite + wouter + shadcn. Bootstrap auto‑selects SCIS org on first load; sidebar org switcher reloads at `/` so tenant context is unambiguous. Pages:
- `/` — **Command Center** (executive dashboard: 4 KPIs `Realized savings / Pipeline value / Capture rate / Awaiting approval`, "Needs your attention" actionable list with severity dots, System pulse panel `last cycle / job queue / collectors / market signals / total addressable spend`, 5‑stage Opportunity pipeline funnel, Top 5 open opportunities, Lever performance table with realization rate per lever, Recent OODA cycles strip. Every card click‑throughs to its detail page. Auto‑refreshes every 30s via `refetchInterval` on each Orval hook (Orval requires explicit `queryKey` when query opts are passed). Opportunities are fetched as 5 separate per‑status calls (`limit=200` each) so the executive totals can't be skewed by a single page sorted by projected $ — a yellow caveat banner appears automatically if any single bucket hits the 200 cap. **Capture rate** = `realized $ / (realized + proposed + approved + executing) projected $` (excludes rejected/expired so deliberate "no" decisions don't deflate the rate). Stale‑collector alert only flags collectors that actually ran but >24h ago; a separate softer alert surfaces enabled collectors that have never run.)
- `/spend` — **Spend Overview** (class / category / supplier / BU + concentration KPIs — moved here when Command Center took `/`)
- `/opportunities` — **Opportunities Feed** (grouped by lever, filterable by status & lever)
- `/opportunities/:id` — **Opportunity detail** (approve / reject‑with‑reason / execute / realize)
- `/approvals` — **Pipeline** (Proposed → Approved → Executing → Realized + Rejected)
- `/ooda` — **OODA Wheel** (5‑stage diagram, cycle history, prior deltas, "Run next cycle")
- `/results` — **Results & Billing** (realized $, contingency owed, by‑lever breakdown)
- `/playbook` — **Procurement Playbook** (Tier 1–4 lever ladder w/ shipped vs starter vs planned)
- `/collectors` — **Collector Registry** (intelligence sources + run‑now + ECB FX history backfill button + multi‑year **FX‑rate trends chart** with Indexed/Absolute mode toggle and per‑pair toggles, sourced from `/api/market-signals?signalType=fx_rate&scopeMaterialCode=…&order=asc` + recent market signals)
- `/ingest` — **Data Ingest** (CSV upload UI for all 8 spend datasets + a dedicated streaming-only `Purchase Order Lines (large)` entity; client‑side header validation, groups POs/contracts by externalId, calls `useIngestCsvBatch`). Files **> 5 MB** for streamable single‑table entities (categories / suppliers / items / invoices / payments / shipments) auto‑switch to the streaming endpoint, and the new `purchaseOrderLines` entity is **streaming-only** (always uses the streaming endpoint regardless of size — its job is the millions-of-PO-lines case where the JSON `purchaseOrders` grouping path would OOM). The streaming endpoint is `POST /api/ingest/csv-stream?entity=<name>` and accepts **two transports**: (1) `multipart/form-data` with a single `file` part (preferred — what the OpenAPI contract advertises, the generated React client uses, and the Data Ingest page sends via XHR + FormData so it can show upload progress); (2) raw `text/csv` request body (kept for `curl --data-binary` and back-compat). The server uses **busboy** to stream the multipart `file` part directly into `streamCsvEntity` (`csv-adapter.ts`) — no full-file buffering — and pipes `req` directly for the raw path. Express body parsers skip both via `SKIP_BODY` in `app.ts`. Hard limit: **1 GB per request** enforced via `Content-Length` pre-flight (413) plus a streaming byte counter that destroys the stream mid-upload if exceeded. The response is **NDJSON** (`application/x-ndjson`, chunked, `Cache-Control: no-store`, `X-Accel-Buffering: no`) so the page can show server-side row progress after the upload bar reaches 100%. The server emits one JSON event per line: zero or more `{ "type": "progress", "rowsParsed", "rowsInserted" }` lines (throttled to **~250 ms** intervals — `PROGRESS_EMIT_INTERVAL_MS` in `routes/ingest.ts` — fed by an `onProgress` callback that `streamCsvEntity` invokes after every 1000-row batch flush) followed by a terminal `{ "type": "result", entity, rowsParsed, rowsInserted, durationMs }` (final rolled-up counts always present regardless of how many `progress` events were throttled out) **or** `{ "type": "error", error }`. Pre-flight failures (bad entity, oversize Content-Length) still return conventional 4xx JSON before the stream starts; once the body begins, errors arrive as in-stream `error` events on a 200. The Data Ingest page parses NDJSON incrementally from `xhr.responseText` (`uploadCsvStream` in `pages/ingest.tsx`) and renders per-entity "X rows parsed · Y inserted" via `serverProgress` state on `EntityRow` (with a "processing on server…" placeholder shown when the upload byte progress hits 100% but the first `progress` event hasn't arrived yet). Returns `StreamCsvResult` (rowsParsed / rowsInserted / durationMs) as the terminal `result` event payload. Streaming `invoices` accepts both the streaming-native `supplierId`/`poId` columns and the page-shaped `supplierExternalId`/`poExternalId` columns (with batch lookups), so large invoice files uploaded from the page actually insert. The orval-generated `ingestCsvStream` is patched post-codegen by `lib/api-spec/scripts/patch-codegen.mjs` (orval emits `JSON.stringify` for binary/multipart bodies, which would silently upload `"{}"`) so the package exposes a working multipart client to consumers; the patched helper passes `responseType: "raw"` to `customFetch` so consumers receive the unconsumed `Response` (with the NDJSON body readable off `response.body`) — this `"raw"` mode is implemented in `lib/api-client-react/src/custom-fetch.ts` and bypasses body parsing on 2xx while still throwing `ApiError` for non-2xx pre-flight failures. Page parses only the header row for streaming files, uses XHR+FormData for upload-progress events, and shows per-entity progress bar + `Streaming · <size>` badge. `contracts` and `purchaseOrders` (grouped header + lines) stay JSON-only.
- `/landing` — RaaS positioning hero (linked from header)

### Seed (`scripts/src/seed.ts`)
- **SCIS Procurement** (`org_scis_proc`, slug `scis-procurement`, 20% contingency): F500‑scale — 200 suppliers, 30 contracts (with tiers), 1500 POs, 3700+ PO lines, 1500 invoices, 1000+ payments, 700+ shipments, raw‑material usage, distributions tuned to trigger every Tier‑1 lever.
- **ProcureWorks Inc.** (`org_procureworks`, slug `procureworks`, 15% contingency): smaller tenant for isolation proof.
- 4 historical OODA cycles per tenant (Gen 1–4) with realized outcomes, learned priors, and decisions populated. Re‑run via `pnpm --filter @workspace/scripts run seed`.
- 1 collector entry pre‑seeded.

## Verified flows
- Cycle‑over‑cycle: running Gen N+1 updates `learned_priors.projection_multiplier` from realized outcomes; new opportunities are re‑ranked accordingly. Verified via API.
- Tenant isolation: switching tenant in the sidebar surfaces totally different spend / cycles / opportunities. Verified end‑to‑end.
- Approve / reject / execute / realize lifecycle works from the UI with toast feedback.

## Secrets catalog
External-API intelligence collectors require the following Replit Secrets. All are read directly from `process.env`. If a secret is missing, the corresponding collector throws a clear, actionable error and writes a `fetch_failed` audit entry — it never writes signals.

| Secret | Used by | Where to get it |
| --- | --- | --- |
| `EIA_API_KEY` | `eia-energy` collector (WTI crude, Henry Hub gas, US retail diesel/gasoline, US industrial electricity) | Free registration at https://www.eia.gov/opendata/register.php |

## Conventions
- All PK columns are `text` (already pushed) — **never** change PK types.
- Server logging: `req.log` in handlers; the `logger` singleton elsewhere. Never `console.log` in server code.
- Frontend uses orval‑generated React Query hooks from `@workspace/api-client-react`.
- Workflows are how the apps run; do not run `pnpm dev` at the root.

See `.local/skills/pnpm-workspace/SKILL.md` for monorepo conventions.
