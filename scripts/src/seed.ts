/**
 * One-command database seed for tests and local dev.
 *
 * Run with: `pnpm --filter @workspace/scripts run seed`
 *
 * What this guarantees
 * --------------------
 * After `pnpm --filter @workspace/db run push` + this script, the database
 * holds at least one row in `orgs`. That is the minimum required by the
 * integration tests in `artifacts/api-server/test/` (each one calls
 * `pickOrgId()` which reads the first org).
 *
 * Idempotency
 * -----------
 * Every insert uses `ON CONFLICT DO NOTHING` against either the primary key
 * or a unique constraint, so running the script repeatedly is safe and
 * never duplicates rows. It also never wipes existing data — if a developer
 * already has richer data in their local database, this script tops it up
 * without destroying it.
 */
import {
  db,
  pool,
  orgsTable,
} from "@workspace/db";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SEED_ORG = {
  id: "org_seed_default",
  slug: "seed-default",
  name: "Seed Default Org",
} as const;

async function seedOrgs(): Promise<void> {
  const inserted = await db
    .insert(orgsTable)
    .values({
      id: SEED_ORG.id,
      slug: SEED_ORG.slug,
      name: SEED_ORG.name,
    })
    .onConflictDoNothing()
    .returning({ id: orgsTable.id });

  if (inserted.length > 0) {
    console.log(`[seed] inserted org ${SEED_ORG.id} (${SEED_ORG.slug})`);
  } else {
    console.log(`[seed] org ${SEED_ORG.id} already present — no changes`);
  }
}

/**
 * Apply the bands routing taxonomy seed (`lib/db/seeds/taxonomy.sql`).
 *
 * The SQL file is the single source of truth for category/lever bands +
 * the global synonym registry. It is fully idempotent (every INSERT
 * uses `ON CONFLICT DO NOTHING`), so re-running it is a no-op once the
 * rows already exist. We resolve the path relative to this script
 * rather than `process.cwd()` so the seed works whether invoked from
 * the workspace root or the `scripts/` package directory.
 */
async function seedTaxonomyBands(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sqlPath = resolve(here, "..", "..", "lib", "db", "seeds", "taxonomy.sql");
  const seedSql = readFileSync(sqlPath, "utf8");
  await pool.query(seedSql);
  console.log(`[seed] taxonomy bands + synonym registry ensured`);
}

async function main(): Promise<void> {
  console.log(`[seed] starting at ${new Date().toISOString()}`);
  await seedOrgs();
  await seedTaxonomyBands();
  console.log(`[seed] complete`);
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
