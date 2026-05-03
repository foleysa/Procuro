# Threat Model

## Project Overview

Procuro is a multi-tenant procurement analytics platform with an Express 5 API (`artifacts/api-server`), a React/Vite operator UI (`artifacts/command-center`), and a PostgreSQL database accessed through Drizzle ORM. Tenants ingest ERP or CSV spend data, run OODA analysis cycles, review procurement opportunities, and track realized savings. In production, tenant access is intended to be enforced with bearer API tokens; Replit provides TLS in front of the deployed app.

The primary production attack surface is the API server. `artifacts/mockup-sandbox`, seed/codegen scripts, and other local-development utilities are dev-only unless a future scan demonstrates production reachability.

## Assets

- **Tenant procurement data** — suppliers, contracts, purchase orders, invoices, payments, shipments, opportunities, and savings data. Cross-tenant disclosure or tampering would expose sensitive spend patterns and corrupt business outcomes.
- **Tenant API tokens and roles** — bearer credentials stored as SHA-256 hashes plus user/API-key role assignments. A valid credential must grant only its intended tenant-scoped capabilities and must never cross into platform-administrator authority.
- **External integration and alert delivery credentials** — ERP OAuth credentials, webhook signing secrets, and Slack/Teams/webhook URLs stored for tenant integrations and alert delivery. These are sensitive bearer-like credentials and should not be returned after write.
- **Decision and audit history** — cycle triggers, opportunity approvals/rejections/executions/realizations, and collector audit records. These records matter for accountability, billing, and operator trust.
- **Platform control-plane secrets** — especially `PLATFORM_ADMIN_TOKEN`, which gates collector-management endpoints and other system-level operations that operate across tenants.
- **Service availability** — ingestion, job processing, and analysis-cycle execution are core workloads in a shared multi-tenant backend; one tenant should not be able to starve others.

## Trust Boundaries

- **Client / API boundary** — browsers, mobile clients, and integrations call the Express API. The client is untrusted; all authn, authz, validation, and workload controls must be enforced server-side.
- **API / PostgreSQL boundary** — the API has direct database access. Query scoping and parameterization must prevent cross-tenant reads/writes and injection.
- **Tenant / tenant boundary** — every request must stay bound to a single org, and tenant-supplied headers or IDs must never override that binding in production.
- **Tenant / platform-admin boundary** — collector registration, kill-switch, audit, background job control, and execution controls are platform-wide and must be isolated from normal tenant capabilities.
- **API / external network boundary** — tenant-configurable integrations and alert destinations cause the server to make outbound requests. Production egress must prevent tenant input from reaching loopback, link-local, private infrastructure, metadata services, or unintended third-party hosts.
- **Production / dev-only boundary** — dev fallbacks such as header-based tenant selection and seeded-org defaults may exist locally but must stay disabled in production.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/index.ts`, and `artifacts/api-server/src/routes/*.ts`.
- **Highest-risk areas:** `artifacts/api-server/src/lib/tenant.ts`, `lib/auth.ts`, `lib/platform-admin.ts`, `routes/admin-users.ts`, `routes/ingest.ts`, `routes/jobs.ts`, `routes/cycles.ts`, `routes/alerts.ts`, `routes/integrations.ts`, `routes/opportunities.ts`, and collector runtime code under `src/lib/intelligence/`.
- **Authenticated tenant surfaces:** `/me`, `/spend`, `/suppliers`, `/opportunities`, `/cycles`, `/jobs`, `/ingest`, `/billing`, `/market-signals`, `/alert-*`, `/integrations`, and collector listing.
- **Platform-admin surfaces:** collector mutation, run, kill/unkill, and audit endpoints in `routes/collectors.ts`.
- **Usually dev-only / ignore unless proven reachable:** `artifacts/mockup-sandbox/**`, `scripts/**`, generated API clients/specs, and local bootstrap conveniences that require `NODE_ENV !== "production"`.

## Threat Categories

### Spoofing

Production requests that access tenant data must require a valid bearer token and must derive tenant scope from the server-side token lookup, not from caller-controlled tenant hints. Any identity recorded in decision logs, cycle history, or audit trails must come from authenticated context rather than caller-supplied headers.

Platform control-plane endpoints must accept only the configured platform admin secret in production. Missing configuration should fail closed rather than silently downgrading to tenant or anonymous access.

### Tampering

All mutation routes must enforce tenant scoping in every database write, including opportunity lifecycle transitions, ingest upserts, and cycle updates. Business-state transitions such as approve/reject/execute/realize must be validated server-side so callers cannot force invalid states or alter another tenant’s records.

### Information Disclosure

API responses, job metadata, logs, integration views, alert channel views, and collector/audit outputs must not leak another tenant’s data, platform-only operational details, or stored delivery credentials. Shared/global records that are intentionally visible across tenants must be narrowly defined; internal results, errors, or secrets must not be exposed through convenience endpoints.

### Denial of Service

Authenticated tenants must not be able to monopolize CPU, memory, request-processing time, or the shared job worker by submitting oversized ingest payloads or enqueuing unbounded work. Expensive operations need sensible body-size limits, rate limits or quotas, and fair queueing so one tenant cannot degrade service for all others.

### Elevation of Privilege

Tenant-scoped credentials must never gain access to platform-admin controls, and tenant hints such as `x-org-id` must not override token-derived authorization in production. Cross-tenant or platform-wide operations require explicit server-side checks on every route, not frontend assumptions.
