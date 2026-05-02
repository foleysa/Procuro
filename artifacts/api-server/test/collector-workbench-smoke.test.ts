/**
 * Smoke tests for the Collector Workbench surface added in task #79.
 *
 * Two layers of coverage:
 *
 *  1. Pure helpers (`buildLineageGraph`, `computeHealthScore`,
 *     `resolvePostureClass`) are exercised against the real in-memory
 *     collector registry. These are the math/structure that the
 *     `/collectors/workbench/{lineage,source-health,catalog}` routes
 *     return — by pinning the helpers we cover the bulk of the route
 *     bodies without standing up a database.
 *
 *  2. The `collectors` Express router is introspected to confirm the
 *     eight workbench paths are mounted with the expected HTTP methods.
 *     This catches refactor regressions that drop or rename a route
 *     without anything else noticing — the generated OpenAPI hooks
 *     would silently 404 in the UI.
 *
 * No real database is required: the helpers walk the in-memory registry,
 * and the router introspection only inspects `router.stack[].route`.
 * A placeholder `DATABASE_URL` keeps the `@workspace/db` import-time
 * guard happy.
 */

import test from "node:test";
import assert from "node:assert/strict";

if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const {
  buildLineageGraph,
  classifyDataSourceVisibility,
  computeHealthScore,
  resolvePostureClass,
} = await import("../src/lib/intelligence/workbench-helpers");
const { listRegisteredCollectorIds, getCollector, registerCollector } =
  await import("../src/lib/intelligence/runtime");

// The runtime registry is populated at server boot in `src/index.ts` by
// importing each collector module and calling `registerCollector`. The
// test does not boot that file (it would also start an HTTP listener),
// so do the same registration here against the same singleton.
const { publishedCommodityIndexCollector } = await import(
  "../src/lib/intelligence/collectors/published-commodity-index"
);
const { ecbFxRatesCollector } = await import(
  "../src/lib/intelligence/collectors/ecb-fx-rates"
);
const { fredEconomicIndexCollector } = await import(
  "../src/lib/intelligence/collectors/fred-economic-index"
);
const { eiaEnergyCollector } = await import(
  "../src/lib/intelligence/collectors/eia-energy"
);
const { worldBankPinkSheetCollector } = await import(
  "../src/lib/intelligence/collectors/world-bank-pink-sheet"
);
const { blsEconomicIndexCollector } = await import(
  "../src/lib/intelligence/collectors/bls-economic-index"
);
for (const c of [
  publishedCommodityIndexCollector,
  ecbFxRatesCollector,
  fredEconomicIndexCollector,
  eiaEnergyCollector,
  worldBankPinkSheetCollector,
  blsEconomicIndexCollector,
]) {
  registerCollector(c);
}

// ---------------------------------------------------------------------------
// Helper-layer smoke tests
// ---------------------------------------------------------------------------

test("buildLineageGraph includes every registered collector with a posture class and tier", () => {
  const graph = buildLineageGraph();
  const registeredIds = listRegisteredCollectorIds();
  assert.ok(
    registeredIds.length > 0,
    "expected at least one registered collector",
  );
  // Every registered collector must show up in the lineage graph;
  // otherwise the Lineage tab silently drops sources.
  for (const id of registeredIds) {
    const node = graph.collectors.find((c) => c.id === id);
    assert.ok(node, `lineage graph missing collector ${id}`);
    assert.ok(
      ["public_api", "tos_restricted", "gray_hat"].includes(node.postureClass),
      `collector ${id} has invalid postureClass ${node.postureClass}`,
    );
    assert.ok(
      ["T1", "T2", "T3", "T4"].includes(node.disclosureTier),
      `collector ${id} has invalid disclosureTier ${node.disclosureTier}`,
    );
  }
});

test("buildLineageGraph emits collector→table, table→mart, mart→consumer edges", () => {
  const graph = buildLineageGraph();
  const kinds = new Set(graph.edges.map((e) => e.kind));
  assert.ok(
    kinds.has("collector_to_table"),
    "expected at least one collector_to_table edge",
  );
  // The remaining two kinds depend on workbench-meta declaring marts
  // and consumers — at least one collector must declare both for the
  // workbench UI to be useful.
  assert.ok(
    kinds.has("table_to_mart"),
    "expected at least one table_to_mart edge",
  );
  assert.ok(
    kinds.has("mart_to_consumer"),
    "expected at least one mart_to_consumer edge",
  );

  // Edge dedupe sanity: every edge key (kind+from+to) should appear once.
  const keys = graph.edges.map((e) => `${e.kind}::${e.from}->${e.to}`);
  assert.equal(
    new Set(keys).size,
    keys.length,
    "lineage graph has duplicate edges",
  );
});

test("computeHealthScore returns 100 when there is no traffic", () => {
  assert.equal(
    computeHealthScore({ runs: 0, failures: 0, fetchErrors: 0 }),
    100,
  );
});

test("computeHealthScore drops linearly with the failure ratio", () => {
  // 10 runs, 5 failures, 0 fetch errors → 50.
  assert.equal(
    computeHealthScore({ runs: 10, failures: 5, fetchErrors: 0 }),
    50,
  );
  // 4 runs, 0 failures, 1 fetch error → 1 bad / 5 total = 80.
  assert.equal(
    computeHealthScore({ runs: 4, failures: 0, fetchErrors: 1 }),
    80,
  );
  // All bad → 0.
  assert.equal(
    computeHealthScore({ runs: 0, failures: 0, fetchErrors: 3 }),
    0,
  );
});

test("resolvePostureClass prefers contract field over legacy posture map", () => {
  // Synthetic "collector" — the helper only reads two fields so the
  // narrow Pick<> in its signature lets us pass a plain object.
  const explicit = resolvePostureClass({
    postureClass: "gray_hat",
    posture: "public-api",
  });
  assert.equal(explicit, "gray_hat");

  // Cast: the helper accepts `undefined` at runtime (legacy fallback
  // path), but the `Pick<>` shape narrows to `PostureClass`. The cast
  // exercises the documented runtime behaviour without loosening the
  // production signature.
  const fallback = resolvePostureClass({
    postureClass: undefined as unknown as "public_api",
    posture: "public-api",
  });
  assert.equal(fallback, "public_api");
});

test("every registered collector resolves to one of the three posture classes", () => {
  for (const id of listRegisteredCollectorIds()) {
    const c = getCollector(id);
    assert.ok(c, `collector ${id} is registered but not retrievable`);
    const cls = resolvePostureClass(c);
    assert.ok(
      ["public_api", "tos_restricted", "gray_hat"].includes(cls),
      `collector ${id} resolves to invalid postureClass ${cls}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Router-presence smoke test — every workbench path must be mounted.
//
// We cannot easily issue real HTTP calls because the workbench routes
// are wrapped in `tenantMiddleware`, which requires a live database to
// resolve `req.orgId`. Introspecting `router.stack` checks the route
// table directly, which is enough to catch a future refactor that
// drops a path or accidentally changes its HTTP verb.
// ---------------------------------------------------------------------------

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ name?: string; handle?: { name?: string } }>;
  };
}
interface RouterWithStack {
  stack: RouteLayer[];
}

const collectorsRouter = (
  await import("../src/routes/collectors")
).default as unknown as RouterWithStack;

function findRoute(method: string, path: string): RouteLayer | undefined {
  return collectorsRouter.stack.find(
    (l) =>
      l.route?.path === path && l.route?.methods[method.toLowerCase()] === true,
  );
}

function middlewareNamesOn(layer: RouteLayer | undefined): string[] {
  if (!layer?.route) return [];
  return layer.route.stack
    .map((s) => s.name ?? s.handle?.name ?? "")
    .filter((n) => n.length > 0);
}

test("collectors router mounts all eight workbench paths", () => {
  // Posture: both read and write
  assert.ok(
    findRoute("get", "/collectors/:id/posture"),
    "GET /collectors/:id/posture is missing",
  );
  assert.ok(
    findRoute("patch", "/collectors/:id/posture"),
    "PATCH /collectors/:id/posture is missing",
  );
  // Read-only workbench tabs
  for (const tab of [
    "catalog",
    "source-health",
    "lineage",
    "coverage",
    "cost",
    "runs",
  ]) {
    assert.ok(
      findRoute("get", `/collectors/workbench/${tab}`),
      `GET /collectors/workbench/${tab} is missing`,
    );
  }
  // Client-facing surface
  assert.ok(findRoute("get", "/data-sources"), "GET /data-sources is missing");
});

test("GET /collectors/:id/posture is tenant-scoped only — analysts must read", () => {
  const layer = findRoute("get", "/collectors/:id/posture");
  const names = middlewareNamesOn(layer);
  assert.ok(
    names.includes("tenantMiddleware"),
    `GET posture must resolve req.orgId via tenantMiddleware (got ${JSON.stringify(names)})`,
  );
  assert.ok(
    !names.includes("requirePlatformAdmin"),
    `GET posture must NOT require platform admin (got ${JSON.stringify(names)})`,
  );
});

// ---------------------------------------------------------------------------
// Authorization smoke tests — operator endpoints are admin-gated, the
// client-facing /data-sources surface is not (it only needs a valid
// tenant). Drift either way is a security regression.
// ---------------------------------------------------------------------------

test("workbench READ routes are tenant-scoped only — analysts must be able to read", () => {
  const routes = [
    "/collectors/workbench/catalog",
    "/collectors/workbench/source-health",
    "/collectors/workbench/lineage",
    "/collectors/workbench/coverage",
    "/collectors/workbench/cost",
    "/collectors/workbench/cost/timeseries",
    "/collectors/workbench/runs",
  ];
  for (const path of routes) {
    const layer = findRoute("get", path);
    const names = middlewareNamesOn(layer);
    assert.ok(
      names.includes("tenantMiddleware"),
      `${path} is missing tenantMiddleware (got ${JSON.stringify(names)})`,
    );
    // The codebase has no separate "analyst" role — any authenticated
    // tenant member is treated as analyst-level for read access. Adding
    // requirePlatformAdmin to read endpoints would lock out analysts,
    // which is a regression we want CI to catch.
    assert.ok(
      !names.includes("requirePlatformAdmin"),
      `${path} must NOT require platform admin — analysts must be able to read (got ${JSON.stringify(names)})`,
    );
  }
});

test("PATCH /collectors/:id/posture is admin-gated (mutation, not read)", () => {
  const layer = findRoute("patch", "/collectors/:id/posture");
  const names = middlewareNamesOn(layer);
  assert.ok(
    names.includes("requirePlatformAdmin"),
    `PATCH posture must be admin-gated (got ${JSON.stringify(names)})`,
  );
  assert.ok(
    names.includes("tenantMiddleware"),
    `PATCH posture must resolve req.orgId via tenantMiddleware first (got ${JSON.stringify(names)})`,
  );
});

test("GET /data-sources stays under tenantMiddleware only — admin gate would block clients", () => {
  const layer = findRoute("get", "/data-sources");
  const names = middlewareNamesOn(layer);
  assert.ok(
    names.includes("tenantMiddleware"),
    `/data-sources must be tenant-resolved (got ${JSON.stringify(names)})`,
  );
  assert.ok(
    !names.includes("requirePlatformAdmin"),
    `/data-sources must NOT require platform admin — clients use this view (got ${JSON.stringify(names)})`,
  );
});

// ---------------------------------------------------------------------------
// Workbench-meta sanity — the tier-disclosure policy on /data-sources
// hinges on every collector declaring a disclosureTier. If a future
// collector ships without one, the policy default ("T1") would silently
// surface what should have been gated. Pin it.
// ---------------------------------------------------------------------------

test("coverage handler scopes marketSignalsTable queries to req.orgId — no cross-tenant leakage", async () => {
  // Structural / source-code pin. A live integration test against the
  // database isn't viable in the smoke suite, so we read the route
  // source and assert the tenant-scope predicate is wired into both
  // signal queries inside the coverage handler. If a future refactor
  // drops the filter, this fails CI before it can leak data across
  // tenants. Pair with the documented SQL pattern in collectors.ts.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const here = new URL(".", import.meta.url).pathname;
  const src = fs.readFileSync(
    path.resolve(here, "../src/routes/collectors.ts"),
    "utf8",
  );
  // Find just the coverage handler body so we don't accidentally pass
  // because some *other* route filters on orgId.
  const start = src.indexOf('"/collectors/workbench/coverage"');
  assert.ok(start >= 0, "coverage route block not found");
  const end = src.indexOf("router.get(", start + 1);
  const block = src.slice(start, end > 0 ? end : src.length);
  assert.match(
    block,
    /eq\(\s*marketSignalsTable\.orgId\s*,\s*req\.orgId/,
    "coverage handler must filter marketSignalsTable.orgId against req.orgId",
  );
  assert.match(
    block,
    /isNull\(\s*marketSignalsTable\.orgId\s*\)/,
    "coverage handler must also include global signals (orgId IS NULL)",
  );
});

test("classifyDataSourceVisibility enforces the T1+T2 / T3-summary / T4-hidden contract", () => {
  // Named in /data-sources
  assert.equal(classifyDataSourceVisibility("T1"), "named");
  assert.equal(classifyDataSourceVisibility("T2"), "named");
  // Bucketed into the summary line — never named individually
  assert.equal(classifyDataSourceVisibility("T3"), "summarised");
  // Never disclosed under any circumstance
  assert.equal(classifyDataSourceVisibility("T4"), "hidden");
});

test("every registered collector declares an explicit disclosureTier", () => {
  for (const id of listRegisteredCollectorIds()) {
    const c = getCollector(id);
    assert.ok(c, `${id} is registered but not retrievable`);
    assert.ok(
      c.disclosureTier,
      `${id} is missing disclosureTier — /data-sources tier policy depends on this`,
    );
    assert.ok(
      ["T1", "T2", "T3", "T4"].includes(c.disclosureTier),
      `${id} has invalid disclosureTier ${c.disclosureTier}`,
    );
  }
});
