/**
 * Hand-rolled fetch wrappers for the `/api/admin/*` and `/api/scim/v2/*`
 * endpoints. The product OpenAPI spec at `lib/api-spec/openapi.yaml`
 * describes the customer-facing surface; the admin surface is private,
 * tenant-scoped, and intentionally outside the spec — this module
 * provides typed access without bloating the spec.
 *
 * Conventions match the rest of the app:
 *   - Active org is read from `localStorage.activeOrgId` and forwarded
 *     by the global fetch shim in `main.tsx` as the `x-org-id` header.
 *   - All errors are surfaced as a `Promise.reject(new Error(...))`
 *     with the server-supplied error string when present.
 */

export type AdminUserRole =
  | "platform_admin"
  | "org_admin"
  | "approver"
  | "analyst"
  | "read_only"
  | "auditor";

export interface AdminUserRow {
  id: string;
  userId: string;
  email: string;
  role: AdminUserRole;
  grantedVia: string;
  grantedBy: string;
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
}

export interface AdminApiKeyRow {
  id: string;
  label: string;
  prefix: string;
  scopeRole: AdminUserRole;
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotatedFromId: string | null;
}

export interface AdminApiKeyIssued extends AdminApiKeyRow {
  /** Plaintext bearer; shown ONCE. */
  secret: string;
}

export interface AdminAuditRow {
  id: string;
  actor: string;
  action: string;
  targetId: string | null;
  targetLabel: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AdminSsoConfig {
  enabled: boolean;
  protocol: "saml" | "oidc";
  idpName: string;
  emailDomains: string[];
  clerkConnectionId: string | null;
  metadataUrl: string | null;
  notes: string | null;
  scimEnabled: boolean;
}

export interface AdminTenantSettings {
  successFeePct?: number;
  baseCurrency?: string;
  disclosurePolicy?: "conservative" | "standard" | "analyst";
  contractRenewalAlertDays?: number;
  retentionDefaultDays?: number;
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
  // ---- Users
  listUsers: () =>
    fetch("/api/admin/users").then((r) => jsonOrThrow<AdminUserRow[]>(r)),
  inviteUser: (email: string, role: AdminUserRole) =>
    fetch("/api/admin/users/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role }),
    }).then((r) =>
      jsonOrThrow<{ id: string; email: string; role: AdminUserRole; pending: boolean }>(r),
    ),
  changeUserRole: (id: string, role: AdminUserRole) =>
    fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }).then((r) =>
      jsonOrThrow<{ id: string; email: string; role: AdminUserRole }>(r),
    ),
  revokeUser: (id: string) =>
    fetch(`/api/admin/users/${id}`, { method: "DELETE" }).then((r) =>
      jsonOrThrow<{ id: string; revoked: boolean }>(r),
    ),

  // ---- API keys
  listKeys: () =>
    fetch("/api/admin/api-keys").then((r) => jsonOrThrow<AdminApiKeyRow[]>(r)),
  issueKey: (label: string, scopeRole: AdminUserRole) =>
    fetch("/api/admin/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, scopeRole }),
    }).then((r) => jsonOrThrow<AdminApiKeyIssued>(r)),
  rotateKey: (id: string) =>
    fetch(`/api/admin/api-keys/${id}/rotate`, { method: "POST" }).then((r) =>
      jsonOrThrow<AdminApiKeyIssued>(r),
    ),
  revokeKey: (id: string) =>
    fetch(`/api/admin/api-keys/${id}`, { method: "DELETE" }).then((r) =>
      jsonOrThrow<{ id: string; revoked: boolean }>(r),
    ),

  // ---- Audit log
  listAudit: (filters?: { actor?: string; action?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (filters?.actor) qs.set("actor", filters.actor);
    if (filters?.action) qs.set("action", filters.action);
    if (filters?.limit) qs.set("limit", String(filters.limit));
    const query = qs.toString();
    return fetch(`/api/admin/audit-log${query ? `?${query}` : ""}`).then((r) =>
      jsonOrThrow<AdminAuditRow[]>(r),
    );
  },
  listAuditActions: () =>
    fetch("/api/admin/audit-log/actions").then((r) =>
      jsonOrThrow<{ action: string; count: number }[]>(r),
    ),
  exportAuditCsv: (filters?: { actor?: string; action?: string }) => {
    const qs = new URLSearchParams();
    if (filters?.actor) qs.set("actor", filters.actor);
    if (filters?.action) qs.set("action", filters.action);
    const query = qs.toString();
    window.location.href = `/api/admin/audit-log/export.csv${query ? `?${query}` : ""}`;
  },

  // ---- SSO
  getSso: () =>
    fetch("/api/admin/sso").then((r) => jsonOrThrow<AdminSsoConfig>(r)),
  saveSso: (cfg: AdminSsoConfig) =>
    fetch("/api/admin/sso", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    }).then((r) => jsonOrThrow<AdminSsoConfig>(r)),

  // ---- Tenant settings
  getTenantSettings: () =>
    fetch("/api/admin/tenant-settings").then((r) =>
      jsonOrThrow<AdminTenantSettings>(r),
    ),
  saveTenantSettings: (s: AdminTenantSettings) =>
    fetch("/api/admin/tenant-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(s),
    }).then((r) => jsonOrThrow<AdminTenantSettings>(r)),
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
