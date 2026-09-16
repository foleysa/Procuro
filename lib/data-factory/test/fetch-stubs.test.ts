import { describe, expect, it } from "vitest";
import { DATA_FACTORY_SOURCES } from "../src/catalog";
import { fetchAllLayerASources, fetchLayerASource } from "../src/fetch-stubs";

describe("Layer A fetch stubs", () => {
  it("never invents observation values", () => {
    for (const result of fetchAllLayerASources()) {
      expect(result.observations).toEqual([]);
    }
  });

  it("blocks paid-license sources", () => {
    const fbx = fetchLayerASource("src_freightos_fbx");
    expect(fbx.status).toBe("blocked_pending_license");
    expect(fbx.observations).toEqual([]);
    if (fbx.status === "blocked_pending_license") {
      expect(fbx.note.toLowerCase()).toMatch(/license/);
    }
  });

  it("returns a stub (not a live scrape) for TED", () => {
    const ted = fetchLayerASource("src_eu_ted");
    expect(ted.status).toBe("stub");
    expect(ted.observations).toEqual([]);
  });

  it("points wired sources at the existing collector without dumping rows", () => {
    const fred = fetchLayerASource("src_fred");
    expect(fred.status).toBe("wired_existing_collector");
    if (fred.status === "wired_existing_collector") {
      expect(fred.collectorId).toBe("fred-economic-index");
    }
    expect(fred.observations).toEqual([]);
  });

  it("covers every catalog source and unknown ids", () => {
    expect(fetchAllLayerASources()).toHaveLength(DATA_FACTORY_SOURCES.length);
    const unknown = fetchLayerASource("src_does_not_exist");
    expect(unknown.status).toBe("unknown_source");
    expect(unknown.observations).toEqual([]);
  });
});
