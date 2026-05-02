/**
 * End-to-end test for the Defense Pack pipeline.
 *
 * The unit suites (`defense-pack-sanitize.test.ts`,
 * `defense-pack-verify.test.ts`) cover the prompt-injection sanitiser
 * and the citation verifier in isolation. This test wires the whole
 * route handler together — seeded `market_signals`, real
 * `assembleEvidence` query, mocked Gemini call at the module boundary —
 * and asserts the three properties a buyer's negotiation memo must
 * uphold:
 *
 *   a) Every claim in the persisted pack cites a `signalId` that came
 *      from the seeded evidence pool.
 *   b) A claim that invents a `signalId` not in the pool is dropped
 *      from the persisted pack (the verifier strips it).
 *   c) A target with zero T1/T2 evidence yields
 *      `status: "insufficient_evidence"` and never reaches the
 *      Gemini call (so we can prove regressions in the prompt
 *      template can't accidentally leak un-cited memos).
 *
 * The Gemini SDK is mocked at `@workspace/integrations-gemini-ai` via
 * `node:test`'s experimental module mocks (enabled in the test script
 * with `--experimental-test-module-mocks`). The mock reads its next
 * canned response from a queue the test fills before each scenario.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

// ---------------------------------------------------------------------
// Mock the Gemini SDK BEFORE importing the app. The real client throws
// at import time when AI_INTEGRATIONS_GEMINI_BASE_URL / _API_KEY are
// missing (see lib/integrations-gemini-ai/src/client.ts), so without
// the mock the test process couldn't even load `defense-packs.ts`.
// ---------------------------------------------------------------------
interface CannedGeminiResponse {
  text: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const responseQueue: Array<() => CannedGeminiResponse> = [];
let geminiCallCount = 0;

function queueResponse(body: unknown, usage = { promptTokenCount: 100, candidatesTokenCount: 200 }): void {
  responseQueue.push(() => ({
    text: typeof body === "string" ? body : JSON.stringify(body),
    usageMetadata: usage,
  }));
}

mock.module("@workspace/integrations-gemini-ai", {
  namedExports: {
    ai: {
      models: {
        generateContent: async (_args: unknown): Promise<CannedGeminiResponse> => {
          geminiCallCount += 1;
          const next = responseQueue.shift();
          if (!next) {
            throw new Error(
              "Gemini mock: no canned response queued — test forgot to call queueResponse()",
            );
          }
          return next();
        },
      },
    },
  },
});

// Now safe to dynamically import the app + DB layer. NOTE: these MUST be
// dynamic (`await import(...)`) — static `import` declarations are
// hoisted in ESM and would resolve `@workspace/integrations-gemini-ai`
// before `mock.module(...)` above runs, defeating the mock.
import type { DefensePackSection } from "@workspace/db";
import type { IntelligenceCollector } from "../src/lib/intelligence/collector";

const dbMod = await import("@workspace/db");
const {
  db,
  pool,
  orgsTable,
  collectorsTable,
  marketSignalsTable,
  suppliersTable,
  defensePacksTable,
} = dbMod;
const { eq, inArray } = await import("drizzle-orm");
const { default: app } = await import("../src/app");
const { registerCollector } = await import("../src/lib/intelligence/runtime");
const { defaultStableSignalKey, looseSignalDraftSchema } = await import(
  "../src/lib/intelligence/contractHelpers"
);

// ---------------------------------------------------------------------
// Fixture identifiers — namespaced per run so concurrent suites don't
// stomp on each other.
// ---------------------------------------------------------------------
const RUN = `${Date.now()}-${process.pid}`;
const ORG_ID = `dpe2e-org-${RUN}`;
const T1_COLLECTOR_ID = `dpe2e-t1-${RUN}`;
const T3_COLLECTOR_ID = `dpe2e-t3-${RUN}`;
const SUPPLIER_ID = `dpe2e-sup-${RUN}`;
const SUPPLIER_NAME = `DPE2E Supplier ${RUN}`;
const MATERIAL_WITH_EVIDENCE = `DPE2E_STEEL_HRC_${RUN}`;
const MATERIAL_NO_EVIDENCE = `DPE2E_NO_EVIDENCE_${RUN}`;

// Four T1 signals on the same material so the >=3 evidence floor is
// exceeded and the verifier has more than one valid signalId to check
// against. Values are chosen to be distinct so the per-claim tolerance
// check actually distinguishes them.
const SEEDED_SIGNALS: Array<{
  id: string;
  collector: string;
  value: number;
  observedAt: Date;
  material: string;
}> = [
  { id: `sig-t1-a-${RUN}`, collector: T1_COLLECTOR_ID, value: 182.4, observedAt: new Date("2026-03-01T00:00:00Z"), material: MATERIAL_WITH_EVIDENCE },
  { id: `sig-t1-b-${RUN}`, collector: T1_COLLECTOR_ID, value: 195.7, observedAt: new Date("2026-03-15T00:00:00Z"), material: MATERIAL_WITH_EVIDENCE },
  { id: `sig-t1-c-${RUN}`, collector: T1_COLLECTOR_ID, value: 201.0, observedAt: new Date("2026-04-01T00:00:00Z"), material: MATERIAL_WITH_EVIDENCE },
  { id: `sig-t1-d-${RUN}`, collector: T1_COLLECTOR_ID, value: 210.5, observedAt: new Date("2026-04-15T00:00:00Z"), material: MATERIAL_WITH_EVIDENCE },
  // T3 row scoped to the SAME supplier as the T1 set — confirms the
  // narrative-only tier never enters the citation pool under
  // conservative policy and never backs a claim under any policy.
  { id: `sig-t3-a-${RUN}`, collector: T3_COLLECTOR_ID, value: 999.0, observedAt: new Date("2026-04-20T00:00:00Z"), material: MATERIAL_WITH_EVIDENCE },
];

// The 5 sections that must each carry >=1 verified claim (the
// `position` and `proprietary_signal_context` sections are
// narrative-only; under `conservative` policy the latter isn't even
// rendered).
const CITED_SECTIONS = [
  "market_context",
  "cost_drivers",
  "comparable_benchmarks",
  "recommended_counter_position",
  "walk_away_considerations",
] as const;

function makeCollector(id: string, tier: "T1" | "T3"): IntelligenceCollector {
  return {
    id,
    name: `Synthetic ${tier} ${id}`,
    description: "defense-pack-pipeline e2e fixture",
    posture: "public-api",
    sourceUrl: `https://example.test/${id}`,
    defaultRateLimitRpm: 60,
    defaultScheduleCron: null,
    postureClass: "public_api",
    disclosureTier: tier,
    jurisdiction: "US",
    retentionDays: 365,
    tenantOptInDefault: true,
    signalSchema: looseSignalDraftSchema,
    stableSignalKey(d) {
      return defaultStableSignalKey(id, d);
    },
    async collect() {
      return [];
    },
  };
}

interface Server {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let server: Server;

test.before(async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Register collectors in the in-process registry so `getCollector(id)`
  // returns the right tier. The route's evidence assembler reads tier
  // from this registry, NOT from the DB row.
  registerCollector(makeCollector(T1_COLLECTOR_ID, "T1"));
  registerCollector(makeCollector(T3_COLLECTOR_ID, "T3"));

  // FK-satisfying registry rows + tenant + supplier.
  await db.insert(orgsTable).values({
    id: ORG_ID,
    name: `DPE2E Org ${RUN}`,
    slug: `dpe2e-${RUN}`,
    // `conservative` policy keeps the proprietary_signal_context T3
    // paragraph out of the rendered output, so we only have to satisfy
    // the citation floor on the T1/T2-backed sections.
    settings: { disclosurePolicy: "conservative" },
  });

  await db.insert(collectorsTable).values([
    {
      id: T1_COLLECTOR_ID,
      name: `T1 ${RUN}`,
      description: "test",
      posture: "public-api",
      status: "approved",
      owner: "test",
      sourceUrl: `https://example.test/${T1_COLLECTOR_ID}`,
    },
    {
      id: T3_COLLECTOR_ID,
      name: `T3 ${RUN}`,
      description: "test",
      posture: "respect-robots-crawl",
      status: "approved",
      owner: "test",
      sourceUrl: `https://example.test/${T3_COLLECTOR_ID}`,
    },
  ]);

  await db.insert(suppliersTable).values({
    id: SUPPLIER_ID,
    orgId: ORG_ID,
    name: SUPPLIER_NAME,
    normalizedName: SUPPLIER_NAME.toLowerCase(),
  });

  await db.insert(marketSignalsTable).values(
    SEEDED_SIGNALS.map((s) => ({
      id: s.id,
      orgId: ORG_ID,
      collectorId: s.collector,
      signalType: "commodity_index" as const,
      scopeMaterialCode: s.material,
      scopeSupplierName: SUPPLIER_NAME,
      value: String(s.value),
      unit: "USD/tonne",
      currency: "USD",
      observedAt: s.observedAt,
      sourceUrl: `https://example.test/signal/${s.id}`,
      posture: "public-api" as const,
    })),
  );

  server = await startServer();
});

test.after(async () => {
  // Cleanest-possible teardown — packs first (FK to org), then signals,
  // then suppliers + collectors, then org. Wrapped so a partial setup
  // doesn't leak rows to subsequent runs.
  try {
    await db.delete(defensePacksTable).where(eq(defensePacksTable.orgId, ORG_ID));
    await db.delete(marketSignalsTable).where(
      inArray(
        marketSignalsTable.id,
        SEEDED_SIGNALS.map((s) => s.id),
      ),
    );
    await db.delete(suppliersTable).where(eq(suppliersTable.id, SUPPLIER_ID));
    await db
      .delete(collectorsTable)
      .where(inArray(collectorsTable.id, [T1_COLLECTOR_ID, T3_COLLECTOR_ID]));
    await db.delete(orgsTable).where(eq(orgsTable.id, ORG_ID));
  } finally {
    if (server) await server.close();
    await pool.end();
  }
});

interface PackResponse {
  id: string;
  status: string;
  statusReason: string | null;
  sections: DefensePackSection[];
  evidenceSnapshot: Array<{ signalId: string; tier: string }>;
  verifiedClaimCount: number;
  evidencePoolSize: number;
}

async function generatePack(
  body: Record<string, unknown>,
): Promise<{ status: number; pack: PackResponse }> {
  const res = await fetch(`${server.baseUrl}/api/defense-packs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-org-id": ORG_ID,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    pack: text ? (JSON.parse(text) as PackResponse) : ({} as PackResponse),
  };
}

/** Build a Gemini-shaped JSON body where every section's claim cites
 *  the given signal at the given quoted value. */
function buildLlmBody(claims: Array<{ section: string; signalId: string; quoted: string }>) {
  const grouped = new Map<string, Array<{ text: string; signalId: string; valueQuoted: string }>>();
  for (const k of [
    "position",
    "market_context",
    "cost_drivers",
    "comparable_benchmarks",
    "recommended_counter_position",
    "walk_away_considerations",
  ]) {
    grouped.set(k, []);
  }
  for (const c of claims) {
    grouped.get(c.section)?.push({
      text: `Claim citing ${c.signalId}`,
      signalId: c.signalId,
      valueQuoted: c.quoted,
    });
  }
  return {
    sections: Array.from(grouped.entries()).map(([key, claimList]) => ({
      key,
      narrative: `Narrative for ${key}.`,
      claims: claimList,
    })),
  };
}

test("e2e: every claim in the persisted pack cites a seeded signalId", async () => {
  responseQueue.length = 0;
  const before = geminiCallCount;
  // Build a fully valid response: each cited section gets one claim
  // citing one of the four seeded T1 signals at its real value.
  const valid = buildLlmBody([
    { section: "market_context", signalId: SEEDED_SIGNALS[0].id, quoted: "$182.40 /tonne" },
    { section: "cost_drivers", signalId: SEEDED_SIGNALS[1].id, quoted: "195.70 USD/tonne" },
    { section: "comparable_benchmarks", signalId: SEEDED_SIGNALS[2].id, quoted: "201.00 USD/tonne" },
    { section: "recommended_counter_position", signalId: SEEDED_SIGNALS[3].id, quoted: "210.50 USD/tonne" },
    { section: "walk_away_considerations", signalId: SEEDED_SIGNALS[0].id, quoted: "182.40" },
  ]);
  queueResponse(valid);

  const { status, pack } = await generatePack({
    target: {
      supplierId: SUPPLIER_ID,
      supplierName: SUPPLIER_NAME,
      materialCode: MATERIAL_WITH_EVIDENCE,
    },
    position: "defend_against_increase",
    length: "exec_one_pager",
    positionNote: "Supplier proposed 8% increase on STEEL_HRC.",
  });

  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(pack)}`);
  assert.equal(pack.status, "ready");
  assert.equal(geminiCallCount - before, 1, "should not have triggered a regeneration");

  // Build the set of seeded signalIds the route actually saw — the
  // evidence snapshot is the source of truth here, not the seed list,
  // because the route also enforces tier filtering.
  const allowedIds = new Set(pack.evidenceSnapshot.map((e) => e.signalId));
  assert.ok(allowedIds.size >= 3, "evidence pool must clear the >=3 floor");
  // No T3 row may have entered the citation snapshot under conservative.
  for (const e of pack.evidenceSnapshot) {
    assert.ok(e.tier === "T1" || e.tier === "T2", `tier ${e.tier} leaked into citation pool`);
  }

  // Every section that carries claims must cite only seeded signalIds.
  let totalClaims = 0;
  for (const section of pack.sections) {
    for (const claim of section.claims) {
      totalClaims += 1;
      assert.ok(
        allowedIds.has(claim.signalId),
        `claim cited non-snapshot signalId ${claim.signalId} in section ${section.key}`,
      );
    }
  }
  assert.equal(totalClaims, pack.verifiedClaimCount);
  assert.ok(totalClaims >= CITED_SECTIONS.length, "every cited section needs >=1 claim");
});

test("e2e: claims that invent a signalId are dropped from the persisted pack", async () => {
  responseQueue.length = 0;
  // Each cited section gets TWO claims — one valid (seeded signalId,
  // correct quoted value) and one fabricated (signalId nowhere in the
  // pool). The verifier must keep the valid one and strip the fake.
  const FAKE_ID = `sig-NOT-IN-POOL-${RUN}`;
  const mixed = buildLlmBody([
    { section: "market_context", signalId: SEEDED_SIGNALS[0].id, quoted: "$182.40" },
    { section: "market_context", signalId: FAKE_ID, quoted: "$999.99" },
    { section: "cost_drivers", signalId: SEEDED_SIGNALS[1].id, quoted: "195.70" },
    { section: "cost_drivers", signalId: FAKE_ID, quoted: "999.99" },
    { section: "comparable_benchmarks", signalId: SEEDED_SIGNALS[2].id, quoted: "201.00" },
    { section: "comparable_benchmarks", signalId: FAKE_ID, quoted: "999" },
    { section: "recommended_counter_position", signalId: SEEDED_SIGNALS[3].id, quoted: "210.50" },
    { section: "recommended_counter_position", signalId: FAKE_ID, quoted: "999" },
    { section: "walk_away_considerations", signalId: SEEDED_SIGNALS[0].id, quoted: "182.40" },
    { section: "walk_away_considerations", signalId: FAKE_ID, quoted: "999" },
  ]);
  queueResponse(mixed);

  const { status, pack } = await generatePack({
    target: {
      supplierId: SUPPLIER_ID,
      supplierName: SUPPLIER_NAME,
      materialCode: MATERIAL_WITH_EVIDENCE,
    },
    position: "defend_against_increase",
    length: "exec_one_pager",
  });

  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(pack)}`);
  assert.equal(pack.status, "ready");

  const allowedIds = new Set(pack.evidenceSnapshot.map((e) => e.signalId));
  let totalClaims = 0;
  let leakedFake = 0;
  for (const section of pack.sections) {
    for (const claim of section.claims) {
      totalClaims += 1;
      if (claim.signalId === FAKE_ID) leakedFake += 1;
      assert.ok(
        allowedIds.has(claim.signalId),
        `unverified claim ${claim.signalId} survived in section ${section.key}`,
      );
    }
  }
  assert.equal(leakedFake, 0, "fabricated signalId must not appear in any persisted claim");
  // Each cited section had exactly one valid claim; the verifier
  // should have kept all 5 and dropped the 5 fakes.
  assert.equal(totalClaims, CITED_SECTIONS.length);
});

test("e2e: zero T1/T2 evidence yields status: insufficient_evidence", async () => {
  responseQueue.length = 0;
  const before = geminiCallCount;

  // Target a material code we never seeded → assembleEvidence returns
  // an empty citation pool → generator short-circuits BEFORE calling
  // Gemini. We still queue a tripwire response so an accidental call
  // would surface as a clear failure, not a silent pass.
  responseQueue.push(() => {
    throw new Error("Gemini must not be called when there is no T1/T2 evidence");
  });

  const { status, pack } = await generatePack({
    target: {
      supplierId: SUPPLIER_ID,
      supplierName: `${SUPPLIER_NAME}-no-evidence`,
      materialCode: MATERIAL_NO_EVIDENCE,
    },
    position: "attack_for_decrease",
    length: "exec_one_pager",
  });

  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(pack)}`);
  assert.equal(pack.status, "insufficient_evidence");
  assert.ok(
    pack.statusReason && /T1\/T2/.test(pack.statusReason),
    `statusReason should explain the missing T1/T2 floor (got: ${pack.statusReason})`,
  );
  assert.equal(pack.sections.length, 0, "no sections should be persisted");
  assert.equal(pack.evidencePoolSize, 0);
  assert.equal(
    geminiCallCount - before,
    0,
    "Gemini was called even though evidence floor was not met",
  );

  // Drain the tripwire response so it doesn't affect later tests.
  responseQueue.length = 0;
});
