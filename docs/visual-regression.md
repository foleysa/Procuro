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
3. Consider raising the threshold for that specific route in `BROWSER_THRESHOLDS`.

### Browser-specific failures

Firefox and WebKit may render fonts, anti-aliasing, and sub-pixel layouts differently from Chromium. If a test fails in only one browser:

1. Confirm the diff is a genuine rendering difference, not a layout bug.
2. If the rendering difference is cosmetic and expected, the browser-specific thresholds already provide extra tolerance. If that's not enough, increase the threshold for the affected browser in `tests/visual/routes.ts` → `BROWSER_THRESHOLDS`.
3. If the difference reveals a real layout bug, fix it in the CSS/component code.

## Adding New Routes

1. Add the route to `tests/a11y/routes.ts` (the visual inventory inherits from it).
2. If the route has charts or data visualizations, add its path to the `CHART_ROUTES` set in `tests/visual/routes.ts` to get a higher diff threshold.
3. Run `pnpm test:visual:update` to generate the initial baselines for all three browsers.
4. Commit the new baseline PNGs.

## Threshold Tuning

Thresholds are defined per-browser in `tests/visual/routes.ts` via `BROWSER_THRESHOLDS`:

| Browser | Static pages | Chart-heavy pages |
|---|---|---|
| Chromium | `0.001` (0.1%) | `0.005` (0.5%) |
| Firefox | `0.002` (0.2%) | `0.008` (0.8%) |
| WebKit | `0.002` (0.2%) | `0.008` (0.8%) |

Firefox and WebKit use slightly higher thresholds because their font rasterizers and anti-aliasing engines produce minor sub-pixel differences compared to Chromium. These defaults are conservative; adjust them per-browser if you see persistent false positives.

The test file resolves the active project name at runtime via `test.info().project.name` and looks up the matching thresholds through the `getMaxDiffForRoute()` helper.

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
