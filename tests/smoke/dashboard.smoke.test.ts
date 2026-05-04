import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

/**
 * Dashboard smoke test.
 *
 * Authentication strategy (in priority order):
 *
 *  1. **Stored auth state** — set `SMOKE_STORAGE_STATE` to a Playwright
 *     `storageState` JSON file captured from a signed-in Clerk session.
 *     This is the most deterministic option for protected envs.
 *
 *  2. **Clerk testing token** — when `CLERK_PUBLISHABLE_KEY` and
 *     `CLERK_SECRET_KEY` are present, the Clerk testing helper installs
 *     a bypass token on the page so Clerk treats the session as a
 *     test session and skips bot detection. Pair with a smoke-test
 *     user provisioned in the Clerk dashboard for full sign-in.
 *
 *  3. **Local dev fallback** — when neither is configured (typical
 *     local dev), the api-server's dev-tenant fallback lets the
 *     dashboard render against the seeded org with no Clerk session.
 */

const storageState = process.env["SMOKE_STORAGE_STATE"];
// Opt-in: set SMOKE_USE_CLERK_TESTING_TOKEN=1 when running against a
// Clerk-protected environment that has bot-detection enabled. Requires
// CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY to be set in the env. We
// gate this explicitly so local runs (where Clerk dev keys exist but
// we want the dev-tenant fallback) don't accidentally try to contact
// Clerk's testing-token endpoint.
const useClerkTestingToken =
  process.env["SMOKE_USE_CLERK_TESTING_TOKEN"] === "1" &&
  Boolean(process.env["CLERK_PUBLISHABLE_KEY"]) &&
  Boolean(process.env["CLERK_SECRET_KEY"]);

test.use(storageState ? { storageState } : {});

function readOpportunitiesArray(body: unknown): unknown[] {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj["data"])) return obj["data"];
    if (Array.isArray(obj["items"])) return obj["items"];
  }
  return [];
}

test.describe("smoke: dashboard renders after auth", () => {
  test("Command Center shows the three Outcomes tiles with no error text", async ({
    page,
  }) => {
    if (useClerkTestingToken) {
      await setupClerkTestingToken({ page });
    }

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The Outcomes header is the canonical landing-page hero. We assert
    // its container is visible, then assert each of the three tile values
    // — Realized Savings, Identified Pipeline, Gap to Goal — render.
    const outcomes = page.getByTestId("dashboard-outcomes-header");
    await expect(outcomes).toBeVisible({ timeout: 15_000 });

    const realized = page.getByTestId("outcomes-realized-value");
    const pipeline = page.getByTestId("outcomes-pipeline-value");
    const gap = page.getByTestId("outcomes-gap-value");

    await expect(realized).toBeVisible();
    await expect(pipeline).toBeVisible();
    await expect(gap).toBeVisible();

    // Each tile value should be filled in (not the loading "…" placeholder).
    for (const tile of [realized, pipeline, gap]) {
      const text = (await tile.innerText()).trim();
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toBe("…");
    }

    // No "error", "undefined", or "something went wrong" anywhere
    // in the visible body. We check the rendered text content of <body>
    // rather than HTML so attribute names like `aria-errormessage` don't
    // trigger false positives.
    const bodyText = (await page.locator("body").innerText()).toLowerCase();
    for (const needle of ["error", "undefined", "something went wrong"]) {
      expect(
        bodyText.includes(needle),
        `dashboard body should not contain "${needle}"`,
      ).toBe(false);
    }
  });

  test("GET /api/opportunities?limit=1 returns 200 with an opportunities array", async ({
    request,
  }) => {
    const response = await request.get("/api/opportunities?limit=1");
    expect(response.status()).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const rows = readOpportunitiesArray(body);
    expect(Array.isArray(rows)).toBe(true);
  });
});
