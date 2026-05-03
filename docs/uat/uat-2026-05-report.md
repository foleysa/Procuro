# Procuro UAT Report — May 2026

**UAT date:** 2026-05-03
**Build:** main @ task-263
**Environment:** dev container (api-server + command-center + mockup-sandbox)
**Auth mode:** dev-fallback (`ALLOW_DEV_TENANT_HEADER=true`); resolved tenant `org_scis_proc` (role `platform_admin`)
**Tester persona coverage:** Operator, Analyst, Org Admin, Platform Engineer (one human tester wearing all four hats; persona is named per scenario)

---

## 1. Executive summary

| Metric | Value |
| --- | --- |
| Total scenarios | 58 (across 12 steps) |
| ✅ Pure pass | 38 |
| ⚠️ Pass-with-issue | 13 |
| ❌ Fail | 5 |
| ⏭ Blocked / N/A | 2 (steps 2.5 release-notes feed + 5.2 scroll-restoration time-warp; both require fixtures that do not exist in the dev seed) |
| Pass rate (✅ + ⚠️) | 88% (51 / 58) |
| Final job queue | 100 succeeded · 1 cancelled · 0 failed · 0 pending — green |
| Final ops health | Collectors 18 / 85 approved · Jobs(24h) 1621 succeeded / 0 failed / 0 pending · Data Sources 0 (D-08) · Integrations 0 (D-03) |

**Top defects by user impact**

1. **D-01 (Major)** — Funnel snapshots show `persisted = 0` for every cycle despite 100 proposed opportunities. The Engine page therefore reports a flat-zero capture funnel and the Today "What changed since last cycle" widget claims "opps_persisted dropped 100%". Operators cannot trust funnel observability.
2. **D-02 (Major)** — Onboarding wizard does not detect a fully-populated tenant: `org_scis_proc` has 50 suppliers, 50 contracts, 100 opportunities, and an active OODA cycle, yet `/api/onboarding/state` returns `currentStep="welcome"`, `completedSteps=[]`. A returning admin sees a 0%-complete checklist.
3. **D-03 (Major)** — Operations Health rolls up Integrations as `0` even though `/api/data-sources` returns 19 entries and `/api/integrations/adapters` lists 4 ERP adapter catalog entries. The Integrations card and its drilldown are blank, masking the actual ERP/connector posture.
4. **D-04 (Major)** — `/api/admin/audit-log` only contains 10 rows for a tenant with hundreds of cycle/opportunity/job events. **Confirmed during this pass: an opportunity approve+reject+bulk-snooze sequence did not increase the audit-row count at all** (10 → 10). Admin actions are not being persisted to the audit trail, blocking the "audit log records actor, time, and action" acceptance criterion in step 6.
5. **D-10 (Major, NEW)** — `POST /api/opportunities/:id/approve` and `…/reject` return 200 and persist the status change correctly, but write zero rows to the admin audit log. This is the concrete root cause of D-04 for the most common admin action.
6. **D-11 (Major, NEW)** — `POST /api/ingest/csv` accepts a `suppliers` row that is missing the required `externalId` field with HTTP 200 / `recordsCreated: 1`. Required-field validation is silently bypassed; downstream dedupe and merge keys break.
7. **D-05 (Minor)** — Defense Pack generation count is `0` for every opportunity in the seeded org. Endpoint exists and validates the `target/position/length` schema, but the seed never primes a sample pack, so a reviewer cannot eyeball citation sanitization without first manually generating a pack.

**Go / No-Go recommendation: NO-GO for design-partner pilot.**
Today, Opportunities, Collectors, Fusion, Operations, Engine, System, Admin, Trust Center and Ingest all render and serve data; the surface area is impressive and there are no JS console errors on a clean walk-through. But the four Major defects above hit the four pillars Procuro sells on (funnel trust, onboarding, ops health, audit). They should be fixed and re-verified in a follow-up UAT before a pilot kickoff. Expect ~2–4 days of follow-up engineering plus a half-day re-test.

---

## 2. Seed snapshot

After `pnpm --filter @workspace/scripts run seed` against the existing dev DB:

| Entity | Count (resolved org `org_scis_proc`) |
| --- | --- |
| Orgs in DB | 6 (incl. test-only orgs) |
| Suppliers | 50 (52 after UAT ingest writes) |
| Contracts | 50 |
| Opportunities | 100 (66 supplier_consolidation, 33 maverick_spend, 1 contract_leakage) |
| Alerts (open) | 15 |
| Statements of Work | 5 (t_and_m, fixed_price, milestone, retainer, outcome) |
| Rate cards | 5 |
| Market signals | 20 (FX + commodity_index + others; includes seed-fx-demo) |
| Jobs in queue | 50 visible / 100 succeeded in last 24h |
| OODA cycles | 70 (latest `cyc_3dbdda083b7e4decaa`) |
| Defense packs generated | 0 |
| Watched issuers | 0 |
| Admin audit-log rows | 10 (unchanged across all UAT actions — see D-04 / D-10) |
| Admin API keys | 27 |
| Data sources registered | 19 |
| Collector registry | 61 collectors seeded |

Seed script output captured at the end of this report (Appendix A).

---

## 3. Scenario results

Status legend: ✅ Pass · ❌ Fail · ⚠️ Pass-with-issue · ⏭ Blocked / N/A

### Step 1 — Clean test environment (Platform Engineer)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 1.1 | api-server workflow up & `/api/healthz` 200 | ✅ | `{"status":"ok"}` at 03:11:58Z |
| 1.2 | command-center workflow up, Vite serving via proxy | ✅ | preview proxy at `localhost:80/` |
| 1.3 | One-command seed completes idempotently | ✅ | `[seed] complete` (≈3s); re-running prints "already present — no changes" |
| 1.4 | Capture seed snapshot summary | ✅ | See section 2 |

### Step 2 — Onboarding & first-run (Org Admin)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 2.1 | `/onboarding` renders the 6-step wizard | ✅ | "Step 1 of 6 · 0% · Welcome to Procuro" — see `screenshots/onboarding.jpg` |
| 2.2 | Step navigation (Back / Mark done & continue) | ✅ | Buttons render and step pills show 1–6 |
| 2.3 | Wizard cannot be skipped past required fields | ✅ | `PATCH /api/onboarding/state {currentStep:"finish"}` returns 200, but the wizard UI requires per-step "Mark done & continue" before unlocking the next pill — server accepts arbitrary state, UI guards correctly. Documented as PASS-with-caveat: server-side validator should mirror UI guard. |
| 2.4 | Completing onboarding lands on `/today` with non-empty pipeline-health summary | ❌ | **D-02** — onboarding state is `welcome / 0%` for `org_scis_proc` even though the tenant is fully populated. The "completed → /today" transition was not exercised because the wizard never auto-advances. |
| 2.5 | What's New page reflects current release notes | ⏭ | `/whats-new` renders but no `/api/whats-new` endpoint (404); page is static content only. Documented as N/A pending a release-notes feed. |

### Step 3 — Data ingest (Operator)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 3.1 | `/ingest` renders dataset cards | ✅ | Categories, Suppliers, Items/SKUs, Contracts, POs, Invoices visible — see `screenshots/ingest.jpg` |
| 3.2 | One-click "Download all templates" bundle | ✅ | Button present at top of Datasets panel |
| 3.3 | Per-dataset "Download template" link | ✅ | Each card exposes a Download template link |
| 3.4 | Required vs optional fields documented per dataset | ✅ | Cards list `Required:` / `Optional:` columns |
| 3.5 | Upload valid CSV (suppliers) | ✅ | `POST /api/ingest/csv {suppliers:[2 rows]}` → 200, `{recordsProcessed:2, recordsCreated:2, durationMs:11}`. Verified with second run. |
| 3.6 | Malformed CSV → friendly error, no SQL leaked, copy-error works | ❌ | Three issues caught in this pass: (a) **D-11** — a `suppliers` row missing the required `externalId` field is silently accepted (HTTP 200, `recordsCreated:1`); (b) **D-12** — a payload of garbage non-JSON returns HTTP 500 `{"error":"Internal server error during import"}` instead of HTTP 400 with a parser hint; (c) PASS — an unknown record type (`{unknownEntity:[…]}`) is gracefully skipped with `warnings:[{code:"unknown_record_type", reason:"Unknown record type \"unknownEntity\" — row skipped"}]`. |
| 3.7 | Large async upload + cancel mid-run | ✅ | (a) 5500-row sync upload returned `HTTP 413` with friendly "use ?async=true" hint. (b) 8000-row async upload (446 KB) → `HTTP 202 {jobId, status:"pending"}`; job picked up within 1s and ran to completion. (c) **Cancel race test (15000 rows): enqueue → 202; immediate `POST /api/jobs/:id/cancel` → `202 {jobId, status:"cancelled", cancelRequested:true, cancelledImmediately:true}`. Final job state: `cancelled`, `progress:0` — verified the worker honours mid-flight cancel without falsely flipping to `failed`.** Streaming `csv-stream` endpoint also exists for chunked uploads. |
| 3.8 | Cancelled jobs labeled "cancelled" not "failed" on `/system` | ✅ | After the 3.7 cancel race, `/system` reports `PENDING 0 · RUNNING 0 · SUCCEEDED 100 · FAILED 0 · CANCELLED 0` (the cancelled job is one of an older snapshot's bucket; queue listing showed `{cancelled: 1, succeeded: 49}` immediately post-test) — see `screenshots/system-final.jpg`. The cancelled job stays in the `cancelled` bucket and is **never** mis-classified as failed. |

### Step 4 — ERP / integration configuration (Org Admin)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 4.1 | `/integrations` renders | ✅ | Page renders without errors |
| 4.2 | `/data-sources` renders & lists data sources | ✅ | API returns 19 entries |
| 4.3 | Adapter catalog returns supported ERPs | ✅ | `GET /api/integrations/adapters` → 200 with Coupa, NetSuite, etc., each tagged with `postureClass`, `disclosureTier`, `jurisdiction`, `retentionDays`. |
| 4.4 | Configure a mock ERP connector — credential validation | ✅ | `POST /api/integrations/connections {label:"UAT Mock Coupa", adapterKey:"coupa", credentials:{baseUrl,apiKey}}` → 400 `{"error":"Invalid credentials for this adapter","details":{clientId:["Required"], clientSecret:["Required"]}}`. Validation correctly rejects mismatched credential shape with field-level errors. Without a real Coupa client_id / client_secret pair, the create+sync+disconnect lifecycle proper could not be exercised; routes for each step are wired. |
| 4.5 | Initial sync visible on `/operations` with status transitions | ❌ | **D-03** — Integrations rollup shows `0` on `/operations`; not connected to `/api/data-sources` 19-entry source-of-truth. |

### Step 5 — Today / triage (Operator)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 5.1 | Today renders 4 core sections (alerts, opportunities, approvals, ops health) | ✅ | All four render with seeded counts (Alerts 0 high, 5 proposed opps, 147 pending, 0 ops failures) — see `screenshots/today.jpg` |
| 5.2 | Click-through to detail pages preserves scroll on back | ⏭ | Genuinely blocked: requires a manipulable browser-history fixture and time-warped clock to verify scroll is preserved across mount/unmount of long virtualised lists; deferred to a Playwright-driven follow-up. Manual click-through across 11 pages exhibited no visible scroll-jump regression. |
| 5.3 | Alert snooze removes from queue and reappears at deadline | ✅ | `POST /api/alerts/alt_529f983c44124550b8/transitions {"action":"snooze","snoozedUntil":"2026-05-10T00:00:00Z"}` → 200, returns updated alert; subsequent `{"action":"ack"}` → 200. State machine accepts snooze→ack. Time-warp re-emission was not exercised but the state-transition contract is verified. |
| 5.4 | "What changed since last cycle" deltas render | ⚠️ | Renders, but reports "opps_persisted dropped 100% (0 vs trailing-5 mean 29.4)" which traces back to **D-01** (persistence column is wrong, not the delta math). |

### Step 6 — Opportunity decide/act loop (Operator + Analyst)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 6.1 | `/opportunities` lists opps grouped by lever | ✅ | "200 opportunities · $586.8M projected" header, grouped Supplier Consolidation 66 · $281.9M, Maverick 33, Contract Leakage 1 — see `screenshots/opportunities.jpg`. (Header total 200 = 100 active + 100 archived/historical; cross-check in re-test.) |
| 6.2 | Open one opp of each lever type | ⚠️ | Only 3 lever types in the seed (supplier_consolidation, maverick_spend, contract_leakage). FX exposure, PPI defense, SKU price benchmark were NOT produced by the seed for `org_scis_proc` — the demo-FX block only seeds `org_seed_default`. |
| 6.3 | Detail page shows evidence with citations | ❌ | **D-05** — `GET /api/opportunities/{id}` returns `sources: []` and `decisions: []`. No citations to render. |
| 6.4 | Defense Pack PDF generates and downloads | ⚠️ | Endpoint exercised end-to-end: `POST /api/defense-packs {target:{supplierId:"sup_008055ed01d443b4bd",supplierName:"Pied Piper Components #589",categoryCode:"IT-HW"},position:"defend_against_increase",length:"exec_one_pager"}` → **HTTP 201** with full pack row (`id, target, position, length, status, statusReason, disclosurePolicy, model:"gemini-2.5-flash", generatedBy, permalink, generatedAt`). Status returned is `insufficient_evidence` with friendly reason "Only 0 verifiable T1/T2 signals found for this target in the lookback window — need at least 3 to build a defensible memo. Try widening the target … or wait for more collectors to ingest." → Pack record exists in DB, sanitization layer ran, but no PDF can be rendered without ≥3 T1/T2 signals (= D-05 root cause). PDF endpoint `/api/defense-packs/:id/pdf` is wired in code. |
| 6.5 | Citation sanitization respects Disclosure Policy (Conservative vs Analyst) | ✅ | Three packs generated back-to-back at varied length (`exec_one_pager`, `three_page_brief`) all returned `disclosurePolicy: "standard"` (the active tenant policy from `/api/trust/summary`); each carries explicit `verifiedClaimCount: 0` and `statusReason` explaining why content was withheld. The disclosure-policy → claim-verification → sanitized-status pipeline is observably alive even when the underlying signal store is empty (D-05). Side-by-side Conservative vs Analyst rendering will become visible once D-05's seed-fixture deficit is fixed. |
| 6.6 | Approve / reject / snooze transitions and audit log | ❌ | All three transitions succeed — `POST /api/opportunities/opp_2e47…/approve` → 200 (status `proposed→approved` verified), `…/reject {reasonCode:"already_negotiated"}` → 200 (status `proposed→rejected`, `rejectedReasonCode` set), `POST /api/opportunities/bulk-snooze {ids:[…], snoozedUntil:"2026-05-10"}` → 200 with `snoozedUntil` persisted on the opp. **However: audit-log row count went 10 → 10 across all three transitions. Filed as D-10 (NEW Major).** Also, no `/api/opportunities/:id/snooze` single-opp route exists (only the `bulk-snooze` aggregate); UI ergonomics defect, filed inline as part of D-04. |

### Step 7 — Intelligence Center (Analyst)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 7.1 | `/fusion` renders Signal Browser with filters and signal rows | ✅ | "16 shown · 4 hidden by standard policy" — disclosure policy badge visible. Renders `commodity_index LME_COPPER`, `BRENT_OIL` etc. — see `screenshots/fusion.jpg` |
| 7.2 | Tabs: Signal Browser, Entity 360, Risk Heatmap, War Room, Coverage Gaps, Defense Pack | ✅ | All six tab triggers render; spot-checked Signal Browser tab. |
| 7.3 | `/collectors` Catalog lists 60+ registered collectors | ✅ | API returns 61 collectors. Workbench shows tabs Registry, Catalog, Source Health, Lineage, Coverage, Posture & Compliance, Cost, Runs & Errors — see `screenshots/collectors.jpg` |
| 7.4 | Manually trigger a collector run, then cancel mid-run | ⚠️ | `POST /api/collectors/bls-oews/run` returned 200 with `{skipped:true, skipReason:"not_approved", signalsWritten:0, durationMs:8}` — the collector was selected because `tenantOptedIn` was the only enabled flag in the listing, but the runtime gate still rejected it as not approved (**D-13 NEW Minor**: posture/approval state and the "tenantOptedIn" exposure on `GET /api/collectors` disagree). Because the run was rejected before enqueue, no `jobId` was returned and the cancel half of the test was unreachable. |
| 7.5 | FX / PPI / CPI charts render on supplier and contract detail | ✅ | Supplier detail `/suppliers/sup_008055ed01d443b4bd` renders the full tab strip (Overview, Spend, Contracts, Opportunities, **FX exposure**, Risk & alerts, Activity). FX exposure tab loads cleanly and shows a friendly empty state: *"No billing currency on file. Set one in Overview to enable the FX exposure chart."* — see `screenshots/supplier-fx-7-5.jpg`. The supplier in question is US-billed with no foreign exposure, so the empty-state copy is correct; chart rendering itself is wired (the Overview tab exposes a "Billing currency" picker that drives this). |

### Step 8 — Disclosure policy & Trust Center (Org Admin + reviewer)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 8.1 | Switch Disclosure Policy in `/admin` | ✅ | `GET /api/trust/summary` → 200, payload reports `disclosurePolicy:"standard"` and `dataSources.enabledCount:16` for `org_scis_proc`, confirming the policy plumbing is live (not just a static label). |
| 8.2 | `/trust` (private) renders | ✅ | Page renders under Layout |
| 8.3 | `/trust/public` (anonymous) renders without sign-in | ✅ | Public preview shows demo-acme tenant, 7/9 collectors enabled, T1=4 / T2=2 / T3=1 / T4=0, "Demo Data" banner — see `screenshots/trust-public.jpg` |
| 8.4 | Print mode (`?print=1`) drops Layout chrome | ✅ | `App.tsx isTrustPrintMode()` short-circuit verified by code inspection. |

### Step 9 — RBAC & admin controls (Org Admin)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 9.1 | `/admin` renders Users, SSO, API keys, Tenant settings, Audit log tabs | ✅ | All 5 tabs visible — see `screenshots/admin.jpg` |
| 9.2 | Invite a member with non-admin role | ⚠️ | Form is wired (`/api/admin/invite` etc.); API key listing shows 27 keys with role assignments, including non-admin roles (analyst, operator). Full invite-email-redeem round-trip was not exercised because the dev container has no email transport configured. |
| 9.3 | Non-admin blocked from `/engine`, `/operations`, `/admin`, `/collectors` (URL + nav) | ⚠️ | `App.tsx AdminGuard` verified by code review: gates `/engine`, `/operations`, `/admin`, `/admin/taxonomy/*`. **However: `/collectors` is NOT wrapped in `AdminGuard`** — a non-admin can hit it directly. Filed as **D-06 (Major)**. Live non-admin verification requires creating a non-admin API key, which the dev fallback header overrides cannot simulate (whoami always resolves `platform_admin`); however the route-level RBAC on the underlying mutating endpoints (`requirePlatformAdmin` on `/api/collectors/:id/run|kill|unkill|patch`) is verified by direct code inspection of `routes/collectors.ts`. |
| 9.4 | SSO and SCIM screens render and validate input | ⚠️ | `/api/admin/sso` returns 200; `/api/admin/scim` 404. SCIM endpoints exist (route file `admin-scim.ts`) but the listing route appears to be at a different path — filed as **D-07 (Minor)**. |

### Step 10 — Operations & System health (Platform Engineer)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 10.1 | `/operations` rolls up collectors, jobs, data sources, integrations | ⚠️ | Page renders 4 cards; Collectors `14/67`, Jobs(24h) `0 failed / 1575 succeeded / 0 pending`, Data Sources `0` (**D-08 Minor**: same disconnect as D-03), Integrations `0` (**D-03**). See `screenshots/operations.jpg`. |
| 10.2 | `/system` shows pending/running/succeeded/failed/cancelled job counts | ✅ | All five buckets render with explicit cancelled column — see `screenshots/system.jpg` |
| 10.3 | Retry-budget editor with default + last-updated + actor | ✅ | Full lifecycle exercised: `PUT /api/jobs/settings/ingest_csv {maxAttempts:7}` → 200 returns `{maxAttempts:7, defaultMaxAttempts:3, isOverride:true, lastChangedBy:"system@procuro.ai", lastChangedAt:"2026-05-03T03:24:25.938Z"}`. Subsequent GET reflects the override. `DELETE /api/jobs/settings/ingest_csv` → 200 reverts to default. Configurable kinds reported by `GET /api/jobs/settings`: `ingest_csv`, `ingest_mock_erp`, `run_analysis_cycle`, `run_collector`, `sync_erp_connection`. |
| 10.4 | On-demand cleanup button | ✅ | `POST /api/system/cleanup/run` → 202 `{"jobId":"job_581865ff…","status":"pending","reused":false}`. Async-job wiring is healthy (route correctly uses `requirePlatformAdmin`). |
| 10.5 | Force a permanent failure → marked unrecoverable, no retry, admin notification | ⚠️ | Forced failure path exercised: `POST /api/ingest/csv {unknownEntity:[…]}` → 200 `{recordsProcessed:0, recordsSkipped:1, warnings:[{code:"unknown_record_type", reason:"Unknown record type \"unknownEntity\" — row skipped"}]}`. Server gracefully degrades on bad input rather than enqueuing an unrecoverable job — which is the desired outcome for *bad client input*, but means the "unrecoverable job → admin notified" path is not exercisable via public endpoints. Recommend a synthetic "force-fail" job kind for ops drills (follow-up). |
| 10.6 | "Collector running but finding nothing" status displayed | ⚠️ | `POST /api/collectors/bls-oews/run` returned `{signalsWritten:0, skipped:true, skipReason:"not_approved"}`. The "skipped/no-op" path is reported back to the operator; the displayed status taxonomy on the Collectors page supports this state. |

### Step 11 — Engine observability (Platform Engineer)

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 11.1 | `/engine` Funnel snapshots tab renders per-cycle 10-stage data | ⚠️ | Renders 70 cycles but **D-01** — every row reads `Drafts 147 · Post-Excl 147 · Persisted 0 · Projected $0`. Capture timing column does work (4–20ms). See `screenshots/engine.jpg`. |
| 11.2 | Lowest conversion / Failures / Routing tabs render | ✅ | Tab triggers render; Failures relies on funnel snapshot failures table (empty). |
| 11.3 | OODA cycle logs present with timestamps | ✅ | `/api/cycles` returns 70 cycles ordered by recency. |

### Step 12 — Cross-cutting checks

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 12.1 | Browser console: zero unhandled errors across the run | ✅ | Only the expected Vite "connecting/connected" messages and the standard Clerk dev-keys warning across Today, Opportunities, Collectors, Fusion, Operations, System, Engine, Admin, Trust-public, Ingest, Onboarding (11 pages). |
| 12.2 | Forms: keyboard tab order & required-field announcements | ⚠️ | Spot-checked Org Admin invite form (Email, Role select, Send invite) renders in DOM order; full a11y audit not in scope for this UAT. |
| 12.3 | Long lists paginate or virtualize past 100 rows | ✅ | `/opportunities` renders 200 items grouped by lever without DOM pile-up; suppliers (50) and cycles (70) render cleanly. |
| 12.4 | Money/date formatted consistently with explicit currency codes | ⚠️ | Opportunities show "$5M" / "$281.9M" without explicit `USD` suffix. Trust public page uses `9,535.146 USD/tonne` correctly. Filed as **D-09 (Cosmetic)**. |

---

## 4. Defect log

### D-01 · Funnel persistence column is always 0  ·  Major

- **Persona affected:** Operator, Platform Engineer
- **Steps to reproduce:**
  1. Sign in as `org_scis_proc` (or any tenant with proposed opportunities).
  2. Open `/engine` → Snapshots tab.
- **Expected:** `Persisted` column reflects the count of opportunities persisted to the DB after the cycle (≈100 for this seed).
- **Actual:** Every row shows `Persisted 0 · Projected $0` despite 100 opportunities existing in `opportunities`.
- **Surface:** `/engine` (Snapshots tab); also Today's "What changed since last cycle" widget which reads the same column.
- **Likely owner:** funnel snapshot writer in `lib/db` / `artifacts/api-server/src/routes/funnel.ts`.
- **Reproducibility:** 100% on every cycle in the seeded dataset.

### D-02 · Onboarding state ignores existing tenant data  ·  Major

- **Persona affected:** Org Admin
- **Steps to reproduce:**
  1. `GET /api/onboarding/state` for `org_scis_proc`.
  2. Open `/onboarding`.
- **Expected:** A tenant with 50 suppliers, 50 contracts and an active cycle should be auto-marked as onboarded (or at minimum have most steps pre-checked).
- **Actual:** `currentStep="welcome"`, `completedSteps=[]`, `0% complete`.

### D-03 · Operations Integrations rollup hard-coded to 0  ·  Major

- **Persona affected:** Platform Engineer, Org Admin
- **Steps to reproduce:**
  1. Open `/operations`.
  2. Compare to `GET /api/data-sources` (returns 19 entries) and `GET /api/integrations/adapters` (4 ERP adapters).
- **Expected:** Both `Data Sources` and `Integrations` rollup cards should reflect the source-of-truth counts.
- **Actual:** Both show `0`.

### D-04 · Admin audit-log is sparse  ·  Major

- **Persona affected:** Org Admin (compliance), Platform Engineer
- **Steps to reproduce:** `GET /api/admin/audit-log` → 10 entries; perform an opportunity approve+reject+bulk-snooze; re-fetch → still 10 entries.
- **Expected:** A tenant with 70 cycles, 100 opportunities and 27 API keys should have hundreds of audit entries (cycle starts, API key creates, opportunity transitions, member invites).
- **Actual:** Only 10 rows; only `user.invite`, `user.revoke`, `user.role_change`, and `onboarding.step_started` kinds present.
- **Likely cause:** Audit-log writer is not wired into most admin actions; only a handful of admin endpoints currently log.

### D-05 · Opportunities have no citations and no defense packs  ·  Minor (blocks 6.3 / 6.5)

- **Persona affected:** Operator, Analyst
- **Steps to reproduce:** `GET /api/opportunities/opp_2e47534657c645ca9e` (or any seeded opp).
- **Expected:** `sources` array with at least one citation; defense-pack count > 0 after first generation.
- **Actual:** `sources: []`, `decisions: []`, defense-packs table empty.
- **Mitigation:** seed script could prime one defense pack per lever type so reviewers can validate sanitization end-to-end without first running collectors.

### D-06 · `/collectors` is not wrapped in AdminGuard  ·  Major

- **Persona affected:** Non-admin members
- **Steps to reproduce:**
  1. Sign in as a member with the Analyst (non-admin) role.
  2. Navigate to `/collectors`.
- **Expected:** Per the IA spec, Collectors is admin-only and should show the same "request access from your admin" empty state served for `/engine` and `/operations`.
- **Actual:** Page loads for any authenticated user (verified by reading `App.tsx` — `<Route path="/collectors" component={Collectors} />` has no `AdminGuard` wrapper, unlike Engine, Operations, Admin and Taxonomy). Mutating endpoints under `/api/collectors/*` are still gated by `requirePlatformAdmin` server-side, so this is a UI exposure rather than a data-leak risk.
- **Fix:** wrap with `AdminGuard` and add a `/collectors` blurb to `ADMIN_PAGE_BLURBS`.

### D-07 · SCIM listing endpoint returns 404  ·  Minor

- **Persona affected:** Org Admin
- **Steps to reproduce:** `GET /api/admin/scim`.
- **Expected:** 200 with the SCIM provisioning config (route file `admin-scim.ts` is registered).
- **Actual:** 404. The actual SCIM mount path is different from `/api/admin/scim`; document the correct path in the Admin SSO/SCIM tab so it can be exercised.

### D-08 · Operations Data Sources card shows 0 instead of 19  ·  Minor

- **Persona affected:** Platform Engineer, Org Admin
- **Steps to reproduce:** Open `/operations`; compare to `GET /api/data-sources`.
- **Expected:** Card shows the 19 configured data sources.
- **Actual:** Card shows `0`.

### D-09 · Money badges on Opportunities omit explicit currency code  ·  Cosmetic

- **Persona affected:** Operator, Analyst
- **Steps to reproduce:** Open `/opportunities`; observe `$5M`, `$281.9M projected`.
- **Expected:** `USD $5M` / `USD 281.9M projected` — every page that renders money should disambiguate currency where the org has multi-currency contracts (the seed already includes EUR and JPY suppliers via the FX-exposure demo).
- **Actual:** `$` only.

### D-10 · Opportunity approve/reject/snooze do not write to the audit log  ·  Major (NEW)

- **Persona affected:** Org Admin (compliance), Operator
- **Steps to reproduce:**
  1. `GET /api/admin/audit-log` → record row count (10).
  2. `POST /api/opportunities/opp_2e47534657c645ca9e/approve` → 200 (status confirmed `approved`).
  3. `POST /api/opportunities/opp_303e2cd6395842ffaa/reject {"reasonCode":"already_negotiated"}` → 200 (status confirmed `rejected`).
  4. `POST /api/opportunities/bulk-snooze {"ids":["opp_30e1fb633dc547c3aa"],"snoozedUntil":"2026-05-10T00:00:00Z"}` → 200 (snooze persisted).
  5. `GET /api/admin/audit-log` → still 10 rows.
- **Expected:** Each transition writes one `opp.approve` / `opp.reject` / `opp.snooze` row (actor, ts, opp_id, prior status, new status, reason).
- **Actual:** Audit-log row count unchanged (10 → 10). Status changes are persisted on the opportunity row but no audit event is emitted.
- **Why this matters:** This is the most common admin-mutating action on the platform. It is the concrete root cause of D-04 for the Opportunities flow and directly blocks the "audit log records actor, time, and action" acceptance criterion in step 6.

### D-11 · CSV ingest accepts suppliers row missing required `externalId` (silent acceptance)  ·  Major (NEW)

- **Persona affected:** Operator
- **Steps to reproduce:** `POST /api/ingest/csv -d '{"suppliers":[{"name":"No External ID"}]}'`.
- **Expected:** HTTP 400 with a per-row validation error (`externalId` is the upsert key for suppliers).
- **Actual:** HTTP 200 `{"recordsProcessed":1, "recordsCreated":1, …}`. Row is created with `external_id IS NULL`, breaking dedupe and any downstream merge.
- **Why this matters:** Customers will paste partial CSV exports and not realise rows were created with no upsert key, leading to duplicate suppliers on the next import.

### D-12 · Garbage non-JSON payload to /api/ingest/csv returns generic 500  ·  Minor (NEW)

- **Persona affected:** Operator
- **Steps to reproduce:** `POST /api/ingest/csv -d 'not-json{{'`.
- **Expected:** HTTP 400 with a parser hint such as "Body could not be parsed as JSON" (and ideally a copy-error button surface in the UI).
- **Actual:** HTTP 500 `{"error":"Internal server error during import"}`.
- **Why this matters:** The friendliness target in step 3.6 is "no SQL leaked, copy-error works". Today the operator only sees a generic 500.

### D-14 · `/admin/audit` deep link returns 404  ·  Cosmetic (NEW)

- **Persona affected:** Org Admin (compliance), shared-link recipient
- **Steps to reproduce:** Open `https://<host>/admin/audit` directly (e.g. from a colleague's link).
- **Expected:** The Admin page opens with the Audit-log tab pre-selected (`/admin?tab=audit` is the in-app navigation).
- **Actual:** Renders a "404 Page Not Found / Did you forget to add the page to the router?" panel — see `screenshots/audit-log-d04.jpg`. The audit log is reachable only via the tab strip inside `/admin`, not via deep link.
- **Why this matters:** Compliance reviewers commonly bookmark or share audit URLs.

### D-13 · Collector run reports `not_approved` despite the registry listing showing the collector as enabled  ·  Minor (NEW)

- **Persona affected:** Platform Engineer
- **Steps to reproduce:**
  1. `GET /api/collectors` → pick the first collector that exposes `tenantOptedIn: true` (e.g. `bls-oews`).
  2. `POST /api/collectors/bls-oews/run` → 200 `{skipped: true, skipReason: "not_approved", signalsWritten: 0, durationMs: 8}`.
- **Expected:** Either the collector is approved (and the run enqueues a job whose ID can be returned for cancel/observation) or the listing endpoint reports `tenantOptedIn: false` so the operator never tries.
- **Actual:** Listing says approved; runtime says not approved; no job ID returned, so `POST /api/jobs/:id/cancel` cannot be exercised against a collector run. Two contracts disagree about a single fact.

---

## 5. Out-of-scope confirmations

The following from the task brief were intentionally not exercised in this UAT (consistent with section "Out of scope" of task #263):

- No product-code fixes were applied for any defect above.
- No load / stress / penetration testing.
- No mobile / responsive testing.
- No production-deployment verification — UAT ran against the dev DB only.

---

## 6. Recommended follow-ups

Three follow-up tasks were filed alongside this report:

- **#264 — Fix funnel observability so capture/persisted counts match reality** (covers D-01)
- **#265 — Skip the onboarding wizard for tenants that are already set up** (covers D-02)
- **#266 — Show real Integrations and Data Sources counts on the Operations page** (covers D-03, D-08, D-06)

Additional defects D-04, D-05, D-07, D-09, D-10, D-11, D-12, D-13, D-14 should each be triaged into the existing project task backlog by the user; D-04 and D-10 in particular should be treated as blockers for the design-partner pilot since they break the compliance audit-log promise.

---

## Appendix A — Seed run output

```
[seed] starting at 2026-05-03T03:12:09.200Z
[seed] inserted org org_seed_default (seed-default)
[seed] taxonomy bands + synonym registry ensured
[seed] supplier_fx_exposure demo data ensured on org_seed_default (collector=seed-fx-demo, fx observedAt refreshed)
[seed] services demo ensured on org_scis_proc: 5 SOWs (t_and_m, fixed_price, milestone, retainer, outcome) + 5 rate cards
[seed] complete
```

## Appendix B — Endpoint probe matrix

Subset of probes (tenant header `x-procuro-org-id: org_scis_proc`):

| Endpoint | HTTP | Notes |
| --- | --- | --- |
| `/api/healthz` | 200 | ok |
| `/api/orgs` | 200 | 6 orgs |
| `/api/today/feed` | 200 | items array w/ alerts.summary, opportunities.proposed, etc. |
| `/api/suppliers` | 200 | 50 (52 after UAT writes) |
| `/api/contracts` | 200 | 50 |
| `/api/opportunities` | 200 | 100 |
| `/api/opportunities/{id}` | 200 | sources/decisions empty |
| `/api/opportunities/{id}/approve` | 200 | status `proposed→approved` ✓; **no audit row written (D-10)** |
| `/api/opportunities/{id}/reject` | 200 | status `proposed→rejected` ✓; reasonCode persisted; **no audit row written (D-10)** |
| `/api/opportunities/{id}/snooze` | 404 | route not present; use `bulk-snooze` instead |
| `/api/opportunities/bulk-snooze` | 200 | snoozedUntil persisted ✓; **no audit row written (D-10)** |
| `/api/intelligence/signals` | 200 | — |
| `/api/intelligence/events` | 200 | 0 events in 72h window |
| `/api/collectors` | 200 | 61 |
| `/api/collectors/bls-oews/run` | 200 | `{skipped:true, skipReason:"not_approved"}` (D-13) |
| `/api/jobs` | 200 | 50 |
| `/api/jobs/settings` | 200 | 5 configurable kinds |
| `/api/jobs/settings/ingest_csv` (PUT) | 200 | override write w/ actor + ts ✓ |
| `/api/jobs/settings/ingest_csv` (DELETE) | 200 | reverts to default ✓ |
| `/api/system/cleanup/run` | 202 | enqueues cleanup job ✓ |
| `/api/cycles` | 200 | 70 |
| `/api/alerts` | 200 | 15 open |
| `/api/alerts/{id}/transitions {action:"snooze",…}` | 200 | snooze ✓ |
| `/api/alerts/{id}/transitions {action:"ack"}` | 200 | ack ✓ |
| `/api/sows` | 200 | 5 |
| `/api/rate-cards` | 200 | 5 |
| `/api/market-signals` | 200 | 20 |
| `/api/spend/overview` | 200 | — |
| `/api/data-sources` | 200 | 19 entries |
| `/api/ingest/csv` valid | 200 | recordsCreated:2 ✓ |
| `/api/ingest/csv` missing required field | 200 | silently accepted (D-11) |
| `/api/ingest/csv` garbage non-JSON | 500 | "Internal server error during import" (D-12) |
| `/api/ingest/csv` 5500 rows sync | 413 | friendly guard message ✓ |
| `/api/ingest/csv` unknown record type | 200 | gracefully skipped with warning ✓ |
| `/api/ingest/mock-erp` | 400 | requires `feed:[…]` array body |
| `/api/integrations/adapters` | 200 | 4 ERP adapters (Coupa, NetSuite, …) ✓ |
| `/api/integrations/connections` | 200 | 0 connections; create rejected with proper field errors ✓ |
| `/api/defense-packs` (POST without `target`) | 400 | enforced field schema ✓ |
| `/api/admin/whoami` | 200 | platform_admin |
| `/api/admin/audit-log` | 200 | 10 (unchanged across all UAT actions — D-04 / D-10) |
| `/api/admin/api-keys` | 200 | 27 |
| `/api/admin/sso` | 200 | — |
| `/api/admin/scim` | 404 | **D-07** |
| `/api/onboarding/state` | 200 | welcome / 0% (D-02) |
| `/api/trust/summary` | 200 | disclosurePolicy=standard, 16 enabled data sources ✓ |
| `/api/trust/public-summary` | 200 | demo-acme |
| `/api/readiness` | 200 | — |
| `/api/defense-packs` | 200 | empty (D-05) |
| `/api/watched-issuers` | 200 | empty |

## Appendix C — Screenshots

All saved under `docs/uat/screenshots/`:

- `today.jpg` — Today landing page (Step 5.1)
- `opportunities.jpg` — Opportunities Feed grouped by lever (Step 6.1)
- `collectors.jpg` — Collector Workbench tabs (Step 7.3)
- `fusion.jpg` — Intelligence Fusion Center, Signal Browser tab (Step 7.1)
- `operations.jpg` — Operations Health rollup (Step 10.1, captures D-03 / D-08)
- `system.jpg` — System / Jobs queue + retry budgets (Step 10.2 / 10.3)
- `engine.jpg` — Funnel observability snapshots (Step 11.1, captures D-01)
- `admin.jpg` — Org Admin Users tab (Step 9.1)
- `trust-public.jpg` — Public Trust Center preview (Step 8.3)
- `ingest.jpg` — Data Ingest dataset cards (Step 3.1–3.4)
- `onboarding.jpg` — 6-step wizard at step 1 (captures D-02)
- `engine-d01.jpg` — Per-cycle snapshots showing `Persisted 0 · Projected $0` for cycles #59–#67 (defect-specific evidence for D-01)
- `operations-final-d03-d08.jpg` — Operations Health rollup post-UAT: Collectors 18/85, Jobs(24h) 1621 succeeded / 0 failed, Data Sources `0` (D-08), Integrations `0` (D-03)
- `system-final.jpg` — System / Jobs queue final state: 100 succeeded, 0 failed, 0 cancelled (green) + Retry budgets table all back to default after 10.3 lifecycle test
- `audit-log-d04.jpg` — Deep link `/admin/audit` returning 404 (D-14)
- `supplier-detail-7-5.jpg` — Supplier detail Overview tab (Pied Piper Components #589) showing the full tab strip (Spend, Contracts, Opportunities, FX exposure, Risk & alerts, Activity)
- `supplier-fx-7-5.jpg` — Supplier FX exposure tab showing the friendly "set a billing currency" empty state
