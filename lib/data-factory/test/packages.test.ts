import { describe, expect, it } from "vitest";
import {
  NEWS_OSINT_SOURCE_IDS,
  TIER1_SOURCE_IDS,
  TIER2_SOURCE_IDS,
} from "../src/catalog";
import {
  DATA_FACTORY_PACKAGES,
  packageLayerADataset,
  packageNewsOsintStream,
} from "../src/packages";
import { dataFactoryStatus } from "../src/status";

describe("Layer A packages", () => {
  it("packs every declared package with empty observations", () => {
    for (const meta of DATA_FACTORY_PACKAGES) {
      const packed = packageLayerADataset(meta.id);
      expect(packed).not.toBeNull();
      expect(packed?.ga).toBe(false);
      expect(packed?.release).toBe("beta");
      expect(packed?.layer).toBe("A");
      expect(packed?.observations).toEqual([]);
      expect(packed?.sources.length).toBe(meta.sourceIds.length);
      expect(["pulse", "api", "both"]).toContain(meta.channelUse);
    }
  });

  it("serves the strengthened Tier 1 pack for Pulse and API", () => {
    const packed = packageLayerADataset("pkg_tier1");
    expect(packed?.package.channelUse).toBe("both");
    expect(packed?.package.sourceIds).toEqual([...TIER1_SOURCE_IDS]);
    expect(packed?.observations).toEqual([]);
    const alias = packageLayerADataset("pkg_day0_wire_first");
    expect(alias?.package.sourceIds).toEqual([...TIER1_SOURCE_IDS]);
  });

  it("serves the Tier 2 file/CSV pack including Cass/SCFI cite-only", () => {
    const packed = packageLayerADataset("pkg_tier2");
    expect(packed?.package.sourceIds).toEqual([...TIER2_SOURCE_IDS]);
    expect(packed?.observations).toEqual([]);
    const cass = packed?.fetches.find((f) => f.sourceId === "src_cass_freight_index");
    expect(cass?.status).toBe("license_required");
  });

  it("does not invent a tenant-spend or FSA package", () => {
    expect(packageLayerADataset("pkg_tenant_spend")).toBeNull();
    expect(packageLayerADataset("pkg_fsa_client")).toBeNull();
    const ids = DATA_FACTORY_PACKAGES.map((p) => p.id);
    expect(ids.some((id) => /tenant|fsa|benchmark/i.test(id))).toBe(false);
  });

  it("keeps paid freight sources as license_required", () => {
    const packed = packageLayerADataset("pkg_license_required");
    expect(packed?.sources.length).toBe(11);
    expect(
      packed?.fetches.every((f) => f.status === "license_required"),
    ).toBe(true);
    expect(packed?.observations).toEqual([]);
    expect(packed?.sources.some((s) => s.id === "src_cass_freight_index")).toBe(
      false,
    );
  });

  it("packs news/OSINT as metadata + cited bullets, never article HTML", () => {
    const packed = packageLayerADataset("pkg_news_osint");
    expect(packed?.package.sourceIds).toEqual([...NEWS_OSINT_SOURCE_IDS]);
    expect(packed?.observations).toEqual([]);
    expect(packed?.package.channelUse).toBe("both");
    const stream = packageNewsOsintStream();
    expect(stream.events).toEqual([]);
    expect(stream.pulse.format).toBe("cited_bullets");
    expect(stream.tos.fullTextRepublish).toBe("out_of_scope");
  });

  it("advertises an honest beta status", () => {
    const status = dataFactoryStatus();
    expect(status.ga).toBe(false);
    expect(status.layerB).toBe("deferred");
    expect(status.clientTenantData).toBe(false);
    expect(status.fsaClientPaths).toBe(false);
    expect(status.inventedCustomerMetrics).toBe(false);
    expect(status.loe).toBe("procuro");
  });
});
