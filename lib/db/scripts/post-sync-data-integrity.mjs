#!/usr/bin/env node
/**
 * Post-migration hook for data-integrity assertions (Task #314).
 *
 * `pnpm --filter @workspace/db run sync` runs `node sync-schema.mjs`
 * to apply Drizzle schema changes. We hang this script off pnpm's
 * automatic `postsync` lifecycle so every successful migration can
 * be IMMEDIATELY followed by a full reconciliation pass — catching
 * the "schema migration silently changed dollar totals" failure
 * mode the #314 spec calls out.
 *
 * Behavior:
 *   - Default: NO-OP. The hook is registered (`postsync` runs
 *     automatically after `sync`) but exits 0 immediately, so the
 *     existing inner-loop tests, `pretest` flows, and CI fast-paths
 *     stay fast.
 *   - Set `RUN_POST_MIGRATION_DATA_INTEGRITY=1` to actually execute
 *     the assertions. Wire that into your production migration
 *     runner so a broken migration cannot "succeed" silently.
 *   - On run: delegates to `pnpm --filter @workspace/scripts run
 *     data-integrity --post-migration`, which persists every result
 *     to `data_integrity_audit_log` (triggered_by='post_migration')
 *     and EXITS NON-ZERO if any assertion failed.
 *
 * We delegate to the existing tsx-based runner rather than
 * dynamic-importing the workspace from this plain-Node script
 * because @workspace/db's `exports` are .ts files that need the tsx
 * loader. Spawning a single child process is the cleanest, most
 * portable way to run that.
 */
import { spawn } from "node:child_process";

if (
  process.env.RUN_POST_MIGRATION_DATA_INTEGRITY !== "1" &&
  process.env.RUN_POST_MIGRATION_DATA_INTEGRITY !== "true"
) {
  // Hook is registered but opt-in. See the script header for why.
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  process.stderr.write(
    "[post-sync-data-integrity] SKIPPED (no DATABASE_URL set)\n",
  );
  process.exit(0);
}

process.stderr.write("[post-sync-data-integrity] BEGIN\n");

const child = spawn(
  "pnpm",
  [
    "--filter",
    "@workspace/scripts",
    "run",
    "data-integrity",
    "--",
    "--post-migration",
  ],
  { stdio: "inherit", env: process.env },
);

child.on("exit", (code) => {
  process.stderr.write(
    `[post-sync-data-integrity] END (exit ${code ?? 0})\n`,
  );
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  process.stderr.write(`[post-sync-data-integrity] ERROR — ${err}\n`);
  process.exit(2);
});
