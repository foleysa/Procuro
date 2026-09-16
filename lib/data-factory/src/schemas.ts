/**
 * Layer A observation schemas — strengthened Tier 1 (all 15) plus
 * Tier 2 file/CSV shapes. Fetch stubs return observations: [].
 */

export interface LayerAFieldSchema {
  name: string;
  type: "string" | "number" | "boolean" | "datetime";
  required: boolean;
  note: string;
}

export interface LayerAObservationSchema {
  sourceId: string;
  title: string;
  recordName: string;
  fields: readonly LayerAFieldSchema[];
  liveFetch: false;
}

function fields(
  rows: Array<[string, LayerAFieldSchema["type"], boolean, string]>,
): LayerAFieldSchema[] {
  return rows.map(([name, type, required, note]) => ({
    name,
    type,
    required,
    note,
  }));
}

function schema(
  sourceId: string,
  title: string,
  recordName: string,
  fieldRows: Array<[string, LayerAFieldSchema["type"], boolean, string]>,
): LayerAObservationSchema {
  return {
    sourceId,
    title,
    recordName,
    fields: fields(fieldRows),
    liveFetch: false,
  };
}

export const TIER1_SCHEMAS: readonly LayerAObservationSchema[] = [
  schema("src_bls", "BLS PPI observation", "BlsPpiObservation", [
    ["seriesId", "string", true, "BLS timeseries id, e.g. WPU101"],
    ["period", "string", true, "BLS year + period (M01…)"],
    ["value", "number", false, "Index value; omit if BLS sends '-'"],
    ["latest", "boolean", false, "BLS latest flag when present"],
  ]),
  schema("src_fred", "FRED series observation", "FredObservation", [
    ["seriesId", "string", true, "FRED series id, e.g. WPU101"],
    ["observedOn", "datetime", true, "FRED observation date"],
    ["value", "number", false, "Numeric; FRED '.' means missing"],
    ["unit", "string", true, "Series unit / index"],
  ]),
  schema("src_eia", "EIA v2 series observation", "EiaObservation", [
    ["seriesId", "string", true, "EIA v2 series id, e.g. PET.RWTC.D"],
    ["period", "string", true, "EIA period token"],
    ["value", "number", false, "Datapoint; omit if null"],
    ["unit", "string", true, "USD/bbl, USD/gal, …"],
  ]),
  schema("src_usda_mymarketnews", "MyMarketNews report row", "UsdaMmnRow", [
    ["reportId", "string", true, "MARS report slug / id"],
    ["slugName", "string", false, "Commodity / market slug"],
    ["reportDate", "datetime", false, "Report date"],
    ["officeName", "string", false, "AMS market office"],
    ["value", "number", false, "Quoted price when AMS publishes one"],
    ["unit", "string", false, "Published unit"],
  ]),
  schema(
    "src_openfda_food_enforcement",
    "openFDA food enforcement",
    "OpenFdaFoodEnforcement",
    [
      ["recallNumber", "string", true, "recall_number"],
      ["classification", "string", false, "Class I / II / III"],
      ["status", "string", false, "Ongoing / Completed / Terminated"],
      ["recallingFirm", "string", false, "Public firm name"],
      ["reasonForRecall", "string", false, "FDA reason text"],
      ["reportDate", "datetime", false, "report_date"],
    ],
  ),
  schema("src_openfda_recalls", "openFDA drug/device enforcement", "OpenFdaRecall", [
    ["recallNumber", "string", true, "recall_number"],
    ["productType", "string", false, "drug | device"],
    ["classification", "string", false, "Class I / II / III"],
    ["recallingFirm", "string", false, "Public firm name"],
    ["reportDate", "datetime", false, "report_date"],
  ]),
  schema("src_ofac_sdn", "OFAC SDN entry", "OfacSdnEntry", [
    ["uid", "string", true, "SDN uid"],
    ["name", "string", true, "Primary name"],
    ["sdnType", "string", false, "Individual / Entity / Vessel / Aircraft"],
    ["program", "string", false, "Sanctions program"],
    ["sourceFormat", "string", false, "xml | csv"],
  ]),
  schema("src_federal_register", "Federal Register document", "FederalRegisterDoc", [
    ["documentNumber", "string", true, "FR document_number"],
    ["title", "string", true, "Document title"],
    ["type", "string", false, "Rule / Proposed Rule / Notice"],
    ["publicationDate", "datetime", false, "publication_date"],
    ["htmlUrl", "string", false, "Canonical FR URL"],
  ]),
  schema("src_sec_edgar", "EDGAR submission", "EdgarSubmission", [
    ["cik", "string", true, "Zero-padded CIK"],
    ["accessionNumber", "string", true, "Accession"],
    ["form", "string", true, "10-K / 10-Q / 8-K / …"],
    ["filedAt", "datetime", false, "Filing date"],
    ["entityName", "string", false, "Issuer name"],
  ]),
  schema("src_bts_teu", "BTS monthly TEU (Socrata)", "BtsMonthlyTeu", [
    ["period", "string", true, "Month as published"],
    ["portOrRegion", "string", false, "Port / coast / national"],
    ["teu", "number", false, "TEU only if the Socrata row has a number"],
    ["datasetId", "string", false, "Socrata 4×4 — set only after a human pins it"],
  ]),
  schema("src_weather_gov", "NWS active alert", "NwsAlert", [
    ["alertId", "string", true, "GeoJSON feature id"],
    ["event", "string", true, "Alert event name"],
    ["severity", "string", false, "NWS severity"],
    ["areaDesc", "string", false, "Affected area"],
    ["onset", "datetime", false, "Onset"],
  ]),
  schema("src_usaspending", "USAspending award", "UsaSpendingAward", [
    ["awardId", "string", true, "Generated unique award id"],
    ["recipientName", "string", false, "Public recipient"],
    ["awardAmount", "number", false, "Awarded amount"],
    ["naics", "string", false, "NAICS when present"],
    ["startDate", "datetime", false, "Period of performance start"],
  ]),
  schema("src_census_ft900", "FT-900 exhibit row", "CensusFt900Row", [
    ["period", "string", true, "Month/year of the release"],
    ["exhibit", "string", true, "FT-900 exhibit id"],
    ["flow", "string", false, "export | import | balance"],
    ["valueUsd", "number", false, "Published dollar value only"],
  ]),
  schema("src_census_m3", "Census M3 observation", "CensusM3Observation", [
    ["seasonalAdj", "string", false, "S / U"],
    ["categoryCode", "string", true, "M3 category"],
    ["cellValue", "number", false, "Shipments / inventories / orders"],
    ["timeSlotId", "string", true, "YYYY-MM"],
  ]),
  schema("src_world_bank_pink_sheet", "Pink Sheet monthly", "WorldBankPinkSheet", [
    ["commodity", "string", true, "Pink Sheet series name"],
    ["period", "string", true, "YYYY-MM"],
    ["value", "number", false, "Published price / index"],
    ["unit", "string", false, "Unit from the workbook"],
  ]),
  schema("src_un_comtrade", "UN Comtrade row", "UnComtradeRow", [
    ["period", "string", true, "Year or year-month"],
    ["reporter", "string", true, "Reporter ISO"],
    ["partner", "string", false, "Partner ISO"],
    ["cmdCode", "string", false, "HS command code"],
    ["tradeValue", "number", false, "Free-tier published value only"],
    ["flowCode", "string", false, "M / X"],
  ]),
];

export const TIER2_SCHEMAS: readonly LayerAObservationSchema[] = [
  schema("src_pola", "POLA published container stat", "PolaContainerStat", [
    ["period", "string", true, "Month/year on the page"],
    ["metric", "string", true, "Page label"],
    ["value", "number", false, "Only if the page states a number"],
  ]),
  schema("src_polb", "POLB published port stat", "PolbPortStat", [
    ["period", "string", true, "Month/year on the page"],
    ["metric", "string", true, "Page label"],
    ["value", "number", false, "Only if the page states a number"],
  ]),
  schema("src_usgs_mcs", "USGS MCS unit value", "UsgsMcsRow", [
    ["commodity", "string", true, "MCS commodity"],
    ["year", "string", true, "Survey year"],
    ["unitValue", "number", false, "Published unit value"],
  ]),
  schema("src_usda_ers", "ERS data-product row", "UsdaErsRow", [
    ["productId", "string", true, "ERS product slug"],
    ["period", "string", false, "As published"],
    ["value", "number", false, "Published cell only"],
  ]),
  schema("src_cpsc", "CPSC recall", "CpscRecall", [
    ["recallNumber", "string", true, "CPSC recall number"],
    ["title", "string", true, "Recall title"],
    ["recallDate", "datetime", false, "Announcement date"],
    ["manufacturer", "string", false, "Named manufacturer"],
  ]),
  schema("src_beige_book", "Beige Book edition", "BeigeBookEdition", [
    ["editionDate", "datetime", true, "Release date"],
    ["district", "string", false, "Reserve district or National"],
    ["htmlUrl", "string", true, "Canonical Fed URL"],
  ]),
  schema("src_naics", "NAICS code", "NaicsCode", [
    ["code", "string", true, "NAICS code"],
    ["title", "string", true, "Official title"],
    ["year", "string", true, "Manual year"],
  ]),
  schema("src_unspsc", "UNSPSC code", "UnspscCode", [
    ["code", "string", true, "UNSPSC code"],
    ["title", "string", true, "Official title"],
    ["version", "string", false, "Download version"],
  ]),
  schema("src_nhc", "NHC advisory", "NhcAdvisory", [
    ["advisoryId", "string", true, "Storm / advisory id"],
    ["stormName", "string", false, "Name if named"],
    ["issuedAt", "datetime", false, "Advisory time"],
    ["gisUrl", "string", false, "NHC GIS asset"],
  ]),
  schema("src_fda_dashboard", "FDA dashboard recall card", "FdaDashboardRecall", [
    ["title", "string", true, "Card title"],
    ["firm", "string", false, "Named firm"],
    ["postedAt", "datetime", false, "Dashboard date"],
    ["htmlUrl", "string", false, "Source page"],
  ]),
  schema("src_sam_gov", "SAM.gov opportunity", "SamGovOpportunity", [
    ["noticeId", "string", true, "SAM notice id"],
    ["title", "string", true, "Notice title"],
    ["postedDate", "datetime", false, "Posted date"],
    ["naics", "string", false, "NAICS"],
  ]),
  schema("src_imf_primary_commodity", "IMF commodity monthly", "ImfCommodityMonthly", [
    ["commodity", "string", true, "IMF series name"],
    ["period", "string", true, "YYYY-MM"],
    ["value", "number", false, "Published index / price"],
  ]),
  schema("src_usace", "USACE waterborne row", "UsaceWaterborneRow", [
    ["period", "string", true, "Report year"],
    ["portOrWaterway", "string", false, "As published"],
    ["tons", "number", false, "Published tonnage only if the file is open"],
  ]),
  schema("src_epa_tri", "TRI facility release", "EpaTriRow", [
    ["facilityId", "string", true, "TRIFID"],
    ["facilityName", "string", false, "Public facility name"],
    ["chemical", "string", false, "TRI chemical"],
    ["year", "string", true, "Reporting year"],
    ["totalRelease", "number", false, "Published pounds"],
  ]),
];

const OSINT_EVENT_FIELDS: Array<
  [string, LayerAFieldSchema["type"], boolean, string]
> = [
  ["title", "string", true, "Headline only — not article body"],
  ["url", "string", true, "Canonical link"],
  ["published", "datetime", false, "Feed pubDate when present"],
  ["source", "string", true, "Catalog source id"],
  ["entities", "string", false, "JSON string[] of named entities; empty if unknown"],
  ["event_type", "string", true, "policy | maritime | freight | hazard | quake | storm | other"],
  ["severity", "string", true, "info | watch | warning | severe | unknown"],
];

export const NEWS_OSINT_SCHEMAS: readonly LayerAObservationSchema[] = [
  schema("src_cbp_csms", "CBP CSMS headline", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_freightwaves_rss", "FreightWaves headline", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_supply_chain_dive", "Supply Chain Dive headline", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_gcaptain", "gCaptain headline", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_maritime_executive", "Maritime Executive headline", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_splash247", "Splash247 headline", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_loadstar", "Loadstar headline", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_container_news", "Container News headline", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_bbc_business", "BBC Business headline", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_gdelt", "GDELT doc/event", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_google_news_rss", "Google News headline (fragile)", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_gdacs", "GDACS alert", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_usgs_quakes", "USGS significant quake", "OsintEvent", OSINT_EVENT_FIELDS),
  schema("src_nhc_products", "NHC product headline", "OsintEvent", OSINT_EVENT_FIELDS),
];

export const WIRE_FIRST_SCHEMAS = TIER1_SCHEMAS;

const ALL = [...TIER1_SCHEMAS, ...TIER2_SCHEMAS, ...NEWS_OSINT_SCHEMAS];
const SCHEMA_BY_ID = new Map(ALL.map((s) => [s.sourceId, s]));

export function getLayerAObservationSchema(
  sourceId: string,
): LayerAObservationSchema | undefined {
  return SCHEMA_BY_ID.get(sourceId);
}
