/**
 * Packaged Layer A datasets — Pulse / Diligence AND the API spine.
 *
 * Day 0 packages are catalog JSON + schemas. observations stay [].
 */

import {
  DAY0_WIRE_FIRST_IDS,
  LICENSE_REQUIRED_PLACEHOLDER_IDS,
  getDataFactorySource,
  type DataFactoryChannelUse,
  type DataFactorySource,
  type DataFactorySourceFamily,
} from "./catalog";
import { fetchLayerASource, type LayerAFetchResult } from "./fetch-stubs";
import { DATA_FACTORY_RELEASE, DATA_FACTORY_SCHEMA_VERSION } from "./status";

export interface DataFactoryPackageMeta {
  id: string;
  title: string;
  description: string;
  family: DataFactorySourceFamily | "mixed";
  sourceIds: readonly string[];
  /** Pulse brief vs API product vs both. */
  channelUse: DataFactoryChannelUse;
  /** @deprecated use channelUse — kept for earlier Day 0 callers */
  pulseSurface: "pulse" | "diligence" | "both";
  release: typeof DATA_FACTORY_RELEASE;
}

export const DATA_FACTORY_PACKAGES: readonly DataFactoryPackageMeta[] = [
  {
    id: "pkg_day0_wire_first",
    title: "Day 0 wire-first public signals",
    description:
      "FRED, EIA v2, openFDA food enforcement, OFAC SDN, api.weather.gov, BTS TEU, POLA/POLB (careful pages), Cass (cite-only).",
    family: "mixed",
    sourceIds: DAY0_WIRE_FIRST_IDS,
    channelUse: "both",
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_indices",
    title: "Public price & economic indices",
    description: "FRED + EIA v2 (wire-first) and BLS / World Bank (existing).",
    family: "index",
    sourceIds: ["src_fred", "src_eia", "src_bls", "src_world_bank_pink_sheet"],
    channelUse: "both",
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_disruption",
    title: "Public disruption signals",
    description:
      "openFDA food enforcement, OFAC SDN, NWS alerts. Signals, not a screening product.",
    family: "disruption",
    sourceIds: [
      "src_openfda_food_enforcement",
      "src_ofac_sdn",
      "src_weather_gov",
    ],
    channelUse: "pulse",
    pulseSurface: "pulse",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_freight_commodity",
    title: "Freight & commodity public + license placeholders",
    description:
      "BTS TEU and POLA/POLB stubs. Cass and paid freight/commodity feeds are license_required only.",
    family: "freight_commodity",
    sourceIds: [
      "src_bts_teu",
      "src_pola",
      "src_polb",
      ...LICENSE_REQUIRED_PLACEHOLDER_IDS,
    ],
    channelUse: "both",
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_license_required",
    title: "Paid feeds (license required)",
    description:
      "DAT, Freightos, Xeneta, Drewry, SONAR, LME, CME, ISM ROB, S&P CI, Fastmarkets, JOC, Cass. Placeholders — no fetch.",
    family: "mixed",
    sourceIds: LICENSE_REQUIRED_PLACEHOLDER_IDS,
    channelUse: "both",
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_procurement",
    title: "Public procurement notices & awards",
    description: "SAM.gov and USAspending. No tenant PO/invoice data.",
    family: "procurement",
    sourceIds: ["src_sam_gov", "src_usaspending"],
    channelUse: "api",
    pulseSurface: "diligence",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_filings",
    title: "Public corporate filings",
    description: "SEC EDGAR. No tenant-private issuer lists.",
    family: "filing",
    sourceIds: ["src_sec_edgar"],
    channelUse: "api",
    pulseSurface: "diligence",
    release: DATA_FACTORY_RELEASE,
  },
] as const;

export interface DataFactoryPackageJson {
  schemaVersion: typeof DATA_FACTORY_SCHEMA_VERSION;
  release: typeof DATA_FACTORY_RELEASE;
  ga: false;
  layer: "A";
  package: DataFactoryPackageMeta;
  sources: DataFactorySource[];
  fetches: LayerAFetchResult[];
  observations: [];
  fences: string[];
}

const PACKAGE_BY_ID = new Map(DATA_FACTORY_PACKAGES.map((p) => [p.id, p]));

export function getDataFactoryPackage(
  id: string,
): DataFactoryPackageMeta | undefined {
  return PACKAGE_BY_ID.get(id);
}

export function listDataFactoryPackages(filter?: {
  channelUse?: DataFactoryChannelUse;
}): DataFactoryPackageMeta[] {
  return DATA_FACTORY_PACKAGES.filter((p) => {
    if (!filter?.channelUse) return true;
    if (filter.channelUse === "both") return p.channelUse === "both";
    return p.channelUse === filter.channelUse || p.channelUse === "both";
  });
}

export function packageLayerADataset(
  packageId: string,
): DataFactoryPackageJson | null {
  const meta = getDataFactoryPackage(packageId);
  if (!meta) return null;
  const sources: DataFactorySource[] = [];
  for (const sourceId of meta.sourceIds) {
    const source = getDataFactorySource(sourceId);
    if (!source) {
      throw new Error(
        `Package ${packageId} references missing source ${sourceId}`,
      );
    }
    sources.push(source);
  }
  return {
    schemaVersion: DATA_FACTORY_SCHEMA_VERSION,
    release: DATA_FACTORY_RELEASE,
    ga: false,
    layer: "A",
    package: meta,
    sources,
    fetches: meta.sourceIds.map((id) => fetchLayerASource(id)),
    observations: [],
    fences: [
      "Public / internet Layer A only.",
      "No tenant spend, ERP, or FSA client files.",
      "No invented index values, ARR, savings %, or peer percentiles.",
      "Paid-license sources stay license_required until human approval.",
    ],
  };
}

export function packageAllLayerADatasets(): DataFactoryPackageJson[] {
  return DATA_FACTORY_PACKAGES.map((p) => {
    const packed = packageLayerADataset(p.id);
    if (!packed) {
      throw new Error(`Failed to pack ${p.id}`);
    }
    return packed;
  });
}
