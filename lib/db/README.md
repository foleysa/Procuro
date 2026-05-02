# `@workspace/db`

Drizzle ORM schema and Postgres client for the monorepo. Tables live under
`src/schema/` and are re-exported through `src/schema/index.ts`. The package
exposes a single `db` client backed by `pg.Pool` against `process.env.DATABASE_URL`.

## Test database is the same as the dev database

This monorepo has **one** Postgres database (the one named in `DATABASE_URL`) —
there is no separate `TEST_DATABASE_URL`. The api-server test suite
(`pnpm --filter @workspace/api-server run test`) connects to that same
database and assumes its columns match the current Drizzle schema.

There is also no `lib/db/migrations/` folder: schema changes are applied
live with `drizzle-kit push`, not via versioned migration files. That means
**any time a `lib/db/src/schema/*.ts` file changes (column added/renamed/
dropped) you must re-push before the test suite will be honest.**

Symptoms of a stale database:

```
column "billing_currency" of relation "suppliers" does not exist
column "base_currency" of relation "orgs" does not exist
column "scope_region_code" of relation "market_signals" does not exist
column "unspsc_code" of relation "categories" does not exist
```

These typically surface in the streaming CSV ingest tests
(`csv-stream-*.test.ts`), the FX exposure analyzer
(`fx-exposure-analyzer.test.ts`), and the spot-vs-contract lever
(`spot-vs-contract-lever.test.ts`) inside `artifacts/api-server/test/`.

## Syncing the schema

Pick whichever fits your shell:

```bash
# Recommended — works in any shell, including non-TTY (CI, agents).
pnpm --filter @workspace/db run sync

# Equivalent if you have an interactive terminal and want to answer the
# rename prompts yourself.
pnpm --filter @workspace/db run push
pnpm --filter @workspace/db run push-force   # if conflicts
```

`pnpm run sync` runs `scripts/sync-schema.mjs`, which spawns
`drizzle-kit push --force` and auto-answers each interactive prompt with the
highlighted default (the first option, always "create column" / "create table").
That is the safe non-rename answer — it adds the missing object the schema
expects and never silently re-points an existing column to a different name.

The script has a 60s stall watchdog: if drizzle-kit is waiting on a prompt
that no longer matches the known marker (`❯` or `Is <X> column ... created
or renamed`), it bails with a loud `FATAL:` diagnostic instead of hanging
the test runner. Update `PROMPT_CARET` / `PROMPT_QUESTION_RE` in
`scripts/sync-schema.mjs` if drizzle-kit ever changes its prompt format.

### Renames are intentional and manual

Auto-accepting "create" is intentional. Treating an unknown rename as a
new column is *safe* (it never silently re-points data) but it is also
*lossy*: the data in the original column does not move to the new column.
**If you are actually performing a rename, do NOT use `pnpm run sync`.**
Run `pnpm --filter @workspace/db run push` interactively, pick the
"rename column" option from the menu yourself, then commit the schema
change. The sync wrapper is only correct for additive schema drift,
which is the 99% case.

### Pretest hook

`pnpm --filter @workspace/api-server run test` invokes a `pretest` hook
that runs this `sync` automatically, so the api-server test suite is
self-healing on a stale checkout — no separate step required. The sync
wrapper logs `SCHEMA-SYNC:BEGIN` / `SCHEMA-SYNC:END` markers to stderr
so CI logs can be grepped for proof that it ran before the affected
tests (`csv-stream-*.test.ts`, `fx-exposure-analyzer.test.ts`,
`spot-vs-contract-lever.test.ts`).

## Adding a new table

1. Create `lib/db/src/schema/<thing>.ts` and define the Drizzle table,
   insert schema (via `drizzle-zod`), and derived types.
2. Re-export from `lib/db/src/schema/index.ts`.
3. Run `pnpm --filter @workspace/db run sync`.
4. Run the affected tests to confirm.
