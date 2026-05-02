# Procuro

Procuro is a multi-tenant procurement intelligence platform. The repo
is a pnpm monorepo of artifacts (deployable apps) and shared libs.

See `pnpm-workspace.yaml` for the workspace layout and
`replit.md` for project-specific notes.

## Identity & access (SSO + SCIM)

Procuro integrates with the standard enterprise IdPs (Okta, Azure AD /
Entra ID, OneLogin, JumpCloud) for both authentication and directory
provisioning:

- **Authentication (SSO)** — SAML / OIDC is brokered by Clerk and
  configured per-tenant in **Admin → SSO**.
- **Provisioning (SCIM 2.0)** — user CRUD, suspension, and group →
  role push are accepted at
  `/api/scim/v2/orgs/<orgId>/{Users,Groups}` with an
  `org_admin`-scoped API key as bearer.

The end-to-end SCIM connector setup runbook for Okta and Azure AD
lives in [`artifacts/api-server/SCIM.md`](artifacts/api-server/SCIM.md):

- Endpoint reference and supported filters / pagination
- Per-tenant API key issuance and rotation
- Group → role mapping (configured from the SSO admin tab)
- Deprovisioning policy: `PATCH active=false` (soft suspend) vs
  `DELETE /Users` (total deprovision)
- Troubleshooting the common Okta / Azure quirks

The same runbook is linked inline from the SCIM groups card under
**Admin → SSO** in the command-center UI so operators can find it
during setup.
