/**
 * Honest product banner for the Data Factory API spine.
 *
 * Day 0 is beta. This is not GA. Layer B (opt-in tenant spend,
 * multi-tenant benchmarks) is deferred. FSA client paths are out of
 * LoE.
 */
export const DATA_FACTORY_SCHEMA_VERSION = 1 as const;
export const DATA_FACTORY_RELEASE = "beta" as const;

export interface DataFactoryStatus {
  product: "procuro-data-factory";
  loe: "procuro";
  schemaVersion: typeof DATA_FACTORY_SCHEMA_VERSION;
  release: typeof DATA_FACTORY_RELEASE;
  ga: false;
  layerA: "public_ingest_spine";
  layerB: "deferred";
  layerC: "decide_learn_taxonomy_stub";
  clientTenantData: false;
  fsaClientPaths: false;
  inventedCustomerMetrics: false;
  notes: string[];
}

export function dataFactoryStatus(): DataFactoryStatus {
  return {
    product: "procuro-data-factory",
    loe: "procuro",
    schemaVersion: DATA_FACTORY_SCHEMA_VERSION,
    release: DATA_FACTORY_RELEASE,
    ga: false,
    layerA: "public_ingest_spine",
    layerB: "deferred",
    layerC: "decide_learn_taxonomy_stub",
    clientTenantData: false,
    fsaClientPaths: false,
    inventedCustomerMetrics: false,
    notes: [
      "Serves packaged public / internet Layer A datasets only.",
      "Paid-license feeds are catalogued and blocked until a human approves the license.",
      "Does not ingest tenant spend, ERP extracts, or FSA client files.",
      "Does not publish peer percentiles, ARR, or savings %.",
      "Metering is a usage-log hook, not a GA billing meter.",
    ],
  };
}
