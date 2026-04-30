/**
 * Verifies that the streaming CSV path (`streamCsvEntity` for the
 * `suppliers` entity) preserves the optional `tags` column documented on
 * the Data Ingest page and shipped in the downloadable template.
 *
 * Two paths are exercised:
 *   1. Insert: a brand-new supplier row with `tags` is parsed and the
 *      resulting DB row carries the parsed array.
 *   2. Upsert: re-streaming the same `externalId` with a different `tags`
 *      cell updates the existing row's `tags` column (the original
 *      streaming path hardcoded `tags: []` and omitted `tags` from the
 *      conflict update set, so both halves used to silently drop the
 *      data).
 *
 * Also pins the delimiter behavior (`|`, `;`, `,` are all valid separators)
 * to mirror the helper in `artifacts/command-center/src/pages/ingest.tsx`.
 *
 * Prereqs (same as `csv-stream-large.test.ts`):
 *   - `DATABASE_URL` is set and the schema has been pushed.
 *   - At least one row exists in `orgs`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { db, orgsTable, suppliersTable, pool } from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import {
  parseTagsCell,
  streamCsvEntity,
} from "../src/lib/adapters/csv-adapter";

const TEST_RUN_ID = `csvtagstest-${Date.now()}-${process.pid}`;
const EXTERNAL_ID_PREFIX = `${TEST_RUN_ID}-`;

async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) {
    throw new Error(
      "No org rows found. Seed the database (pnpm --filter @workspace/scripts run seed) before running this test.",
    );
  }
  return row.id;
}

async function deleteTestRows(): Promise<number> {
  const deleted = await db
    .delete(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, "csv"),
        like(suppliersTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}%`),
      ),
    )
    .returning({ id: suppliersTable.id });
  return deleted.length;
}

function csvStream(body: string): Readable {
  return Readable.from([body]);
}

test("parseTagsCell splits on |, ;, and , and trims/filters", () => {
  assert.deepEqual(parseTagsCell(undefined), []);
  assert.deepEqual(parseTagsCell(""), []);
  assert.deepEqual(parseTagsCell("electronics|preferred"), [
    "electronics",
    "preferred",
  ]);
  assert.deepEqual(parseTagsCell("a; b ; c"), ["a", "b", "c"]);
  assert.deepEqual(parseTagsCell("x,y,,z"), ["x", "y", "z"]);
  assert.deepEqual(parseTagsCell(" mixed | bag ; ok , last "), [
    "mixed",
    "bag",
    "ok",
    "last",
  ]);
});

test("streaming suppliers ingest preserves the `tags` column on insert and upsert", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  t.after(async () => {
    try {
      await deleteTestRows();
    } catch (err) {
      console.error("[cleanup] failed to delete test rows:", err);
    }
    await pool.end().catch(() => {});
  });

  const orgId = await pickOrgId();
  // Paranoia: clean any leftovers from a prior interrupted run.
  await deleteTestRows();

  const extA = `${EXTERNAL_ID_PREFIX}A`;
  const extB = `${EXTERNAL_ID_PREFIX}B`;
  const extC = `${EXTERNAL_ID_PREFIX}C`;

  // 1. Insert: three new suppliers with tags using each documented delimiter,
  //    plus one with an empty tags cell.
  const insertCsv =
    "externalId,name,tags\n" +
    `${extA},Acme Industrial,electronics|preferred\n` +
    `${extB},Bravo Components,"alpha; beta ; gamma"\n` +
    `${extC},Charlie Co,\n`;

  const insertResult = await streamCsvEntity({
    orgId,
    entity: "suppliers",
    input: csvStream(insertCsv),
  });
  assert.equal(insertResult.rowsParsed, 3);
  assert.equal(insertResult.rowsInserted, 3);

  const afterInsert = await db
    .select({
      ext: suppliersTable.sourceExternalId,
      tags: suppliersTable.tags,
    })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, "csv"),
        like(suppliersTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}%`),
      ),
    );
  const byExt = new Map(afterInsert.map((r) => [r.ext, r.tags]));
  assert.deepEqual(byExt.get(extA), ["electronics", "preferred"]);
  assert.deepEqual(byExt.get(extB), ["alpha", "beta", "gamma"]);
  assert.deepEqual(
    byExt.get(extC),
    [],
    "missing/empty tags cell should yield an empty array, not null",
  );

  // 2. Upsert: re-stream the same externalIds with a different tags column
  //    and confirm the conflict-update path overwrites the previous value.
  const upsertCsv =
    "externalId,name,tags\n" +
    `${extA},Acme Industrial,strategic\n` +
    `${extB},Bravo Components,\n` +
    `${extC},Charlie Co,"red,green,blue"\n`;

  const upsertResult = await streamCsvEntity({
    orgId,
    entity: "suppliers",
    input: csvStream(upsertCsv),
  });
  assert.equal(upsertResult.rowsParsed, 3);
  assert.equal(upsertResult.rowsInserted, 3);

  const afterUpsert = await db
    .select({
      ext: suppliersTable.sourceExternalId,
      tags: suppliersTable.tags,
    })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, "csv"),
        like(suppliersTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}%`),
      ),
    );
  const byExt2 = new Map(afterUpsert.map((r) => [r.ext, r.tags]));
  assert.deepEqual(byExt2.get(extA), ["strategic"]);
  assert.deepEqual(
    byExt2.get(extB),
    [],
    "upsert with empty tags cell should clear the previous tags",
  );
  assert.deepEqual(byExt2.get(extC), ["red", "green", "blue"]);
});
