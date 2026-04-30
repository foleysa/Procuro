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
    - **`lib/connectors/erp-connector` + Coupa adapter:** ERP connector framework with a per-tenant `erp_connections` table (AES-GCM encrypted credentials via `ERP_CREDENTIAL_ENCRYPTION_KEY`, per-entity `watermarks` JSON). The shared `ingest-writer.ts` is reused so CSV and ERP adapters share idempotent upsert logic; ERP rows are tagged `source_system="erp_<key>"`. Coupa is the first adapter (OAuth2 client_credentials, paged REST fetch with `?updated-at[gt]=` watermarks, T2 disclosure / US / 365d retention). Sync runs as the `sync_erp_connection` job kind; failures land in `last_error` and flip status to `error`. Routes live under `/api/integrations/...` and are gated by `requireOrgAdmin` (the `x-org-admin-token` header).
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
    - `GET /suppliers/:id/intelligence` joins `market_signals` to a supplier via `metadata.entityUid` (from `resolveEntity`) OR case-insensitive `scope_supplier_name`, restricted to the Phase-2 supplier-intelligence signal types (`sanctions_match`, `risk_screening_match`, `corporate_filing`, `entity_registry`, `facility_emissions`, `natural_hazard`, `event_geocoded`). Each row carries the collector `contract` so the client can render disclosure-tier-respecting citations. Per-row headlines/details are rendered in `lib/supplier-intelligence.ts` (unit-tested).
    - **Auth & RBAC:** Multi-strategy auth resolved by `tenantMiddleware`: bearer API key (`api_keys` table, `proc_*` token, sha256-hashed) → Clerk session (`@clerk/express`, `x-org-id` selects active tenant from the user's `user_roles`) → dev fallback (only when `ALLOW_DEV_TENANT_HEADER=true`). RBAC roles: `platform_admin`, `org_admin`, `approver`, `analyst`, `read_only`, `auditor` — see `lib/rbac.ts` for the full permission matrix. Mutations are gated by `requirePermission(...)`; every admin mutation appends to `admin_audit_log` via `writeAdminAudit`. SCIM 2.0 stub at `/api/scim/v2/orgs/<orgId>/Users|Groups` accepts an org_admin-scoped API key as the bearer.
- **`artifacts/command-center` (Operator UI):**
    - A React-based frontend providing an executive dashboard, spend overview, opportunities feed, OODA wheel visualization, results and billing reports, procurement playbook, collector registry, contracts list/detail/calendar, and data ingest UI.
    - Supports CSV upload for various datasets, with streaming capabilities for large files and real-time progress updates using NDJSON.
    - `pages/supplier-detail.tsx` (`/suppliers/:id`) renders a supplier-detail page with a "Risk & Filings" panel powered by `useGetSupplierIntelligence`. Top-10 supplier rows on the spend page link to it. Each row reuses `<InsightCitations>` so attribution honors `usePolicy()` (the tenant's `disclosurePolicy`).
    - **Auth UI:** Clerk-powered with `/sign-in` and `/sign-up` routes themed via `@clerk/themes/shadcn`. The fetch shim in `main.tsx` only adds `x-org-id` to same-origin `/api/*` requests so external Clerk requests aren't blocked by CORS preflight.
    - **Org Admin (`/admin`):** five-tab shell (Users, SSO, API keys, Tenant settings, Audit log) gated to `org_admin` / `platform_admin` via `useMyRole` hook (calls `/api/admin/whoami`). Admin endpoints intentionally live outside the OpenAPI spec — consumed via the hand-rolled `lib/admin-client.ts` wrapper.

- **Contracts UI + renewal alerts:**
    - `/contracts` list with cursor pagination, status / supplier / category / currency / owner filters, and a `?view=calendar` toggle that renders the next 12 months on a colour-coded grid.
    - `/contracts/:id` detail page surfaces header KPIs, an inline edit form (owner / internalNotes / renewalTargetDate / renewalTargetAction), linked opportunities (via `inputs.contractId`), an FX-trend card filtered to the contract's billing-currency pair, a market-signals (PPI) card, disclosure-policy-aware citations, contracted items, and an activity timeline backed by `contract_audit_log` (one row per changed field, written transactionally inside PATCH).
    - Cross-link from opportunity detail back to the source contract whenever `opp.inputs.contractId` is set.
    - Daily `renewal_alert_scan` job worker scans every tenant; reads `orgs.settings.contractRenewalAlertDays` (default 90) and inserts `alerts` rows with `dedupeKey = renewal:${contractId}:${threshold}` under a unique index on `(org_id, kind, dedupe_key)`, so reruns are idempotent. The threshold is also appended to `contracts.renewal_alerted_thresholds` so the UI can render the "Alerted at Xd" badge without joining `alerts`.

## External Dependencies

- **PostgreSQL:** Primary database.
- **OpenAPI 3:** For API contract definition.
- **Orval:** API client generation.
- **shadcn/ui:** UI component library.
- **Tailwind CSS v4:** Styling framework.
- **BLS API:** For `blsEconomicIndexCollector` (Bureau of Labor Statistics data).
- **EIA API:** For `eia-energy` collector (Energy Information Administration data).