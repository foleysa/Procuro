# Test Suites

This project has two test runners across three packages.

## Quick reference

| Suite | Runner | Command | DB required? |
|-------|--------|---------|--------------|
| `lib/db` unit tests | Vitest | `pnpm --filter @workspace/db run test` | No |
| `lib/db` coverage | Vitest + v8 | `pnpm --filter @workspace/db run test:coverage` | No |
| `api-server` integration | Node test runner | `pnpm --filter @workspace/api-server run test` | Yes |
| `command-center` frontend | Vitest | `pnpm --filter @workspace/command-center run test` | No |
| All suites | Mixed | `pnpm run test` | Yes (for api-server) |

## lib/db — Unit tests

Pure unit tests for the S2P data model business logic. No database connection required.

**What's covered:**
- DOA tier derivation (`resolveDoaTierNumber` / `resolveDoaTier`) with boundary values
- Gate SLA breach computation (`gateSlaBreach`) for all forward-progress and terminal stages
- Backfill status-to-S2P mapping (`s2pForStatusTransition`)
- Baseline field validation for Realized savings (`validateBaselineForRealized`)
- Backfill review flag defaults (`BACKFILL_DEFAULTS` and factory verification)

**Run:**
```bash
pnpm --filter @workspace/db run test
```

**Run with coverage:**
```bash
pnpm --filter @workspace/db run test:coverage
```

## api-server — Integration tests

Integration tests that run against a real PostgreSQL database. The `pretest` hook
automatically syncs the schema before running.

**Key S2P integration tests:**
- `opportunities-s2p.test.ts` — Stage history rows on approve/reject/execute/realize,
  DOA tier thresholds, analysis cycle S2P defaults
- `s2p-savings-gate.test.ts` — CFO insurance gate (Hard Savings aggregate excludes
  `classification_needs_review=true` records), full 5-stage lifecycle with
  `stage_entered_at` tracking

**Run all api-server tests:**
```bash
pnpm --filter @workspace/api-server run test
```

**Run a single test file:**
```bash
pnpm --filter @workspace/api-server exec node --experimental-test-module-mocks --import tsx --test test/s2p-savings-gate.test.ts
```

## Running everything

From the workspace root:
```bash
pnpm run test
```

This runs all test suites across `lib/*` and `artifacts/*` packages.
