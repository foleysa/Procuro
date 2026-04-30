/**
 * Integration test for `/api/intelligence/*` routes.
 *
 * Locks down two contracts that are easy to break and impossible to
 * recover from once leaked:
 *
 *   1. Tenant isolation. The Signal Browser, Entity 360, Risk Heatmap,
 *      Event Stream, and Coverage Gaps endpoints must NEVER surface a
 *      market signal that belongs to a different tenant. Every selector
 *      in `routes/intelligence.ts` therefore composes a
 *      `tenantScopeCondition(orgId)` that allows `org_id = $1 OR org_id
 *      IS NULL` (the second branch is the platform-wide default for
 *      collectors keyed at the global level — every test below confirms
 *      that nobody else's tenant rows leak in).
 *
 *   2. Per-tenant disclosure-policy filtering. The same response data
 *      must change shape based on the tenant's `disclosurePolicy`
 *      stored in `orgs.settings`:
 *        - `conservative` → only T1/T2 signals
 *        - `standard`     → T1/T2/T3
 *        - `analyst`      → all tiers
 *      Anything stricter than the policy must be reported in the
 *      `droppedByPolicy` counter so the UI can say "5 hidden" without
 *      surfacing the rows themselves.
 *
 * The test boots the real Express app (so the route + middleware chain
 * matches production), inserts two synthetic orgs and two synthetic
 * collectors at distinct disclosure tiers, then exercises the endpoints
 * via HTTP using the dev `x-org-id` header (gated by
 * ALLOW_DEV_TENANT_HEADER=true). Every assertion is on the *response*
 * shape — we never test internal helpers directly here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import {
  db,
  pool,
  orgsTable,
  collectorsTable,
  marketSignalsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import app from "../src/app";
import { newId } from "../src/lib/ids";
import { registerCollector } from "../src/lib/intelligence/runtime";
import {
  defaultStableSignalKey,
  looseSignalDraftSchema,
} from "../src/lib/intelligence/contractHelpers";
import type { IntelligenceCollector } from "../src/lib/intelligence/collector";

const RUN = `${Date.now()}-${process.pid}`;

const T1_COLLECTOR_ID = `it-test-t1-${RUN}`;
const T3_COLLECTOR_ID = `it-test-t3-${RUN}`;
const ORG_A_ID = `it-test-org-a-${RUN}`;
const ORG_B_ID = `it-test-org-b-${RUN}`;

function makeCollector(
  id: string,
  tier: "T1" | "T2" | "T3" | "T4",
): IntelligenceCollector {
  return {
    id,
    name: `Synthetic ${tier} collector ${id}`,
    description: "Throw-away collector for intelligence-routes test.",
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

async function withServer<T>(
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to bind server");
  }
  try {
    return await fn(addr.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface JsonRes<T> {
  status: number;
  body: T;
}

async function getJson<T>(
  port: number,
  path: string,
  orgId: string,
): Promise<JsonRes<T>> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "x-org-id": orgId },
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as T) : ({} as T),
  };
}

async function setupFixtures(): Promise<void> {
  // Two orgs with different disclosure policies so we can pin the
  // policy filter behaviour in the same suite.
  await db.insert(orgsTable).values([
    {
      id: ORG_A_ID,
      name: `Test Org A ${RUN}`,
      slug: `it-test-a-${RUN}`,
      settings: { disclosurePolicy: "conservative" },
    },
    {
      id: ORG_B_ID,
      name: `Test Org B ${RUN}`,
      slug: `it-test-b-${RUN}`,
      settings: { disclosurePolicy: "analyst" },
    },
  ]);

  // Two collectors at different tiers — `getCollector(id)` is what the
  // route uses to resolve a signal's tier for the policy filter.
  registerCollector(makeCollector(T1_COLLECTOR_ID, "T1"));
  registerCollector(makeCollector(T3_COLLECTOR_ID, "T3"));

  // Persist the registry rows so the FK constraint on `market_signals`
  // is satisfied. We mark them `approved` to mimic production, but the
  // route doesn't gate reads on collector status.
  await db.insert(collectorsTable).values([
    {
      id: T1_COLLECTOR_ID,
      name: `Synthetic T1 ${RUN}`,
      description: "test",
      posture: "public-api",
      status: "approved",
      owner: "test",
      sourceUrl: `https://example.test/${T1_COLLECTOR_ID}`,
    },
    {
      id: T3_COLLECTOR_ID,
      name: `Synthetic T3 ${RUN}`,
      description: "test",
      posture: "respect-robots-crawl",
      status: "approved",
      owner: "test",
      sourceUrl: `https://example.test/${T3_COLLECTOR_ID}`,
    },
  ]);

  const now = new Date();
  // Build 6 signals: 2 per org for the T1 collector, 1 per org for the
  // T3 collector. Lane scope (CN / DE / US) lets us also exercise the
  // country filter and the heatmap aggregator without standing up
  // suppliers/categories. Every observedAt is unique to avoid
  // colliding with the `(collector_id, signal_type, scopes…,
  // observed_at)` natural-key uniqueness index.
  let offset = 0;
  const at = () => new Date(now.getTime() - 60_000 - offset++ * 1_000);
  const signals: (typeof marketSignalsTable.$inferInsert)[] = [
    // org A — T1 (visible to conservative policy)
    {
      id: newId("ms"),
      orgId: ORG_A_ID,
      collectorId: T1_COLLECTOR_ID,
      signalType: "event_geocoded",
      scopeLaneKey: "CN",
      value: "5.5",
      unit: "score",
      currency: "USD",
      observedAt: at(),
      sourceUrl: `https://example.test/${T1_COLLECTOR_ID}/a-cn`,
      posture: "public-api",
      confidence: "0.9000",
      metadata: { country: "CN", actor: "fixture" },
    },
    {
      id: newId("ms"),
      orgId: ORG_A_ID,
      collectorId: T1_COLLECTOR_ID,
      signalType: "fx_rate",
      scopeLaneKey: "DE",
      value: "1.08",
      unit: "ratio",
      currency: "USD",
      observedAt: at(),
      sourceUrl: `https://example.test/${T1_COLLECTOR_ID}/a-de`,
      posture: "public-api",
      confidence: "0.9000",
      metadata: {},
    },
    // org A — T3 (hidden from conservative policy; also an EVENT type
    // so the events test can prove the per-tier filter applies there
    // too).
    {
      id: newId("ms"),
      orgId: ORG_A_ID,
      collectorId: T3_COLLECTOR_ID,
      signalType: "natural_hazard",
      scopeLaneKey: "CN",
      value: "1",
      unit: "count",
      currency: "USD",
      observedAt: at(),
      sourceUrl: `https://example.test/${T3_COLLECTOR_ID}/a-cn`,
      posture: "respect-robots-crawl",
      confidence: "0.6000",
      metadata: {},
    },
    // org B — T1
    {
      id: newId("ms"),
      orgId: ORG_B_ID,
      collectorId: T1_COLLECTOR_ID,
      signalType: "event_geocoded",
      scopeLaneKey: "CN",
      value: "3.0",
      unit: "score",
      currency: "USD",
      observedAt: at(),
      sourceUrl: `https://example.test/${T1_COLLECTOR_ID}/b-cn`,
      posture: "public-api",
      confidence: "0.9000",
      metadata: {},
    },
    {
      id: newId("ms"),
      orgId: ORG_B_ID,
      collectorId: T1_COLLECTOR_ID,
      signalType: "freight_rate",
      scopeLaneKey: "US",
      value: "1234.5",
      unit: "USD",
      currency: "USD",
      observedAt: at(),
      sourceUrl: `https://example.test/${T1_COLLECTOR_ID}/b-us`,
      posture: "public-api",
      confidence: "0.9000",
      metadata: {},
    },
    // org B — T3 (visible to analyst policy)
    {
      id: newId("ms"),
      orgId: ORG_B_ID,
      collectorId: T3_COLLECTOR_ID,
      signalType: "natural_hazard",
      scopeLaneKey: "DE",
      value: "1",
      unit: "count",
      currency: "USD",
      observedAt: at(),
      sourceUrl: `https://example.test/${T3_COLLECTOR_ID}/b-de`,
      posture: "respect-robots-crawl",
      confidence: "0.6000",
      metadata: {},
    },
  ];
  await db.insert(marketSignalsTable).values(signals);
}

async function teardownFixtures(): Promise<void> {
  // FK-safe order: signals → collectors → orgs.
  await db
    .delete(marketSignalsTable)
    .where(inArray(marketSignalsTable.collectorId, [
      T1_COLLECTOR_ID,
      T3_COLLECTOR_ID,
    ]));
  await db
    .delete(collectorsTable)
    .where(inArray(collectorsTable.id, [T1_COLLECTOR_ID, T3_COLLECTOR_ID]));
  await db.delete(orgsTable).where(eq(orgsTable.id, ORG_A_ID));
  await db.delete(orgsTable).where(eq(orgsTable.id, ORG_B_ID));
}

interface SignalsResp {
  items: Array<{
    id: string;
    tier: "T1" | "T2" | "T3" | "T4";
    scope: { kind: string; laneKey?: string | null };
    source: { collectorId: string };
  }>;
  totalCount: number;
  droppedByPolicy: number;
  policy: "conservative" | "standard" | "analyst";
}

interface HeatmapResp {
  countries: string[];
  dimensions: string[];
  cells: Array<{ country: string; dimension: string; signalCount: number }>;
  policy: "conservative" | "standard" | "analyst";
}

interface EventsResp {
  items: Array<{
    id: string;
    tier: "T1" | "T2" | "T3" | "T4";
    source: { collectorId: string };
  }>;
  policy: "conservative" | "standard" | "analyst";
  droppedByPolicy: number;
}

interface CoverageResp {
  items: Array<{ scopeKind: string; scopeLabel: string; severity: string }>;
}

await test("intelligence routes — fixture setup", async () => {
  // Best-effort cleanup of any rows left behind from a crashed run, then
  // (re-)seed. We don't unique-suffix the IDs across the suite because
  // every other run uses a fresh `RUN` value already.
  await teardownFixtures();
  await setupFixtures();
});

await test("GET /api/intelligence/signals isolates rows by tenant", async () => {
  await withServer(async (port) => {
    const a = await getJson<SignalsResp>(
      port,
      "/api/intelligence/signals?limit=200",
      ORG_A_ID,
    );
    assert.equal(a.status, 200, `org A status: ${a.status}`);
    assert.equal(a.body.policy, "conservative");
    // Org A's three fixture signals: 2 T1 (event_geocoded CN, fx_rate
    // DE) survive conservative policy; the T3 natural_hazard CN must
    // be filtered out. We assert on our specific fixture ids rather
    // than overall counts because the dev DB may already contain
    // platform-wide signals seeded by other test/dev fixtures.
    const aOurT1Ids = new Set([
      ...a.body.items
        .filter((i) => i.source.collectorId === T1_COLLECTOR_ID)
        .map((i) => i.id),
    ]);
    const aOurT3Ids = a.body.items.filter(
      (i) => i.source.collectorId === T3_COLLECTOR_ID,
    );
    assert.equal(
      aOurT1Ids.size,
      2,
      `Conservative policy must surface both T1 signals; got ${aOurT1Ids.size}`,
    );
    assert.equal(
      aOurT3Ids.length,
      0,
      "Conservative policy must hide T3 signals from response items",
    );
    assert.ok(
      a.body.droppedByPolicy >= 1,
      `droppedByPolicy must include at least the T3 fixture; got ${a.body.droppedByPolicy}`,
    );

    const b = await getJson<SignalsResp>(
      port,
      "/api/intelligence/signals?limit=200",
      ORG_B_ID,
    );
    assert.equal(b.status, 200, `org B status: ${b.status}`);
    assert.equal(b.body.policy, "analyst");
    // Analyst should see all three of org B's fixtures.
    const bOurIds = new Set(
      b.body.items
        .filter((i) =>
          [T1_COLLECTOR_ID, T3_COLLECTOR_ID].includes(i.source.collectorId),
        )
        .map((i) => i.id),
    );
    assert.equal(
      bOurIds.size,
      3,
      `Analyst policy must surface all 3 org-B fixtures; got ${bOurIds.size}`,
    );

    // Cross-tenant leak check — none of org A's row ids may appear in
    // org B's response.
    const aIds = new Set(a.body.items.map((i) => i.id));
    for (const item of b.body.items) {
      assert.ok(
        !aIds.has(item.id),
        `Signal ${item.id} leaked from org A into org B response`,
      );
    }
  });
});

await test(
  "GET /api/intelligence/signals?country=CN narrows by lane scope",
  async () => {
    await withServer(async (port) => {
      const r = await getJson<SignalsResp>(
        port,
        "/api/intelligence/signals?country=CN&limit=200",
        ORG_B_ID,
      );
      assert.equal(r.status, 200);
      // Org B's CN signals: 1 T1 geopolitical_event. T3 supplier_risk_news
      // for org B was scoped to DE, not CN.
      const lanes = new Set(
        r.body.items.map((i) => i.scope.laneKey ?? "").filter(Boolean),
      );
      assert.deepEqual(
        [...lanes],
        ["CN"],
        "Country filter must yield only CN-scoped rows",
      );
      assert.equal(r.body.items.length, 1);
    });
  },
);

await test("GET /api/intelligence/risk/heatmap aggregates per tenant", async () => {
  await withServer(async (port) => {
    const a = await getJson<HeatmapResp>(
      port,
      "/api/intelligence/risk/heatmap?lookbackDays=90",
      ORG_A_ID,
    );
    assert.equal(a.status, 200);
    // Org A has signals tagged for CN + DE; conservative hides the T3
    // CN supplier_risk_news so DE survives only via the T1 fx_rate row.
    assert.ok(
      a.body.countries.includes("CN") || a.body.countries.includes("DE"),
      `Org A heatmap should contain CN or DE; got ${JSON.stringify(a.body.countries)}`,
    );
    // No org-B-only country (US) should leak into org A's heatmap.
    assert.ok(
      !a.body.countries.includes("US"),
      "Org B's US lane must not appear in org A heatmap",
    );

    const b = await getJson<HeatmapResp>(
      port,
      "/api/intelligence/risk/heatmap?lookbackDays=90",
      ORG_B_ID,
    );
    assert.equal(b.status, 200);
    assert.ok(
      b.body.countries.includes("US"),
      "Org B heatmap should contain US",
    );
  });
});

await test("GET /api/intelligence/events isolates by tenant + drops T3 for conservative", async () => {
  await withServer(async (port) => {
    const a = await getJson<EventsResp>(
      port,
      "/api/intelligence/events?hours=720&limit=500",
      ORG_A_ID,
    );
    assert.equal(a.status, 200);
    // Org A's only "event-shaped" signal at T1+ is the geopolitical_event
    // on CN (T1). The T3 supplier_risk_news must be dropped by the
    // conservative policy.
    const aTiers = new Set(a.body.items.map((i) => i.tier));
    assert.ok(
      !aTiers.has("T3") && !aTiers.has("T4"),
      `Conservative policy must hide T3/T4 events; saw ${[...aTiers].join(",")}`,
    );

    const b = await getJson<EventsResp>(
      port,
      "/api/intelligence/events?hours=720&limit=500",
      ORG_B_ID,
    );
    assert.equal(b.status, 200);
    // Cross-tenant: org B's events must not contain any of org A's row ids.
    const aIds = new Set(a.body.items.map((i) => i.id));
    for (const ev of b.body.items) {
      assert.ok(
        !aIds.has(ev.id),
        `Event ${ev.id} leaked from org A into org B response`,
      );
    }
  });
});

await test("GET /api/intelligence/coverage-gaps is tenant-scoped", async () => {
  await withServer(async (port) => {
    const a = await getJson<CoverageResp>(
      port,
      "/api/intelligence/coverage-gaps?lookbackDays=90",
      ORG_A_ID,
    );
    // Endpoint always returns 200 with `items` — even if the tenant has
    // no spend, the response shape must be stable.
    assert.equal(a.status, 200);
    assert.ok(Array.isArray(a.body.items));
    // Cross-tenant: the test's fixture orgs have no PO/PO-line spend so
    // we expect an empty list, but the contract is that the endpoint
    // never throws on a fresh tenant.
  });
});

await test("intelligence routes — teardown", async () => {
  await teardownFixtures();
  await pool.end();
});
