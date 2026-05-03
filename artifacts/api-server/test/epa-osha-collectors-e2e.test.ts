/**
 * End-to-end integration test for the EPA ECHO and DOL OSHA
 * supplier-risk collectors (Task #262).
 *
 * Parser-level tests (`epa-echo-parser.test.ts`,
 * `osha-inspections-parser.test.ts`) already pin the per-row mapping
 * and the schema/key contracts. Backfill-mode tests
 * (`supplier-risk-backfill.test.ts`) pin the run-mode cap and
 * idempotency. Neither covers the *full* `collectWithRaw` pipeline
 * with a captured upstream payload PLUS the live alert fan-out call,
 * so a regression in any of these seams would slip through:
 *
 *   - the `_us-suppliers` loader → `fetchEchoForSupplier` URL shape
 *   - the parsed JSON → `MarketSignalDraft[]` projection
 *   - the per-supplier `RawPayload` envelope (name / contentType /
 *     sourceUrl / metadata) the runtime persists alongside drafts
 *   - the `_entity-resolver` glue that stamps `entityUid` on each
 *     draft
 *   - the live fan-out: `fanOutCollectorAlerts` → tenant resolver →
 *     `createAlert` payload (source / severity / kind / title /
 *     summary / dedupeKey / sources / supplier scoping)
 *
 * Strategy mirrors the existing `supplier-risk-backfill.test.ts` and
 * `usda-nass-economic-index-fetch.test.ts` patterns:
 *   1. Mock `_us-suppliers.loadWatchedUsSuppliers` so the test owns
 *      the supplier roster.
 *   2. Mock `_entity-resolver.resolveDraftEntities` so we can assert
 *      the collector threads resolver output back onto every draft.
 *   3. Mock the `@workspace/db` boundary used by the fan-out tenant
 *      resolver to hand back a deterministic `(orgId, supplierId)`
 *      match for the watched supplier name.
 *   4. Mock `@workspace/intelligence`'s `createAlert` to capture the
 *      fan-out's emitted alert payloads, and `evaluateRulesForSignal`
 *      to a no-op (no rule overrides exercised here).
 *   5. Stub `globalThis.fetch` to replay the captured EPA / OSHA
 *      JSON fixtures, asserting the URL contract on the way through.
 *   6. Run `collectWithRaw({ since: null })` then feed the result
 *      into `fanOutCollectorAlerts` and assert drafts + rawPayloads +
 *      the captured `createAlert` calls.
 *
 * Stays hermetic — no real DB, no real upstream, no real createAlert.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const SUPPLIERS = [
  { name: "Acme Manufacturing Inc", normalizedName: "acme manufacturing inc" },
  { name: "Quiet Supplier LLC", normalizedName: "quiet supplier llc" },
];

// --- Mocks for the collector seam ----------------------------------
const resolverCalls: Array<{
  collectorId: string;
  name: string;
  country?: string;
}> = [];

mock.module("../src/lib/intelligence/collectors/_us-suppliers", {
  namedExports: {
    loadWatchedUsSuppliers: async (cap: number) =>
      SUPPLIERS.slice(0, Math.min(cap, SUPPLIERS.length)),
  },
});

mock.module("../src/lib/intelligence/collectors/_entity-resolver", {
  namedExports: {
    resolveDraftEntities: async (
      inputs: Array<{ collectorId: string; name: string; country?: string }>,
    ) => {
      for (const i of inputs) resolverCalls.push(i);
      return inputs.map(
        (i) => `ent_test_${i.name.toLowerCase().replace(/\s+/g, "_")}`,
      );
    },
  },
});

// --- Mocks for the fan-out seam ------------------------------------
//
// `fanOutCollectorAlerts` reads tenant suppliers via
//   db.select({...}).from(suppliersTable).where(eq(suppliersTable.normalizedName, needle))
// We stub the chain to return one tenant match per supplier name we
// know about (only "Acme Manufacturing Inc" maps to a real
// (orgId, supplierId)). Anything else → empty match list, exercising
// the "no tenant cares" branch on the EPA/OSHA Quiet Supplier LLC
// fixtures (which carry no drafts anyway, but the contract is pinned).
const TENANT_BY_NORMALIZED: Record<
  string,
  Array<{ orgId: string; supplierId: string }>
> = {
  "acme manufacturing inc": [
    { orgId: "org_test_acme", supplierId: "sup_test_acme" },
  ],
};

let lastWhereNormalized: string | null = null;
const fakeSuppliersTable = {
  normalizedName: "__suppliers.normalized_name__",
  orgId: "__suppliers.org_id__",
  id: "__suppliers.id__",
} as const;

const fakeDb = {
  select: () => ({
    from: () => ({
      // The where() call passes a drizzle SQL fragment; we don't
      // inspect it. Instead we capture the needle that
      // resolveTenantSuppliers normalises just before calling where(),
      // via the `eq()` shim below.
      where: async () => TENANT_BY_NORMALIZED[lastWhereNormalized ?? ""] ?? [],
    }),
  }),
};

const realDb = await import("@workspace/db");
mock.module("@workspace/db", {
  namedExports: {
    ...realDb,
    db: fakeDb,
    suppliersTable: fakeSuppliersTable,
  },
});

// `fanOutCollectorAlerts` calls `eq(suppliersTable.normalizedName, needle)`.
// We patch drizzle-orm's `eq` so we can capture the needle without
// reading drizzle's opaque SQL AST. Anything else routes through
// drizzle untouched.
const drizzleOrm = await import("drizzle-orm");
const realEq = drizzleOrm.eq;
mock.module("drizzle-orm", {
  namedExports: {
    ...drizzleOrm,
    eq: ((col: unknown, val: unknown) => {
      if (col === fakeSuppliersTable.normalizedName && typeof val === "string") {
        lastWhereNormalized = val;
      }
      return realEq(col as never, val as never);
    }) as typeof drizzleOrm.eq,
  },
});

// `createAlert` captures one call per fan-out emission.
interface CapturedAlert {
  orgId: string;
  severity: string;
  source: string;
  kind: string;
  title: string;
  summary: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  supplierId: string | null | undefined;
  entityUid: string | null | undefined;
}
const capturedAlerts: CapturedAlert[] = [];

const realIntelligence = await import("@workspace/intelligence");
mock.module("@workspace/intelligence", {
  namedExports: {
    ...realIntelligence,
    createAlert: async (args: CapturedAlert) => {
      capturedAlerts.push(args);
      return { id: `alert_${capturedAlerts.length}` };
    },
    evaluateRulesForSignal: async () => [],
  },
});

// --- Fixtures + fetch stub -----------------------------------------
const { EPA_ECHO_FIXTURE_RESPONSES } = await import(
  "./fixtures/epa-echo-responses"
);
const { OSHA_FIXTURE_RESPONSES } = await import(
  "./fixtures/osha-inspections-responses"
);

interface CapturedRequest {
  url: string;
  acceptHeader: string | null;
}
const capturedRequests: CapturedRequest[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  const acceptHeader =
    (init?.headers as Record<string, string> | undefined)?.["Accept"] ?? null;
  capturedRequests.push({ url, acceptHeader });

  if (
    url.startsWith(
      "https://echodata.epa.gov/echo/case_rest_services.get_cases",
    )
  ) {
    const u = new URL(url);
    const supplier = u.searchParams.get("p_co") ?? "";
    const fixture = EPA_ECHO_FIXTURE_RESPONSES[supplier] ?? {
      Results: { QueryRows: 0, Cases: [] },
    };
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.startsWith("https://www.osha.gov/pls/imis/establishment.json")) {
    const u = new URL(url);
    const supplier = u.searchParams.get("establishment") ?? "";
    const fixture = OSHA_FIXTURE_RESPONSES[supplier] ?? { inspections: [] };
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

test.after(() => {
  globalThis.fetch = realFetch;
});

// --- Module under test (imported AFTER all mocks are installed) ----
const { epaEchoCollector, EPA_ECHO_COLLECTOR_ID, EPA_ECHO_STATUTE_CODES } =
  await import("../src/lib/intelligence/collectors/epa-echo");
const {
  oshaInspectionsCollector,
  OSHA_COLLECTOR_ID,
  OSHA_INSPECTION_SCOPE_CODES,
} = await import("../src/lib/intelligence/collectors/osha-inspections");
const { fanOutCollectorAlerts } = await import(
  "../src/lib/alerts/collector-fanout"
);
const { CollectorFanoutDraft } = {} as {
  CollectorFanoutDraft: import("../src/lib/alerts/collector-fanout").CollectorFanoutDraft;
};
type CollectorFanoutDraft = typeof CollectorFanoutDraft;

// Minimal CollectorRow shape — fanout only reads id / name / posture.
const FAKE_EPA_COLLECTOR_ROW = {
  id: EPA_ECHO_COLLECTOR_ID,
  name: "EPA ECHO Enforcement Cases",
  posture: "public-api",
} as unknown as Parameters<typeof fanOutCollectorAlerts>[0]["collector"];

const FAKE_OSHA_COLLECTOR_ROW = {
  id: OSHA_COLLECTOR_ID,
  name: "DOL OSHA Inspections",
  posture: "public-api",
} as unknown as Parameters<typeof fanOutCollectorAlerts>[0]["collector"];

test("epa-echo: collectWithRaw → fanOutCollectorAlerts emits a high-severity environmental_violation alert per matched draft", async () => {
  capturedRequests.length = 0;
  resolverCalls.length = 0;
  capturedAlerts.length = 0;

  const result = await epaEchoCollector.collectWithRaw!({ since: null });

  // --- URL contract: one call per supplier, JSON output, p_co=name.
  const echoReqs = capturedRequests.filter((r) =>
    r.url.startsWith(
      "https://echodata.epa.gov/echo/case_rest_services.get_cases",
    ),
  );
  assert.equal(echoReqs.length, SUPPLIERS.length);
  for (const r of echoReqs) {
    const u = new URL(r.url);
    assert.equal(u.searchParams.get("output"), "JSON");
    assert.ok(u.searchParams.get("p_co"), "p_co query param must be present");
    assert.equal(r.acceptHeader, "application/json");
  }
  const queriedSuppliers = echoReqs
    .map((r) => new URL(r.url).searchParams.get("p_co"))
    .sort();
  assert.deepEqual(
    queriedSuppliers,
    SUPPLIERS.map((s) => s.name).sort(),
  );

  // --- Raw payloads: one per supplier, JSON, sourceUrl matches.
  assert.equal(result.rawPayloads.length, SUPPLIERS.length);
  for (const raw of result.rawPayloads) {
    assert.equal(raw.contentType, "application/json");
    assert.match(raw.name, /^cases-/);
    assert.ok(
      raw.sourceUrl?.startsWith(
        "https://echodata.epa.gov/echo/case_rest_services.get_cases",
      ),
    );
    assert.ok(raw.body.length > 0);
    const md = raw.metadata as Record<string, unknown>;
    assert.ok(typeof md["supplierName"] === "string");
  }

  // --- Drafts: only Acme has cases; the unusable row is dropped.
  assert.equal(result.drafts.length, 2);
  const bySku = new Map(result.drafts.map((d) => [d.scopeSku, d]));
  const cwa = bySku.get("CWA-04-2024-1234");
  assert.ok(cwa);
  assert.equal(cwa!.signalType, "environmental_violation");
  assert.equal(cwa!.value, EPA_ECHO_STATUTE_CODES["CWA"]);
  assert.equal(cwa!.scopeSupplierName, "Acme Manufacturing Inc");
  assert.equal(cwa!.scopeLaneKey, "TX");
  assert.equal(cwa!.observedAt.toISOString(), "2024-09-01T00:00:00.000Z");
  assert.equal(cwa!.unit, "epa_statute_code");
  const cwaMeta = cwa!.metadata as Record<string, unknown>;
  assert.equal(cwaMeta["statute"], "CWA");
  assert.equal(cwaMeta["federalPenaltyUsd"], 50000);

  const rcra = bySku.get("RCRA-05-2024-9999");
  assert.ok(rcra);
  assert.equal(rcra!.value, EPA_ECHO_STATUTE_CODES["RCRA"]);
  assert.equal(rcra!.observedAt.toISOString(), "2024-07-20T00:00:00.000Z");

  // --- Entity-resolver glue.
  assert.equal(resolverCalls.length, result.drafts.length);
  for (const c of resolverCalls) {
    assert.equal(c.collectorId, EPA_ECHO_COLLECTOR_ID);
    assert.equal(c.country, "US");
  }
  for (const d of result.drafts) {
    assert.equal(
      d.entityUid,
      `ent_test_${d.scopeSupplierName!.toLowerCase().replace(/\s+/g, "_")}`,
    );
  }

  // --- Live fan-out: feed drafts (typed via the runtime contract)
  // through `fanOutCollectorAlerts` and pin the captured alert shape.
  // The drafts shape is a strict superset of CollectorFanoutDraft, so
  // no casts are needed.
  const fanoutDrafts: import("../src/lib/alerts/collector-fanout").CollectorFanoutDraft[] =
    result.drafts.map((d) => ({
      signalType: d.signalType,
      scopeSupplierName: d.scopeSupplierName ?? null,
      entityUid: d.entityUid ?? null,
      observedAt: d.observedAt,
      sourceUrl: d.sourceUrl,
      metadata: d.metadata ?? null,
      value: d.value,
      unit: d.unit,
      marketSignalId: `sig_test_${d.scopeSku}`,
    }));

  const counts = await fanOutCollectorAlerts({
    collector: FAKE_EPA_COLLECTOR_ROW,
    drafts: fanoutDrafts,
  });
  assert.equal(counts.draftsConsidered, 2);
  assert.equal(counts.alertsCreated, 2);
  assert.equal(capturedAlerts.length, 2);

  for (const alert of capturedAlerts) {
    assert.equal(alert.orgId, "org_test_acme");
    assert.equal(alert.supplierId, "sup_test_acme");
    assert.equal(alert.source, "risk_screening");
    assert.equal(alert.severity, "high");
    assert.equal(alert.kind, "environmental_violation");
    assert.match(alert.title, /Acme Manufacturing/);
    assert.match(alert.title, /EPA enforcement/);
    assert.match(alert.summary, /Environmental enforcement case/);
    // dedupeKey carries collector id + observedAt for natural-key
    // collapse on re-runs.
    assert.match(alert.dedupeKey, /^coll:epa-echo:environmental_violation:/);
    assert.equal(
      alert.payload["collectorId"],
      EPA_ECHO_COLLECTOR_ID,
      "payload must carry collectorId",
    );
    assert.equal(alert.payload["signalType"], "environmental_violation");
    assert.ok(
      typeof alert.payload["marketSignalId"] === "string",
      "war-room cross-link id must be stamped on the payload",
    );
    const sources = alert.payload["sources"] as Array<Record<string, unknown>>;
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!["kind"], "collector");
    assert.equal(sources[0]!["collectorId"], EPA_ECHO_COLLECTOR_ID);
  }
});

test("osha-inspections: collectWithRaw → fanOutCollectorAlerts emits a medium-severity workplace_safety_incident alert per matched draft", async () => {
  capturedRequests.length = 0;
  resolverCalls.length = 0;
  capturedAlerts.length = 0;

  const result = await oshaInspectionsCollector.collectWithRaw!({
    since: null,
  });

  // --- URL contract.
  const oshaReqs = capturedRequests.filter((r) =>
    r.url.startsWith("https://www.osha.gov/pls/imis/establishment.json"),
  );
  assert.equal(oshaReqs.length, SUPPLIERS.length);
  for (const r of oshaReqs) {
    const u = new URL(r.url);
    assert.ok(
      u.searchParams.get("establishment"),
      "establishment query param must be present",
    );
    assert.equal(r.acceptHeader, "application/json");
  }
  const queriedSuppliers = oshaReqs
    .map((r) => new URL(r.url).searchParams.get("establishment"))
    .sort();
  assert.deepEqual(
    queriedSuppliers,
    SUPPLIERS.map((s) => s.name).sort(),
  );

  // --- Raw payloads.
  assert.equal(result.rawPayloads.length, SUPPLIERS.length);
  for (const raw of result.rawPayloads) {
    assert.equal(raw.contentType, "application/json");
    assert.match(raw.name, /^inspections-/);
    assert.ok(
      raw.sourceUrl?.startsWith(
        "https://www.osha.gov/pls/imis/establishment.json",
      ),
    );
    assert.ok(raw.body.length > 0);
  }

  // --- Drafts.
  assert.equal(result.drafts.length, 2);
  const bySku = new Map(result.drafts.map((d) => [d.scopeSku, d]));
  const partial = bySku.get("1234567.015");
  assert.ok(partial);
  assert.equal(partial!.signalType, "workplace_safety_incident");
  assert.equal(partial!.value, OSHA_INSPECTION_SCOPE_CODES["Partial"]);
  assert.equal(partial!.scopeLaneKey, "TX");
  assert.equal(partial!.observedAt.toISOString(), "2024-08-15T00:00:00.000Z");
  assert.equal(partial!.unit, "osha_scope_code");
  const partialMeta = partial!.metadata as Record<string, unknown>;
  assert.equal(partialMeta["totalViolations"], 5);
  assert.equal(partialMeta["totalPenaltyUsd"], 35000);
  const violations = partialMeta["violations"] as Array<
    Record<string, unknown>
  >;
  assert.equal(violations.length, 2);
  assert.equal(violations[0]!["citationId"], "01001A");
  assert.equal(violations[0]!["initialPenaltyUsd"], 14502);

  const accident = bySku.get("9999999.001");
  assert.ok(accident);
  assert.equal(accident!.value, OSHA_INSPECTION_SCOPE_CODES["Accident"]);
  assert.equal(accident!.scopeLaneKey, "OH");

  // --- Entity-resolver glue.
  assert.equal(resolverCalls.length, result.drafts.length);
  for (const c of resolverCalls) {
    assert.equal(c.collectorId, OSHA_COLLECTOR_ID);
    assert.equal(c.country, "US");
  }

  // --- Live fan-out.
  const fanoutDrafts: import("../src/lib/alerts/collector-fanout").CollectorFanoutDraft[] =
    result.drafts.map((d) => ({
      signalType: d.signalType,
      scopeSupplierName: d.scopeSupplierName ?? null,
      entityUid: d.entityUid ?? null,
      observedAt: d.observedAt,
      sourceUrl: d.sourceUrl,
      metadata: d.metadata ?? null,
      value: d.value,
      unit: d.unit,
      marketSignalId: `sig_test_${d.scopeSku}`,
    }));

  const counts = await fanOutCollectorAlerts({
    collector: FAKE_OSHA_COLLECTOR_ROW,
    drafts: fanoutDrafts,
  });
  assert.equal(counts.draftsConsidered, 2);
  assert.equal(counts.alertsCreated, 2);
  assert.equal(capturedAlerts.length, 2);

  for (const alert of capturedAlerts) {
    assert.equal(alert.orgId, "org_test_acme");
    assert.equal(alert.supplierId, "sup_test_acme");
    assert.equal(alert.source, "risk_screening");
    assert.equal(alert.severity, "medium");
    assert.equal(alert.kind, "workplace_safety_incident");
    assert.match(alert.title, /Acme Manufacturing/);
    assert.match(alert.title, /OSHA inspection/);
    assert.match(alert.summary, /Workplace-safety inspection/);
    assert.match(
      alert.dedupeKey,
      /^coll:osha-inspections:workplace_safety_incident:/,
    );
    assert.equal(alert.payload["collectorId"], OSHA_COLLECTOR_ID);
    assert.equal(alert.payload["signalType"], "workplace_safety_incident");
    assert.ok(typeof alert.payload["marketSignalId"] === "string");
    const sources = alert.payload["sources"] as Array<Record<string, unknown>>;
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!["collectorId"], OSHA_COLLECTOR_ID);
  }
});
