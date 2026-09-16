import { describe, expect, it } from "vitest";
import {
  DATA_FACTORY_SOURCES,
  TIER1_SOURCE_IDS,
  TIER15_SOURCE_IDS,
  TIER15B_SOURCE_IDS,
  TIER_C_SOURCE_IDS,
  TIER2_SOURCE_IDS,
} from "../src/catalog";
import {
  fetchAllLayerASources,
  fetchLayerASource,
  fetchTier15Sources,
  fetchTier15bSources,
  fetchTierCSources,
  fetchTier1Sources,
  fetchTier2Sources,
} from "../src/fetch-stubs";
import {
  getLayerAObservationSchema,
  TIER1_SCHEMAS,
  TIER15_SCHEMAS,
  TIER15B_SCHEMAS,
  TIER_C_SCHEMAS,
} from "../src/schemas";

describe("Layer A fetch stubs", () => {
  it("never invents observation values", () => {
    for (const result of fetchAllLayerASources()) {
      expect(result.observations).toEqual([]);
    }
  });

  it("blocks paid-license sources as license_required", () => {
    const fbx = fetchLayerASource("src_freightos_fbx");
    expect(fbx.status).toBe("license_required");
    expect(fbx.plan).toBeNull();
    expect(fbx.observations).toEqual([]);
  });

  it("returns a stub (not a live scrape) for openFDA, BTS, and POLA", () => {
    const fda = fetchLayerASource("src_openfda_food_enforcement");
    expect(fda.status).toBe("stub");
    expect(fda.plan?.liveFetch).toBe(false);
    expect(fda.observations).toEqual([]);

    const bts = fetchLayerASource("src_bts_teu");
    expect(bts.status).toBe("stub");
    expect(bts.plan?.scrapePosture).toBe("socrata");
    expect(bts.plan?.url).toBe("https://data.bts.gov/");
    expect(bts.note).toMatch(/do not invent a 4×4/i);

    const pola = fetchLayerASource("src_pola");
    expect(pola.status).toBe("stub");
    expect(pola.plan?.scrapePosture).toBe("careful_public_page");
  });

  it("points FRED/EIA/BLS/OFAC at existing collectors without dumping rows", () => {
    const fred = fetchLayerASource("src_fred");
    expect(fred.status).toBe("wired_existing_collector");
    if (fred.status === "wired_existing_collector") {
      expect(fred.collectorId).toBe("fred-economic-index");
    }
    expect(fred.plan?.authEnvVar).toBe("FRED_API_KEY");
    expect(fred.observations).toEqual([]);

    expect(fetchLayerASource("src_bls").status).toBe(
      "wired_existing_collector",
    );
    expect(fetchLayerASource("src_eia").status).toBe(
      "wired_existing_collector",
    );
    expect(fetchLayerASource("src_ofac_sdn").status).toBe(
      "wired_existing_collector",
    );
  });

  it("attaches observation schemas to every Tier 1 source", () => {
    const schemaIds = new Set(TIER1_SCHEMAS.map((s) => s.sourceId));
    expect(schemaIds.size).toBe(TIER1_SOURCE_IDS.length);
    for (const id of TIER1_SOURCE_IDS) {
      expect(schemaIds.has(id), id).toBe(true);
      const result = fetchLayerASource(id);
      expect(result.status).not.toBe("license_required");
      expect(result.schema?.sourceId, id).toBe(id);
      expect(result.schema?.liveFetch).toBe(false);
      expect(result.plan?.liveFetch).toBe(false);
      expect(result.observations).toEqual([]);
    }
    expect(fetchTier1Sources()).toHaveLength(TIER1_SOURCE_IDS.length);
  });

  it("keeps Cass and SCFI cite-only on Tier 2 (no invented index schema)", () => {
    for (const id of ["src_cass_freight_index", "src_scfi"] as const) {
      expect(TIER2_SOURCE_IDS).toContain(id);
      expect(getLayerAObservationSchema(id)).toBeUndefined();
      const result = fetchLayerASource(id);
      expect(result.status).toBe("license_required");
      expect(result.plan).toBeNull();
      expect(result.observations).toEqual([]);
    }
    expect(fetchTier2Sources()).toHaveLength(TIER2_SOURCE_IDS.length);
  });

  it("attaches observation schemas to every Tier 1.5 source (GDACS reuses OSINT)", () => {
    const schemaIds = new Set(TIER15_SCHEMAS.map((s) => s.sourceId));
    expect(schemaIds.has("src_gdacs")).toBe(false);
    for (const id of TIER15_SOURCE_IDS) {
      if (id === "src_gdacs") {
        expect(getLayerAObservationSchema(id)?.sourceId).toBe("src_gdacs");
        continue;
      }
      expect(schemaIds.has(id), id).toBe(true);
      const result = fetchLayerASource(id);
      expect(result.status).not.toBe("license_required");
      expect(result.schema?.sourceId, id).toBe(id);
      expect(result.schema?.liveFetch).toBe(false);
      expect(result.plan?.liveFetch).toBe(false);
      expect(result.observations).toEqual([]);
    }
    expect(fetchTier15Sources()).toHaveLength(TIER15_SOURCE_IDS.length);

    const aishub = fetchLayerASource("src_aishub");
    expect(aishub.status).toBe("stub");
    expect(aishub.plan?.authEnvVar).toBe("AISHUB_USERNAME");
    expect(aishub.observations).toEqual([]);

    const bea = fetchLayerASource("src_bea");
    expect(bea.status).toBe("stub");
    expect(bea.plan?.authEnvVar).toBe("BEA_API_KEY");
  });

  it("attaches observation schemas to locked Tier 1.5b stubs (ACLED gated)", () => {
    const schemaIds = new Set(TIER15B_SCHEMAS.map((s) => s.sourceId));
    for (const id of TIER15B_SOURCE_IDS) {
      const result = fetchLayerASource(id);
      expect(result.observations).toEqual([]);
      if (id === "src_acled") {
        expect(result.status).toBe("license_required");
        expect(result.plan).toBeNull();
        expect(getLayerAObservationSchema(id)).toBeUndefined();
        continue;
      }
      expect(schemaIds.has(id), id).toBe(true);
      expect(result.status).not.toBe("license_required");
      expect(result.schema?.sourceId, id).toBe(id);
    }
    expect(fetchTier15bSources()).toHaveLength(TIER15B_SOURCE_IDS.length);
    expect(fetchLayerASource("src_companies_house").status).toBe(
      "wired_existing_collector",
    );
  });

  it("attaches observation schemas to light Tier C (OpenSanctions reused)", () => {
    const schemaIds = new Set(TIER_C_SCHEMAS.map((s) => s.sourceId));
    expect(schemaIds.has("src_opensanctions")).toBe(false);
    for (const id of TIER_C_SOURCE_IDS) {
      const result = fetchLayerASource(id);
      expect(result.observations).toEqual([]);
      expect(result.status).not.toBe("license_required");
      if (id === "src_opensanctions") {
        expect(result.schema?.sourceId).toBe("src_opensanctions");
        continue;
      }
      expect(schemaIds.has(id), id).toBe(true);
      expect(result.schema?.sourceId, id).toBe(id);
    }
    expect(fetchTierCSources()).toHaveLength(TIER_C_SOURCE_IDS.length);
    expect(fetchLayerASource("src_opencorporates").note).toMatch(/Day 0 stub/);
  });

  it("covers every catalog source and unknown ids", () => {
    expect(fetchAllLayerASources()).toHaveLength(DATA_FACTORY_SOURCES.length);
    const unknown = fetchLayerASource("src_does_not_exist");
    expect(unknown.status).toBe("unknown_source");
    expect(unknown.observations).toEqual([]);
  });
});
