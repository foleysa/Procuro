/**
 * A11y route-coverage check.
 *
 * Compares the routes defined in the frontend router (App.tsx) against the
 * a11y scan inventory (`routes.ts`). Any route that exists in the router but
 * is missing from the inventory is flagged so new pages don't silently skip
 * accessibility scanning.
 *
 * Run:
 *   npx playwright test --config playwright.a11y.config.ts route-coverage
 *
 * This test does NOT launch a browser — it is a pure static analysis check
 * that reads the router source file and compares path strings.
 */

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ROUTES } from "./routes";

const APP_TSX_PATH = path.resolve(
  __dirname,
  "../../artifacts/command-center/src/App.tsx",
);

/**
 * Paths that are intentionally excluded from the a11y scan inventory.
 * Each entry should have a brief reason so reviewers know why it's skipped.
 */
const KNOWN_EXCLUSIONS: Record<string, string> = {
  "/dashboard": "Redirect to /",
  "/today": "Redirect to /",
  "/admin/taxonomy": "Redirect to /admin/taxonomy/queue",
  "/admin/funnel": "Redirect to /engine",
  "/onboarding": "One-time wizard, not a permanent scannable page",
  "/sign-in/*?": "Wildcard Clerk route — covered by /sign-in entry",
  "/sign-up/*?": "Wildcard Clerk route — covered by /sign-up entry",
};

function extractRouterPaths(source: string): string[] {
  const routePathRegex = /<Route\s+path="([^"]+)"/g;
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = routePathRegex.exec(source)) !== null) {
    paths.push(match[1]);
  }
  return [...new Set(paths)];
}

function normalizeInventoryPath(p: string): string {
  return p
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "/:id")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i, "/:id/");
}

function stripWouterWildcard(p: string): string {
  return p.replace(/\/\*\??$/, "");
}

test("all router paths are covered by the a11y scan inventory", () => {
  const source = fs.readFileSync(APP_TSX_PATH, "utf8");
  const routerPaths = extractRouterPaths(source);

  const inventoryPaths = new Set(
    ROUTES.map((r) => normalizeInventoryPath(r.path)),
  );

  const missingPaths: string[] = [];

  for (const rp of routerPaths) {
    if (KNOWN_EXCLUSIONS[rp]) continue;

    if (!inventoryPaths.has(rp)) {
      missingPaths.push(rp);
    }
  }

  if (missingPaths.length > 0) {
    const message = [
      `${missingPaths.length} route(s) in App.tsx are missing from the a11y scan inventory (tests/a11y/routes.ts):`,
      "",
      ...missingPaths.map((p) => `  • ${p}`),
      "",
      "Add these routes to ROUTES in tests/a11y/routes.ts, or add them to",
      "KNOWN_EXCLUSIONS in tests/a11y/route-coverage.test.ts with a reason.",
    ];
    expect(missingPaths, message.join("\n")).toHaveLength(0);
  }
});

test("a11y inventory does not list routes that no longer exist in the router", () => {
  const source = fs.readFileSync(APP_TSX_PATH, "utf8");
  const routerPaths = extractRouterPaths(source);
  const strippedRouterPaths = new Set(routerPaths.map(stripWouterWildcard));

  const staleRoutes: string[] = [];

  for (const entry of ROUTES) {
    const normalized = normalizeInventoryPath(entry.path);
    if (!strippedRouterPaths.has(normalized)) {
      staleRoutes.push(`${entry.name} (${entry.path})`);
    }
  }

  if (staleRoutes.length > 0) {
    const message = [
      `${staleRoutes.length} route(s) in the a11y inventory no longer exist in App.tsx:`,
      "",
      ...staleRoutes.map((r) => `  • ${r}`),
      "",
      "Remove these from ROUTES in tests/a11y/routes.ts.",
    ];
    expect(staleRoutes, message.join("\n")).toHaveLength(0);
  }
});

test("KNOWN_EXCLUSIONS lists only paths that actually exist in the router", () => {
  const source = fs.readFileSync(APP_TSX_PATH, "utf8");
  const routerPaths = new Set(extractRouterPaths(source));

  const phantomExclusions: string[] = [];
  for (const p of Object.keys(KNOWN_EXCLUSIONS)) {
    if (!routerPaths.has(p)) {
      phantomExclusions.push(`${p} — ${KNOWN_EXCLUSIONS[p]}`);
    }
  }

  if (phantomExclusions.length > 0) {
    const message = [
      `${phantomExclusions.length} KNOWN_EXCLUSION(s) reference paths not in App.tsx:`,
      "",
      ...phantomExclusions.map((p) => `  • ${p}`),
      "",
      "Remove stale exclusions from KNOWN_EXCLUSIONS in route-coverage.test.ts.",
    ];
    expect(phantomExclusions, message.join("\n")).toHaveLength(0);
  }
});
