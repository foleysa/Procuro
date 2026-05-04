#!/usr/bin/env tsx
import { db, a11yScanResultsTable } from "@workspace/db";
import { lt } from "drizzle-orm";

const DEFAULT_RETENTION_DAYS = 90;

async function main() {
  const retentionDays =
    Math.max(1, Math.floor(Number(process.env.A11Y_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS));
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  console.log(`Pruning a11y_scan_results older than ${retentionDays} days (before ${cutoff.toISOString()})...`);

  const result = await db
    .delete(a11yScanResultsTable)
    .where(lt(a11yScanResultsTable.scannedAt, cutoff));

  const deleted = result.rowCount ?? 0;
  console.log(`Deleted ${deleted} rows.`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
