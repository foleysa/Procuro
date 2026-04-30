import { useQuery } from "@tanstack/react-query";
import type { AdminUserRole } from "./admin-client";

export interface WhoAmI {
  orgId: string | null;
  email: string;
  roles: AdminUserRole[];
  viaApiKey: boolean;
  authMode: string | null;
}

/**
 * Convenience hook around `/api/admin/whoami`. Returns the resolved RBAC
 * roles for the active tenant and a couple of derived booleans the UI
 * cares about. Falls back to `roles: []` on 401/403 so layout chrome can
 * still render for unauthenticated users.
 */
export function useMyRole(): {
  data: WhoAmI | undefined;
  isLoading: boolean;
  isOrgAdmin: boolean;
  isPlatformAdmin: boolean;
} {
  const q = useQuery({
    queryKey: ["whoami"],
    queryFn: async (): Promise<WhoAmI> => {
      const res = await fetch("/api/admin/whoami");
      if (!res.ok) {
        return { orgId: null, email: "", roles: [], viaApiKey: false, authMode: null };
      }
      return (await res.json()) as WhoAmI;
    },
    staleTime: 60_000,
  });
  const roles = q.data?.roles ?? [];
  return {
    data: q.data,
    isLoading: q.isLoading,
    isOrgAdmin: roles.includes("org_admin") || roles.includes("platform_admin"),
    isPlatformAdmin: roles.includes("platform_admin"),
  };
}
