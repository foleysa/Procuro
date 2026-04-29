# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/scripts exec tsx /home/runner/workspace/artifacts/api-server/src/scripts/seed.ts` — re-seed demo data

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Apps

### `command-center` (artifact)
Multi-tenant Outcome Ledger + Agent Registry — a procurement-AI Results-as-a-Service control plane. Three pages: Dashboard (KPIs, charts, activity feed), Agents registry (list + detail + register/edit), Outcome Ledger (filterable claims table with verify/deny workflow and event-history drawer).

### `api-server` (artifact)
Express + Drizzle. Tenant scoping via `x-org-id` header (validated against `orgs` table; dev-only fallback to first org). Append-only `claim_events` table records every state transition. Routes:
- `GET /api/orgs`
- `GET|POST /api/agents`, `GET|PATCH /api/agents/:id`
- `GET|POST /api/outcome-claims`, `GET /api/outcome-claims/:id`, `POST /api/outcome-claims/:id/verify`, `POST /api/outcome-claims/:id/deny`
- `GET /api/ledger/{summary,recent-activity,value-by-agent,value-over-time}`

Claim state machine: `claimed → verified | denied`; `invoiced` is terminal. `verify`/`deny` reject re-transitions with HTTP 409.

### Seed data
2 orgs (SCIS Procurement Services + ProcureWorks Inc.). SCIS has 4 agents and ~30 historical claims spread across the last 30 days with a mix of statuses; ProcureWorks has 2 agents and 5 claims.
