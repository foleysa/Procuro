import { test, expect } from "@playwright/test";

test.describe("smoke: static assets", () => {
  test("homepage loads without any failed JS/CSS/font assets", async ({
    page,
  }) => {
    const failures: Array<{ url: string; status: number; type: string }> = [];

    page.on("response", (response) => {
      const status = response.status();
      if (status < 400) return;

      const request = response.request();
      const resourceType = request.resourceType();
      if (
        resourceType !== "script" &&
        resourceType !== "stylesheet" &&
        resourceType !== "font"
      ) {
        return;
      }

      failures.push({ url: response.url(), status, type: resourceType });
    });

    const response = await page.goto("/", { waitUntil: "load" });
    expect(response?.status() ?? 0).toBeLessThan(400);

    expect(
      failures,
      `static asset(s) returned 4xx/5xx:\n${failures
        .map((f) => `  [${f.status}] ${f.type} ${f.url}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
