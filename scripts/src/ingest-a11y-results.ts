#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, a11yScanResultsTable } from "@workspace/db";

interface AxeViolation {
  id: string;
  impact: string;
  description: string;
  helpUrl: string;
  nodes: Array<{ html: string; target: string[]; failureSummary?: string }>;
}

interface RouteResult {
  route: string;
  routeName: string;
  violations: AxeViolation[];
}

interface BaselineEntry {
  route: string;
  violationId: string;
  impact: string;
}

const WORKSPACE_ROOT = path.resolve(
  new URL(import.meta.url).pathname,
  "../../..",
);
const VIOLATIONS_JSONL = path.resolve(
  WORKSPACE_ROOT,
  "test-results/a11y-violations.jsonl",
);
const BASELINE_PATH = path.resolve(WORKSPACE_ROOT, ".a11y-baseline.json");

function loadBaseline(): BaselineEntry[] {
  if (!fs.existsSync(BASELINE_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as BaselineEntry[];
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

async function main() {
  if (!fs.existsSync(VIOLATIONS_JSONL)) {
    console.error(`No JSONL file found at ${VIOLATIONS_JSONL}.`);
    console.error("Run the a11y scan first:");
    console.error("  npx playwright test --config playwright.a11y.config.ts");
    process.exit(1);
  }

  const lines = fs
    .readFileSync(VIOLATIONS_JSONL, "utf8")
    .split("\n")
    .filter(Boolean);

  const byRoute = new Map<string, RouteResult>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as RouteResult;
      byRoute.set(parsed.route, parsed);
    } catch {
      // skip malformed lines
    }
  }

  if (byRoute.size === 0) {
    console.log("No route results found in JSONL file. Nothing to ingest.");
    process.exit(0);
  }

  const baseline = loadBaseline();
  const runId = crypto.randomUUID();
  const scannedAt = new Date();
  const rows: Array<typeof a11yScanResultsTable.$inferInsert> = [];

  for (const [, rr] of byRoute) {
    let criticalCount = 0;
    let seriousCount = 0;
    let moderateCount = 0;
    let minorCount = 0;
    let totalNodes = 0;
    let newCount = 0;
    let baselinedCount = 0;

    const violations: Array<{
      id: string;
      impact: string;
      description: string;
      helpUrl: string;
      nodeCount: number;
    }> = [];

    for (const v of rr.violations) {
      const nodeCount = Array.isArray(v.nodes) ? v.nodes.length : 0;
      totalNodes += nodeCount;
      violations.push({
        id: v.id,
        impact: v.impact ?? "minor",
        description: v.description ?? "",
        helpUrl: v.helpUrl ?? "",
        nodeCount,
      });
      switch (v.impact) {
        case "critical":
          criticalCount++;
          break;
        case "serious":
          seriousCount++;
          break;
        case "moderate":
          moderateCount++;
          break;
        default:
          minorCount++;
      }
      if (isBaselined(baseline, rr.route, v.id)) {
        baselinedCount++;
      } else {
        newCount++;
      }
    }

    rows.push({
      id: crypto.randomUUID(),
      runId,
      scannedAt,
      route: rr.route,
      routeName: rr.routeName,
      totalViolations: rr.violations.length,
      criticalCount,
      seriousCount,
      moderateCount,
      minorCount,
      newCount,
      baselinedCount,
      totalNodes,
      violations,
    });
  }

  if (rows.length > 0) {
    await db.insert(a11yScanResultsTable).values(rows);
  }

  const totalViolations = rows.reduce((s, r) => s + r.totalViolations, 0);
  const totalNew = rows.reduce((s, r) => s + (r.newCount ?? 0), 0);

  console.log(`Ingested ${rows.length} route results into a11y_scan_results.`);
  console.log(`  Run ID:           ${runId}`);
  console.log(`  Total violations: ${totalViolations}`);
  console.log(`  New violations:   ${totalNew}`);
  console.log(`  Baselined:        ${totalViolations - totalNew}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
