# Procuro — Procurement‑as‑a‑Service

## Overview

Procuro is a Procurement RaaS (Revenue-as-a-Service) MVP designed for F500 scale and full multi-tenancy. It integrates with client ERP systems to analyze spending data, identify Tier-1 procurement opportunities, and bills clients based on realized savings. The project aims to automate and optimize procurement processes, driving significant cost savings for large enterprises.

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

- **`lib/db` (Canonical Procurement Schema):** Designed for multi-tenancy, including tables for `orgs`, `users`, `suppliers`, `categories`, `items`, `contracts`, `purchase_orders`, `invoices`, `payments`, `shipments`, `raw_material_usage`, `opportunities`, `decisions`, `realized_savings`, `analysis_cycles`, `learned_priors`, `market_signals`, `collectors`, `collector_audit_log`, and `jobs`.
- **`lib/source-adapters` (Ingestion Abstraction):** Defines `SourceAdapter` and `IntelligenceCollector` interfaces. Includes an ERP connector framework with a Coupa adapter, handling data ingestion and idempotent upserts.
- **`lib/analyzers` (Tier-1 Lever Analyzers):** Seven built-in analyzers (e.g., `sku_price_benchmark`, `maverick_spend`, `contract_leakage`) generate typed `Opportunity` rows.
- **`lib/ooda` (OODA Cycle Runner):** Implements the Observe, Orient, Decide, Act, Learn (OODA) loop per tenant, persisting cycle payloads and managing `learned_priors`. Includes a funnel observability substrate for tracking and annotating deltas in analysis stages. Cycles are auto-scheduled every 6 hours.
- **`lib/job-runner` (Postgres-backed Job Queue):** Manages a queue of tasks using a `jobs` table, featuring per-tenant rate limiting, operator cancellation, and configurable retry budgets.
- **`artifacts/api-server` (Express API):** Enforces tenant isolation via `x-org-id` header validation and provides APIs for various domains like `health`, `orgs`, `spend`, `suppliers`, `opportunities`, `cycles`, `jobs`, and `billing`. It supports multi-strategy authentication (bearer API key, Clerk session, dev fallback) and RBAC roles (`platform_admin`, `org_admin`, `approver`, `analyst`, `read_only`, `auditor`).
- **`artifacts/command-center` (Operator UI):** A React-based frontend offering an executive dashboard, spend overview, opportunities feed, results and billing reports, procurement playbook, collector registry, contracts management, and a data ingest UI with CSV upload capabilities. It uses Clerk for authentication and provides an Org Admin section for user, SSO, API key, tenant settings, and audit log management.
- **Defense Pack v1:** Generates Gemini 2.5 Flash-powered, citation-verified procurement memos, assembling evidence from market signals and verifying claims. Includes a persistence layer for `defense_packs` and `defense_pack_outcomes`.
- **Bands routing model + 4-layer category resolution:** Implements a sophisticated category resolution system using `category_bands`, `lever_bands`, and a `synonym_registry`, with an `unmapped_category_queue` for fallback.
- **Contracts UI + renewal alerts:** Provides a UI for listing and viewing contract details with pagination, filters, calendar view, and renewal alerts based on configurable thresholds.

## External Dependencies

- **PostgreSQL:** Primary database.
- **OpenAPI 3:** API contract definition.
- **Orval:** API client generation.
- **shadcn/ui:** UI component library.
- **Tailwind CSS v4:** Styling framework.
- **BLS API:** Bureau of Labor Statistics data for `blsEconomicIndexCollector`.
- **EIA API:** Energy Information Administration data for `eia-energy` collector.
- **Clerk:** User authentication and management.
- **Gemini 2.5 Flash:** AI model for Defense Pack memo generation.