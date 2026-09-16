/**
 * Packaged Layer A datasets — Pulse / Diligence AND the API spine.
 *
 * Day 0 packages are catalog JSON + schemas. observations stay [].
 */

import {
  TIER1_SOURCE_IDS,
  TIER2_SOURCE_IDS,
  NEWS_OSINT_SOURCE_IDS,
  LICENSE_REQUIRED_PLACEHOLDER_IDS,
  getDataFactorySource,
  type DataFactoryChannelUse,
  type DataFactorySource,
  type DataFactorySourceFamily,
} from "./catalog";
import {
  newsOsintMetadataStream,
  type NewsOsintStream,
} from "./events";
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
    id: "pkg_tier1",
    title: "Day 0 Tier 1 public APIs",
    description:
      "Strengthened Tier 1: BLS PPI, FRED, EIA v2, USDA MyMarketNews, openFDA food + recalls, OFAC SDN, Federal Register, SEC EDGAR, BTS TEU (Socrata), weather.gov alerts, USAspending, Census FT-900, Census M3, World Bank Pink Sheet, UN Comtrade free/bulk.",
    family: "mixed",
    sourceIds: TIER1_SOURCE_IDS,
    channelUse: "both",
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_day0_wire_first",
    title: "Day 0 Tier 1 public APIs (alias)",
    description:
      "Deprecated alias of pkg_tier1. The old 8-source wire-first list was weak.",
    family: "mixed",
    sourceIds: TIER1_SOURCE_IDS,
    channelUse: "both",
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_tier2",
    title: "Day 0 Tier 2 file / CSV / careful pages",
    description:
      "POLA/POLB, USGS MCS, USDA ERS, CPSC, Beige Book, NAICS/UNSPSC, Cass cite-only, NHC, FDA dashboard, SAM.gov (careful), SCFI cite-only, IMF primary commodity, USACE if open, EPA TRI.",
    family: "mixed",
    sourceIds: TIER2_SOURCE_IDS,
    channelUse: "both",
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_indices",
    title: "Public price & economic indices",
    description:
      "BLS PPI, FRED, EIA v2, USDA MyMarketNews, Census M3, World Bank Pink Sheet.",
    family: "index",
    sourceIds: [
      "src_bls",
      "src_fred",
      "src_eia",
      "src_usda_mymarketnews",
      "src_census_m3",
      "src_world_bank_pink_sheet",
    ],
    channelUse: "both",
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_disruption",
    title: "Public disruption signals",
    description:
      "openFDA food + recalls, OFAC SDN, Federal Register, NWS alerts. Signals, not a screening product.",
    family: "disruption",
    sourceIds: [
      "src_openfda_food_enforcement",
      "src_openfda_recalls",
      "src_ofac_sdn",
      "src_federal_register",
      "src_weather_gov",
    ],
    channelUse: "pulse",
    pulseSurface: "pulse",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_freight_commodity",
    title: "Freight & commodity public + cite-only",
    description:
      "BTS TEU, Census FT-900, UN Comtrade. POLA/POLB and USACE are Tier 2. Cass and SCFI are cite-only.",
    family: "freight_commodity",
    sourceIds: [
      "src_bts_teu",
      "src_census_ft900",
      "src_un_comtrade",
      "src_pola",
      "src_polb",
      "src_cass_freight_index",
      "src_scfi",
      "src_usace",
    ],
    channelUse: "both",
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_license_required",
    title: "Paid feeds (license required)",
    description:
      "DAT, Freightos, Xeneta, Drewry, SONAR, LME, CME, ISM ROB, S&P CI, Fastmarkets, JOC. Placeholders — no fetch. Cass and SCFI live on Tier 2 as cite-only.",
    family: "mixed",
    sourceIds: LICENSE_REQUIRED_PLACEHOLDER_IDS,
    channelUse: "both",
    pulseSurface: "both",
    release: DATA_FACTORY_RELEASE,
  },
  {
    id: "pkg_public_procurement",
    title: "Public procurement notices & awards",
    description:
      "USAspending (Tier 1) and SAM.gov (Tier 2, careful). No tenant PO/invoice data.",
    family: "procurement",
    sourceIds: ["src_usaspending", "src_sam_gov"],
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
  {
    id: "pkg_news_osint",
    title: "Open-source news / OSINT (metadata)",
    description:
      "RSS → normalize → dedupe → event schema. Headlines + links only. Pulse = cited bullets. Full-text republish out of scope.",
    family: "news_osint",
    sourceIds: NEWS_OSINT_SOURCE_IDS,
    channelUse: "both",
    pulseSurface: "pulse",
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
      "News/OSINT: headlines + link OK; full-text republish is out of scope.",
    ],
  };
}

export function packageNewsOsintStream(): NewsOsintStream {
  return newsOsintMetadataStream([]);
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
