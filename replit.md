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

## Testing

- **`lib/db`**: Vitest unit tests for S2P business logic (DOA tiers, gate SLA breach, backfill mapping, baseline validation). Run: `pnpm --filter @workspace/db run test`
- **`api-server`**: Node native test runner with real dev DB for integration tests (stage transitions, CFO insurance gate, lifecycle). Run: `pnpm --filter @workspace/api-server run test`
- **`command-center`**: Vitest for frontend component tests. Run: `pnpm --filter @workspace/command-center run test`
- **Accessibility (a11y)**: Playwright + axe-core WCAG 2.2 AA scan across ~40 routes. Run: `pnpm run test:a11y`. Registered as a CI validation (`a11y`) and included in `pnpm run check`. New serious/critical violations block the build; baselined violations (`.a11y-baseline.json`) pass through. Config: `playwright.a11y.config.ts`, tests: `tests/a11y/`, routes: `tests/a11y/routes.ts`. Scan results can be persisted to the `a11y_scan_results` table via `pnpm --filter @workspace/scripts run ingest-a11y`, and trends are viewable at `/admin/a11y` (platform admin only). A route-coverage check (`tests/a11y/route-coverage.test.ts`) compares App.tsx router definitions against the a11y inventory and fails if new pages are missing or stale entries remain.
- **All suites**: `pnpm run test` (filters `lib/**` and `artifacts/**`)
- Key shared modules: `lib/db/src/s2p-helpers.ts` (backfill mapping, baseline validation), `lib/db/src/hard-savings.ts` (aggregate gate query)
- Fixture factory: `lib/db/test/fixtures/factory.ts` (`makeOpportunity`, `makeBackfilledOpportunity`, `makeUser`)
- **Visual regression**: Playwright screenshot comparison across all routes × 2 viewports (desktop 1440×900, tablet 768×1024) × 2 themes (light/dark). Chromium and Firefox run by default; WebKit (Safari) is opt-in via `VISUAL_BROWSERS=webkit-visual`. All three browsers have committed baselines. WebKit requires system deps — run `pnpm --filter @workspace/scripts run setup-webkit-deps` after a fresh env. Run: `pnpm test:visual`. Update baselines: `pnpm test:visual:update`. Config: `playwright.visual.config.ts`. Baselines committed in `tests/visual/baselines/`. See `docs/visual-regression.md`.
- See `tests/README.md` for full details.

## Post-Merge Setup

The post-merge script (`scripts/post-merge.sh`) runs automatically after task merges. It installs dependencies, pushes the DB schema, and runs backfills.

**Clean-start mode:** Set the environment variable `CLEAR_DATA_ON_MERGE=1` to wipe all business data (orgs, suppliers, opportunities, etc.) before backfills run. This is useful for fresh environments or when stale demo data must not linger. System-config tables (lever_bands, category_bands, synonym_registry, etc.) are preserved. When the variable is unset or `0`, the data-clearing step is skipped entirely.

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
- **Notion:** Connected via Replit native integration (connector `notion`). Use the credentials proxy at `https://${REPLIT_CONNECTORS_HOSTNAME}/api/v2/connection?include_secrets=true&connector_names=notion` with `X_REPLIT_TOKEN: "repl " + REPL_IDENTITY` to fetch a fresh `access_token`, then call `https://api.notion.com/v1/...` with `Notion-Version: 2022-06-28`. Never cache the token.

## Notion workspace map ("FSA Operating")

Top-level page `FSA Operating` (`3554a7a5-85e9-80ff-9875-f3bab7730935`) contains:

- `1. Operating Protocol` — `3554a7a5-85e9-801b-9c0d-c90c60ac4ec2` — **read before starting any task**
  - `Correction Log` — `3554a7a5-85e9-80ce-8a08-ed0cff64c80c`
  - `Decision Registry` — `3554a7a5-85e9-80a8-a87b-ffa80d5b5839`
  - `Project State Ledger` — `3554a7a5-85e9-80f8-a512-f1c23036d511`
  - `Stale File Index` — `3554a7a5-85e9-80d4-bb2e-e96a50fd60f2`
  - `Lawyer Conditions` — `3554a7a5-85e9-80d3-96d2-c62800b27034`
- `2. Procuro Tasks` — `3554a7a5-85e9-80fe-ba14-ffea48fc1110`
  - Inline database **`Tasks`** — `3554a7a5-85e9-81d9-b46a-e39096c7e3d7`. **Open a row at task start, update Status/Closed/Commit at end.** Schema: `Task #` (title, e.g. `#242`), `Title` (rich_text), `Status` (select: Idea / Active / Blocked / Closed), `Gate` (select: Gate 1–7 / N/A), `Priority` (select: Critical / High / Normal / Low), `Opened` (date), `Closed` (date), `Summary` (rich_text), `Commit` (rich_text). Find an existing row by querying with a `Task #` equals filter before creating a new one.
- `3. Content Pipeline` — `3554a7a5-85e9-80e5-b791-fc293c3214b5`
- `4. Pipeline (CRM)` — `3554a7a5-85e9-8039-ba93-db876b0aeedc`
- `5. Strategic Docs` — `3554a7a5-85e9-800f-a5d7-e45ddb7c1c67`