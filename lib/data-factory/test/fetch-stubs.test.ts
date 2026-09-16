import { describe, expect, it } from "vitest";
import {
  DATA_FACTORY_SOURCES,
  TIER1_SOURCE_IDS,
  TIER2_SOURCE_IDS,
} from "../src/catalog";
import {
  fetchAllLayerASources,
  fetchLayerASource,
  fetchTier1Sources,
  fetchTier2Sources,
} from "../src/fetch-stubs";
import {
  getLayerAObservationSchema,
  TIER1_SCHEMAS,
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

  it("covers every catalog source and unknown ids", () => {
    expect(fetchAllLayerASources()).toHaveLength(DATA_FACTORY_SOURCES.length);
    const unknown = fetchLayerASource("src_does_not_exist");
    expect(unknown.status).toBe("unknown_source");
    expect(unknown.observations).toEqual([]);
  });
});
