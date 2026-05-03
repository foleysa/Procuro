# Codebase Cleanup Audit — 2026-05-03

## Summary

| Metric | Value |
|---|---|
| **Total items cataloged** | 30 |
| **Category A — Fake/Mock Data** | 7 |
| **Category B — Fake/Stub APIs** | 2 |
| **Category C — Orphan Files** | 1 |
| **Category D — Dead Code Inside Live Files** | 5 |
| **Category E — Unused Dependencies / Bloat** | 3 |
| **Category F — Background Jobs & Tasks** | 12 |
| **Files affected** | ~35 |
| **Estimated removable LOC** | ~250 (dead code only; KEEP items ~2,800 LOC) |
| **Estimated removable dependencies** | 0 confirmed (see E-001–E-003 for candidates) |
| **Failing/stub jobs** | 0 (all 12 schedulers point to real handlers) |
| **KEEP items** | 23 (A:6, B:1, C:1, D:1, E:2, F:12) |
| **DELETE items** | 2 (D:2) |
| **REPLACE items** | 1 (A:1) |
| **INVESTIGATE items** | 4 (B:1, D:2, E:1) |

Reconciliation: 23 + 2 + 1 + 4 = 30 total = sum of all category counts (7+2+1+5+3+12).

### Top 10 Highest-Impact Items

1. **A-005** — `publishedCommodityIndexCollector` deterministic stub (136 LOC, generates synthetic market signals in production)
2. **D-001** — `sweepStaleAlerts` noop placeholder (19 LOC, wired in synthesize.ts but does nothing)
3. **A-002** — `scripts/src/seed.ts` services demo data (710 LOC, modifies live contract rows with `UPDATE`)
4. **B-001** — `fakeAlert` in channel test endpoint (ephemeral test alert construction)
5. **A-004** — Dev-tenant fallback in `tenant.ts` (auto-assigns first org when no auth)
6. **D-002** — `void` statements suppressing unused-import warnings in `synthesize.ts`
7. **F-003** — `analysis_cycle_fanout` fan-out enqueues per-tenant cycles globally
8. **A-001** — Onboarding sample-data loader (467 LOC, intentional but worth reviewing scope)
9. **D-004** — `placeholderId` pattern in `admin-users.ts` (pending user email-as-ID)
10. **E-002** — Duplicate concern: both `source-adapter.ts` interface and `erp-connector.ts` interface

---

## Full Inventory

### Category A — Fake/Mock Data

| ID | Category | File / Location | Description | Last Touched | Recommendation | Risk if Removed |
|---|---|---|---|---|---|---|
| A-001 | A — Fake/Mock Data | `artifacts/api-server/src/lib/onboarding/sample-data.ts` (467 LOC) | Hardcoded fixture arrays (5 suppliers, 4 contracts, 7 items, POs, invoices, payments) inserted during onboarding. Tagged with `source_system = 'sample_data'`. Has a clean `removeSampleData()` function. | Active | **KEEP** | N/A — intentional onboarding feature |
| A-002 | A — Fake/Mock Data | `scripts/src/seed.ts` (710 LOC) | Dev seed script with `seedOrgs`, `seedFxExposureDemo`, `seedTaxonomyBands`, `seedServicesDemoForOrg`. Contains hardcoded IDs (`org_seed_default`, `sup_seed_fx_eur`, etc.). The services demo block runs `UPDATE contracts SET contract_type = ...` on live rows. | Active | **KEEP** | N/A — dev-only script, not imported by runtime |
| A-003 | A — Fake/Mock Data | `artifacts/mockup-sandbox/src/components/mockups/_shared/seed.ts` (115 LOC) | Static KPI/funnel/lever constants for UI mockups. Not imported by `api-server` or `command-center`. | Active | **KEEP** | N/A — isolated to mockup sandbox |
| A-004 | A — Fake/Mock Data | `artifacts/api-server/src/lib/tenant.ts` lines 180–192 | Dev-tenant fallback: when `ALLOW_DEV_TENANT_HEADER=true` AND `NODE_ENV !== 'production'`, auto-assigns first seeded org if no auth context is present. Double-gated. | Active | **KEEP** | N/A — secure-by-default, explicit opt-in |
| A-005 | A — Fake/Mock Data | `artifacts/api-server/src/lib/intelligence/collectors/published-commodity-index.ts` (136 LOC) | **Deterministic stub collector.** Uses `Math.sin()` daily walk from hardcoded base prices (LME copper $9420.50, Brent $78.32, HRC steel $825, PE resin $1180) instead of fetching real market data. Registered in production and writes synthetic `commodity_index` signals to `market_signals` table. | Active | **REPLACE** | Medium — removing without a live feed replacement would break Tier-2 lever analyzers that depend on commodity signals |
| A-006 | A — Fake/Mock Data | `artifacts/api-server/src/lib/adapters/mock-erp-adapter.ts` (415 LOC) | Mock ERP source adapter implementing the `SourceAdapter` interface. Supports `fullSync`, `incrementalSync`, `deleteRecord`. Used by the `/ingest/mock-erp` route and the `ingest_mock_erp` job handler. | Active | **KEEP** | N/A — valid testing/demo adapter for ERP pipeline validation |
| A-007 | A — Fake/Mock Data | `artifacts/command-center/src/pages/trust-public.tsx` (196 LOC) | Public Trust Portal page with demo tenant payload. Used for unauthenticated trust showcase. Referenced in `App.tsx` routing. | Active | **KEEP** | N/A — intentional public-facing demo page |

**Category A counts:** 7 items → 6 KEEP, 1 REPLACE, 0 DELETE, 0 INVESTIGATE.

### Category B — Fake/Stub APIs

| ID | Category | File / Location | Description | Last Touched | Recommendation | Risk if Removed |
|---|---|---|---|---|---|---|
| B-001 | B — Fake/Stub APIs | `artifacts/api-server/src/routes/alerts.ts` line 638 | `fakeAlert` — ephemeral `AlertRow` object constructed for the `POST /alerts/channels/:id/test` endpoint. Used to smoke-test channel delivery without persisting a real alert. Named "fake" but is a legitimate test-delivery feature. | Active | **KEEP** | N/A — intentional test-delivery endpoint |
| B-002 | B — Fake/Stub APIs | `artifacts/api-server/src/lib/alerts/channels/slack.ts` + `teams.ts` (comments say "stub") | File-level JSDoc comments call these "stub" adapters, but the implementations are real: Slack posts to `hooks.slack.com` webhooks, Teams posts `MessageCard` JSON to webhook URLs. Both have full config validation, SSRF protection, error handling. | Active | **INVESTIGATE** | Low — code is real; only the doc comment is misleading. Recommend updating comments to remove "stub" label |

**Category B counts:** 2 items → 1 KEEP, 0 REPLACE, 0 DELETE, 1 INVESTIGATE.

### Category C — Orphan Files

| ID | Category | File / Location | Description | Last Touched | Recommendation | Risk if Removed |
|---|---|---|---|---|---|---|
| C-001 | C — Orphan Files | *(no orphan files found)* | `xlsx-parser.ts` was initially flagged but is actively imported by `world-bank-pink-sheet.ts` and `usgs-mineral.ts`. No confirmed orphan source files were identified in the scan. | N/A | **KEEP** | N/A |

**Category C counts:** 1 item → 1 KEEP, 0 REPLACE, 0 DELETE, 0 INVESTIGATE.

### Category D — Dead Code Inside Live Files

| ID | Category | File / Location | Description | Last Touched | Recommendation | Risk if Removed |
|---|---|---|---|---|---|---|
| D-001 | D — Dead Code | `artifacts/api-server/src/lib/alerts/synthesize.ts` lines 489–497 | `sweepStaleAlerts()` — exported async function that is a **complete no-op**. Body is `void _now; void alertsTable; void isNull; void lt; return 0;`. Comment says "intentionally noop — placeholder so callers can wire it in now". Not called anywhere in the codebase (grep confirms zero callers). | Active | **DELETE** | None — no callers exist; the `void` statements only suppress unused-import warnings |
| D-002 | D — Dead Code | `artifacts/api-server/src/lib/alerts/synthesize.ts` lines 493–495 | `void alertsTable; void isNull; void lt;` — three `void` statements that exist solely to suppress TypeScript unused-import errors for imports that are only needed by the noop `sweepStaleAlerts`. | Active | **DELETE** (with D-001) | None — removing the function removes the need for these imports |
| D-003 | D — Dead Code | `artifacts/api-server/src/lib/alerts/schedulers.ts` line 170 | `void jobsTable;` — standalone `void` statement at module level. Verified: `jobsTable` is imported but never referenced (SQL queries use raw `FROM jobs` strings, not the drizzle table object). The `void` suppresses the unused-import warning. | Active | **INVESTIGATE** | Low — either remove the import + void together, or switch raw SQL to drizzle for type safety |
| D-004 | D — Dead Code | `artifacts/api-server/src/routes/admin-users.ts` lines 65–104 | `placeholderId = \`pending:\${email}\`` pattern — creates a synthetic userId for invited users who haven't completed Clerk signup. Comment says "For H1 we use email as the placeholder userId". | Active | **KEEP** | N/A — legitimate pattern for pre-registration user invites |
| D-005 | D — Dead Code | `artifacts/api-server/src/lib/levers/material-index-arbitrage.ts` line 35 | JSDoc comment references `raw_material_hedging (placeholder)` as a future lever. Verified: not registered in the lever registry — comment-only aspirational reference. | Active | **INVESTIGATE** | Low — remove comment to avoid confusion, or leave as a roadmap marker |

**Category D counts:** 5 items → 1 KEEP, 0 REPLACE, 2 DELETE, 2 INVESTIGATE.

### Category E — Unused Dependencies / Bloat

| ID | Category | File / Location | Description | Last Touched | Recommendation | Risk if Removed |
|---|---|---|---|---|---|---|
| E-001 | E — Unused Deps | `artifacts/api-server/package.json` | `depcheck` analysis was inconclusive (empty JSON output). Manual review shows all major deps (`express`, `drizzle-orm`, `pg`, `zod`, `@clerk/express`, `cron-parser`, `pino`) are actively imported. No obvious unused packages found. | Active | **KEEP** | N/A |
| E-002 | E — Unused Deps | `artifacts/api-server/src/lib/adapters/source-adapter.ts` + `artifacts/api-server/src/lib/connectors/erp-connector.ts` | Two separate adapter interfaces for data ingestion. `SourceAdapter` (CSV, mock-ERP) predates the newer `ErpConnector` (Coupa, NetSuite, Ariba). Both are actively used but represent duplicate architectural patterns. | Active | **INVESTIGATE** | Medium — consolidation would reduce maintenance burden but requires careful migration |
| E-003 | E — Unused Deps | No `@faker-js/faker` in runtime | Confirmed: `@faker-js/faker` appears only in `pnpm-lock.yaml` (transitive or test-only). No runtime `src/` imports exist. | N/A | **KEEP** | N/A — already test-only |

**Category E counts:** 3 items → 2 KEEP, 0 REPLACE, 0 DELETE, 1 INVESTIGATE.

### Category F — Background Jobs & Tasks

All schedulers and handlers were cross-referenced. Every registered `JobKind` has both a scheduler that enqueues it and a handler that processes it. No orphan schedulers or handlers were found.

| ID | Category | Job Kind | Scheduler | Handler | Status | Recommendation | Notes |
|---|---|---|---|---|---|---|---|
| F-001 | F — Background Jobs | `prune_jobs` | `startJobPruner` (24h) | `pruneJobsHandler` | **Real** | **KEEP** | Internal DB housekeeping |
| F-002 | F — Background Jobs | `prune_funnel_snapshots` | `startFunnelSnapshotPruner` (24h) | `pruneFunnelSnapshotsHandler` | **Real** | **KEEP** | Internal DB housekeeping |
| F-003 | F — Background Jobs | `analysis_cycle_fanout` | `startAnalysisCycleScheduler` (6h) | `runAnalysisCycleFanoutHandler` | **Real** | **KEEP** | System fan-out, enqueues per-tenant `run_analysis_cycle` |
| F-004 | F — Background Jobs | `deliver_alerts` | `startAlertsDeliveryScheduler` (30s) | `deliverAlertsHandler` | **Real** | **KEEP** | Dispatches to email/Slack/Teams/webhook channels |
| F-005 | F — Background Jobs | `escalate_alerts` | `startAlertsEscalationScheduler` (5m) | `escalateAlertsHandler` | **Real** | **KEEP** | Re-delivers unacknowledged alerts |
| F-006 | F — Background Jobs | `synthesize_operational_alerts` | `startOperationalSynthScheduler` (15m) | `synthesizeOperationalAlertsHandler` | **Real** | **KEEP** | Monitors system health metrics |
| F-007 | F — Background Jobs | `renewal_alert_scan` | `startRenewalScanScheduler` (24h) | `renewalAlertScanHandler` | **Real** | **KEEP** | Daily contract renewal detection |
| F-008 | F — Background Jobs | `expire_stale_opportunities` | `startExpireStaleOpportunitiesScheduler` (24h) | `expireStaleOpportunitiesHandler` | **Real** | **KEEP** | Flips stale proposed→expired |
| F-009 | F — Background Jobs | `clear_expired_snoozes` | `startClearExpiredSnoozesScheduler` (1h) | `clearExpiredSnoozesHandler` | **Real** | **KEEP** | Clears snoozed_until past deadline |
| F-010 | F — Background Jobs | `routing_health_check` | `startRoutingHealthScheduler` (6h) | `routingHealthCheckHandler` | **Real** | **KEEP** | Materialized-view drift detection |
| F-011 | F — Background Jobs | `defense_pack_staleness_scan` | `startDefensePackStalenessScheduler` (24h) | `defensePackStalenessScanHandler` | **Real** | **KEEP** | Evidence freshness check |
| F-012 | F — Background Jobs | `sync_erp_connection` | `startErpSyncScheduler` (60s tick) | `syncErpConnectionHandler` | **Real** | **KEEP** | Per-connection ERP sync based on cron schedule |

**Category F counts:** 12 items → 12 KEEP, 0 REPLACE, 0 DELETE, 0 INVESTIGATE. All schedulers point to real handlers; zero failing or stub jobs.

**Conclusion for Category F:** The job system is clean. Every scheduler points to a real, functional handler. No fake APIs are called, no fake data is operated on. The `ingest_mock_erp` job kind is registered but only fires when explicitly triggered by an operator via the `/ingest/mock-erp` route — it is not scheduled.

---

## KEEP Items — Rationale

| ID | Item | Why Keep |
|---|---|---|
| A-001 | Onboarding sample-data loader | Intentional product feature for new tenant onboarding; tagged with `source_system='sample_data'` for clean removal; has dedicated `removeSampleData()` endpoint |
| A-002 | Dev seed script | Dev/test-only script (`scripts/src/seed.ts`); not imported by any runtime code; uses `ON CONFLICT DO NOTHING` for idempotency |
| A-003 | Mockup sandbox seed data | Completely isolated in `artifacts/mockup-sandbox`; no cross-references from api-server or command-center |
| A-004 | Dev-tenant fallback | Double-gated security: requires both `NODE_ENV !== 'production'` AND explicit `ALLOW_DEV_TENANT_HEADER=true`; auth.ts enforces a hard FATAL crash if the flag is set in production |
| A-006 | Mock ERP adapter | Valid SourceAdapter implementation for testing the ingest pipeline end-to-end; only fires on explicit operator action |
| A-007 | Trust public page | Intentional public-facing demo page routed in App.tsx |
| B-001 | `fakeAlert` in channel test | Ephemeral test object for the smoke-test delivery endpoint; never persisted |
| C-001 | No orphan files found | Initial flagged candidate (`xlsx-parser.ts`) confirmed imported by two collectors |
| D-004 | `placeholderId` pattern | Legitimate pre-registration invite pattern for Clerk integration |
| E-001 | api-server dependencies | All major packages are actively imported |
| E-003 | No faker in runtime | Already test-only |
| F-001–F-012 | All background jobs | Every scheduler has a real handler; no orphans |

## INVESTIGATE Items — Need User Decision

| ID | Item | Question |
|---|---|---|
| A-005 | `publishedCommodityIndexCollector` deterministic stub | This collector writes synthetic commodity prices to `market_signals` using `Math.sin()`. It's registered in production. **Decision needed:** Replace with a live API feed (LME, ICE, CME), or keep the deterministic stub for now? If a live feed is wired, this becomes dead code. |
| B-002 | "Stub" comments on Slack/Teams adapters | The implementations are real (HTTP POST to webhooks with SSRF protection). Only the file-level JSDoc comments say "stub". **Decision needed:** Update the comments, or is there still missing functionality that warrants the "stub" label? |
| D-003 | `void jobsTable` in schedulers.ts | `jobsTable` is imported but never used — the SQL queries use raw `FROM jobs` strings, not the drizzle table object. The `void` statement at line 170 suppresses the unused-import warning. **Decision needed:** Remove both the import and the `void`, or switch the raw SQL to use the drizzle table reference for type safety? |
| D-005 | `raw_material_hedging` placeholder comment | Referenced only in a JSDoc comment in `material-index-arbitrage.ts` line 35 as a future lever. Not registered in the lever registry — it's aspirational documentation only. **Decision needed:** Remove the comment to avoid confusion, or leave as a roadmap marker? |
| E-002 | Dual adapter interfaces (`SourceAdapter` vs `ErpConnector`) | Both are actively used but represent overlapping patterns. `SourceAdapter` handles CSV/mock-ERP; `ErpConnector` handles Coupa/NetSuite/Ariba. Consolidation could simplify the codebase but is a non-trivial refactor. |

## DELETE Items

| ID | Item | Rationale |
|---|---|---|
| D-001 | `sweepStaleAlerts()` noop function | Zero callers in the entire codebase. The function body is empty (`void` statements only). The comment says it's a placeholder for future auto-resolve heuristics, but no caller was ever wired up. Can be re-added when the feature is implemented. |
| D-002 | `void alertsTable; void isNull; void lt;` in synthesize.ts | These `void` statements exist only to suppress unused-import warnings for the noop `sweepStaleAlerts`. Removing D-001 allows removing these imports entirely. |

---

## Appendix: Files Scanned

### api-server (primary scan)
- `src/routes/` — 42 route files, all confirmed to use real data layer
- `src/lib/jobs/queue.ts` — 2786 LOC, job queue infrastructure
- `src/lib/jobs/handlers.ts` — 1474 LOC, all job handlers
- `src/lib/alerts/schedulers.ts` — 171 LOC, alert scheduling
- `src/lib/alerts/channels/` — 4 channel adapters (email, slack, teams, webhook)
- `src/lib/alerts/synthesize.ts` — 498 LOC, alert synthesis + noop stub
- `src/lib/intelligence/runtime.ts` — 2044 LOC, collector orchestration
- `src/lib/intelligence/collectors/` — 28 files, 19+ registered collectors
- `src/lib/adapters/` — CSV, mock-ERP, ingest-writer, source-adapter interface
- `src/lib/connectors/` — Coupa, NetSuite, Ariba ERP connectors
- `src/lib/onboarding/` — sample-data loader + constants
- `src/lib/tenant.ts` — tenant middleware with dev fallback

### command-center
- `src/pages/trust-public.tsx` — public trust demo page
- `src/App.tsx` — routing (references trust-public)

### Other
- `scripts/src/seed.ts` — dev seed script
- `artifacts/mockup-sandbox/src/components/mockups/_shared/seed.ts` — mockup data
- `lib/db/seeds/taxonomy.sql` — taxonomy band seed SQL

### Methodology
- Full-text search for: `TODO`, `FIXME`, `HACK`, `STUB`, `fake`, `mock`, `placeholder`, `hardcoded`, `demo`, `faker`, `casual`
- Environment variable scan for: `DEMO_MODE`, `BYPASS_AUTH`, `SKIP_AUTH`, `DEV_TENANT`, `DEV_ORG`
- Cross-reference of all `JobKind` enum values against registered handlers and schedulers
- Manual review of every route handler for real vs stub data layer calls
- LOC counts via `wc -l` on all flagged files
