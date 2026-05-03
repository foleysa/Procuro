# UAT 2026-05 v2 — follow-up task drafts (planning artefact only)

These are one-line drafts for each Blocker/Major in the v2 defect log. They are **not** project tasks — file separately per the team's planning process. Each line is `title :: persona :: repro recipe pointer`.

## Blockers
- **D-04 / D-10** Wire admin actions (approve/reject/bulk-snooze, retry-budget edits, integration connect/disconnect, policy switch, taxonomy edits) into the audit-log writer; verify with a row-count delta test :: Org Admin :: `evidence/2026-05/raw/step-4a-audit-immut.txt`
- **D-15** Make `ALLOW_DEV_TENANT_HEADER=true` outside `NODE_ENV=development` a startup-time process crash; add a test that asserts the env-var contract :: IT/SecOps :: `evidence/2026-05/raw/step-4d-cross-tenant.txt`
- **D-18** Document the pilot feature-flag set in `docs/pilot/feature-flags.yaml` and write a `pnpm` script that diffs UAT flags vs the doc and exits non-zero on any difference :: Platform Engineer + exec sponsor :: spec Step 1.0
- **D-19** Implement `PATCH /api/admin/audit/:id` and `DELETE /api/admin/audit/:id` returning 403 with a body explaining the audit-log is append-only, AND append a new audit row recording the failed attempt :: Auditor :: `evidence/2026-05/raw/step-4a-audit-immut.txt`
- **D-22** Seed at least three T1/T2 signals per lever for `org_scis_proc` so defense-pack generation returns a sanitisable artefact; expose `model + version + temperature + system_prompt_id` on `GET /api/defense-packs/:id` so spec 4e Q10 has a substantive answer :: Analyst + Regulator :: spec 4e

## Majors
- **D-01** Repair the funnel snapshot writer so `totalOppsPersisted` reflects post-cycle DB row count :: Operator + Platform Engineer :: `evidence/2026-05/raw/step-11-1-funnel.txt`
- **D-02** Detect a fully-populated tenant in the onboarding state initializer (suppliers ≥ 10 OR cycles ≥ 1 → mark `currentStep` past welcome) :: Org Admin :: `evidence/2026-05/raw/step-2-2-onboarding.txt`
- **D-03** Wire `/operations` Integrations card to `/api/integrations/connections` (or adapters when no connections) :: Org Admin + Platform Engineer :: spec 10.1
- **D-05** Seed at least one defense pack per lever so detail-page citation rendering can be reviewed without first running collectors :: Operator + Analyst :: spec 6.2
- **D-06** Wrap `/collectors` route in `AdminGuard` in `App.tsx` :: Org Admin :: spec 9.1
- **D-08** Wire `/operations` Data Sources card to `/api/data-sources` (currently 0 vs 19) :: Platform Engineer :: spec 10.1
- **D-11** Add server-side Zod validation that requires `externalId` on supplier ingest; return 400 with field-level error :: Operator :: `evidence/2026-05/raw/step-3-3-missing-extid.txt`
- **D-16** Apply CSV-injection neutralisation (prepend `'`) at ingest for fields rendered via spreadsheet export :: Operator + CFO :: `evidence/2026-05/raw/step-4f-1-csv-inj.txt`
- **D-17** Audit every render path that consumes supplier `name` (HTML, PDF, CSV export) and confirm escaping; add a test with the literal `<script>alert(1)</script>` payload that asserts no `<script>` element survives :: Operator :: `evidence/2026-05/raw/step-4f-2-xss.txt`
- **D-20** Run a security scan (SAST + dependency audit) and check the report into `docs/security-scan/` so Q22 has a substantive answer :: Exec sponsor + IT/SecOps :: spec Q22
- **D-21** Add a DB-level append-only constraint to `audit_log` (DROP UPDATE / DELETE privileges from the application role; expose only INSERT) :: Auditor :: spec Q13
- **D-23** Enumerate every mutating admin endpoint and add a CSRF-token middleware; cover with a per-endpoint test :: IT/SecOps :: `evidence/2026-05/raw/step-4f-5-csrf.txt`
- **D-24** Implement brute-force lockout in the production auth path AND add a test harness that exercises it without dev-fallback :: IT/SecOps :: spec 4f.7
- **D-25** Wire axe-core into the test pipeline against `/today`, `/opportunities`, `/fusion`; fail the build on any critical/serious finding :: Operator + Auditor :: spec 12b
- **D-26** Add `acknowledged_test_artifact` to the ingest schema and an admin UI to set it :: Platform Engineer :: spec Step 13

## Minors
- **D-07** Restore SCIM listing route at `/api/admin/scim` (the route file exists; the listing path appears to be different) :: IT/SecOps :: spec 9.2
- **D-09** Render every monetary value with an explicit ISO 4217 code (`USD`, `EUR`); apply across opportunities, fusion, defense packs :: CFO :: spec 12d
- **D-12** Wrap the JSON parser in `/api/ingest/csv` to return HTTP 400 with a parser hint instead of HTTP 500 :: Operator :: `evidence/2026-05/raw/step-3-4-garbage.txt`
- **D-13** Reconcile collector posture/approval state so the `tenantOptedIn` exposure on `GET /api/collectors` agrees with the runtime gate :: Platform Engineer :: v1 §7.4
- **D-14** Add a `/api/operations` alias that returns the Operations summary (currently 404; only `/api/operations/health` resolves) :: Platform Engineer :: spec 10.1
- **D-27** Identify a separate human tester for the Step 13 independent re-check in v3 :: Platform Engineer :: spec Step 13
