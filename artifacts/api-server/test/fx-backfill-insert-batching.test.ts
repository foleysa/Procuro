/**
 * Guardrail: the ECB FX backfill stays *batched* and *idempotent*.
 *
 * Background. Task #49 sped up the historical backfill by switching
 * `insertSignalsIdempotent` from per-row inserts to a single
 * `INSERT … VALUES (...), (...), … ON CONFLICT DO NOTHING` per chunk
 * (chunk size 500). The functional behavior is unchanged — same rows
 * land in `market_signals`, same dedupe outcome — so a future refactor
 * could silently regress back to per-row inserts and the table would
 * still look correct, just 5–10× slower per backfill press.
 *
 * This test pins both invariants in one place:
 *
 *   1. **Batching.** A cold insert of N synthetic FX drafts must hit
 *      `market_signals` in `ceil(N / CHUNK_SIZE)` INSERT statements,
 *      not N. We monkey-patch the shared `pg.Pool` to count
 *      `INSERT INTO market_signals` statements (covering both
 *      `pool.query` and any client checked out via `pool.connect`),
 *      then assert the count is at most a couple of round-trips for
 *      ~1500 rows.
 *
 *   2. **Idempotency.** Re-running with the same drafts inserts zero
 *      new rows and reports every row as `signalsSkipped`. A mixed
 *      re-run that adds new observed-at days inserts exactly the new
 *      ones and skips the rest — the natural-key dedupe is doing the
 *      work, not luck.
 *
 * Drives `insertSignalsIdempotent` directly (test-only export from
 * `runtime.ts`) so the assertion is on the shared backfill plumbing
 * itself, not the ECB-specific wrapper. Same plumbing is used by the
 * FRED, OpenSanctions, GLEIF, ClimateTRACE, and Companies House
 * backfills — guarding it once covers all of them.
 *
 * Prereqs (same as the other api-server integration tests):
 *   - `DATABASE_URL` is set and the schema has been pushed
 *     (`pnpm --filter @workspace/db run push`).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  marketSignalsTable,
  collectorAuditLogTable,
  collectorsTable,
  type CollectorRow,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  approveCollector,
  disableCollector,
  insertSignalsIdempotent,
  upsertCollectorRegistration,
} from "../src/lib/intelligence/runtime";
import type { MarketSignalDraft } from "../src/lib/intelligence/collector";

const TEST_COLLECTOR_ID = `test-fx-batch-${Date.now()}-${process.pid}`;

/** Chunk size hard-coded in `insertSignalsIdempotent`. Mirror it here so
 * the assertion is explicit rather than depending on internal state. */
const CHUNK_SIZE = 500;

/**
 * Synthetic FX-rate drafts modelled on what `buildEcbDraftsForDay` emits
 * (signalType="fx_rate", scopeMaterialCode="EUR/<quote>", one observed_at
 * per day). Each (day × quote) pair is a unique natural-key tuple so all
 * `count` drafts land as distinct rows on a cold insert.
 *
 * `dayOffset` lets a follow-up run produce drafts on *new* days that
 * don't collide with the cold-insert cohort, exercising the mixed
 * already-seen / new path of the dedupe.
 */
function makeFxDrafts(count: number, dayOffset = 0): MarketSignalDraft[] {
  const quotes = ["USD", "GBP", "JPY", "CHF", "AUD", "CAD", "SEK", "NOK", "DKK", "PLN"];
  const drafts: MarketSignalDraft[] = [];
  // Anchor far in the past so we never collide with rows another test
  // (or a real backfill) might have written for recent ECB days.
  const epoch = Date.UTC(1990, 0, 1);
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = 0; i < count; i++) {
    const dayIdx = dayOffset + Math.floor(i / quotes.length);
    const quote = quotes[i % quotes.length]!;
    const observedAt = new Date(epoch + dayIdx * dayMs);
    const pair = `EUR/${quote}`;
    drafts.push({
      signalType: "fx_rate",
      scopeMaterialCode: pair,
      value: 1 + (i % 100) / 100,
      unit: pair,
      currency: quote,
      observedAt,
      sourceUrl: "https://example.test/fx-batch-guardrail",
      confidence: 0.99,
      metadata: {
        base: "EUR",
        quote,
        feed: "test-fx-batch-guardrail",
        publishedDate: observedAt.toISOString().slice(0, 10),
      },
    });
  }
  return drafts;
}

/**
 * Count `INSERT INTO market_signals` statements that hit Postgres.
 *
 * Hooks `pool.connect` and wraps the returned client's `query` method.
 * `pool.query(text)` internally calls `this.connect(cb)` then
 * `client.query(text, …)` on the checked-out client, so wrapping at
 * the client layer captures BOTH:
 *
 *   - the current non-transactional `db.execute(sql`…`)` path (which
 *     drizzle routes through `pool.query` → wrapped client.query), and
 *   - any future refactor that wraps the insert in a `db.transaction`
 *     (which would route through `pool.connect()` directly + a series
 *     of `client.query(...)` calls on the same checked-out client).
 *
 * Wrapping at the client layer (instead of `pool.query`) avoids
 * double-counting: every statement is a `client.query`, exactly once.
 *
 * Returns a `restore()` to put the original `connect` method back and
 * a `reset()` to zero the counter between phases. We tag wrapped
 * clients with `__signalSpyWrapped` so the same client checked out
 * twice from the pool isn't wrapped twice.
 */
function installInsertSpy(): {
  count: () => number;
  reset: () => void;
  restore: () => void;
} {
  let n = 0;
  const isMarketSignalsInsert = (text: unknown): boolean =>
    typeof text === "string" &&
    /INSERT\s+INTO\s+"?market_signals"?/i.test(text);

  type SpyableClient = {
    query: (...args: unknown[]) => unknown;
    __signalSpyWrapped?: boolean;
  };

  const wrapClient = (client: unknown): unknown => {
    const c = client as SpyableClient | null | undefined;
    if (c && !c.__signalSpyWrapped) {
      const originalClientQuery = c.query.bind(c);
      c.query = (...qargs: unknown[]): unknown => {
        const first = qargs[0] as { text?: string } | string | undefined;
        const text = typeof first === "string" ? first : first?.text;
        if (isMarketSignalsInsert(text)) n += 1;
        return originalClientQuery(...qargs);
      };
      c.__signalSpyWrapped = true;
    }
    return client;
  };

  const originalConnect = pool.connect.bind(pool);

  // pg-pool's `connect` supports two call styles:
  //   - callback: `connect((err, client, done) => …)` — returns void.
  //     `pool.query` uses this style internally.
  //   - promise:  `connect()` with no args — returns Promise<client>.
  //     drizzle's `db.transaction(...)` and direct callers use this.
  // The wrapper has to handle both or breaks the callback-style flow.
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (
    ...args: unknown[]
  ): unknown => {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      const cb = last as (
        err: unknown,
        client: unknown,
        done: unknown,
      ) => void;
      return (originalConnect as unknown as (
        cb: (err: unknown, client: unknown, done: unknown) => void,
      ) => unknown)((err, client, done) => {
        if (!err) wrapClient(client);
        cb(err, client, done);
      });
    }
    const result = (originalConnect as unknown as (
      ...a: unknown[]
    ) => unknown)(...args);
    if (
      result &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      return (result as Promise<unknown>).then((client) => wrapClient(client));
    }
    return result;
  };

  return {
    count: () => n,
    reset: () => {
      n = 0;
    },
    restore: () => {
      (pool as unknown as { connect: typeof originalConnect }).connect =
        originalConnect;
    },
  };
}

async function deleteTestData(): Promise<void> {
  await db
    .delete(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, TEST_COLLECTOR_ID));
  await db
    .delete(collectorAuditLogTable)
    .where(eq(collectorAuditLogTable.collectorId, TEST_COLLECTOR_ID));
}

async function countRows(): Promise<number> {
  const rows = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, TEST_COLLECTOR_ID));
  return rows.length;
}

test("insertSignalsIdempotent batches inserts and stays idempotent on re-run", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Register a throw-away collector row so the FK from `market_signals`
  // resolves. We never run the live collector — `insertSignalsIdempotent`
  // only needs `collectorRow.{id, posture}`.
  await upsertCollectorRegistration({
    id: TEST_COLLECTOR_ID,
    name: "Test FX Batch Guardrail Collector",
    description: "Throw-away collector for FX backfill batching guardrail.",
    posture: "public-api",
    owner: "tests",
    sourceUrl: "https://example.test/fx-batch-guardrail",
    rateLimitRpm: 60,
    scheduleCron: null,
    notes: null,
    actor: "tests",
  });
  await approveCollector(TEST_COLLECTOR_ID, "tests");

  const [collectorRow] = await db
    .select()
    .from(collectorsTable)
    .where(eq(collectorsTable.id, TEST_COLLECTOR_ID))
    .limit(1);
  assert.ok(collectorRow, "test collector registry row exists");
  const reg: CollectorRow = collectorRow!;

  const spy = installInsertSpy();

  t.after(async () => {
    spy.restore();
    try {
      await deleteTestData();
      // Mark the throw-away registry row rejected so it doesn't appear
      // as an approved collector in any operator UI even if the FK-
      // bound row itself can't be deleted.
      await disableCollector(TEST_COLLECTOR_ID, "tests", "rejected");
    } catch (err) {
      console.error("[cleanup] fx-batch guardrail cleanup failed:", err);
    }
    await pool.end().catch(() => {});
  });

  await deleteTestData();

  // ---------------------------------------------------------------
  // 1) Cold insert: N drafts → N rows, in O(N / CHUNK_SIZE) round-trips.
  // ---------------------------------------------------------------
  // 1500 drafts spans three full chunks. Picking a multiple of CHUNK_SIZE
  // makes the expected round-trip count exact (3) and the assertion
  // crisp: the regression we're guarding against would push it to ≈1500.
  const N = 1500;
  const cold = makeFxDrafts(N);
  assert.equal(cold.length, N);

  spy.reset();
  const r1 = await insertSignalsIdempotent(reg, cold);
  const coldQueryCount = spy.count();

  assert.equal(r1.inserted, N, "cold run inserts every draft");
  assert.equal(r1.skipped, 0, "no in-batch or cross-run dups on cold run");
  assert.equal(await countRows(), N, "row count matches inserted count");

  const expectedChunks = Math.ceil(N / CHUNK_SIZE);
  assert.equal(
    expectedChunks,
    3,
    "sanity: 1500 / 500 = 3 chunks expected by this test's setup",
  );
  // Allow a tiny amount of headroom in case the implementation grows a
  // small fixed prelude (e.g. a single `SET … ` or `BEGIN` before the
  // chunked inserts). The point of the assertion is to fail loudly if
  // someone reverts to per-row inserts — *that* path would produce
  // >= N statements, nowhere near `expectedChunks + 2`.
  assert.ok(
    coldQueryCount <= expectedChunks + 2,
    `expected ≤${expectedChunks + 2} INSERT statements for ${N} rows ` +
      `(batched in chunks of ${CHUNK_SIZE}); got ${coldQueryCount}. ` +
      `A regression to per-row inserts would produce ≈${N} statements.`,
  );
  // And, crucially, far fewer than per-row would produce.
  assert.ok(
    coldQueryCount < N / 10,
    `INSERT statement count (${coldQueryCount}) must be dramatically ` +
      `smaller than draft count (${N}); per-row regression would be ~${N}.`,
  );

  // ---------------------------------------------------------------
  // 2) Warm re-run: same drafts → 0 inserted, all skipped.
  // ---------------------------------------------------------------
  spy.reset();
  const r2 = await insertSignalsIdempotent(reg, cold);
  const warmQueryCount = spy.count();

  assert.equal(r2.inserted, 0, "warm re-run inserts zero rows");
  assert.equal(
    r2.skipped,
    N,
    "warm re-run reports every row as a duplicate-skip",
  );
  assert.equal(await countRows(), N, "row count is stable across the re-run");
  // Warm path still issues one INSERT per chunk (each statement is the
  // ON CONFLICT DO NOTHING that finds every row already there). Same
  // batching guarantee applies — a per-row regression would balloon
  // this number to ~N as well.
  assert.ok(
    warmQueryCount <= expectedChunks + 2,
    `warm re-run also expected to be batched (≤${expectedChunks + 2} ` +
      `statements); got ${warmQueryCount}.`,
  );

  // ---------------------------------------------------------------
  // 3) Mixed re-run: 1500 already-seen + 500 brand-new drafts on new
  //    observed-at days → exactly 500 inserted, 1500 skipped.
  // ---------------------------------------------------------------
  // Bump the day offset past the cold cohort so the "new" drafts have
  // observed_at values that don't collide on the natural key.
  const newDays = 500;
  const coldDayCount = Math.ceil(N / 10); // makeFxDrafts uses 10 quotes
  const fresh = makeFxDrafts(newDays, coldDayCount);
  // Sanity: the fresh drafts must not overlap with the cold cohort on
  // (scopeMaterialCode, observedAt). If the offset math regresses, the
  // assertion below would silently pass with the wrong reason.
  const coldKeys = new Set(
    cold.map(
      (d) => `${d.scopeMaterialCode}|${d.observedAt.toISOString()}`,
    ),
  );
  for (const f of fresh) {
    const k = `${f.scopeMaterialCode}|${f.observedAt.toISOString()}`;
    assert.ok(
      !coldKeys.has(k),
      `fresh draft ${k} unexpectedly collides with cold cohort`,
    );
  }
  const mixed = [...cold, ...fresh];

  spy.reset();
  const r3 = await insertSignalsIdempotent(reg, mixed);

  assert.equal(
    r3.inserted,
    newDays,
    "mixed re-run inserts only the brand-new drafts",
  );
  assert.equal(
    r3.skipped,
    N,
    "mixed re-run skips every already-seen draft",
  );
  assert.equal(
    await countRows(),
    N + newDays,
    "row count grew by exactly the new-draft count",
  );
});
