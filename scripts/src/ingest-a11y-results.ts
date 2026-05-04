#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, a11yScanResultsTable } from "@workspace/db";
import { lt } from "drizzle-orm";

const A11Y_RETENTION_DAYS = Math.max(1, Math.floor(Number(process.env.A11Y_RETENTION_DAYS) || 90));

interface AxeViolation {
  id: string;
  impact: string;
  description: string;
  helpUrl: string;
  nodes: Array<{ html: string; target: string[]; failureSummary?: string }>;
}

export interface RouteResult {
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

export interface IngestResult {
  runId: string;
  routeCount: number;
  totalViolations: number;
  totalNew: number;
  prunedCount: number;
}

export async function ingestA11yResults(
  routeResults: RouteResult[],
  baselinePath?: string,
): Promise<IngestResult> {
  const baseline = baselinePath
    ? (() => {
        if (!fs.existsSync(baselinePath)) return [];
        try {
          return JSON.parse(fs.readFileSync(baselinePath, "utf8")) as BaselineEntry[];
        } catch {
          return [];
        }
      })()
    : loadBaseline();

  const runId = crypto.randomUUID();
  const scannedAt = new Date();
  const rows: Array<typeof a11yScanResultsTable.$inferInsert> = [];

  for (const rr of routeResults) {
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

  const cutoff = new Date(Date.now() - A11Y_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const pruned = await db
    .delete(a11yScanResultsTable)
    .where(lt(a11yScanResultsTable.scannedAt, cutoff));
  const prunedCount = pruned.rowCount ?? 0;

  const totalViolations = rows.reduce((s, r) => s + r.totalViolations, 0);
  const totalNew = rows.reduce((s, r) => s + (r.newCount ?? 0), 0);

  return { runId, routeCount: rows.length, totalViolations, totalNew, prunedCount };
}

export function parseJsonlFile(filePath: string): RouteResult[] {
  const lines = fs
    .readFileSync(filePath, "utf8")
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

  return Array.from(byRoute.values());
}

async function main() {
  if (!fs.existsSync(VIOLATIONS_JSONL)) {
    console.error(`No JSONL file found at ${VIOLATIONS_JSONL}.`);
    console.error("Run the a11y scan first:");
    console.error("  npx playwright test --config playwright.a11y.config.ts");
    process.exit(1);
  }

  const routeResults = parseJsonlFile(VIOLATIONS_JSONL);

  if (routeResults.length === 0) {
    console.log("No route results found in JSONL file. Nothing to ingest.");
    process.exit(0);
  }

  const result = await ingestA11yResults(routeResults);

  console.log(`Ingested ${result.routeCount} route results into a11y_scan_results.`);
  console.log(`  Run ID:           ${result.runId}`);
  console.log(`  Total violations: ${result.totalViolations}`);
  console.log(`  New violations:   ${result.totalNew}`);
  console.log(`  Baselined:        ${result.totalViolations - result.totalNew}`);
  if (result.prunedCount > 0) {
    console.log(`  Pruned:           ${result.prunedCount} rows older than ${A11Y_RETENTION_DAYS} days`);
  }

  process.exit(0);
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
