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
    - **Funnel observability substrate (task #185):** every completed cycle writes one `funnel_snapshots` row with a 10-stage breakdown, per-cohort identity drill-down (lever `cohortKey()`), and prior calibration verdicts (median absolute error per `(lever, window∈{7d,30d,90d})`). After persistence, `detectAndAnnotateDeltas` writes `source='auto'` rows into `funnel_annotations` when a stage moves ≥25% AND ≥per-stage abs floor vs the median of the prior 5 snapshots (5-cycle warmup gate). Writer failures upsert into `funnel_snapshot_failures` (24h recurrence collapse) and bump an in-process counter; the writer never propagates errors into the cycle. Admin surface: `/admin/funnel` (gated by `AdminGuard`) with snapshots, lowest-conversion, and failures tabs. REST under `/api/admin/funnel/...` (`audit:read` tenant, `platform:manage` cross-tenant). Operator runbook: `artifacts/api-server/src/lib/ooda/README.funnel.md`.
    - **Auto-scheduled every 6h** by `startAnalysisCycleScheduler()` in the API server boot. Each tick enqueues a single system-scoped `analysis_cycle_fanout` job (advisory-lock-protected against duplicates), whose handler iterates every org and enqueues one `run_analysis_cycle` job per tenant — skipping tenants that already have a pending/running cycle so on-demand "Run now" overrides don't pile up duplicates. Interval overridable via `ANALYSIS_CYCLE_INTERVAL_MS`. The dedicated OODA Wheel page was retired; the last-cycle summary (gen, opportunities surfaced, projected savings) is folded into the Dashboard's "Recent analysis cycles" card, while every cycle remains individually visible/cancelable as a `run_analysis_cycle` row on System / Jobs.
- **`lib/job-runner` (Postgres-backed Job Queue):**
    - Uses a `jobs` table as a queue for tasks like `run_analysis_cycle`, `ingest_csv`, `run_collector`.
    - Features per-tenant rate limiting and operator cancellation. Cancelled jobs land in a dedicated `cancelled` terminal status (distinct from `failed`) so the System page can show "operator stopped this" separately from "the system tried and could not". `pruneOldJobs` extends the failed-retention window to cancelled rows so the two share one cleanup contract.
    - Allows per-tenant adjustment of retry budgets via the `job_kind_settings` table (composite PK `(org_id, kind)`). `enqueueJob` consults `resolveMaxAttempts(kind, orgId)` at insert time and falls back to the in-code `MAX_ATTEMPTS_BY_KIND` defaults; system jobs without an `orgId` always use the default. Operators edit their org's overrides from the System / Jobs page via `GET/PUT/DELETE /api/jobs/settings[/:kind]` (all gated by `tenantMiddleware`, so cross-tenant edits are impossible). Each override row carries `last_changed_by` / `last_changed_at` audit columns, surfaced in the Retry Budgets table. Overrides apply to the next enqueue; in-flight jobs keep the per-row `max_attempts` they were created with.
    - Platform Admin endpoints `GET /api/system/cleanup/status` and `POST /api/system/cleanup/run` expose the last `prune_jobs` row + retention windows and let an operator enqueue an on-demand cleanup. The System page surfaces these via a "Job-history cleanup" card with a "Run cleanup now" button. A second card on the same page renders CSV ingest throughput trends (p50/p95 latency and rows-per-second) computed client-side from succeeded `ingest_csv` job rows; the per-batch `csv_batch_latency_ms` structured log emitted by `streamCsvEntity` provides finer-grained data for log-based analysis.
    - Long-running collectors thread an `AbortSignal` through `IntelligenceCollector.collect`/`collectWithRaw` into the underlying `fetch()` calls. The runtime polls `isCancelled` every 500ms and aborts the controller so a cancellation request stops in-flight HTTP work without waiting for the natural timeout.
- **`artifacts/api-server` (Express API):**
    - Enforces tenant isolation via `x-org-id` header validation.
    - Provides APIs for `health`, `orgs`, `me`, `spend`, `suppliers`, `opportunities`, `cycles`, `collectors`, `market-signals`, `jobs`, `ingest`, `billing`.
    - All endpoints inherently filter data by `orgId`.
    - `GET /suppliers/:id/intelligence` joins `market_signals` to a supplier via `metadata.entityUid` (from `resolveEntity`) OR case-insensitive `scope_supplier_name`, restricted to the Phase-2 supplier-intelligence signal types (`sanctions_match`, `risk_screening_match`, `corporate_filing`, `entity_registry`, `facility_emissions`, `natural_hazard`, `event_geocoded`). Each row carries the collector `contract` so the client can render disclosure-tier-respecting citations. Per-row headlines/details are rendered in `lib/supplier-intelligence.ts` (unit-tested).
    - **Auth & RBAC:** Multi-strategy auth resolved by `tenantMiddleware`: bearer API key (`api_keys` table, `proc_*` token, sha256-hashed) → Clerk session (`@clerk/express`, `x-org-id` selects active tenant from the user's `user_roles`) → dev fallback (only when `ALLOW_DEV_TENANT_HEADER=true`). RBAC roles: `platform_admin`, `org_admin`, `approver`, `analyst`, `read_only`, `auditor` — see `lib/rbac.ts` for the full permission matrix. Mutations are gated by `requirePermission(...)`; every admin mutation appends to `admin_audit_log` via `writeAdminAudit`. SCIM 2.0 stub at `/api/scim/v2/orgs/<orgId>/Users|Groups` accepts an org_admin-scoped API key as the bearer.
- **`artifacts/command-center` (Operator UI):**
    - A React-based frontend providing an executive dashboard (with a folded-in "Recent analysis cycles" summary), spend overview, opportunities feed, results and billing reports, procurement playbook, collector registry, contracts list/detail/calendar, and data ingest UI.
    - Supports CSV upload for various datasets, with streaming capabilities for large files and real-time progress updates using NDJSON.
    - `pages/supplier-detail.tsx` (`/suppliers/:id`) renders a supplier-detail page with a "Risk & Filings" panel powered by `useGetSupplierIntelligence`. Top-10 supplier rows on the spend page link to it. Each row reuses `<InsightCitations>` so attribution honors `usePolicy()` (the tenant's `disclosurePolicy`).
    - **Auth UI:** Clerk-powered with `/sign-in` and `/sign-up` routes themed via `@clerk/themes/shadcn`. The fetch shim in `main.tsx` only adds `x-org-id` to same-origin `/api/*` requests so external Clerk requests aren't blocked by CORS preflight.
    - **Org Admin (`/admin`):** five-tab shell (Users, SSO, API keys, Tenant settings, Audit log) gated to `org_admin` / `platform_admin` via `useMyRole` hook (calls `/api/admin/whoami`). Admin endpoints intentionally live outside the OpenAPI spec — consumed via the hand-rolled `lib/admin-client.ts` wrapper.

- **Defense Pack v1 (`/fusion?tab=defense`):**
    - Gemini 2.5 Flash–generated, citation-verified procurement memos. Buyer fills the Defense Pack Builder (supplier, scope = material/category/contract line, position, length, free-text note) and the server returns a buyer-ready memo + frozen Evidence Room snapshot.
    - Pipeline (server-side): assemble evidence pool from `market_signals` (T1/T2 only for citations, T3 narrative-only for standard/analyst tenants, T4 never) → sanitise buyer-typed text against prompt-injection vectors (`lib/defense-pack/sanitize.ts`: role-switch tokens, instruction-override phrasing, URL-as-instruction, base64 blobs, length cap) → call Gemini 2.5 Flash via `@workspace/integrations-gemini-ai` with structured-output schema → verify every claim's `signalId`+tier+value-tolerance against the snapshot (`lib/defense-pack/verify.ts`, default rel 1% / abs 0.01) → render PDF with pdfkit (`lib/defense-pack/pdf.ts`).
    - Insufficient-evidence path: if any cited section has zero verified claims, status flips to `insufficient_evidence` with a human-readable reason; the UI shows a warning banner instead of the memo.
    - Cost guardrails: per-tenant cap of 50 packs/UTC-day; estimated USD cost stored as `numeric(10,5)` per pack from input/output token counts.
    - Persistence: `defense_packs` (sections + frozen `evidence_snapshot` jsonb), `defense_pack_outcomes` (feedback). Permalink == pack id (`dpk_*`).
    - Routes (`/api/defense-packs/...`): `GET /` list, `POST /` generate, `GET /:id`, `GET /:id/pdf` PDF download, `POST /:id/feedback`.
    - Tests: `defense-pack-sanitize.test.ts`, `defense-pack-verify.test.ts` (pure-function unit tests, no DB).

- **Bands routing model + 4-layer category resolution (task #213):**
    - Truth tables: `category_bands` (category code → band) and `lever_bands` (lever id → band, with `rank`). Materialized view `v_category_lever_mappings` joins them and is refreshed by AFTER INSERT/DELETE triggers (`bootstrapCategoryLeverMappings()` runs at boot).
    - Tenant-string resolution layers: A `synonym_registry` (global + tenant-scoped, `source` filter excludes auto-only rows in v1) → B `unmapped_category_queue` fallback (auto-enqueues misses, accumulates 90d spend on conflict) → C admin operator resolution → D learning (out of scope for v1).
    - `opportunities.mapped_via` is stamped at insert time by `cycle.ts` (uses `determineOpportunityMappedVia()`); `funnel.ts` calibration WHERE excludes `mapped_via = 'unmapped_default'` so unrouted strings can't poison weights. Resolving a queue entry is **forward-only**: existing matching opportunities get `re_categorized_after_persistence=1` for audit traceability but their `mapped_via` is never rewritten.
    - Public API surface: only `lib/intelligence/routing/index.ts`. The `routing-boundary.test.ts` guardrail fails any deep import of `routing/synonym`, `routing/queue`, etc. from outside the routing dir.
    - Operational health: `routing_health_check` job kind runs every 6h (`startRoutingHealthScheduler`), counts `category_bands ⋈ lever_bands` vs the materialized view, attempts a refresh, and throws `UnrecoverableJobError` if drift remains. The resulting `failed` job row is picked up by `synthesize_operational_alerts` as `operational_job_failed` — the snapshot-failure-style alert path.
    - Admin UI: `/admin/funnel` → "Routing" tab surfaces `MappingDataHealthCard` (queue depth, oldest age, unmapped spend, materialized view status) and `RoutingQueueTab` (queue list with canonical-code dropdown, scope toggle global/tenant, collision detection on resolve).
    - REST: `/api/admin/routing/{queue,queue/:id/resolve,canonical-codes,health}` and `/api/admin/funnel/mapping-data-health`.

- **Contracts UI + renewal alerts:**
    - `/contracts` list with cursor pagination, status / supplier / category / currency / owner filters, and a `?view=calendar` toggle that renders the next 12 months on a colour-coded grid.
    - `/contracts/:id` detail page surfaces header KPIs, an inline edit form (owner / internalNotes / renewalTargetDate / renewalTargetAction), linked opportunities (via `inputs.contractId`), an FX-trend card filtered to the contract's billing-currency pair, a market-signals (PPI) card, disclosure-policy-aware citations, contracted items, and an activity timeline backed by `contract_audit_log` (one row per changed field, written transactionally inside PATCH).
    - Cross-link from opportunity detail back to the source contract whenever `opp.inputs.contractId` is set.
    - Daily `renewal_alert_scan` job worker scans every tenant; reads `orgs.settings.contractRenewalAlertDays` (default 90) and inserts `alerts` rows with `dedupeKey = renewal:${contractId}:${threshold}` under a unique index on `(org_id, kind, dedupe_key)`, so reruns are idempotent. The threshold is also appended to `contracts.renewal_alerted_thresholds` so the UI can render the "Alerted at Xd" badge without joining `alerts`.

## Known issues / hazards

- **`alerts` schema drift (P1, surfaced via #209).** The Drizzle source schema in `lib/db/src/schema/alerts.ts` declares `state`, `source`, `payload`, `acknowledgedAt`, `snoozedUntil` (the #117 alerts redesign), but the live shipping database still has the legacy column set: `body`, `ref_type`, `ref_id`, `metadata`, `resolved_at`. **No migration has been run.** Any code path that reads or writes the new columns will crash at SQL parse time with `column "alerts"."state" does not exist`. This is the root cause of #208's "Today is broken" report — the original Today aggregator's alerts query did `groupBy(alertsTable.state)` and threw, marking the whole alerts source as failed in `errors[]`.
    - **Workaround in place (#209):** the Today aggregator's alerts sub-query was rewritten to use only schema-drift-safe columns (filter on `resolvedAt IS NULL`, group by `severity`). All other call sites that use the new alerts shape are at risk and must be audited before the next deploy that touches alerts.
    - **Real fix:** ship the #117 alerts schema migration and reconcile callers. Owner: TBD. Until then, do not add new code that relies on `alerts.state` / `alerts.source` / `alerts.payload`.
- **#208 was misdiagnosed.** It read as a feature request ("Today UX is bad") but the underlying signal was a database error masked by the aggregator's fail-soft contract. #209 is the UX patch on top of the workaround; the schema-drift root cause above is the still-unresolved P1.
- **`funnel_annotations` / `funnel_snapshots` schema drift (also P1, surfaced via #209 investigation).** The Today substrate-reader queries (`getRecentAutoAnnotations`, `getCycleConversionRateDeltas`) fail at SQL parse time with `parserOpenTable` errors against the live database — the source schema declares tables/columns that don't exist there. This is independent of the alerts drift above but the same class of issue. Symptom: every live `/api/today/feed` response includes `funnelAutoAnnotations` and `funnelConversionDeltas` in `errors[]`. The aggregator's fail-soft contract (and #209's render-time scrubber) keep the page usable, but the "What changed since last cycle" card permanently shows its admin-only failure ribbon. Pre-existing — not introduced by #209.
- **Render-time error scrubber is denylist-shaped.** `artifacts/command-center/src/lib/scrub-error.ts` strips known leak markers (SQL keywords, `$N` params, `params:` blobs, file paths, stack frames) from any string about to be rendered in a per-source failure ribbon on the Today page. The proper long-term contract is a template-allowlist (only render error strings drawn from a known-safe registry); that's a follow-up for the substrate-driven Today (#204). Until then, audit any new failure-rendering surface and route through `scrubError()`.

## External Dependencies

- **PostgreSQL:** Primary database.
- **OpenAPI 3:** For API contract definition.
- **Orval:** API client generation.
- **shadcn/ui:** UI component library.
- **Tailwind CSS v4:** Styling framework.
- **BLS API:** For `blsEconomicIndexCollector` (Bureau of Labor Statistics data).
- **EIA API:** For `eia-energy` collector (Energy Information Administration data).