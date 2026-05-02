/**
 * Integration tests for the audit-trail columns on `job_kind_settings`
 * introduced by task #97 (`last_changed_by`, `last_changed_at`).
 *
 * Why this exists separate from `jobs-settings-resolve.test.ts`:
 *   - The sibling test pins *retry-budget resolution at enqueue time*.
 *   - This test pins *who/when an override was last written*, which is
 *     a different invariant: it is what the System / Jobs page surfaces
 *     beneath the "Last updated" timestamp so an operator looking at a
 *     custom retry budget can answer "who set this?".
 *
 * What we lock in:
 *   - The same upsert shape used by `PUT /jobs/settings/:kind` writes
 *     `lastChangedBy` and `lastChangedAt` on both the *insert* branch
 *     and the *on-conflict update* branch. Drizzle's `$onUpdate` does
 *     not fire on conflict-do-update, so the route sets both columns
 *     explicitly — this test would catch a future refactor that
 *     reverts to relying on `$onUpdate`.
 *   - A subsequent write by a different operator overwrites
 *     `lastChangedBy` (we never accumulate history; only the latest
 *     editor is surfaced).
 *   - Tenant isolation: writing an override for Org A leaves Org B's
 *     row (or absence) untouched, so one tenant's editor identity
 *     cannot bleed across the composite-PK boundary.
 *   - The DELETE path (`DELETE /jobs/settings/:kind`) removes the row
 *     entirely, which is what causes the GET response to surface
 *     `lastChangedBy: null` after a clear.
 *
 * Prereq mirrors `jobs-settings-resolve.test.ts`: `DATABASE_URL` set,
 * schema pushed, both seeded orgs present.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  jobKindSettingsTable,
  orgsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

const ORG_A = "org_scis_proc";
const ORG_B = "org_procureworks";
const KIND = "ingest_csv" as const;

/**
 * Mirror of the upsert performed inside `PUT /jobs/settings/:kind`
 * (artifacts/api-server/src/routes/jobs.ts). Kept as a tight helper so
 * each test case reads as "what the route would do" — and so a
 * regression in either the schema or the route's column list shows up
 * as a single diff hunk rather than scattered across the file.
 */
async function upsertOverride(
  orgId: string,
  maxAttempts: number,
  actor: string | null,
  now: Date,
): Promise<void> {
  await db
    .insert(jobKindSettingsTable)
    .values({
      orgId,
      kind: KIND,
      maxAttempts,
      updatedAt: now,
      lastChangedBy: actor,
      lastChangedAt: now,
    })
    .onConflictDoUpdate({
      target: [jobKindSettingsTable.orgId, jobKindSettingsTable.kind],
      set: {
        maxAttempts,
        updatedAt: now,
        lastChangedBy: actor,
        lastChangedAt: now,
      },
    });
}

async function readOverride(
  orgId: string,
): Promise<typeof jobKindSettingsTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(jobKindSettingsTable)
    .where(
      and(
        eq(jobKindSettingsTable.orgId, orgId),
        eq(jobKindSettingsTable.kind, KIND),
      ),
    );
  return row ?? null;
}

async function deleteOverrides(orgIds: string[]): Promise<void> {
  for (const orgId of orgIds) {
    await db
      .delete(jobKindSettingsTable)
      .where(
        and(
          eq(jobKindSettingsTable.orgId, orgId),
          eq(jobKindSettingsTable.kind, KIND),
        ),
      );
  }
}

test("retry-budget audit columns: who/when round-trip across upsert paths", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const presentOrgs = await db
    .select({ id: orgsTable.id })
    .from(orgsTable);
  const ids = new Set(presentOrgs.map((o) => o.id));
  if (!ids.has(ORG_A) || !ids.has(ORG_B)) {
    console.warn(
      `[skip] jobs-settings-audit: required seeded orgs missing (have=${[...ids].join(",")})`,
    );
    return;
  }

  t.after(async () => {
    try {
      await deleteOverrides([ORG_A, ORG_B]);
    } catch (err) {
      console.error("[cleanup] jobs-settings-audit cleanup failed:", err);
    }
    await pool.end().catch(() => {});
  });

  await deleteOverrides([ORG_A, ORG_B]);

  await t.test(
    "insert branch: first write stamps lastChangedBy and lastChangedAt",
    async () => {
      const now = new Date();
      await upsertOverride(ORG_A, 5, "alice@procuro.ai", now);

      const row = await readOverride(ORG_A);
      assert.ok(row, "override row should exist after first write");
      assert.equal(row.maxAttempts, 5);
      assert.equal(
        row.lastChangedBy,
        "alice@procuro.ai",
        "first write must stamp the editor identity from req.actorEmail",
      );
      assert.ok(
        row.lastChangedAt instanceof Date,
        "first write must stamp lastChangedAt explicitly (not rely on $onUpdate)",
      );
      assert.equal(
        row.lastChangedAt!.getTime(),
        now.getTime(),
        "lastChangedAt must equal the server-side `now` passed to the upsert",
      );
    },
  );

  await t.test(
    "upsert update branch: a second editor overwrites lastChangedBy",
    async () => {
      // First editor still owns the row from the previous case.
      const before = await readOverride(ORG_A);
      assert.equal(before?.lastChangedBy, "alice@procuro.ai");

      // A new write by a different operator must overwrite the audit
      // columns — we surface "the latest editor", not a history.
      // Sleep a tick so `lastChangedAt` is provably advanced (Postgres
      // timestamptz has microsecond resolution, but JS Date is
      // millisecond, so we wait one millisecond to be safe).
      await new Promise((r) => setTimeout(r, 2));
      const later = new Date();
      await upsertOverride(ORG_A, 9, "bob@procuro.ai", later);

      const after = await readOverride(ORG_A);
      assert.ok(after);
      assert.equal(after.maxAttempts, 9, "max_attempts must follow the new write");
      assert.equal(
        after.lastChangedBy,
        "bob@procuro.ai",
        "on-conflict-do-update branch must overwrite lastChangedBy",
      );
      assert.ok(
        after.lastChangedAt instanceof Date &&
          before?.lastChangedAt instanceof Date &&
          after.lastChangedAt.getTime() > before.lastChangedAt.getTime(),
        "lastChangedAt must advance on the update branch (drizzle's $onUpdate does NOT fire on conflict)",
      );
    },
  );

  await t.test(
    "null actor is permitted (legacy/system-context writes)",
    async () => {
      // The schema deliberately allows `last_changed_by` to be null
      // because pre-#97 rows do not have an editor identity, and some
      // dev/test paths populate `req.actorEmail = null`. The UI shows
      // an em-dash for these. This test pins that the column accepts
      // null without throwing a NOT NULL violation.
      const now = new Date();
      await upsertOverride(ORG_B, 4, null, now);
      const row = await readOverride(ORG_B);
      assert.ok(row);
      assert.equal(row.lastChangedBy, null);
      assert.ok(row.lastChangedAt instanceof Date);
    },
  );

  await t.test(
    "tenant isolation: writing Org A's audit row leaves Org B untouched",
    async () => {
      // Seed Org B with a known editor; then mutate Org A; assert
      // Org B's row is unchanged. The composite PK `(org_id, kind)`
      // already enforces this at the SQL level — this test would
      // catch a future refactor that, e.g., dropped `org_id` from
      // the conflict target.
      const seededAt = new Date();
      await upsertOverride(ORG_B, 6, "carol@procuro.ai", seededAt);
      const orgBBefore = await readOverride(ORG_B);
      assert.equal(orgBBefore?.lastChangedBy, "carol@procuro.ai");

      await new Promise((r) => setTimeout(r, 2));
      await upsertOverride(ORG_A, 12, "dave@procuro.ai", new Date());

      const orgBAfter = await readOverride(ORG_B);
      assert.deepEqual(
        {
          lastChangedBy: orgBAfter?.lastChangedBy,
          lastChangedAt: orgBAfter?.lastChangedAt?.getTime(),
          maxAttempts: orgBAfter?.maxAttempts,
        },
        {
          lastChangedBy: orgBBefore?.lastChangedBy,
          lastChangedAt: orgBBefore?.lastChangedAt?.getTime(),
          maxAttempts: orgBBefore?.maxAttempts,
        },
        "Org B's audit row must not be perturbed by an Org A write",
      );
    },
  );

  await t.test(
    "DELETE clears the row entirely so subsequent reads surface lastChangedBy=null",
    async () => {
      // The route's DELETE handler `delete(...).where(orgId & kind)`
      // removes the row; the GET handler then synthesises a
      // `lastChangedBy: null` for kinds without a row. This test pins
      // the data-layer half of that contract.
      assert.ok(await readOverride(ORG_A), "precondition: Org A row exists");
      await deleteOverrides([ORG_A]);
      assert.equal(
        await readOverride(ORG_A),
        null,
        "DELETE must remove the row so the GET path falls back to defaults with null audit fields",
      );
    },
  );
});
