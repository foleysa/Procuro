# Hardening Status — `pnpm run check`

`pnpm run check` runs the full repo gate: `pnpm run typecheck` (composite
libs + every leaf workspace package) followed by `pnpm run test` (every
artifact's `test` script — currently `@workspace/api-server`).

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
