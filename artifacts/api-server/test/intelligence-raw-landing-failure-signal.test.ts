/**
 * Task #133 — when raw-payload landing to GCS fails, the runtime must
 * loudly surface that to operators instead of swallowing it as a
 * worker warn log. The acceptance bar from the task is "audit-log
 * event in the workbench, status badge, or `raw_landing_failed`
 * flag in `collector_runs`" — this test pins down all three of the
 * durable signals the runtime is responsible for emitting:
 *
 *   1. A dedicated `raw_landing_failed` row appears in
 *      `collector_audit_log` for every failed upload, carrying the
 *      run id and the GCS error message. The workbench Runs & Errors
 *      tab keys off this event id.
 *
 *   2. The `fetch_succeeded` audit row carries
 *      `metadata.rawLandingFailed: true` (plus `rawLandingAttempts` /
 *      `rawLandingFailures` counters), so a single audit query can
 *      paint both successful-but-impaired runs and the per-attempt
 *      forensic detail.
 *
 *   3. The `recordCollectorRun` payload streamed to BigQuery has
 *      `rawLandingFailed: true`, so the warehouse-backed Source
 *      Health roll-up can count the outage even after the audit log
 *      has rotated out.
 *
 * The companion route test in `collectors.ts` uses the same audit
 * event to populate the source-health response, and the
 * `collectors.tsx` workbench renders the red chip + XCircle in the
 * Runs & Errors stream. This test is the runtime contract those rely
 * on; if the runtime ever stops writing the audit row or stops
 * threading the flag into the BQ record, the workbench will go silent
 * again and operators will lose the only fast signal of a sustained
 * landing outage.
 *
 * Strategy mirrors `intelligence-raw-pointer-bq.test.ts`: hermetic
 * fakes for `landRawPayload` (forced to throw) and
 * `recordCollectorRun` (capturing the streamed row). Postgres is
 * real because the audit log lives there.
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

const TEST_COLLECTOR_ID = `test-raw-landing-fail-${Date.now()}-${process.pid}`;
const FAKE_GCS_ERROR =
  "503 Service Unavailable from fake GCS — landing rejected";

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
    name: "Raw-Landing-Failure Regression Collector",
    description:
      "Throw-away collector for the raw_landing_failed signal contract.",
    posture: "public-api",
    sourceUrl: "https://example.invalid/raw-landing-failure-test",
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
          sourceUrl:
            "https://example.invalid/raw-landing-failure-test/observation/1",
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

test("raw-landing failure surfaces an audit event, fetch_succeeded metadata, and a BQ flag (#133)", async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error(
      "DATABASE_URL is required to run this integration test.",
    );
  }

  // Coerce isIntelligenceEnabled() so the runtime actually attempts
  // the GCS landing branch we're trying to fault.
  process.env["GCP_PROJECT_ID"] = "fake-project";
  process.env["GCS_RAW_BUCKET"] = "fake-bucket";
  process.env["GOOGLE_APPLICATION_CREDENTIALS"] = "/dev/null";

  // Force the GCS landing to fail. The runtime must catch this and
  // continue (Postgres + BQ remain the system of record for the
  // parsed rows) but emit the visible signals we assert below.
  __setLandRawPayloadOverrideForTests(async () => {
    throw new Error(FAKE_GCS_ERROR);
  });

  const captured: CollectorRunRecord[] = [];
  __setRecordCollectorRunOverrideForTests(async (row) => {
    captured.push(row);
    return true;
  });

  try {
    await cleanup();
    await upsertCollectorRegistration({
      id: TEST_COLLECTOR_ID,
      name: "Raw-Landing-Failure Regression Collector",
      description: "raw_landing_failed signal regression test",
      posture: "public-api",
      sourceUrl: "https://example.invalid/raw-landing-failure-test",
      owner: "test",
      actor: "test@procuro.ai",
    });
    await approveCollector(TEST_COLLECTOR_ID, "test@procuro.ai");
    registerCollector(makeCollector());

    const result = await runCollector(TEST_COLLECTOR_ID, { force: true });
    assert.equal(
      result.signalsCollected,
      1,
      "the run must still land its parsed signal in Postgres — GCS landing " +
        "failures are explicitly non-fatal so the runtime degrades gracefully",
    );

    // ---------------------------------------------------------------
    // 1. Dedicated `raw_landing_failed` audit row
    // ---------------------------------------------------------------
    const auditRows = await db
      .select()
      .from(collectorAuditLogTable)
      .where(eq(collectorAuditLogTable.collectorId, TEST_COLLECTOR_ID));

    const rawFailRows = auditRows.filter(
      (r) => r.event === "raw_landing_failed",
    );
    assert.equal(
      rawFailRows.length,
      1,
      "exactly one raw_landing_failed audit row should have been written " +
        "for the single failed landing attempt — this is what the workbench " +
        "Runs & Errors tab keys off",
    );
    const failRow = rawFailRows[0]!;
    assert.equal(
      failRow.error,
      FAKE_GCS_ERROR,
      "the audit row must carry the underlying GCS error message so " +
        "operators can triage without grepping worker logs",
    );
    const failMeta = (failRow.metadata ?? {}) as Record<string, unknown>;
    assert.equal(
      typeof failMeta["runId"],
      "string",
      "raw_landing_failed metadata must include the runId so the row can " +
        "be correlated back to the rest of the run's audit trail",
    );

    // ---------------------------------------------------------------
    // 2. fetch_succeeded metadata carries the raw-landing flags
    // ---------------------------------------------------------------
    const succeededRows = auditRows.filter(
      (r) => r.event === "fetch_succeeded",
    );
    assert.equal(
      succeededRows.length,
      1,
      "the run must still record a fetch_succeeded audit row — Postgres " +
        "and BQ landed the signal, only the raw-payload landing failed",
    );
    const succeededMeta = (succeededRows[0]!.metadata ?? {}) as Record<
      string,
      unknown
    >;
    assert.equal(
      succeededMeta["rawLandingFailed"],
      true,
      "fetch_succeeded.metadata.rawLandingFailed must be true so the " +
        "workbench can badge runs that succeeded for Postgres+BQ but " +
        "lost their replay pointer to a GCS outage",
    );
    assert.equal(
      Number(succeededMeta["rawLandingAttempts"]),
      1,
      "exactly one landing attempt was made for the synthesized snapshot",
    );
    assert.equal(
      Number(succeededMeta["rawLandingFailures"]),
      1,
      "the single attempt must be reflected in the failure count too",
    );
    assert.equal(
      Number(succeededMeta["rawLanded"]),
      0,
      "no payloads landed, so rawLanded must be 0 (this also implies " +
        "the BQ market_signals rows from this run carry a null pointer)",
    );

    // ---------------------------------------------------------------
    // 3. BQ collector_runs row carries the rawLandingFailed flag
    // ---------------------------------------------------------------
    const successRuns = captured.filter((r) => r.status === "succeeded");
    assert.equal(
      successRuns.length,
      1,
      `exactly one succeeded recordCollectorRun call expected, got ${captured.length} total`,
    );
    const bqRun = successRuns[0]!;
    assert.equal(
      bqRun.collectorId,
      TEST_COLLECTOR_ID,
      "captured BQ run must belong to the test collector",
    );
    assert.equal(
      bqRun.rawLandingFailed,
      true,
      "BQ collector_runs.raw_landing_failed must be true so the " +
        "warehouse-backed Source Health roll-up can count the outage even " +
        "after the audit log has rotated",
    );
    assert.equal(
      bqRun.rawPayloadPointer,
      null,
      "since the only landing attempt failed, the BQ run row must not " +
        "carry a stale or fabricated pointer",
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
