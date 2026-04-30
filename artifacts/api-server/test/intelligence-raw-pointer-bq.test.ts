/**
 * Regression test for #123: every successful BigQuery `collector_runs`
 * row must carry a non-null `raw_payload_pointer`.
 *
 * The runtime synthesizes a JSON snapshot of the parsed drafts when a
 * collector doesn't implement `collectWithRaw`, lands it in GCS, and
 * threads the resulting `gs://…` pointer into both the BQ
 * `market_signals.raw_payload_pointer` column and the BQ
 * `collector_runs.raw_payload_pointer` column. The pointer is what the
 * replay path keys off; if it's ever null on a `status="succeeded"`
 * run, the parsed signals can never be re-derived without re-fetching
 * upstream — defeating the entire raw-landing path.
 *
 * The test:
 *   1. forces intelligence "enabled" by setting the GCP env vars
 *   2. overrides `landRawPayload` to return a deterministic fake pointer
 *      (so we don't actually touch GCS)
 *   3. overrides `recordCollectorRun` to capture the row that would have
 *      been streamed into BigQuery
 *   4. registers a synthetic public-API collector via the same
 *      `registerCollector` / `upsertCollectorRegistration` /
 *      `approveCollector` flow used by other runtime tests
 *   5. invokes `runCollector` and asserts the captured run row's
 *      `rawPayloadPointer` is the fake pointer (i.e. not null)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { z } from "zod";
import {
  db,
  marketSignalsTable,
  collectorAuditLogTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  __setLandRawPayloadOverrideForTests,
  __setRecordCollectorRunOverrideForTests,
  type CollectorRunRecord,
  type LandPayloadResult,
} from "@workspace/intelligence";

import {
  registerCollector,
  runCollector,
  upsertCollectorRegistration,
  approveCollector,
} from "../src/lib/intelligence/runtime";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../src/lib/intelligence/collector";

const TEST_COLLECTOR_ID = `test-raw-pointer-${Date.now()}-${process.pid}`;
const FAKE_GCS_POINTER = `gs://fake-bucket/raw/${TEST_COLLECTOR_ID}/sample.json`;

// Original env values so we can restore them and not leak side effects
// into sibling tests in the same node:test run.
const ORIGINAL_ENV: Record<string, string | undefined> = {
  GCP_PROJECT_ID: process.env["GCP_PROJECT_ID"],
  GCS_RAW_BUCKET: process.env["GCS_RAW_BUCKET"],
  GOOGLE_APPLICATION_CREDENTIALS:
    process.env["GOOGLE_APPLICATION_CREDENTIALS"],
};

function makeCollector(): IntelligenceCollector {
  const schema = z
    .object({
      signalType: z.string(),
      value: z.number(),
      unit: z.string(),
      observedAt: z.date(),
      sourceUrl: z.string(),
    })
    .passthrough();
  return {
    id: TEST_COLLECTOR_ID,
    name: "Raw-Pointer Regression Collector",
    description: "Throw-away collector for raw_payload_pointer regression.",
    posture: "public-api",
    sourceUrl: "https://example.invalid/raw-pointer-test",
    defaultRateLimitRpm: 60,
    defaultScheduleCron: null,
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "GLOBAL",
    retentionDays: 365,
    tenantOptInDefault: true,
    signalSchema: schema,
    stableSignalKey(d: MarketSignalDraft) {
      return `${TEST_COLLECTOR_ID}:${d.signalType}:${
        d.observedAt instanceof Date
          ? d.observedAt.toISOString()
          : String(d.observedAt)
      }`;
    },
    async collect() {
      return [
        {
          signalType: "fx_rate",
          value: 1.2345,
          unit: "USD/EUR",
          observedAt: new Date("2026-04-30T00:00:00Z"),
          sourceUrl: "https://example.invalid/raw-pointer-test/observation/1",
        },
      ];
    },
  };
}

async function cleanup(): Promise<void> {
  await db
    .delete(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, TEST_COLLECTOR_ID));
  await db
    .delete(collectorAuditLogTable)
    .where(eq(collectorAuditLogTable.collectorId, TEST_COLLECTOR_ID));
}

test("collector_runs BQ row carries a non-null raw_payload_pointer (#123)", async () => {
  // 1. Coerce `isIntelligenceEnabled()` to true. The bridge resolver
  //    just reads these three env vars; the test never touches GCP.
  process.env["GCP_PROJECT_ID"] = "fake-project";
  process.env["GCS_RAW_BUCKET"] = "fake-bucket";
  process.env["GOOGLE_APPLICATION_CREDENTIALS"] = "/dev/null";

  // 2. Override the GCS landing helper so it stores the bytes in a
  //    fake "object store" keyed by pointer. We deliberately persist
  //    the bytes (not just return the pointer) so the assertion at
  //    the end can prove the pointer actually resolves to a readable
  //    payload — the whole point of #123 is that a non-null pointer
  //    is useless if the object behind it doesn't exist.
  const fakeObjectStore = new Map<string, Buffer>();
  __setLandRawPayloadOverrideForTests(async (args): Promise<LandPayloadResult> => {
    const buf = Buffer.isBuffer(args.payload)
      ? args.payload
      : Buffer.from(args.payload);
    fakeObjectStore.set(FAKE_GCS_POINTER, buf);
    return {
      pointer: FAKE_GCS_POINTER,
      path: `raw/${TEST_COLLECTOR_ID}/sample.json`,
      bytes: buf.length,
    };
  });

  // 3. Capture every recordCollectorRun call so we can inspect the
  //    arguments the runtime would have streamed to BigQuery.
  const captured: CollectorRunRecord[] = [];
  __setRecordCollectorRunOverrideForTests(async (row) => {
    captured.push(row);
    return true;
  });

  try {
    await cleanup();
    await upsertCollectorRegistration({
      id: TEST_COLLECTOR_ID,
      name: "Raw-Pointer Regression Collector",
      description: "raw_payload_pointer regression test",
      posture: "public-api",
      sourceUrl: "https://example.invalid/raw-pointer-test",
      owner: "test",
      actor: "test@procuro.ai",
    });
    await approveCollector(TEST_COLLECTOR_ID, "test@procuro.ai");
    registerCollector(makeCollector());

    const result = await runCollector(TEST_COLLECTOR_ID, { force: true });
    assert.equal(
      result.signalsCollected,
      1,
      "expected one new market signal to land in Postgres",
    );

    const successRuns = captured.filter((r) => r.status === "succeeded");
    assert.equal(
      successRuns.length,
      1,
      `expected exactly one succeeded recordCollectorRun call, got ${captured.length} total`,
    );
    const run = successRuns[0]!;
    assert.equal(
      run.collectorId,
      TEST_COLLECTOR_ID,
      "captured run should belong to the test collector",
    );
    // The actual regression assertion: the BQ run row must carry a
    // non-null raw_payload_pointer when the run succeeded.
    assert.notEqual(
      run.rawPayloadPointer,
      null,
      "succeeded collector_runs row must carry a non-null raw_payload_pointer",
    );
    assert.equal(
      run.rawPayloadPointer,
      FAKE_GCS_POINTER,
      "the pointer surfaced in the BQ row must be the one returned by landRawPayload",
    );
    assert.equal(run.rowsEmitted, 1);

    // Acceptance for #123: a non-null pointer is only meaningful if
    // the object it points at actually exists. Look the pointer up in
    // the fake object store the landRawPayload override populated;
    // a successful resolution proves the runtime threaded a *readable*
    // pointer into the BQ row (not a stale or fabricated string).
    const landed = fakeObjectStore.get(run.rawPayloadPointer!);
    assert.ok(
      landed,
      `the BQ row's raw_payload_pointer must resolve to a readable object; ` +
        `pointer=${run.rawPayloadPointer} not present in the fake object store`,
    );
    assert.ok(
      landed!.length > 0,
      "the resolved object must contain non-empty bytes (the JSON-encoded drafts)",
    );
    // And the resolved bytes must parse back to JSON we recognise —
    // the runtime serialises the run snapshot when collectWithRaw
    // isn't implemented, so the payload should be a JSON document
    // referencing this collector's id.
    const decodedText = landed!.toString("utf8");
    const decoded = JSON.parse(decodedText) as unknown;
    assert.ok(
      decoded !== null && typeof decoded === "object",
      `decoded payload should be a JSON object/array, got: ${decodedText.slice(0, 200)}`,
    );
    assert.ok(
      decodedText.includes(TEST_COLLECTOR_ID),
      `the landed payload must reference the collector id so replay can ` +
        `verify the source; got: ${decodedText.slice(0, 200)}`,
    );
  } finally {
    __setLandRawPayloadOverrideForTests(null);
    __setRecordCollectorRunOverrideForTests(null);
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await cleanup();
  }
});
