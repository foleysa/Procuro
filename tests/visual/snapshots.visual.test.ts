/**
 * Visual regression snapshot tests.
 *
 * For each route × viewport × theme combination, captures a full-page
 * screenshot and compares it pixel-by-pixel against committed baselines.
 * Any unintended visual change surfaces as a failed test with a diff image.
 *
 * Theme toggling:
 *   The app uses Tailwind's class-based dark mode. Adding the `dark` class
 *   to the <html> element activates dark-mode CSS variables. We inject this
 *   class *before* the page navigates so every resource renders in the
 *   target theme from the start—no flash of the wrong theme.
 *
 * Run:   pnpm test:visual
 * Update baselines:  pnpm test:visual:update
 */

import { test, expect } from "@playwright/test";
import type { Theme } from "./routes";
import { VISUAL_ROUTES } from "./routes";

const ORG_ID = process.env["VISUAL_ORG_ID"] ?? "org-t272-55abafb4-dis";

async function applyTheme(
  page: import("@playwright/test").Page,
  theme: Theme,
): Promise<void> {
  await page.addInitScript((t: string) => {
    if (t === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, theme);
}

async function stabilizePage(
  page: import("@playwright/test").Page,
  maskSelectors: string[],
  theme: Theme,
): Promise<void> {
  const maskCss = maskSelectors
    .map(
      (sel) =>
        `${sel} { visibility: hidden !important; }`,
    )
    .join("\n");

  if (theme === "dark") {
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
    });
  }

  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      input, textarea { caret-color: transparent !important; }
      [class*="animate"], [class*="transition"] {
        animation: none !important;
        transition: none !important;
      }
      ${maskCss}
    `,
  });

  await page.waitForLoadState("networkidle");

  await page.evaluate(() => {
    return document.fonts.ready;
  });

  await page.waitForTimeout(500);
}

for (const route of VISUAL_ROUTES) {
  for (const viewport of route.viewports) {
    for (const theme of route.themes) {
      const testName = `${route.name} @ ${viewport.name} ${theme} (${viewport.width}×${viewport.height})`;
      const slug = route.name
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/-+$/, "")
        .toLowerCase();
      const snapshotName = `${slug}-${viewport.name}-${theme}.png`;

      test(testName, async ({ page }) => {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });

        await applyTheme(page, theme);

        if (route.requiresAuth) {
          await page.setExtraHTTPHeaders({ "x-org-id": ORG_ID });
        }

        await page.goto(route.path, {
          waitUntil: "networkidle",
        });

        await stabilizePage(page, route.maskSelectors, theme);

        await expect(page).toHaveScreenshot(snapshotName, {
          fullPage: true,
          maxDiffPixelRatio: route.maxDiffPixelRatio,
        });
      });
    }
  }
}
