import { useGetMe } from "@workspace/api-client-react";
import type { TenantPolicy } from "@workspace/intelligence/contracts";

/**
 * Resolve the tenant's disclosure policy via `GET /me`. Falls back to
 * `"standard"` until the request settles so the citation renderer never
 * has an "undefined" branch — the same default the API server uses
 * when an org's `settings.disclosurePolicy` is missing.
 *
 * `useGetMe` is already cached for the session by React Query, so this
 * hook is effectively free to call from any component that needs to
 * decide what level of source provenance to surface.
 */
export function usePolicy(): TenantPolicy {
  const { data } = useGetMe();
  const policy = data?.org.disclosurePolicy;
  if (policy === "conservative" || policy === "standard" || policy === "analyst") {
    return policy;
  }
  return "standard";
}
