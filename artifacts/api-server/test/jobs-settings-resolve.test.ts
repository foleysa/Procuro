/**
 * Integration tests for the per-tenant retry-budget override layer
 * exposed by `job_kind_settings`.
 *
 * What we lock in:
 *   - When no `(org_id, kind)` row exists, `enqueueJob` falls back to
 *     `MAX_ATTEMPTS_BY_KIND`.
 *   - When an override exists for the job's org, the new row is
 *     enqueued with that `max_attempts` value.
 *   - An override for Org A does NOT bleed into a job enqueued for
 *     Org B (the tenant-isolation invariant the schema's composite PK
 *     `(org_id, kind)` enforces).
 *   - System/internal jobs enqueued without an `orgId` skip the
 *     per-tenant lookup entirely and always use the in-code default,
 *     even when a same-kind override exists for some org.
 *   - An explicit `args.maxAttempts` passed to `enqueueJob` always
 *     wins over the override (preserves the existing test/manual
 *     contract).
 *
 * Each test enqueues `prune_jobs` rows tagged with `{ settingsTest: ... }`
 * in their payload so cleanup can be precise (and so we never affect
 * a developer's real queued jobs). `prune_jobs` is convenient because
 * it is the only kind whose handler isn't registered against the
 * test queue here — we never let the worker claim these rows, we
 * just inspect the columns the row was inserted with.
 *
 * Prereq: `DATABASE_URL` is set and the schema has been pushed
 * (`pnpm --filter @workspace/db run push`). The two seeded orgs
 * (`org_scis_proc`, `org_procureworks`) must exist; we verify and
 * skip if either is missing rather than create test fixtures that
 * could collide with seed data.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  jobsTable,
  jobKindSettingsTable,
  orgsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

import {
  enqueueJob,
  MAX_ATTEMPTS_BY_KIND,
} from "../src/lib/jobs/queue";

const ORG_A = "org_scis_proc";
const ORG_B = "org_procureworks";

async function deleteTestJobs(): Promise<void> {
  await db.execute(sql`
    DELETE FROM jobs
    WHERE payload ? 'settingsTest'
  `);
}

async function deleteOverrides(orgIds: string[]): Promise<void> {
  for (const orgId of orgIds) {
    await db
      .delete(jobKindSettingsTable)
      .where(eq(jobKindSettingsTable.orgId, orgId));
  }
}

async function getMaxAttempts(jobId: string): Promise<number | null> {
  const [row] = await db
    .select({ maxAttempts: jobsTable.maxAttempts })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  return row?.maxAttempts ?? null;
}

test("per-tenant retry-budget resolution at enqueue time", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Skip rather than fabricate orgs — the test depends on real seed data
  // matching the two-tenant assumption documented above.
  const presentOrgs = await db
    .select({ id: orgsTable.id })
    .from(orgsTable);
  const ids = new Set(presentOrgs.map((o) => o.id));
  if (!ids.has(ORG_A) || !ids.has(ORG_B)) {
    console.warn(
      `[skip] jobs-settings-resolve: required seeded orgs missing (have=${[...ids].join(",")})`,
    );
    return;
  }

  t.after(async () => {
    try {
      await deleteTestJobs();
      await deleteOverrides([ORG_A, ORG_B]);
    } catch (err) {
      console.error("[cleanup] jobs-settings-resolve cleanup failed:", err);
    }
    await pool.end().catch(() => {});
  });

  await deleteTestJobs();
  await deleteOverrides([ORG_A, ORG_B]);

  await t.test(
    "fallback: no override row => enqueueJob uses MAX_ATTEMPTS_BY_KIND",
    async () => {
      const job = await enqueueJob({
        kind: "ingest_csv",
        orgId: ORG_A,
        payload: { settingsTest: "fallback" },
      });
      const stored = await getMaxAttempts(job.id);
      assert.equal(
        stored,
        MAX_ATTEMPTS_BY_KIND.ingest_csv,
        "ingest_csv should fall back to its in-code default when no override exists",
      );
    },
  );

  await t.test(
    "override: matching (org_id, kind) row drives the inserted max_attempts",
    async () => {
      await db
        .insert(jobKindSettingsTable)
        .values({ orgId: ORG_A, kind: "ingest_csv", maxAttempts: 11 })
        .onConflictDoUpdate({
          target: [jobKindSettingsTable.orgId, jobKindSettingsTable.kind],
          set: { maxAttempts: 11, updatedAt: new Date() },
        });

      const job = await enqueueJob({
        kind: "ingest_csv",
        orgId: ORG_A,
        payload: { settingsTest: "override-applies" },
      });
      const stored = await getMaxAttempts(job.id);
      assert.equal(stored, 11, "override should be picked up at insert time");
    },
  );

  await t.test(
    "tenant isolation: Org A's override does NOT affect Org B's enqueued job",
    async () => {
      // Reuse the override from the previous case (Org A -> ingest_csv = 11)
      // but enqueue for Org B. Org B has no row, so the in-code default
      // must be used.
      const [orgARow] = await db
        .select({ maxAttempts: jobKindSettingsTable.maxAttempts })
        .from(jobKindSettingsTable)
        .where(
          and(
            eq(jobKindSettingsTable.orgId, ORG_A),
            eq(jobKindSettingsTable.kind, "ingest_csv"),
          ),
        );
      assert.equal(
        orgARow?.maxAttempts,
        11,
        "precondition: Org A's override should still be 11",
      );

      const job = await enqueueJob({
        kind: "ingest_csv",
        orgId: ORG_B,
        payload: { settingsTest: "isolation" },
      });
      const stored = await getMaxAttempts(job.id);
      assert.equal(
        stored,
        MAX_ATTEMPTS_BY_KIND.ingest_csv,
        `Org B should see the in-code default (${MAX_ATTEMPTS_BY_KIND.ingest_csv}), not Org A's override (11)`,
      );
    },
  );

  await t.test(
    "system jobs (orgId=null) always use the in-code default, never an override",
    async () => {
      // Even though Org A has an override for ingest_csv, a system job
      // enqueued without an orgId must skip the per-tenant lookup and
      // use MAX_ATTEMPTS_BY_KIND.
      const job = await enqueueJob({
        kind: "ingest_csv",
        orgId: null,
        payload: { settingsTest: "system-skips-override" },
      });
      const stored = await getMaxAttempts(job.id);
      assert.equal(
        stored,
        MAX_ATTEMPTS_BY_KIND.ingest_csv,
        "system jobs must always use the in-code default",
      );
    },
  );

  await t.test(
    "explicit args.maxAttempts wins over both override and default",
    async () => {
      const job = await enqueueJob({
        kind: "ingest_csv",
        orgId: ORG_A, // Org A still has override = 11 from earlier
        maxAttempts: 2,
        payload: { settingsTest: "explicit-wins" },
      });
      const stored = await getMaxAttempts(job.id);
      assert.equal(
        stored,
        2,
        "explicit caller override must win regardless of table state",
      );
    },
  );
});
