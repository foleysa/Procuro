# Accessibility Testing — WCAG 2.2 AA

## Standard targeted

**WCAG 2.2 Level AA** — the current international benchmark for web
accessibility and the level typically required by enterprise procurement due
diligence questionnaires and VPATs.

The automated scans check:

| Tag         | Covers                                  |
|-------------|-----------------------------------------|
| `wcag2a`    | WCAG 2.0 Level A                        |
| `wcag2aa`   | WCAG 2.0 Level AA                       |
| `wcag21a`   | WCAG 2.1 Level A additions              |
| `wcag21aa`  | WCAG 2.1 Level AA additions             |
| `wcag22aa`  | WCAG 2.2 Level AA additions             |

## Scanning tool

[**axe-core**](https://github.com/dequelabs/axe-core) via
[`@axe-core/playwright`](https://github.com/dequelabs/axe-core-playwright).

axe-core is the industry-standard accessibility engine. It catches roughly
30–40 % of all WCAG violations automatically — the remainder requires manual
testing with screen readers (NVDA, JAWS, VoiceOver) and keyboard-only
navigation, which is out of scope for this automated gate.

## Initial baseline (established May 2026)

First scan of all 36 routes found **108 violations** baselined in
`.a11y-baseline.json`. These are pre-existing issues; all future PRs must keep
the new-violation count at zero for serious/critical impact levels.

| Violation ID              | Count | Impact   | Follow-up needed |
|---------------------------|-------|----------|-----------------|
| `meta-viewport`           | 36    | moderate | Yes             |
| `color-contrast`          | 33    | serious  | Yes             |
| `button-name`             | 32    | critical | Yes             |
| `link-in-text-block`      | 2     | serious  | Yes             |
| `label`                   | 2     | critical | Yes             |
| `aria-progressbar-name`   | 1     | serious  | Yes             |
| `aria-valid-attr-value`   | 1     | critical | Yes             |
| `aria-allowed-attr`       | 1     | critical | Yes             |

> All 108 baseline entries reference **task #329** ("Fix the 108 pre-existing
> accessibility violations found in the baseline scan"). Update `followUpRef`
> per entry as individual violations are broken into sub-tickets.

## What the gate enforces

The CI gate **fails only on new serious or critical violations** that are not
listed in `.a11y-baseline.json`.

| Severity | On new violation |
|----------|-----------------|
| Critical | ❌ Fails the scan |
| Serious  | ❌ Fails the scan |
| Moderate | ⚠️  Logged as annotation; does not fail |
| Minor    | ⚠️  Logged as annotation; does not fail |

**Baselined violations** (recorded in `.a11y-baseline.json`) are excluded from
the failure gate. They were present when accessibility testing was first
established and each has a corresponding follow-up item.

## Running the scans

Both the Command Center (`/`) and API Server (`/api`) workflows must be
running. The scan uses the dev-tenant header bypass (`x-org-id`) — it does not
require a real Clerk session.

```bash
# Run all a11y scans
npx playwright test --config playwright.a11y.config.ts

# View HTML report
npx playwright show-report test-results/a11y-html
```

### Environment variables

| Variable         | Default                                | Purpose                                          |
|------------------|----------------------------------------|--------------------------------------------------|
| `A11Y_BASE_URL`  | Replit dev domain (`REPLIT_DEV_DOMAIN`) | Target base URL for the scans                   |
| `A11Y_ORG_ID`    | `org-t272-55abafb4-dis`                | Tenant org ID for the `x-org-id` auth header     |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | (auto-discovered)         | Override Chromium binary path (CI/Nix overrides)|

## Continuous integration

GitHub Actions runs the scan on every push to `main` and on every pull
request via `.github/workflows/a11y.yml`. The job:

1. Installs workspace dependencies and the Playwright-bundled Chromium
   (cached between runs by `pnpm-lock.yaml` hash).
2. Boots the API Server and Command Center in the background and starts a
   tiny path-based reverse proxy on `:80` that mirrors the Replit dev proxy
   (`/api/*` → API Server, everything else → Command Center).
3. Waits for both services to respond, then runs `pnpm run test:a11y`.
4. Uploads the HTML report and JSONL accumulation file as workflow artifacts
   for triage.

The build fails when the scan reports new serious or critical violations
that are not in `.a11y-baseline.json`.

`A11Y_ORG_ID` and `A11Y_BASE_URL` are sourced from repository **Variables**
(Settings → Secrets and variables → Actions → Variables) so they can be
overridden without editing the workflow. Sensible defaults (the dev-seed
org ID and `http://localhost:80`) are used when no variable is set.

Parameterised routes (supplier detail, opportunity detail, etc.) can be
populated with real IDs via:

| Variable              | Purpose                          |
|-----------------------|----------------------------------|
| `A11Y_OPPORTUNITY_ID` | Real opportunity UUID            |
| `A11Y_SUPPLIER_ID`    | Real supplier UUID               |
| `A11Y_CONTRACT_ID`    | Real contract UUID               |
| `A11Y_SOW_ID`         | Real SOW UUID                    |
| `A11Y_RATE_CARD_ID`   | Real rate card UUID              |
| `A11Y_JOB_ID`         | Real background job UUID         |

## How to handle scan failures

1. **Read the failure message** — it includes the violation ID, impact, axe
   help URL, and the affected DOM selector(s).
2. **Visit the axe help URL** to understand the required fix.
3. **Fix the violation** and re-run the scan to confirm it clears.
4. If the fix is not feasible in the current sprint, **add a baseline entry**
   (see below) and file a follow-up ticket.

## Adding new routes to the inventory

Edit `tests/a11y/routes.ts`. Add an entry to the `ROUTES` array:

```typescript
{
  path: "/my-new-page",
  name: "My New Page",
  requiresAuth: true,           // false for public routes
  description: "What this page shows",
},
```

Re-run the scan after adding routes. The new route's violations will appear
in the output. Fix serious/critical ones before merging, or baseline them if
deferring.

## Updating the baseline

The establish-baseline script reads from `test-results/a11y-violations.jsonl`
— a line-delimited file that **accumulates across runs**. This allows the full
36-route scan to be split into smaller batches (each batch appends rather than
overwriting).

After remediating violations, regenerate the baseline by running:

```bash
# 1. Clear the accumulation file so stale data doesn't persist
rm -f test-results/a11y-violations.jsonl

# 2. Run the full scan (or in batches — each appends to the JSONL)
npx playwright test --config playwright.a11y.config.ts

# 3. Re-establish the baseline from the fresh scan results
pnpm --filter @workspace/scripts run establish-a11y-baseline

# 4. Commit the updated .a11y-baseline.json
```

When adding a new violation to the baseline (deferring a fix):

1. Add the violation entry to `.a11y-baseline.json` manually or re-run the
   establish script after running the scan.
2. Set `followUpRef` to the real ticket or GitHub issue URL.
3. Commit both files in the same PR so the baseline and code change stay
   in sync.

## Baseline update policy

- Baseline entries **must** reference a follow-up ticket.
- Do not add serious/critical violations to the baseline without a P1/P2
  ticket assigned to the current or next sprint.
- Review and shrink the baseline quarterly as violations are remediated.
- Automated scans catch ~30–40 % of WCAG issues. Schedule manual screen
  reader and keyboard audits at least once per major release.
