/**
 * End-to-end contract test for SAM.gov exclusions → critical alert.
 *
 * The SAM.gov collector emits exclusion hits as `sanctions_match`
 * MarketSignal drafts (with reserved list code 5 = SAM.gov exclusion)
 * specifically so they inherit the existing alert fan-out path that
 * fires a critical-severity tenant alert per matching watched supplier
 * — the same path OFAC / EU / UK / UN sanctions hits ride. This test
 * pins that contract end-to-end without requiring a live database:
 *
 *  1. Drive the deterministic `exclusionToDraft` builder with a parsed
 *     SAM exclusion record.
 *  2. Look the resulting `signalType` up in the exported
 *     `FANOUT_BY_SIGNAL_TYPE` spec from `collector-fanout.ts` and
 *     assert the routed alert source / severity / kind are exactly
 *     what the alerts inbox expects for a critical sanctions match.
 */
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const { exclusionToDraft, entityToDraft, SAM_UNKNOWN_DATE_SENTINEL } =
  await import("../src/lib/intelligence/collectors/sam-gov");
const { FANOUT_BY_SIGNAL_TYPE } = await import(
  "../src/lib/alerts/collector-fanout"
);

const SAMPLE_EXCLUSION = {
  legalBusinessName: "BAD ACTOR INC",
  classification: "Firm" as string | null,
  exclusionType: "Reciprocal" as string | null,
  excludingAgencyCode: "DOD" as string | null,
  exclusionProgram: "Procurement" as string | null,
  activationDate: new Date("2025-11-04T00:00:00.000Z") as Date | null,
  terminationDate: null as Date | null,
  exclusionId: "rec-12345",
  countryCode: "USA" as string | null,
  ueiSAM: "PPPP9999QQQQ" as string | null,
};

test("SAM exclusion drafts route through the critical sanctions fan-out spec", () => {
  const draft = exclusionToDraft(SAMPLE_EXCLUSION, null);
  assert.equal(draft.signalType, "sanctions_match");
  assert.equal(draft.value, 5, "list code 5 = SAM.gov exclusion");

  const spec = FANOUT_BY_SIGNAL_TYPE[draft.signalType];
  assert.ok(spec, "sanctions_match must have a fan-out spec");
  // The critical contract: a SAM exclusion fan-outs as a sanctions
  // alert at critical severity, identical to OFAC / EU / UK / UN hits.
  assert.equal(spec.source, "sanctions");
  assert.equal(spec.severity, "critical");
  assert.equal(spec.kind, "sanctions_match");

  const title = spec.buildTitle({
    scopeSupplierName: draft.scopeSupplierName ?? null,
    sourceUrl: draft.sourceUrl,
    observedAt: draft.observedAt,
  } as never);
  assert.match(title, /BAD ACTOR INC/);
});

test("SAM drafts use the stable date sentinel when SAM payload omits the date (idempotency)", () => {
  // Re-run idempotency contract: the natural-key dedupe index includes
  // observed_at, so wall-clock fallback would land duplicate rows on
  // every run. The collector pins a stable sentinel instead.
  const exclusionNoDate = { ...SAMPLE_EXCLUSION, activationDate: null };
  const d1 = exclusionToDraft(exclusionNoDate, null);
  const d2 = exclusionToDraft(exclusionNoDate, null);
  assert.equal(
    d1.observedAt.toISOString(),
    SAM_UNKNOWN_DATE_SENTINEL.toISOString(),
  );
  assert.equal(
    d1.observedAt.toISOString(),
    d2.observedAt.toISOString(),
    "two builds of the same record must produce identical observedAt",
  );

  const entityNoDate = {
    ueiSAM: "ABCD1234EFGH",
    legalBusinessName: "ACME",
    registrationStatus: "Active",
    registrationDate: null,
    expirationDate: null,
    countryCode: "USA",
  };
  const e1 = entityToDraft(entityNoDate, null);
  const e2 = entityToDraft(entityNoDate, null);
  assert.equal(
    e1.observedAt.toISOString(),
    SAM_UNKNOWN_DATE_SENTINEL.toISOString(),
  );
  assert.equal(e1.observedAt.toISOString(), e2.observedAt.toISOString());
});
