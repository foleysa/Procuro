/**
 * Captured DOL OSHA Establishment Search responses replayed by
 * `epa-osha-collectors-e2e.test.ts`.
 *
 * Each fixture mirrors the real
 * `https://www.osha.gov/pls/imis/establishment.json?establishment=<NAME>`
 * payload shape 1:1 — top-level `inspections` array, mixed numeric /
 * string penalty values, nested `violations` array, and at least one
 * row that the parser must skip (no `activity_nr` or no usable date)
 * so the live `parseOshaResponse` drop-paths are exercised end to end.
 *
 * Keyed by the supplier display name passed to the collector so the
 * stubbed `fetch` can route per-supplier requests deterministically.
 */

import type { OshaSearchResponse } from "../../src/lib/intelligence/collectors/osha-inspections";

export const OSHA_FIXTURE_RESPONSES: Readonly<
  Record<string, OshaSearchResponse>
> = {
  "Acme Manufacturing Inc": {
    inspections: [
      {
        activity_nr: "1234567.015",
        estab_name: "ACME MANUFACTURING INC",
        site_address: "123 Main St",
        site_city: "Houston",
        site_state: "TX",
        site_zip: "77002",
        open_date: "2024-08-15",
        close_case_date: "2024-09-01",
        naics_code: "332710",
        scope_label: "Partial",
        total_violations: "5",
        total_penalty: "35,000",
        violations: [
          {
            citation_id: "01001A",
            standard: "1910.147(c)(4)",
            gravity: 8,
            initial_penalty: 14502,
            current_penalty: 7251,
            citation_type: "Serious",
          },
          {
            citation_id: "01002B",
            standard: "1910.212(a)(1)",
            gravity: 5,
            initial_penalty: 4838,
            current_penalty: 2419,
            citation_type: "Other-than-Serious",
          },
        ],
      },
      {
        activity_nr: "9999999.001",
        estab_name: "ACME LOGISTICS",
        site_state: "OH",
        open_date: "2024-06-01",
        scope_label: "Accident",
        total_violations: 2,
        total_penalty: 9000,
        violations: [],
      },
      // Unusable row — no activity_nr → parser must drop it.
      {
        scope_label: "Partial",
        site_state: "CA",
        open_date: "2024-05-01",
      },
    ],
  },
  "Quiet Supplier LLC": {
    inspections: [],
  },
};
