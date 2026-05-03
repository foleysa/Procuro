/**
 * WCAG 2.2 AA accessibility scan — all application routes.
 *
 * Runs axe-core against every route in the inventory. For each route it:
 *   1. Authenticates via the dev-tenant header bypass (x-org-id).
 *   2. Navigates and waits for network idle.
 *   3. Runs axe with WCAG 2.x + 2.2 AA tags.
 *   4. Partitions violations into "baselined" vs "new".
 *   5. Fails only on new serious or critical violations.
 *   6. Attaches full violation data for the baseline-establishment script.
 *
 * Run:
 *   npx playwright test --config playwright.a11y.config.ts
 *
 * Required env vars:
 *   A11Y_ORG_ID    Tenant org ID to use for the x-org-id auth header.
 *                  Defaults to the first entry in A11Y_ORG_IDS_CSV or the
 *                  hard-coded dev seed value.
 */

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { ROUTES, type RouteEntry } from "./routes";

// ── Auth setup ───────────────────────────────────────────────────────────────

const ORG_ID =
  process.env["A11Y_ORG_ID"] ??
  // Fall back to the primary dev-seed org
  "org-t272-55abafb4-dis";

const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
];

// ── Baseline loading ──────────────────────────────────────────────────────────

interface BaselineEntry {
  route: string;
  violationId: string;
  impact: string;
}

function loadBaseline(): BaselineEntry[] {
  const baselinePath = path.resolve(process.cwd(), ".a11y-baseline.json");
  if (!fs.existsSync(baselinePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(baselinePath, "utf8")) as BaselineEntry[];
  } catch {
    return [];
  }
}

function isBaselined(
  baseline: BaselineEntry[],
  route: string,
  violationId: string,
): boolean {
  return baseline.some(
    (e) => e.route === route && e.violationId === violationId,
  );
}

const SERIOUS_OR_CRITICAL = new Set(["serious", "critical"]);

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Build the full URL for a route entry. The Playwright `baseURL` is set in the
 * config; `page.goto` with a path-only string will prepend it automatically.
 */
function routeUrl(entry: RouteEntry): string {
  return entry.path;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const baseline = loadBaseline();

for (const entry of ROUTES) {
  test(`a11y: ${entry.name} (${entry.path})`, async ({ page }, testInfo) => {
    // Apply the dev-tenant auth header only for routes that require authentication.
    // Public routes (requiresAuth: false) are scanned without any tenant context
    // so the public-facing experience is what axe evaluates.
    if (entry.requiresAuth) {
      await page.setExtraHTTPHeaders({ "x-org-id": ORG_ID });
    }

    // Navigate — tolerate both 200 and non-200 status codes because some
    // parameterised routes (e.g. detail pages with placeholder UUIDs) will
    // render a 404 / not-found page. We still want to scan whatever is rendered.
    await page.goto(routeUrl(entry), { waitUntil: "networkidle" });

    // Give JS-heavy pages a moment to finish hydrating after network idle.
    // Playwright's networkidle fires after 500 ms of no requests, but React
    // may still be running effects synchronously after that window.
    await page.waitForTimeout(1_500);

    // Run axe scan
    const axeResults = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      // Exclude third-party widgets that we cannot control
      .exclude("#clerk-components")
      .exclude("[data-clerk-component]")
      .analyze();

    const { violations } = axeResults;

    // Attach full results for the baseline-establishment script
    const routeResult = {
      route: entry.path,
      routeName: entry.name,
      violations: violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map((n) => ({
          html: n.html,
          target: n.target as string[],
          failureSummary: n.failureSummary,
        })),
      })),
    };

    await testInfo.attach("axe-violations", {
      body: JSON.stringify(routeResult),
      contentType: "application/json",
    });

    // Also append to the accumulation file so batched runs build up a full
    // picture. This file survives across playwright invocations (unlike the
    // JSON reporter which is overwritten each run).
    const accumulationPath = "test-results/a11y-violations.jsonl";
    fs.mkdirSync("test-results", { recursive: true });
    fs.appendFileSync(
      accumulationPath,
      JSON.stringify(routeResult) + "\n",
      "utf8",
    );

    // Partition into baselined vs new
    const newViolations = violations.filter(
      (v) => !isBaselined(baseline, entry.path, v.id),
    );
    const newSeriousOrCritical = newViolations.filter((v) =>
      SERIOUS_OR_CRITICAL.has(v.impact ?? ""),
    );

    // Build a human-readable summary for the test report
    const summary = [
      `Route: ${entry.name} (${entry.path})`,
      `Total violations: ${violations.length}`,
      `  Baselined (pass): ${violations.length - newViolations.length}`,
      `  New (all impacts): ${newViolations.length}`,
      `  New serious/critical: ${newSeriousOrCritical.length}`,
      "",
    ];

    if (newViolations.length > 0) {
      summary.push("New violations:");
      for (const v of newViolations) {
        summary.push(
          `  [${v.impact?.toUpperCase()}] ${v.id}: ${v.description}`,
        );
        summary.push(`    Help: ${v.helpUrl}`);
        for (const node of v.nodes.slice(0, 3)) {
          const targets = (node.target as string[]).join(", ");
          summary.push(`    Node: ${targets}`);
        }
      }
    }

    console.log(summary.join("\n"));

    // Gate: fail only on new serious or critical violations
    if (newSeriousOrCritical.length > 0) {
      const failureLines = [
        `${newSeriousOrCritical.length} new serious/critical WCAG 2.2 AA violation(s) on "${entry.name}" (${entry.path}).`,
        "Fix or baseline these before merging.\n",
      ];

      for (const v of newSeriousOrCritical) {
        failureLines.push(`• [${v.impact?.toUpperCase()}] ${v.id}`);
        failureLines.push(`  ${v.description}`);
        failureLines.push(`  Help: ${v.helpUrl}`);
        for (const node of v.nodes.slice(0, 5)) {
          const targets = (node.target as string[]).join(", ");
          failureLines.push(`  Affected: ${targets}`);
          if (node.failureSummary) {
            failureLines.push(`  Reason: ${node.failureSummary}`);
          }
        }
        failureLines.push("");
      }

      expect.soft(
        newSeriousOrCritical.length,
        failureLines.join("\n"),
      ).toBe(0);
    }

    // Non-blocking: log new moderate/minor violations as annotations
    const newMinor = newViolations.filter(
      (v) => !SERIOUS_OR_CRITICAL.has(v.impact ?? ""),
    );
    for (const v of newMinor) {
      testInfo.annotations.push({
        type: "warning",
        description: `New moderate/minor a11y: [${v.impact}] ${v.id} — ${v.description}`,
      });
    }
  });
}
