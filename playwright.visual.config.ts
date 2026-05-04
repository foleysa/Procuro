import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Playwright configuration for visual regression snapshot testing.
 *
 * Run:   pnpm test:visual
 * Update baselines:  pnpm test:visual:update
 *
 * Env vars:
 *   VISUAL_BASE_URL                     Override the target base URL
 *   VISUAL_ORG_ID                       Tenant org-id for dev-header auth bypass
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  Override the Chromium binary
 */

function findNixChromium(): string | undefined {
  const nixStore = "/nix/store";
  try {
    const entries = fs.readdirSync(nixStore);
    const candidates = entries
      .filter((e) => e.includes("playwright-browsers-chromium"))
      .map((e) => {
        const chromiumDir = path.join(nixStore, e);
        try {
          const sub = fs
            .readdirSync(chromiumDir)
            .find((d) => d.startsWith("chromium-"));
          if (!sub) return undefined;
          const bin = path.join(chromiumDir, sub, "chrome-linux", "chrome");
          return fs.existsSync(bin) ? bin : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((p): p is string => p !== undefined)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return candidates[0];
  } catch {
    return undefined;
  }
}

const executablePath =
  process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] ?? findNixChromium();

const replitDomain =
  process.env["REPLIT_DEV_DOMAIN"] ??
  process.env["REPLIT_DOMAINS"]?.split(",")[0];
const defaultBaseUrl = replitDomain
  ? `https://${replitDomain}`
  : "http://localhost:80";

export default defineConfig({
  testDir: "./tests/visual",
  testMatch: "**/*.visual.test.ts",

  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },

  retries: 0,
  workers: 1,
  fullyParallel: false,

  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/visual-results.json" }],
    ["html", { outputFolder: "playwright-visual-report", open: "never" }],
  ],

  snapshotPathTemplate:
    "tests/visual/baselines/{arg}{-projectName}{-snapshotSuffix}{ext}",

  use: {
    baseURL: process.env["VISUAL_BASE_URL"] ?? defaultBaseUrl,
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
    screenshot: "only-on-failure",
    trace: "off",
  },

  projects: [
    {
      name: "chromium-visual",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],

  outputDir: "test-results/visual-artifacts",
});
