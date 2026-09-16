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

## Data Factory (Day 0)

Procuro LoE only — not FSA. John pivot: ingest **public / internet**
signals, package them, sell via Pulse / Diligence **and** an API spine
in parallel. No tenant spend. No FSA client paths. Layer B deferred.

Honest beta (`ga: false`). Catalog, fetch stubs, packaged JSON, Layer C
Decide→Learn taxonomy (aligned with PR #30), and authenticated read
endpoints live in `@workspace/data-factory` and
`GET /api/data-factory/*`.

See [`DATA-FACTORY-DAY0.md`](DATA-FACTORY-DAY0.md) for the strengthened
Tier 1 map, Tier 2 file/CSV sources, the parallel news/OSINT track
(RSS metadata → events; headlines + link only), the locked storage
layout (GCS raw / Postgres serving / BigQuery analytics on the existing
intelligence stack), Pulse vs API vs both tags, and
`license_required` paid placeholders.
