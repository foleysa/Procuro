/**
 * Module-boundary guardrail for the routing layer (task #213).
 *
 * The routing module enforces a strict public-API surface:
 *   `lib/intelligence/routing/index.ts` is the *only* import target
 *   for code outside the routing directory. Internal files
 *   (synonym.ts, queue.ts, queries.ts, materialized-view.ts, etc.)
 *   must never be imported directly — that would let calibration code
 *   reach past the abstraction and lock us into the current internal
 *   shape.
 *
 * This test scans every TypeScript source file in the api-server
 * outside `lib/intelligence/routing/` and fails if any of them imports
 * a deep routing path. Pure-static check, runs in milliseconds.
 *
 * No ESLint rule is enforced because the repo doesn't currently run
 * ESLint — this test is the equivalent guardrail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_ROOT = resolve(__dirname, "..", "src");
const ROUTING_DIR = resolve(SRC_ROOT, "lib", "intelligence", "routing");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Match `from "...routing/<anything-other-than-index>"` and
// `import("...routing/<anything-other-than-index>")` forms.
//
// Allowed:
//   from "../routing"
//   from "../routing/index"
//   from "./routing"
//
// Disallowed:
//   from "../routing/synonym"
//   from "../routing/queue"
//   from "../routing/internal/foo"
const DEEP_ROUTING_RE = /from\s+["'][^"']*\/routing\/(?!index["'])([a-zA-Z0-9_\-\/]+)["']/g;

describe("routing module boundary", () => {
  it("no file outside routing/ deep-imports an internal routing module", () => {
    const offenders: Array<{ file: string; matches: string[] }> = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      // Skip anything inside the routing directory itself — internal
      // cross-imports are obviously fine.
      if (file.startsWith(ROUTING_DIR)) continue;
      const src = readFileSync(file, "utf8");
      const matches: string[] = [];
      for (const m of src.matchAll(DEEP_ROUTING_RE)) {
        matches.push(m[0]);
      }
      if (matches.length > 0) {
        offenders.push({ file: relative(SRC_ROOT, file), matches });
      }
    }
    assert.equal(
      offenders.length,
      0,
      `Routing internal imports detected — only the public API \
(\`./routing\` or \`./routing/index\`) may be imported from outside the \
routing directory.\n\n${JSON.stringify(offenders, null, 2)}`,
    );
  });

  it("routing/index.ts re-exports the documented public surface", () => {
    const indexSrc = readFileSync(
      resolve(ROUTING_DIR, "index.ts"),
      "utf8",
    );
    const required = [
      "resolveSynonym",
      "enqueueUnmapped",
      "listOpenQueue",
      "summarizeQueue",
      "resolveQueueEntry",
      "leversForCategory",
      "categoriesForLever",
      "isCanonicalCodeRouted",
      "bootstrapCategoryLeverMappings",
      "refreshCategoryLeverMappings",
      "checkRoutingHealth",
      "routeTenantCategory",
      "determineOpportunityMappedVia",
      "ALL_BANDS",
      "FALLBACK_BAND",
    ];
    for (const name of required) {
      assert.ok(
        indexSrc.includes(name),
        `routing/index.ts must export '${name}' (public API contract)`,
      );
    }
  });
});
