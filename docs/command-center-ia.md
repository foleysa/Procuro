# Command Center IA — design notes (task #199)

This is the source of truth for the Command Center information architecture
restructure. Subsequent IA work edits this file rather than redesigning
in a vacuum. Steps below correspond to the steps in `.local/tasks/task-199.md`.

## Five user journeys

| Journey | Primary surface(s) | In/out of scope this redesign |
|---|---|---|
| **Operator** triaging the morning | `/today` (new) | In scope — feed-only Today landing |
| **Analyst** investigating a signal | `/intelligence` (renamed from `/fusion`), with Alerts and Opportunities surfaced as filtered tabs / cross-links from there | In scope — re-host of existing pages under a clearer parent |
| **Admin** configuring data flow | `/operations` (new health overview), with `/operations/collectors`, `/operations/data-sources`, `/operations/ingest`, `/operations/integrations`, `/operations/jobs` underneath | In scope — re-host existing pages, add aggregator-backed landing |
| **Engineer** shipping a lever or Learn-loop change | `/engine` (new top-level, ex `/admin/funnel`) | In scope — re-host admin observability surface at friendlier path |
| **Decision-maker / CPO** reviewing what the engine learned | **Out of scope this redesign.** IA slot reserved at `/engine/learnings` (no nav entry yet). Will be filled by the v2 decision-maker slice produced by the funnel substrate's week-4 readiness review (per #185). |

## Today vs substrate decision (step 3)

Picked: **(b) Feed-only Today**, with substrate integration as a follow-up.

**Criterion applied:** condition (ii) of the task spec (substrate endpoints
exist or can be added in scope) is **not** met today. Specifically, the
two endpoints the substrate-driven Today aggregator would compose —
`auto-annotations` and `conversion-rate-deltas` — do not exist by name
in `artifacts/api-server/src` (verified by ripgrep over the routes and
ooda directories on the day this doc was written). The auto-annotation
mechanism is implemented (`detectAndAnnotateDeltas` in
`lib/ooda/funnel.ts`) but it writes to `funnel_annotations` rather than
exposing a per-tenant feed; conversion-rate-deltas is computed by
`/admin/funnel/lowest-conversion` but that surface returns a per-lever
worst-transition rollup, not a feed of recently-changed cohorts.

Picked sub-choice **(β)**: build (b) now, roll the endpoint creation
into the substrate-driven Today follow-up. The follow-up's trigger
condition is the standard one from the task spec: "create the
substrate-driven Today task once the funnel substrate's behavioural
verification is complete and its outputs are considered trustworthy."

Old `/` content (the Command Center dashboard) is preserved at
`/dashboard` (renamed analytics page). Today is now the canonical
landing at `/`.

### Choice (β) status: **shipped (#204).**

The substrate-driven Today follow-up landed. The Today aggregator now
joins two more sources alongside the original four:

- `funnel.auto_annotations` — recent `stage_drop`/`stage_spike`
  annotations emitted by `detectAndAnnotateDeltas`. Operator notes
  are excluded; the Today card is for substrate-emitted deltas.
- `funnel.conversion_deltas` — per-transition conversion-rate diff
  between the two most recent funnel snapshots
  (drafts→post_exclusion, post_exclusion→persisted,
  persisted→approved_30d, approved_30d→realized_30d).

Both flow through thin readers in
`artifacts/api-server/src/lib/ooda/funnel.ts`
(`getRecentAutoAnnotations`, `getCycleConversionRateDeltas`) and are
wrapped in the existing `safe()` helper so a reader-level failure still
degrades the feed to `partial=true` rather than failing the response.
The Today UI renders them as a single "What changed since last cycle"
card below the four triage cards, with explicit empty states for
"insufficient history" so silence is distinguishable from an error.

## Friendlier funnel path (step 6)

Funnel substrate friendlier path: **`/engine`** (UI route).

The backend keeps its current `/api/admin/funnel/...` endpoints — those
are RBAC-gated and the friendlier name is purely a frontend concern. The
old `/admin/funnel` page continues to resolve at its current URL via a
redirect to `/engine`, so external links and bookmarks stay live (per
step 7).

**Criterion applied** for top-level section vs nested under Operations:
the funnel substrate answers "what is the engine learning, and where
are the bottlenecks" — engine observability — which is a different
question from "is my data flowing." Default of own-section is taken;
the audit found no specific reason the engine-observability framing
collapses meaningfully into operations-health framing for the engineer
journey identified in step 1.

## Substrate output placements (step 1)

Each placement applies the criterion from the task spec verbatim:
*does a non-admin user (operator or analyst) need this information to
do their job? If yes, the output surfaces in their journey. If the
information is purely diagnostic for engineers debugging the substrate
itself, it stays admin-only. Default for ambiguous cases is admin-only.*

| Output | Placement | Rationale |
|---|---|---|
| Snapshot-failure banner | **Operations** (`/operations`), wired into the unified health endpoint | The operator journey needs to know when the health view itself is missing data. Already specified by step 5. |
| Prior calibration table | **Engine** (`/engine`, admin-only) | Today this is a verdict per `(lever, window)` of whether priors are helping. Useful for the engineer iterating on lever scoring; not yet useful to an analyst making a single decision (an analyst sees the rescaled projection on each opportunity, which is the consumed output). Default-admin per criterion. |
| Cohort identity tuples + `re_evaluation_count` on opportunities | **Engine** (`/engine`, admin-only), surfaced via the snapshot detail view | Whether two opportunities share a cohort and how often a cohort has re-fired is engine-internals — analysts already see the deduped opportunity. Surfacing the tuple on the analyst's opportunity detail card has unproven decision-supporting value; default-admin. |
| Signal lineage ("which levers consulted this signal") on signals | **Engine** (`/engine`, admin-only), via the snapshot detail's `signals_analyzed` stage | The analyst journey today asks "is this signal credible" (handled by the existing citation tier on every signal), not "which levers ate it". Lineage is an engineer-debugging surface for proving that a lever change actually consults the signals it claims to. Default-admin. |
| Recurring-failure detail UI from `funnel_snapshot_failures` | **Operations** (`/operations/failures`), surfaced as a drill-down from the failure summary banner | The summary already lives in Operations per step 5; the per-failure detail + acknowledge action lives next to it so an admin diagnosing data-flow problems can act in one place. |

## Role-gating list (step 2)

Sidebar items render conditionally on the resolved RBAC role from
`/api/admin/whoami`. Items hidden, not shown-and-disabled. Anonymous
users (no resolved role) see only items that work without auth (none of
the substantive nav items do, so they get a near-empty sidebar and the
header sign-in link).

| Section | Item | Min role |
|---|---|---|
| Today | Today | any signed-in role |
| Workspace | Spend Overview | any signed-in role |
| Workspace | Suppliers | any signed-in role |
| Workspace | Contracts | any signed-in role |
| Workspace | Approvals | `approver`, `org_admin`, `platform_admin` |
| Intelligence | Intelligence (was Fusion) | any signed-in role |
| Intelligence | Opportunities | any signed-in role |
| Intelligence | Alerts | any signed-in role |
| Intelligence | Saved Lists (was Watchlists) | any signed-in role |
| Intelligence | Watched Companies | `analyst`, `approver`, `org_admin`, `platform_admin` |
| Operations | Operations Health | `org_admin`, `platform_admin` |
| Operations | Collectors | `org_admin`, `platform_admin` |
| Operations | Data Sources | `org_admin`, `platform_admin` |
| Operations | Data Ingest | `analyst`, `approver`, `org_admin`, `platform_admin` |
| Operations | Integrations | `org_admin`, `platform_admin` |
| Operations | System & Jobs | `org_admin`, `platform_admin` |
| Engine | Engine | `org_admin`, `platform_admin` |
| Org | Dashboard (analytics) | any signed-in role |
| Org | Results & Billing | any signed-in role |
| Org | Playbook | any signed-in role |
| Org | Trust Center | any signed-in role |
| Org | Settings | any signed-in role |
| Org | Org Admin | `org_admin`, `platform_admin` |

Naming changes adopted:
- `Watchlists` → **Saved Lists** (less collision with "Watched Companies").
- `Intelligence Fusion` → **Intelligence** (one canonical analyst surface).
- `Dashboard` (was `/`) → moved under **Org / Dashboard** as an analytics
  page, since Today now owns the landing surface.

## Backend aggregators

Two thin server-side endpoints back the cross-cutting views. Both follow
the shared response contract from the task spec:
`{ items: [...], partial: boolean, errors: [{ source, error }] }` with
fail-soft behaviour and per-request caching only.

- `GET /api/today/feed` composes `getAlertsSummary`, `listOpportunities` (proposed bucket), `listJobs` (failed window), and approvals-pending counts. Tenant-scoped via `tenantMiddleware`; no further role gating — Today is the operator landing for everyone.
- `GET /api/operations/health` composes `listCollectors`, `listJobs` (last 24h), `listDataSources` summary, `listIntegrations` summary, plus `funnel_snapshot_failures` rollup. **Admin-only** (`requireRole("org_admin", "platform_admin")`) — surfaces operational signals (collectors / integrations / pipeline failures) that match the role-gating list above. The frontend `/operations` route is wrapped in `AdminGuard` for the same reason; both gates exist independently so URL access alone cannot bypass the sidebar hide.

Both use the existing OpenAPI codegen workflow.

## Today deep-link query convention (#209)

The Today aggregator's "Open →" links carry a `?filter=key:value`
repeatable query param so the destination page lands pre-filtered to
the slice the operator was looking at. Convention:

- Param name is always `filter`.
- Each occurrence is `<key>:<value>`. Repeats on the same key OR
  together (a multi-select).
- Destination pages whitelist their own keys; unknown keys are
  silently ignored, so adding a stray `?filter=foo:bar` to a deep-link
  is non-breaking.
- Initial-state-only: pages seed local filter state from the URL on
  first render, but manual filter changes do **not** write back to the
  URL (intentional — avoids bookmark drift).

Today's current deep-links:

| Card | Destination | Query string |
|---|---|---|
| Alerts | `/alerts` | `filter=state:open` |
| Proposed opportunities | `/opportunities` | `filter=status:proposed` |
| Pending approvals | `/approvals` | _(no filter)_ |
| Operations health | `/operations` | _(no filter)_ |

**Single-select destinations and multi-value keys.** The alerts card
counts open critical OR high, which the convention would naturally
express as `filter=severity:critical&filter=severity:high`. The alerts
page's severity filter is currently a single-`<Select>`, so a
multi-value link would silently collapse to one severity and
mis-represent the slice the operator just clicked. Until the alerts
page grows a multi-select severity (a #204 follow-up), its deep-link
lands on `state:open` only and lets the operator pick a severity
manually. Other destinations that grow multi-select UI should consume
the full `Set` from `parseFilters()` instead of `firstFilterValue()`.

Helper lives at `artifacts/command-center/src/lib/url-filters.ts`
(`parseFilters` returns `Map<key, Set<value>>`; `firstFilterValue` is
a convenience for single-select destination UIs). Add new card
deep-links via the same helper rather than inventing new query
shapes — this is the convention the substrate-driven Today (#204)
will inherit.

## Migration banner copy (step 7)

One-time, dismissable banner shown on first sign-in post-deploy. Three
elements only — informational, not a tutorial:

> **The navigation changed.** [See what moved →](/whats-new) [Dismiss]

The "See what moved" link points to `/whats-new` (in-app, role-free
page) which renders an old→new path mapping table — every change in
this redesign points to its new home, so deep-links and external
bookmarks don't have to guess.

Auto-hides 7 days after first impression. Persistence: per-user
localStorage flag (`procuro.ia.migration.dismissedAt`) — no server
state, since this is a one-time UX nudge per browser.

## Post-deploy verification (step 9)

Status: **deferred.** Live shadowing is not feasible from inside the
implementation environment. Follow-up: file a task to perform the
behavioural verification within 7 days of deploy with one operator and
one analyst, recording any patterns of confusion. Until that runs the
verification entry below stays open.

| Date | Outcome |
|---|---|
| _pending_ | _pending_ |
