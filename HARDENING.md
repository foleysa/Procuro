# Hardening Status — `pnpm run check`

`pnpm run check` runs the full repo gate: `pnpm run typecheck` (composite
libs + every leaf workspace package) followed by `pnpm run test` (every
artifact's `test` script — currently `@workspace/api-server`), followed
by `pnpm run test:perf` (the two perf-budget tests).

## Current state (Task #306)

- **`pnpm run typecheck`** — **green** across all 4 packages
  (`@workspace/db`, `@workspace/api-spec`, `@workspace/api-server`,
  `@workspace/command-center`). The previous schema-drift cascade was
  resolved by rebuilding the composite `lib/db` declarations
  (`pnpm run typecheck:libs`) — the schema was already correct, only
  `lib/db/dist/` was stale. `DOABreachAlert.tsx` was patched to pass
  the explicit `queryKey` to its react-query options.

- **`pnpm --filter @workspace/api-server test`** — **14 failing tests
  remaining out of 979** (down from 23). Fixes landed in this task:

  - `funnel_snapshots_cycle_uq` widened to `(cycle_id, cycle_generation)`
    so multi-generation snapshots per cycle stop colliding (matches the
    actual writer in `captureFunnelSnapshot`).
  - `services-rate-card-benchmark-lever` test stops emitting four
    OEWS percentile rows at the same `observed_at`; the natural-key
    index does not discriminate on `metadata.aggregate`.
  - `usda-nass-economic-index-fetch` stub now returns empty for
    `agg_level_desc=STATE` / `state_alpha=*` requests so the new
    state-level series stop double-counting the national fixture.
  - `trust-summary-pdf` route now folds `_` to `-` in the filename
    slug so org IDs containing underscores match the documented
    kebab shape.

## Known-failing tests (tracked separately)

These are *not* schema/typecheck regressions — they are pre-existing
test-isolation, seed-ordering, or auth-setup issues that need their
own focused investigation. Do not silently `it.skip` them; track them
as follow-up tasks so the failure inventory stays honest.

| Suite | Failing tests | Likely root cause |
|---|---|---|
| `routing-resolution.test.ts` | 11 | global routing seeds (synonyms, bands, levers) absent at run time; another suite likely truncates the seed tables before this one runs |
| `admin-broadcast-posture.test.ts` | 1 | tenant-count drift (`73 vs 74`) — fixture pollution from concurrent admin tests |
| `jobs-recently-failed.test.ts` | 1 | `system-scoped failure visible to every tenant` — tenant-isolation predicate appears to filter out NULL `org_id` rows |
| `scim-provisioning.test.ts` | 1 | `Users CRUD` returns 401 — SCIM bearer-token middleware setup |

Run individually with:

```sh
cd artifacts/api-server && PG_POOL_MAX=30 NODE_OPTIONS=--expose-gc \
  node --experimental-test-module-mocks --import tsx \
  --test test/<file>.test.ts
```

## Conventions

- `pnpm run check` is the single source of truth for "is the repo
  green?" Do not introduce parallel scoped scripts (`test:hardening`
  etc.) — failures get tracked here and as Notion follow-ups instead.
- Every new test that depends on shared global state (routing seeds,
  collector registry, etc.) must namespace its fixtures with a per-run
  prefix and avoid mutating rows it did not create.

## Invariants

### API server

- **Typed errors only.** Route handlers must throw one of the typed
  errors in `artifacts/api-server/src/lib/api-errors.ts` (`UnauthorizedError`,
  `ForbiddenError`, `TenantMismatchError`, `NotFoundError`,
  `ConflictError`, `DBConstraintError`) or a `ZodError` from a
  generated request schema. Ad-hoc `res.status(500).json({...})`
  with raw error text is forbidden.
- **Uniform error envelope.** The global error handler emits
  `{ error, code, details? }`. The `code` is a stable
  machine-readable `ApiErrorCode`; clients and tests branch on it
  rather than on the human message.
- **Tenant isolation.** Every tenant-scoped route MUST resolve
  `req.orgId` via `tenantMiddleware` and MUST scope every DB query by
  that org id. The `assertDevTenantHeaderSafe` guard runs at module
  load to prevent the dev-impersonation header from being enabled in
  production.
- **Request IDs.** `pino-http` honours an inbound `x-request-id` header
  (or generates one) and echoes it back on the response. Use that
  same id when grepping logs — see "Lookup pattern" below.

### Background jobs

- Every job kind has a known retry budget (`MAX_ATTEMPTS_BY_KIND`).
  Permanent input errors throw `UnrecoverableJobError` so they fail
  on attempt #1 instead of burning the budget.
- The terminal failure log line has a stable shape:
  ```
  event=job_terminal_failure jobId=<id> jobKind=<kind>
  tenantId=<orgId|null> errorClass=<name> attempt=<n>
  maxAttempts=<n> unrecoverable=<bool> err=<message>
  ```
  Do **not** swallow errors inside a handler — let them bubble so the
  worker records the terminal log + DB row.
- Cancellation always wins over auto-retry. If
  `isJobCancelRequested(job.id)` returns `true`, the worker writes the
  `cancelled` terminal state and stops.

### Frontend

- The whole app is wrapped in an `ErrorBoundary` in `main.tsx`.
- Every top-level route inside the `Layout` is additionally wrapped in
  a per-route `ErrorBoundary` keyed on `useLocation()` so navigating
  away from a crashing page implicitly clears the fallback.
- React Query failures should render an inline error state with retry,
  **not** be allowed to throw into the boundary. Use
  `query.isError` + `query.refetch()` in components.

### Database

- All multi-statement writes that must be atomic are wrapped in
  `db.transaction(async (tx) => …)`. The cycle persistence, ingest
  commit, and registry edits are existing examples; new flows should
  follow the same pattern.
- Schema changes require a Drizzle migration in `lib/db/migrations`.
  Never edit the schema in place without one.

### Logging

- Server code uses `req.log` inside route handlers and the singleton
  `logger` from `./lib/logger` everywhere else. **`console.log` is
  banned in server code.**
- Job handlers receive `job.id` and should pass it (and `job.orgId`
  as `tenantId`) into any structured log they emit.

## Lookup pattern: "everything that happened for request X"

1. Grab the `x-request-id` from the response header (or the inbound
   request) — call it `<rid>`.
2. Filter the api-server logs for `reqId=<rid>` (pino-http binds it
   onto every `req.log` call).
3. If the request enqueued a job, the job handler's logs include
   `jobId=<id>` and `tenantId=<orgId>`. Filter on `jobId` or
   `tenantId` to pick up the downstream work.

## Audit hotspots (snapshot, May 2026)

These are the highest-leverage areas to check when making a broad
change:

- `routes/*.ts`: ad-hoc `res.status(500)` calls — replace with throwing
  a typed `ApiError`.
- `lib/jobs/handlers.ts`: any `try { … } catch { /* swallow */ }` —
  must be `wrapStructuralError` or re-throw.
- `lib/db/src/schema/*`: columns that should be `NOT NULL` or have a
  FK — add a migration before relying on the constraint.
- `command-center/src/pages/*`: components that throw on a missing
  field — they will be caught by the route boundary, but inline
  error states are friendlier.
