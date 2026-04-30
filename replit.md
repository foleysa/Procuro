# Procuro — Procurement‑as‑a‑Service

## Overview

Procuro is a Procurement RaaS (Revenue-as-a-Service) MVP designed to integrate with client ERP systems, analyze their spending data, identify Tier-1 procurement opportunities, and bill based on realized savings. It aims for F500 scale and full multi-tenancy. The project focuses on automating and optimizing procurement processes to drive significant cost savings for large enterprises.

## User Preferences

- All PK columns are `text` (already pushed) — **never** change PK types.
- Server logging: `req.log` in handlers; the `logger` singleton elsewhere. Never `console.log` in server code.
- Frontend uses orval‑generated React Query hooks from `@workspace/api-client-react`.
- Workflows are how the apps run; do not run `pnpm dev` at the root.

## System Architecture

The project is built as a pnpm monorepo using Node.js 24 and TypeScript 5.9.

**Core Technologies:**
- **API:** Express 5
- **Database:** PostgreSQL with Drizzle ORM (all primary keys are `text` type)
- **Validation:** Zod (`zod/v4`), `drizzle-zod`
- **API Contract:** OpenAPI 3, with Orval generating React Query hooks and Zod schemas
- **Frontend:** React 18, Vite, wouter for routing, shadcn/ui for UI components, and Tailwind CSS v4

**Architectural Components:**

- **`lib/db` (Canonical Procurement Schema):**
    - Multi-tenant design: every domain row includes `tenant_id`, `source_system`, `source_external_id`, and `source_synced_at`.
    - Key tables: `orgs`, `users`, `suppliers`, `categories`, `items`, `contracts`, `purchase_orders`, `invoices`, `payments`, `shipments`, `raw_material_usage`, `opportunities`, `decisions`, `realized_savings`, `analysis_cycles`, `learned_priors`, `market_signals`, `collectors`, `collector_audit_log`, `jobs`.
- **`lib/source-adapters` (Ingestion Abstraction):**
    - Defines `SourceAdapter` and `IntelligenceCollector` interfaces for data ingestion.
    - Includes built-in collectors like `publishedCommodityIndexCollector` and `blsEconomicIndexCollector` for market signals.
- **`lib/analyzers` (Tier-1 Lever Analyzers):**
    - Seven shipped analyzers: `sku_price_benchmark`, `maverick_spend`, `contract_leakage`, `duplicate_payment`, `missed_volume_threshold`, `payment_term_extension`, `tail_spend_rationalization`.
    - Emits typed `Opportunity` rows. `spot_vs_contract` analyzer integrates market signals with procurement spend.
- **`lib/ooda` (OODA Cycle Runner):**
    - Implements the Observe, Orient, Decide, Act, Learn (OODA) loop for each tenant.
    - Persists cycle payloads on `analysis_cycles` and manages `learned_priors` for calibration.
- **`lib/job-runner` (Postgres-backed Job Queue):**
    - Uses a `jobs` table as a queue for tasks like `run_analysis_cycle`, `ingest_csv`, `run_collector`.
    - Features per-tenant rate limiting and operator cancellation.
    - Allows per-tenant adjustment of retry budgets via the `job_kind_settings` table (composite PK `(org_id, kind)`). `enqueueJob` consults `resolveMaxAttempts(kind, orgId)` at insert time and falls back to the in-code `MAX_ATTEMPTS_BY_KIND` defaults; system jobs without an `orgId` always use the default. Operators edit their org's overrides from the System / Jobs page via `GET/PUT /api/jobs/settings[/:kind]` (both gated by `tenantMiddleware`, so cross-tenant edits are impossible). Overrides apply to the next enqueue; in-flight jobs keep the per-row `max_attempts` they were created with.
- **`artifacts/api-server` (Express API):**
    - Enforces tenant isolation via `x-org-id` header validation.
    - Provides APIs for `health`, `orgs`, `me`, `spend`, `suppliers`, `opportunities`, `cycles`, `collectors`, `market-signals`, `jobs`, `ingest`, `billing`.
    - All endpoints inherently filter data by `orgId`.
- **`artifacts/command-center` (Operator UI):**
    - A React-based frontend providing an executive dashboard, spend overview, opportunities feed, OODA wheel visualization, results and billing reports, procurement playbook, collector registry, and data ingest UI.
    - Supports CSV upload for various datasets, with streaming capabilities for large files and real-time progress updates using NDJSON.

## External Dependencies

- **PostgreSQL:** Primary database.
- **OpenAPI 3:** For API contract definition.
- **Orval:** API client generation.
- **shadcn/ui:** UI component library.
- **Tailwind CSS v4:** Styling framework.
- **BLS API:** For `blsEconomicIndexCollector` (Bureau of Labor Statistics data).
- **EIA API:** For `eia-energy` collector (Energy Information Administration data).