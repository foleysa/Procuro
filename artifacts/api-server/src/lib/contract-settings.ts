/**
 * Per-tenant contract-renewal preferences stored in `orgs.settings`.
 *
 * `contractRenewalAlertDays` is the days-to-expiry threshold the daily
 * `renewal_alert_scan` worker uses to surface a contract as a renewal
 * alert. The same value drives the contract list / calendar
 * `derivedStatus` boundary so what the operator sees in the UI matches
 * what fires an alert. Defaults to 90, mirroring the
 * `contract_renegotiation_trigger` lever's "expiring <90d" definition
 * so the lever and the renewal alerts stay in sync.
 *
 * Lives in `lib/` (rather than alongside the contract route) so the
 * job handler in `lib/jobs/handlers.ts` can read the value without an
 * upstream import into `routes/`, which would invert the standard
 * routes-depend-on-lib layering.
 */

export const ORG_DEFAULT_RENEWAL_ALERT_DAYS = 90;
export const MAX_RENEWAL_ALERT_DAYS = 365;

export function readRenewalAlertDays(
  settings: Record<string, unknown> | null | undefined,
): number {
  const raw = settings?.["contractRenewalAlertDays"];
  if (
    typeof raw === "number" &&
    Number.isFinite(raw) &&
    raw >= 1 &&
    raw <= MAX_RENEWAL_ALERT_DAYS
  ) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_RENEWAL_ALERT_DAYS) {
      return n;
    }
  }
  return ORG_DEFAULT_RENEWAL_ALERT_DAYS;
}
