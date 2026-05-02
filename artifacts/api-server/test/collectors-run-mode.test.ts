/**
 * Pin the `?backfill=true` → `mode: "backfill"` contract of
 * `POST /collectors/:id/run`.
 *
 * The route helper `resolveRunCollectorMode(rawBackfill)` is the only
 * place that maps the raw query-string value onto the collector run
 * mode that's forwarded into `runCollector(id, { mode })`. A regression
 * here would silently re-enable the daily cron's old "rewrite the
 * entire window every poll" behaviour when an operator triggers a
 * backfill, or — worse — make every recurring run wider than intended.
 *
 * We import the real route module so the helper under test is exactly
 * the function the production handler calls. The route module
 * transitively imports `@workspace/db`, which only *constructs* a Pool
 * at import time (it does not connect until a query runs); a
 * placeholder DATABASE_URL is therefore enough to satisfy the
 * import-time guard without standing up a real database.
 */
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const { resolveRunCollectorMode } = await import("../src/routes/collectors");

test("resolveRunCollectorMode: ?backfill=true opts into backfill mode", () => {
  assert.equal(resolveRunCollectorMode("true"), "backfill");
});

test("resolveRunCollectorMode: missing query param defaults to latest", () => {
  // The recurring cron hits the route with no query string at all.
  // Defaulting to backfill there would silently widen every daily run.
  assert.equal(resolveRunCollectorMode(undefined), "latest");
  assert.equal(resolveRunCollectorMode(""), "latest");
  assert.equal(resolveRunCollectorMode(null), "latest");
});

test("resolveRunCollectorMode: only the literal string 'true' opts in", () => {
  // Pin the case-sensitivity and exact-match behaviour so a future
  // refactor doesn't accidentally accept "TRUE", "1", "yes", or
  // similar near-misses (which would change the recurring contract
  // for any operator who fat-fingers the param).
  for (const v of ["false", "1", "0", "yes", "no", "TRUE", "True", "BACKFILL"]) {
    assert.equal(
      resolveRunCollectorMode(v),
      "latest",
      `expected latest for raw query value ${JSON.stringify(v)}`,
    );
  }
});

test("resolveRunCollectorMode: array / object query values fall back to latest", () => {
  // Express's `qs` parser can yield arrays (`?backfill=true&backfill=true`)
  // or nested objects (`?backfill[x]=true`). String() coercion turns
  // those into "true,true" and "[object Object]" respectively, neither
  // of which equals "true" — so the helper safely falls back to latest.
  assert.equal(resolveRunCollectorMode(["true", "true"]), "latest");
  assert.equal(resolveRunCollectorMode({ x: "true" }), "latest");
});
