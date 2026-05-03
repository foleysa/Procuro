#!/usr/bin/env node
/**
 * Sync the database to the current Drizzle schema in lib/db/src/schema/.
 *
 * Why this exists:
 *   `drizzle-kit push` is interactive — whenever it cannot tell whether a
 *   newly-defined column is a rename of an existing one, it asks. That makes
 *   the bare `pnpm --filter @workspace/db run push` unusable from any non-TTY
 *   shell (CI, agents, post-merge scripts, fresh-clone setup).
 *
 *   This wrapper spawns drizzle-kit, watches stdout for the prompt
 *   indicator (`❯`), and writes `\r` to its stdin to accept the highlighted
 *   default, which is always the FIRST option — i.e. "create column" /
 *   "create table" / "create constraint". That is the safe, non-rename
 *   answer: it never silently re-points an existing column to a different
 *   name, it just adds the missing column the schema expects.
 *
 * When to run:
 *   - After pulling main / merging a branch that touches lib/db/src/schema/
 *   - Before running the api-server test suite on a fresh checkout
 *   - Whenever a streaming-CSV / FX-exposure / spot-vs-contract test fails
 *     with `column "..." of relation "..." does not exist`
 *
 * Usage:
 *   node lib/db/scripts/sync-schema.mjs
 *   pnpm --filter @workspace/db run sync
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(__dirname, "..");

/**
 * Resolve the drizzle-kit CLI entry portably across pnpm workspace layouts:
 *   1. Use Node's resolver from this script's location — finds the package
 *      whether it's hoisted, nested, or symlinked through pnpm's store.
 *   2. Fall back to a direct local node_modules path for the (uncommon) case
 *      where the package's `exports` map blocks `bin.cjs` resolution.
 *   3. Final fallback: spawn through `pnpm exec` so we still work in any
 *      environment where pnpm itself can resolve the binary.
 */
function resolveDrizzleKit() {
  const require = createRequire(import.meta.url);
  try {
    const pkgJsonPath = require.resolve("drizzle-kit/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    const binRel =
      typeof pkg.bin === "string"
        ? pkg.bin
        : (pkg.bin && (pkg.bin["drizzle-kit"] ?? Object.values(pkg.bin)[0])) ||
          "bin.cjs";
    const binAbs = path.resolve(path.dirname(pkgJsonPath), binRel);
    if (fs.existsSync(binAbs)) {
      return { kind: "node", argv: [process.execPath, binAbs] };
    }
  } catch {
    // fall through
  }
  const localBin = path.join(dbDir, "node_modules", "drizzle-kit", "bin.cjs");
  if (fs.existsSync(localBin)) {
    return { kind: "node", argv: [process.execPath, localBin] };
  }
  return { kind: "pnpm", argv: ["pnpm", "exec", "drizzle-kit"] };
}

const resolved = resolveDrizzleKit();
const [cmd, ...prefixArgs] = resolved.argv;
// Easily-greppable banner so anyone reading CI / pretest logs can confirm
// schema sync actually ran before the affected tests (csv-stream-*,
// fx-exposure-analyzer, spot-vs-contract-lever, etc.). Search for
// "SCHEMA-SYNC:BEGIN" / "SCHEMA-SYNC:END" in build output.
process.stderr.write(
  `[sync-schema] SCHEMA-SYNC:BEGIN drizzle-kit via ${resolved.kind}: ${resolved.argv.join(" ")}\n`,
);

// Workaround for Task #279 / drizzle-kit@0.31.9 bug:
//   bin.cjs:19958 throws `TypeError: Cannot read properties of undefined
//   (reading 'options')` while introspecting database views — it issues a
//   per-view detail query that returns no rows for our `v_category_lever_mappings`
//   materialized view (drizzle-kit's WHERE filters by `relkind` but its
//   detail join expects a non-materialized row), then dereferences the
//   undefined result. The crash leaves the schema un-synced and downstream
//   tests fail with "column does not exist".
//
// The materialized view + its refresh trigger are not modelled in Drizzle
// schema; they are bootstrapped by the API server on boot
// (`bootstrapCategoryLeverMappings` in
// `artifacts/api-server/src/lib/intelligence/routing/materialized-view.ts`)
// and by `lib/db/seeds/taxonomy.sql`. Dropping them here before drizzle-kit
// runs sidesteps the introspection bug; the next API boot recreates them.
await dropMatViewBeforePush();

async function dropMatViewBeforePush() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write(
      `[sync-schema] DATABASE_URL not set; skipping matview pre-drop\n`,
    );
    return;
  }
  let pgMod;
  try {
    pgMod = await import("pg");
  } catch (err) {
    process.stderr.write(
      `[sync-schema] could not import 'pg' for matview pre-drop: ${err}\n`,
    );
    return;
  }
  const { Client } = pgMod.default ?? pgMod;
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    // CASCADE drops the dependent INSERT/DELETE triggers on
    // category_bands / lever_bands too. The function is dropped
    // separately because triggers were created via
    // `EXECUTE FUNCTION refresh_v_category_lever_mappings()` — CASCADE
    // on the function is what actually removes those triggers.
    await client.query(
      `DROP MATERIALIZED VIEW IF EXISTS v_category_lever_mappings CASCADE;`,
    );
    await client.query(
      `DROP FUNCTION IF EXISTS refresh_v_category_lever_mappings() CASCADE;`,
    );
    process.stderr.write(
      `[sync-schema] dropped v_category_lever_mappings + refresh trigger ` +
        `(will be re-bootstrapped on API server start)\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[sync-schema] matview pre-drop failed (continuing): ${err}\n`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

const child = spawn(
  cmd,
  [...prefixArgs, "push", "--force", "--config", "./drizzle.config.ts"],
  {
    cwd: dbDir,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, FORCE_COLOR: "0" },
  },
);

let buf = "";
let pendingPrompt = false;
let answered = 0;
let lastStdoutAt = Date.now();
let lastQuestionAt = 0;

// Markers we know drizzle-kit currently uses for its rename / create
// confirmation menu. The selection caret (❯) is the strongest signal; the
// "is X column ... created or renamed" prefix is a secondary signal that
// also catches table/constraint variants. If drizzle-kit ever changes BOTH
// of these, the stall watchdog below is our last line of defence.
const PROMPT_CARET = "❯";
const PROMPT_QUESTION_RE =
  /\bIs\s+\S+\s+(column|table|constraint|index)\b.*\b(created|renamed)\b/i;

const tryAnswerPrompt = () => {
  if (pendingPrompt) return;
  const looksLikePrompt =
    buf.includes(PROMPT_CARET) || PROMPT_QUESTION_RE.test(buf);
  if (!looksLikePrompt) return;
  pendingPrompt = true;
  lastQuestionAt = Date.now();
  // Small debounce so the entire menu has a chance to flush before we send.
  setTimeout(() => {
    child.stdin.write("\r");
    answered++;
    process.stderr.write(
      `[sync-schema] accepted default for prompt #${answered}\n`,
    );
    buf = "";
    pendingPrompt = false;
  }, 150);
};

child.stdout.on("data", (chunk) => {
  const s = chunk.toString();
  process.stdout.write(s);
  buf += s;
  lastStdoutAt = Date.now();
  tryAnswerPrompt();
});

// Stall watchdog. If drizzle-kit produces no output for STALL_MS AND the
// buffer suggests we never recognised a prompt that's clearly being asked
// (look for any line ending in '?'), bail with a loud diagnostic instead of
// hanging the test runner forever. This catches the "prompt rendering
// changed and our marker no longer matches" failure mode the reviewer
// flagged, surfacing it as a clear actionable error.
const STALL_MS = 60_000;
const watchdog = setInterval(() => {
  const idleMs = Date.now() - lastStdoutAt;
  if (idleMs < STALL_MS) return;
  const looksLikeUnrecognisedQuestion =
    /\?\s*$/m.test(buf) && !buf.includes(PROMPT_CARET);
  if (!looksLikeUnrecognisedQuestion) return;
  clearInterval(watchdog);
  process.stderr.write(
    `\n[sync-schema] FATAL: drizzle-kit appears to be waiting on a prompt ` +
      `we did not recognise (no '${PROMPT_CARET}' caret seen, no output for ` +
      `${Math.round(idleMs / 1000)}s). The drizzle-kit prompt format may have ` +
      `changed — update PROMPT_CARET / PROMPT_QUESTION_RE in this script. ` +
      `Last buffered output:\n${buf.slice(-500)}\n`,
  );
  child.kill("SIGTERM");
  process.exit(2);
}, 5_000).unref();

child.on("exit", (code) => {
  clearInterval(watchdog);
  const totalMs = Date.now() - (lastQuestionAt || lastStdoutAt);
  if (code === 0) {
    process.stderr.write(
      `[sync-schema] SCHEMA-SYNC:END ok — ${answered} prompt(s) ` +
        `auto-answered (last ~${totalMs}ms ago)\n`,
    );
  } else {
    process.stderr.write(
      `[sync-schema] SCHEMA-SYNC:END fail (exit ${code}) ` +
        `after auto-answering ${answered} prompt(s)\n`,
    );
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  clearInterval(watchdog);
  process.stderr.write(`[sync-schema] failed to spawn drizzle-kit: ${err}\n`);
  process.exit(1);
});
