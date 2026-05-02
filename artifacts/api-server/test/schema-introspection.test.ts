/**
 * Schema-introspection regression guard (#248 / #249).
 *
 * Asserts that every column declared in the Drizzle source schema for
 * the alerts subsystem (#117) and the funnel substrate (#185) actually
 * exists in the live PostgreSQL database. This is the regression
 * guard that prevents the schema drift described in the #248 / #249
 * task plans from silently re-emerging if a future post-merge sync
 * collapses a rename into a drop-and-recreate, or if someone adds a
 * column to the schema file but the deploy step misses pushing it.
 *
 * Strategy: pull the declared column set straight from each Drizzle
 * table via `getTableColumns`, then query `information_schema.columns`
 * for the same table and assert every declared `name` is present. This
 * stays in sync automatically — adding a column to the schema file
 * tightens the assertion without requiring a test edit.
 *
 * Scope: alerts (8 tables — alerts plus the 7 supporting tables) and
 * funnel (3 tables). Other tables are not in scope here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";

const {
  pool,
  alertsTable,
  alertEventsTable,
  alertChannelsTable,
  alertSubscriptionsTable,
  watchlistsTable,
  watchlistMembersTable,
  alertRulesTable,
  escalationPoliciesTable,
  alertDeliveriesTable,
  funnelSnapshotsTable,
  funnelAnnotationsTable,
  funnelSnapshotFailuresTable,
} = await import("@workspace/db");
const { getTableColumns, getTableName } = await import("drizzle-orm");

type AnyTable = Parameters<typeof getTableName>[0];

const TABLES: ReadonlyArray<{ family: string; table: AnyTable }> = [
  { family: "alerts", table: alertsTable },
  { family: "alerts", table: alertEventsTable },
  { family: "alerts", table: alertChannelsTable },
  { family: "alerts", table: alertSubscriptionsTable },
  { family: "alerts", table: watchlistsTable },
  { family: "alerts", table: watchlistMembersTable },
  { family: "alerts", table: alertRulesTable },
  { family: "alerts", table: escalationPoliciesTable },
  { family: "alerts", table: alertDeliveriesTable },
  { family: "funnel", table: funnelSnapshotsTable },
  { family: "funnel", table: funnelAnnotationsTable },
  { family: "funnel", table: funnelSnapshotFailuresTable },
];

async function liveColumns(tableName: string): Promise<Set<string>> {
  const r = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  );
  return new Set(r.rows.map((row) => row.column_name));
}

for (const { family, table } of TABLES) {
  const tableName = getTableName(table);
  test(`${family}: ${tableName} live columns ⊇ Drizzle-declared columns`, async () => {
    const declared = Object.values(getTableColumns(table)).map((c) => c.name);
    const live = await liveColumns(tableName);
    assert.ok(
      live.size > 0,
      `${tableName} not present in information_schema.columns`,
    );
    const missing = declared.filter((name) => !live.has(name));
    assert.deepEqual(
      missing,
      [],
      `${tableName} is missing ${missing.length} declared column(s) in the live DB: ${missing.join(", ")}`,
    );
  });
}

test("schema-introspection teardown", async () => {
  await pool.end();
});
