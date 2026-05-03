#!/usr/bin/env tsx
/**
 * establish-a11y-baseline.ts
 *
 * Reads the JSON report produced by the accessibility scan
 * (`test-results/a11y-report.json`) and writes `.a11y-baseline.json`
 * that records every violation found at the time of the last scan.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run establish-a11y-baseline
 *
 * The script is safe to re-run: it overwrites the baseline file each time.
 * Commit the result so future scan runs can diff against it.
 */

import fs from "node:fs";
import path from "node:path";

interface AxeViolation {
  id: string;
  impact: string;
  description: string;
  helpUrl: string;
  nodes: Array<{ html: string; target: string[] }>;
}

interface RouteResult {
  route: string;
  routeName: string;
  violations: AxeViolation[];
}

interface PlaywrightJsonReport {
  suites?: Array<{
    specs?: Array<{
      title?: string;
      tests?: Array<{
        results?: Array<{
          attachments?: Array<{
            name: string;
            contentType: string;
            body?: string;
          }>;
        }>;
      }>;
    }>;
  }>;
}

// Resolve relative to the workspace root, not the scripts/ working directory
const WORKSPACE_ROOT = path.resolve(new URL(import.meta.url).pathname, "../../..");
const REPORT_PATH = path.resolve(WORKSPACE_ROOT, "test-results/a11y-report.json");
const VIOLATIONS_JSONL = path.resolve(WORKSPACE_ROOT, "test-results/a11y-violations.jsonl");
const BASELINE_PATH = path.resolve(WORKSPACE_ROOT, ".a11y-baseline.json");

/**
 * Load route results from the JSONL accumulation file (preferred — survives
 * batched runs) or fall back to inline attachments in the Playwright JSON
 * report (last-run only).
 */
function loadRouteResults(): RouteResult[] {
  // Prefer the accumulation file which survives across batched runs
  if (fs.existsSync(VIOLATIONS_JSONL)) {
    const lines = fs.readFileSync(VIOLATIONS_JSONL, "utf8")
      .split("\n")
      .filter(Boolean);

    // Deduplicate: last write for each route wins
    const byRoute = new Map<string, RouteResult>();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RouteResult;
        byRoute.set(parsed.route, parsed);
      } catch {
        // skip malformed lines
      }
    }
    if (byRoute.size > 0) {
      console.log(`Loaded data from JSONL accumulation file (${byRoute.size} routes).`);
      return Array.from(byRoute.values());
    }
  }

  // Fall back to Playwright JSON report (single run only)
  if (!fs.existsSync(REPORT_PATH)) {
    console.error(`\nNeither ${VIOLATIONS_JSONL} nor ${REPORT_PATH} found.`);
    console.error("Run the a11y scan first:\n");
    console.error("  npx playwright test --config playwright.a11y.config.ts\n");
    process.exit(1);
  }

  console.log("Falling back to Playwright JSON report (may be partial if using batched runs).");
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8")) as PlaywrightJsonReport;
  return extractRouteResultsFromReport(report);
}

function extractRouteResultsFromReport(report: PlaywrightJsonReport): RouteResult[] {
  const results: RouteResult[] = [];

  for (const suite of report.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      const title = spec.title ?? "";
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          for (const attachment of result.attachments ?? []) {
            if (attachment.name === "axe-violations" && attachment.body) {
              try {
                const parsed = JSON.parse(
                  Buffer.from(attachment.body, "base64").toString("utf8")
                ) as RouteResult;
                results.push(parsed);
              } catch {
                // skip malformed attachments
              }
            }
          }
        }
      }
    }
  }

  return results;
}

interface BaselineEntry {
  route: string;
  routeName: string;
  violationId: string;
  impact: string;
  description: string;
  helpUrl: string;
  affectedNodes: string[];
  followUpRef: string;
  baselinedAt: string;
}

function buildBaseline(routeResults: RouteResult[]): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  const now = new Date().toISOString();

  for (const rr of routeResults) {
    for (const v of rr.violations) {
      entries.push({
        route: rr.route,
        routeName: rr.routeName,
        violationId: v.id,
        impact: v.impact,
        description: v.description,
        helpUrl: v.helpUrl,
        affectedNodes: v.nodes.slice(0, 3).map((n) => n.target.join(", ")),
        followUpRef: "TODO: link follow-up ticket here",
        baselinedAt: now,
      });
    }
  }

  return entries;
}

function main() {
  console.log("Loading scan data from:", VIOLATIONS_JSONL, "or", REPORT_PATH);
  const routeResults = loadRouteResults();

  if (routeResults.length === 0) {
    console.log(
      "\nNo route-level axe attachment data found in the report.\n" +
      "Ensure the scan test attaches violations via test.info().attach().\n"
    );
    // Write an empty baseline rather than failing
    const empty: BaselineEntry[] = [];
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(empty, null, 2) + "\n");
    console.log("Wrote empty baseline to", BASELINE_PATH);
    return;
  }

  const baseline = buildBaseline(routeResults);
  const totalViolations = baseline.length;
  const byImpact = baseline.reduce<Record<string, number>>((acc, e) => {
    acc[e.impact] = (acc[e.impact] ?? 0) + 1;
    return acc;
  }, {});

  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");

  console.log(`\nBaseline established from ${routeResults.length} scanned routes.`);
  console.log(`Total baselined violations: ${totalViolations}`);
  for (const [impact, count] of Object.entries(byImpact)) {
    console.log(`  ${impact}: ${count}`);
  }
  console.log(`\nWritten to: ${BASELINE_PATH}`);

  // Warn if any followUpRef values are still placeholder text — these must
  // be replaced with real ticket/issue references before committing.
  const placeholderRefs = baseline.filter(
    (e) => e.followUpRef.startsWith("TODO") || e.followUpRef.trim() === ""
  );
  if (placeholderRefs.length > 0) {
    console.warn(
      `\n⚠  WARNING: ${placeholderRefs.length} baseline entries still have placeholder followUpRef values.\n` +
      "   Replace each 'TODO: ...' with a real ticket or issue URL before committing.\n" +
      "   Violation IDs with placeholder refs:\n" +
      [...new Set(placeholderRefs.map((e) => `     - ${e.violationId} (${e.impact})`))].join("\n")
    );
  }

  console.log(
    "\nNext steps:\n" +
    "  1. Ensure every followUpRef points to a real tracker reference (no TODO placeholders).\n" +
    "  2. Commit .a11y-baseline.json to version control.\n" +
    "  3. Future scan runs will only fail on NEW serious/critical violations.\n"
  );
}

main();
