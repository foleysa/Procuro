import { describe, expect, it } from "vitest";
import {
  DATA_FACTORY_SOURCES,
  DAY0_WIRE_FIRST_IDS,
} from "../src/catalog";
import {
  fetchAllLayerASources,
  fetchLayerASource,
  fetchWireFirstSources,
} from "../src/fetch-stubs";
import { getLayerAObservationSchema, WIRE_FIRST_SCHEMAS } from "../src/schemas";

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

  it("returns a stub (not a live scrape) for openFDA and POLA", () => {
    const fda = fetchLayerASource("src_openfda_food_enforcement");
    expect(fda.status).toBe("stub");
    expect(fda.plan?.liveFetch).toBe(false);
    expect(fda.observations).toEqual([]);

    const pola = fetchLayerASource("src_pola");
    expect(pola.status).toBe("stub");
    expect(pola.plan?.scrapePosture).toBe("careful_public_page");
  });

  it("points FRED/EIA/OFAC at existing collectors without dumping rows", () => {
    const fred = fetchLayerASource("src_fred");
    expect(fred.status).toBe("wired_existing_collector");
    if (fred.status === "wired_existing_collector") {
      expect(fred.collectorId).toBe("fred-economic-index");
    }
    expect(fred.plan?.authEnvVar).toBe("FRED_API_KEY");
    expect(fred.observations).toEqual([]);
  });

  it("attaches observation schemas to every wire-first public source except Cass", () => {
    const schemaIds = new Set(WIRE_FIRST_SCHEMAS.map((s) => s.sourceId));
    for (const id of DAY0_WIRE_FIRST_IDS) {
      if (id === "src_cass_freight_index") {
        expect(getLayerAObservationSchema(id)).toBeUndefined();
        expect(fetchLayerASource(id).status).toBe("license_required");
        continue;
      }
      expect(schemaIds.has(id), id).toBe(true);
      const result = fetchLayerASource(id);
      expect(result.schema?.sourceId, id).toBe(id);
      expect(result.schema?.liveFetch).toBe(false);
    }
    expect(fetchWireFirstSources()).toHaveLength(DAY0_WIRE_FIRST_IDS.length);
  });

  it("covers every catalog source and unknown ids", () => {
    expect(fetchAllLayerASources()).toHaveLength(DATA_FACTORY_SOURCES.length);
    const unknown = fetchLayerASource("src_does_not_exist");
    expect(unknown.status).toBe("unknown_source");
    expect(unknown.observations).toEqual([]);
  });
});
