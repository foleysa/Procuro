/**
 * S2P (Source-to-Pay) programme constants shared across Command Center
 * UI components. These are deliberately kept separate from hardcoded
 * component-level magic numbers so they can be updated from a single
 * source of truth (or later fetched from a tenant-config API endpoint).
 */

/**
 * Target share of acted-on spend that should be converted to Realized
 * Savings. Used to compute "Gap to Goal" in the Outcomes Header.
 *
 * Formula: Goal = CAPTURE_RATE_TARGET × captureDenominator
 *
 * captureDenominator = proposed + approved + executing + realized
 * (the full set of opportunities the engine has touched).
 */
export const CAPTURE_RATE_TARGET = 0.6;
