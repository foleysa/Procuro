import type { FullResult, Reporter } from "@playwright/test/reporter";
import fs from "node:fs";
import path from "node:path";

const WORKSPACE_ROOT = path.resolve(__dirname, "../..");
const VIOLATIONS_JSONL = path.resolve(
  WORKSPACE_ROOT,
  "test-results/a11y-violations.jsonl",
);
const BASELINE_PATH = path.resolve(WORKSPACE_ROOT, ".a11y-baseline.json");

class A11yIngestReporter implements Reporter {
  async onEnd(_result: FullResult) {
    if (!fs.existsSync(VIOLATIONS_JSONL)) {
      console.log("[a11y-ingest] No JSONL results file found. Skipping ingest.");
      return;
    }

    const { parseJsonlFile, ingestA11yResults } = await import(
      "../../scripts/src/ingest-a11y-results.ts"
    );

    const routeResults = parseJsonlFile(VIOLATIONS_JSONL);
    if (routeResults.length === 0) {
      console.log("[a11y-ingest] No route results found. Skipping ingest.");
      return;
    }

    console.log(
      `[a11y-ingest] Found ${routeResults.length} route results. Running ingest…`,
    );

    const result = await ingestA11yResults(routeResults, BASELINE_PATH);

    console.log(
      `[a11y-ingest] Ingested ${result.routeCount} route results into a11y_scan_results.`,
    );
    console.log(`[a11y-ingest]   Run ID:           ${result.runId}`);
    console.log(`[a11y-ingest]   Total violations: ${result.totalViolations}`);
    console.log(`[a11y-ingest]   New violations:   ${result.totalNew}`);
    console.log(
      `[a11y-ingest]   Baselined:        ${result.totalViolations - result.totalNew}`,
    );
    if (result.prunedCount > 0) {
      console.log(
        `[a11y-ingest]   Pruned:           ${result.prunedCount} old rows`,
      );
    }
  }
}

export default A11yIngestReporter;
