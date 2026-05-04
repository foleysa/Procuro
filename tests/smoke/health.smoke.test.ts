import { test, expect } from "@playwright/test";

/**
 * Pulls the array of opportunity rows out of the response body, accepting
 * the actual contract (`items`) as well as the legacy/spec shape (`data`)
 * so the smoke test stays green if the API contract evolves either way.
 */
function readOpportunitiesArray(body: unknown): unknown[] {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj["data"])) return obj["data"];
    if (Array.isArray(obj["items"])) return obj["items"];
  }
  return [];
}

test.describe("smoke: health & critical routes", () => {
  test("homepage returns 200 in under 3 seconds", async ({ request }) => {
    const start = Date.now();
    const response = await request.get("/");
    const elapsed = Date.now() - start;

    expect(response.status()).toBe(200);
    expect(elapsed).toBeLessThan(3_000);
  });

  test("GET /api/healthz returns 200 with status: ok", async ({ request }) => {
    const response = await request.get("/api/healthz");
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });

  test("no 5xx on critical routes (/, /api/healthz, /api/opportunities)", async ({
    request,
  }) => {
    const paths = ["/", "/api/healthz", "/api/opportunities"];
    for (const path of paths) {
      const response = await request.get(path);
      expect(
        response.status(),
        `expected ${path} to return < 500, got ${response.status()}`,
      ).toBeLessThan(500);
    }
  });

  test("GET /api/opportunities?limit=1 returns 200 with an opportunities array", async ({
    request,
  }) => {
    const response = await request.get("/api/opportunities?limit=1");
    expect(response.status()).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const rows = readOpportunitiesArray(body);
    expect(
      Array.isArray(rows),
      `expected response to contain an array under "data" or "items", got keys: ${Object.keys(body).join(", ")}`,
    ).toBe(true);
  });
});
