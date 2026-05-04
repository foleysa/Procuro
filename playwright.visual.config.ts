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
 *   PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH   Override the Firefox binary
 *   VISUAL_BROWSERS                      Comma-separated list of browser projects to run
 *                                        (e.g. "chromium-visual,firefox-visual")
 *                                        Defaults to all three browsers.
 */

function findNixBrowser(
  dirPattern: string,
  binaryRelPath: string | ((dir: string) => string | undefined),
): string | undefined {
  const nixStore = "/nix/store";
  try {
    const entries = fs.readdirSync(nixStore);
    const candidates = entries
      .filter((e) => e.includes(dirPattern))
      .map((e) => {
        const fullDir = path.join(nixStore, e);
        try {
          if (typeof binaryRelPath === "function") {
            return binaryRelPath(fullDir);
          }
          const bin = path.join(fullDir, binaryRelPath);
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

function findNixChromium(): string | undefined {
  return findNixBrowser("playwright-browsers-chromium", (dir) => {
    const sub = fs
      .readdirSync(dir)
      .find((d) => d.startsWith("chromium-"));
    if (!sub) return undefined;
    const bin = path.join(dir, sub, "chrome-linux", "chrome");
    return fs.existsSync(bin) ? bin : undefined;
  });
}

function findNixFirefox(): string | undefined {
  return findNixBrowser("playwright-firefox", "firefox/firefox");
}

const chromiumExec =
  process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] ?? findNixChromium();
const firefoxExec =
  process.env["PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH"] ?? findNixFirefox();

const replitDomain =
  process.env["REPLIT_DEV_DOMAIN"] ??
  process.env["REPLIT_DOMAINS"]?.split(",")[0];
const defaultBaseUrl = replitDomain
  ? `https://${replitDomain}`
  : "http://localhost:80";

const defaultProjects = [
  {
    name: "chromium-visual",
    use: {
      ...devices["Desktop Chrome"],
      launchOptions: chromiumExec ? { executablePath: chromiumExec } : {},
    },
  },
  {
    name: "firefox-visual",
    use: {
      ...devices["Desktop Firefox"],
      launchOptions: firefoxExec ? { executablePath: firefoxExec } : {},
    },
  },
];

const optInProjects = [
  {
    name: "webkit-visual",
    use: {
      ...devices["Desktop Safari"],
    },
  },
];

const allProjects = [...defaultProjects, ...optInProjects];

const enabledBrowsers = process.env["VISUAL_BROWSERS"]
  ? process.env["VISUAL_BROWSERS"].split(",").map((b) => b.trim())
  : undefined;

const projects = enabledBrowsers
  ? allProjects.filter((p) => enabledBrowsers.includes(p.name))
  : defaultProjects;

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
    ignoreHTTPSErrors: true,
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
    screenshot: "only-on-failure",
    trace: "off",
  },

  projects,

  outputDir: "test-results/visual-artifacts",
});
