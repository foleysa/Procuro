/**
 * Captured USDA NASS QuickStats `/api_GET/` responses for the curated
 * commodity series exercised by `usda-nass-economic-index-fetch.test.ts`.
 *
 * Each entry is a representative subset of what NASS actually returns
 * for a single (commodity_desc + class_desc + statisticcat_desc + ...)
 * filter combination — three monthly observations, plus one
 * "MARKETING YEAR" row to pin that the live collector's
 * `selectLatestMonthly` can never let an annual roll-up outrank a real
 * calendar month.
 *
 * The shape and field names mirror NASS responses 1:1 so the mocked
 * `fetch` returns bytes that round-trip through the production parser
 * unchanged. Numeric strings are intentionally returned with thousands
 * separators where NASS does, and the suppression marker "(D)" appears
 * in the milk fixture so the parser's drop-null path is exercised end
 * to end.
 *
 * The cotton fixture is intentionally empty — paired with the
 * `NO_RECORDS_BODY` sentinel, it lets the test pin the "NASS returns
 * 400 'no records found matching this query'" path so a temporarily
 * empty series can never crash a run.
 */

import type { NassRow } from "../../src/lib/intelligence/collectors/usda-nass-economic-index";

export interface NassFixtureResponse {
  /**
   * Rows the mocked fetch should return as the JSON `data` array.
   * `null` means "respond with HTTP 400 + NO_RECORDS_BODY" so callers
   * can exercise the no-records path explicitly.
   */
  data: NassRow[] | null;
}

/**
 * The literal HTTP body NASS returns alongside its 400 "no records"
 * response. Pinned here so the parser keeps treating that exact string
 * as an empty result rather than a transport failure.
 */
export const NO_RECORDS_BODY =
  '{"error":["No records found matching the query criteria"]}';

/**
 * Keyed by `commodity_desc` (the NASS query parameter that uniquely
 * identifies each curated series in the test). Anything not listed
 * here will be returned as a 200 with an empty `data` array so
 * non-curated series in `NASS_SERIES` don't leak drafts into the
 * fixture-driven assertions.
 */
export const USDA_NASS_FIXTURE_RESPONSES: Readonly<
  Record<string, NassFixtureResponse>
> = {
  CORN: {
    data: [
      {
        short_desc: "CORN, GRAIN - PRICE RECEIVED, MEASURED IN $ / BU",
        commodity_desc: "CORN",
        year: "2025",
        reference_period_desc: "JAN",
        value: "4.20",
        unit_desc: "$ / BU",
        load_time: "2025-02-28 15:00:00",
      },
      {
        short_desc: "CORN, GRAIN - PRICE RECEIVED, MEASURED IN $ / BU",
        commodity_desc: "CORN",
        year: "2025",
        reference_period_desc: "FEB",
        value: "4.35",
        unit_desc: "$ / BU",
        load_time: "2025-03-28 15:00:00",
      },
      {
        short_desc: "CORN, GRAIN - PRICE RECEIVED, MEASURED IN $ / BU",
        commodity_desc: "CORN",
        year: "2025",
        reference_period_desc: "MAR",
        value: "4.55",
        unit_desc: "$ / BU",
        load_time: "2025-04-28 15:00:00",
      },
      // Annual roll-up: must not outrank the MAR row above.
      {
        short_desc: "CORN, GRAIN - PRICE RECEIVED, MEASURED IN $ / BU",
        commodity_desc: "CORN",
        year: "2024",
        reference_period_desc: "MARKETING YEAR",
        value: "4.80",
        unit_desc: "$ / BU",
        load_time: "2025-09-30 15:00:00",
      },
    ],
  },
  WHEAT: {
    data: [
      {
        short_desc: "WHEAT - PRICE RECEIVED, MEASURED IN $ / BU",
        commodity_desc: "WHEAT",
        year: "2025",
        reference_period_desc: "FEB",
        value: "5.60",
        unit_desc: "$ / BU",
      },
      {
        short_desc: "WHEAT - PRICE RECEIVED, MEASURED IN $ / BU",
        commodity_desc: "WHEAT",
        year: "2025",
        reference_period_desc: "MAR",
        value: "5.85",
        unit_desc: "$ / BU",
      },
    ],
  },
  SOYBEANS: {
    data: [
      {
        short_desc: "SOYBEANS - PRICE RECEIVED, MEASURED IN $ / BU",
        commodity_desc: "SOYBEANS",
        year: "2025",
        reference_period_desc: "MAR",
        value: "10.25",
        unit_desc: "$ / BU",
      },
    ],
  },
  MILK: {
    data: [
      {
        short_desc: "MILK, ALL - PRICE RECEIVED, MEASURED IN $ / CWT",
        commodity_desc: "MILK",
        year: "2025",
        reference_period_desc: "JAN",
        value: "22.10",
        unit_desc: "$ / CWT",
      },
      // NASS suppression marker — must yield no draft.
      {
        short_desc: "MILK, ALL - PRICE RECEIVED, MEASURED IN $ / CWT",
        commodity_desc: "MILK",
        year: "2025",
        reference_period_desc: "FEB",
        value: "(D)",
        unit_desc: "$ / CWT",
      },
      {
        short_desc: "MILK, ALL - PRICE RECEIVED, MEASURED IN $ / CWT",
        commodity_desc: "MILK",
        year: "2025",
        reference_period_desc: "MAR",
        value: "1,234.50",
        unit_desc: "$ / CWT",
      },
    ],
  },
  CHEESE: {
    data: [
      {
        short_desc: "CHEESE - PRICE RECEIVED",
        commodity_desc: "CHEESE",
        year: "2025",
        reference_period_desc: "MAR",
        value: "1.85",
        unit_desc: "$ / LB",
      },
    ],
  },
  BUTTER: {
    data: [
      {
        short_desc: "BUTTER - PRICE RECEIVED",
        commodity_desc: "BUTTER",
        year: "2025",
        reference_period_desc: "MAR",
        value: "2.40",
        unit_desc: "$ / LB",
      },
    ],
  },
  CATTLE: {
    data: [
      {
        short_desc:
          "CATTLE, STEERS & HEIFERS - PRICE RECEIVED, MEASURED IN $ / CWT",
        commodity_desc: "CATTLE",
        year: "2025",
        reference_period_desc: "MAR",
        value: "198.50",
        unit_desc: "$ / CWT",
      },
    ],
  },
  HOGS: {
    data: [
      {
        short_desc: "HOGS - PRICE RECEIVED, MEASURED IN $ / CWT",
        commodity_desc: "HOGS",
        year: "2025",
        reference_period_desc: "MAR",
        value: "67.20",
        unit_desc: "$ / CWT",
      },
    ],
  },
  CHICKENS: {
    data: [
      {
        short_desc: "CHICKENS, BROILERS - PRICE RECEIVED",
        commodity_desc: "CHICKENS",
        year: "2025",
        reference_period_desc: "MAR",
        value: "0.65",
        unit_desc: "$ / LB",
      },
    ],
  },
  // Empty series — paired with the no-records 400 path below.
  COTTON: {
    data: null,
  },
};
