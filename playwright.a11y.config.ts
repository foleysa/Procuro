import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Playwright configuration for WCAG 2.2 AA accessibility scans.
 *
 * Run:   npx playwright test --config playwright.a11y.config.ts
 * Env vars:
 *   A11Y_BASE_URL                      Override the target base URL (default: Replit dev domain)
 *   A11Y_ORG_ID                        The tenant org-id to use for the dev-header auth bypass
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH Override the Chromium binary (any environment)
 *
 * NixOS note: the Playwright-bundled Chromium headless shell requires glibc
 * shared libraries that are not on the default LD path in Nix. We instead
 * use the Nix-managed Playwright Chromium binary which is properly linked.
 * The binary is discovered dynamically from /nix/store so it stays valid
 * across Nix package hash changes; the env override takes precedence.
 */

/** Discover the highest-version Nix-managed Playwright Chromium binary. */
function findNixChromium(): string | undefined {
  const nixStore = "/nix/store";
  try {
    const entries = fs.readdirSync(nixStore);
    const candidates = entries
      .filter((e) => e.includes("playwright-browsers-chromium"))
      .map((e) => {
        // chromium-NNNN/chrome-linux/chrome
        const chromiumDir = path.join(nixStore, e);
        try {
          const sub = fs.readdirSync(chromiumDir).find((d) => d.startsWith("chromium-"));
          if (!sub) return undefined;
          const bin = path.join(chromiumDir, sub, "chrome-linux", "chrome");
          return fs.existsSync(bin) ? bin : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((p): p is string => p !== undefined)
      // Sort descending so the newest build (largest revision number) is first
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return candidates[0];
  } catch {
    return undefined;
  }
}

/**
 * Resolution order for the Chromium binary:
 *   1. Explicit `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env var (highest priority).
 *   2. Nix-managed Playwright Chromium (only when running inside the Replit
 *      Nix container).
 *   3. `undefined` — let Playwright use its own installed browser. This is the
 *      path used in GitHub Actions CI where `npx playwright install chromium`
 *      provides the binary at the standard cache location.
 */
const executablePath =
  process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] ?? findNixChromium();

const replitDomain = process.env["REPLIT_DEV_DOMAIN"] ?? process.env["REPLIT_DOMAINS"]?.split(",")[0];
const defaultBaseUrl = replitDomain
  ? `https://${replitDomain}`
  : "http://localhost:80";

export default defineConfig({
  testDir: "./tests/a11y",
  testMatch: ["**/*.a11y.test.ts", "**/route-coverage.test.ts"],

  /* Generous timeout — pages may be slow to hydrate in dev */
  timeout: 60_000,
  expect: { timeout: 15_000 },

  /* One retry to smooth over transient network hiccups */
  retries: 1,

  /* Run tests serially to avoid hammering the dev server */
  workers: 1,

  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/a11y-report.json" }],
    ["html", { outputFolder: "test-results/a11y-html", open: "never" }],
    ["./tests/a11y/ingest-reporter.ts"],
  ],

  use: {
    baseURL: process.env["A11Y_BASE_URL"] ?? defaultBaseUrl,
    /* Wait for the network to be fully idle before axe scans */
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
    /* Capture screenshots on failure for debugging */
    screenshot: "only-on-failure",
    /* Trace on first retry */
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium-a11y",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],

  outputDir: "test-results/a11y-artifacts",
});
