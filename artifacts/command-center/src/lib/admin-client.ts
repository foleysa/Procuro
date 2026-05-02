/**
 * Admin-page UI helpers and SCIM-group fetch wrappers.
 *
 * The bulk of the admin API (`/api/admin/users`, `/api/admin/api-keys`,
 * `/api/admin/audit-log`, `/api/admin/sso`, `/api/admin/tenant-settings`,
 * `/api/admin/whoami`) is documented under the `admin` tag in
 * `lib/api-spec/openapi.yaml` and consumed via the orval-generated React
 * Query hooks from `@workspace/api-client-react` (e.g.
 * `useListAdminUsers`, `useInviteAdminUser`, `useGetAdminSsoConfig`, …).
 *
 * The `/api/admin/scim/groups` surface was added later (task #151) and
 * is not yet in the OpenAPI spec, so we keep a thin hand-rolled fetch
 * wrapper here. Once the SCIM endpoints are documented, this client
 * shrinks back to just `ROLE_OPTIONS` + the `AdminUserRole` re-export.
 *
 * This module also holds copy/labelling that lives next to the page
 * rather than the spec — namely the role-picker option list with hint
 * text used by every role-bearing dropdown.
 */

import type { AdminUserRole } from "@workspace/api-client-react";

export type { AdminUserRole };

export interface AdminScimGroup {
  id: string;
  displayName: string;
  externalId: string | null;
  roleMapping: AdminUserRole | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const obj = JSON.parse(text) as { error?: string };
      if (obj?.error) detail = obj.error;
    } catch {
      // text already populated
    }
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const adminClient = {
  listScimGroups: () =>
    fetch("/api/admin/scim/groups").then((r) =>
      jsonOrThrow<AdminScimGroup[]>(r),
    ),
  setScimGroupRoleMapping: (id: string, roleMapping: AdminUserRole | null) =>
    fetch(`/api/admin/scim/groups/${id}/role-mapping`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleMapping }),
    }).then((r) =>
      jsonOrThrow<{
        id: string;
        displayName: string;
        roleMapping: AdminUserRole | null;
      }>(r),
    ),
};

export const ROLE_OPTIONS: Array<{
  value: AdminUserRole;
  label: string;
  hint: string;
}> = [
  {
    value: "org_admin",
    label: "Org admin",
    hint: "Full tenant control: users, SSO, API keys, settings.",
  },
  {
    value: "approver",
    label: "Approver",
    hint: "Approve / reject / execute opportunities, run cycles.",
  },
  {
    value: "analyst",
    label: "Analyst",
    hint: "Suggest, ingest, run analyses; cannot approve.",
  },
  {
    value: "read_only",
    label: "Read only",
    hint: "View everything, mutate nothing.",
  },
  {
    value: "auditor",
    label: "Auditor",
    hint: "Read everything plus the admin audit log.",
  },
];
