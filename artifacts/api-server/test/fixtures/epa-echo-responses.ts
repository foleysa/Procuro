/**
 * Captured EPA ECHO Case Search responses replayed by
 * `epa-osha-collectors-e2e.test.ts`.
 *
 * Each fixture mirrors the real
 * `https://echodata.epa.gov/echo/case_rest_services.get_cases?output=JSON&p_co=<NAME>`
 * payload shape 1:1 — `Results.QueryRows` envelope, mixed numeric /
 * string penalty values, and at least one row that the parser must
 * skip (no `case_number` or no usable date) so the live
 * `parseEchoCaseResponse` drop-paths are exercised end-to-end.
 *
 * Keyed by the supplier display name passed to the collector so the
 * stubbed `fetch` can route per-supplier requests deterministically.
 */

import type { EchoCaseSearchResponse } from "../../src/lib/intelligence/collectors/epa-echo";

export const EPA_ECHO_FIXTURE_RESPONSES: Readonly<
  Record<string, EchoCaseSearchResponse>
> = {
  "Acme Manufacturing Inc": {
    Results: {
      QueryRows: 3,
      Cases: [
        {
          case_number: "CWA-04-2024-1234",
          case_name: "United States v. Acme Manufacturing",
          case_law_section_code: "CWA",
          case_status: "Settled",
          settlement_entry_date: "2024-09-01",
          settlement_date: "2024-08-15",
          facility_name: "Acme Plant 3",
          facility_city: "Houston",
          facility_state: "TX",
          facility_zip: "77002",
          federal_penalty_assessed_amt: "50,000",
          complying_actions: "Pay penalty, install monitoring",
          case_url:
            "https://echo.epa.gov/enforcement-case-report?id=CWA-04-2024-1234",
        },
        {
          case_number: "RCRA-05-2024-9999",
          case_name: "United States v. Acme Hazardous",
          case_law_section_code: "RCRA",
          case_status: "Settled",
          settlement_date: "2024-07-20",
          facility_name: "Acme Plant 7",
          facility_state: "OH",
          federal_penalty_assessed_amt: 12500,
        },
        // Unusable row — no case_number → parser must drop it.
        {
          case_law_section_code: "CAA",
          settlement_date: "2024-06-01",
          facility_state: "CA",
        },
      ],
    },
  },
  // Empty supplier — pins that a 200 with zero cases yields zero
  // drafts and still records a raw payload (audit trail).
  "Quiet Supplier LLC": {
    Results: {
      QueryRows: 0,
      Cases: [],
    },
  },
};
