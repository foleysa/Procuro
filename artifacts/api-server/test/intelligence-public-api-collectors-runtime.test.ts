/**
 * End-to-end runtime contract test for the 8 high-ROI public-API
 * collectors added in Task #78:
 *
 *   - sec-edgar
 *   - gleif-lei
 *   - companies-house
 *   - opensanctions
 *   - government-sanctions
 *   - climate-trace
 *   - gdelt-events
 *   - natural-hazards
 *
 * What this test pins down (one parameterised pass per collector):
 *   1. Drafts produced by the collector parser land in
 *      `market_signals` through `runCollector` (no upstream HTTP — we
 *      stub `collect()` with fixture drafts that match each collector's
 *      schema).
 *   2. A second `runCollector` against identical drafts is a no-op:
 *      the natural-key index + ON CONFLICT DO NOTHING dedupes.
 *   3. Drafts that carry a non-null `entityUid` materialise it in
 *      `metadata.entityUid` on the persisted row, so downstream
 *      cross-source joins keep working without the BQ entity table.
 *   4. The `collector_audit_log.fetch_succeeded` row's
 *      `metadata.inserted` / `metadata.duplicates` numbers track
 *      reality.
 *
 * Why one test, parameterised, instead of 8 separate tests: the wiring
 * (register + approve + run + audit) is identical for every collector;
 * the only thing that varies is the schema-compatible draft fixture.
 *
 * Prereqs:
 *   - DATABASE_URL set, schema pushed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  marketSignalsTable,
  collectorAuditLogTable,
} from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";

import {
  registerCollector,
  runCollector,
  upsertCollectorRegistration,
  approveCollector,
  disableCollector,
} from "../src/lib/intelligence/runtime";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../src/lib/intelligence/collector";

import { secEdgarCollector } from "../src/lib/intelligence/collectors/sec-edgar";
import { gleifLeiCollector } from "../src/lib/intelligence/collectors/gleif-lei";
import { companiesHouseCollector } from "../src/lib/intelligence/collectors/companies-house";
import { opensanctionsCollector } from "../src/lib/intelligence/collectors/opensanctions";
import { governmentSanctionsCollector } from "../src/lib/intelligence/collectors/government-sanctions";
import { climateTraceCollector } from "../src/lib/intelligence/collectors/climate-trace";
import { gdeltEventsCollector } from "../src/lib/intelligence/collectors/gdelt-events";
import { naturalHazardsCollector } from "../src/lib/intelligence/collectors/natural-hazards";

interface CollectorCase {
  /** Real collector id — must match the registered collector. */
  id: string;
  /** The real collector module (we only override `collect`/`collectWithRaw`). */
  base: IntelligenceCollector;
  /** Two draft fixtures that will pass the collector's signal schema. */
  drafts: MarketSignalDraft[];
}

/** Stable observed_at — keeps re-runs reproducible. */
const TS_A = new Date("2026-04-01T00:00:00Z");
const TS_B = new Date("2026-04-02T00:00:00Z");

const CASES: CollectorCase[] = [
  {
    id: secEdgarCollector.id,
    base: secEdgarCollector,
    drafts: [
      {
        signalType: "corporate_filing",
        scopeSupplierName: "TEST CO INC",
        scopeSku: "0001234567-26-000001",
        scopeLaneKey: "8-K",
        value: 1,
        unit: "filing",
        currency: "USD",
        observedAt: TS_A,
        sourceUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001234567",
        confidence: 0.95,
        entityUid: "ent_cik_1234567",
        metadata: {
          cik: "0001234567",
          accessionNumber: "0001234567-26-000001",
          form: "8-K",
          filingDate: "2026-04-01",
        },
      },
      {
        signalType: "corporate_filing",
        scopeSupplierName: "TEST CO INC",
        scopeSku: "0001234567-26-000002",
        scopeLaneKey: "10-Q",
        value: 1,
        unit: "filing",
        currency: "USD",
        observedAt: TS_B,
        sourceUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001234567",
        confidence: 0.95,
        entityUid: "ent_cik_1234567",
        metadata: {
          cik: "0001234567",
          accessionNumber: "0001234567-26-000002",
          form: "10-Q",
          filingDate: "2026-04-02",
        },
      },
    ],
  },
  {
    id: gleifLeiCollector.id,
    base: gleifLeiCollector,
    drafts: [
      {
        signalType: "entity_registry",
        scopeSupplierName: "Test Bank PLC",
        scopeSku: "5493000ABCDEFGHIJK01",
        scopeLaneKey: "GB",
        value: 1,
        unit: "lei_status",
        currency: "USD",
        observedAt: TS_A,
        sourceUrl: "https://api.gleif.org/api/v1/lei-records/5493000ABCDEFGHIJK01",
        confidence: 0.99,
        entityUid: "ent_lei_5493000abcdefghijk01",
        metadata: {
          lei: "5493000ABCDEFGHIJK01",
          legalName: "Test Bank PLC",
          jurisdiction: "GB",
          legalAddressCountry: "GB",
          headquartersCountry: "GB",
          registrationStatus: "ISSUED",
          entityStatus: "ACTIVE",
          lastUpdateDate: "2026-04-01T00:00:00Z",
          initialRegistrationDate: "2020-01-01T00:00:00Z",
        },
      },
      {
        signalType: "entity_registry",
        scopeSupplierName: "Test Bank PLC",
        scopeSku: "5493000ABCDEFGHIJK02",
        scopeLaneKey: "GB",
        value: 1,
        unit: "lei_status",
        currency: "USD",
        observedAt: TS_B,
        sourceUrl: "https://api.gleif.org/api/v1/lei-records/5493000ABCDEFGHIJK02",
        confidence: 0.99,
        entityUid: "ent_lei_5493000abcdefghijk02",
        metadata: {
          lei: "5493000ABCDEFGHIJK02",
          legalName: "Other Test Bank PLC",
          jurisdiction: "GB",
          legalAddressCountry: "GB",
          headquartersCountry: "GB",
          registrationStatus: "ISSUED",
          entityStatus: "ACTIVE",
          lastUpdateDate: "2026-04-02T00:00:00Z",
          initialRegistrationDate: "2020-01-01T00:00:00Z",
        },
      },
    ],
  },
  {
    id: companiesHouseCollector.id,
    base: companiesHouseCollector,
    drafts: [
      {
        signalType: "corporate_filing",
        scopeSupplierName: "TEST UK LIMITED",
        scopeSku: "MzM5OTk5OTk5OWFkaXF6a2N4",
        scopeLaneKey: "england-wales",
        value: 1,
        unit: "filing",
        currency: "GBP",
        observedAt: TS_A,
        sourceUrl: "https://api.company-information.service.gov.uk/company/12345678",
        confidence: 0.97,
        entityUid: "ent_companies_house_12345678",
        metadata: {
          companyNumber: "12345678",
          companyName: "TEST UK LIMITED",
          companyStatus: "active",
          companyType: "ltd",
          category: "accounts",
          transactionId: "MzM5OTk5OTk5OWFkaXF6a2N4",
          description: "accounts-with-accounts-type-full",
          type: "AA",
          jurisdiction: "england-wales",
        },
      },
      {
        signalType: "corporate_filing",
        scopeSupplierName: "TEST UK LIMITED",
        scopeSku: "TXY3OTk5OTk5OWFkaXF6a2N5",
        scopeLaneKey: "england-wales",
        value: 1,
        unit: "filing",
        currency: "GBP",
        observedAt: TS_B,
        sourceUrl: "https://api.company-information.service.gov.uk/company/12345678",
        confidence: 0.97,
        entityUid: "ent_companies_house_12345678",
        metadata: {
          companyNumber: "12345678",
          companyName: "TEST UK LIMITED",
          companyStatus: "active",
          companyType: "ltd",
          category: "confirmation-statement",
          transactionId: "TXY3OTk5OTk5OWFkaXF6a2N5",
          description: "confirmation-statement",
          type: "CS01",
          jurisdiction: "england-wales",
        },
      },
    ],
  },
  {
    id: opensanctionsCollector.id,
    base: opensanctionsCollector,
    drafts: [
      {
        signalType: "risk_screening_match",
        scopeSupplierName: "Acme Trading Group",
        scopeSku: "NK-acme-1",
        scopeLaneKey: "ru",
        value: 2,
        unit: "ftm_class",
        currency: "USD",
        observedAt: TS_A,
        sourceUrl: "https://www.opensanctions.org/entities/NK-acme-1/",
        confidence: 0.92,
        entityUid: "ent_lei_549300abcdef1234wxyz",
        metadata: {
          openSanctionsId: "NK-acme-1",
          schema: "Organization",
          topics: ["sanction"],
          country: "ru",
          lei: "549300ABCDEF1234WXYZ",
          program: "OFAC-SDN",
          datasets: ["us_ofac_sdn"],
          referents: [],
        },
      },
      {
        signalType: "risk_screening_match",
        scopeSupplierName: "Acme Subsidiary Ltd",
        scopeSku: "NK-acme-2",
        scopeLaneKey: "us",
        value: 2,
        unit: "ftm_class",
        currency: "USD",
        observedAt: TS_B,
        sourceUrl: "https://www.opensanctions.org/entities/NK-acme-2/",
        confidence: 0.92,
        entityUid: "ent_opensanctions_NK-acme-2",
        metadata: {
          openSanctionsId: "NK-acme-2",
          schema: "Company",
          topics: ["debarment"],
          country: "us",
          lei: null,
          program: null,
          datasets: ["us_sam_exclusions"],
          referents: [],
        },
      },
    ],
  },
  {
    id: governmentSanctionsCollector.id,
    base: governmentSanctionsCollector,
    drafts: [
      {
        signalType: "sanctions_match",
        scopeSupplierName: "Restricted Party A",
        scopeSku: "OFAC:12345",
        scopeLaneKey: "RU",
        value: 1,
        unit: "list_code",
        currency: "USD",
        observedAt: TS_A,
        sourceUrl: "https://www.treasury.gov/ofac/downloads/sdn.xml",
        confidence: 0.99,
        entityUid: "ent_sanctions_ofac_12345",
        metadata: {
          listName: "OFAC",
          listCode: 1,
          entryId: "12345",
          type: "Entity",
          country: "RU",
          program: "UKRAINE-EO13662",
        },
      },
      {
        signalType: "sanctions_match",
        scopeSupplierName: "Restricted Party B",
        scopeSku: "EU:67890",
        scopeLaneKey: "IR",
        value: 2,
        unit: "list_code",
        currency: "USD",
        observedAt: TS_B,
        sourceUrl: "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content",
        confidence: 0.99,
        entityUid: "ent_sanctions_eu_67890",
        metadata: {
          listName: "EU",
          listCode: 2,
          entryId: "67890",
          type: "Individual",
          country: "IR",
          program: "EU/2010/413",
        },
      },
    ],
  },
  {
    id: climateTraceCollector.id,
    base: climateTraceCollector,
    drafts: [
      {
        signalType: "facility_emissions",
        scopeSupplierName: "Test Steel Co",
        scopeSku: "10001",
        scopeLaneKey: "USA",
        scopeCategoryCode: "iron-and-steel",
        value: 1234567.89,
        unit: "tonnes_co2e",
        currency: "USD",
        observedAt: TS_A,
        sourceUrl: "https://climatetrace.org/explore?assetId=10001",
        confidence: 0.85,
        entityUid: "ent_climatetrace_owner_test_steel_co",
        metadata: {
          assetId: "10001",
          assetName: "Test Steel Mill #1",
          country: "United States",
          iso3Country: "USA",
          sector: "iron-and-steel",
          subsector: null,
          assetType: "mill",
          ownerName: "Test Steel Co",
          co2: 1234567.89,
          co2e100yr: 1234567.89,
          co2e20yr: null,
          capacity: null,
          capacityUnits: null,
          startTime: "2025-01-01T00:00:00Z",
          endTime: "2025-12-31T23:59:59Z",
        },
      },
      {
        signalType: "facility_emissions",
        scopeSupplierName: "Test Cement Inc",
        scopeSku: "10002",
        scopeLaneKey: "DEU",
        scopeCategoryCode: "cement",
        value: 9876543.21,
        unit: "tonnes_co2e",
        currency: "USD",
        observedAt: TS_B,
        sourceUrl: "https://climatetrace.org/explore?assetId=10002",
        confidence: 0.8,
        entityUid: "ent_climatetrace_owner_test_cement_inc",
        metadata: {
          assetId: "10002",
          assetName: "Test Cement Plant",
          country: "Germany",
          iso3Country: "DEU",
          sector: "cement",
          subsector: null,
          assetType: "plant",
          ownerName: "Test Cement Inc",
          co2: 9876543.21,
          co2e100yr: 9876543.21,
          co2e20yr: null,
          capacity: null,
          capacityUnits: null,
          startTime: "2025-01-01T00:00:00Z",
          endTime: "2025-12-31T23:59:59Z",
        },
      },
    ],
  },
  {
    id: gdeltEventsCollector.id,
    base: gdeltEventsCollector,
    drafts: [
      {
        signalType: "event_geocoded",
        scopeSku: "1234567890",
        scopeSupplierName: "ACME CORP",
        scopeLaneKey: "US",
        value: 110,
        unit: "cameo_code",
        currency: "USD",
        observedAt: TS_A,
        sourceUrl: "https://example.test/news/1",
        confidence: 0.65,
        metadata: {
          globalEventId: "1234567890",
          sqlDate: "20260401",
          eventCode: 110,
          actor1Name: "ACME CORP",
          actor1CountryCode: "USA",
          actor2Name: null,
          actor2CountryCode: null,
          goldsteinScale: -2.5,
          numMentions: 3,
          avgTone: -1.2,
          actionGeoFullName: "Houston, Texas, United States",
          actionGeoCountryCode: "US",
          actionGeoLat: 29.76,
          actionGeoLong: -95.36,
        },
      },
      {
        signalType: "event_geocoded",
        scopeSku: "1234567891",
        scopeSupplierName: "BETA LTD",
        scopeLaneKey: "GB",
        value: 42,
        unit: "cameo_code",
        currency: "USD",
        observedAt: TS_B,
        sourceUrl: "https://example.test/news/2",
        confidence: 0.65,
        metadata: {
          globalEventId: "1234567891",
          sqlDate: "20260402",
          eventCode: 42,
          actor1Name: "BETA LTD",
          actor1CountryCode: "GBR",
          actor2Name: null,
          actor2CountryCode: null,
          goldsteinScale: 1.5,
          numMentions: 7,
          avgTone: 2.1,
          actionGeoFullName: "London, England, United Kingdom",
          actionGeoCountryCode: "GB",
          actionGeoLat: 51.5,
          actionGeoLong: -0.12,
        },
      },
    ],
  },
  {
    id: naturalHazardsCollector.id,
    base: naturalHazardsCollector,
    drafts: [
      {
        signalType: "natural_hazard",
        scopeSku: "us7000abcd",
        scopeLaneKey: "Honduras",
        scopeCategoryCode: "earthquake",
        value: 1,
        unit: "source_code",
        currency: "USD",
        observedAt: TS_A,
        sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
        confidence: 0.99,
        metadata: {
          sourceName: "USGS",
          eventId: "us7000abcd",
          magnitude: 5.2,
          place: "20 km E of Tegucigalpa, Honduras",
          eventType: "earthquake",
          tsunami: 0,
          longitude: -87.0,
          latitude: 14.0,
          depthKm: 10,
        },
      },
      {
        signalType: "natural_hazard",
        scopeSku: "https://api.weather.gov/alerts/test-001",
        scopeLaneKey: "US",
        scopeCategoryCode: "Severe Thunderstorm Warning",
        value: 2,
        unit: "source_code",
        currency: "USD",
        observedAt: TS_B,
        sourceUrl: "https://api.weather.gov/alerts/test-001",
        confidence: 0.95,
        metadata: {
          sourceName: "NWS",
          eventId: "https://api.weather.gov/alerts/test-001",
          event: "Severe Thunderstorm Warning",
          severity: "Severe",
          severityValue: 3,
          certainty: "Observed",
          urgency: "Immediate",
          areaDesc: "Travis, TX",
          headline: "Severe Thunderstorm Warning until 7 PM",
          messageType: "Alert",
        },
      },
    ],
  },
];

function buildStubCollector(c: CollectorCase): IntelligenceCollector {
  // Return a fresh copy of drafts each call so the test fixtures
  // aren't mutated by the runtime's normalization.
  return {
    ...c.base,
    async collect(): Promise<MarketSignalDraft[]> {
      return c.drafts.map((d) => ({ ...d, metadata: { ...(d.metadata ?? {}) } }));
    },
    // Drop the raw-landing path entirely for the test; we're not
    // exercising GCS here, only the runtime's
    // resolve/insert/dedupe/audit pipeline.
    collectWithRaw: undefined,
  };
}

async function deleteTestData(collectorId: string): Promise<void> {
  await db
    .delete(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, collectorId));
  await db
    .delete(collectorAuditLogTable)
    .where(eq(collectorAuditLogTable.collectorId, collectorId));
}

async function latestSucceededAudit(collectorId: string): Promise<{
  inserted: number;
  duplicates: number;
  drafts: number;
} | null> {
  const [row] = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, collectorId),
        eq(collectorAuditLogTable.event, "fetch_succeeded"),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(1);
  if (!row) return null;
  const md = row.metadata as Record<string, unknown>;
  return {
    inserted: Number(md["inserted"] ?? -1),
    duplicates: Number(md["duplicates"] ?? -1),
    drafts: Number(md["drafts"] ?? -1),
  };
}

async function fetchCollectorRows(collectorId: string): Promise<
  Array<{ metadata: unknown; scopeSku: string | null }>
> {
  const rows = await db
    .select({
      metadata: marketSignalsTable.metadata,
      scopeSku: marketSignalsTable.scopeSku,
    })
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, collectorId));
  return rows;
}

test("public-api collectors round-trip drafts through runCollector with idempotent dedupe + entity_uid mirroring", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Cleanup at the very end — pool.end() must come after every per-case
  // teardown.
  t.after(async () => {
    await pool.end().catch(() => {});
  });

  for (const c of CASES) {
    await t.test(`runCollector ↔ ${c.id}`, async (sub) => {
      const stub = buildStubCollector(c);
      registerCollector(stub);

      await upsertCollectorRegistration({
        id: c.id,
        name: c.base.name,
        description: c.base.description,
        posture: c.base.posture,
        owner: "tests",
        sourceUrl: c.base.sourceUrl,
        rateLimitRpm: c.base.defaultRateLimitRpm,
        scheduleCron: c.base.defaultScheduleCron,
        notes: null,
        actor: "tests",
      });
      await approveCollector(c.id, "tests");

      sub.after(async () => {
        try {
          await deleteTestData(c.id);
          await disableCollector(c.id, "tests", "rejected");
        } catch (err) {
          // Best-effort cleanup; don't fail the test on teardown.
          // eslint-disable-next-line no-console
          console.error(`[cleanup] ${c.id}:`, err);
        }
      });

      await deleteTestData(c.id);

      // 1) First run: both fixture drafts inserted.
      const r1 = await runCollector(c.id);
      assert.equal(
        r1.signalsCollected,
        c.drafts.length,
        `${c.id}: first run should insert all fixture drafts`,
      );
      const audit1 = await latestSucceededAudit(c.id);
      assert.deepEqual(
        audit1,
        { inserted: c.drafts.length, duplicates: 0, drafts: c.drafts.length },
        `${c.id}: audit log inserted/duplicates accurate after first run`,
      );

      // 2) Identical second run: zero new rows, all duplicates.
      const r2 = await runCollector(c.id);
      assert.equal(
        r2.signalsCollected,
        0,
        `${c.id}: second run must dedupe via natural-key index`,
      );
      const audit2 = await latestSucceededAudit(c.id);
      assert.deepEqual(
        audit2,
        { inserted: 0, duplicates: c.drafts.length, drafts: c.drafts.length },
        `${c.id}: audit log records all drafts as duplicates on re-run`,
      );

      // 3) entityUid (when set on the draft) must surface in
      //    metadata.entityUid on the persisted row.
      const rows = await fetchCollectorRows(c.id);
      assert.equal(
        rows.length,
        c.drafts.length,
        `${c.id}: row count matches inserted draft count`,
      );
      const skuToUid = new Map<string, string | undefined>();
      for (const d of c.drafts) {
        if (d.scopeSku) {
          skuToUid.set(d.scopeSku, d.entityUid ?? undefined);
        }
      }
      for (const row of rows) {
        if (row.scopeSku === null) continue;
        const expected = skuToUid.get(row.scopeSku);
        const md = (row.metadata ?? {}) as Record<string, unknown>;
        if (expected !== undefined) {
          assert.equal(
            md["entityUid"],
            expected,
            `${c.id}: metadata.entityUid mirrored for scopeSku=${row.scopeSku}`,
          );
        } else {
          assert.equal(
            md["entityUid"],
            undefined,
            `${c.id}: no entityUid on draft → no entityUid on row (scopeSku=${row.scopeSku})`,
          );
        }
      }
    });
  }
});
