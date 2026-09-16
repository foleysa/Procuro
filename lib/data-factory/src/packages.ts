/**
 * Packaged Layer A datasets sold via Pulse / Diligence AND the API spine.
 *
 * Day 0 packages are catalog JSON: sources, license posture, empty
 * observations. They do not invent index values, savings, or
 * multi-tenant benchmarks.
 */

import {
  DATA_FACTORY_SOURCES,
  getDataFactorySource,
  type DataFactorySource,
  type DataFactorySourceFamily,
} from "./catalog";
import { fetchLayerASource, type LayerAFetchResult } from "./fetch-stubs";
import { DATA_FACTORY_RELEASE, DATA_FACTORY_SCHEMA_VERSION } from "./status";

export interface DataFactoryPackageMeta {
  id: string;
  title: string;
  description: string;
  family: DataFactorySourceFamily;
  sourceIds: readonly string[];
  pulseSurface: "pulse" | "diligence" | "both";
  release: typeof DATA_FACTORY_RELEASE;
}

export const DATA_FACTORY_PACKAGES: readonly DataFactoryPackageMeta[] = [
  {
    id: "pkg_public_indices",
    title: "Public price & economic indices",
    description:
      "FRED, BLS, EIA, World Bank Pink Sheet, USGS minerals, ECB FX, Eurostat, USDA NASS. Public / free-registration series only.",
    family: "index",
    sourceIds: [
      "src_fred",
      "src_bls",
      "src_eia",
      "src_world_bank_pink_sheet",
      "src_usgs_mineral",
      "src_ecb_fx",
      "src_eurostat",
      "src_usda_nass",
    ],
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_procurement",
    title: "Public procurement notices & awards",
    description:
      "SAM.gov and USAspending (wired collectors) plus TED and UK Contracts Finder stubs. No tenant PO/invoice data.",
    family: "procurement",
    sourceIds: [
      "src_sam_gov",
      "src_usaspending",
      "src_eu_ted",
      "src_uk_contracts_finder",
    ],
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_freight_commodity",
    title: "Freight & commodity public feeds",
    description:
      "Public/free commodity closes and BTS stub. Freightos FBX, Cass, and SCFI are catalogued and blocked pending license.",
    family: "freight_commodity",
    sourceIds: [
      "src_published_commodity_index",
      "src_bts_freight",
      "src_freightos_fbx",
      "src_cass_freight_index",
      "src_scfi",
    ],
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_disruption",
    title: "Public disruption signals",
    description:
      "GDELT events, natural hazards, and official sanctions lists. Geopolitical / hazard / screening *signals*, not a screening product.",
    family: "disruption",
    sourceIds: ["src_gdelt", "src_natural_hazards", "src_government_sanctions"],
    pulseSurface: "pulse",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_filings",
    title: "Public corporate filings",
    description:
      "SEC EDGAR and UK Companies House. Issuer watchlists may exist on the desk; this package does not include tenant-private lists.",
    family: "filing",
    sourceIds: ["src_sec_edgar", "src_companies_house"],
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
  /**
   * Always empty on Day 0. Live numbers stay on existing collectors.
   * Do not invent observations to make a Diligence pack "look live".
   */
  observations: [];
  fences: string[];
}

const PACKAGE_BY_ID = new Map(DATA_FACTORY_PACKAGES.map((p) => [p.id, p]));

export function getDataFactoryPackage(
  id: string,
): DataFactoryPackageMeta | undefined {
  return PACKAGE_BY_ID.get(id);
}

export function listDataFactoryPackages(): DataFactoryPackageMeta[] {
  return [...DATA_FACTORY_PACKAGES];
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
      "Paid-license sources stay blocked until human approval.",
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
