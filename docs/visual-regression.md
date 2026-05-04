# Visual Regression Testing

Automated visual regression testing using Playwright's built-in screenshot comparison. On every test run, Playwright captures full-page screenshots of every dashboard route and compares them pixel-by-pixel against committed baselines. Any unintended visual change surfaces as a failed test with a diff image.

## How It Works

1. **Route inventory** (`tests/visual/routes.ts`) defines every route to capture, reusing the same list as the accessibility scanner.
2. **Parameterized tests** (`tests/visual/snapshots.visual.test.ts`) iterate over each route × viewport (desktop 1440×900 and tablet 768×1024).
3. Each test:
   - Sets the viewport size.
   - Authenticates via the `x-org-id` dev-tenant header bypass (same pattern as smoke and a11y tests).
   - Navigates to the route and waits for network idle.
   - Runs a `stabilizePage` helper that disables all animations/transitions, hides carets, waits for fonts to load, and pauses for a final paint cycle.
   - Masks volatile elements (timestamps, relative-time labels, counters) so they don't cause false diffs.
   - Calls `expect(page).toHaveScreenshot()` with the route's configured threshold.
4. **Baselines** are committed PNGs in `tests/visual/baselines/`.

## Running the Tests

```bash
# Run the visual regression suite
pnpm test:visual

# Update all baselines (after intentional UI changes)
pnpm test:visual:update

# Update baselines for a specific route
./scripts/update-visual-baselines.sh "Dashboard"
```

## Handling Failures

### Intentional UI changes

When you make a deliberate UI change (new component, restyled page, layout shift):

1. Run `pnpm test:visual` to see which baselines are affected.
2. Review the diff images in `test-results/visual-artifacts/` to confirm the changes are expected.
3. Run `pnpm test:visual:update` to regenerate baselines.
4. Review the updated PNGs in `tests/visual/baselines/`.
5. Commit the updated baselines alongside your UI changes.

### Unintentional failures

If a visual test fails and you did **not** make a UI change:

1. Check the diff image — it highlights the pixel differences.
2. Investigate what caused the visual drift (dependency update, inherited style change, data-driven layout shift).
3. Fix the root cause rather than updating the baseline.

### Flaky failures

If a test fails intermittently:

1. Check if a volatile element is not being masked — add its selector to `VOLATILE_SELECTORS` in `tests/visual/routes.ts`.
2. Check if a chart or animation is not fully settled — the `stabilizePage` helper may need a longer wait.
3. Consider raising the `maxDiffPixelRatio` threshold for that specific route.

## Adding New Routes

1. Add the route to `tests/a11y/routes.ts` (the visual inventory inherits from it).
2. If the route has charts or data visualizations, add its path to the `CHART_ROUTES` set in `tests/visual/routes.ts` to get a higher diff threshold (0.5% vs 0.1%).
3. Run `pnpm test:visual:update` to generate the initial baseline.
4. Commit the new baseline PNG.

## Threshold Tuning

Default thresholds are set in `tests/visual/routes.ts`:

| Route type | `maxDiffPixelRatio` | Notes |
|---|---|---|
| Static pages | `0.001` (0.1%) | Forms, settings, lists |
| Chart-heavy pages | `0.005` (0.5%) | Dashboard, Spend, Results, Operations, Engine |

To override for a specific route, modify the route entry in `VISUAL_ROUTES` or adjust the `CHART_ROUTES` set.

## Stabilization Rules

The `stabilizePage` helper in the test file:

- Injects CSS that sets `animation-duration`, `animation-delay`, `transition-duration`, and `transition-delay` to `0s` on all elements.
- Hides text carets with `caret-color: transparent`.
- Waits for `document.fonts.ready` to ensure web fonts are fully loaded.
- Waits for `networkidle` state.
- Adds a 500ms buffer for final paint/layout completion.

## Viewports

| Name | Dimensions | Notes |
|---|---|---|
| Desktop | 1440×900 | Standard laptop/desktop |
| Tablet | 768×1024 | iPad-style portrait |

Mobile (375×667) is out of scope for now.

## Migration Path to Percy / Chromatic

If the project outgrows local snapshot testing:

1. **Percy**: Replace `toHaveScreenshot()` calls with `percySnapshot()`. Percy handles baseline storage, cross-browser diffs, and approval workflows in the cloud.
2. **Chromatic**: Best suited if the project adopts Storybook. Chromatic captures per-component snapshots automatically from stories.

Both services eliminate the need to commit baseline PNGs and provide better collaboration workflows for design review. The route inventory and stabilization logic can be reused with either service.

## File Layout

```
tests/visual/
├── routes.ts                    # Route inventory with thresholds and masks
├── snapshots.visual.test.ts     # Parameterized snapshot tests
└── baselines/                   # Committed baseline PNGs (tracked in git)
    ├── home-dashboard-desktop-chromium-visual.png
    ├── home-dashboard-tablet-chromium-visual.png
    └── ...

playwright.visual.config.ts      # Playwright config for visual tests
scripts/update-visual-baselines.sh  # Helper script for baseline updates
```
