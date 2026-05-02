# SCIM 2.0 provisioning runbook

The Procuro API exposes a SCIM 2.0 (RFC 7643/7644) bridge so identity
providers (Okta, Azure AD / Entra ID, OneLogin, JumpCloud, etc.) can
push user provisioning, suspension, and group membership in real time
to a single tenant.

This document is the operator-facing runbook that ships with the
admin UI's SSO tab. For the schema-level rationale see the comments
in [`src/routes/scim.ts`](./src/routes/scim.ts).

---

## 0 — Deprovisioning policy

The bridge distinguishes **suspend** from **delete** because Okta and
Azure AD treat them as different lifecycle events.

**`PATCH active=false`** (suspend / "deactivate user") revokes:

- the SCIM-managed identity row (`grantedVia="scim"`), AND
- **every** group-derived role grant for the user
  (`grantedVia="scim-group"`).

`PATCH active=false` does **not** touch grants from other sources —
i.e. roles an Org Admin granted manually in the admin UI
(`grantedVia="manual"`) or grants from Clerk org membership webhooks
(`grantedVia="clerk"`). The reasoning: a SCIM suspend is the IdP's
statement about the SCIM-managed identity, not a sweeping
cross-system kill switch. If your tenancy policy requires suspend to
revoke **all** sources, an Org Admin should additionally remove the
manual grants from the admin UI's Users tab (or we can ship a
tenant-level toggle on request — see `task-119` follow-ups).

**`DELETE /Users/{id}`** (full deprovision / offboarding) is more
aggressive: it revokes **every** active `user_roles` row for that
user in the tenant — `scim`, `scim-group`, `manual`, and `clerk`
alike. This matches the Okta and Azure AD product expectation that a
DELETE call is the unambiguous "this user is gone" signal an
offboarding workflow fires. Use `PATCH active=false` if you want a
reversible soft-suspend that preserves manual grants.

Conversely, **adding** a user back to a SCIM-mapped group will NOT
re-authorise a deactivated user: the bridge refuses to mint a fresh
active grant when the target user has no active "primary" identity
row. The user must first be reactivated via SCIM (`PATCH
active=true`) or by an Org Admin re-inviting them.

## 1 — Endpoints

The bridge is rooted at `/api/scim/v2/orgs/<orgId>` so the URL itself
proves which tenant the request is for. A bearer token whose tenant
disagrees with the URL is rejected with **401**.

| Resource                  | Methods                          |
|---------------------------|----------------------------------|
| `ServiceProviderConfig`   | `GET`                            |
| `ResourceTypes`           | `GET`                            |
| `Schemas`                 | `GET`                            |
| `Users`                   | `GET`, `POST`, `GET/{id}`, `PUT/{id}`, `PATCH/{id}`, `DELETE/{id}` |
| `Groups`                  | `GET`, `POST`, `GET/{id}`, `PUT/{id}`, `PATCH/{id}`, `DELETE/{id}` |

Capabilities advertised in `ServiceProviderConfig`:

- `patch.supported = true` — full Okta and Azure AD `PatchOp` flow.
- `filter.supported = true`, `maxResults = 1000`.
- `bulk.supported = false`, `sort.supported = false` — we have no
  customer that needs them and SCIM does not require them.

Filters use the SCIM 2.0 grammar; the parser accepts the subset Okta
and Azure AD actually emit:

```text
userName eq "alice@acme.com"
externalId eq "okta-12345"
emails.value eq "alice@acme.com"
emails[type eq "work"].value eq "alice@acme.com"
userName co "alice"
userName sw "alice"
active eq true
displayName eq "procuro-approvers"
```

Pagination uses `?startIndex=1&count=100` (`startIndex` is 1-based per
RFC 7644 §3.4.2; `count` is clamped to 1000).

---

## 2 — Authentication

The bridge accepts a single auth scheme: `Authorization: Bearer
<token>` where `<token>` is an `org_admin`-scoped row in the tenant's
`api_keys` table. The Procuro Org Admin issues the token from
**Admin → API keys → Issue key** with scope `Org admin`.

Why an API key and not a Clerk session? IdPs have no human in the
loop; they want a static credential they can rotate on schedule.
The bridge:

1. Verifies the bearer is non-revoked.
2. Verifies the bearer's `org_id` matches the URL `:orgId`.
3. Verifies `scope_role = 'org_admin'`.

Stamps `api_keys.last_used_at` on every successful call.

### `SCIM_BEARER_TOKEN` escape hatch — dev / single-tenant only

For local development or strictly single-tenant deployments, set
`SCIM_BEARER_TOKEN=<value>` and the bridge accepts that single shared
token in addition to the per-tenant `api_keys` rows.

> ⚠️ **Do NOT set `SCIM_BEARER_TOKEN` in a multi-tenant production
> environment.** Unlike per-tenant API keys, this token is **not**
> bound to any `:orgId` — possessing it lets the IdP push to *any*
> tenant URL on the server. Enforcement:
>
> - In **development** (`NODE_ENV !== "production"`) the server logs
>   a loud `WARN` at boot if `SCIM_BEARER_TOKEN` is set alongside
>   more than one provisioned tenant.
> - In **production** (`NODE_ENV === "production"`) the same
>   condition is **fatal** — the server refuses to start so the
>   misconfiguration cannot ship. Operators must either unset the
>   env var or scope the deployment to a single tenant.
>
> Deployment policy: shared-infra environments should never set
> `SCIM_BEARER_TOKEN`; rely exclusively on the per-tenant `api_keys`
> flow above.

---

## 3 — Group → role mapping

A SCIM Group is just metadata until an Org Admin maps it to one of
the six Procuro roles. The mapping lives in `scim_groups.role_mapping`
and is configured at **Admin → SSO → SCIM groups**.

When you change the mapping, every existing membership is
re-projected immediately:

- The previous role grant (if any) is revoked.
- A new grant is minted for each member that resolves to a tenant user.
- Audit log entry: `scim.group_role_mapping_change`.

A group with `roleMapping = null` is a no-op: pushes are accepted and
the membership rows are stored, but no `user_roles` grant is created.
Use this state during initial setup before you decide what role each
group means.

`platform_admin` cannot be granted via SCIM. The validator returns
400 if you try.

### Resolving a member

When a SCIM PATCH adds a member, the `value` field is matched
against:

1. `user_roles.id` (Procuro stable user id, returned by `POST /Users`).
2. `user_roles.user_id` (the IdP `externalId` we stored on POST).

Either works. If neither matches, the membership row is stored but
no role is minted — useful when groups arrive before user pushes
during the initial sync.

---

## 4 — Okta setup

In Okta admin: **Applications → Browse App Catalog → SCIM 2.0 Test App
(OAuth Bearer Token)**, or any app you've already configured for
SAML/OIDC SSO via Clerk that supports SCIM provisioning.

### Connection settings

| Field | Value |
|-------|-------|
| **SCIM connector base URL** | `https://<your-domain>/api/scim/v2/orgs/<orgId>` |
| **Unique identifier field for users** | `userName` |
| **Supported provisioning actions** | Push New Users, Push Profile Updates, Push Groups, Push Status (Suspend/Reactivate) |
| **Authentication mode** | HTTP Header → `Bearer <api_key>` |

Click **Test Connector Configuration**. Okta will:

1. `GET /ServiceProviderConfig` — must return 200.
2. `GET /Users?count=1` — must return a SCIM `ListResponse`.

### Enabling provisioning

In the **Provisioning** tab:

- **Create Users** — on
- **Update User Attributes** — on
- **Deactivate Users** — on (the bridge soft-revokes via `revoked_at`).

In the **Push Groups** tab, push the Okta groups you want mapped.
After the first push:

1. Open Procuro **Admin → SSO → SCIM groups**.
2. Each pushed group appears with `Don't grant a role` selected.
3. Pick a role from the dropdown (`approver`, `analyst`, `read_only`,
   `auditor`, or `org_admin`). The mapping takes effect immediately
   for current and future members.

### Common Okta troubleshooting

- **`401 Unauthorized` on Test Connector** — the API key is not
  `org_admin`-scoped or the URL `:orgId` doesn't match the key's
  tenant. Issue a fresh key from **Admin → API keys** and copy it
  before navigating away (the secret is shown once).
- **`409 uniqueness` on POST /Users** — Okta is retrying after a
  partial success. Safe to ignore; the user is already provisioned.
- **`Push Groups` is greyed out** — Okta requires SAML/OIDC SSO to be
  configured first before group push is offered.

---

## 5 — Azure AD / Entra ID setup

In Entra: **Enterprise Applications → New application → Create your
own application → Integrate any other application you don't find in
the gallery**, then **Provisioning → Get started**.

### Tenant URL and Secret Token

| Field | Value |
|-------|-------|
| **Tenant URL** | `https://<your-domain>/api/scim/v2/orgs/<orgId>?aadOptscim062020` |
| **Secret Token** | the `org_admin` API key |

The `?aadOptscim062020` suffix is Microsoft's flag that opts the
provisioning agent into SCIM 2.0 spec compliance mode. Without it,
Azure sends some PATCHes in a non-standard pathless shape. Our PATCH
handler accepts both shapes anyway, but the spec-compliant mode
produces fewer warnings in the Azure provisioning logs.

Click **Test Connection**. Azure will:

1. `GET /ServiceProviderConfig`
2. `GET /Schemas`
3. `GET /Users` and `GET /Groups`

All four must succeed.

### Mappings

Azure ships with a default attribute mapping that includes
`extensionAttribute1..N`. We don't model those — only `userName`,
`emails`, `active`, `externalId`, `displayName`. In **Provisioning →
Mappings → Provision Microsoft Entra ID Users**, delete every row
EXCEPT:

| Source attribute | Target attribute |
|------------------|------------------|
| `userPrincipalName` | `userName` |
| `Switch([IsSoftDeleted], …, "False", "True", "True", "False")` | `active` |
| `objectId` | `externalId` |
| `mail` | `emails[type eq "work"].value` |

For groups (**Provision Microsoft Entra ID Groups**):

| Source attribute | Target attribute |
|------------------|------------------|
| `displayName` | `displayName` |
| `objectId` | `externalId` |
| `members` | `members` |

Set **Provisioning Status** to **On** and select **Sync only assigned
users and groups**. Azure does an initial cycle within 40 minutes;
on-demand provisioning is available from the user/group detail page.

### Common Azure troubleshooting

- **`StatusCode: BadRequest. Detail: …` after enabling provisioning**
  — usually means a required attribute is unmapped on the Azure side.
  The bridge is permissive about extra fields (it ignores them) but
  Azure validates the *Mappings* page locally.
- **Users get provisioned but groups don't appear** — check that the
  group is *assigned* to the application (Users and groups tab), not
  just present in the directory.
- **`429 Too Many Requests`** — we don't return 429 today, but the
  Replit proxy in front of the API does at very high concurrency.
  Lower the Azure provisioning batch size to 10.

---

## 6 — Validating SCIM 2.0 behaviour

The end-to-end test suite at
[`test/scim-provisioning.test.ts`](./test/scim-provisioning.test.ts)
is a project-owned regression harness — **not** a wrapper around an
external "official" SCIM 2.0 conformance test runner. It exercises
the operations Okta and Azure AD actually emit in production
provisioning runs:

- `ServiceProviderConfig` advertises `patch` and `filter`.
- Users CRUD, including filter, pagination, suspend/reactivate, and
  the `409 uniqueness` response on duplicate POST.
- Groups CRUD, including PATCH `add`/`remove` `members`, full
  replacement via PUT, and DELETE.
- Cross-resource: deactivating a user revokes group-derived role
  grants too; deleting a group revokes everything it minted.
- `400 invalidFilter` for malformed / unsupported filter strings,
  including dangling `and`, missing values, unknown operators, and
  trailing garbage tokens (full token-stream consumption check).

Run it with:

```bash
pnpm --filter @workspace/api-server test -- --test-name-pattern=scim
```

This is the test pinned in CI; if you change the bridge, update the
test alongside this runbook. If you need attestation against the
external SCIM 2.0 conformance harness operated by IdP vendors, run
that suite manually against a staging tenant and attach the report
to the deploy ticket — it is intentionally not part of CI here
because it requires live IdP credentials.
