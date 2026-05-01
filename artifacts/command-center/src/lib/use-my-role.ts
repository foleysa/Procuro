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
 *
 * `hasRole(role)` returns true for the named role or any role that
 * outranks it on the platform→org→approver→analyst→read_only ladder.
 * Used by the IA nav-grouping (#199) to gate items per the design doc.
 */
export function useMyRole(): {
  data: WhoAmI | undefined;
  isLoading: boolean;
  isOrgAdmin: boolean;
  isPlatformAdmin: boolean;
  hasRole: (role: AdminUserRole) => boolean;
  isSignedIn: boolean;
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
  // Hierarchy: higher roles satisfy lower role checks. Order matters —
  // index = strength.
  const HIERARCHY: AdminUserRole[] = [
    "read_only",
    "auditor",
    "analyst",
    "approver",
    "org_admin",
    "platform_admin",
  ];
  const myStrength = roles.reduce((acc, r) => {
    const i = HIERARCHY.indexOf(r);
    return i > acc ? i : acc;
  }, -1);
  const hasRole = (role: AdminUserRole): boolean => {
    const need = HIERARCHY.indexOf(role);
    if (need < 0) return false;
    return myStrength >= need;
  };
  return {
    data: q.data,
    isLoading: q.isLoading,
    isOrgAdmin: roles.includes("org_admin") || roles.includes("platform_admin"),
    isPlatformAdmin: roles.includes("platform_admin"),
    hasRole,
    isSignedIn: roles.length > 0,
  };
}
