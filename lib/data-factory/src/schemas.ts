/**
 * Layer A observation schemas for Day 0 wire-first sources.
 *
 * These describe the record we *would* persist. Fetch stubs return
 * `observations: []` — never invented values.
 *
 * Cited endpoints:
 *   FRED      https://api.stlouisfed.org/fred/series/observations
 *   EIA v2    https://api.eia.gov/v2/seriesid/{seriesId}
 *   openFDA   https://api.fda.gov/food/enforcement.json
 *   OFAC SDN  https://www.treasury.gov/ofac/downloads/sdn.xml
 *   NWS       https://api.weather.gov/alerts/active
 *   BTS TEU   https://data.bts.gov/
 *   POLA      https://www.portoflosangeles.org/business/statistics/container-statistics
 *   POLB      https://polb.com/business/port-statistics/
 *   Cass      cite-only — no schema fetch
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
  /** Empty on Day 0. Typed so packages can advertise the shape. */
  recordName: string;
  fields: readonly LayerAFieldSchema[];
  liveFetch: false;
}

const FRED_FIELDS: readonly LayerAFieldSchema[] = [
  {
    name: "seriesId",
    type: "string",
    required: true,
    note: "FRED series id, e.g. WPU101 (PPI iron and steel)",
  },
  {
    name: "observedOn",
    type: "datetime",
    required: true,
    note: "FRED observation `date`",
  },
  {
    name: "value",
    type: "number",
    required: false,
    note: "Numeric observation; FRED '.' means missing — do not invent",
  },
  {
    name: "unit",
    type: "string",
    required: true,
    note: "Index or published unit from the series metadata",
  },
];

const EIA_FIELDS: readonly LayerAFieldSchema[] = [
  {
    name: "seriesId",
    type: "string",
    required: true,
    note: "EIA v2 series id, e.g. PET.RWTC.D",
  },
  {
    name: "period",
    type: "string",
    required: true,
    note: "EIA `period` (daily/weekly/monthly token)",
  },
  {
    name: "value",
    type: "number",
    required: false,
    note: "EIA datapoint value; omit if upstream is null",
  },
  {
    name: "unit",
    type: "string",
    required: true,
    note: "Canonical unit (USD/bbl, USD/gal, …)",
  },
];

const OPENFDA_FIELDS: readonly LayerAFieldSchema[] = [
  {
    name: "recallNumber",
    type: "string",
    required: true,
    note: "openFDA `recall_number`",
  },
  {
    name: "classification",
    type: "string",
    required: false,
    note: "Class I / II / III",
  },
  {
    name: "status",
    type: "string",
    required: false,
    note: "Ongoing / Completed / Terminated",
  },
  {
    name: "recallingFirm",
    type: "string",
    required: false,
    note: "Public firm name — not a tenant supplier id",
  },
  {
    name: "reasonForRecall",
    type: "string",
    required: false,
    note: "FDA reason text",
  },
  {
    name: "reportDate",
    type: "datetime",
    required: false,
    note: "FDA `report_date`",
  },
];

const OFAC_FIELDS: readonly LayerAFieldSchema[] = [
  {
    name: "uid",
    type: "string",
    required: true,
    note: "SDN `uid`",
  },
  {
    name: "name",
    type: "string",
    required: true,
    note: "Primary SDN name",
  },
  {
    name: "sdnType",
    type: "string",
    required: false,
    note: "Individual / Entity / Vessel / Aircraft",
  },
  {
    name: "program",
    type: "string",
    required: false,
    note: "Sanctions program code",
  },
];

const NWS_FIELDS: readonly LayerAFieldSchema[] = [
  {
    name: "alertId",
    type: "string",
    required: true,
    note: "NWS GeoJSON feature id",
  },
  {
    name: "event",
    type: "string",
    required: true,
    note: "Alert event name",
  },
  {
    name: "severity",
    type: "string",
    required: false,
    note: "NWS severity",
  },
  {
    name: "areaDesc",
    type: "string",
    required: false,
    note: "Affected area text",
  },
  {
    name: "onset",
    type: "datetime",
    required: false,
    note: "Alert onset",
  },
];

const BTS_TEU_FIELDS: readonly LayerAFieldSchema[] = [
  {
    name: "period",
    type: "string",
    required: true,
    note: "BTS reporting period",
  },
  {
    name: "portOrRegion",
    type: "string",
    required: false,
    note: "Port / coast / national rollup when present",
  },
  {
    name: "teu",
    type: "number",
    required: false,
    note: "Twenty-foot equivalent units — only if BTS publishes a number",
  },
];

const PORT_PAGE_FIELDS: readonly LayerAFieldSchema[] = [
  {
    name: "period",
    type: "string",
    required: true,
    note: "Month/year as published on the public page",
  },
  {
    name: "metric",
    type: "string",
    required: true,
    note: "e.g. loaded inbound TEU — copied from the page label",
  },
  {
    name: "value",
    type: "number",
    required: false,
    note: "Only if the public page states a number; never estimated",
  },
];

export const WIRE_FIRST_SCHEMAS: readonly LayerAObservationSchema[] = [
  {
    sourceId: "src_fred",
    title: "FRED series observation",
    recordName: "FredObservation",
    fields: FRED_FIELDS,
    liveFetch: false,
  },
  {
    sourceId: "src_eia",
    title: "EIA v2 series observation",
    recordName: "EiaObservation",
    fields: EIA_FIELDS,
    liveFetch: false,
  },
  {
    sourceId: "src_openfda_food_enforcement",
    title: "openFDA food enforcement event",
    recordName: "OpenFdaFoodEnforcement",
    fields: OPENFDA_FIELDS,
    liveFetch: false,
  },
  {
    sourceId: "src_ofac_sdn",
    title: "OFAC SDN entry",
    recordName: "OfacSdnEntry",
    fields: OFAC_FIELDS,
    liveFetch: false,
  },
  {
    sourceId: "src_weather_gov",
    title: "NWS active alert",
    recordName: "NwsAlert",
    fields: NWS_FIELDS,
    liveFetch: false,
  },
  {
    sourceId: "src_bts_teu",
    title: "BTS TEU observation",
    recordName: "BtsTeuObservation",
    fields: BTS_TEU_FIELDS,
    liveFetch: false,
  },
  {
    sourceId: "src_pola",
    title: "POLA published container statistic",
    recordName: "PolaContainerStat",
    fields: PORT_PAGE_FIELDS,
    liveFetch: false,
  },
  {
    sourceId: "src_polb",
    title: "POLB published port statistic",
    recordName: "PolbPortStat",
    fields: PORT_PAGE_FIELDS,
    liveFetch: false,
  },
];

const SCHEMA_BY_ID = new Map(
  WIRE_FIRST_SCHEMAS.map((s) => [s.sourceId, s]),
);

export function getLayerAObservationSchema(
  sourceId: string,
): LayerAObservationSchema | undefined {
  return SCHEMA_BY_ID.get(sourceId);
}
