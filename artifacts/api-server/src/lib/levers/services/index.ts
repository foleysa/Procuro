/**
 * Tier-5 Services-band lever analyzers (task #216).
 *
 * Four levers route to the Services band per the bands seed
 * (`lib/db/seeds/taxonomy.sql`):
 *   - `services_rate_card_benchmark`  (also dual-banded to Concentrated rank 2)
 *   - `scope_management`
 *   - `hours_audit`
 *   - `sow_to_msa_conversion`         (also dual-banded to Concentrated rank 2)
 */

import type { LeverAnalyzer } from "../types";
import { servicesRateCardBenchmarkLever } from "./rate-card-benchmark";
import { scopeManagementLever } from "./scope-management";
import { hoursAuditLever } from "./hours-audit";
import { sowToMsaConversionLever } from "./sow-to-msa-conversion";

export {
  servicesRateCardBenchmarkLever,
  scopeManagementLever,
  hoursAuditLever,
  sowToMsaConversionLever,
};

export const SERVICES_LEVERS: LeverAnalyzer[] = [
  servicesRateCardBenchmarkLever,
  scopeManagementLever,
  hoursAuditLever,
  sowToMsaConversionLever,
];
