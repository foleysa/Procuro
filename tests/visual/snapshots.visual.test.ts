/**
 * Visual regression snapshot tests.
 *
 * For each route × viewport combination, captures a full-page screenshot
 * and compares it pixel-by-pixel against committed baselines. Any
 * unintended visual change surfaces as a failed test with a diff image.
 *
 * Run:   pnpm test:visual
 * Update baselines:  pnpm test:visual:update
 */

import { test, expect } from "@playwright/test";
import { VISUAL_ROUTES } from "./routes";

const ORG_ID = process.env["VISUAL_ORG_ID"] ?? "org-t272-55abafb4-dis";

async function stabilizePage(
  page: import("@playwright/test").Page,
  maskSelectors: string[],
): Promise<void> {
  const maskCss = maskSelectors
    .map(
      (sel) =>
        `${sel} { visibility: hidden !important; }`,
    )
    .join("\n");

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
    const testName = `${route.name} @ ${viewport.name} (${viewport.width}×${viewport.height})`;
    const snapshotName = `${route.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "").toLowerCase()}-${viewport.name}.png`;

    test(testName, async ({ page }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });

      if (route.requiresAuth) {
        await page.setExtraHTTPHeaders({ "x-org-id": ORG_ID });
      }

      await page.goto(route.path, {
        waitUntil: "networkidle",
      });

      await stabilizePage(page, route.maskSelectors);

      await expect(page).toHaveScreenshot(snapshotName, {
        fullPage: true,
        maxDiffPixelRatio: route.maxDiffPixelRatio,
      });
    });
  }
}
