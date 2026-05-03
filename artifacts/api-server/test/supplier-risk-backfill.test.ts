/**
 * Supplier-risk collector backfill guardrails.
 *
 * Pins (Task #246):
 *   - `mode: "backfill"` lifts the per-tick supplier cap so an
 *     admin-triggered replay can cover *every* watched US supplier,
 *     not just the first 50 the recurring tick was bounded by.
 *   - `mode: "latest"` keeps the per-tick cap (default behaviour).
 *   - Re-running the same `collectWithRaw({ mode: "backfill" })` yields
 *     stable signal keys for every draft — the natural-key dedupe in
 *     `runtime.insertSignalsIdempotent` will treat the second pass as a
 *     no-op.
 *
 * Mocks the `_us-suppliers` loader and global `fetch` so the test stays
 * hermetic and never hits EPA / OSHA upstream services.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

interface Captured {
  caps: number[];
}
const captured: Captured = { caps: [] };

const SUPPLIERS = Array.from({ length: 75 }, (_, i) => ({
  name: `Supplier ${i}`,
  normalizedName: `supplier ${i}`,
}));

mock.module(
  "../src/lib/intelligence/collectors/_us-suppliers",
  {
    namedExports: {
      loadWatchedUsSuppliers: async (cap: number) => {
        captured.caps.push(cap);
        return SUPPLIERS.slice(0, Math.min(cap, SUPPLIERS.length));
      },
    },
  },
);

mock.module(
  "../src/lib/intelligence/collectors/_entity-resolver",
  {
    namedExports: {
      resolveDraftEntities: async (xs: unknown[]) => xs.map(() => null),
    },
  },
);

const ECHO_RESPONSE = JSON.stringify({
  Results: {
    QueryRows: 1,
    Cases: [
      {
        case_number: "CWA-04-2024-1",
        case_name: "USA v. Acme",
        case_law_section_code: "CWA",
        settlement_date: "2024-08-15",
        facility_state: "TX",
      },
    ],
  },
});

const OSHA_RESPONSE = JSON.stringify({
  inspections: [
    {
      activity_nr: "100.001",
      estab_name: "Acme",
      open_date: "2024-08-15",
      site_state: "TX",
      scope_label: "Partial",
      total_violations: 3,
      total_penalty: 12000,
      violations: [],
    },
  ],
});

let fetchPath: "echo" | "osha" = "echo";
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = String(input);
  const body =
    url.includes("echodata.epa.gov") || fetchPath === "echo"
      ? ECHO_RESPONSE
      : OSHA_RESPONSE;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

test.after(() => {
  globalThis.fetch = origFetch;
});

const { epaEchoCollector, EPA_ECHO_MAX_SUPPLIERS_PER_RUN } = await import(
  "../src/lib/intelligence/collectors/epa-echo"
);
const { oshaInspectionsCollector, OSHA_MAX_SUPPLIERS_PER_RUN } = await import(
  "../src/lib/intelligence/collectors/osha-inspections"
);

test("epa-echo: latest mode caps suppliers; backfill mode lifts the cap", async () => {
  captured.caps.length = 0;
  await epaEchoCollector.collectWithRaw!({ since: null });
  assert.equal(captured.caps.at(-1), EPA_ECHO_MAX_SUPPLIERS_PER_RUN);

  await epaEchoCollector.collectWithRaw!({ since: null, mode: "backfill" });
  const backfillCap = captured.caps.at(-1)!;
  assert.ok(
    backfillCap > EPA_ECHO_MAX_SUPPLIERS_PER_RUN,
    `expected backfill cap > ${EPA_ECHO_MAX_SUPPLIERS_PER_RUN}, got ${backfillCap}`,
  );
});

test("osha-inspections: latest mode caps suppliers; backfill mode lifts the cap", async () => {
  fetchPath = "osha";
  captured.caps.length = 0;
  await oshaInspectionsCollector.collectWithRaw!({ since: null });
  assert.equal(captured.caps.at(-1), OSHA_MAX_SUPPLIERS_PER_RUN);

  await oshaInspectionsCollector.collectWithRaw!({
    since: null,
    mode: "backfill",
  });
  const backfillCap = captured.caps.at(-1)!;
  assert.ok(
    backfillCap > OSHA_MAX_SUPPLIERS_PER_RUN,
    `expected backfill cap > ${OSHA_MAX_SUPPLIERS_PER_RUN}, got ${backfillCap}`,
  );
});

test("epa-echo: backfill rerun produces identical stable signal keys (idempotent)", async () => {
  fetchPath = "echo";
  const a = await epaEchoCollector.collectWithRaw!({
    since: null,
    mode: "backfill",
  });
  const b = await epaEchoCollector.collectWithRaw!({
    since: null,
    mode: "backfill",
  });
  assert.equal(a.drafts.length, b.drafts.length);
  assert.ok(a.drafts.length > 0, "expected at least one draft");
  const ka = a.drafts.map(epaEchoCollector.stableSignalKey).sort();
  const kb = b.drafts.map(epaEchoCollector.stableSignalKey).sort();
  assert.deepEqual(ka, kb);
});

test("osha-inspections: backfill rerun produces identical stable signal keys (idempotent)", async () => {
  fetchPath = "osha";
  const a = await oshaInspectionsCollector.collectWithRaw!({
    since: null,
    mode: "backfill",
  });
  const b = await oshaInspectionsCollector.collectWithRaw!({
    since: null,
    mode: "backfill",
  });
  assert.equal(a.drafts.length, b.drafts.length);
  assert.ok(a.drafts.length > 0, "expected at least one draft");
  const ka = a.drafts.map(oshaInspectionsCollector.stableSignalKey).sort();
  const kb = b.drafts.map(oshaInspectionsCollector.stableSignalKey).sort();
  assert.deepEqual(ka, kb);
});
