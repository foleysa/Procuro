/**
 * Per-tenant disclosure-policy helpers.
 *
 * The intelligence subsystem ships a typed `TenantPolicy` literal union
 * (`conservative` | `standard` | `analyst`) that drives `renderInsight()`
 * in `@workspace/intelligence/tier`. We don't yet maintain a dedicated DB
 * column for this — the value is stored alongside other per-tenant
 * preferences inside `orgs.settings` (a JSONB column), under the
 * `disclosurePolicy` key. Centralising the read here ensures every API
 * handler that surfaces a policy applies the same default + validation.
 */

import type { TenantPolicy } from "@workspace/intelligence";

const VALID_POLICIES: readonly TenantPolicy[] = [
  "conservative",
  "standard",
  "analyst",
];

export const DEFAULT_DISCLOSURE_POLICY: TenantPolicy = "standard";

/**
 * Read the active disclosure policy from an org's `settings` JSON.
 * Returns `DEFAULT_DISCLOSURE_POLICY` when the value is absent or
 * doesn't match a known policy literal — surfacing an unknown policy
 * to the renderer would silently disable citation rendering, so we
 * fail closed onto the standard tier.
 */
export function readDisclosurePolicy(
  settings: Record<string, unknown> | null | undefined,
): TenantPolicy {
  const raw = settings?.["disclosurePolicy"];
  if (typeof raw === "string" && (VALID_POLICIES as readonly string[]).includes(raw)) {
    return raw as TenantPolicy;
  }
  return DEFAULT_DISCLOSURE_POLICY;
}
