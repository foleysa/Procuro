/**
 * Route inventory for visual regression snapshot testing.
 *
 * Reuses the same route list as the a11y inventory but extends each entry
 * with viewport definitions, per-route pixel-diff thresholds, and mask
 * selectors for volatile elements (timestamps, relative-time labels,
 * animated counters, etc.).
 *
 * Each route is tested across every viewport × theme combination so that
 * both light and dark mode regressions are caught.
 */

import { ROUTES as A11Y_ROUTES } from "../a11y/routes";

export type Viewport = {
  name: string;
  width: number;
  height: number;
};

export const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
];

export type Theme = "light" | "dark";

const ALL_THEMES: Theme[] = ["light", "dark"];

const envTheme = process.env["VISUAL_THEME"]?.toLowerCase();

export const THEMES: Theme[] =
  envTheme === "light" || envTheme === "dark"
    ? [envTheme]
    : ALL_THEMES;

export type VisualRouteEntry = {
  path: string;
  name: string;
  requiresAuth: boolean;
  description: string;
  viewports: Viewport[];
  themes: Theme[];
  maxDiffPixelRatio: number;
  maskSelectors: string[];
};

const VOLATILE_SELECTORS = [
  '[data-testid*="timestamp"]',
  '[data-testid*="ago"]',
  '[data-testid*="date"]',
  "time",
  '[class*="relative-time"]',
  '[class*="timeAgo"]',
  '[data-testid="last-updated"]',
  '[data-testid*="count"]',
  '[data-testid*="badge-count"]',
];

const CHART_ROUTES = new Set([
  "/",
  "/spend",
  "/results",
  "/operations",
  "/engine",
]);

const CHROMIUM_THRESHOLDS = {
  static: 0.001,
  chart: 0.005,
};

const FIREFOX_THRESHOLDS = {
  static: 0.002,
  chart: 0.008,
};

const WEBKIT_THRESHOLDS = {
  static: 0.002,
  chart: 0.008,
};

export const BROWSER_THRESHOLDS: Record<
  string,
  { static: number; chart: number }
> = {
  "chromium-visual": CHROMIUM_THRESHOLDS,
  "firefox-visual": FIREFOX_THRESHOLDS,
  "webkit-visual": WEBKIT_THRESHOLDS,
};

export function getMaxDiffForRoute(
  routePath: string,
  projectName?: string,
): number {
  const key = projectName ?? "chromium-visual";
  const thresholds = BROWSER_THRESHOLDS[key] ?? CHROMIUM_THRESHOLDS;
  return CHART_ROUTES.has(routePath) ? thresholds.chart : thresholds.static;
}

export const VISUAL_ROUTES: VisualRouteEntry[] = A11Y_ROUTES.map((route) => ({
  path: route.path,
  name: route.name,
  requiresAuth: route.requiresAuth,
  description: route.description,
  viewports: VIEWPORTS,
  themes: THEMES,
  maxDiffPixelRatio: CHROMIUM_THRESHOLDS.static,
  maskSelectors: [...VOLATILE_SELECTORS],
}));
