# E2E Tests — Opportunity Approval & Rejection Journeys

## What's covered

### API-layer tests (`approve-opportunity.e2e.test.ts`)

Run via Playwright's API request context (no browser needed):

| Test | Description |
|------|-------------|
| Approve journey | Seeds a fresh org + opportunity, calls POST `/api/opportunities/:id/approve`, verifies status=approved, canonicalStage=Awarded, savingsType=Negotiated, plus stage history and decisions rows. |
| Reject journey | Seeds a fresh org + opportunity, calls POST `/api/opportunities/:id/reject` with `compliance_or_legal_block` reason, verifies status=rejected, canonicalStage=Closed-No Action, plus stage history and decisions rows with reason code. |

### UI-layer tests (via Replit `runTest()`)

Browser-based tests run through the Replit testing infrastructure:

| Test | Description |
|------|-------------|
| Approve UI | Navigates to opportunity detail page, verifies initial "Identified" stage badge, clicks the Approve button, asserts badge transitions to "Awarded" and savings type to "Negotiated". |
| Reject UI | Navigates to opportunity detail page, selects a rejection reason from the Radix Select dropdown, enters a note, clicks Reject, asserts badge transitions to "Closed-No Action". |

## How to run

```bash
# API-layer E2E tests (no browser required)
pnpm run test:e2e

# UI tests are run via the Replit testing skill (runTest) and require
# the API server + Command Center workflows to be active.
```

## Prerequisites

- **Database**: A running PostgreSQL instance with the app schema applied (`DATABASE_URL` set).
- **API Server**: Running on its configured port behind the Replit proxy at `/api`.
- **Command Center**: Running and serving the frontend at `/`.
- **Dev tenant header**: `ALLOW_DEV_TENANT_HEADER=true` must be set on the API server so the `x-org-id` header bypass works without Clerk auth.

## Data seeding

Each test seeds its own isolated org, cycle, opportunity, and user role before running. All seeded data uses the `e2e-test-` prefix for safe identification. Cleanup runs in `afterAll` and deletes test data by org ID (the org row itself is retained since the `admin_audit_log` table has an append-only trigger preventing cascade deletes).

## Configuration

- `workers: 1` to serialize DB-touching tests
- `retries: 0` — a flaky test must be fixed, not retried
- Traces, screenshots, and videos captured on failure only
- 90s timeout per test; total suite target under 3 minutes
