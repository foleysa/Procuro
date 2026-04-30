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
- `/` — **Spend Overview** (class / category / supplier / BU + concentration KPIs)
- `/opportunities` — **Opportunities Feed** (grouped by lever, filterable by status & lever)
- `/opportunities/:id` — **Opportunity detail** (approve / reject‑with‑reason / execute / realize)
- `/approvals` — **Pipeline** (Proposed → Approved → Executing → Realized + Rejected)
- `/ooda` — **OODA Wheel** (5‑stage diagram, cycle history, prior deltas, "Run next cycle")
- `/results` — **Results & Billing** (realized $, contingency owed, by‑lever breakdown)
- `/playbook` — **Procurement Playbook** (Tier 1–4 lever ladder w/ shipped vs starter vs planned)
- `/collectors` — **Collector Registry** (intelligence sources + recent market signals + run‑now)
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

## Conventions
- All PK columns are `text` (already pushed) — **never** change PK types.
- Server logging: `req.log` in handlers; the `logger` singleton elsewhere. Never `console.log` in server code.
- Frontend uses orval‑generated React Query hooks from `@workspace/api-client-react`.
- Workflows are how the apps run; do not run `pnpm dev` at the root.

See `.local/skills/pnpm-workspace/SKILL.md` for monorepo conventions.
