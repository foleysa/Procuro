/**
 * Data integrity assertion harness (Task #314 — CFO Insurance).
 *
 * Runs a list of SQL-level assertions against a real Postgres
 * connection (NOT a Testcontainer; this is meant for staging /
 * production / preview DBs). Each assertion is a self-contained
 * probe + verdict — see `assertions.ts` for the eleven that ship.
 *
 * Two callers:
 *   1. `scripts/src/run-data-integrity.ts` — `pnpm data-integrity`
 *      one-shot runner (CI, post-migration, or operator).
 *   2. `artifacts/api-server/src/lib/jobs/data-integrity.ts` — the
 *      `data_integrity_check` job handler that fires every 15 min.
 *
 * Both reuse `runAssertions` so the single-source-of-truth shape
 * lives here.
 */
import type { db as Db } from "@workspace/db";

export type DrizzleDb = typeof Db;

export type AssertionFamily =
  | "aggregate"
  | "savings_type"
  | "stage_history"
  | "gating";

export interface AssertionResult {
  name: string;
  family: AssertionFamily;
  passed: boolean;
  /** Structured probe output, persisted as JSONB in the audit log. */
  actual: Record<string, unknown>;
  /** Human-readable expected condition. */
  expected: string;
  /** Result message — used in the Slack alert body on failure. */
  message: string;
  /** Original SQL probe text (kept for debugging / audit trail). */
  query: string;
}

export interface Assertion {
  name: string;
  family: AssertionFamily;
  description: string;
  run: (db: DrizzleDb) => Promise<AssertionResult>;
}

/**
 * Execute every assertion sequentially against `db`. Per-assertion
 * exceptions are caught and surfaced as a `passed=false` result with
 * `actual.error` populated; one bad probe never short-circuits the
 * suite. Returns results in input order.
 */
export async function runAssertions(
  db: DrizzleDb,
  assertions: Assertion[],
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const a of assertions) {
    try {
      results.push(await a.run(db));
    } catch (err) {
      results.push({
        name: a.name,
        family: a.family,
        passed: false,
        actual: { error: err instanceof Error ? err.message : String(err) },
        expected: "query to execute successfully",
        message: `Assertion ${a.name} threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
        query: "<errored>",
      });
    }
  }
  return results;
}
