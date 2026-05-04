import { defineConfig, devices } from "@playwright/test";

const replitDomain = process.env["REPLIT_DEV_DOMAIN"];
const fallbackBaseUrl = replitDomain
  ? `https://${replitDomain}`
  : "http://localhost:80";

const baseURL = process.env["SMOKE_BASE_URL"] ?? fallbackBaseUrl;

const chromiumExecutable = process.env["REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: "tests/smoke",
  testMatch: /.*\.smoke\.test\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: chromiumExecutable
          ? { executablePath: chromiumExecutable }
          : undefined,
      },
    },
  ],
});
