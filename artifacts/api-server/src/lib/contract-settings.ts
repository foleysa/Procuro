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
 * `contractRenewalEmailEnabled` is the per-tenant opt-in for the
 * owner-email side-channel attached to the renewal scan (Task #155).
 * Defaults to `false` so existing tenants do NOT receive a surprise
 * blast of renewal emails when this code first ships — operators must
 * explicitly turn it on in tenant settings before any owner emails
 * are sent. The flag is read inside the renewal scan so toggling it
 * takes effect on the very next scheduled run without a redeploy.
 *
 * Lives in `lib/` (rather than alongside the contract route) so the
 * job handler in `lib/jobs/handlers.ts` can read the value without an
 * upstream import into `routes/`, which would invert the standard
 * routes-depend-on-lib layering.
 */

export const ORG_DEFAULT_RENEWAL_ALERT_DAYS = 90;
export const MAX_RENEWAL_ALERT_DAYS = 365;

/**
 * Default for `contractRenewalEmailEnabled`. Intentionally `false` —
 * see file header for the spam-prevention rationale.
 */
export const ORG_DEFAULT_RENEWAL_EMAIL_ENABLED = false;

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

/**
 * Strict-true read of the renewal-email opt-in. Anything other than a
 * literal `true` (boolean) or the string `"true"` falls back to
 * `ORG_DEFAULT_RENEWAL_EMAIL_ENABLED` (`false`) so a typo in the
 * settings JSON can never accidentally enable the side-channel for a
 * tenant that didn't opt in.
 */
export function readRenewalEmailEnabled(
  settings: Record<string, unknown> | null | undefined,
): boolean {
  const raw = settings?.["contractRenewalEmailEnabled"];
  if (raw === true) return true;
  if (typeof raw === "string" && raw.toLowerCase() === "true") return true;
  return ORG_DEFAULT_RENEWAL_EMAIL_ENABLED;
}
