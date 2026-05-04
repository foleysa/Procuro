# Visual Regression Testing

Automated visual regression testing using Playwright's built-in screenshot comparison. On every test run, Playwright captures full-page screenshots of every dashboard route and compares them pixel-by-pixel against committed baselines. Any unintended visual change surfaces as a failed test with a diff image.

## Browser Coverage

The suite runs against multiple browser engines to catch browser-specific rendering regressions:

| Project name | Engine | Device profile | Default |
|---|---|---|---|
| `chromium-visual` | Chromium | Desktop Chrome | Yes |
| `firefox-visual` | Firefox | Desktop Firefox | Yes |
| `webkit-visual` | WebKit | Desktop Safari | Opt-in |

Chromium and Firefox run by default. WebKit is opt-in because it requires system libraries (`libgles2`, `gstreamer1.0-libav`) that may not be available in all environments.

Each browser gets its own set of baseline PNGs, stored in the same `tests/visual/baselines/` directory but differentiated by the project name in the filename (e.g. `home-dashboard-desktop-chromium-visual-linux.png` vs `home-dashboard-desktop-firefox-visual-linux.png`).

### Running specific browsers

To restrict to specific browsers or enable WebKit, set `VISUAL_BROWSERS`:

```bash
# Run only Chromium
VISUAL_BROWSERS=chromium-visual pnpm test:visual

# Run all three including WebKit (requires system deps)
VISUAL_BROWSERS=chromium-visual,firefox-visual,webkit-visual pnpm test:visual

# Update baselines for Firefox only
VISUAL_BROWSERS=firefox-visual pnpm test:visual:update
```

## How It Works

1. **Route inventory** (`tests/visual/routes.ts`) defines every route to capture, reusing the same list as the accessibility scanner.
2. **Parameterized tests** (`tests/visual/snapshots.visual.test.ts`) iterate over each route × viewport (desktop 1440×900 and tablet 768×1024).
3. Each test:
   - Sets the viewport size.
   - Authenticates via the `x-org-id` dev-tenant header bypass (same pattern as smoke and a11y tests).
   - Navigates to the route and waits for network idle.
   - Runs a `stabilizePage` helper that disables all animations/transitions, hides carets, waits for fonts to load, and pauses for a final paint cycle.
   - Masks volatile elements (timestamps, relative-time labels, counters) so they don't cause false diffs.
   - Calls `expect(page).toHaveScreenshot()` with the route's browser-specific threshold.
4. **Baselines** are committed PNGs in `tests/visual/baselines/`.

## Running the Tests

```bash
# Run the visual regression suite (all browsers)
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
3. Consider adding a route-specific override in `ROUTE_OVERRIDES` in `tests/visual/routes.ts` to raise the threshold for that specific route and browser.

### Browser-specific failures

Firefox and WebKit may render fonts, anti-aliasing, and sub-pixel layouts differently from Chromium. If a test fails in only one browser:

1. Confirm the diff is a genuine rendering difference, not a layout bug.
2. If the rendering difference is cosmetic and expected, check if the browser-specific global thresholds already provide enough tolerance. If not, add a route-specific override in `ROUTE_OVERRIDES` in `tests/visual/routes.ts` (preferred over raising the global threshold).
3. If the difference reveals a real layout bug, fix it in the CSS/component code.

## Adding New Routes

1. Add the route to `tests/a11y/routes.ts` (the visual inventory inherits from it).
2. If the route has charts or data visualizations, add its path to the `CHART_ROUTES` set in `tests/visual/routes.ts` to get a higher diff threshold.
3. Run `pnpm test:visual:update` to generate the initial baselines for all three browsers.
4. Commit the new baseline PNGs.

## Threshold Tuning

### Global per-browser thresholds

Thresholds are defined per-browser in `tests/visual/routes.ts` via `BROWSER_THRESHOLDS`:

| Browser | Static pages | Chart-heavy pages |
|---|---|---|
| Chromium | `0.001` (0.1%) | `0.005` (0.5%) |
| Firefox | `0.003` (0.3%) | `0.012` (1.2%) |
| WebKit | `0.003` (0.3%) | `0.012` (1.2%) |

Firefox and WebKit thresholds are set higher than Chromium to account for known cross-engine rendering differences:

- **Font rasterization**: Firefox uses its own text shaper with different sub-pixel anti-aliasing; WebKit uses a Core Text–style rasterizer. Both produce slightly different glyph outlines and hinting compared to Chromium/Skia, causing small per-pixel diffs on text-heavy pages.
- **SVG / chart rendering**: Recharts SVG paths, gradients, and anti-aliased curves render with measurably different sub-pixel coverage across engines, especially for complex data-viz pages.
- **CSS rendering**: Minor differences in border-radius interpolation, box-shadow blur, and gradient banding.

### Route-specific overrides

For routes with known larger cosmetic deltas, per-route overrides are defined in `ROUTE_OVERRIDES` in `tests/visual/routes.ts`. These take precedence over the global thresholds:

| Route | Browsers | Threshold | Reason |
|---|---|---|---|
| `/sign-in` | Firefox, WebKit | `0.015` (1.5%) | Clerk-rendered external widget with different form control styling |
| `/sign-up` | Firefox, WebKit | `0.015` (1.5%) | Clerk-rendered external widget with different form control styling |
| `/` | Firefox, WebKit | `0.018` (1.8%) | Dashboard with multiple chart panels and SVG-heavy sparklines |
| `/spend` | Firefox, WebKit | `0.018` (1.8%) | Dense Recharts area/bar charts with gradient fills |
| `/results` | Firefox, WebKit | `0.018` (1.8%) | Savings charts and billing visualizations |
| `/services` | Firefox, WebKit | `0.006` (0.6%) | Dense data tables with many text cells |
| `/suppliers` | Firefox, WebKit | `0.006` (0.6%) | Dense data tables with many text cells |
| `/contracts` | Firefox, WebKit | `0.006` (0.6%) | Dense data tables with many text cells |

To add a new override, add an entry to the `ROUTE_OVERRIDES` map in `tests/visual/routes.ts`. Each override specifies the route path, an optional list of browser project names, and the `maxDiffPixelRatio`.

The test file resolves the active project name at runtime via `test.info().project.name` and looks up the matching thresholds through the `getMaxDiffForRoute()` helper, which checks route-specific overrides first, then falls back to global browser thresholds.

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

## Environment Variables

| Variable | Description |
|---|---|
| `VISUAL_BASE_URL` | Override the target base URL |
| `VISUAL_ORG_ID` | Tenant org-id for dev-header auth bypass |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Override the Chromium binary |
| `PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH` | Override the Firefox binary |
| `VISUAL_BROWSERS` | Comma-separated list of projects to run (e.g. `chromium-visual,firefox-visual`). Defaults to all. |

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
    ├── home-dashboard-desktop-chromium-visual-linux.png
    ├── home-dashboard-desktop-firefox-visual-linux.png
    ├── home-dashboard-desktop-webkit-visual-linux.png
    ├── home-dashboard-tablet-chromium-visual-linux.png
    └── ...

playwright.visual.config.ts      # Playwright config for visual tests
scripts/update-visual-baselines.sh  # Helper script for baseline updates
```
