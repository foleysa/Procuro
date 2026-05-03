/**
 * Workbench-only static metadata for each registered collector.
 *
 * Most of what the Collector workbench renders comes from the live
 * registry row + the in-code `IntelligenceCollector` contract
 * (postureClass, disclosureTier, jurisdiction, retentionDays,
 * tenantOptInDefault, signalSchema). A handful of fields are
 * documentary — ToS link snapshot, PII classification, kill criteria,
 * downstream BQ tables and consumer panes — that the foundation
 * contract does not (yet) carry. Rather than burying these in scattered
 * comments, we collect them here so the Catalog / Posture / Lineage
 * tabs can render them from a single source of truth.
 *
 * This file is intentionally NOT a database table: these fields rarely
 * change, are committed alongside the collector implementation, and an
 * editable surface for them is out of scope for v0.
 */

import type { MarketSignalType } from "@workspace/db";

/** PII classification — drives the disclosure & retention lens. */
export type PiiClassification = "none" | "low" | "medium" | "high";

export interface CollectorWorkbenchMeta {
  /** ISO 3166-1 alpha-2 flag emoji for the jurisdiction. */
  flagEmoji: string;
  /** Snapshot of the source's terms-of-use / licensing page. */
  tosUrl: string;
  /** One-line license summary for the client-facing /data-sources view. */
  licenseNote: string;
  /** Logo / favicon URL used in the client-mode card. */
  logoUrl: string;
  /** PII classification — `none` for public macro feeds. */
  piiClassification: PiiClassification;
  /**
   * Conditions under which the platform team would activate the kill
   * switch for this source. Documentary; not enforced automatically.
   */
  killCriteria: string;
  /** Output signal types this collector emits. */
  outputSignalTypes: ReadonlyArray<MarketSignalType>;
  /** Scope kinds this collector populates on `market_signals` rows. */
  scopeKinds: ReadonlyArray<
    "material" | "category" | "supplier" | "sku" | "lane"
  >;
  /** Plain-English cadence summary. */
  cadenceLabel: string;
  /** Downstream BigQuery tables this collector writes into. */
  downstreamBqTables: ReadonlyArray<string>;
  /** Marts that consume the BQ rows. */
  downstreamMarts: ReadonlyArray<string>;
  /**
   * Lever / Fusion-Center pane consumers that read these signals.
   * Used by the Lineage tab for the bipartite graph view.
   */
  downstreamConsumers: ReadonlyArray<string>;
}

const COMMON_BQ_TABLES = ["market_signals", "collector_runs"];

/**
 * Static workbench metadata. Add a new entry whenever you register a
 * new collector — `getWorkbenchMeta(id)` falls back to a safe default
 * for collectors with no explicit entry, so nothing breaks at runtime,
 * but the Catalog / Lineage tabs will only show the fallback data.
 */
const WORKBENCH_META: Record<string, CollectorWorkbenchMeta> = {
  "fred-economic-index": {
    flagEmoji: "🇺🇸",
    tosUrl: "https://fred.stlouisfed.org/legal/",
    licenseNote:
      "Federal Reserve Bank of St. Louis FRED® API. Free for non-commercial use; attribution requested.",
    logoUrl: "https://fred.stlouisfed.org/images/fred-logo-2x.png",
    piiClassification: "none",
    killCriteria:
      "Persistent 5xx for >24h, schema drift in observation payload, FRED ToS revocation, or bulk-quota throttling beyond 120 rpm cap.",
    outputSignalTypes: ["economic_index"],
    scopeKinds: ["material", "category"],
    cadenceLabel: "Daily (latest observation per series)",
    downstreamBqTables: COMMON_BQ_TABLES,
    downstreamMarts: ["mart_material_ppi_trend"],
    downstreamConsumers: [
      "spot_vs_contract lever",
      "Fusion: Material PPI pane",
      "Opportunity rationale: contract-PPI benchmark",
    ],
  },
  "bls-economic-index": {
    flagEmoji: "🇺🇸",
    tosUrl: "https://www.bls.gov/bls/linksite.htm",
    licenseNote:
      "U.S. Bureau of Labor Statistics public data API. Free for any use; no attribution required.",
    logoUrl: "https://www.bls.gov/images/bls_emblem_blue.png",
    piiClassification: "none",
    killCriteria:
      "Persistent 5xx for >24h, daily 500-request soft cap exceeded, or BLS ToS revocation.",
    outputSignalTypes: ["economic_index"],
    scopeKinds: ["material", "category"],
    cadenceLabel: "Monthly (release-day pull)",
    downstreamBqTables: COMMON_BQ_TABLES,
    downstreamMarts: ["mart_material_ppi_trend", "mart_cpi_subindex_trend"],
    downstreamConsumers: [
      "spot_vs_contract lever",
      "Fusion: CPI sub-index pane",
      "Negotiation: supplier price-increase pushback",
    ],
  },
  "ecb-fx-rates": {
    flagEmoji: "🇪🇺",
    tosUrl:
      "https://www.ecb.europa.eu/services/disclaimer/html/index.en.html",
    licenseNote:
      "European Central Bank reference rates. Free re-use with source acknowledgement.",
    logoUrl:
      "https://www.ecb.europa.eu/shared/img/ecb_logo_blue.svg",
    piiClassification: "none",
    killCriteria:
      "ECB feed deprecation, schema drift in eurofxref-daily.xml, or sustained 5xx >24h.",
    outputSignalTypes: ["fx_rate"],
    scopeKinds: ["material"],
    cadenceLabel: "Daily (T-1 reference rates, ~16:00 CET)",
    downstreamBqTables: COMMON_BQ_TABLES,
    downstreamMarts: ["mart_fx_rate_history"],
    downstreamConsumers: [
      "fx_exposure lever",
      "Fusion: FX trend pane",
      "Supplier billing-currency exposure card",
    ],
  },
  "eia-energy": {
    flagEmoji: "🇺🇸",
    tosUrl: "https://www.eia.gov/about/copyrights_reuse.php",
    licenseNote:
      "U.S. Energy Information Administration Open Data. Free re-use with attribution.",
    logoUrl: "https://www.eia.gov/global/images/eia_logo.png",
    piiClassification: "none",
    killCriteria:
      "EIA API key revocation, persistent 5xx >24h, or repeated schema drift in series payload.",
    outputSignalTypes: ["economic_index"],
    scopeKinds: ["material"],
    cadenceLabel: "Weekly (latest observation per energy series)",
    downstreamBqTables: COMMON_BQ_TABLES,
    downstreamMarts: ["mart_energy_index_trend"],
    downstreamConsumers: [
      "spot_vs_contract lever (energy categories)",
      "Fusion: Energy index pane",
    ],
  },
  "usgs-mineral": {
    flagEmoji: "🇺🇸",
    tosUrl: "https://www.usgs.gov/information-policies-and-instructions",
    licenseNote:
      "U.S. Geological Survey National Minerals Information Center. Public-domain federal data; attribution encouraged.",
    logoUrl:
      "https://www.usgs.gov/themes/custom/usgs/img/dark-blue-usgs-logo.svg",
    piiClassification: "none",
    killCriteria:
      "DS-140 workbook layout drift (header rows shift), per-mineral file URL drift across the curated list, or sustained 5xx >24h on USGS S3 distribution.",
    outputSignalTypes: ["commodity_index"],
    scopeKinds: ["material"],
    cadenceLabel: "Annual (daily-poll, latest year per mineral)",
    downstreamBqTables: COMMON_BQ_TABLES,
    downstreamMarts: ["mart_commodity_index_trend"],
    downstreamConsumers: [
      "spot_vs_contract lever (critical-mineral categories)",
      "Fusion: Critical-mineral pane",
    ],
  },
  "world-bank-pink-sheet": {
    flagEmoji: "🌐",
    tosUrl: "https://data.worldbank.org/summary-terms-of-use",
    licenseNote:
      "World Bank Pink Sheet. CC BY 4.0 — free re-use with attribution.",
    logoUrl: "https://www.worldbank.org/content/dam/wbr-redesign/logos/wbg-header-en.svg",
    piiClassification: "none",
    killCriteria:
      "Pink Sheet schema drift (header rows shift), file format change, or sustained 5xx >24h.",
    outputSignalTypes: ["commodity_index"],
    scopeKinds: ["material"],
    cadenceLabel: "Monthly (early-month publication)",
    downstreamBqTables: COMMON_BQ_TABLES,
    downstreamMarts: ["mart_commodity_index_trend"],
    downstreamConsumers: [
      "spot_vs_contract lever (commodities)",
      "Fusion: Commodity-trend pane",
    ],
  },
  "epa-echo": {
    flagEmoji: "🇺🇸",
    tosUrl: "https://echo.epa.gov/help/web-services-faq",
    licenseNote:
      "U.S. EPA ECHO Web Services. Public-domain federal data; attribution requested.",
    logoUrl: "https://echo.epa.gov/themes/custom/echo/logo.png",
    piiClassification: "none",
    killCriteria:
      "Persistent 5xx for >24h, Case Search schema drift, or EPA ECHO ToS revocation.",
    outputSignalTypes: ["environmental_violation"],
    scopeKinds: ["supplier", "lane"],
    cadenceLabel: "Daily (per watched US supplier, capped per tick)",
    downstreamBqTables: COMMON_BQ_TABLES,
    downstreamMarts: ["mart_supplier_risk_timeline"],
    downstreamConsumers: [
      "Supplier 360: Risk & Filings tab",
      "Alerts inbox (environmental_violation kind)",
      "Fusion: Supplier-risk pane",
    ],
  },
  "osha-inspections": {
    flagEmoji: "🇺🇸",
    tosUrl: "https://www.osha.gov/laws-regs/regulations/standardnumber",
    licenseNote:
      "U.S. DOL OSHA Establishment Search. Public-domain federal data; no attribution required.",
    logoUrl: "https://www.osha.gov/themes/custom/osha_eta/logo.svg",
    piiClassification: "low",
    killCriteria:
      "Persistent 5xx for >24h, OSHA Establishment Search schema drift, or DOL ToS revocation.",
    outputSignalTypes: ["workplace_safety_incident"],
    scopeKinds: ["supplier", "lane"],
    cadenceLabel: "Daily (per watched US supplier, capped per tick)",
    downstreamBqTables: COMMON_BQ_TABLES,
    downstreamMarts: ["mart_supplier_risk_timeline"],
    downstreamConsumers: [
      "Supplier 360: Risk & Filings tab",
      "Alerts inbox (workplace_safety_incident kind)",
      "Fusion: Supplier-risk pane",
    ],
  },
  "published-commodity-index": {
    flagEmoji: "🌐",
    tosUrl: "https://www.lme.com/en/about/legal/terms-and-conditions",
    licenseNote:
      "Synthetic stand-in for published exchange indices used in dev environments.",
    logoUrl: "https://www.lme.com/static/img/lme-logo.svg",
    piiClassification: "none",
    killCriteria:
      "Synthetic feed: kill only if dev environment is leaking values to production tenants.",
    outputSignalTypes: ["commodity_index"],
    scopeKinds: ["material"],
    cadenceLabel: "On-demand (dev / smoke runs)",
    downstreamBqTables: COMMON_BQ_TABLES,
    downstreamMarts: ["mart_commodity_index_trend"],
    downstreamConsumers: ["spot_vs_contract lever (smoke / dev only)"],
  },
};

/**
 * Returns the workbench metadata for a collector, or a safe fallback
 * with empty consumer lists so the Catalog / Lineage tabs degrade
 * gracefully for new collectors registered without a corresponding
 * entry in `WORKBENCH_META`.
 */
export function getWorkbenchMeta(
  collectorId: string,
): CollectorWorkbenchMeta {
  return (
    WORKBENCH_META[collectorId] ?? {
      flagEmoji: "🌐",
      tosUrl: "",
      licenseNote: "",
      logoUrl: "",
      piiClassification: "none",
      killCriteria: "Not yet documented.",
      outputSignalTypes: [],
      scopeKinds: [],
      cadenceLabel: "On-demand",
      downstreamBqTables: COMMON_BQ_TABLES,
      downstreamMarts: [],
      downstreamConsumers: [],
    }
  );
}

export function listWorkbenchMetaIds(): string[] {
  return Object.keys(WORKBENCH_META);
}
