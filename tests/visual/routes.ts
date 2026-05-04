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

export const THEMES: Theme[] = ["light", "dark"];

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

export const VISUAL_ROUTES: VisualRouteEntry[] = A11Y_ROUTES.map((route) => ({
  path: route.path,
  name: route.name,
  requiresAuth: route.requiresAuth,
  description: route.description,
  viewports: VIEWPORTS,
  themes: THEMES,
  maxDiffPixelRatio: CHART_ROUTES.has(route.path) ? 0.005 : 0.001,
  maskSelectors: [...VOLATILE_SELECTORS],
}));
