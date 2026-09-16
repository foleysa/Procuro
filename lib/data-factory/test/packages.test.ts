import { describe, expect, it } from "vitest";
import { DATA_FACTORY_PACKAGES, packageLayerADataset } from "../src/packages";
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
    }
  });

  it("does not invent a tenant-spend or FSA package", () => {
    expect(packageLayerADataset("pkg_tenant_spend")).toBeNull();
    expect(packageLayerADataset("pkg_fsa_client")).toBeNull();
    const ids = DATA_FACTORY_PACKAGES.map((p) => p.id);
    expect(ids.some((id) => /tenant|fsa|benchmark/i.test(id))).toBe(false);
  });

  it("keeps paid freight sources inside the freight package as blocked", () => {
    const packed = packageLayerADataset("pkg_public_freight_commodity");
    const blocked = packed?.fetches.filter(
      (f) => f.status === "blocked_pending_license",
    );
    expect(blocked?.length).toBeGreaterThanOrEqual(3);
    expect(packed?.observations).toEqual([]);
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
